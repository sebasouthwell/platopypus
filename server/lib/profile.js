// Project security profile: what kind of project a folder is, chosen once on the phone when the first agent session
// starts there, and the security brief that goes with it. Stored in the project (git-ignored by default, see gitignore.js):
//   <project>/.porthole/project.json   { level, audience?, tier?, set, lastCveCheck? }
//   <project>/.porthole/security.md    copy of deploy/security/<key>.md (refreshed when the level changes)
// Agents are told (global instructions) to read $PORTHOLE_SECURITY_FILE at the start of every session.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import * as agentUser from './agentuser.js';
import { log } from './log.js';
import { ensureIgnored } from './gitignore.js';

const docsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'security');
const projectsDir = path.join(config.root, 'Projects');
export const LEVELS = {
    throwaway: { title: 'Throwaway', blurb: 'One-off, torn down soon. Build as fast as possible, no security work.' },
    personal: { title: 'Personal', blurb: 'Yours. Decent security so nobody can use your login or see your data.', audiences: ['private', 'shared'] },
    professional: { title: 'Professional', blurb: 'Work-grade. Boundary tests every iteration, daily CVE checks.', tiers: ['internal', 'public', 'regulated'] },
};

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// The top-level project folder a path belongs to (/Projects/<name>), or null outside /Projects.
export function projectRoot(dir) {
    let real; try { real = fs.realpathSync(dir); } catch { real = path.resolve(dir); }
    let base; try { base = fs.realpathSync(projectsDir); } catch { base = projectsDir; }
    if (!real.startsWith(base + path.sep)) return null;
    return path.join(base, real.slice(base.length + 1).split(path.sep)[0]);
}

export function docKey(p) {
    if (!p) return null;
    if (p.level === 'throwaway') return 'throwaway';
    if (p.level === 'personal') return `personal-${p.audience === 'shared' ? 'shared' : 'private'}`;
    if (p.level === 'professional') return `professional-${['internal', 'public', 'regulated'].includes(p.tier) ? p.tier : 'internal'}`;
    return null;
}
export const docPath = key => path.join(docsDir, `${key}.md`);
export const controlDoc = () => docPath('control');

export function get(dir) {
    const root = projectRoot(dir);
    if (!root) return { root: null, profile: null };
    try {
        const p = JSON.parse(fs.readFileSync(path.join(root, '.porthole', 'project.json'), 'utf8'));
        if (!LEVELS[p.level]) return { root, profile: null };
        const key = docKey(p);
        const due = p.level === 'professional' && (!p.lastCveCheck || Date.now() - p.lastCveCheck > 24 * 3600_000);
        return { root, name: path.basename(root), profile: { ...p, key, title: LEVELS[p.level].title }, securityFile: path.join(root, '.porthole', 'security.md'), cveDue: due };
    } catch { return { root, name: path.basename(root), profile: null }; }
}

function writeShared(file, text) {
    fs.writeFileSync(file, text, { mode: 0o664 });
    const a = agentUser.info();
    if (a) { try { fs.chownSync(file, 0, Number(fs.statSync(path.dirname(file)).gid)); } catch { /* best effort */ } }
}

export function set(dir, { level, audience, tier }) {
    const root = projectRoot(dir);
    if (!root) throw httpError(400, 'Security levels apply to projects under /Projects.');
    if (!LEVELS[level]) throw httpError(400, 'level: throwaway, personal or professional.');
    if (level === 'personal' && !['private', 'shared'].includes(audience)) throw httpError(400, 'Personal projects are private or shared.');
    if (level === 'professional' && !['internal', 'public', 'regulated'].includes(tier)) throw httpError(400, 'Professional tier: internal, public or regulated.');
    const meta = path.join(root, '.porthole');
    fs.mkdirSync(meta, { recursive: true, mode: 0o775 });
    const prev = get(root).profile;
    const p = { level, ...(level === 'personal' ? { audience } : {}), ...(level === 'professional' ? { tier } : {}), set: Date.now(), ...(prev?.lastCveCheck ? { lastCveCheck: prev.lastCveCheck } : {}) };
    writeShared(path.join(meta, 'project.json'), JSON.stringify(p, null, 2) + '\n');
    const key = docKey(p);
    writeShared(path.join(meta, 'security.md'), `<!-- Written by PlatOpypus for this project's security level (${key}). Change the level on the phone, not here. -->\n\n` + fs.readFileSync(docPath(key), 'utf8'));
    ensureIgnored(root);
    log('profile', `${path.basename(root)} → ${key}`);
    return get(root);
}

export function cveChecked(dir) {
    const g = get(dir);
    if (!g.profile) throw httpError(404, 'This project has no security level yet.');
    const file = path.join(g.root, '.porthole', 'project.json');
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    p.lastCveCheck = Date.now();
    writeShared(file, JSON.stringify(p, null, 2) + '\n');
    log('profile', `${path.basename(g.root)} CVE check recorded`);
    return get(dir);
}
