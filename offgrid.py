#!/usr/bin/env python3
"""Off-Grid Library: build a plug-in survival library drive from Kiwix ZIMs.

Run:  .venv/bin/python offgrid.py   then open http://localhost:8642

Drive layout written by this tool:
    <drive>/OfflineLibrary/   (or the name of the package you downloaded)
        zim/                    downloaded, crawled and generated .zim files
        kiwix-tools/<platform>/ kiwix-serve binaries for each OS you install
        library.xml             Kiwix library index of zim/
        START-Mac.command, START-Linux.sh, START-Windows.bat
        custom.json             websites crawled with zimit
"""
import json
import os
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import build_guide

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
SETTINGS_FILE = os.path.join(HERE, "settings.json")
CACHE_FILE = os.path.join(HERE, "catalog_cache.json")
UI_PORT = int(os.environ.get("OFFGRID_PORT", "8642"))
KIWIX_PORT = 8090
OPDS = "https://library.kiwix.org/catalog/v2/entries"
TOOLS_URL = "https://download.kiwix.org/release/kiwix-tools/kiwix-tools_{}.{}"
TOOL_PLATFORMS = {
    "macos-arm64": "Mac (Apple Silicon)",
    "macos-x86_64": "Mac (Intel)",
    "linux-x86_64": "Linux (x86-64)",
    "linux-aarch64": "Linux (ARM64 / Raspberry Pi 4+)",
    "win-x86_64": "Windows (64-bit)",
}
ZIMIT_IMAGE = "ghcr.io/openzim/zimit"
BUILD_STATE = "build-state.json"  # ZIM files present at the last build, to tell when a rebuild is due
PACKAGES_FILE = os.path.join(HERE, "packages.json")
# Bump when /api/state changes shape. The page checks it, because web/ files are re-read from disk on
# every request while this module only loads at startup, so an old builder can end up serving a new page.
API_VERSION = 7
BROWSER_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"}
UA = {"User-Agent": "OffGridLibrary/1.0"}

with open(os.path.join(HERE, "catalog.json")) as f:
    CATALOG = json.load(f)


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


settings = load_json(SETTINGS_FILE, {"drive": "", "flavours": {}})
settings.setdefault("flavours", {})
settings.setdefault("scanAlways", False)    # look for removable drives without asking first
settings.setdefault("autoConnect", False)   # reconnect to the saved drive without asking first
settings.setdefault("topicEdits", {})        # your changes to topics: {topic id: {"title": ..., "kiwix": [library names]}}
settings.setdefault("folders", {})         # drive path -> name of the library folder on it
settings.setdefault("favorites", None)      # starred package ids for the landing page; None = Offie's starter packs
remote = load_json(CACHE_FILE, {})  # library name -> [options]
packages = load_json(PACKAGES_FILE, [])  # saved carts, oldest first
lock = threading.RLock()
# The saved drive is only touched once the person says so (this session), unless they chose "don't ask again".
session = {"connected": False}


# ------------------------------------------------------------------ paths

DEFAULT_FOLDER = "OfflineLibrary"
LEGACY_FOLDERS = ("OfflineLibrary", "OffGridLibrary")
MARKER = ".offie-library"  # dropped in every library folder Offie creates, so it can find it again


def find_library(p):
    """Name of the folder holding an Offie library on drive p, or None."""
    names = [settings["folders"].get(p)] if settings["folders"].get(p) else []
    try:
        names += sorted(e for e in os.listdir(p) if not e.startswith("."))
    except OSError:
        pass
    for n in names:
        d = os.path.join(p, n)
        if os.path.isdir(os.path.join(d, "zim")) and (n in LEGACY_FOLDERS or os.path.exists(os.path.join(d, MARKER))):
            return n
    return None


def folder_name(name):
    """A safe folder name from a package name (falls back to OfflineLibrary)."""
    n = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name or "").strip(" .")[:60]
    return n or DEFAULT_FOLDER


def adopt_library(p):
    """Remember the library already on drive p (if any), so root() points at it."""
    n = find_library(p)
    if n and settings["folders"].get(p) != n:
        settings["folders"][p] = n
        save_json(SETTINGS_FILE, settings)


def name_library(package):
    """Before the first download to an empty drive, name the library folder after the package (or OfflineLibrary)."""
    p = settings.get("drive")
    if not p or find_library(p) or os.path.isdir(root()):
        return
    with lock:
        settings["folders"][p] = folder_name(package)
        save_json(SETTINGS_FILE, settings)


def root():
    if not settings.get("drive") or not (session["connected"] or settings.get("autoConnect")):
        return ""
    return os.path.join(settings["drive"], settings["folders"].get(settings["drive"]) or DEFAULT_FOLDER)


def ensure_root():
    os.makedirs(zim_dir(), exist_ok=True)
    m = os.path.join(root(), MARKER)
    if not os.path.exists(m):
        open(m, "w").close()


def zim_dir():
    return os.path.join(root(), "zim")


def host_platform():
    m = platform.machine().lower()
    arm = m in ("arm64", "aarch64")
    if sys.platform == "darwin":
        return "macos-arm64" if arm else "macos-x86_64"
    if sys.platform.startswith("win"):
        return "win-x86_64"
    return "linux-aarch64" if arm else "linux-x86_64"


def tool_path(name, plat=None):
    plat = plat or host_platform()
    exe = name + (".exe" if plat.startswith("win") else "")
    p = os.path.join(root(), "kiwix-tools", plat, exe)
    if root() and os.path.exists(p):
        return p
    return shutil.which(name) if plat == host_platform() else None


def fs_type(path):
    """Filesystem type of the mount holding path ('msdos'/'vfat' = FAT32, 4 GB file limit)."""
    try:
        out = subprocess.run(["mount"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return ""
    best, kind = "", ""
    real = os.path.realpath(path)
    for line in out.splitlines():
        m = re.match(r".+? on (.+?) (?:\((\w+)|type (\w+))", line)
        if m and (real == m.group(1) or real.startswith(m.group(1).rstrip("/") + "/")) and len(m.group(1)) > len(best):
            best, kind = m.group(1), m.group(2) or m.group(3)
    return kind


def is_removable(p):
    """True for USB sticks, SD cards and external drives; False for internal disks, disk images and network shares."""
    if sys.platform == "darwin":
        try:
            out = subprocess.run(["diskutil", "info", "-plist", p], capture_output=True, timeout=8).stdout
            info = plistlib.loads(out)
        except (OSError, subprocess.SubprocessError, ValueError):
            return False
        if info.get("BusProtocol") == "Disk Image" or info.get("VirtualOrPhysical") == "Virtual":
            return False
        return bool(info.get("RemovableMedia") or info.get("Removable") or info.get("Ejectable") or info.get("Internal") is False)
    if sys.platform.startswith("win"):
        import ctypes
        return ctypes.windll.kernel32.GetDriveTypeW(ctypes.c_wchar_p(p)) == 2  # DRIVE_REMOVABLE
    return True  # Linux: only /media and /run/media are scanned, where desktops mount removable drives


def list_drives():
    """Removable drives only. Internal disks and folders are added by typing a path."""
    cands = []
    if sys.platform == "darwin":
        cands = [os.path.join("/Volumes", d) for d in os.listdir("/Volumes")]
    elif sys.platform.startswith("win"):
        cands = [f"{c}:\\" for c in "DEFGHIJKLMNOPQRSTUVWXYZ" if os.path.exists(f"{c}:\\")]
    else:
        for base in ("/media", "/run/media"):
            if os.path.isdir(base):
                for d in os.listdir(base):
                    p = os.path.join(base, d)
                    subs = [os.path.join(p, s) for s in os.listdir(p)] if not os.path.ismount(p) and os.path.isdir(p) else []
                    cands += subs or [p]
    cands = [p for p in cands if os.path.isdir(p) and os.path.realpath(p) != "/"]
    # Each check talks to the disk; run them side by side so one slow drive can't stall the list.
    with ThreadPoolExecutor(8) as pool:
        checked = list(pool.map(lambda p: drive_info(p, "removable") if is_removable(p) else None, cands))
    return [d for d in checked if d]


def drive_info(p, kind):
    """Size, filesystem and any existing library for one drive or folder (None if unreadable)."""
    try:
        u = shutil.disk_usage(p)
    except OSError:
        return None
    lib = find_library(p)
    lib_zim = os.path.join(p, lib, "zim") if lib else ""
    zims = []
    if os.path.isdir(lib_zim):
        try:
            zims = [f for f in os.listdir(lib_zim) if f.endswith(".zim") and not f.startswith(build_guide.GUIDE_NAME)]
        except OSError:
            pass
    lib_size = sum(os.path.getsize(os.path.join(lib_zim, f)) for f in zims) if zims else 0
    return {"path": p, "name": os.path.basename(p.rstrip("/\\")) or p, "kind": kind,
            "free": u.free, "total": u.total, "fstype": fs_type(p),
            "library": {"count": len(zims), "size": lib_size, "folder": lib} if lib else None}


def frameable(url):
    """Whether a site lets this app show it in an embedded preview (X-Frame-Options / CSP frame-ancestors)."""
    if urllib.parse.urlparse(url).scheme not in ("http", "https"):
        raise ValueError("Enter a full web address starting with http:// or https://")
    blocked = {"ok": False, "reason": "This website doesn't allow previews inside other apps."}
    # Ask the way a browser would, so the site sends the same headers the preview would get.
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=BROWSER_UA), timeout=10) as r:
            headers = r.headers
    except urllib.error.HTTPError:
        # The site refused us; a preview would most likely come up blank too, so say so up front.
        return {"ok": False, "reason": "This website blocked the preview."}
    except Exception:  # DNS failure, TLS error, timeout…
        return {"ok": False, "reason": "This website couldn't be reached for a preview."}
    xfo = (headers.get("X-Frame-Options") or "").strip().lower()
    csp = " ".join(headers.get_all("Content-Security-Policy") or []).lower()
    if xfo:
        return blocked
    m = re.search(r"frame-ancestors([^;]*)", csp)
    if m and not any(s in m.group(1) for s in ("*", "http://localhost")):
        return blocked
    return {"ok": True}


# ------------------------------------------------------------------ catalog

def fetch_remote(name):
    url = OPDS + "?" + urllib.parse.urlencode({"name": name, "count": 50})
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        tree = ET.fromstring(r.read())
    ns = {"a": "http://www.w3.org/2005/Atom"}
    opts = []
    for e in tree.findall("a:entry", ns):
        acq = [l for l in e.findall("a:link", ns) if l.get("type") == "application/x-zim"]
        if not acq:
            continue
        href = acq[0].get("href")
        opts.append({
            "flavour": (e.findtext("a:flavour", "", ns) or ""),
            "size": int(acq[0].get("length") or 0),
            "url": href[:-len(".meta4")] if href.endswith(".meta4") else href,
            "date": (e.findtext("a:updated", "", ns) or "")[:10],
            "summary": e.findtext("a:summary", "", ns) or "",
        })
    opts.sort(key=lambda o: o["size"])
    return opts


def refresh_catalog():
    names = list(CATALOG["libraries"])
    errors = []

    def one(n):
        try:
            return n, fetch_remote(n)
        except Exception as ex:  # network down, etc.
            errors.append(f"{n}: {ex}")
            return n, None

    with ThreadPoolExecutor(8) as pool:
        for n, opts in pool.map(one, names):
            if opts:
                remote[n] = opts
    save_json(CACHE_FILE, remote)
    if errors and len(errors) == len(names):
        raise RuntimeError("Could not reach library.kiwix.org: " + errors[0])
    return len(names) - len(errors)


def chosen_option(name):
    opts = remote.get(name) or []
    if not opts:
        return None
    want = settings["flavours"].get(name, CATALOG["libraries"][name].get("flavour", ""))
    for o in opts:
        if o["flavour"] == want:
            return o
    return opts[0]


def on_drive():
    return build_guide.scan(zim_dir(), CATALOG) if root() else {}


def custom_sites():
    return load_json(os.path.join(root(), "custom.json"), []) if root() else []


# ------------------------------------------------------------------ jobs

jobs = []  # newest last
queue_cv = threading.Condition(lock)


class Cancelled(Exception):
    pass


def new_job(kind, label, run, **extra):
    job = {"id": uuid.uuid4().hex[:8], "kind": kind, "label": label, "status": "queued",
           "progress": 0.0, "message": "Waiting…", "done": 0, "total": 0, "speed": 0,
           "cancel": False, "run": run, "started": None, **extra}
    with queue_cv:
        jobs.append(job)
        queue_cv.notify_all()
    return job


def public(job):
    return {k: v for k, v in job.items() if k not in ("run", "cancel", "proc")}


def worker(kinds):
    """One worker per lane: downloads run one at a time; crawls/builds run in their own lane."""
    while True:
        with queue_cv:
            job = None
            while job is None:
                job = next((j for j in jobs if j["status"] == "queued" and j["kind"] in kinds), None)
                if job is None:
                    queue_cv.wait()
            job["status"], job["started"] = "running", time.time()
        try:
            job["run"](job)
            job["status"], job["progress"] = "done", 1.0
            job["message"] = job.get("message") if job["message"] != "Waiting…" else "Done"
        except Cancelled:
            job["status"], job["message"] = "cancelled", "Cancelled"
        except Exception as ex:
            job["status"], job["message"] = "error", str(ex)


def check_cancel(job):
    if job["cancel"]:
        raise Cancelled()


def download(url, dest, job):
    """Resumable HTTP download into dest (.part until complete)."""
    part = dest + ".part"
    have = os.path.getsize(part) if os.path.exists(part) else 0
    req = urllib.request.Request(url, headers={**UA, "Range": f"bytes={have}-"} if have else UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        if have and r.status != 206:
            have = 0  # server ignored Range; start over
        total = have + int(r.headers.get("Content-Length") or 0)
        job["total"], job["done"] = total, have
        t0, d0 = time.time(), have
        with open(part, "ab" if have else "wb") as f:
            while True:
                check_cancel(job)
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                job["done"] += len(chunk)
                dt = time.time() - t0
                if dt > 1:
                    job["speed"] = (job["done"] - d0) / dt
                job["progress"] = job["done"] / total if total else 0
                job["message"] = f"{human(job['done'])} of {human(total)}"
    if total and os.path.getsize(part) < total:
        raise RuntimeError("Download incomplete; start it again to resume")
    os.replace(part, dest)


def human(n):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024


def queue_download(name):
    opt = chosen_option(name)
    if not opt:
        raise ValueError(f"No catalog info for {name}; refresh the catalog first")
    fname = os.path.basename(urllib.parse.urlparse(opt["url"]).path)
    dest = os.path.join(zim_dir(), fname)
    if os.path.exists(dest):
        raise ValueError(f"{fname} is already on the drive")
    for j in jobs:
        if j.get("library") == name and j["status"] in ("queued", "running"):
            raise ValueError(f"{name} is already queued")
    ensure_root()
    free = shutil.disk_usage(zim_dir()).free
    queued = sum(j["total"] - j["done"] for j in jobs if j["kind"] == "download" and j["status"] in ("queued", "running"))
    if opt["size"] > free - queued:
        raise ValueError(f"Not enough space for {name} ({human(opt['size'])}, {human(free - queued)} free after queue)")
    fat = fs_type(zim_dir()) in ("msdos", "vfat", "fat32")
    if fat and opt["size"] >= 4 * 1024 ** 3:
        raise ValueError(f"{name} is over 4 GB and the drive is FAT32. Reformat as exFAT or pick a smaller flavour.")

    def run(job):
        # Drop older versions of the same library once the new one lands.
        old = on_drive().get(name)
        download(opt["url"], dest, job)
        if old and old != fname:
            os.remove(os.path.join(zim_dir(), old))
        job["message"] = f"Saved {fname}"

    return new_job("download", CATALOG["libraries"][name]["title"], run, library=name, total=opt["size"])


def queue_crawl(url, title, topic, page_limit):
    if not shutil.which("docker"):
        raise ValueError("Docker is not installed; zimit needs it to crawl websites")
    host = urllib.parse.urlparse(url).netloc
    if not host:
        raise ValueError("Enter a full URL, e.g. https://example.org/")
    name = re.sub(r"[^a-z0-9]+", "-", (title or host).lower()).strip("-")[:40] or "site"
    stem = f"crawl-{name}_{time.strftime('%Y-%m')}"
    ensure_root()

    def run(job):
        # No volume mount: Docker Desktop only shares some host folders, and FAT/exFAT drives
        # mount poorly. The ZIM is copied out of the container with `docker cp` instead.
        container = f"offgrid-crawl-{job['id']}"
        cmd = ["docker", "run", "--name", container, ZIMIT_IMAGE, "zimit",
               "--seeds", url, "--name", f"crawl-{name}", "--zim-file", stem + ".zim",
               "--title", (title or host)[:30], "--description", f"Offline copy of {host}"[:80],
               "--workers", "2", "--waitUntil", "domcontentloaded"]
        if page_limit:
            cmd += ["--pageLimit", str(int(page_limit))]
        job["message"] = "Starting crawler (first run pulls the Docker image, about 1 GB)…"
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            tail = []
            for line in proc.stdout:
                if job["cancel"]:
                    subprocess.run(["docker", "stop", container], capture_output=True)
                    raise Cancelled()
                line = line.strip()
                if not line:
                    continue
                tail = (tail + [line])[-40:]
                m = re.search(r'"crawled":(\d+).*?"total":(\d+)', line)
                if m:
                    done, total = int(m.group(1)), int(m.group(2))
                    job["done"], job["total"] = done, total
                    job["progress"] = 0.9 * done / max(total, 1)
                    job["message"] = f"Crawled {done} of {total} pages"
                elif "warc2zim" in line.lower():
                    job["message"] = "Packaging pages into a ZIM…"
            if proc.wait() != 0:
                raise RuntimeError("zimit failed: " + (tail[-1] if tail else "no output"))
            job["message"] = "Copying ZIM to the drive…"
            dest = os.path.join(zim_dir(), stem + ".zim")
            cp = subprocess.run(["docker", "cp", f"{container}:/output/{stem}.zim", dest + ".part"],
                                capture_output=True, text=True)
            if cp.returncode != 0:
                raise RuntimeError("zimit finished but no ZIM was written: " + cp.stderr.strip())
            os.replace(dest + ".part", dest)
        finally:
            subprocess.run(["docker", "rm", "-f", container], capture_output=True)
        sites = [c for c in custom_sites() if c["file"] != stem + ".zim"]
        sites.append({"title": title or host, "url": url, "topic": topic, "file": stem + ".zim"})
        save_json(os.path.join(root(), "custom.json"), sites)
        job["message"] = f"Saved {stem}.zim"

    return new_job("crawl", f"Copy website: {title or host}", run,
                   url=url, title=title, topic=topic, pageLimit=page_limit)


def tools_url(plat, ext):
    """Newest kiwix-tools build for a platform, read from the release directory listing."""
    base = TOOLS_URL.rsplit("/", 1)[0] + "/"
    with urllib.request.urlopen(urllib.request.Request(base, headers=UA), timeout=30) as r:
        listing = r.read().decode(errors="replace")
    pat = re.compile(r'href="(kiwix-tools_' + re.escape(plat) + r'-(\d+)\.(\d+)\.(\d+)(?:-(\d+))?\.' + re.escape(ext) + ')"')
    builds = [(tuple(int(g or 0) for g in m.groups()[1:]), m.group(1)) for m in pat.finditer(listing)]
    if not builds:
        raise RuntimeError(f"No kiwix-tools build found for {plat}")
    return base + max(builds)[1]


def queue_tools(platforms):
    def run(job):
        for i, plat in enumerate(platforms):
            check_cancel(job)
            ext = "zip" if plat.startswith("win") else "tar.gz"
            dest_dir = os.path.join(root(), "kiwix-tools", plat)
            os.makedirs(dest_dir, exist_ok=True)
            archive = os.path.join(root(), "kiwix-tools", f"{plat}.{ext}")
            job["message"] = f"Downloading {TOOL_PLATFORMS[plat]}"
            download(tools_url(plat, ext), archive, job)
            job["message"] = f"Unpacking {TOOL_PLATFORMS[plat]}"
            if ext == "zip":
                with zipfile.ZipFile(archive) as z:
                    members = [(m, os.path.basename(m.filename)) for m in z.infolist() if not m.is_dir()]
                    for m, base in members:
                        with z.open(m) as src, open(os.path.join(dest_dir, base), "wb") as out:
                            shutil.copyfileobj(src, out)
            else:
                with tarfile.open(archive) as t:
                    for m in t.getmembers():
                        if m.isfile():
                            with t.extractfile(m) as src, open(os.path.join(dest_dir, os.path.basename(m.name)), "wb") as out:
                                shutil.copyfileobj(src, out)
                            os.chmod(os.path.join(dest_dir, os.path.basename(m.name)), 0o755)
            os.remove(archive)
            job["progress"] = (i + 1) / len(platforms)
        job["message"] = "Installed " + ", ".join(TOOL_PLATFORMS[p] for p in platforms)

    return new_job("build", "Install Kiwix reader", run)


LAUNCH_MAC = """#!/bin/bash
# Double-click to open the Off-Grid Library.
cd "$(dirname "$0")"
ARCH=$(uname -m); [ "$ARCH" = "arm64" ] && P=macos-arm64 || P=macos-x86_64
BIN="kiwix-tools/$P/kiwix-serve"
[ -x "$BIN" ] || { echo "No Kiwix reader for $P on this drive."; read -r; exit 1; }
xattr -dr com.apple.quarantine kiwix-tools 2>/dev/null
"$BIN" --port {port} --library library.xml &
PID=$!; sleep 2; open "http://localhost:{port}/content/{guide}/"
echo "Off-Grid Library running at http://localhost:{port}  (close this window to stop)"
wait $PID
"""
LAUNCH_LINUX = """#!/bin/sh
# Run: sh START-Linux.sh
cd "$(dirname "$0")"
case "$(uname -m)" in aarch64|arm64) P=linux-aarch64;; *) P=linux-x86_64;; esac
BIN="kiwix-tools/$P/kiwix-serve"
[ -x "$BIN" ] || chmod +x "$BIN" 2>/dev/null
"$BIN" --port {port} --library library.xml &
PID=$!; sleep 2; (xdg-open "http://localhost:{port}/content/{guide}/" >/dev/null 2>&1 &)
echo "Off-Grid Library running at http://localhost:{port}  (Ctrl+C to stop)"
wait $PID
"""
LAUNCH_WIN = """@echo off
rem Double-click to open the Off-Grid Library.
cd /d "%~dp0"
start "" /b "kiwix-tools\\win-x86_64\\kiwix-serve.exe" --port {port} --library library.xml
timeout /t 2 >nul
start "" "http://localhost:{port}/content/{guide}/"
echo Off-Grid Library running at http://localhost:{port}  - close this window to stop.
pause >nul
"""
README = """OFF-GRID LIBRARY
================

Plug this drive into any computer, then:

  Mac      double-click  START-Mac.command   (first time: right-click > Open)
  Windows  double-click  START-Windows.bat
  Linux    run           sh START-Linux.sh

Your web browser opens the Off-Grid Field Guide. It works with no internet.
Every topic page links into the full libraries stored in the zim/ folder.

Readers available on this drive: {plats}

Phones/tablets: install the free Kiwix app and open the .zim files in zim/.
Other computers on the same network can browse to http://<this-computer-ip>:{port}
"""


def write_library_xml(files):
    """library.xml via kiwix-manage when available; otherwise a minimal index we write ourselves."""
    lib = os.path.join(root(), "library.xml")
    if os.path.exists(lib):
        os.remove(lib)
    manage = tool_path("kiwix-manage")
    if manage:
        subprocess.run([manage, "library.xml", "add"] + [os.path.join("zim", f) for f in files],
                       cwd=root(), check=True, capture_output=True, timeout=600)
        return "kiwix-manage"
    books = []
    for f in files:
        with open(os.path.join(zim_dir(), f), "rb") as z:
            head = z.read(24)
        book_id = str(uuid.UUID(bytes=head[8:24]))
        books.append(f'  <book id="{book_id}" path="zim/{f}" title="{f[:-4]}"/>')
    with open(lib, "w") as out:
        out.write('<?xml version="1.0" encoding="UTF-8" ?>\n<library version="20110515">\n' + "\n".join(books) + "\n</library>\n")
    return "built-in writer"


def queue_build():
    def run(job):
        ensure_root()
        job["message"] = "Building Off-Grid Field Guide ZIM…"
        guide = os.path.join(zim_dir(), build_guide.GUIDE_NAME + ".zim")
        build_guide.build(guide, catalog_view(), on_drive(), custom_sites())
        job["progress"] = 0.5
        check_cancel(job)
        job["message"] = "Writing library.xml…"
        files = sorted(f for f in os.listdir(zim_dir()) if f.endswith(".zim"))
        how = write_library_xml(files)
        save_json(os.path.join(root(), BUILD_STATE), {"files": files, "time": time.time()})
        job["progress"] = 0.8
        for fname, tpl in (("START-Mac.command", LAUNCH_MAC), ("START-Linux.sh", LAUNCH_LINUX), ("START-Windows.bat", LAUNCH_WIN)):
            p = os.path.join(root(), fname)
            text = tpl.replace("{port}", str(KIWIX_PORT)).replace("{guide}", build_guide.GUIDE_NAME)
            with open(p, "w", newline="\r\n" if fname.endswith(".bat") else "\n") as out:
                out.write(text)
            os.chmod(p, 0o755)
        plats = [TOOL_PLATFORMS[p] for p in TOOL_PLATFORMS if os.path.isdir(os.path.join(root(), "kiwix-tools", p))]
        with open(os.path.join(root(), "README-FIRST.txt"), "w") as out:
            out.write(README.format(plats=", ".join(plats) or "none yet (add them in step 3 of the builder)", port=KIWIX_PORT))
        job["message"] = f"Indexed {len(files)} ZIM files ({how}); launchers written"

    return new_job("build", "Build drive index & launchers", run)


# ------------------------------------------------------------------ kiwix-serve

serve = {"proc": None}


def serve_start():
    serve_stop()
    binp = tool_path("kiwix-serve")
    lib = os.path.join(root(), "library.xml")
    if not binp:
        raise ValueError("This computer's reader isn't on the drive yet. Tick it under 'Which computers should open this drive?' and build again.")
    if not os.path.exists(lib):
        raise ValueError("Build the drive index first")
    serve["proc"] = subprocess.Popen([binp, "--port", str(KIWIX_PORT), "--library", lib],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    time.sleep(1.0)
    if serve["proc"].poll() is not None:
        err = serve["proc"].stderr.read().decode(errors="replace")[-300:]
        serve["proc"] = None
        raise RuntimeError("kiwix-serve exited: " + err)


def serve_stop():
    if serve["proc"] and serve["proc"].poll() is None:
        serve["proc"].terminate()
        serve["proc"].wait(5)
    serve["proc"] = None


# ------------------------------------------------------------------ packages

def catalog_view():
    """The catalog with your topic edits applied (new names, libraries added or removed). Topic ids never change."""
    edits = settings.get("topicEdits") or {}
    cats = []
    for c in CATALOG["categories"]:
        topics = []
        for t in c["topics"]:
            e = edits.get(t["id"]) or {}
            topics.append({**t, "title": e.get("title") or t["title"],
                           "kiwix": [n for n in e["kiwix"] if n in CATALOG["libraries"]] if "kiwix" in e else t["kiwix"],
                           "edited": bool(e), "originalTitle": t["title"]})
        cats.append({**c, "topics": topics})
    return {**CATALOG, "categories": cats}


def clean_package(b):
    """A saved cart: libraries from the catalog plus websites to copy. Also used for imported package files."""
    name = str(b.get("name") or "").strip()[:80]
    if not name:
        raise ValueError("Give the package a name")
    libs = []
    for n in b.get("libraries") or []:
        if n in CATALOG["libraries"] and n not in libs:
            libs.append(n)
    topics = {t["id"] for c in CATALOG["categories"] for t in c["topics"]}
    sites, seen = [], set()
    for s in b.get("sites") or []:
        url = str(s.get("url") or "").strip()
        if urllib.parse.urlparse(url).scheme not in ("http", "https") or url in seen:
            continue
        seen.add(url)
        sites.append({"url": url, "title": str(s.get("title") or urllib.parse.urlparse(url).netloc)[:80],
                      "topic": s.get("topic") if s.get("topic") in topics else None,
                      "pageLimit": max(0, min(int(s.get("pageLimit") or 200), 100000))})
    if not libs and not sites:
        raise ValueError("This package has nothing in it")
    return {"id": uuid.uuid4().hex[:10], "name": name, "description": str(b.get("description") or "").strip()[:500],
            "libraries": libs, "sites": sites, "created": time.strftime("%Y-%m-%d")}


# ------------------------------------------------------------------ state

def docker_ok():
    if not shutil.which("docker"):
        return False
    try:
        return subprocess.run(["docker", "info"], capture_output=True, timeout=8).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


_docker = {"ok": None, "t": 0}


def state():
    if time.time() - _docker["t"] > 30:
        _docker.update(ok=docker_ok(), t=time.time())
    drive = None
    if root():
        try:
            u = shutil.disk_usage(settings["drive"])
            drive = {"path": settings["drive"], "name": os.path.basename(settings["drive"].rstrip("/\\")) or settings["drive"],
                     "root": root(), "folder": os.path.basename(root()), "folderExists": os.path.isdir(root()), "free": u.free, "total": u.total, "fstype": fs_type(settings["drive"]),
                     "home": os.path.realpath(settings["drive"]) == os.path.realpath(os.path.expanduser("~"))}
        except OSError:
            drive = {"path": settings["drive"], "missing": True}
    have = on_drive() if drive and not drive.get("missing") else {}
    libs = {}
    for name, meta in CATALOG["libraries"].items():
        opt = chosen_option(name)
        f = have.get(name)
        libs[name] = {
            "title": meta["title"], "options": remote.get(name) or [],
            "flavour": opt["flavour"] if opt else meta.get("flavour", ""),
            "size": opt["size"] if opt else 0, "summary": opt["summary"] if opt else "",
            "file": f, "fileSize": os.path.getsize(os.path.join(zim_dir(), f)) if f else 0,
            "outdated": bool(f and opt and os.path.basename(opt["url"]) != f),
        }
    guide = os.path.join(zim_dir(), build_guide.GUIDE_NAME + ".zim") if root() else ""
    zims, needs_rebuild = [], False
    if drive and not drive.get("missing") and os.path.isdir(zim_dir()):
        zims = sorted(f for f in os.listdir(zim_dir()) if f.endswith(".zim"))
        lib = os.path.join(root(), "library.xml")
        last = load_json(os.path.join(root(), BUILD_STATE), None)
        if last is not None:
            needs_rebuild = sorted(last.get("files", [])) != zims
        elif os.path.exists(lib):  # built by an older version of this app
            needs_rebuild = any(os.path.getmtime(os.path.join(zim_dir(), f)) > os.path.getmtime(lib) for f in zims)
    try:
        import libzim  # noqa: F401
        has_libzim = True
    except ImportError:
        has_libzim = False
    saved = None
    if settings.get("drive") and not root():  # a drive from last time, waiting for permission to reconnect
        p = settings["drive"]
        saved = {"path": p, "name": os.path.basename(p.rstrip("/\\")) or p, "available": os.path.isdir(p)}
    return {
        "apiVersion": API_VERSION,
        "drive": drive,
        "savedDrive": saved,
        "permissions": {"scanAlways": bool(settings.get("scanAlways")), "autoConnect": bool(settings.get("autoConnect"))},
        "packages": packages,
        "favorites": settings.get("favorites"),
        "categories": catalog_view()["categories"],
        "suggestions": CATALOG["crawl_suggestions"],
        "libraries": libs,
        "catalogLoaded": bool(remote),
        "custom": custom_sites(),
        "jobs": [public(j) for j in jobs[-40:]],
        "tools": {
            "docker": _docker["ok"], "libzim": has_libzim, "host": host_platform(),
            "platforms": [{"id": p, "label": l, "installed": bool(root()) and os.path.isdir(os.path.join(root(), "kiwix-tools", p))}
                          for p, l in TOOL_PLATFORMS.items()],
            "kiwixServe": bool(root()) and bool(tool_path("kiwix-serve")),
        },
        "guideBuilt": bool(guide) and os.path.exists(guide),
        "indexBuilt": bool(root()) and os.path.exists(os.path.join(root(), "library.xml")),
        "needsRebuild": needs_rebuild,
        "zimCount": len([f for f in zims if not f.startswith(build_guide.GUIDE_NAME)]),
        "serving": bool(serve["proc"] and serve["proc"].poll() is None),
        "kiwixUrl": f"http://localhost:{KIWIX_PORT}/content/{build_guide.GUIDE_NAME}/",
        "kiwixHome": f"http://localhost:{KIWIX_PORT}/",
    }


# ------------------------------------------------------------------ http

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/state":
            return self.send(200, state())
        if path == "/api/drives":
            return self.send(200, list_drives())
        if path == "/api/frameable":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                return self.send(200, frameable((q.get("url") or [""])[0]))
            except ValueError as ex:
                return self.send(400, {"error": str(ex)})
        fname = "index.html" if path == "/" else path.lstrip("/")
        full = os.path.realpath(os.path.join(WEB, fname))
        if not full.startswith(WEB + os.sep) or not os.path.isfile(full):
            return self.send(404, {"error": "not found"})
        ctype = {"html": "text/html", "js": "text/javascript", "css": "text/css", "svg": "image/svg+xml"}.get(full.rsplit(".", 1)[-1], "application/octet-stream")
        with open(full, "rb") as f:
            self.send(200, f.read(), ctype + "; charset=utf-8")

    def do_POST(self):
        # Only accept requests from this app's own page.
        origin = self.headers.get("Origin", "")
        if origin and urllib.parse.urlparse(origin).netloc not in (f"localhost:{UI_PORT}", f"127.0.0.1:{UI_PORT}"):
            return self.send(403, {"error": "forbidden"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            result = self.route(urllib.parse.urlparse(self.path).path, body)
            self.send(200, result if result is not None else {"ok": True})
        except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as ex:
            self.send(400, {"error": str(ex)})

    def route(self, path, b):
        needs_drive = not (path in ("/api/settings", "/api/resolve", "/api/flavour", "/api/connect", "/api/permissions", "/api/favorite", "/api/topic")
                           or path.startswith("/api/packages/"))
        if needs_drive and not root():
            raise ValueError("Choose a drive first")
        if path == "/api/settings":
            d = os.path.expanduser(b.get("drive", "").strip())
            if not os.path.isdir(d):
                raise ValueError(f"Folder not found: {d}")
            with lock:
                settings["drive"] = d
                save_json(SETTINGS_FILE, settings)
                session["connected"] = True  # the person just picked it
                adopt_library(d)
        elif path == "/api/connect":
            d = settings.get("drive")
            if not d:
                raise ValueError("No drive saved yet")
            if not os.path.isdir(d):
                raise ValueError(f"{os.path.basename(d.rstrip('/')) or d} isn't connected. Plug it in, or pick another drive.")
            with lock:
                session["connected"] = True
                adopt_library(d)
                if b.get("remember"):
                    settings["autoConnect"] = True
                    save_json(SETTINGS_FILE, settings)
        elif path == "/api/permissions":
            with lock:
                for k in ("scanAlways", "autoConnect"):
                    if k in b:
                        settings[k] = bool(b[k])
                save_json(SETTINGS_FILE, settings)
        elif path == "/api/favorite":
            pid = str(b.get("id") or "")[:40]
            if not pid:
                raise ValueError("No package given")
            with lock:
                favs = list(b["defaults"] if settings.get("favorites") is None and isinstance(b.get("defaults"), list) else settings.get("favorites") or [])
                favs = [str(x)[:40] for x in favs if x != pid][:200]
                if b.get("favorite"):
                    favs.append(pid)
                settings["favorites"] = favs
                save_json(SETTINGS_FILE, settings)
        elif path == "/api/packages/save":
            pkg = clean_package(b)
            with lock:
                packages.append(pkg)
                save_json(PACKAGES_FILE, packages)
            return pkg
        elif path == "/api/packages/update":
            # Edits a saved package in place. Editing one of Offie's starter packs (id "offie-…") saves your own copy under
            # the same id, which the page shows instead of the original; deleting that copy brings the original back.
            pid = str(b.get("id") or "")[:40]
            pkg = clean_package(b)
            with lock:
                old = next((x for x in packages if x["id"] == pid), None)
                if old:
                    pkg.update(id=pid, created=old.get("created", pkg["created"]))
                    packages[packages.index(old)] = pkg
                elif re.fullmatch(r"offie-[a-z0-9-]{1,30}", pid):
                    pkg.update(id=pid, edited=True)
                    packages.append(pkg)
                else:
                    raise ValueError("That package no longer exists")
                save_json(PACKAGES_FILE, packages)
            return pkg
        elif path == "/api/packages/import":
            pkg = clean_package(b.get("package") or {})
            with lock:
                packages.append(pkg)
                save_json(PACKAGES_FILE, packages)
            return pkg
        elif path == "/api/packages/delete":
            with lock:
                packages[:] = [p for p in packages if p["id"] != b.get("id")]
                save_json(PACKAGES_FILE, packages)
                # Resetting an edited Offie pack keeps it starred; deleting your own package unstars it.
                if settings.get("favorites") and b.get("id") in settings["favorites"] and not str(b.get("id")).startswith("offie-"):
                    settings["favorites"] = [x for x in settings["favorites"] if x != b.get("id")]
                    save_json(SETTINGS_FILE, settings)
        elif path == "/api/resolve":
            return {"resolved": refresh_catalog()}
        elif path == "/api/flavour":
            if b["name"] not in CATALOG["libraries"]:
                raise ValueError("unknown library")
            with lock:
                settings["flavours"][b["name"]] = b["flavour"]
                save_json(SETTINGS_FILE, settings)
        elif path == "/api/download":
            name_library(b.get("folder"))
            errors, queued = [], 0
            for n in b.get("names", []):
                try:
                    queue_download(n)
                    queued += 1
                except ValueError as ex:
                    errors.append(str(ex))
            return {"queued": queued, "errors": errors}
        elif path == "/api/topic":
            # Rename a topic or change which libraries it lists; {"reset": true} goes back to Offie's version.
            tid = b.get("id")
            if tid not in {t["id"] for c in CATALOG["categories"] for t in c["topics"]}:
                raise ValueError("Unknown topic")
            with lock:
                edits = settings.setdefault("topicEdits", {})
                if b.get("reset"):
                    edits.pop(tid, None)
                else:
                    title = str(b.get("title") or "").strip()[:80]
                    if not title:
                        raise ValueError("Give the topic a name")
                    kiwix = []
                    for n in b.get("kiwix") or []:
                        if n in CATALOG["libraries"] and n not in kiwix:
                            kiwix.append(n)
                    edits[tid] = {"title": title, "kiwix": kiwix}
                save_json(SETTINGS_FILE, settings)
        elif path == "/api/custom/update":
            # Moves a website already copied to the drive to another topic (the copy itself doesn't change).
            topics = {t["id"] for c in CATALOG["categories"] for t in c["topics"]}
            topic = b.get("topic") or None
            if topic is not None and topic not in topics:
                raise ValueError("Unknown topic")
            with lock:
                sites = custom_sites()
                site = next((c for c in sites if c.get("file") == b.get("file")), None)
                if not site:
                    raise ValueError("That website isn't on the drive any more")
                site["topic"] = topic
                save_json(os.path.join(root(), "custom.json"), sites)
        elif path == "/api/delete":
            f = os.path.basename(b["file"])
            os.remove(os.path.join(zim_dir(), f))
            sites = [c for c in custom_sites() if c.get("file") != f]
            save_json(os.path.join(root(), "custom.json"), sites)
        elif path == "/api/cancel":
            for j in jobs:
                if j["id"] == b["id"]:
                    j["cancel"] = True
                    if j["status"] == "queued":
                        j["status"], j["message"] = "cancelled", "Cancelled"
        elif path == "/api/clear":
            with lock:
                jobs[:] = [j for j in jobs if j["status"] in ("queued", "running")]
        elif path == "/api/crawl":
            name_library(b.get("folder"))
            queue_crawl(b.get("url", "").strip(), b.get("title", "").strip(), b.get("topic") or None, b.get("pageLimit") or 0)
        elif path == "/api/tools":
            plats = [p for p in b.get("platforms", []) if p in TOOL_PLATFORMS]
            if not plats:
                raise ValueError("Pick at least one platform")
            queue_tools(plats)
        elif path == "/api/build":
            queue_build()
        elif path == "/api/serve":
            serve_start() if b.get("action") == "start" else serve_stop()
        else:
            raise ValueError("unknown endpoint")


def main():
    for lane in ({"download"}, {"crawl"}, {"build"}):
        threading.Thread(target=worker, args=(lane,), daemon=True).start()
    if not remote:
        threading.Thread(target=lambda: _try(refresh_catalog), daemon=True).start()
    if settings.get("drive") and settings.get("autoConnect") and os.path.isdir(settings["drive"]):
        adopt_library(settings["drive"])  # pick up a library made before folders were named (OffGridLibrary)
    srv = ThreadingHTTPServer(("127.0.0.1", UI_PORT), Handler)
    url = f"http://localhost:{UI_PORT}"
    print(f"Off-Grid Library builder running at {url}  (Ctrl+C to quit)")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        serve_stop()


def _try(fn):
    try:
        fn()
    except Exception as ex:
        print("Catalog refresh failed (offline?):", ex)


if __name__ == "__main__":
    main()
