// Per-project publishing flag. By default nothing on the box may be pushed anywhere: a folder is "local" until the
// user marks it as a repo on the phone, choosing private or public at the same time. The flag is enforced in three
// places: the Publish button, the git pre-push hook installed for the service user (bin/project allow-push), and
// the agents' instructions. Flags live in state/projects.json keyed by absolute folder path.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

const file = path.join(config.state, 'projects.json');
export const FLAGS = ['local', 'private', 'public'];

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { repos: {} }; } }
function save(db) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }
const norm = p => path.resolve(String(p || '/')).replace(/\/+$/, '') || '/';

// The flag for a folder: its own entry, else the nearest flagged ancestor (a sub-folder of a published project is
// part of that project), else "local".
export function repoFlag(absDir) {
    const db = load();
    let dir = norm(absDir);
    for (;;) {
        const e = db.repos[dir];
        if (e) return { flag: e.flag, dir, set: e.set };
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return { flag: 'local', dir: norm(absDir), set: null };
}

// Research (/Research/<Topic>): sources, notes, uploaded PDFs and transcripts never leave the box. The one exception
// is the paper itself (/Research/<Topic>/paper: the LaTeX and refs.bib), which may go to a PRIVATE repo, never public.
const researchRoot = () => norm(path.join(config.root, 'Research'));
export function researchPlace(absDir) {
    const rel = path.relative(researchRoot(), norm(absDir));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;          // not research at all
    const parts = rel.split(path.sep).filter(Boolean);
    return { paper: parts.length >= 2 && parts[1] === 'paper', paperRoot: parts.length === 2 && parts[1] === 'paper' };
}
const RESEARCH_REASON = 'Research files stay on this box and are never pushed. Only the paper folder (the LaTeX and refs.bib) can be published, and only to a private repo.';

export function setRepoFlag(absDir, flag) {
    if (!FLAGS.includes(flag)) throw httpError(400, 'Flag must be local, private or public.');
    const dir = norm(absDir);
    const rp = researchPlace(dir);
    if (rp && flag !== 'local' && (!rp.paperRoot || flag !== 'private')) throw httpError(400, RESEARCH_REASON);
    if (dir === '/' || dir === config.home) throw httpError(400, 'Flag a project folder, not the whole box.');
    const db = load();
    if (flag === 'local') delete db.repos[dir]; else db.repos[dir] = { flag, set: Date.now() };
    save(db);
    log('projects', `${dir} → ${flag}`);
    return repoFlag(dir);
}

// Used by the pre-push hook and by git.publish().
export function allowPush(absDir) {
    const f = repoFlag(absDir);
    const rp = researchPlace(absDir);
    // Checked here as well as in setRepoFlag, so a flag edited by hand in projects.json still cannot open research up.
    if (rp && (!rp.paper || f.flag !== 'private' || !researchPlace(f.dir)?.paperRoot)) return { allowed: false, ...f, flag: 'local', reason: RESEARCH_REASON };
    if (f.flag === 'local') return { allowed: false, ...f, reason: `"${path.basename(f.dir)}" is local only. On the phone: Files → this folder → Repo → choose Private or Public to allow publishing.` };
    return { allowed: true, ...f, reason: `${f.flag} repo` };
}

export function listFlags() {
    return Object.entries(load().repos).map(([dir, e]) => ({ dir, ...e }));
}
