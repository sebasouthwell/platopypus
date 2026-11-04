// File browser backend, jailed to config.root. Every path from the client is resolved against the
// root, then the real path (symlinks followed) is checked to still be inside it. Deletes move to a
// trash folder in the state dir instead of unlinking.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { log } from './log.js';

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

const rootReal = fs.realpathSync(config.root);

// True when `real` is the root or below it. Handles root === "/" (whole filesystem) without doubling the slash.
const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
function inside(real) {
    return real === rootReal || real.startsWith(rootPrefix);
}

// Resolve a client-supplied relative path to an absolute path inside the root.
// The parent must exist and really be inside the root; the leaf may not exist yet (for uploads/mkdir).
export function resolveInRoot(rel) {
    if (typeof rel !== 'string') throw httpError(400, 'Bad path.');
    if (rel.includes('\0')) throw httpError(400, 'Bad path.');
    const abs = path.resolve(config.root, rel.replace(/^\/+/, ''));
    // Existing path (including the root itself): follow symlinks, then check.
    try {
        const real = fs.realpathSync(abs);
        if (!inside(real)) throw httpError(403, 'Outside the allowed folder.');
        return real;
    } catch (e) {
        if (e.status) throw e;
    }
    // Not there yet (upload / mkdir target): the parent must exist and be inside the root.
    let parentReal;
    try {
        parentReal = fs.realpathSync(path.dirname(abs));
    } catch {
        throw httpError(404, 'Folder not found.');
    }
    if (!inside(parentReal)) throw httpError(403, 'Outside the allowed folder.');
    return path.join(parentReal, path.basename(abs));
}

export function relative(abs) {
    const rel = path.relative(rootReal, abs);
    return rel.split(path.sep).join('/');
}

export function safeName(name) {
    if (typeof name !== 'string') throw httpError(400, 'Bad name.');
    const base = path.basename(name).replace(/[\0/\\]/g, '').trim();
    if (!base || base === '.' || base === '..') throw httpError(400, 'Bad name.');
    if (base.length > 255) throw httpError(400, 'Name too long.');
    return base;
}

// A folder's own icon: a favicon (or app icon) at its top level or in a usual web folder. Checked per listing for
// folders only, newest-first by place; cached by the folder's mtime so a long Projects list stays cheap.
const ICON_DIRS = ['', 'public', 'static', 'src', 'web', 'www', 'assets', 'app', 'client', 'frontend', 'src/assets', 'public/img', 'public/images', 'static/img', 'apps/web/public', 'apps/web', 'packages/web/public', 'frontend/public', 'client/public', 'web/icons'];
const ICON_NAMES = ['favicon.svg', 'favicon.png', 'favicon.ico', 'apple-touch-icon.png', 'icon.svg', 'icon.png', 'logo.svg', 'logo.png'];
export const ICON_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const iconCache = new Map(); // dir -> { mtime, icon }
export async function folderIcon(full, mtime) {
    const hit = iconCache.get(full);
    if (hit && hit.mtime === mtime) return hit.icon;
    let found = null;
    outer: for (const d of ICON_DIRS) {
        for (const n of ICON_NAMES) {
            const f = path.join(full, d, n);
            try { const st = await fsp.stat(f); if (st.isFile() && st.size > 0 && st.size <= 512 * 1024) { found = path.posix.join(d, n); break outer; } } catch { /* next */ }
        }
    }
    if (iconCache.size > 2000) iconCache.clear();
    iconCache.set(full, { mtime, icon: found });
    return found;
}

export async function list(rel) {
    const dir = resolveInRoot(rel || '.');
    let entries;
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
        if (e.code === 'ENOENT') throw httpError(404, 'Folder not found.');
        if (e.code === 'ENOTDIR') throw httpError(400, 'Not a folder.');
        throw e;
    }
    const items = [];
    for (const ent of entries) {
        const full = path.join(dir, ent.name);
        let st;
        try { st = await fsp.stat(full); } catch { continue; } // dangling symlink etc.
        const isDir = st.isDirectory();
        items.push({
            name: ent.name,
            type: isDir ? 'dir' : 'file',
            size: isDir ? null : st.size,
            modified: st.mtimeMs,
            hidden: ent.name.startsWith('.'),
            symlink: ent.isSymbolicLink(),
            ...(isDir && !ent.name.startsWith('.') && entries.length <= 300 ? { icon: await folderIcon(full, st.mtimeMs).catch(() => null) } : {}),
        });
    }
    items.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
    return { path: relative(dir), items, root: rootReal, home: relative(path.resolve(config.home)) };
}

export async function stat(rel) {
    const p = resolveInRoot(rel);
    const st = await fsp.stat(p).catch(() => { throw httpError(404, 'Not found.'); });
    return { abs: p, stat: st };
}

export async function mkdir(rel, name) {
    const dir = resolveInRoot(rel || '.');
    const target = path.join(dir, safeName(name));
    await fsp.mkdir(target);
    log('files', `mkdir ${relative(target)}`);
    return { path: relative(target) };
}

export async function rename(rel, newName) {
    const from = resolveInRoot(rel);
    const to = path.join(path.dirname(from), safeName(newName));
    if (fs.existsSync(to)) throw httpError(409, 'Something with that name already exists.');
    await fsp.rename(from, to);
    log('files', `rename ${relative(from)} -> ${relative(to)}`);
    return { path: relative(to) };
}

export async function trash(rel) {
    const target = resolveInRoot(rel);
    if (target === rootReal) throw httpError(400, 'Cannot delete the root folder.');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(config.state, 'trash', `${stamp}__${path.basename(target)}`);
    try {
        await fsp.rename(target, dest);
    } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        // Different filesystem (e.g. a mounted volume): copy then remove.
        await fsp.cp(target, dest, { recursive: true, preserveTimestamps: true });
        await fsp.rm(target, { recursive: true, force: true });
    }
    log('files', `trash ${relative(target)} -> ${dest}`);
    return { trashed: dest };
}

// Streams a request body to a temp file in the target folder, then renames into place.
export async function upload(req, rel, name, overwrite = false) {
    const dir = resolveInRoot(rel || '.');
    const st = await fsp.stat(dir).catch(() => { throw httpError(404, 'Folder not found.'); });
    if (!st.isDirectory()) throw httpError(400, 'Not a folder.');
    const base = safeName(name);
    const final = path.join(dir, base);
    if (!overwrite && fs.existsSync(final)) throw httpError(409, `"${base}" already exists.`);

    const declared = parseInt(req.headers['content-length'] || '0', 10);
    const maxBytes = config.maxUploadMb * 1024 * 1024;
    if (declared > maxBytes) throw httpError(413, `Upload is bigger than ${config.maxUploadMb} MB.`);

    const tmp = path.join(dir, `.${base}.porthole-upload-${process.pid}`);
    let received = 0;
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    try {
        req.on('data', chunk => {
            received += chunk.length;
            if (received > maxBytes) req.destroy(httpError(413, `Upload is bigger than ${config.maxUploadMb} MB.`));
        });
        await pipeline(req, out);
        await fsp.rename(tmp, final);
    } catch (e) {
        await fsp.rm(tmp, { force: true });
        throw e.status ? e : httpError(500, 'Upload failed.');
    }
    log('files', `upload ${relative(final)} (${received} bytes)`);
    return { path: relative(final), size: received };
}

// ---------- text editor ----------

const MAX_EDIT_BYTES = 2 * 1024 * 1024;
export const editableExt = new Set(['.txt', '.md', '.markdown', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.bash', '.zsh', '.yml', '.yaml', '.toml', '.env', '.html', '.htm', '.css', '.scss', '.csv', '.tsv', '.log', '.tf', '.tfvars', '.ini', '.conf', '.cfg', '.xml', '.sql', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.hpp', '.rb', '.php', '.swift', '.kt', '.lua', '.r', '.ps1', '.bat', '.dockerfile', '.gitignore', '.editorconfig', '.lock', '.properties', '.svg', '.vue', '.svelte']);

export function isEditable(name, size) {
    const base = path.basename(name);
    const ext = path.extname(base).toLowerCase();
    const named = /^(dockerfile|makefile|caddyfile|procfile|license|readme|\.[a-z0-9_-]+rc)$/i.test(base);
    return (editableExt.has(ext) || named || ext === '') && size <= MAX_EDIT_BYTES;
}

export async function read(rel) {
    const p = resolveInRoot(rel);
    const st = await fsp.stat(p).catch(() => { throw httpError(404, 'Not found.'); });
    if (!st.isFile()) throw httpError(400, 'Not a file.');
    if (!isEditable(p, st.size)) throw httpError(415, st.size > MAX_EDIT_BYTES ? 'Too big to edit here (2 MB limit).' : 'Not a text file.');
    const buf = await fsp.readFile(p);
    if (buf.includes(0)) throw httpError(415, 'This looks like a binary file.');
    return { path: relative(p), content: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs };
}

// Atomic write. If `expectedMtime` is given and the file changed since, refuse so the phone can ask.
export async function write(rel, content, expectedMtime) {
    const p = resolveInRoot(rel);
    if (typeof content !== 'string') throw httpError(400, 'Content must be text.');
    if (Buffer.byteLength(content) > MAX_EDIT_BYTES) throw httpError(413, 'Too big to save here (2 MB limit).');
    const st = await fsp.stat(p).catch(() => null);
    if (st && !st.isFile()) throw httpError(400, 'Not a file.');
    if (st && expectedMtime && Math.abs(st.mtimeMs - Number(expectedMtime)) > 1) throw httpError(409, 'The file changed on the box since you opened it.');
    const tmp = `${p}.porthole-save-${process.pid}`;
    await fsp.writeFile(tmp, content, { mode: st ? st.mode & 0o777 : 0o644 });
    await fsp.rename(tmp, p);
    const after = await fsp.stat(p);
    log('files', `saved ${relative(p)} (${after.size} bytes)`);
    return { path: relative(p), size: after.size, mtime: after.mtimeMs };
}

export async function create(rel, name) {
    const dir = resolveInRoot(rel || '.');
    const target = path.join(dir, safeName(name));
    if (fs.existsSync(target)) throw httpError(409, 'A file with that name already exists.');
    await fsp.writeFile(target, '', { flag: 'wx', mode: 0o644 });
    log('files', `create ${relative(target)}`);
    return { path: relative(target) };
}

const textExt = new Set(['.txt', '.md', '.json', '.js', '.mjs', '.ts', '.py', '.sh', '.yml', '.yaml', '.toml', '.env', '.html', '.css', '.csv', '.log', '.tf', '.ini', '.conf', '.xml', '.sql', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.rb']);
const imageExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

export function kindOf(name) {
    const ext = path.extname(name).toLowerCase();
    if (imageExt.has(ext)) return 'image';
    if (textExt.has(ext) || ext === '' ) return 'text';
    if (ext === '.pdf') return 'pdf';
    return 'binary';
}

export const mimeByExt = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.woff2': 'font/woff2',
};
