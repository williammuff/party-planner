# Party Planner

Local web app that reads your Serato library, plans a DJ set from a plain-English brief, lets you preview and edit it, and saves it as a Serato crate. No API keys, no dependencies. The only network use is downloading public chart data (below).

## Run

**Installed app:** `./scripts/install.sh` builds the current code into `/Applications/Party Planner.app` (keep it in the Dock) and restarts it if it's running. It uses this folder's `data/` for recipes, crate backups and charts. Re-run it after any change.

**From the project folder:** `./go.sh` (or `npm run app`) runs the desktop app straight from here, which is handy while developing.

**Browser:** `npm start`, then open http://localhost:4321. Requires Node 20+. Set `SERATO_DIR` to use a `_Serato_` folder other than `~/Music/_Serato_`, `PORT` to change the port, and `PP_DATA_DIR` to keep data somewhere other than `./data`.

Only the desktop app can drag tracks straight into Serato.

## How it works

**Reading** (read-only): `database V2`, `Subcrates/*.crate`, `History/Sessions/*.session`, and the Serato tags inside audio files (hot cues, loops, waveform overview).

**Filling gaps in metadata** (`lib/library.js`): every derived value records its source, and the UI shows it.
- Genre: votes from the genre tag, grouping, comment codes like `(HH)`, folder names, crate names; falls back to the artist's other tracks.
- Year: year tag, else the earliest year across other versions of the same song (record pools re-tag old songs), else the artist's median year, else decade words in genre/crate names, else a dated record-pool folder.
- Energy: Mixed In Key `Energy N` in comments.
- Crowd-pleaser score: the stronger of two play signals (Serato's Play Count column `utpc`, and how many history sessions the track appears in), plus a bonus when both agree, plus how many crates it's in. A cleared play count doesn't penalise a track. Play counts over 999 are ignored (some taggers write years there), and huge automation sessions are down-weighted.
- Proven transitions: tracks you've played back to back (1–15 min apart) in real sets.

**Planning** (`lib/planner.js`): the brief is split into clauses → buckets of (genres, era range, share). "house vibe w/ hip hop 90's 2000's" becomes House (any era, 64%) + Hip Hop (1990–2009, 36%). Duration, BPM range, energy (chill / warm-up / build / peak), crowd pleasers vs deep cuts, clean versions and exclusions are picked up too. Everything is editable in the UI before rebuilding.

Tracks are scored on genre fit (penalised when the BPM is atypical for the genre), era fit (weighted by how trustworthy the year is), and popularity. They're deduped by song (one version of each), capped per artist, then ordered in genre blocks with a greedy pass over BPM distance, Camelot key distance, an energy curve and your proven transitions.

**Writing**: saving creates `Subcrates/<Parent>%%<Name>.crate` (default parent "Party Planner"). It never modifies `database V2` or `neworder.pref`. Overwriting an existing crate backs it up to `data/crate-backups/` first. If Serato is open, the crate shows up after a restart.

## Charts

`data/charts/` holds two local chart sources:

- **Billboard Hot 100**: every weekly chart since 1958, from the UT Austin [rwd-billboard-data](https://github.com/utdata/rwd-billboard-data) dataset (about 20 MB CSV, updated weekly upstream). Re-downloaded automatically when the local copy is over a week old.
- **iTunes Top Songs**: Apple only publishes the current top 100, so the app saves one snapshot per day in `data/charts/itunes/` and uses the last 30 days.

Refreshes run in the background at startup and from the **Update charts** button. If you're offline, the last local copy is used.

The **Charts** recipe setting (or words like "billboard", "chart hits", "only charted" in the brief) controls them:
- **Prioritize** boosts charted songs by peak position and weeks on the chart.
- **Only charted** drops everything that didn't chart.

It's era-aware: songs that charted inside a pillar's years count fully, outside them only partly. Billboard's first chart week also corrects track years when your tags are missing or look re-tagged.

## Pillars and keywords

In the "By pillar" view each pillar's header holds its settings: genres, era range, share of the set, **Must include** (a track has to match at least one of these words) and **Priority** (matches get boosted). Keywords are comma-separated and checked against artist, title, album, genre, comment, grouping, label, crate names and folder names, ignoring punctuation. Global settings (track count, energy, crowd, BPM, clean, exclude) live in the Recipe row above the results. Edits mark the set stale until you hit "Rebuild with changes".

## Recipes

**Save recipe** stores everything in `data/presets.json`:
- the brief and the Recipe row (track count, energy, crowd, BPM, clean, exclude)
- every pillar (genres, era, share, keywords, charts, shuffle seed)
- the exact tracks in the set, in order, including your pillar shuffles and removals

Loading a recipe brings back that exact set with fresh metadata (play counts, charts). Tracks no longer in the library are skipped and reported. Rebuild or a pillar's ⟳ Shuffle gives new picks from the same settings. "Update recipe" overwrites the loaded one; "Save as new" makes a copy. Older saved searches without tracks simply re-plan.

## What to play next

The second tab follows Serato live by reading its running log (`_Serato_/Logs/DJ.INFO`), which records every track load instantly with its deck. (Serato only writes `History/Sessions` files when a session ends.) The app checks every 2 seconds and on window focus (or press "Refresh decks"), shows what's on each deck, and refreshes suggestions whenever a new track is loaded. Tracks already played this session are skipped.

Suggestions weigh transitions you've actually played after that track, genre and era closeness, popularity, and Mixed In Key energy. BPM and key only break ties. Optional text steers it:
- genre words ("switch to house")
- decades or "throwbacks"
- energy words ("go harder", "slow it down")
- chart words
- anything else, treated as priority keyword phrases ("bay area", "too short")

The "Next" button on any set track, or "Next →" on a suggestion, plans from that track instead of Serato.

## Getting tracks into Serato

In the **desktop app**, dragging any track row (set, swap list, suggestions) is a native macOS file drag, just like dragging from Finder, so you can drop it on a Serato deck, crate or the library. No copy is made. "⇱ Drag set into Serato" drags the whole set in play order, and the "⇱ N" handle on a pillar drags that pillar. In play-order view, drag a row's **number** to reorder instead.

In a browser tab, drags can't carry real files (a browser limitation), so use **Finder** (reveals the file to drag from there) or save a crate.

Electron is installed manually because its installer needs Node 22+: `node_modules/electron/dist` holds the official v44.5.1 build, checked against Electron's published checksum.

## Sharing with another DJ

`./scripts/package.sh` builds `dist/Party Planner.zip`: a self-contained app for Apple Silicon Macs (no Node or Terminal needed) plus a short read-me. It contains the code and a seed copy of the Billboard history, nothing from your `data/` folder. The packaged app keeps its data in `~/Library/Application Support/Party Planner` and reads the recipient's own `~/Music/_Serato_`.

It's signed ad hoc, not with an Apple Developer ID, so the first launch needs right-click → Open (or System Settings → Privacy & Security → Open Anyway). Re-run the script after making changes.

## Updates

**First install** (any Apple Silicon Mac): download the full app from the permanent installer link, https://github.com/williammuff/party-planner/releases/download/installer/Party-Planner-mac-arm64.zip, unzip it, drag **Party Planner.app** into Applications, and right-click → Open the first time.

**After that it updates itself.** It checks this repo's latest Release at launch and every 6 hours (or **ⓘ → Check for updates**), shows **⬆ Update to x.y.z** in the top bar, and installs when you click it:
- Usually that's a **code-only update** of under 1 MB: just the app's own files are swapped inside the existing app.
- When a release needs a newer Electron, it downloads the full app from the installer release instead.

Every download is checked against its published SHA-256, the app is re-signed and verified, and a failed swap is rolled back. Your data isn't touched.

**Publishing:** commit your changes, then `./scripts/release.sh patch "What changed"` (or `minor` / `major`). Each release uploads only the small code update. The ~125 MB installer is re-uploaded only when Electron changes, or with `--full` to give new installs a newer starting version. Needs the GitHub CLI (`brew install gh`, `gh auth login`).

## Keys

Space play/pause · ← → previous/next track · 1–8 hot cues · Cmd/Ctrl+Enter in the brief to plan.

## Limits

- AIFF files only play in Safari; Chrome can't decode them. Cues/waveforms aren't read from WAV/AIFF yet.
- Tracks on external drives use crates stored on that drive; this version only reads the main `~/Music/_Serato_` library.
- Genre/era are inferred, so check the "why" line under each track. Swap anything wrong.
