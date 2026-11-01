// Self-updates the installed app from the GitHub repo's Releases.
// Normal case: the latest release carries a small code-only update (the app's own files) plus a
// manifest naming the Electron version it needs; if that matches this copy, only Resources/app is
// swapped. Otherwise the full app (Electron included) comes from the permanent "installer" release.
// Every download is checked against its published SHA-256, the bundle is re-signed (ad hoc) and
// verified, and a failed swap is rolled back. Electron's built-in autoUpdater would need an Apple
// Developer ID, so this does it by hand.
import { app } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const FULL = 'Party-Planner-mac-arm64.zip';
const CODE = 'Party-Planner-update.zip';
const MANIFEST = 'Party-Planner-update.json';
const INSTALLER_TAG = 'installer';
const UA = { 'User-Agent': 'Party-Planner-updater' };

const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 1 << 26 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));

// "0.2.10" > "0.2.9"
export function isNewer(latest, current) {
  const a = String(latest).replace(/^v/, '').split('.').map(Number);
  const b = String(current).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', ...UA }, signal: AbortSignal.timeout(15000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

const asset = (rel, name) => rel?.assets?.find((a) => a.name === name);

// Downloads a release asset and checks it against its .sha256 sibling (and GitHub's digest).
async function download(rel, name, dest) {
  const a = asset(rel, name);
  if (!a) throw new Error(`release has no ${name}`);
  const res = await fetch(a.browser_download_url, { headers: UA, signal: AbortSignal.timeout(10 * 60000) });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  const actual = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  let expected = a.digest?.startsWith('sha256:') ? a.digest.slice(7) : null;
  const sum = asset(rel, `${name}.sha256`);
  if (sum) {
    const r = await fetch(sum.browser_download_url, { headers: UA, signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const published = (await r.text()).trim().split(/\s+/)[0];
      if (expected && published !== expected) throw new Error('release checksums disagree');
      expected = published;
    }
  }
  if (!expected) throw new Error(`${name} has no checksum to verify against`);
  if (actual !== expected) throw new Error(`${name} failed its checksum`);
}

export function createUpdater({ repo, currentVersion, appBundle, onStatus }) {
  let status = { state: 'idle', currentVersion, repo };
  const set = (patch) => { status = { ...status, ...patch, currentVersion, repo }; onStatus?.(status); return status; };
  let plan = null; // { version, mode: 'code' | 'full', release, notes }

  async function check() {
    if (!repo) return set({ state: 'unconfigured', message: 'No update source configured.' });
    if (!appBundle) return set({ state: 'dev', message: 'Updates apply to the installed app, not a copy run from the project folder.' });
    set({ state: 'checking' });
    try {
      const api = `https://api.github.com/repos/${repo}/releases`;
      const rel = await getJSON(`${api}/latest`); // ignores drafts and pre-releases (like "installer")
      const version = String(rel?.tag_name || '').replace(/^v/, '');
      if (!rel || !isNewer(version, currentVersion)) {
        plan = null;
        return set({ state: 'current', latestVersion: version || null, checkedAt: Date.now(), message: rel ? undefined : 'No releases published yet.' });
      }
      let manifest = null;
      const m = asset(rel, MANIFEST);
      if (m) {
        const r = await fetch(m.browser_download_url, { headers: UA, signal: AbortSignal.timeout(15000) });
        if (r.ok) manifest = await r.json();
      }
      if (asset(rel, CODE) && manifest?.electron === process.versions.electron) {
        plan = { version, mode: 'code', release: rel };
      } else if (asset(rel, FULL)) {
        plan = { version, mode: 'full', release: rel };
      } else {
        const installer = await getJSON(`${api}/tags/${INSTALLER_TAG}`);
        if (!asset(installer, FULL)) throw new Error('no full app published for this Electron version');
        plan = { version, mode: 'full', release: installer };
      }
      plan.notes = rel.body || '';
      return set({ state: 'available', latestVersion: version, notes: plan.notes, size: plan.mode, checkedAt: Date.now() });
    } catch (e) {
      return set({ state: 'error', message: `Couldn't check for updates (${e.message}).` });
    }
  }

  async function install() {
    if (!plan) await check();
    if (status.state !== 'available' || !plan) return status;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-update-'));
    const cfg = path.join(appBundle, 'Contents/Resources/app/config.json');
    try {
      set({ state: 'downloading' });
      if (plan.mode === 'code') await installCode(work, cfg);
      else await installFull(work, cfg);
      set({ state: 'restarting', latestVersion: plan.version });
      setTimeout(() => { app.relaunch(); app.exit(0); }, 600);
      return status;
    } catch (e) {
      return set({ state: 'error', message: `Update failed: ${e.code === 'EACCES' || e.code === 'EPERM' ? 'no permission to replace the app (is it in Applications?)' : e.message}` });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  // Swap just Contents/Resources/app, keeping this copy's config.json, then re-sign the bundle.
  async function installCode(work, cfg) {
    const zip = path.join(work, CODE);
    await download(plan.release, CODE, zip);
    set({ state: 'verifying' });
    const fresh = path.join(work, 'app');
    fs.mkdirSync(fresh);
    await run('/usr/bin/ditto', ['-x', '-k', zip, fresh]);
    const pkg = JSON.parse(fs.readFileSync(path.join(fresh, 'package.json'), 'utf8'));
    if (pkg.version !== plan.version || !fs.existsSync(path.join(fresh, 'electron/main.js'))) throw new Error('update contents look wrong');
    if (fs.existsSync(cfg)) fs.copyFileSync(cfg, path.join(fresh, 'config.json'));

    set({ state: 'installing' });
    const live = path.join(appBundle, 'Contents/Resources/app');
    const backup = `${live}.previous`;
    fs.rmSync(backup, { recursive: true, force: true });
    fs.renameSync(live, backup);
    try {
      await run('/usr/bin/ditto', [fresh, live]);
      await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appBundle]);
      await run('/usr/bin/codesign', ['--verify', '--deep', appBundle]);
    } catch (e) {
      fs.rmSync(live, { recursive: true, force: true });
      fs.renameSync(backup, live);
      await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appBundle]).catch(() => {});
      throw e;
    }
    fs.rmSync(backup, { recursive: true, force: true });
  }

  // Replace the whole .app (new Electron too). The installer release may hold an older build of
  // the code; the next check then brings it up to date with a code-only update.
  async function installFull(work, cfg) {
    const zip = path.join(work, FULL);
    await download(plan.release, FULL, zip);
    set({ state: 'verifying' });
    await run('/usr/bin/ditto', ['-x', '-k', zip, work]);
    const fresh = findApp(work);
    if (!fresh) throw new Error('no app found in the download');
    await run('/usr/bin/codesign', ['--verify', '--deep', fresh]);
    if (fs.existsSync(cfg)) {
      fs.copyFileSync(cfg, path.join(fresh, 'Contents/Resources/app/config.json'));
      await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', fresh]);
    }
    set({ state: 'installing' });
    const backup = `${appBundle}.previous`;
    fs.rmSync(backup, { recursive: true, force: true });
    fs.renameSync(appBundle, backup);
    try {
      await run('/usr/bin/ditto', [fresh, appBundle]);
    } catch (e) {
      fs.rmSync(appBundle, { recursive: true, force: true });
      fs.renameSync(backup, appBundle);
      throw e;
    }
    fs.rmSync(backup, { recursive: true, force: true });
  }

  return { check, install, status: () => status };
}

function findApp(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name.endsWith('.app')) return p;
    if (entry.isDirectory() && !entry.name.startsWith('__MACOSX')) {
      const inner = findApp(p);
      if (inner) return inner;
    }
  }
  return null;
}
