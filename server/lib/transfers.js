// Transfer links: fetch a file, or a folder as a zip, from another machine with curl, wget or PowerShell, without
// signing in. Each link carries a random token (192 bits), lives 2 minutes from creation, and by default works for
// one download. Tokens live in memory only (a restart forgets them). Creating and using a link are both audited.
import crypto from 'node:crypto';
import path from 'node:path';

const LIFE_MS = 2 * 60_000, MAX_ACTIVE = 20;
const links = new Map();   // token -> link
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const sweep = () => { const now = Date.now(); for (const [t, l] of links) if (l.expires < now - 60_000 || (l.once && l.used && !l.active)) links.delete(t); };
// A file name that is safe on every shell and file system.
export const safeName = n => String(n || 'download').replace(/[^\w.\-() ]+/g, '_').replace(/^[.\s]+/, '').slice(0, 120) || 'download';

export function create({ rel, abs, kind, all = false, once = true }) {
    sweep();
    if ([...links.values()].filter(l => l.expires > Date.now()).length >= MAX_ACTIVE) throw httpError(429, 'Too many transfer links are open. Wait for some to expire, or revoke them.');
    const token = crypto.randomBytes(24).toString('base64url');
    const name = safeName(kind === 'zip' ? `${path.basename(abs) || 'root'}.zip` : path.basename(abs));
    const link = { id: crypto.createHash('sha256').update(token).digest('hex').slice(0, 10), rel, abs, kind, all: !!all, once: once !== false, name, created: Date.now(), expires: Date.now() + LIFE_MS, used: 0, active: 0 };
    links.set(token, link);
    return { token, ...view(link) };
}
export const view = l => ({ id: l.id, rel: l.rel, kind: l.kind, name: l.name, once: l.once, all: l.all, created: l.created, expires: l.expires, used: l.used, path: null });
export function list() { sweep(); return [...links.entries()].filter(([, l]) => l.expires > Date.now() && !(l.once && l.used)).map(([t, l]) => ({ ...view(l), path: `/dl/${t}/${encodeURIComponent(l.name)}` })); }
export function revoke(id) { for (const [t, l] of links) if (l.id === id) { links.delete(t); return { revoked: id }; } throw httpError(404, 'No such link (it may have expired).'); }
// Look up a token for a download: null if unknown; an error status if expired or already used.
export function take(token) {
    const l = links.get(String(token || ''));
    if (!l) return null;
    if (l.expires < Date.now()) { links.delete(token); return { gone: 'This transfer link has expired.' }; }
    if (l.once && l.used) return { gone: 'This transfer link was already used.' };
    l.used++; l.active++;
    return { link: l, done: () => { l.active = Math.max(0, l.active - 1); if (l.once) links.delete(token); } };
}
