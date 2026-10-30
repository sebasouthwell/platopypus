// Credentials handed over by agents via `credshare`. Captured from the pty stream (OSC 777 porthole-cred),
// stored encrypted with the vault key in state/shared-creds.json, linked to a service by port where possible,
// kept for 7 days or until deleted. Values are only returned to an authenticated client that asks.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { log } from './log.js';
import { encrypt, decrypt } from './vault.js';
import * as tunnels from './tunnels.js';
import * as dockerMgr from './docker.js';

const file = path.join(config.state, 'shared-creds.json');
const TTL = 7 * 86400_000;
const CRED_RE = /\x1b\]777;porthole-cred;([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)/g;
const tails = new Map(); // shell -> partial sequence carried between chunks
export const events = new EventEmitter(); // 'added' -> { id, title, port, shell }

function load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { items: [] }; } }
function save(db) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 }); fs.renameSync(tmp, file); }

function inferPort(cred) {
    if (cred.port && Number.isInteger(Number(cred.port))) return Number(cred.port);
    const u = String(cred.url || '');
    const local = u.match(/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d+))?/i);
    if (local) return local[1] ? Number(local[1]) : (u.startsWith('https') ? 443 : 80);
    return null;
}

// Called for every chunk of pty output. Returns how many credentials were captured.
export function capture(shell, text) {
    const buf = (tails.get(shell) || '') + text;
    let m, found = 0;
    CRED_RE.lastIndex = 0;
    while ((m = CRED_RE.exec(buf))) {
        try {
            const cred = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
            if (!cred || !Array.isArray(cred.fields)) continue;
            add(shell, cred);
            found++;
        } catch { /* malformed */ }
    }
    const start = buf.lastIndexOf('\x1b]777;porthole-cred;');
    tails.set(shell, start >= 0 && !/\x07|\x1b\\/.test(buf.slice(start)) ? buf.slice(start).slice(0, 20000) : '');
    return found;
}

export async function add(shell, cred) {
    const db = load();
    let port = inferPort(cred);
    if (!port && cred.url) {
        // A tunnel URL → the port behind it.
        try { const t = (await tunnels.list()).find(x => x.url && String(cred.url).startsWith(x.url)); if (t) port = t.port; } catch { /* ignore */ }
    }
    const item = {
        id: crypto.randomBytes(5).toString('hex'),
        title: String(cred.title || 'Credentials').slice(0, 80),
        fields: cred.fields.slice(0, 20).map(f => ({ label: String(f.label).slice(0, 40), value: encrypt(String(f.value).slice(0, 4096)), secret: !!f.secret })),
        url: cred.url ? String(cred.url).slice(0, 2048) : null,
        note: cred.note ? String(cred.note).slice(0, 300) : null,
        shell: shell || cred.shell || null,
        port,
        at: Date.now(),
    };
    db.items.unshift(item);
    db.items = db.items.filter(i => Date.now() - i.at < TTL).slice(0, 50);
    save(db);
    log('credshare', `shell "${shell}" shared "${item.title}" (${item.fields.length} field(s)${port ? `, port ${port}` : ''})`);
    events.emit('added', { id: item.id, title: item.title, port, shell: item.shell });
    return item.id;
}

// List with live service resolution. values=true decrypts field values (authenticated callers only).
export async function list({ shell = null, port = null, values = false } = {}) {
    const db = load();
    const fresh = db.items.filter(i => Date.now() - i.at < TTL);
    if (fresh.length !== db.items.length) { db.items = fresh; save(db); }
    let tl = [], ports = new Set(), containers = [];
    try { tl = await tunnels.list(); } catch { /* ignore */ }
    try { ports = new Set((await tunnels.listeningPorts()).map(p => p.port)); } catch { /* ignore */ }
    try { if (await dockerMgr.available()) containers = await dockerMgr.containers(); } catch { /* ignore */ }
    return fresh
        .filter(i => (!shell || i.shell === shell) && (!port || i.port === Number(port)))
        .map(i => {
            const t = i.port ? tl.find(x => x.port === i.port) : null;
            const c = i.port ? containers.find(x => x.state === 'running' && x.ports.some(pp => pp.host === i.port)) : null;
            const live = i.port ? (ports.has(i.port) || !!c) : null;
            return {
                id: i.id, title: i.title, url: i.url, note: i.note, shell: i.shell, port: i.port, at: i.at,
                service: i.port ? { live, tunnel: t?.url || null, container: c?.name || null } : null,
                fields: i.fields.map(f => ({ label: f.label, secret: f.secret, value: values ? safeDecrypt(f.value) : undefined, hint: f.secret ? '••••••••' : safeDecrypt(f.value) })),
            };
        });
}
function safeDecrypt(v) { try { return decrypt(v); } catch { return ''; } }

export function remove(id) {
    const db = load();
    const before = db.items.length;
    db.items = db.items.filter(i => i.id !== id);
    if (db.items.length === before) throw Object.assign(new Error('No such shared credential.'), { status: 404 });
    save(db);
    log('credshare', `forgot ${id}`);
}

export function removeStale() {
    const db = load();
    const before = db.items.length;
    db.items = db.items.filter(i => Date.now() - i.at < TTL);
    save(db);
    return before - db.items.length;
}
