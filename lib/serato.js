// Readers/writers for Serato's on-disk formats: database V2, .crate files, history sessions.
// All of them are a flat sequence of chunks: 4-byte tag, 4-byte big-endian length, payload.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const SERATO_DIR = process.env.SERATO_DIR || path.join(os.homedir(), 'Music', '_Serato_');
const SUBCRATES = path.join(SERATO_DIR, 'Subcrates');

export function* chunks(buf) {
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    yield [buf.toString('latin1', i, i + 4), buf.subarray(i + 8, i + 8 + len), buf.readUInt32BE(i)];
    i += 8 + len;
  }
}

export function utf16(buf) {
  const b = Buffer.from(buf.subarray(0, buf.length & ~1));
  return b.swap16().toString('utf16le').replace(/\0+$/, '');
}

function encUtf16(str) {
  return Buffer.from(str, 'utf16le').swap16();
}

function chunk(tag, data) {
  const head = Buffer.alloc(8);
  head.write(tag, 0, 'latin1');
  head.writeUInt32BE(data.length, 4);
  return Buffer.concat([head, data]);
}

// Serato stores paths relative to the volume root, without a leading slash.
export const normPath = (p) => p.replace(/^\/+/, '');

export function readDatabase() {
  const buf = fs.readFileSync(path.join(SERATO_DIR, 'database V2'));
  const tracks = [];
  for (const [tag, data] of chunks(buf)) {
    if (tag !== 'otrk') continue;
    const t = {};
    for (const [k, v] of chunks(data)) {
      if (k[0] === 't' || k[0] === 'p') t[k] = utf16(v).trim();
      else if (k[0] === 'b') t[k] = v[0] === 1;
      else if (k[0] === 'u' && v.length >= 4) t[k] = v.readUInt32BE(0);
    }
    if (t.pfil) tracks.push(t);
  }
  return tracks;
}

export function readCrates() {
  const crates = [];
  for (const file of fs.readdirSync(SUBCRATES)) {
    if (!file.endsWith('.crate')) continue;
    const name = file.slice(0, -'.crate'.length);
    const paths = [];
    try {
      for (const [tag, data] of chunks(fs.readFileSync(path.join(SUBCRATES, file)))) {
        if (tag !== 'otrk') continue;
        for (const [k, v] of chunks(data)) if (k === 'ptrk') paths.push(normPath(utf16(v)));
      }
    } catch {
      continue; // unreadable crate; skip rather than fail the whole library load
    }
    crates.push({ name, parts: name.split('%%'), paths });
  }
  return crates;
}

// History sessions: oent > adat > fields keyed by numeric id instead of 4-char tags.
const F_PATH = 2, F_START = 28, F_PLAYED = 50;

export function readHistory() {
  const dir = path.join(SERATO_DIR, 'History', 'Sessions');
  const sessions = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.session')); } catch { return sessions; }
  for (const file of files) {
    const plays = [];
    try {
      for (const [tag, data] of chunks(fs.readFileSync(path.join(dir, file)))) {
        if (tag !== 'oent') continue;
        for (const [k, adat] of chunks(data)) {
          if (k !== 'adat') continue;
          const e = {};
          for (const [, v, id] of chunks(adat)) {
            if (id === F_PATH) e.path = normPath(utf16(v));
            else if (id === F_START && v.length >= 4) e.start = v.readUInt32BE(0);
            else if (id === F_PLAYED) e.played = v[0] === 1;
          }
          if (e.path && e.played) plays.push(e);
        }
      }
    } catch {
      continue;
    }
    plays.sort((a, b) => (a.start || 0) - (b.start || 0));
    if (plays.length) sessions.push(plays);
  }
  return sessions;
}

const CRATE_COLUMNS = ['song', 'artist', 'bpm', 'key', 'year', 'genre', 'comment', 'length'];

export function buildCrate(paths) {
  const parts = [chunk('vrsn', encUtf16('1.0/Serato ScratchLive Crate'))];
  parts.push(chunk('osrt', Buffer.concat([chunk('tvcn', encUtf16('song')), chunk('brev', Buffer.from([0]))])));
  for (const col of CRATE_COLUMNS) {
    parts.push(chunk('ovct', Buffer.concat([chunk('tvcn', encUtf16(col)), chunk('tvcw', encUtf16('0'))])));
  }
  for (const p of paths) parts.push(chunk('otrk', chunk('ptrk', encUtf16(normPath(p)))));
  return Buffer.concat(parts);
}

export const crateFile = (fullName) => path.join(SUBCRATES, `${fullName}.crate`);

export function sanitizeCrateName(name) {
  return name.replace(/%%/g, '%').replace(/[\/\\:]/g, '-').replace(/\s+/g, ' ').trim();
}

// Writes Parent%%Child.crate, creating empty ancestor crates so Serato shows the nesting.
// Never touches database V2 or neworder.pref. Existing files are backed up first.
export function saveCrate({ name, parent, paths, backupDir }) {
  const parts = [...(parent ? parent.split('%%') : []), name].map(sanitizeCrateName).filter(Boolean);
  if (!parts.length) throw new Error('Crate name is empty');
  for (let i = 1; i < parts.length; i++) {
    const ancestor = crateFile(parts.slice(0, i).join('%%'));
    if (!fs.existsSync(ancestor)) fs.writeFileSync(ancestor, buildCrate([]));
  }
  const fullName = parts.join('%%');
  const file = crateFile(fullName);
  let backup = null;
  if (fs.existsSync(file)) {
    fs.mkdirSync(backupDir, { recursive: true });
    backup = path.join(backupDir, `${Date.now()}-${path.basename(file)}`);
    fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buildCrate(paths));
  fs.renameSync(tmp, file);
  return { fullName, file, backup };
}
