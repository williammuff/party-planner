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

`./scripts/release.sh [patch|minor|major] "notes" [--full]` publishes a version: bumps `package.json`, builds, commits, tags, pushes, creates a GitHub Release carrying only the code update (`Party-Planner-update.zip` + `.sha256` + `Party-Planner-update.json` naming the Electron version), refreshes the `installer` pre-release (full ~125 MB app) only when Electron changed or `--full` is passed, then reinstalls the local app. Installed copies check the latest Release at launch and every 6 hours (`electron/updater.js`): code-only swap of `Contents/Resources/app` when Electron matches, else the full app from `installer`; checksums verified, bundle re-signed ad hoc, rollback on failure. Only release when the user asks (each publish is public); commit their changes first (the script requires a clean tree). Testing a second copy while the real app is open needs `--user-data-dir` (single-instance lock).

## Electron

`node_modules/electron/dist` was installed by hand (the Electron 44 installer needs Node 22+; this Mac has Node 20): official v44.5.1 darwin-arm64 zip, verified against `checksums.json`. Re-do that manually when upgrading.
