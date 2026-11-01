# Party Planner

Local Electron + Node app that reads the user's Serato library (see README.md for how it works).

## After every code change

Run `./scripts/install.sh`. It rebuilds `/Applications/Party Planner.app` from the current code and restarts it if it was running. That installed copy is what the user launches from the Dock; it shares this project's `data/` folder (recipes, crate backups, charts) via `config.json` baked into the bundle. A change isn't done until it's installed.

- It boots the new server on port 4397 first and refuses to install if that fails.
- Run it from a shell where `ELECTRON_RUN_AS_NODE` may be set (VS Code sets it): the scripts unset it themselves.
- `./go.sh` / `npm run app` still run straight from the project folder for quick checks.

## Sharing

`./scripts/package.sh` builds `dist/Party Planner.zip` for other Apple Silicon Macs (friends' copies). It must never include anything from `data/` except the Billboard seed: no recipes, crate backups, logs or iTunes snapshots (they contain the user's paths and username).

## Releases and auto-update

`./scripts/release.sh [patch|minor|major] "notes"` publishes a version: bumps `package.json`, builds the zip + `.sha256`, commits, tags, pushes, creates the GitHub Release on `updateRepo`, and reinstalls the local app. Installed copies (the user's and friends') check that repo's latest Release at launch and every 6 hours (`electron/updater.js`), verify the checksum and signature, swap themselves and relaunch. Only release when the user asks; commit their changes first (the script requires a clean tree).

## Electron

`node_modules/electron/dist` was installed by hand (the Electron 44 installer needs Node 22+; this Mac has Node 20): official v44.5.1 darwin-arm64 zip, verified against `checksums.json`. Re-do that manually when upgrading.
