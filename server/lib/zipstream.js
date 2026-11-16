// Save a folder as a zip: walks the folder and streams a standard zip (deflate, UTF-8 names, data descriptors) straight
// to the response, so nothing is written to the box. No zip64: at most 65 535 entries and 4 GB, checked before the
// first byte is sent. Symlinks and special files are skipped, never followed.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const DEFAULT_SKIP = ['node_modules', '.git', '.platopypus', '__pycache__', '.venv', '.terraform'];
const MAX_ENTRIES = 65535, MAX_BYTES = 0xFFFFFFFF - 1;
const STORED_EXT = new Set(['.zip', '.gz', '.tgz', '.xz', '.zst', '.7z', '.rar', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.mkv', '.mp3', '.m4a', '.ogg', '.woff2', '.pdf']);
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// What would go in: files and folders (paths relative to the folder), total size, and what was skipped.
export async function plan(root, { skip = DEFAULT_SKIP } = {}) {
    const entries = [], skipped = new Map(); let bytes = 0, links = 0;
    const walk = async rel => {
        const dir = path.join(root, rel); let list;
        try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
        list.sort((a, b) => a.name.localeCompare(b.name));
        for (const ent of list) {
            const r = rel ? `${rel}/${ent.name}` : ent.name;
            if (skip.includes(ent.name)) { skipped.set(ent.name, (skipped.get(ent.name) || 0) + 1); continue; }
            if (ent.isSymbolicLink()) { links++; continue; }
            if (ent.isDirectory()) { entries.push({ rel: r, dir: true, mtime: (await fsp.stat(path.join(root, r)).catch(() => null))?.mtime || new Date() }); await walk(r); }
            else if (ent.isFile()) { const st = await fsp.stat(path.join(root, r)).catch(() => null); if (!st) continue; entries.push({ rel: r, dir: false, size: st.size, mtime: st.mtime, mode: st.mode }); bytes += st.size; }
            if (entries.length > MAX_ENTRIES) return;
        }
    };
    await walk('');
    return { entries, bytes, files: entries.filter(e => !e.dir).length, folders: entries.filter(e => e.dir).length, links, skipped: Object.fromEntries(skipped), tooBig: entries.length > MAX_ENTRIES || bytes > MAX_BYTES };
}

// CRC-32 (zlib.crc32 where Node has it).
const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = typeof zlib.crc32 === 'function' ? (buf, prev = 0) => zlib.crc32(buf, prev) : (buf, prev = 0) => { let c = (prev ^ 0xFFFFFFFF) >>> 0; for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const dos = d => { const y = Math.max(1980, d.getFullYear()); return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; };

// Stream the planned entries as a zip into `out` (a writable, usually the HTTP response). Resolves with totals.
export async function write(root, p, out) {
    if (p.tooBig) throw httpError(413, 'Too big for one zip (over 65 535 items or 4 GB).');
    let offset = 0; const central = [];
    // Wait for the response to take more, or fail if the browser went away (so an abandoned download never hangs).
    const drained = () => new Promise((ok, bad) => { const done = err => { out.off('drain', onD); out.off('close', onC); out.off('error', onC); err ? bad(err) : ok(); }; const onD = () => done(); const onC = () => done(new Error('The download was closed.')); out.on('drain', onD); out.on('close', onC); out.on('error', onC); });
    const send = async buf => { if (out.destroyed || out.writableEnded) throw new Error('The download was closed.'); offset += buf.length; if (!out.write(buf)) await drained(); };
    const put = send;
    for (const e of p.entries) {
        const name = Buffer.from(e.dir ? `${e.rel}/` : e.rel, 'utf8'); const { time, date } = dos(e.mtime); const start = offset;
        const method = e.dir ? 0 : 8; const flags = 0x0800 | (e.dir ? 0 : 0x0008);   // UTF-8 names; sizes after the data for files
        const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt16LE(name.length, 26);
        await put(lh); await put(name);
        let crc = 0, csize = 0, usize = 0;
        if (!e.dir) {
            const level = STORED_EXT.has(path.extname(e.rel).toLowerCase()) ? 1 : 6;
            const count = new Transform({ transform(c, _e, cb) { crc = crc32(c, crc); usize += c.length; cb(null, c); } });
            // The last stage writes into the response itself, so the pipeline only finishes once every byte is handed over.
            const sink = new Writable({ write(c, _e, cb) { csize += c.length; send(c).then(() => cb(), cb); } });
            try { await pipeline(fs.createReadStream(path.join(root, e.rel)), count, zlib.createDeflateRaw({ level }), sink); }
            catch (err) { if (out.destroyed || out.writableEnded) throw err; /* the file changed or became unreadable mid-way: what was read stays, and the sizes below are true */ }
            const dd = Buffer.alloc(16); dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc >>> 0, 4); dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(usize, 12); await put(dd);
        }
        central.push({ name, flags, method, time, date, crc: crc >>> 0, csize, usize, start, dir: e.dir, mode: e.mode });
    }
    const cdStart = offset;
    for (const c of central) {
        const h = Buffer.alloc(46); h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE((3 << 8) | 20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(c.flags, 8); h.writeUInt16LE(c.method, 10); h.writeUInt16LE(c.time, 12); h.writeUInt16LE(c.date, 14);
        h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.usize, 24); h.writeUInt16LE(c.name.length, 28);
        h.writeUInt32LE((((c.dir ? 0o40755 : (c.mode & 0o777) | 0o100000) & 0xFFFF) << 16 | (c.dir ? 0x10 : 0)) >>> 0, 38); h.writeUInt32LE(c.start, 42);
        await put(h); await put(c.name);
    }
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10); end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
    await put(end);
    return { entries: central.length, bytes: offset };
}
