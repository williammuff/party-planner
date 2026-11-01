// Self-updates the installed app from the GitHub repo's latest Release:
// check -> download the zip -> verify its SHA-256 and code signature -> swap the app bundle -> relaunch.
// Electron's built-in autoUpdater needs an Apple Developer ID; this works with ad hoc signing.
import { app } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const ASSET = 'Party-Planner-mac-arm64.zip';
const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 1 << 26 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));

// "0.2.10" > "0.2.9"
export function isNewer(latest, current) {
  const a = String(latest).replace(/^v/, '').split('.').map(Number);
  const b = String(current).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

export function createUpdater({ repo, currentVersion, appBundle, onStatus }) {
  let status = { state: 'idle', currentVersion, repo };
  const set = (patch) => { status = { ...status, ...patch, currentVersion, repo }; onStatus?.(status); return status; };
  let latest = null;

  async function check() {
    if (!repo) return set({ state: 'unconfigured', message: 'No update source configured.' });
    if (!appBundle) return set({ state: 'dev', message: 'Updates apply to the installed app, not a copy run from the project folder.' });
    set({ state: 'checking' });
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Party-Planner-updater' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 404) return set({ state: 'current', message: 'No releases published yet.', checkedAt: Date.now() });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const rel = await res.json();
      const asset = rel.assets?.find((a) => a.name === ASSET);
      const sumAsset = rel.assets?.find((a) => a.name === `${ASSET}.sha256`);
      const version = String(rel.tag_name || '').replace(/^v/, '');
      if (!asset || !isNewer(version, currentVersion)) return set({ state: 'current', latestVersion: version || null, checkedAt: Date.now() });
      latest = { version, url: asset.browser_download_url, sumUrl: sumAsset?.browser_download_url, digest: asset.digest, notes: rel.body || '' };
      return set({ state: 'available', latestVersion: version, notes: latest.notes, checkedAt: Date.now() });
    } catch (e) {
      return set({ state: 'error', message: `Couldn't check for updates (${e.message}).` });
    }
  }

  async function install() {
    if (!latest) await check();
    if (status.state !== 'available' || !latest) return status;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-update-'));
    try {
      set({ state: 'downloading' });
      const res = await fetch(latest.url, { headers: { 'User-Agent': 'Party-Planner-updater' }, signal: AbortSignal.timeout(10 * 60000) });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const zip = path.join(work, ASSET);
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));

      // Integrity: the release publishes a .sha256 file (and GitHub reports a digest); both must match.
      set({ state: 'verifying' });
      const actual = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
      let expected = latest.digest?.startsWith('sha256:') ? latest.digest.slice(7) : null;
      if (latest.sumUrl) {
        const sumRes = await fetch(latest.sumUrl, { headers: { 'User-Agent': 'Party-Planner-updater' }, signal: AbortSignal.timeout(15000) });
        if (sumRes.ok) {
          const published = (await sumRes.text()).trim().split(/\s+/)[0];
          if (expected && published !== expected) throw new Error('release checksums disagree');
          expected = published;
        }
      }
      if (!expected) throw new Error('release has no checksum to verify against');
      if (actual !== expected) throw new Error('downloaded file failed its checksum');

      await run('/usr/bin/ditto', ['-x', '-k', zip, work]);
      const fresh = findApp(work);
      if (!fresh) throw new Error('no app found in the download');
      await run('/usr/bin/codesign', ['--verify', '--deep', fresh]);

      // Keep this copy's settings (e.g. config.json pointing at your project's data folder).
      const cfg = path.join(appBundle, 'Contents/Resources/app/config.json');
      if (fs.existsSync(cfg)) fs.copyFileSync(cfg, path.join(fresh, 'Contents/Resources/app/config.json'));
      await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', fresh]);

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
      set({ state: 'restarting', latestVersion: latest.version });
      setTimeout(() => { app.relaunch(); app.exit(0); }, 600);
      return status;
    } catch (e) {
      return set({ state: 'error', message: `Update failed: ${e.code === 'EACCES' || e.code === 'EPERM' ? 'no permission to replace the app (move it to Applications)' : e.message}` });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
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
