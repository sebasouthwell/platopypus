// Upgrade repo: rebuild a prototype as a new project at a higher security level, instead of hardening it in place.
// The original stays untouched; the new project gets a read-only snapshot of it (.porthole/prototype), a brief
// (.porthole/UPGRADE.md) and a first agent prompt that asks for an architecture proposal before any code.
// The link between the two lives in PlatOpypus's state (project-links.json), so the original folder is not written to.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import * as profile from './profile.js';
import * as agentUser from './agentuser.js';
import { lockSnapshot, snapshotOf, SNAPSHOT } from './prototype.js';
import { log } from './log.js';
import { ensureIgnored } from './gitignore.js';

const run = promisify(execFile);
const linksFile = path.join(config.state, 'project-links.json');
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Left out of the snapshot: dependencies, build output, history, and anything that usually holds secrets.
const EXCLUDE = ['node_modules', '.git', '.porthole', '.env', '.env.*', '*.pem', '*.key', '.cloudflared', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.nuxt', '.cache', 'coverage', 'target'];
const SNAPSHOT_LIMIT = 300 * 1024 * 1024;

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function loadLinks() { try { return JSON.parse(fs.readFileSync(linksFile, 'utf8')); } catch { return { links: [] }; } }
function saveLinks(db) { const tmp = linksFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 }); fs.renameSync(tmp, linksFile); }

// { from: {name,…} } and/or { to: [{name,…}] } for a project folder, or null.
export function linksFor(root) {
    const r = path.resolve(root);
    const db = loadLinks();
    const from = db.links.find(l => l.to === r);
    const to = db.links.filter(l => l.from === r);
    if (!from && !to.length) return null;
    return {
        ...(from ? { from: { name: path.basename(from.from), path: from.from, at: from.at, level: from.level } } : {}),
        ...(to.length ? { to: to.map(l => ({ name: path.basename(l.to), path: l.to, at: l.at, level: l.level })) } : {}),
    };
}

async function commitOf(dir) {
    try { return (await run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 })).stdout.trim() || null; } catch { return null; }
}

function brief({ srcName, srcPath, srcLevel, destName, levelKey, levelTitle, commit }) {
    return `<!-- Written by PlatOpypus when ${destName} was created with "Upgrade repo". -->
# Upgrade: ${srcName} → ${destName}

**Prototype:** \`${srcPath}\`${commit ? ` (commit ${commit})` : ''} · ${srcLevel || 'no security level set'}
**Reference copy (read-only):** \`${SNAPSHOT}/\` in this project. Dependencies, build output, git history and
secret files (.env, keys) were left out. Read the original folder if you need something else, but **never change it**.
**Target level:** ${levelTitle} — read \`.porthole/security.md\` first; it governs everything below.

The prototype proved the idea works. This project is the version that deserves to exist long term. You are not asked
to patch the prototype: you may rethink its architecture wherever it does not support the target level. Keep what
the user experiences; replace what only made it quick to build.

## Workflow

1. **Reverse-engineer the prototype.** What the app does, which features are valuable, what users see, its API
   routes, data structures and stored state. Note behaviour that looks accidental and ask rather than copy it.
2. **Analyse its security assumptions.** Trust boundaries, who may call what, authentication, exposed endpoints,
   secrets and configuration, data flows, and the risks that appear with several or untrusted users.
3. **Design the architecture.** Decide which responsibilities deserve their own module (authentication, roles and
   permissions, domain logic, persistence, background jobs, API, administration). Split by responsibility, not to
   raise the file count. A small app should stay small: no microservices or heavy database unless it needs them.
4. **Rebuild while keeping the intended behaviour.** Use the prototype as the functional reference. Write new code
   where its structure cannot meet the target level; reuse what is already sound.
5. **Verify before anything replaces it.** Functional tests, security-boundary tests (every privileged action tried
   with the wrong role and the wrong object, e.g. another room's id), and a deployment rehearsal as a PlatOpypus live
   service (PORTHOLE.md). Compare behaviour with the prototype before presenting it.

## First: the proposal (then stop)

Before writing application code, do steps 1–3 and write \`PROPOSAL.md\` in this project:

- A summary of what the prototype does and the features to keep.
- The trust boundaries and the roles (for example players, hosts, administrators) and what each may do.
- A comparison table — possible differences, not mandatory choices; leave a row out when nothing changes:

| Area | Prototype | New project |
| --- | --- | --- |
| State | | |
| Authentication | | |
| Authorization | | |
| Structure | | |
| Configuration and secrets | | |
| Testing | | |
| Deployment | | |

- The module layout, the data model and its storage, and the test plan.
- Open questions for the user.

Then **stop and ask the user to review PROPOSAL.md**. Start building only after they approve it.
`;
}

export async function upgrade({ from, name, level, audience, tier }) {
    const src = profile.projectRoot(from || '');
    if (!src || path.resolve(src) !== path.resolve(from)) throw httpError(400, 'Pick a project folder directly under /Projects.');
    if (!fs.statSync(src).isDirectory()) throw httpError(400, 'Not a folder.');
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw httpError(400, 'Name: letters, digits, dot, dash or underscore (up to 64).');
    if (!['personal', 'professional'].includes(level)) throw httpError(400, 'An upgrade targets Personal or Professional.');
    const dest = path.join(path.dirname(src), name);
    if (fs.existsSync(dest)) throw httpError(409, `${name} already exists.`);
    const srcProfile = profile.get(src).profile;

    // Size check before copying anything.
    const args = ['-C', src, ...EXCLUDE.flatMap(e => ['--exclude', e]), '-cf', '-', '.'];
    const { stdout: du } = await run('sh', ['-c', `tar "$@" | wc -c`, 'sh', ...args], { timeout: 180_000, maxBuffer: 1024 * 1024 });
    if (Number(du.trim()) > SNAPSHOT_LIMIT) throw httpError(413, `The prototype is over ${SNAPSHOT_LIMIT / 1024 / 1024} MB without dependencies and build output; trim it first.`);

    fs.mkdirSync(dest, { mode: 0o775 });
    try {
        if (agentUser.available()) await agentUser.makeReady(dest).catch(() => {});
        const set = profile.set(dest, { level, audience, tier });
        const snap = snapshotOf(dest);
        fs.mkdirSync(snap, { recursive: true });
        await run('sh', ['-c', 'tar "$@" | tar -C "$0" -xf -', snap, ...args], { timeout: 300_000, maxBuffer: 1024 * 1024 });
        await lockSnapshot(dest);
        const commit = await commitOf(src);
        const text = brief({ srcName: path.basename(src), srcPath: src, srcLevel: srcProfile ? `${srcProfile.title}${srcProfile.key ? ` (${srcProfile.key})` : ''}` : null, destName: name, levelKey: set.profile.key, levelTitle: set.profile.key.replace('-', ' · '), commit });
        fs.writeFileSync(path.join(dest, '.porthole', 'UPGRADE.md'), text, { mode: 0o664 });
        fs.writeFileSync(path.join(dest, '.gitignore'), 'node_modules/\n.env\n', { mode: 0o664 });
        ensureIgnored(dest);   // .porthole/ (with the prototype copy) and .claude/
        if (agentUser.available()) await agentUser.makeReady(dest).catch(() => {});   // relocks the snapshot itself
        const db = loadLinks();
        db.links.push({ from: path.resolve(src), to: path.resolve(dest), at: Date.now(), level: set.profile.key, commit });
        saveLinks(db);
        log('upgrade', `${path.basename(src)} → ${name} (${set.profile.key})`);
        const prompt = `This project is an upgrade of the prototype ${path.basename(src)}. Read .porthole/security.md, then .porthole/UPGRADE.md, and follow it: do steps 1-3 using the read-only copy in ${SNAPSHOT}/, write PROPOSAL.md, then stop and ask me to review it before you write any application code. Do not change ${src}.`;
        return { name, folder: path.relative(config.root, dest).split(path.sep).join('/'), abs: dest, from: path.basename(src), level: set.profile.key, prompt };
    } catch (e) {
        // Leave nothing half-made behind.
        try { await run('rm', ['-rf', '--', dest], { timeout: 120_000 }); } catch { /* best effort */ }
        throw e;
    }
}
