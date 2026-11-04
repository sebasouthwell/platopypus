// Pins and recents for live-service actions: shortcuts on Home so a command, a group or one item (a room)
// is one tap away. A pin is only a pointer: running it goes through the same routes, confirmations and
// item checks as the service page. Kept on the box so the phone and the desktop see the same list.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const file = path.join(config.state, 'quick.json');
const MAX_PINS = 24, MAX_RECENT = 8;
const KINDS = new Set(['action', 'group', 'item']);
const str = (v, n) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, n));

function load() {
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return { pins: Array.isArray(j.pins) ? j.pins : [], recents: Array.isArray(j.recents) ? j.recents : [] }; }
    catch { return { pins: [], recents: [] }; }
}
function save(d) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}
// Actions and groups are matched by label, so reordering PORTHOLE.md does not repoint a pin.
function target(b) {
    const t = {
        kind: String(b?.kind || ''), project: str(b?.project, 80), key: str(b?.key, 31),
        action: str(b?.action, 80), group: str(b?.group, 80), item: str(b?.item, 128), itemLabel: str(b?.itemLabel, 120),
    };
    if (!KINDS.has(t.kind) || !t.project || !/^[a-z0-9-]{1,31}$/.test(t.key || '')) return null;
    if (t.kind === 'action' && !t.action) return null;
    if (t.kind !== 'action' && !t.group) return null;
    if (t.kind === 'item' && !/^[\w.:@+\-=/]{1,128}$/.test(t.item || '')) return null;
    if (t.kind === 'group') t.item = t.itemLabel = null;
    if (t.kind !== 'item') t.itemLabel = null;
    return t;
}
const same = (a, b) => a.kind === b.kind && a.project === b.project && a.key === b.key && (a.group || null) === (b.group || null) && (a.item || null) === (b.item || null) && (a.kind === 'item' ? true : (a.action || null) === (b.action || null));

export const get = () => load();

export function pin(body) {
    const t = target(body);
    if (!t) { const e = new Error('kind (action, group or item), project, key and the action, group or item it points at'); e.status = 400; throw e; }
    if (t.kind !== 'action') t.action = null;   // a group or item pin opens its sheet: every action of the group
    const d = load();
    const have = d.pins.find(p => same(p, t));
    if (have) return have;
    if (d.pins.length >= MAX_PINS) { const e = new Error(`At most ${MAX_PINS} pins: remove one first.`); e.status = 409; throw e; }
    const p = { id: crypto.randomBytes(6).toString('hex'), ...t, at: Date.now() };
    d.pins.push(p); save(d);
    return p;
}
export function unpin(id) {
    const d = load();
    const n = d.pins.length;
    d.pins = d.pins.filter(p => p.id !== id);
    if (d.pins.length !== n) save(d);
    return { removed: n - d.pins.length };
}
// Called after an action ran (from the page, a pin or a recent). The newest run of a target replaces the older one.
export function recordRun(body, { code = 0 } = {}) {
    try {
        const t = target(body); if (!t) return;
        const d = load();
        d.recents = [{ ...t, code, at: Date.now() }, ...d.recents.filter(r => !(same(r, t) && r.action === t.action))].slice(0, MAX_RECENT);
        save(d);
    } catch { /* recents are a convenience; never fail an action over them */ }
}
export function clearRecents() { const d = load(); d.recents = []; save(d); return { ok: true }; }
