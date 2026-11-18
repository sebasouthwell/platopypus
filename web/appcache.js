// A per-app response cache for the PlatOpypus web app: show the last answer at once, refresh in the background.
//
//  - Namespaced by app ("jobs", …); each app opts in with its own GET routes. Never used for the Vault or credentials.
//  - In memory and in IndexedDB, so a reload or a switch back is instant. IndexedDB entries are encrypted with AES-GCM
//    under a non-extractable key that lives only in this browser's IndexedDB (it can't be read out, only used), expire
//    after maxAge, and the whole store is deleted on sign-out or when the server says the session has ended.
//  - Identical requests in flight share one fetch; the server's ETag lets an unchanged answer come back as 304.
//  - Any write in the app (POST) marks the app's entries stale, so the next read revalidates.
const DB = 'plato-cache', STORE = 'r', KEYS = 'k';
let dbp = null, keyp = null;
const mem = new Map(); const inflight = new Map();
function db() {
    if (!('indexedDB' in self)) return Promise.resolve(null);
    return dbp || (dbp = new Promise(ok => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => { r.result.createObjectStore(STORE); r.result.createObjectStore(KEYS); }; r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); }));
}
const tx = (d, s, mode, fn) => new Promise(ok => { try { const t = d.transaction(s, mode); const r = fn(t.objectStore(s)); t.oncomplete = () => ok(r?.result); t.onerror = () => ok(null); } catch { ok(null); } });
async function key() {
    return keyp || (keyp = (async () => {
        const d = await db(); if (!d || !crypto?.subtle) return null;
        let k = await tx(d, KEYS, 'readonly', s => s.get('aes'));
        if (!k) { k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); await tx(d, KEYS, 'readwrite', s => s.put(k, 'aes')); }
        return k;
    })());
}
async function put(id, entry) {
    try { const d = await db(); const k = await key(); if (!d || !k) return; const iv = crypto.getRandomValues(new Uint8Array(12)); const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify(entry))); await tx(d, STORE, 'readwrite', s => s.put({ iv, data, at: entry.at }, id)); } catch { /* the cache is a nicety */ }
}
async function get(id, maxAge) {
    try { const d = await db(); const k = await key(); if (!d || !k) return null; const row = await tx(d, STORE, 'readonly', s => s.get(id)); if (!row) return null; if (Date.now() - row.at > maxAge) { tx(d, STORE, 'readwrite', s => s.delete(id)); return null; } const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv }, k, row.data); return JSON.parse(new TextDecoder().decode(buf)); } catch { return null; }
}
export async function wipe() { mem.clear(); inflight.clear(); keyp = null; try { const d = await db(); if (d) d.close(); } catch { /* closing */ } dbp = null; try { indexedDB.deleteDatabase(DB); } catch { /* none */ } }
// One app's cache. fresh: how long an answer is used without asking the server; maxAge: how long it is kept at all.
export function appCache(app, { fresh = 15_000, maxAge = 12 * 3600_000 } = {}) {
    const id = url => `${app}:${url}`;
    const stale = new Set();
    async function network(url) {
        const cur = mem.get(id(url));
        const res = await fetch(url, { headers: { 'X-Plato': '1', ...(cur?.etag ? { 'If-None-Match': cur.etag } : {}) } });
        if (res.status === 401) { await wipe(); location.href = '/'; throw new Error('Signed out.'); }
        if (res.status === 304 && cur) { const e = { ...cur, at: Date.now() }; mem.set(id(url), e); put(id(url), e); stale.delete(url); return { data: cur.data, changed: false }; }
        const data = await res.json().catch(() => ({})); if (!res.ok) { const err = new Error(data.error || res.statusText); err.status = res.status; throw err; }
        const e = { data, etag: res.headers.get('ETag') || null, at: Date.now() }; mem.set(id(url), e); put(id(url), e); stale.delete(url);
        return { data, changed: !cur || JSON.stringify(cur.data) !== JSON.stringify(data) };
    }
    const once = url => { if (!inflight.has(id(url))) inflight.set(id(url), network(url).finally(() => inflight.delete(id(url)))); return inflight.get(id(url)); };
    return {
        // Resolves with the freshest answer it has at once; onUpdate(data) runs if a background refresh brings something new.
        async get(url, onUpdate) {
            let e = mem.get(id(url)); if (!e) { e = await get(id(url), maxAge); if (e) mem.set(id(url), e); }
            if (!e) return (await once(url)).data;
            if (!stale.has(url) && Date.now() - e.at < fresh) return e.data;
            once(url).then(r => { if (r.changed && onUpdate) onUpdate(r.data); }).catch(() => {});
            return e.data;
        },
        // Always ask the server (still coalesced and ETag'd); for screens that must be current.
        async fetch(url) { return (await once(url)).data; },
        invalidate(prefix = '') { for (const k of mem.keys()) if (k.startsWith(`${app}:${prefix}`)) stale.add(k.slice(app.length + 1)); },
    };
}
