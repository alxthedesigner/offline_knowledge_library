# Expand Your Knowledge and Improve Your Community
This is an offline library that gives you the hands-on skills to build a self-sufficient community that can work together for the public good. This system is built for portability and to avoid subscriptions, hidden data collection, restrictions, and full reliance on the internet.



Use Kiwix to download entire websites for self-sufficiency, building personal infrastructure outside of subscriptions, and takes in information you learn in the real world to help you solve and document problems specific to your community

## Off-Grid Library builder

Builds a plug-in survival library on an external drive. It downloads whole websites as Kiwix `.zim` files, organizes them by the topics in [offgrid_topics.txt](offgrid_topics.txt), and adds launchers so any Mac, Windows or Linux computer can browse the drive with no internet.

### Quick start

```bash
./start.command          # first run creates .venv and installs libzim, then opens http://localhost:8642
```

The app opens on a **home page** that explains what Offie is and shows your **Favorites**. **Explore Topics** goes to step 1 and **Choose Drive…** to step 2. The **Drive** button in the top bar shows where downloads will go (the one you picked there, or the last one you used). Click it to switch between plugged-in drives in a pop-up; **More** opens step 2 for folders and other disks. Pick a drive with the **Drive** button in the top bar, then click **Download** on a package (or **Add to queue** to combine it with other things) to start downloading it there right away. Offie starts you off with four packages of its own (Outage kit, Camping trip, Fix it yourself, Survival essentials). Click the ☆ on any package, here or under **Packages**, to choose which ones appear, and **Edit** to change one (editing an Offie package saves your own version, which you can reset). The **Field identification** section is a placeholder for a separate project; set `FIELD_ID_URL` in [web/app.js](web/app.js) to link it.

To choose exactly what goes on the drive, use the three steps:

1. **Choose topics.** No drive needed yet. The pencil on each topic box renames the topic or changes which libraries it lists (**Reset to Offie's version** undoes it). Pick a category on the left and click **Add** to put libraries in your queue (the **Queue** button at the top shows what's in it). **Choose a drive** at the bottom becomes clickable once something is in the queue. Below the categories, the sidebar lists your top three packages (favorites first) with an **Add** button; **See more** opens the full Packages list. The eye button previews a library or website in a side panel before you download it, with **Visit full website** and **Copy link** for sharing; clicking an item's name opens its full website in a new tab; sites that refuse to be embedded show an **Open in new tab** button instead. **Quick add** (and **Add a website to this topic** on each card) asks you to pick a topic, then paste any website address (the eye button next to it previews the site); websites are copied with zimit (needs Docker running). The pencil button on a website edits it afterwards: a queued website can change topic and address, and one already on the drive can change topic. A library shared by several topics is downloaded once. **Save as package** keeps the queue under a name and description, so you can reuse it or share it.
2. **Choose a drive.** Pick one of two options: **Can Offie look for removable drives?** (Offie asks first, and only lists USB sticks, SD cards and external drives) or **Use a folder or another disk** (type a path and click **Use this folder**). The chosen option is highlighted and the other is greyed out; click it to switch. Each drive card says whether it's a good fit (FAT32's 4 GB limit, low space). "How much space do you need?" compares the drive with the Essentials, your two latest packages, and everything. **Download & continue** starts the downloads into one folder on the drive: `OfflineLibrary/`, or the package's name when you download a package. If the drive already has a library, Offie keeps using that folder.
3. **Build & test the drive.** Watch downloads finish, tick which computers should open the drive, then click **Build drive** (it adds the reader apps too). The app tells you when something new needs another build. **Start reader** lets you test it.

Next time you open the app, it asks before reconnecting to your drive. Choose **Connect, and don't ask again** to skip that (and **Yes, and don't ask again** to skip the drive-scan question); **Ask me again** on step 2 turns both prompts back on.

**Packages** (the box icon in the top bar) lists every package, with search. **Add to queue** loads one, **Edit** changes its name, description and contents, **Export** saves it as a `.offie-package.json` you can send to someone, and **Import a package** loads one you were given. Packages are kept in `packages.json` next to the app.

Off-grid: plug in the drive and double-click `START-Mac.command` or `START-Windows.bat`, or run `sh START-Linux.sh`. The browser opens the Off-Grid Field Guide.

### Where content comes from

| Source | What it is |
|---|---|
| **Kiwix catalog** | 46 real ZIMs mapped to topics in [catalog.json](catalog.json): WikiMed, Military Medicine, zimgit Water/Food/Knots/Post-Disaster, Wiktionary (EN/ES/FR/ZH), Wikipedia EN/ES, iFixit, Ham Radio Q&A, Outdoors Q&A, Gardenology, Ready.gov, and others. Sizes and download URLs are fetched live from `library.kiwix.org`, so you always get the newest version. |
| **Off-Grid Field Guide** | A pseudosite generated by [build_guide.py](build_guide.py) from [guide_content.py](guide_content.py), with one quick-reference page per topic. It is the drive's home page and links into every library on the drive. It covers topics that have no dedicated ZIM, such as tracking, smoking food, traps, and predator defence. |
| **zimit crawls** | Any website you choose, crawled in Docker (`ghcr.io/openzim/zimit`) and tagged to a topic. |

Some libraries come in several **flavours**: `maxi` (full), `nopic` (no images), and `mini` (intros only). Each row has a picker. Large ones default to `nopic`.

Downloading every library at the default flavours needs about **127 GB**, and full English Wikipedia alone is 49 GB. The essentials (medicine, water, food, knots, outdoors, radio, mechanics) fit in under 10 GB.

### Drive layout

```
OfflineLibrary/             (or your package's name)
  zim/                      all .zim files (offgrid-field-guide.zim is the home page)
  kiwix-tools/<platform>/   kiwix-serve for each OS you installed
  library.xml               Kiwix index of zim/
  START-Mac.command  START-Windows.bat  START-Linux.sh
  README-FIRST.txt
  custom.json               websites you crawled
```

Phones and tablets can open the `.zim` files directly with the free Kiwix app.

### Notes

- **Format the drive as exFAT** (or APFS/NTFS/ext4). FAT32 can't hold files over 4 GB; the app warns you and blocks those downloads.
- Downloads resume if interrupted: queue the same library again.
- Crawls copy the ZIM out of the container with `docker cp`, so Docker file-sharing settings don't matter. Only crawl sites you're allowed to copy, and set a page limit.
- Edit [catalog.json](catalog.json) to add topics or map more Kiwix libraries. Library names come from https://library.kiwix.org.
- The field-guide pages are short references, not a substitute for first-aid or firearms training.
