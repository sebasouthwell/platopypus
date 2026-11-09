// Self-update: daily version check against the public repo, and a detached updater that re-runs install.sh
// with a snapshot + automatic rollback. State: state/update.json. The updater never touches ~/.porthole,
// user files, tmux sessions, Docker, or nginx; only /opt/porthole (the app) is replaced.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { log } from './log.js';
import * as migrate from './migrate.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..', '..');           // /opt/porthole
const stateFile = path.join(config.state, 'update.json');
export const REPO = process.env.PORTHOLE_UPDATE_REPO || 'sebasouthwell/platopypus';
// Channel: `stable` moves only when a release has soaked on master (scripts/release.ps1 -Promote); set
// PORTHOLE_UPDATE_BRANCH=master in /etc/porthole.env to follow every release immediately.
export const BRANCH = process.env.PORTHOLE_UPDATE_BRANCH || 'stable';
const SRC = process.env.PORTHOLE_SRC || (fs.existsSync('/opt/platopypus-src') || !fs.existsSync('/opt/porthole-src') ? '/opt/platopypus-src' : '/opt/porthole-src');

function load() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } }
function save(s) { fs.writeFileSync(stateFile, JSON.stringify(s, null, 2), { mode: 0o600 }); }
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

export function installed() {
    let version = null, sha = null, installedAt = null;
    try { version = JSON.parse(fs.readFileSync(path.join(appDir, 'server', 'package.json'), 'utf8')).version; } catch { /* unknown */ }
    try { const v = fs.readFileSync(path.join(appDir, 'VERSION'), 'utf8').trim().split(/\s+/); sha = v[0] || null; installedAt = v[1] ? Number(v[1]) * 1000 : null; } catch { /* bundle install without VERSION */ }
    return { version, sha, installedAt, repo: REPO, branch: BRANCH, src: SRC, srcIsGit: fs.existsSync(path.join(SRC, '.git')) };
}

function cmpVersion(a, b) {
    const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0), pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
    return 0;
}

async function gh(url) {
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'porthole-updater' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw httpError(502, `GitHub ${res.status} for ${url.replace('https://api.github.com', '')}`);
    return res.json();
}

// Ask GitHub what master looks like; remember the answer.
export async function check(trigger = 'manual') {
    const me = installed();
    const s = load();
    try {
        const [pkgRes, commits] = await Promise.all([
            fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/server/package.json`, { signal: AbortSignal.timeout(15_000) }),
            gh(`https://api.github.com/repos/${REPO}/commits?sha=${encodeURIComponent(BRANCH)}&per_page=8`),
        ]);
        if (!pkgRes.ok) throw httpError(502, `package.json fetch ${pkgRes.status}`);
        const latestVersion = (await pkgRes.json()).version;
        const latestSha = commits[0]?.sha?.slice(0, 7) || null;
        // Upgrade plan: the new release's migrations this box has not applied yet (shown before Update).
        let plan = null;
        try {
            const mr = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/server/migrations/manifest.json`, { signal: AbortSignal.timeout(15_000) });
            if (mr.ok) {
                const done = new Set((migrate.schema(config.state).applied || []).map(a => a.id));
                plan = ((await mr.json()).migrations || []).filter(m => !done.has(m.id) && cmpVersion(m.version, latestVersion) <= 0)
                    .sort((x, y) => cmpVersion(x.version, y.version)).map(m => ({ id: m.id, version: m.version, title: m.title, detail: m.detail, touches: m.touches || [] }));
            } else if (mr.status === 404) plan = [];
        } catch { /* plan stays unknown */ }
        const newerVersion = cmpVersion(latestVersion, me.version) > 0;
        const newerSha = !!(me.sha && latestSha && me.sha !== latestSha);
        const available = newerVersion || (!me.sha ? false : newerSha);
        Object.assign(s, {
            checkedAt: Date.now(), trigger, error: null, latestVersion, latestSha, available, plan,
            latestDate: commits[0]?.commit?.committer?.date || null,
            notes: commits.map(c => ({ sha: c.sha.slice(0, 7), message: c.commit.message.split('\n')[0].slice(0, 120), date: c.commit.committer?.date })),
        });
        log('update', `check (${trigger}): installed ${me.version}${me.sha ? '@' + me.sha : ''}, latest ${latestVersion}@${latestSha} → ${available ? 'UPDATE AVAILABLE' : 'up to date'}`);
    } catch (e) {
        Object.assign(s, { checkedAt: Date.now(), trigger, error: e.message });
        log('update', `check failed: ${e.message}`);
    }
    save(s);
    return status();
}

export function status() {
    const s = load();
    let result = null;
    try { result = JSON.parse(fs.readFileSync(path.join(config.state, 'update-result.json'), 'utf8')); } catch { /* none */ }
    return { installed: installed(), ...s, inProgress: fs.existsSync(path.join(config.state, 'update.lock')), lastResult: result };
}

// Start the detached updater. It survives this process restarting.
export async function apply() {
    if (fs.existsSync(path.join(config.state, 'update.lock'))) throw httpError(409, 'An update is already running.');
    const script = path.join(appDir, 'bin', 'plato-update');
    if (!fs.existsSync(script)) throw httpError(500, 'Updater script missing.');
    log('update', `APPLY requested → ${REPO}@${BRANCH}`);
    const out = fs.openSync(path.join(config.state, 'update.log'), 'a');
    const env = { ...process.env, PORTHOLE_UPDATE_REPO: REPO, PORTHOLE_UPDATE_BRANCH: BRANCH, PORTHOLE_SRC: SRC, PORTHOLE_STATE: config.state, PORTHOLE_APP: appDir, PLATO_UPDATE_REPO: REPO, PLATO_UPDATE_BRANCH: BRANCH, PLATO_SRC: SRC, PLATO_STATE: config.state, PLATO_APP: appDir };
    let child;
    try {
        // Prefer a transient systemd unit so the updater is not killed with the porthole service.
        await run('systemd-run', ['--version'], { timeout: 3000 });
        child = spawn('systemd-run', ['--unit', `platopypus-update-${Date.now()}`, '--collect', '--setenv=PORTHOLE_UPDATE_REPO=' + REPO, '--setenv=PORTHOLE_UPDATE_BRANCH=' + BRANCH, '--setenv=PORTHOLE_SRC=' + SRC, '--setenv=PORTHOLE_STATE=' + config.state, '--setenv=PORTHOLE_APP=' + appDir, 'bash', script], { stdio: ['ignore', out, out], detached: true });
    } catch {
        child = spawn('setsid', ['bash', script], { env, stdio: ['ignore', out, out], detached: true });
    }
    child.unref();
    return { started: true };
}

// Daily check, first one a minute after boot.
export function schedule() {
    setTimeout(() => check('startup').catch(() => {}), 60_000);
    setInterval(() => check('daily').catch(() => {}), 24 * 3600_000);
}
