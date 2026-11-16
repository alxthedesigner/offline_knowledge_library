"use strict";
// Offie builder UI: a landing page, then three steps (choose topics → choose a drive → build & test), driven by /api/state.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i < 2 ? Math.round(n) : n.toFixed(n < 10 ? 1 : 0)) + " " + u[i];
};
const MB = 1024 ** 2, GB = 1024 ** 3;
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const ICON = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>',
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 21h20L12 3zM12 10v5M12 18h.01"/></svg>',
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/></svg>',
  ext: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
};
const ON_DRIVE = `<span class="on-drive">${ICON.check}On drive</span>`;
const FLAVOURS = { maxi: "With images", nopic: "Text only", mini: "Short version", "": "Standard" };
// Small, high-value libraries (about 6 GB together): medicine, water, food, knots, outdoors, radio, mechanics.
const ESSENTIALS = ["zimgit-medicine_en", "irp.fas.org_en_military-medicine", "wikipedia_en_medicine", "zimgit-water_en",
  "zimgit-food-preparation_en", "zimgit-knots_en", "zimgit-post-disaster_en", "outdoors.stackexchange.com_en_all",
  "ham.stackexchange.com_en_all", "mechanics.stackexchange.com_en_all", "ifixit_en_all"];
const STEPS = ["home", "pick", "drive", "build"];

// Offie's own starter packages. They show on the landing page until the person stars their own favorites.
const OFFIE_PACKS = [
  { id: "offie-outage", builtin: true, name: "Outage kit", sites: [],
    description: "For power, internet and phone outages: first aid, safe water, food storage, disaster recovery, ham radio and off-grid power.",
    libraries: ["zimgit-medicine_en", "wikipedia_en_medicine", "zimgit-water_en", "zimgit-food-preparation_en", "zimgit-post-disaster_en", "ready.gov_en_all", "ham.stackexchange.com_en_all", "energypedia_en_all"] },
  { id: "offie-camping", builtin: true, name: "Camping trip", sites: [],
    description: "Outdoor skills, knots, water purification, field medicine, and plant and animal identification.",
    libraries: ["outdoors.stackexchange.com_en_all", "scoutwiki.org_en_all", "zimgit-knots_en", "zimgit-water_en", "irp.fas.org_en_military-medicine", "gardenology_en_all", "wikispecies_en_all"] },
  { id: "offie-fixit", builtin: true, name: "Fix it yourself", sites: [],
    description: "Repair guides, home improvement, electronics, car mechanics and low-tech builds, so you can mend what breaks.",
    libraries: ["ifixit_en_all", "diy.stackexchange.com_en_all", "electronics.stackexchange.com_en_all", "mechanics.stackexchange.com_en_all", "appropedia_en_all", "solar.lowtechmagazine.com_mul_all"] },
  { id: "offie-essentials", builtin: true, name: "Survival essentials", sites: [],
    description: "The small, high-value core: medicine, water, food, knots, outdoors, radio and mechanics.",
    libraries: ESSENTIALS },
];
// Link for the Field identification section once that project exists. Leave empty to show "Coming soon".
const FIELD_ID_URL = "";

// Per-browser conveniences only; the server holds everything that matters.
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let S = null;                                        // last /api/state
let drives = null;                                   // last /api/drives
const picked = new Set(store.get("offie.picked", [])); // library names waiting for "Download & continue"
let pending = store.get("offie.pending", []);         // websites waiting to be copied: {url,title,topic,pageLimit}
let cat = store.get("offie.cat", null);              // selected category in step 1
let plats = null, platsDrive = null;                 // reader platforms ticked in step 3
let qaCat = null;                                    // quick-add dialog
let pv = null;                                       // item shown in the preview drawer
let lostConnection = false, missingWarned = false;
let scanAllowed = false;                             // the person said yes to looking for drives (this visit)
let driveError = "";                                 // last drive-scan failure, shown in the list
let connectDismissed = false;                        // "Not now" on the reconnect banner (this visit)
const sigs = {};
const changed = (key, val) => { const s = JSON.stringify(val); if (sigs[key] === s) return false; sigs[key] = s; return true; };
let qPkgs = store.get("offie.qpkgs", []);             // ids of packages added to the queue as a whole
const save = () => {
  // Forget packages once none of their items are left in the queue.
  if (S) qPkgs = qPkgs.filter(id => { const p = findPkg(id); return p && (p.libraries.some(n => picked.has(n)) || p.sites.some(x => pending.some(y => y.url === x.url))); });
  store.set("offie.picked", [...picked]); store.set("offie.pending", pending); store.set("offie.qpkgs", qPkgs);
};

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
function notice(msg, kind = "") {
  const n = $("#notice");
  n.className = "notice " + kind; n.innerHTML = msg; n.hidden = !msg;
  if (msg && !kind) setTimeout(() => { if (n.innerHTML === msg) n.hidden = true; }, 6000);
}
async function act(fn, ok) {
  try { const r = await fn(); if (ok) notice(typeof ok === "function" ? ok(r) : ok); }
  catch (e) { notice(esc(e.message), "error"); }
  await refresh();
}

// ------------------------------------------------------------------ catalog helpers
const hasDrive = () => !!(S?.drive && !S.drive.missing);
const sameTopic = (a, b) => (a || "") === (b || "");
const isVideo = n => /\(video\)/i.test(S.libraries[n]?.title || "");
const libSize = n => S.libraries[n]?.size || 0;
const isFat = fs => /^(msdos|vfat|fat|fat32)$/i.test(fs || "");
const liveJob = j => j.status === "running" || j.status === "queued";
const activeJob = name => S.jobs.find(j => j.library === name && liveJob(j));
const canPick = n => { const L = S.libraries[n]; return !!(L && L.options.length && (!L.file || L.outdated) && !activeJob(n)); };

function allCats() {
  const cats = S.categories.slice();
  if (S.custom.some(c => !c.topic) || pending.some(p => !p.topic))
    cats.push({ id: "__other", title: "Other websites", topics: [{ id: "", title: "Websites without a topic", kiwix: [] }] });
  return cats;
}
function topicIndex() {
  const m = {};
  allCats().forEach(c => c.topics.forEach(t => { m[t.id] = { ...t, cat: c }; }));
  return m;
}
function usage() {
  const u = {};
  S.categories.forEach(c => c.topics.forEach(t => t.kiwix.forEach(n => { u[n] = (u[n] || 0) + 1; })));
  return u;
}
const topicOnDrive = t => t.kiwix.some(n => S.libraries[n]?.file) || S.custom.some(c => sameTopic(c.topic, t.id) && c.file);
const topicPicked = t => t.kiwix.some(n => picked.has(n)) || pending.some(p => sameTopic(p.topic, t.id));

// ------------------------------------------------------------------ routing
function step() {
  const h = location.hash.slice(1);
  return STEPS.includes(h) ? h : "home";
}
// Back arrow: each in-app page change is numbered in history.state, so "back" only leaves pages this visit opened.
const navDepth = () => history.state?.depth || 0;
if (!history.state) history.replaceState({ depth: 0 }, "");
let lastDepth = navDepth();
window.addEventListener("hashchange", () => {
  if (history.state?.depth == null) history.replaceState({ depth: lastDepth + 1 }, "");
  lastDepth = navDepth();
  render(); window.scrollTo(0, 0);
});
const PARENT = { pick: "home", drive: "pick", build: "drive" };
$("#back-btn").onclick = () => { if (navDepth() > 0) history.back(); else location.hash = "#" + (PARENT[step()] || "home"); };

function render() {
  if (!S) return;
  let st = step();
  if (st === "build" && !hasDrive()) {
    history.replaceState(history.state, "", "#drive"); st = "drive";
  }
  STEPS.forEach(s => { $("#step-" + s).hidden = s !== st; });
  document.body.classList.toggle("on-home", st === "home");
  renderHeader(st);
  renderConnectBanner();
  $$(".lib-folder").forEach(x => { x.textContent = hasDrive() ? S.drive.folder : DEFAULT_FOLDER; });
  if (st === "home") renderHomeStep();
  else if (st === "drive") renderDriveStep();
  else if (st === "pick") renderPickStep();
  else renderBuildStep();
  $("#bar").hidden = st !== "home";  // the queue bar is only on the landing page; other steps use the Queue button
  if (st === "home") renderBar(st);
  renderDriveBtn(st);
  if ($("#downloads").open) renderAllJobs();
  if ($("#drives-pop").open) renderDrivesPop();
  if ($("#preview").open) renderPreviewAction();
  if ($("#qa").open) renderQA();
  if ($("#packages").open) renderPackages();
  if ($("#queue").open) renderQueue();
  updateProgress();
}

function renderDriveBtn(st) {
  // The drive downloads go to: the one picked in the Drive pop-up, else the connected or last-used drive.
  const dr = (st === "home" && homeTarget()) || (hasDrive() && { name: S.drive.home ? "This computer" : S.drive.name }) || S.savedDrive;
  const dn = dr ? dr.name + (dr === S.savedDrive ? " (last used)" : "") : "none yet";
  $("#drive-name").textContent = "· " + dn;
  $("#drives-btn").setAttribute("aria-label", `Drive: ${dn}. Open step 2 to switch drives.`);
}

// Top-bar Drive pop-up: switch between plugged-in drives quickly; "More" opens step 2.
function renderDrivesPop() {
  if (scanOk() && drives === null && !scanning) loadDrives();
  const cur = (step() === "home" && homeTarget()?.path) || (hasDrive() && S.drive.path);
  const rows = homeDrives().map(d => {
    const on = d.path === cur;
    const info = [d.free != null && fmt(d.free) + " free", d.fstype, d.lastUsed && !d.connected && "last used"].filter(Boolean).join(" · ");
    return `<button type="button" class="drive-opt" data-act="pop-drive" data-path="${esc(d.path)}" aria-pressed="${on}">
      <span class="radio" aria-hidden="true"></span><span class="grow"><b>${esc(d.name)}</b><small class="muted">${esc(info)}</small></span></button>`;
  }).join("");
  let html = rows;
  if (!scanOk()) html += `<div class="pop-consent"><p class="muted small">Offie asks before it looks for USB sticks, SD cards and external drives.</p>
    <button type="button" class="btn small primary" data-act="scan-once">Look for drives</button></div>`;
  else if (scanning) html += `<p class="muted small">Looking for removable drives…</p>`;
  else if (!rows) html = `<p class="muted small">No removable drives found. Plug one in and click Look again, or choose More to use a folder.</p>`;
  if (changed("drivesPop", html)) $("#drives-pop-list").innerHTML = html;
  $("[data-act=pop-rescan]").hidden = !scanOk();
}
$("#drives-btn").onclick = e => { delete sigs.drivesPop; renderDrivesPop(); openPopup("#drives-pop", e.currentTarget); };

function renderHeader(st) {
  const d = S.drive;
  $("#back-btn").hidden = st === "home" && !navDepth();
  const q = cartCount();
  $("#queue-count").textContent = q;
  $("#queue-btn").classList.toggle("has", q > 0);
  $("#queue-btn").setAttribute("aria-label", `Queue, ${plural(q, "item", "items")}`);
  const done = { home: false, drive: hasDrive(), pick: picked.size + pending.length > 0 || Object.values(S.libraries).some(l => l.file) || S.custom.length > 0, build: false };
  const at = ["pick", "drive", "build"].indexOf(st);
  document.querySelectorAll(".step-arrow").forEach(el => el.classList.toggle("lit", at > ["pick", "drive", "build"].indexOf(el.dataset.after)));
  document.querySelectorAll(".steps a").forEach(a => {
    const s = a.dataset.step;
    if (s === st) a.setAttribute("aria-current", "step"); else a.removeAttribute("aria-current");
    a.classList.toggle("done", s !== st && done[s]);
  });
}

// ------------------------------------------------------------------ step 2: choose a drive
function verdict(d) {
  if (d.kind === "computer") return { warn: true, title: "Not portable", text: "Fine for trying things out, but you can't unplug it and take it with you." };
  if (isFat(d.fstype)) return { warn: true, title: "Can't hold files over 4 GB", text: "Big libraries like Wikipedia and the videos would be blocked. Reformat it as exFAT to use them (this erases the drive)." };
  if (d.free < 2 * GB) return { warn: true, title: "Almost full", text: `Only ${fmt(d.free)} free: room for a few small libraries.` };
  if (d.free < 60 * GB) return { warn: false, title: "Fine for the essentials", text: "Room for the medicine, water, food and skills libraries, but not all of Wikipedia." };
  return { warn: false, title: "Good choice", text: "Works on every computer and has room for big libraries like Wikipedia." };
}

function driveCard(d) {
  const v = verdict(d), sel = d.path === S.drive?.path;
  const used = d.total ? (100 * (1 - d.free / d.total)).toFixed(0) : 0;
  const kind = { external: "External drive", computer: "Your home folder", folder: "Folder" }[d.kind] || "Drive";
  const lib = d.library?.count
    ? `<div class="has-lib">Already has a library on it (${plural(d.library.count, "library", "libraries")}, ${fmt(d.library.size)}). Picking it lets you continue where you left off.</div>` : "";
  return `<button type="button" class="drive-card" data-act="drive" data-path="${esc(d.path)}" aria-pressed="${sel}">
    <div class="top"><span class="radio"></span><div class="grow">
      <span class="name">${esc(d.name)}</span><span class="pill">${esc(d.fstype || "Folder")}</span>
      <div class="sub">${kind} · ${esc(d.path)}</div></div></div>
    <div><div class="meter"><span class="used" style="width:${used}%"></span></div>
      <small class="muted"><b>${fmt(d.free)} free</b> of ${fmt(d.total)}</small></div>
    <div class="verdict ${v.warn ? "warn" : ""}">${v.warn ? ICON.warn : ICON.check}<div><b>${esc(v.title)}</b><small>${esc(v.text)}</small></div></div>
    ${lib}</button>`;
}

const scanOk = () => scanAllowed || S.permissions.scanAlways;
let scanning = false;

function renderConnectBanner() {
  const b = $("#connect-banner"), sd = S.savedDrive;
  b.hidden = !sd || connectDismissed;
  if (b.hidden) return;
  const h = sd.available
    ? `<div class="grow"><b>Connect to “${esc(sd.name)}” again?</b><p class="muted small">Your library was saved there last time. Offie won't open the drive until you say so.</p></div>
       <div class="row-actions"><button type="button" class="btn primary" data-act="connect">Connect</button>
       <button type="button" class="btn" data-act="connect-always">Connect, and don't ask again</button>
       <button type="button" class="btn ghost" data-act="connect-later">Not now</button></div>`
    : `<div class="grow"><b>“${esc(sd.name)}” isn't plugged in</b><p class="muted small">Plug it in to keep working on the library saved there, or choose another drive in step 2.</p></div>
       <div class="row-actions"><button type="button" class="btn" data-act="connect">Try again</button>
       <button type="button" class="btn ghost" data-act="connect-later">Not now</button></div>`;
  if (changed("banner", h)) b.innerHTML = h;
}

const CONSENT = `<div class="consent"><h3>Can Offie look for removable drives?</h3>
  <p class="muted small">Offie checks for external hard drives, USBs, and SD cards that are plugged in. Offie only reads these drives' names, sizes, and free space; your computer's disks are not shown be default; use “Use a folder or another disk”.</p>
  <div class="row-actions"><button type="button" class="btn primary" data-act="scan-once">Yes, look for drives</button>
  <button type="button" class="btn" data-act="scan-always">Yes, and don't ask again</button></div></div>`;

// Step 2 offers two ways to pick where the library goes. The chosen one is highlighted; the other is greyed out but still usable.
let driveMode = store.get("offie.driveMode", null);
function currentMode() {
  if (driveMode) return driveMode;
  if (hasDrive()) return drives?.some(x => x.path === S.drive.path) || (drives === null && scanOk()) ? "scan" : "folder";
  return scanOk() ? "scan" : null;
}
function setDriveMode(m) {
  if (m === currentMode()) return;
  driveMode = m; store.set("offie.driveMode", m); render();
}

// The library folder's name: the one already on the drive, else the package being downloaded, else OfflineLibrary.
const DEFAULT_FOLDER = "OfflineLibrary";
const folderName = n => (n || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim().replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 60) || DEFAULT_FOLDER;
function queuePackage() {
  if (qPkgs.length !== 1) return null;
  const p = findPkg(qPkgs[0]);
  if (!p) return null;
  const all = [...picked].every(n => p.libraries.includes(n)) && pending.every(x => p.sites.some(y => y.url === x.url));
  return all ? p : null;
}
const libFolder = () => hasDrive() && S.drive.folderExists ? S.drive.folder : folderName(queuePackage()?.name);

function renderDriveStep() {
  if (scanOk() && drives === null && !scanning) loadDrives();
  const d = S.drive, mode = currentMode();
  const onList = hasDrive() && (drives || []).some(x => x.path === d.path);
  const cards = (drives || []).map(driveCard).join("");
  let html = "";
  if (!scanOk()) html = "";
  else if (scanning && drives === null) html = `<p class="empty">Looking for removable drives…</p>`;
  else if (driveError) html = `<p class="empty">${esc(driveError)}</p>` + cards;
  else html = cards || `<p class="empty">No removable drives found. Plug in a USB stick or external drive, then click Look for drives again. To use your computer's own disk, choose “Use a folder or another disk”.</p>`;
  if (changed("drives", html)) $("#drive-list").innerHTML = html;
  const acts = scanOk()
    ? `<button class="btn small" type="button" data-act="rescan" ${scanning ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg><span>${scanning ? "Looking…" : "Look for drives again"}</span></button>`
    : `<button type="button" class="btn primary" data-act="scan-once">Yes, look for drives</button>
       <button type="button" class="btn" data-act="scan-always">Yes, and don't ask again</button>`;
  if (changed("scanActs", acts)) $("#scan-actions").innerHTML = acts;
  const folder = hasDrive() && !onList ? driveCard({ ...d, kind: d.home ? "computer" : "folder", name: d.home ? "This computer" : d.name, library: null }) : "";
  if (changed("folderCard", folder)) $("#folder-card").innerHTML = folder;
  $$(".drive-choose .choice").forEach(c => {
    c.classList.toggle("on", c.dataset.mode === mode);
    c.classList.toggle("off", !!mode && c.dataset.mode !== mode);
    $("input[type=radio]", c).checked = c.dataset.mode === mode;
  });
  const name = libFolder();
  const fnote = hasDrive() && S.drive.folderExists
    ? `Your library goes in the <b>${esc(name)}</b> folder already on this drive. Nothing else on the drive is changed or deleted.`
    : name === DEFAULT_FOLDER
      ? `We add one folder, <b>${DEFAULT_FOLDER}</b> (named after your package instead, if you download one). Nothing else on the drive is changed or deleted.`
      : `We add one folder, <b>${esc(name)}</b>, named after your package. Nothing else on the drive is changed or deleted.`;
  if (changed("folderNote", fnote)) $("#folder-note").innerHTML = fnote;
  const p = S.permissions, auto = [p.scanAlways && "looks for drives", p.autoConnect && "reconnects to your saved drive"].filter(Boolean);
  const note = auto.length ? `Offie ${auto.join(" and ")} without asking. <button type="button" class="link-btn" data-act="reset-perms">Ask me again</button>` : "";
  $("#perm-note").hidden = !note;
  if (changed("permNote", note)) $("#perm-note").innerHTML = note;
  // What to do next, now that the bottom bar is only on the landing page.
  let next = "";
  if (hasDrive()) {
    const n = cartCount();
    if (n) {
      const { sub, over } = cartFit(d);
      next = `<div class="grow"><b>${esc(cartTitle())} → ${esc(d.home ? "this computer" : d.name)}</b><small class="${over ? "over" : "muted"}">${esc(sub)}</small></div>
        <button type="button" class="btn primary big" data-act="go">Download &amp; continue</button>`;
    } else next = `<div class="grow"><b>${esc(d.home ? "This computer" : d.name)} · ${fmt(d.free)} free</b><small class="muted">Your queue is empty. Add topics in step 1, or go on to build the drive.</small></div>
        <a class="btn primary big" href="#build">Next: build &amp; test →</a>`;
  }
  if (changed("driveNext", next)) $("#drive-next").innerHTML = next;
  renderSpace();
}
document.addEventListener("change", e => { if (e.target.name === "drive-mode") setDriveMode(e.target.value); });
document.addEventListener("focusin", e => { const c = e.target.closest?.(".drive-choose .choice.off"); if (c && e.target.type !== "radio") setDriveMode(c.dataset.mode); });

function spaceRow(r, d) {
  const libs = S.libraries;
  const total = r.names.reduce((a, n) => a + libSize(n), 0);
  const need = r.names.filter(n => !libs[n].file);
  const needSize = need.reduce((a, n) => a + libSize(n), 0);
  let mark = "·", cls = "";
  if (d && (total || r.sites)) {
    const ok = needSize <= d.free && !(isFat(d.fstype) && need.some(n => libSize(n) >= 4 * GB));
    mark = ok ? "✓" : "✕"; cls = ok ? "yes" : "no";
  }
  const sites = r.sites ? ` + ${plural(r.sites, "website", "websites")}` : "";
  const size = total ? (r.names.length > 1 ? "about " : "") + fmt(total) + sites : r.sites ? plural(r.sites, "website", "websites") + ", size known after copying" : "size shown once the catalog loads";
  return `<div><span class="mark ${cls}" aria-label="${cls === "yes" ? "Fits" : cls === "no" ? "Doesn't fit" : ""}">${mark}</span>
    <div class="grow">${r.pkg ? `<div class="pkg-tag">Your package</div>` : ""}<b class="small">${esc(r.label)}</b> <span class="muted small">· ${size}</span>
    <div class="muted small">${esc(r.note)}</div>
    ${r.pkg ? `<button type="button" class="btn small" data-act="pkg-add" data-id="${esc(r.pkg)}">${pkgInCart(r.pkgObj) ? "✓ In your queue" : "Add to queue"}</button>` : ""}</div></div>`;
}
function renderSpace() {
  const libs = S.libraries, d = hasDrive() ? S.drive : null;
  const recent = S.packages.filter(p => !p.edited).slice(-2).reverse().map(p => ({
    label: p.name, names: p.libraries.filter(n => libs[n]), sites: p.sites.length, pkg: p.id, pkgObj: p,
    note: p.description || `Saved ${p.created}`,
  }));
  const rows = [
    { label: "Essentials", names: ESSENTIALS.filter(n => libs[n]), note: "Medicine, water, food, knots, outdoors, radio, mechanics" },
    ...recent,
    { label: "Everything in the app", names: Object.keys(libs), note: "Every library at its chosen size" },
  ].filter(r => r.names.length || r.sites);
  const html = rows.map(r => spaceRow(r, d)).join("");
  if (changed("space", html)) $("#space-list").innerHTML = html;
  $("#fit-note").textContent = d ? `Checked against ${d.home ? "this computer" : d.name}.` : "Pick a drive to see what fits.";
}

async function loadDrives() {
  if (scanning) return;
  scanning = true; driveError = "";
  render();
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch("/api/drives", { signal: ctl.signal });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    drives = data;
  } catch (e) {
    driveError = e.name === "AbortError"
      ? "Looking for drives took too long. A drive may be busy or failing; unplug it, plug it back in, and try again."
      : `Couldn't look for drives: ${e.message}. Is the builder still running?`;
    drives = drives || [];
  } finally {
    clearTimeout(timer); scanning = false;
  }
  render();
}
$("#drive-form").onsubmit = e => {
  e.preventDefault();
  const p = $("#drive-path").value.trim();
  if (p) { driveMode = "folder"; store.set("offie.driveMode", driveMode); act(() => api("/api/settings", { drive: p }), "Folder selected."); }
};

// ------------------------------------------------------------------ step 1: choose topics
function libRow(n, use) {
  const L = S.libraries[n];
  if (!L) return "";
  const job = activeJob(n), added = picked.has(n), have = L.file && !L.outdated;
  const opt = L.options.find(o => o.flavour === L.flavour);
  const meta = [fmt(have ? L.fileSize : L.size)];
  if (isVideo(n)) meta.push("video");
  if (use[n] > 1) meta.push(`also covers ${plural(use[n] - 1, "other topic", "other topics")}, downloaded once`);
  if (opt?.date) meta.push("updated " + opt.date.slice(0, 7));
  const flav = L.options.length > 1 && !have && !job
    ? `<select data-act="flavour" data-name="${esc(n)}" aria-label="Version of ${esc(L.title)}">${L.options.map(o =>
      `<option value="${esc(o.flavour)}" ${o.flavour === L.flavour ? "selected" : ""}>${esc(FLAVOURS[o.flavour] ?? o.flavour)} · ${fmt(o.size)}</option>`).join("")}</select>` : "";
  let actions;
  if (job) actions = `<span class="pill busy" data-jobtag="${esc(n)}">${job.status === "queued" ? "Waiting" : Math.round(job.progress * 100) + "%"}</span>`;
  else if (have) actions = `${ON_DRIVE}<button type="button" class="btn small ghost danger" data-act="del" data-file="${esc(L.file)}" aria-label="Remove ${esc(L.title)} from the drive">Remove</button>`;
  else if (!L.options.length) actions = `<span class="pill">Not in catalog yet</span>`;
  else actions = `${L.outdated ? `${ON_DRIVE}<span class="pill warn">Update available</span>` : ""}
    <button type="button" class="btn add" data-act="pick" data-name="${esc(n)}" aria-pressed="${added}">${added ? "✓ Added" : L.outdated ? "Update" : "Add"}</button>`;
  return `<div class="lib ${added ? "added" : ""}">
    <div class="info"><b>${titleLink(siteFor(n), L.title)}</b>${L.summary ? `<div class="desc">${esc(L.summary)}</div>` : ""}
      <div class="meta"><span>${meta.map(esc).join(" · ")}</span>${flav}</div></div>
    <div class="actions">${actions}${L.options.length ? `<button type="button" class="icon-btn eye-btn" data-act="preview-lib" data-name="${esc(n)}" aria-label="Preview ${esc(L.title)}" title="Preview">${ICON.eye}</button>` : ""}</div>
    ${job ? `<div class="bar-line"><span data-jobbar="${esc(n)}" style="width:${job.progress * 100}%"></span></div>` : ""}</div>`;
}

const siteAttrs = s => `data-url="${esc(s.url)}" data-title="${esc(s.title)}" data-topic="${esc(s.topic || "")}" data-pages="${esc(s.pageLimit || "")}"`;
const previewSiteBtn = s => `<button type="button" class="icon-btn eye-btn" data-act="preview-site" ${siteAttrs(s)} aria-label="Preview ${esc(s.title)}" title="Preview">${ICON.eye}</button>`;
const editSiteBtn = (kind, key, title) => `<button type="button" class="icon-btn eye-btn" data-act="edit-site" data-kind="${kind}" data-key="${esc(key)}" aria-label="Edit ${esc(title)}" title="Edit topic or address">${ICON.edit}</button>`;
const titleLink = (url, title) => url ? `<a class="title-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="Open the full website">${esc(title)}</a>` : esc(title);

// The original website a library was made from, so "open the full website" goes somewhere real.
// Libraries with no public website of their own (the zimgit collections) fall back to their online Kiwix copy.
function siteFor(n) {
  const [base, lang] = n.split("_");
  const wm = { wikipedia: "wikipedia.org", wiktionary: "wiktionary.org", wikivoyage: "wikivoyage.org", wikibooks: "wikibooks.org" };
  const known = { wikispecies: "https://species.wikimedia.org", ifixit: "https://www.ifixit.com", appropedia: "https://www.appropedia.org",
    energypedia: "https://energypedia.info", gardenology: "https://www.gardenology.org", mdwiki: "https://mdwiki.org",
    "canadian-prepper": "https://www.youtube.com/@CanadianPrepper" };
  if (wm[base]) return `https://${lang}.${wm[base]}`;
  if (known[base]) return known[base];
  if (base.includes(".")) return "https://" + base;
  return kiwixUrl(n);
}
function kiwixUrl(n) {
  const L = S.libraries[n], opt = L?.options.find(o => o.flavour === L.flavour) || L?.options[0];
  return opt ? "https://browse.library.kiwix.org/viewer#" + opt.url.split("/").pop().replace(/\.zim$/, "") : "";
}

function siteOnDriveRow(c) {
  return `<div class="lib"><div class="info"><b>${titleLink(c.url, c.title)}</b><div class="desc">${esc(host(c.url))}</div><div class="meta">Website you copied</div></div>
    <div class="actions">${ON_DRIVE}<button type="button" class="btn small ghost danger" data-act="del" data-file="${esc(c.file)}" aria-label="Remove ${esc(c.title)} from the drive">Remove</button>${editSiteBtn("drive", c.file, c.title)}${previewSiteBtn(c)}</div></div>`;
}
function crawlRow(j) {
  return `<div class="lib"><div class="info"><b>${esc(j.title || host(j.url))}</b><div class="desc">${esc(host(j.url))}</div>
    <div class="meta" data-jobmsg="${j.id}">${esc(jobDetail(j))}</div></div>
    <div class="actions"><span class="pill busy">${j.status === "queued" ? "Waiting" : "Copying"}</span></div></div>`;
}
function pendingRow(p) {
  return `<div class="lib added"><div class="info"><b>${titleLink(p.url, p.title)}</b><div class="desc">${esc(host(p.url))}</div>
    <div class="meta">Website · copied when you click Download &amp; continue</div></div>
    <div class="actions"><button type="button" class="btn add" data-act="unpend" data-url="${esc(p.url)}" aria-pressed="true">✓ Added</button>${editSiteBtn("pending", p.url, p.title)}${previewSiteBtn(p)}</div></div>`;
}

function topicCard(t, use) {
  const pill = topicOnDrive(t) ? `<span class="pill on">On drive</span>` : topicPicked(t) ? "" : `<span class="pill">Guide page only</span>`;
  const crawls = S.jobs.filter(j => j.kind === "crawl" && liveJob(j) && sameTopic(j.topic, t.id));
  const rows = t.kiwix.map(n => libRow(n, use)).join("")
    + S.custom.filter(c => sameTopic(c.topic, t.id)).map(siteOnDriveRow).join("")
    + crawls.map(crawlRow).join("")
    + pending.filter(p => sameTopic(p.topic, t.id)).map(pendingRow).join("");
  const edit = t.id ? `<button type="button" class="icon-btn eye-btn" data-act="edit-topic" data-id="${esc(t.id)}" aria-label="Edit ${esc(t.title)}" title="Edit this topic">${ICON.edit}</button>` : "";
  return `<article class="topic"><div class="topic-head"><h3>${esc(t.title)}</h3>${pill}${edit}</div>
    ${rows ? `<div class="libs">${rows}</div>` : ""}
    ${t.id ? `<button type="button" class="add-site" data-act="add-site" data-topic="${esc(t.id)}">${ICON.plus}Add a website to this topic</button>` : ""}</article>`;
}

// Sidebar: your top 3 packages (favorites first), with Add to queue, and See more for the Packages pop-up.
function renderSidePkgs() {
  const all = allPackages(), favs = favIds();
  const ranked = [...favs.map(findPkg).filter(Boolean), ...all.filter(p => !favs.includes(p.id))];
  const rows = ranked.slice(0, 3).map(p => {
    const inQ = pkgInCart(p);
    return `<div class="side-pkg"><div class="grow"><b>${esc(p.name)}</b><small>${esc(pkgItems(p).split(" plus ")[0])}</small></div>
      <button type="button" class="btn small" data-act="pkg-toggle" data-id="${esc(p.id)}" aria-pressed="${inQ}">${inQ ? "✓ Added" : "Add"}</button></div>`;
  }).join("");
  const html = rows ? `<div class="eyebrow">Packages</div>${rows}${ranked.length > 3 ? `<button type="button" class="link-btn see-more" data-act="side-pkgs-more">See more (${ranked.length - 3})</button>` : ""}` : "";
  if (changed("sidePkgs", html)) $("#side-pkgs").innerHTML = html;
}

function renderPickStep() {
  renderSidePkgs();
  const cats = allCats();
  if (!cats.some(c => c.id === cat)) cat = cats[0]?.id;
  const q = $("#filter").value.trim().toLowerCase();
  const sig = [cat, q, [...picked], pending, S.drive?.path, S.custom, S.catalogLoaded, S.categories,
    Object.entries(S.libraries).map(([k, v]) => [k, v.file, v.flavour, v.options.length, v.outdated]),
    S.jobs.filter(j => (j.library || j.kind === "crawl") && liveJob(j)).map(j => [j.id, j.status])];
  if (!changed("pick", sig)) return;
  $("#catalog-status").textContent = S.catalogLoaded ? "" : "Catalog not loaded (offline?)";
  $("#cat-list").innerHTML = cats.map(c => {
    const covered = c.topics.filter(topicOnDrive).length;
    return `<button type="button" class="cat-btn" data-act="cat" data-id="${esc(c.id)}" aria-current="${!q && c.id === cat}">
      <b>${esc(c.title)}</b><small>${covered} of ${plural(c.topics.length, "topic", "topics")} on drive</small></button>`;
  }).join("");
  const use = usage();
  if (q) {
    const match = (c, t) => (c.title + " " + t.title + " " + t.kiwix.map(n => S.libraries[n]?.title || "").join(" ")).toLowerCase().includes(q);
    const groups = cats.map(c => ({ c, ts: c.topics.filter(t => match(c, t)) })).filter(g => g.ts.length);
    $("#cat-title").textContent = "Search results";
    $("#topics").innerHTML = groups.map(g => `<h3 class="group-title">${esc(g.c.title)}</h3>` + g.ts.map(t => topicCard(t, use)).join("")).join("")
      || `<p class="empty">No topics or libraries match “${esc(q)}”.</p>`;
  } else {
    const c = cats.find(x => x.id === cat);
    $("#cat-title").textContent = c.title;
    $("#topics").innerHTML = c.topics.map(t => topicCard(t, use)).join("");
  }
}
$("#filter").oninput = () => render();
$("#refresh").onclick = async e => {
  e.target.disabled = true; $("#catalog-status").textContent = "Contacting library.kiwix.org…";
  await act(() => api("/api/resolve", {}), r => `Catalog updated: ${r.resolved} libraries.`);
  e.target.disabled = false;
};

// ------------------------------------------------------------------ quick add
let qaEdit = null;  // null = adding a website; otherwise { kind: "pending" | "drive", url, file } being edited
function fillTopics(selected) {
  $("#qa-topic").innerHTML = S.categories.map(c => `<optgroup label="${esc(c.title)}">${c.topics.map(t =>
    `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join("")}</optgroup>`).join("");
  $("#qa-topic").value = selected;
}
function openQA(topic) {
  const idx = topicIndex();
  qaEdit = null;
  qaCat = topic && idx[topic] ? idx[topic].cat : allCats().find(c => c.id === cat) || S.categories[0];
  fillTopics(topic || qaCat.topics[0]?.id || S.categories[0].topics[0].id);
  const f = $("#qa-form");
  f.url.value = ""; f.url.readOnly = false;
  $("#qa-kind").textContent = "Quick add";
  $("#qa-submit").textContent = "Add to queue";
  $("#qa-close").textContent = "Done";
  $("#qa-note").textContent = "Copied with Docker when you download. Only copy sites you're allowed to.";
  $("#qa-status").textContent = "";
  delete sigs.qa;
  renderQA();
  $("#qa").showModal();
}
// Edit a website after adding it: a queued one can change topic and address; one already copied can change topic.
function openEditSite(kind, key) {
  const site = kind === "pending" ? pending.find(p => p.url === key) : S.custom.find(c => c.file === key);
  if (!site) return;
  qaEdit = { kind, url: site.url, file: site.file };
  const idx = topicIndex();
  qaCat = idx[site.topic]?.cat || S.categories[0];
  fillTopics(site.topic || S.categories[0].topics[0].id);
  const f = $("#qa-form");
  f.url.value = site.url; f.url.readOnly = kind === "drive";
  $("#qa-kind").textContent = "Edit website";
  $("#qa-submit").textContent = "Save changes";
  $("#qa-close").textContent = "Cancel";
  $("#qa-note").textContent = kind === "drive"
    ? "This website is already copied, so only its topic can change. To use a different address, remove it and add the new one."
    : "Changes apply before the website is copied.";
  $("#qa-status").textContent = "";
  delete sigs.qa;
  renderQA();
  $("#qa").showModal();
}
function renderQA() {
  const topic = $("#qa-topic").value, idx = topicIndex();
  if (!changed("qa", [topic, S.tools.docker, qaEdit])) return;
  $("#qa-title").textContent = qaEdit ? (idx[topic]?.title || "Website") : (idx[topic]?.cat || qaCat).title;
  $("#qa-docker").hidden = S.tools.docker !== false || qaEdit?.kind === "drive";
}
function typedSite() {
  const f = $("#qa-form");
  if (!f.reportValidity()) return null;
  const url = f.url.value.trim();
  return { url, title: host(url), topic: f.topic.value, pageLimit: 200 };
}
function togglePending(item) {
  if (pending.some(p => p.url === item.url)) pending = pending.filter(p => p.url !== item.url);
  else pending.push(item);
  save(); render();
}
$("#quick-add").onclick = () => openQA(null);
$("#qa-topic").onchange = () => renderQA();
$("#qa-preview").onclick = () => { const s = typedSite(); if (s) openPreview({ type: "site", ...s }); };
$("#qa-form").onsubmit = async e => {
  e.preventDefault();
  const s = typedSite(); if (!s) return;
  const topicName = topicIndex()[s.topic]?.title;
  if (qaEdit?.kind === "drive") {
    try {
      await api("/api/custom/update", { file: qaEdit.file, topic: s.topic });
      notice(`Moved it to “${esc(topicName)}”. Build the drive again to update its home page.`);
      $("#qa").close();
    } catch (err) { $("#qa-status").textContent = err.message; }
    await refresh();
    return;
  }
  if (qaEdit?.kind === "pending") {
    const item = pending.find(p => p.url === qaEdit.url);
    if (!item) { $("#qa").close(); return; }
    if (s.url !== item.url && pending.some(p => p.url === s.url)) { $("#qa-status").textContent = `${s.title} is already in your queue.`; return; }
    const keepTitle = item.title && item.title !== host(item.url) && s.url === item.url;
    Object.assign(item, { url: s.url, topic: s.topic, title: keepTitle ? item.title : s.title });
    save(); render(); $("#qa").close();
    notice(`Saved changes to ${esc(item.title)}.`);
    return;
  }
  if (pending.some(p => p.url === s.url)) { $("#qa-status").textContent = `${s.title} is already added.`; return; }
  pending.push(s); save();
  $("#qa-status").textContent = `Added ${s.title} to “${topicName}”. It's copied when you click Download & continue.`;
  e.target.url.value = "";
  render();
};

// ------------------------------------------------------------------ preview drawer
// Swaps in a fresh iframe instead of changing its src: navigating an iframe adds browser history entries,
// which would make the Back arrow (and the browser's back button) step through previews instead of pages.
function setPvFrame(url) {
  const old = $("#pv-frame"), f = old.cloneNode(false);
  f.removeAttribute("src");
  if (url) f.src = url;
  old.replaceWith(f);
}
async function openPreview(item) {
  pv = item;
  const msg = $("#pv-msg");
  setPvFrame(""); msg.hidden = true;
  if (item.type === "lib") {
    const L = S.libraries[item.name];
    const opt = L.options.find(o => o.flavour === L.flavour) || L.options[0];
    const book = opt.url.split("/").pop().replace(/\.zim$/, "");
    const url = "https://browse.library.kiwix.org/viewer#" + book;
    $("#pv-kind").textContent = "Offline library preview";
    $("#pv-title").textContent = L.title;
    $("#pv-meta").textContent = `${fmt(opt.size)} download · ${FLAVOURS[opt.flavour] ?? opt.flavour}${opt.date ? " · updated " + opt.date : ""}`;
    $("#pv-url").textContent = "library.kiwix.org · " + book;
    $("#pv-open").href = siteFor(item.name);
    setPvFrame(url);
  } else {
    $("#pv-kind").textContent = "Website preview";
    $("#pv-title").textContent = item.title;
    $("#pv-meta").textContent = [item.pageLimit ? `Copies about ${item.pageLimit} pages` : "", topicIndex()[item.topic]?.title].filter(Boolean).join(" · ");
    $("#pv-url").textContent = item.url;
    $("#pv-open").href = item.url;
    msg.hidden = false; msg.textContent = "Checking whether this site can be shown here…";
  }
  renderPreviewAction();
  if (!$("#preview").open) $("#preview").showModal();
  if (item.type !== "site") return;
  try {
    const r = await api("/api/frameable?url=" + encodeURIComponent(item.url));
    if (pv !== item) return;
    if (r.ok) { msg.hidden = true; setPvFrame(item.url); }
    else msg.innerHTML = `${ICON.warn}<b>This website can't be previewed here</b>
      <p>${esc(r.reason)} You can still look at it in a new tab, and you can still add it to your drive.</p>
      <a class="btn primary big" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">Open in new tab ↗</a>`;
  } catch (e) { if (pv === item) msg.textContent = e.message; }
}
function renderPreviewAction() {
  if (!pv) return;
  let h;
  if (pv.type === "lib") {
    const n = pv.name, L = S.libraries[n], job = activeJob(n);
    if (job) h = `<span class="pill busy">${job.status === "queued" ? "Waiting to download" : "Downloading"}</span>`;
    else if (L.file && !L.outdated) h = ON_DRIVE;
    else { const a = picked.has(n); h = `<button type="button" class="btn add big" data-act="pick" data-name="${esc(n)}" aria-pressed="${a}">${a ? "✓ Added (click to remove)" : "Add to my drive"}</button>`; }
  } else if (S.custom.some(c => c.url === pv.url)) h = ON_DRIVE;
  else if (!pv.topic) h = `<span class="muted small">Add it from Quick add to pick a topic.</span>`;
  else { const a = pending.some(p => p.url === pv.url); h = `<button type="button" class="btn add big" data-act="pv-site" aria-pressed="${a}">${a ? "✓ Added (click to remove)" : "Add to my drive"}</button>`; }
  if ($("#pv-action").innerHTML !== h) $("#pv-action").innerHTML = h;
}
$("#preview").addEventListener("close", () => { pv = null; setPvFrame(""); });

// ------------------------------------------------------------------ step 3: build & test
function jobDetail(j) {
  if (j.status === "queued") return "Starts when the one above finishes";
  if (j.status === "running") {
    const eta = j.kind === "download" && j.speed > 0 && j.total ? ` · about ${Math.max(1, Math.ceil((j.total - j.done) / j.speed / 60))} min left` : "";
    return j.message + eta;
  }
  if (j.status === "error") return j.message + (j.library ? ". Try again picks up where it stopped." : "");
  if (j.status === "cancelled") return "Not saved";
  return j.message;
}
function jobRow(j) {
  const pill = {
    done: '<span class="pill on">Done</span>', running: `<span class="pill busy" data-jobpct="${j.id}">${Math.round(j.progress * 100)}%</span>`,
    queued: '<span class="pill">Waiting</span>', error: '<span class="pill warn">Stopped</span>', cancelled: '<span class="pill">Cancelled</span>',
  }[j.status] || "";
  const retry = (j.status === "error" || j.status === "cancelled") && (j.library || j.url)
    ? `<button type="button" class="btn small primary" data-act="retry" data-id="${j.id}">Try again</button>` : "";
  const cancel = liveJob(j) ? `<button type="button" class="btn small" data-act="cancel" data-id="${j.id}">Cancel</button>` : "";
  return `<div class="job"><div class="info"><b>${esc(j.label)}</b><small data-jobmsg="${j.id}">${esc(jobDetail(j))}</small></div>${pill}${retry}${cancel}
    ${j.status === "running" ? `<div class="bar-line"><span data-jobbarid="${j.id}" style="width:${j.progress * 100}%"></span></div>` : ""}</div>`;
}
const fileJobs = () => S.jobs.filter(j => j.kind === "download" || j.kind === "crawl");
const buildBusy = () => S.jobs.find(j => j.kind === "build" && liveJob(j));
const isBuilt = () => S.guideBuilt && S.indexBuilt;

function renderBuildStep() {
  const jobs = fileJobs();
  const done = jobs.filter(j => j.status === "done").length;
  $("#dl-summary").textContent = jobs.length ? `${done} of ${jobs.length} finished` : "";
  if (changed("buildJobs", jobs.map(j => [j.id, j.status])))
    $("#build-jobs").innerHTML = jobs.map(jobRow).join("") || `<p class="empty">Nothing downloading. Libraries and websites you add in step 1 show up here.</p>`;

  if (platsDrive !== S.drive.path) {
    plats = new Set(S.tools.platforms.filter(p => p.installed || p.id === S.tools.host).map(p => p.id));
    platsDrive = S.drive.path;
  }
  const platHtml = S.tools.platforms.map(p => {
    const on = p.installed || plats.has(p.id);
    const status = (p.installed ? "Reader on drive" : on ? "Added when you build" : "Not included") + (p.id === S.tools.host ? " · this computer" : "");
    return `<button type="button" class="plat" data-act="plat" data-id="${esc(p.id)}" aria-pressed="${on}" ${p.installed ? "disabled" : ""}>
      <span class="box"></span><span><b>${esc(p.label)}</b><small>${status}</small></span></button>`;
  }).join("");
  if (changed("plats", platHtml)) $("#platforms").innerHTML = platHtml;

  const busy = buildBusy();
  const lastBuild = S.jobs.filter(j => j.kind === "build").pop();
  const libs = plural(S.zimCount, "library or website", "libraries and websites");
  let cls = "", t, s;
  if (busy) { cls = "busy"; t = busy.label.startsWith("Install") ? "Adding reader apps…" : "Building…"; s = `${busy.message}. Don't unplug the drive.`; }
  else if (lastBuild?.status === "error") { cls = "warn"; t = "The last build stopped"; s = lastBuild.message; }
  else if (!isBuilt()) { t = "Not built yet"; s = S.zimCount ? `${libs} on the drive will be included.` : "Nothing is downloaded yet. You can build now to try it out, then build again later."; }
  else if (!S.zimCount && !S.needsRebuild) { t = "Built, but nothing is downloaded yet"; s = "The drive has the quick-reference pages only. Add libraries in step 1, then build again."; }
  else if (S.needsRebuild) { cls = "warn"; t = "Build again to include new downloads"; s = "Something was added or removed since the last build."; }
  else { cls = "ok"; t = "Built and up to date"; s = `${libs} on the home page.`; }
  const box = $("#build-box");
  box.className = "status-box " + cls;
  box.innerHTML = `<b>${esc(t)}</b><small>${esc(s)}</small>`;
  const warn = $("#build-warn");
  warn.hidden = false;
  if (!S.tools.libzim) warn.innerHTML = "The home page can't be built because python-libzim is missing. Run <code>.venv/bin/pip install libzim</code>, then restart.";
  else if (jobs.some(liveJob)) warn.textContent = "Some downloads are still going. You can build now and build again when they finish.";
  else warn.hidden = true;
  const btn = $("#build");
  btn.textContent = busy ? "Building…" : isBuilt() ? "Build again" : "Build drive";
  btn.disabled = !!busy || !S.tools.libzim;

  let h;
  if (!S.indexBuilt) h = `<p class="empty">Build the drive first, then you can test it here.</p>`;
  else if (!S.tools.kiwixServe && !S.serving) h = `<p class="note">This computer's reader isn't on the drive yet. Tick it in part 2, then build again.</p>`;
  else h = `<div class="row-actions"><button type="button" class="btn big ${S.serving ? "" : "primary"}" data-act="serve">${S.serving ? "Stop reader" : "Start reader"}</button>
    ${S.serving ? `<a class="btn big" href="${esc(S.kiwixUrl)}" target="_blank" rel="noopener">Open home page ↗</a><a class="btn big" href="${esc(S.kiwixHome)}" target="_blank" rel="noopener">See all libraries ↗</a>` : ""}</div>
    ${S.serving ? `<p class="serve-ok">The reader is running. Click around and check your libraries open. Stop it before you unplug the drive.</p>` : ""}`;
  if (changed("test", h)) $("#test-area").innerHTML = h;
}
$("#build").onclick = () => {
  const need = S.tools.platforms.filter(p => !p.installed && plats.has(p.id)).map(p => p.id);
  act(async () => {
    if (need.length) await api("/api/tools", { platforms: need });
    return api("/api/build", {});
  }, need.length ? "Adding reader apps, then building the drive…" : "Building the drive…");
};

function renderAllJobs() {
  const jobs = S.jobs.slice().reverse();
  if (changed("allJobs", jobs.map(j => [j.id, j.status])))
    $("#all-jobs").innerHTML = jobs.map(jobRow).join("") || `<p class="empty">No activity yet.</p>`;
}
$("#clear-jobs").onclick = () => act(() => api("/api/clear", {}));

function updateProgress() {
  S.jobs.forEach(j => {
    if (j.status !== "running") return;
    const pct = Math.round(j.progress * 100) + "%";
    if (j.library) {
      document.querySelectorAll(`[data-jobbar="${CSS.escape(j.library)}"]`).forEach(b => { b.style.width = j.progress * 100 + "%"; });
      document.querySelectorAll(`[data-jobtag="${CSS.escape(j.library)}"]`).forEach(b => { b.textContent = pct; });
    }
    document.querySelectorAll(`[data-jobbarid="${j.id}"]`).forEach(b => { b.style.width = j.progress * 100 + "%"; });
    document.querySelectorAll(`[data-jobpct="${j.id}"]`).forEach(b => { b.textContent = pct; });
    document.querySelectorAll(`[data-jobmsg="${j.id}"]`).forEach(b => { b.textContent = jobDetail(j); });
  });
}

// ------------------------------------------------------------------ bottom bar
const cartSize = () => [...picked].reduce((a, n) => a + libSize(n), 0);
const cartCount = () => picked.size + pending.length;
const cartTitle = () => `${plural(cartCount(), "item", "items")} in your queue · ${[picked.size && fmt(cartSize()), pending.length && plural(pending.length, "website", "websites")].filter(Boolean).join(" + ")}`;
// Whether the queue fits on the connected drive, in words.
function cartFit(d) {
  const size = cartSize();
  if (isFat(d.fstype) && [...picked].some(x => libSize(x) >= 4 * GB))
    return { over: true, sub: "This drive can't hold files over 4 GB. Remove the big libraries or pick their Text only version." };
  if (size > d.free) return { over: true, sub: `Too big for this drive. Remove ${fmt(size - d.free)}.` };
  return { over: false, sub: `Fits on this drive. ${fmt(d.free - size)} will be left.${pending.length ? " Website sizes are known after copying." : ""}` };
}

function renderBar(st) {
  let title, sub, acts, over = false;
  const d = S.drive, n = cartCount();
  $("#bar-meter").hidden = !((st === "pick" || st === "home") && hasDrive());
  if (st === "pick" || st === "home") {
    title = n ? cartTitle() : "Your queue is empty";
    if (!n) sub = "Click Add on anything you want to keep, or use Quick add. You choose where to save it next.";
    else if (hasDrive()) ({ sub, over } = cartFit(d));
    else sub = "Next, choose where to save it. You can also save this queue as a package to reuse or share.";
    if (hasDrive()) {
      const usedPct = d.total ? 100 * (1 - d.free / d.total) : 0;
      $("#bar-meter .used").style.width = usedPct.toFixed(1) + "%";
      $("#bar-meter .pick").style.width = Math.min(100 - usedPct, d.total ? 100 * cartSize() / d.total : 0).toFixed(1) + "%";
    }
    acts = n ? `<button type="button" class="btn" data-act="clear">Clear</button><button type="button" class="btn" data-act="save-pkg">Save as package</button><a class="btn primary big" href="#drive">Choose a drive</a>`
      : `<button type="button" class="btn primary big" disabled title="Add something to your queue first">Choose a drive</button>`;
  } else if (st === "drive") {
    if (!hasDrive()) {
      title = "No drive picked yet";
      sub = n ? `${cartTitle()}. Choose where to save it.` : "Choose where the library will be saved.";
      acts = `<a class="btn big" href="#pick">← Back</a><button type="button" class="btn big" disabled>Pick a drive first</button>`;
    } else if (n) {
      title = `${cartTitle()} → ${d.home ? "this computer" : d.name}`;
      ({ sub, over } = cartFit(d));
      acts = `<a class="btn big" href="#pick">← Back</a><button type="button" class="btn primary big" data-act="go">Download &amp; continue</button>`;
    } else {
      title = `${d.home ? "This computer" : d.name} · ${fmt(d.free)} free`;
      const v = verdict({ ...d, kind: d.home ? "computer" : "external" });
      sub = v.warn ? `Heads up: ${v.title.toLowerCase()}. You can still continue.` : S.zimCount ? "We'll keep the library that's already there." : `We'll add a ${libFolder()} folder to it.`;
      acts = `<a class="btn big" href="#pick">← Back</a><a class="btn primary big" href="#build">Next: build &amp; test →</a>`;
    }
  } else {
    const active = fileJobs().filter(liveJob).length;
    if (!isBuilt()) { title = "Your drive isn't ready yet"; sub = "Build the drive (part 3) to make it usable without internet."; }
    else if (S.needsRebuild) { title = "Almost there: build again"; sub = "New downloads aren't on the home page yet."; }
    else if (!S.zimCount && !active) { title = "Built with the quick-reference pages only"; sub = "Add libraries in step 1 for the full details."; }
    else if (active) { title = "Ready to use, still downloading more"; sub = `${plural(active, "download", "downloads")} still going. Build again when they finish.`; }
    else { title = "Your drive is ready to use"; sub = "Test it, then unplug it safely."; }
    acts = `<a class="btn big" href="#pick">← Back to topics</a>`;
  }
  $("#bar-title").textContent = title;
  $("#bar-sub").textContent = sub;
  $("#bar-sub").classList.toggle("over", over);
  if (changed("barActs", acts)) $("#bar-actions").innerHTML = acts;
}

// Starts downloads for libraries and website copies. Calls done(site) for each website that was queued.
async function queueItems(names, sites, done = () => {}, folder = "") {
  const errors = []; let queued = 0;
  try {
    if (names.length) {
      const r = await api("/api/download", { names, folder });
      queued += r.queued; errors.push(...r.errors);
    }
    for (const p of sites) {
      try {
        await api("/api/crawl", { url: p.url, title: p.title, topic: p.topic, pageLimit: p.pageLimit, folder });
        queued++; done(p);
      } catch (e) { errors.push(`${p.title}: ${e.message}`); }
    }
  } catch (e) { errors.push(e.message); }
  return { queued, errors };
}

async function downloadAndContinue(btn) {
  btn.disabled = true;
  const names = [...picked];
  const folder = queuePackage()?.name || "";
  const { queued, errors } = await queueItems(names, pending.slice(), p => { pending = pending.filter(x => x !== p); }, folder);
  if (names.length) picked.clear();
  save();
  notice(`Started ${plural(queued, "download", "downloads")}.` + (errors.length ? "<br>" + errors.map(esc).join("<br>") : ""), errors.length ? "warn" : "");
  location.hash = "#build";
  await refresh();
}

async function retry(id) {
  const j = S.jobs.find(x => x.id === id); if (!j) return;
  await act(async () => {
    if (j.library) { const r = await api("/api/download", { names: [j.library] }); if (r.errors.length) throw new Error(r.errors[0]); }
    else await api("/api/crawl", { url: j.url, title: j.title, topic: j.topic, pageLimit: j.pageLimit });
  }, "Trying again…");
}

// ------------------------------------------------------------------ packages (saved queues)
let pkgStatus = "";
const pkgSize = p => p.libraries.reduce((a, n) => a + libSize(n), 0);
// Your saved packages plus Offie's starter packs. An edited starter pack is saved under its own id and replaces the original.
function allPackages() {
  const edited = new Map(S.packages.filter(p => p.edited).map(p => [p.id, { ...p, builtin: true }]));
  const builtins = OFFIE_PACKS.map(p => edited.get(p.id) || { ...p, libraries: p.libraries.filter(n => S.libraries[n]) });
  return [...S.packages.filter(p => !p.edited), ...builtins];
}
const findPkg = id => allPackages().find(p => p.id === id);
const favIds = () => S.favorites ?? OFFIE_PACKS.map(p => p.id);
const isFav = id => favIds().includes(id);
const starBtn = p => `<button type="button" class="star" data-act="fav" data-id="${esc(p.id)}" aria-pressed="${isFav(p.id)}" aria-label="${isFav(p.id) ? "Remove" : "Add"} “${esc(p.name)}” ${isFav(p.id) ? "from" : "to"} favorites" title="${isFav(p.id) ? "Favorite: shown on the home page" : "Show on the home page"}">${isFav(p.id) ? "★" : "☆"}</button>`;
const pkgInCart = p => p.libraries.every(n => picked.has(n) || !canPick(n)) && p.sites.every(s => pending.some(x => x.url === s.url) || S.custom.some(c => c.url === s.url));
function pkgItems(p) {
  const parts = [];
  if (p.libraries.length) parts.push(plural(p.libraries.length, "topic", "topics"));  // a package's libraries are shown as topics
  if (p.sites.length) parts.push(plural(p.sites.length, "website", "websites"));
  return parts.join(" + ") + (p.libraries.length ? ` · ${fmt(pkgSize(p))}` : "") + (p.sites.length ? (p.libraries.length ? " plus website copies" : " · size known after copying") : "");
}
// Whether a package still has anything that could go in the queue (not already on the drive).
const pkgItemsLeft = p => p.libraries.some(n => canPick(n) || picked.has(n)) || p.sites.some(s => !S.custom.some(c => c.url === s.url));
function removePackageFromCart(p) {
  qPkgs = qPkgs.filter(x => x !== p.id);
  // Keep anything another queued package also includes (packages often share libraries).
  const others = qPkgs.map(findPkg).filter(Boolean);
  const keepLib = n => others.some(o => o.libraries.includes(n));
  const keepSite = u => others.some(o => o.sites.some(x => x.url === u));
  p.libraries.forEach(n => { if (!keepLib(n)) picked.delete(n); });
  pending = pending.filter(x => keepSite(x.url) || !p.sites.some(s => s.url === x.url));
  save(); render();
}
async function copyLink(url, btn) {
  try { await navigator.clipboard.writeText(url); }
  catch {
    const t = document.createElement("textarea"); t.value = url; document.body.append(t); t.select();
    document.execCommand("copy"); t.remove();
  }
  const label = $("span", btn); const old = label.textContent;
  label.textContent = "Copied"; setTimeout(() => { label.textContent = old; }, 1600);
}
function addPackageToCart(p) {
  if (!qPkgs.includes(p.id)) qPkgs.push(p.id);
  p.libraries.filter(canPick).forEach(n => picked.add(n));
  p.sites.forEach(s => {
    if (!pending.some(x => x.url === s.url) && !S.custom.some(c => c.url === s.url)) pending.push({ ...s });
  });
  save(); render();
}
function renderPackages() {
  const q = $("#pkg-search").value.trim().toLowerCase();
  const list = [...S.packages.filter(p => !p.edited).reverse(), ...allPackages().filter(p => p.builtin)].filter(p => !q || [p.name, p.description, ...p.libraries.map(n => S.libraries[n]?.title), ...p.sites.map(s => s.title + " " + s.url)]
    .join(" ").toLowerCase().includes(q));
  const html = (pkgStatus ? `<p class="small ok-text">${esc(pkgStatus)}</p>` : "") + (list.map(p => {
    const inQ = pkgInCart(p);
    return `<article class="pkg"><div class="pkg-head"><div class="grow"><span class="kind pkg-kind">Package</span><b>${esc(p.name)}</b>
        <small class="muted">${esc(pkgItems(p).split(" plus ")[0])}${p.builtin ? ` · Offie${p.edited ? ", edited" : ""}` : ""}</small></div>${starBtn(p)}</div>
      ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ""}
      ${insideList("f:" + p.id, p.libraries.filter(n => S.libraries[n]), p.sites, false)}
      <div class="pkg-acts"><button type="button" class="btn small ${inQ ? "" : "primary"}" data-act="pkg-add" data-id="${esc(p.id)}">${inQ ? "✓ In your queue" : "Add to queue"}</button>
      <button type="button" class="btn small" data-act="pkg-edit" data-id="${esc(p.id)}">Edit</button>
      <button type="button" class="btn small" data-act="pkg-export" data-id="${esc(p.id)}">Export</button>
      ${p.builtin ? "" : `<button type="button" class="btn small ghost danger" data-act="pkg-del" data-id="${esc(p.id)}">Delete</button>`}</div></article>`;
  }).join("") || `<p class="empty">${S.packages.length ? `No packages match “${esc(q)}”.` : "No packages yet."}</p>`);
  if (changed("pkgs", html)) $("#pkg-list").innerHTML = html;
}
$("#packages-btn").onclick = () => { pkgStatus = ""; delete sigs.pkgs; renderPackages(); openPopup("#packages", $("#packages-btn")); };
$("#pkg-search").oninput = () => renderPackages();
$("#pkg-import").onclick = () => $("#pkg-file").click();
$("#pkg-file").onchange = async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const p = await api("/api/packages/import", { package: data });
    pkgStatus = `Imported “${p.name}”.`;
  } catch (err) { pkgStatus = `Couldn't import that file: ${err instanceof SyntaxError ? "it isn't a package file" : err.message}.`; }
  await refresh(); renderPackages();
};
function exportPackage(p) {
  const data = { offiePackage: 1, name: p.name, description: p.description, libraries: p.libraries, sites: p.sites };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = (p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "package") + ".offie-package.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function openSavePackage() {
  if (!cartCount()) { notice("Your queue is empty. Add libraries or websites first.", "warn"); return; }
  const f = $("#save-pkg-form");
  f.reset();
  const parts = [];
  if (picked.size) parts.push(`${plural(picked.size, "library", "libraries")} (${fmt(cartSize())})`);
  if (pending.length) parts.push(plural(pending.length, "website", "websites"));
  $("#save-pkg-summary").textContent = `Saves the ${parts.join(" and ")} in your queue. Your queue stays as it is.`;
  $("#save-pkg").showModal();
  f.elements.name.focus();
}
$("#save-pkg-form").onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  try {
    const p = await api("/api/packages/save", { name: f.elements.name.value, description: f.elements.description.value, libraries: [...picked], sites: pending });
    $("#save-pkg").close();
    notice(`Saved “${esc(p.name)}”. Find it under Packages (the box icon at the top), and in “How much space do you need?” in step 2.`);
  } catch (err) { notice(esc(err.message), "error"); $("#save-pkg").close(); }
  await refresh();
};

// ------------------------------------------------------------------ landing page
let homeDrive = null;     // path picked in the Drive pop-up; landing-page downloads go there

// Drives the Drive pop-up can offer: the connected drive, the last-used drive, and any removable drives found.
function homeDrives() {
  const out = [];
  const add = d => { if (d && !out.some(x => x.path === d.path)) out.push(d); };
  if (hasDrive()) add({ ...S.drive, name: S.drive.home ? "This computer" : S.drive.name, connected: true });
  if (S.savedDrive?.available) add({ path: S.savedDrive.path, name: S.savedDrive.name, lastUsed: true });
  (drives || []).forEach(add);
  return out;
}
const homeTarget = () => homeDrives().find(d => d.path === homeDrive) || null;

// What a package still needs on the chosen drive, and whether it fits.
function homeFit(p, d) {
  const onThis = d && S.drive && d.path === S.drive.path && !S.drive.missing;
  const libs = p.libraries.filter(n => S.libraries[n]);
  const need = onThis ? libs.filter(canPick) : libs;
  const sites = onThis ? p.sites.filter(s => !S.custom.some(c => c.url === s.url)) : p.sites;
  const busy = onThis && libs.some(n => activeJob(n));
  const size = need.reduce((a, n) => a + libSize(n), 0);
  let fit = null;
  if (d && d.free != null && need.length) {
    if (isFat(d.fstype) && need.some(n => libSize(n) >= 4 * GB)) fit = { ok: false, text: "Has files over 4 GB, which this drive can't hold" };
    else if (size > d.free) fit = { ok: false, text: `Needs ${fmt(size - d.free)} more space on this drive` };
    else fit = { ok: true, text: `Fits · ${fmt(d.free - size)} left after` };
  }
  return { need, sites, busy, done: onThis && !need.length && !sites.length && !busy, fit, size };
}

function favCard(p, d) {
  const f = homeFit(p, d);
  const names = [...p.libraries.map(n => S.libraries[n]?.title || n), ...p.sites.map(s => s.title)];
  let action;
  if (f.done) action = ON_DRIVE;
  else if (f.busy && !f.need.length && !f.sites.length) action = `<a class="btn" href="#build">Downloading… see progress</a>`;
  else action = `<button type="button" class="btn primary big" data-act="home-dl" data-id="${esc(p.id)}" ${f.fit && !f.fit.ok ? "disabled" : ""}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>Download${d ? ` to ${esc(d.name)}` : ""}</button>`;
  const inQ = pkgItemsLeft(p) && pkgInCart(p);
  const addBtn = f.done ? "" : `<button type="button" class="btn add" data-act="pkg-toggle" data-id="${esc(p.id)}" aria-pressed="${inQ}">${inQ ? "✓ Added" : "Add to queue"}</button>`;
  return `<article class="fav-card">${starBtn(p)}
    <h3>${esc(p.name)}</h3>
    <p class="meta">${esc(pkgItems(p).split(" plus ")[0])}${f.fit && !f.done ? ` · <span class="fit ${f.fit.ok ? "" : "no"}">${esc(f.fit.text)}</span>` : ""}</p>
    ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ""}
    <ul class="items">${names.map(n => `<li>${esc(n)}</li>`).join("")}</ul>
    <div class="fav-actions">${action}<button type="button" class="icon-btn" data-act="pkg-edit" data-id="${esc(p.id)}" aria-label="Edit ${esc(p.name)}" title="Edit">${ICON.edit}</button></div>
    ${addBtn}</article>`;
}

function renderHomeStep() {
  if (scanOk() && drives === null && !scanning) loadDrives();
  const list = homeDrives();
  if (homeDrive && !list.some(d => d.path === homeDrive)) homeDrive = null;
  if (!homeDrive && hasDrive()) homeDrive = S.drive.path;
  const d = homeTarget();
  let note = "";
  if (scanning) note = "Looking for removable drives…";
  else if (driveError) note = driveError;
  else if (!d) note = "No drive chosen yet. Click Drive at the top to pick one.";
  else if (d && d.free != null) {
    const v = verdict({ ...d, kind: d.home ? "computer" : "external" });
    if (v.warn) note = `Heads up: ${v.title.toLowerCase()}. ${v.text}`;
  }
  $("#home-drive-note").textContent = note;

  const favs = favIds().map(findPkg).filter(Boolean);
  const html = favs.map(p => favCard(p, d)).join("")
    || `<p class="empty">No favorites yet. Open <b>See all packages</b> and tap ☆ on the ones you want here.</p>`;
  if (changed("favs", html)) $("#fav-list").innerHTML = html;

  const idCat = S.categories.find(x => /identif/i.test(x.title));
  const fid = (FIELD_ID_URL
      ? `<a class="btn primary big" href="${esc(FIELD_ID_URL)}" target="_blank" rel="noopener">Open field identification ↗</a>`
      : `<button type="button" class="btn big" disabled>Coming soon</button>`)
    + (idCat ? `<button type="button" class="btn big" data-act="goto-cat" data-id="${esc(idCat.id)}">Browse identification libraries now</button>` : "");
  if (changed("fid", fid)) $("#fid-actions").innerHTML = fid;
}

async function homeDownload(id, btn) {
  const p = findPkg(id);
  const d = homeTarget();
  if (!p) return;
  if (!d) {
    notice("Choose a drive first: pick one in the Drive menu at the top.", "warn");
    $("#drives-btn").click();
    return;
  }
  btn.disabled = true;
  try {
    if (!hasDrive() || S.drive.path !== d.path) await api("/api/settings", { drive: d.path });
    await refresh();
    const f = homeFit(p, homeTarget() || d);
    if (f.fit && !f.fit.ok) { notice(esc(f.fit.text) + ".", "warn"); return; }
    if (!f.need.length && !f.sites.length) { notice(`Everything in “${esc(p.name)}” is already on ${esc(d.name)}.`); return; }
    const { queued, errors } = await queueItems(f.need, f.sites, undefined, p.name);
    notice(`Downloading “${esc(p.name)}” to ${esc(d.name)}: started ${plural(queued, "download", "downloads")}. When they finish, build the drive below.`
      + (errors.length ? "<br>" + errors.map(esc).join("<br>") : ""), errors.length ? "warn" : "");
    location.hash = "#build";
  } catch (e) { notice(esc(e.message), "error"); }
  finally { btn.disabled = false; }
  await refresh();
}

// ------------------------------------------------------------------ pop-up menus
// Opens a toolbar menu just under the button that opened it (a sheet at the bottom on small screens).
function openPopup(sel, btn) {
  const dlg = $(sel), r = btn.getBoundingClientRect();
  // Open below the button, or above it when there isn't room below (e.g. "See more" low in the sidebar).
  const below = innerHeight - r.bottom - 16, above = r.top - 16;
  if (below < 360 && above > below) { dlg.style.top = "auto"; dlg.style.bottom = Math.round(innerHeight - r.top + 8) + "px"; dlg.style.maxHeight = Math.round(Math.min(above - 8, 620)) + "px"; }
  else { dlg.style.bottom = "auto"; dlg.style.top = Math.max(16, Math.round(r.bottom + 8)) + "px"; dlg.style.maxHeight = ""; }  // the header scrolls away, so keep the menu on screen
  // Open toward the middle of the screen: right-aligned for top-bar buttons, left-aligned for ones on the left (the sidebar).
  if (r.left < innerWidth / 2) { dlg.style.left = Math.max(16, Math.round(r.left)) + "px"; dlg.style.right = "auto"; }
  else { dlg.style.right = Math.max(16, Math.round(innerWidth - r.right)) + "px"; dlg.style.left = "auto"; }
  if (!dlg.open) dlg.showModal();
}

// ------------------------------------------------------------------ queue
const X_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
// What's inside a package, as a drop-down list of single resources and websites.
const detailsOpen = new Set();  // drop-downs the person opened, kept open across re-renders
document.addEventListener("toggle", e => {
  const k = e.target.dataset?.key; if (!k) return;
  e.target.open ? detailsOpen.add(k) : detailsOpen.delete(k);
}, true);
function insideList(key, libs, sites, removable) {
  const n = libs.length + sites.length;
  if (!n) return "";
  const x = (act, label) => removable ? `<button type="button" class="icon-btn xs" ${act} aria-label="Remove ${esc(label)} from the queue" title="Remove">${X_ICON}</button>` : "";
  const rows = libs.map(k => { const L = S.libraries[k];
      return `<li><div class="grow"><span class="kind">Single resource</span><b>${esc(L?.title || k)}</b>${L?.summary ? `<p class="desc">${esc(L.summary)}</p>` : ""}<small class="muted">${fmt(libSize(k))}</small></div>${x(`data-act="pick" data-name="${esc(k)}"`, L?.title || k)}</li>`; })
    .concat(sites.map(w => `<li><div class="grow"><span class="kind">Single website</span><b>${esc(w.title)}</b><small class="muted">${esc(host(w.url))}</small></div>${x(`data-act="unpend" data-url="${esc(w.url)}"`, w.title)}</li>`));
  return `<details class="inside" data-key="${esc(key)}" ${detailsOpen.has(key) ? "open" : ""}><summary>What's inside (${n})</summary><ul>${rows.join("")}</ul></details>`;
}
function queueRow(kind, key, title, desc, sub) {
  const act = kind === "lib" ? `data-act="pick" data-name="${esc(key)}"` : `data-act="unpend" data-url="${esc(key)}"`;
  return `<div class="q-row"><div class="grow"><span class="kind">${kind === "lib" ? "Single resource" : "Single website"}</span>
    <b>${esc(title)}</b>${desc ? `<p class="desc">${esc(desc)}</p>` : ""}<small class="muted">${esc(sub)}</small></div>
    ${kind === "site" ? `<button type="button" class="icon-btn sm" data-act="edit-site" data-kind="pending" data-key="${esc(key)}" aria-label="Edit ${esc(title)}" title="Edit topic or address">${ICON.edit}</button>` : ""}
    <button type="button" class="icon-btn sm" ${act} aria-label="Remove ${esc(title)} from the queue" title="Remove">${X_ICON}</button></div>`;
}
function renderQueue() {
  const n = cartCount();
  $("#queue-summary").textContent = n ? `${plural(n, "item", "items")} · ${fmt(cartSize())}` : "";
  // Packages added as a whole show as one row; anything else shows on its own.
  const shownLibs = new Set(), shownSites = new Set(), rows = [];
  qPkgs.map(findPkg).filter(Boolean).forEach(p => {
    const libs = p.libraries.filter(k => picked.has(k) && !shownLibs.has(k));
    const sites = p.sites.filter(x => pending.some(y => y.url === x.url) && !shownSites.has(x.url));
    if (!libs.length && !sites.length) return;
    libs.forEach(k => shownLibs.add(k)); sites.forEach(x => shownSites.add(x.url));
    const size = libs.reduce((a, k) => a + libSize(k), 0);
    const parts = [libs.length && plural(libs.length, "library", "libraries"), sites.length && plural(sites.length, "website", "websites")].filter(Boolean).join(" + ");
    rows.push(`<div class="q-row"><div class="grow"><span class="kind pkg-kind">Package</span>
      <b>${esc(p.name)}</b>${p.description ? `<p class="desc">${esc(p.description)}</p>` : ""}
      <small class="muted">${esc(parts)}${size ? " · " + fmt(size) : ""}</small>${insideList("q:" + p.id, libs, sites, true)}</div>
      <button type="button" class="icon-btn sm" data-act="q-pkg-del" data-id="${esc(p.id)}" aria-label="Remove the ${esc(p.name)} package from the queue" title="Remove">${X_ICON}</button></div>`);
  });
  [...picked].filter(k => !shownLibs.has(k)).forEach(k => rows.push(queueRow("lib", k, S.libraries[k]?.title || k, S.libraries[k]?.summary, fmt(libSize(k)))));
  pending.filter(x => !shownSites.has(x.url)).forEach(x => rows.push(queueRow("site", x.url, x.title, "", host(x.url))));
  const html = rows.join("") || `<p class="empty">Your queue is empty.</p>`;
  if (changed("queue", html)) $("#queue-list").innerHTML = html;
  let fit = "";
  if (n && hasDrive()) { const f = cartFit(S.drive); fit = `<span class="small ${f.over ? "warn-text" : "muted"}">${esc(f.sub)}</span>`; }
  const foot = n
    ? `${fit ? `<div class="q-fit">${fit}</div>` : ""}<button type="button" class="btn small ghost" data-act="clear">Clear</button><button type="button" class="btn small" data-act="save-pkg">Save as package</button>
       <span class="grow"></span>
       ${hasDrive() ? `<button type="button" class="btn small primary" data-act="go">Download &amp; continue</button>` : `<a class="btn small primary" href="#drive">Choose a drive →</a>`}`
    : `<span class="grow"></span><a class="btn small" href="#pick">Choose topics</a>`;
  if (changed("queueFoot", foot)) $("#queue-foot").innerHTML = foot;
}
$("#queue-btn").onclick = e => { delete sigs.queue; delete sigs.queueFoot; renderQueue(); openPopup("#queue", e.currentTarget); };

// ------------------------------------------------------------------ edit a topic
let editingTopic = null, topicLibs = [], topicOff = new Set();  // libraries listed in the dialog, and the unticked ones
function topicLibRow(n) {
  const L = S.libraries[n];
  return `<label class="check-row"><input type="checkbox" ${topicOff.has(n) ? "" : "checked"} value="${esc(n)}">
    <span class="grow"><b>${esc(L?.title || n)}</b><small class="muted">${esc([L?.summary, fmt(libSize(n))].filter(Boolean).join(" · "))}</small></span></label>`;
}
function renderTopicLibs() {
  $("#edit-topic-libs").innerHTML = topicLibs.map(topicLibRow).join("") || `<p class="muted small">No libraries yet. Add one below.</p>`;
  const others = Object.keys(S.libraries).filter(n => !topicLibs.includes(n))
    .sort((a, b) => S.libraries[a].title.localeCompare(S.libraries[b].title));
  $("#edit-topic-add").innerHTML = `<option value="">Choose a library…</option>` + others.map(n => `<option value="${esc(n)}">${esc(S.libraries[n].title)} · ${fmt(libSize(n))}</option>`).join("");
}
function openEditTopic(id) {
  const t = topicIndex()[id];
  if (!t) return;
  editingTopic = t; topicLibs = t.kiwix.slice(); topicOff = new Set();
  const f = $("#edit-topic-form");
  f.reset();
  f.elements.title.value = t.title;
  $("#edit-topic-title").textContent = t.title;
  renderTopicLibs();
  $("#edit-topic-note").textContent = "Changes show here and on the drive's home page the next time you build it. Websites in this topic have their own pencil.";
  $("#edit-topic-reset").hidden = !t.edited;
  $("#edit-topic").showModal();
  f.elements.title.focus();
}
$("#edit-topic-add-btn").onclick = () => {
  const n = $("#edit-topic-add").value;
  if (!n || topicLibs.includes(n)) return;
  topicLibs.push(n);
  renderTopicLibs();
};
$("#edit-topic-libs").onchange = e => { if (e.target.checked) topicOff.delete(e.target.value); else topicOff.add(e.target.value); };
$("#edit-topic-form").onsubmit = async e => {
  e.preventDefault();
  const f = e.target, t = editingTopic;
  const kiwix = [...f.querySelectorAll("#edit-topic-libs input:checked")].map(i => i.value);
  try {
    await api("/api/topic", { id: t.id, title: f.elements.title.value, kiwix });
    $("#edit-topic").close();
    notice(`Saved changes to “${esc(f.elements.title.value.trim())}”.${S.guideBuilt ? " Build the drive again to update its home page." : ""}`);
  } catch (err) { notice(esc(err.message), "error"); }
  await refresh();
};
$("#edit-topic-reset").onclick = async () => {
  const t = editingTopic;
  if (!t || !confirm(`Reset “${t.title}” to Offie's version (“${t.originalTitle}” with its original libraries)?`)) return;
  $("#edit-topic").close();
  await act(() => api("/api/topic", { id: t.id, reset: true }), `Reset “${esc(t.originalTitle)}” to Offie's version.`);
};

// ------------------------------------------------------------------ edit a package
let editing = null;
function openEditPackage(id) {
  const p = findPkg(id);
  if (!p) return;
  editing = p;
  const f = $("#edit-pkg-form");
  f.reset();
  f.elements.name.value = p.name;
  f.elements.description.value = p.description || "";
  $("#edit-pkg-kind").textContent = p.builtin ? "Offie package" : "Your package";
  const item = (kind, key, title, sub) => `<label class="check-row"><input type="checkbox" checked data-kind="${kind}" value="${esc(key)}">
    <span class="grow"><b>${esc(title)}</b><small class="muted">${esc(sub)}</small></span></label>`;
  $("#edit-pkg-items").innerHTML = p.libraries.map(n => item("lib", n, S.libraries[n]?.title || n, fmt(libSize(n)))).join("")
    + p.sites.map(x => item("site", x.url, x.title, "Website copy · " + host(x.url))).join("")
    || `<p class="muted small">Nothing in it yet.</p>`;
  const n = cartCount();
  $("#edit-pkg-addq").hidden = !n;
  $("#edit-pkg-addq-text").textContent = `Also add what's in your queue (${plural(n, "item", "items")})`;
  $("#edit-pkg-note").textContent = p.builtin && !p.edited
    ? "This is one of Offie's packages. Your changes are saved as your own version, and you can reset it at any time."
    : "To add more, put things in your queue first, then come back and tick “Also add what's in your queue”.";
  $("#edit-pkg-reset").hidden = !p.edited;
  $("#edit-pkg").showModal();
  f.elements.name.focus();
}
$("#edit-pkg-form").onsubmit = async e => {
  e.preventDefault();
  const f = e.target, p = editing;
  const keep = kind => [...f.querySelectorAll(`#edit-pkg-items input[data-kind=${kind}]:checked`)].map(i => i.value);
  const libraries = keep("lib"), urls = new Set(keep("site"));
  const sites = p.sites.filter(x => urls.has(x.url));
  if (f.elements.addQueue.checked) {
    picked.forEach(n => { if (!libraries.includes(n)) libraries.push(n); });
    pending.forEach(x => { if (!sites.some(y => y.url === x.url)) sites.push(x); });
  }
  try {
    const r = await api("/api/packages/update", { id: p.id, name: f.elements.name.value, description: f.elements.description.value, libraries, sites });
    $("#edit-pkg").close();
    pkgStatus = `Saved changes to “${r.name}”.`;
    notice(`Saved changes to “${esc(r.name)}”.`);
  } catch (err) { notice(esc(err.message), "error"); $("#edit-pkg").close(); }
  delete sigs.pkgs; delete sigs.favs;
  await refresh();
};
$("#edit-pkg-reset").onclick = async () => {
  const p = editing;
  if (!p || !confirm(`Reset “${p.name}” to Offie's original version? Your changes to it are removed.`)) return;
  $("#edit-pkg").close();
  await act(() => api("/api/packages/delete", { id: p.id }), "Reset to Offie's version.");
  pkgStatus = ""; delete sigs.pkgs;
};

// ------------------------------------------------------------------ events
document.addEventListener("click", e => {
  if (e.target.tagName === "DIALOG") {  // click on the backdrop
    const r = e.target.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close();
    return;
  }
  const close = e.target.closest("[data-close]");
  if (close) { close.closest("dialog").close(); return; }
  const link = e.target.closest('dialog a[href^="#"]');  // a step link inside a drawer: go there and close the drawer
  if (link) link.closest("dialog").close();
  const el = e.target.closest("[data-act]");
  const choice = e.target.closest(".drive-choose .choice.off");
  if (choice) setDriveMode(choice.dataset.mode);
  if (!el || el.tagName === "SELECT" || el.disabled) return;
  const d = el.dataset;
  switch (d.act) {
    case "drive":
      if (d.path !== S.drive?.path) act(() => api("/api/settings", { drive: d.path }), "Drive selected.");
      break;
    case "connect":
    case "connect-always":
      act(() => api("/api/connect", { remember: d.act === "connect-always" }),
        `Connected to “${esc(S.savedDrive?.name)}”.` + (d.act === "connect-always" ? " Offie will reconnect to it without asking from now on." : ""));
      break;
    case "connect-later": connectDismissed = true; render(); break;
    case "rescan": case "pop-rescan": loadDrives(); break;
    case "pop-drive":
      homeDrive = d.path; delete sigs.homeDrive;
      if (d.path !== S.drive?.path) act(() => api("/api/settings", { drive: d.path }), "Drive selected.");
      else render();
      $("#drives-pop").close();
      break;
    case "scan-once": scanAllowed = true; loadDrives(); break;
    case "scan-always": scanAllowed = true; act(() => api("/api/permissions", { scanAlways: true })).then(loadDrives); break;
    case "reset-perms":
      scanAllowed = false;
      act(() => api("/api/permissions", { scanAlways: false, autoConnect: false }), "Offie will ask before looking for drives, and before reconnecting to your drive.");
      break;
    case "save-pkg": openSavePackage(); break;
    case "pkg-add": { const p = findPkg(d.id); if (p) addPackageToCart(p); break; }
    case "pkg-export": { const p = findPkg(d.id); if (p) exportPackage(p); break; }
    case "fav": act(() => api("/api/favorite", { id: d.id, favorite: !isFav(d.id), defaults: OFFIE_PACKS.map(p => p.id) })); break;
    case "home-dl": homeDownload(d.id, el); break;
    case "open-packages": $("#packages-btn").click(); break;
    case "goto-cat": cat = d.id; store.set("offie.cat", cat); location.hash = "#pick"; break;
    case "pkg-del": {
      const p = S.packages.find(x => x.id === d.id);
      if (p && confirm(`Delete the package “${p.name}”? Nothing on your drive is removed.`))
        act(() => api("/api/packages/delete", { id: p.id })).then(() => { pkgStatus = `Deleted “${p.name}”.`; renderPackages(); });
      break;
    }
    case "cat":
      cat = d.id; store.set("offie.cat", cat); $("#filter").value = ""; render();
      $("#step-pick").scrollIntoView({ block: "start" });
      break;
    case "pick":
      picked.has(d.name) ? picked.delete(d.name) : picked.add(d.name); save(); render();
      break;
    case "pack":
      d.names.split(",").filter(n => n && canPick(n)).forEach(n => picked.add(n)); save(); render();
      break;
    case "del":
      if (confirm(`Delete ${d.file} from the drive?`)) act(() => api("/api/delete", { file: d.file }), "Removed from the drive. Build again to update the home page.");
      break;
    case "preview-lib": openPreview({ type: "lib", name: d.name }); break;
    case "preview-site": openPreview({ type: "site", url: d.url, title: d.title, topic: d.topic, pageLimit: +d.pages || 0 }); break;
    case "pv-site": togglePending({ url: pv.url, title: pv.title, topic: pv.topic, pageLimit: pv.pageLimit || 200 }); break;
    case "add-site": openQA(d.topic); break;
    case "unpend": pending = pending.filter(p => p.url !== d.url); save(); render(); break;
    case "edit-site": openEditSite(d.kind, d.key); break;
    case "edit-topic": openEditTopic(d.id); break;
    case "sugg": { const s = S.suggestions[+d.i]; togglePending({ url: s.url, title: s.title, topic: s.topic, pageLimit: s.pageLimit }); break; }
    case "clear": picked.clear(); pending = []; qPkgs = []; save(); render(); break;
    case "q-pkg-del": { const p = findPkg(d.id); if (p) removePackageFromCart(p); else { qPkgs = qPkgs.filter(x => x !== d.id); save(); render(); } break; }
    case "go": if (el.closest("dialog")) el.closest("dialog").close(); downloadAndContinue(el); break;
    case "pkg-edit": openEditPackage(d.id); break;
    case "side-pkgs-more": pkgStatus = ""; delete sigs.pkgs; renderPackages(); openPopup("#packages", el); break;
    case "pkg-toggle": { const p = findPkg(d.id); if (p) (pkgInCart(p) ? removePackageFromCart(p) : addPackageToCart(p)); break; }
    case "pv-copy": copyLink($("#pv-open").href, el); break;
    case "cancel": act(() => api("/api/cancel", { id: d.id })); break;
    case "retry": retry(d.id); break;
    case "plat": plats.has(d.id) ? plats.delete(d.id) : plats.add(d.id); render(); break;
    case "serve": {
      const was = S.serving;
      act(() => api("/api/serve", { action: was ? "stop" : "start" }), was ? "Reader stopped." : "Reader started.");
      break;
    }
  }
});
document.addEventListener("change", e => {
  const d = e.target.dataset;
  if (d.act === "flavour") act(() => api("/api/flavour", { name: d.name, flavour: e.target.value }));
});

// ------------------------------------------------------------------ loop
const API_VERSION = 7;  // must match API_VERSION in offgrid.py
let staleServer = false;

async function refresh() {
  let next;
  try { next = await api("/api/state"); }
  catch { lostConnection = true; notice("Lost connection to the builder. Is it still running? Start it again with <code>./start.command</code>.", "error"); return; }
  if (next.apiVersion !== API_VERSION) {
    // An older builder is still running from before an update: its data doesn't match this page.
    if (!staleServer) notice("The builder running in Terminal is an older version than this page. Close it (press <b>Ctrl+C</b> in its Terminal window), run <code>./start.command</code> again, then reload this page.", "error");
    staleServer = true;
    return;
  }
  if (staleServer) { staleServer = false; notice(""); }
  S = next;
  if (lostConnection) { lostConnection = false; notice(""); }
  let dirty = false;
  for (const n of [...picked]) if (!canPick(n)) { picked.delete(n); dirty = true; }
  if (dirty) save();
  if (S.drive?.missing && !missingWarned) { missingWarned = true; notice(`The drive <code>${esc(S.drive.path)}</code> isn't connected. Plug it in or pick another.`, "warn"); }
  if (!S.drive?.missing) missingWarned = false;
  render();
}
// Drives are only scanned once the person allows it (renderDriveStep asks first).
(async () => { await refresh(); setInterval(refresh, 1500); })();
