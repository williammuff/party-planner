// Reads the data Serato embeds in audio files: hot cues + loops + track color ("Serato Markers2")
// and the waveform overview ("Serato Overview"). MP3 stores them as ID3 GEOB frames; M4A and FLAC
// store a base64 blob that wraps the same payload.
import fs from 'node:fs';

function cstr(buf, start) {
  const end = buf.indexOf(0, start);
  return buf.toString('utf8', start, end < 0 ? buf.length : end);
}

const hex = (b, i) => `#${b.subarray(i, i + 3).toString('hex')}`;

function decodeBase64Loose(text) {
  let s = text.replace(/[^A-Za-z0-9+/]/g, '');
  if (s.length % 4 === 1) s = s.slice(0, -1); // Serato sometimes leaves a dangling char
  return Buffer.from(s, 'base64');
}

function parseMarkers2(data) {
  // 0x01 0x01, then base64 text of (0x01 0x01, entries...), each entry: name\0, u32 len, payload.
  const buf = decodeBase64Loose(data.subarray(2).toString('latin1').split('\0')[0]);
  const out = { cues: [], loops: [], color: null, bpmLock: false };
  let i = 2;
  while (i < buf.length) {
    const end = buf.indexOf(0, i);
    if (end <= i || end + 5 > buf.length) break;
    const name = buf.toString('latin1', i, end);
    const len = buf.readUInt32BE(end + 1);
    const d = buf.subarray(end + 5, end + 5 + len);
    i = end + 5 + len;
    if (name === 'CUE' && d.length >= 12) {
      out.cues.push({ index: d[1], ms: d.readUInt32BE(2), color: hex(d, 7), name: cstr(d, 12) });
    } else if (name === 'LOOP' && d.length >= 20) {
      out.loops.push({ index: d[1], startMs: d.readUInt32BE(2), endMs: d.readUInt32BE(6), name: cstr(d, 20) });
    } else if (name === 'COLOR' && d.length >= 4) {
      out.color = hex(d, 1);
    } else if (name === 'BPMLOCK') {
      out.bpmLock = d[0] === 1;
    }
  }
  out.cues.sort((a, b) => a.index - b.index);
  return out;
}

function parseOverview(data) {
  // 0x01 0x05, then 16-byte columns (one byte per frequency band).
  const cols = [];
  for (let i = 2; i + 16 <= data.length; i += 16) cols.push([...data.subarray(i, i + 16)]);
  return cols;
}

const syncsafe = (b, i) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];

function readId3Geobs(fd) {
  const head = Buffer.alloc(10);
  fs.readSync(fd, head, 0, 10, 0);
  if (head.toString('latin1', 0, 3) !== 'ID3') return {};
  const ver = head[3];
  const size = syncsafe(head, 6);
  const body = Buffer.alloc(size);
  fs.readSync(fd, body, 0, size, 10);
  let i = head[5] & 0x40 ? (ver === 4 ? syncsafe(body, 0) : body.readUInt32BE(0) + 4) : 0;
  const out = {};
  while (i + 10 <= body.length) {
    const id = body.toString('latin1', i, i + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = ver === 4 ? syncsafe(body, i + 4) : body.readUInt32BE(i + 4);
    if (id === 'GEOB') {
      const f = body.subarray(i + 10, i + 10 + len);
      // encoding(1) mime\0 filename\0 description\0 data — Serato always uses latin1 (encoding 0).
      const mimeEnd = f.indexOf(0, 1);
      const fileEnd = f.indexOf(0, mimeEnd + 1);
      const descEnd = f.indexOf(0, fileEnd + 1);
      if (f[0] === 0 && descEnd > 0) out[f.toString('latin1', fileEnd + 1, descEnd)] = f.subarray(descEnd + 1);
    }
    i += 10 + len;
  }
  return out;
}

// M4A/FLAC: base64("application/octet-stream\0" + "\0" + "Serato Markers2\0" + payload)
function unwrapBlob(b64) {
  const buf = decodeBase64Loose(b64);
  const mimeEnd = buf.indexOf(0);
  const fileEnd = buf.indexOf(0, mimeEnd + 1);
  const descEnd = buf.indexOf(0, fileEnd + 1);
  if (descEnd < 0) return null;
  return [buf.toString('latin1', fileEnd + 1, descEnd), buf.subarray(descEnd + 1)];
}

function readMp4Blobs(fd, fileSize) {
  // Walk top-level atoms to find moov (may be at the end of the file), then moov>udta>meta>ilst>----.
  let pos = 0;
  const head = Buffer.alloc(16);
  let moov = null;
  while (pos + 8 <= fileSize) {
    fs.readSync(fd, head, 0, 16, pos);
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    if (size === 1) size = Number(head.readBigUInt64BE(8));
    else if (size === 0) size = fileSize - pos;
    if (size < 8) break;
    if (type === 'moov') {
      moov = Buffer.alloc(size - 8);
      fs.readSync(fd, moov, 0, size - 8, pos + 8);
      break;
    }
    pos += size;
  }
  const out = {};
  if (!moov) return out;
  const walk = (buf, path) => {
    let i = 0;
    while (i + 8 <= buf.length) {
      const size = buf.readUInt32BE(i);
      const type = buf.toString('latin1', i + 4, i + 8);
      if (size < 8) break;
      const body = buf.subarray(i + 8, i + size);
      if (type === 'udta' || type === 'ilst') walk(body, [...path, type]);
      else if (type === 'meta') walk(body.subarray(4), [...path, type]);
      else if (type === '----') {
        let name = '';
        let data = null;
        let j = 0;
        while (j + 8 <= body.length) {
          const s = body.readUInt32BE(j);
          const t = body.toString('latin1', j + 4, j + 8);
          if (s < 8) break;
          if (t === 'name') name = body.toString('utf8', j + 12, j + s);
          if (t === 'data') data = body.subarray(j + 16, j + s).toString('latin1');
          j += s;
        }
        if (name && data) out[name] = data;
      }
      i += size;
    }
  };
  walk(moov, []);
  const geobs = {};
  for (const key of ['markersv2', 'overview']) {
    const u = out[key] && unwrapBlob(out[key]);
    if (u) geobs[u[0]] = u[1];
  }
  return geobs;
}

function readFlacBlobs(fd) {
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  if (head.toString('latin1') !== 'fLaC') return {};
  let pos = 4;
  const geobs = {};
  for (let guard = 0; guard < 64; guard++) {
    fs.readSync(fd, head, 0, 4, pos);
    const last = head[0] & 0x80;
    const type = head[0] & 0x7f;
    const len = head.readUIntBE(1, 3);
    if (type === 4) {
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, pos + 4);
      let i = 4 + b.readUInt32LE(0);
      const n = b.readUInt32LE(i);
      i += 4;
      for (let k = 0; k < n && i + 4 <= b.length; k++) {
        const l = b.readUInt32LE(i);
        const kv = b.toString('latin1', i + 4, i + 4 + l);
        i += 4 + l;
        const eq = kv.indexOf('=');
        const key = kv.slice(0, eq).toUpperCase();
        if (key === 'SERATO_MARKERS_V2' || key === 'SERATO_OVERVIEW') {
          const u = unwrapBlob(kv.slice(eq + 1));
          if (u) geobs[u[0]] = u[1];
        }
      }
    }
    pos += 4 + len;
    if (last) break;
  }
  return geobs;
}

export function readSeratoTags(file) {
  const result = { cues: [], loops: [], color: null, overview: null };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const ext = file.split('.').pop().toLowerCase();
    const size = fs.fstatSync(fd).size;
    const geobs = ext === 'mp3' ? readId3Geobs(fd)
      : ext === 'm4a' || ext === 'mp4' || ext === 'aac' ? readMp4Blobs(fd, size)
      : ext === 'flac' ? readFlacBlobs(fd)
      : ext === 'aif' || ext === 'aiff' || ext === 'wav' ? {} // ID3 inside RIFF/AIFF chunks: not yet supported
      : {};
    if (geobs['Serato Markers2']) Object.assign(result, parseMarkers2(geobs['Serato Markers2']));
    if (geobs['Serato Overview']) result.overview = parseOverview(geobs['Serato Overview']);
  } catch (e) {
    result.error = e.code || e.message;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return result;
}
