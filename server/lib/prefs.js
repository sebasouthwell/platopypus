// Interface preferences kept on the box, so the phone and the desktop see the same thing.
//   files.hidden: 'hide' (names starting with a dot are not listed), 'some' (they are, except the clutter list),
//                 'all' (everything is listed)
//   files.clutter: names left out unless 'all' (folders like .git, .terraform, node_modules)
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = path.join(config.state, 'prefs.json');
export const DEFAULT_CLUTTER = ['.git', '.terraform', 'node_modules', '__pycache__', '.venv'];
const DEFAULTS = { files: { hidden: 'hide', clutter: DEFAULT_CLUTTER } };
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const NAME_OK = /^[^/\\\0]{1,100}$/;

export function get() {
    let s = {}; try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* defaults */ }
    return { files: { ...DEFAULTS.files, ...(s.files || {}) }, set: !!s.files };
}
export function set(body = {}) {
    const cur = get(); const f = { ...cur.files };
    if (body.files?.hidden !== undefined) { if (!['hide', 'some', 'all'].includes(body.files.hidden)) throw httpError(400, 'hidden: hide, some or all.'); f.hidden = body.files.hidden; }
    if (body.files?.clutter !== undefined) {
        const list = (Array.isArray(body.files.clutter) ? body.files.clutter : String(body.files.clutter).split(/[,\n]/)).map(x => String(x).trim()).filter(Boolean);
        if (list.length > 50 || list.some(n => !NAME_OK.test(n))) throw httpError(400, 'The clutter list holds up to 50 names, without slashes.');
        f.clutter = [...new Set(list)];
    }
    fs.writeFileSync(file, JSON.stringify({ files: f }, null, 2), { mode: 0o600 });
    return get();
}
