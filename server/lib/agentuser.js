// The unprivileged user AI agents run as (docs/AGENT-USER.md). PlatOpypus stays root; agent-user shells run their
// command through runuser, sign in to the API with a per-shell token, and ask for root per command (elevate.js).

import fs from 'node:fs';
import { lockSnapshot } from './prototype.js';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { log } from './log.js';

const run = promisify(execFile);
export const USER = process.env.PORTHOLE_AGENT_USER || 'agent';
export const GROUP = 'porthole-dev';

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

export function info() {
    try {
        const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find(l => l.startsWith(USER + ':'));
        if (!line) return null;
        const [, , uid, gid, , home] = line.split(':');
        return { user: USER, uid: Number(uid), gid: Number(gid), home };
    } catch { return null; }
}
export const available = () => !!info();
// Whether each agent has its own login for this user yet (they do not share root's; see docs/AGENT-USER.md stage 2).
export function signIns() {
    const a = info(); if (!a) return {};
    const has = f => fs.existsSync(path.join(a.home, f));
    return { claude: has('.claude/.credentials.json'), codex: has('.codex/auth.json'), antigravity: has('.gemini/oauth_creds.json') || has('.antigravity/oauth_creds.json') };
}

// Where an agent-user shell may start: projects, scratch folders, its own home.
export function allowedFolder(dir) {
    const a = info(); if (!a) return false;
    const real = fs.realpathSync(dir);
    // Agent scratch folders live under its home; root's ~/scratch is not reachable for this user.
    const roots = [path.join(config.root, 'Projects'), path.join(config.root, 'Research'), path.join(config.root, 'Lab'), path.join(config.root, 'Cases'), a.home].map(r => { try { return fs.realpathSync(r); } catch { return r; } });
    return roots.some(r => real === r || real.startsWith(r + path.sep));
}

// Group-writable for porthole-dev with setgid folders, so root and agent shells can share a project.
export async function prepareFolder(dir) {
    const a = info(); if (!a) throw httpError(412, 'The agent user does not exist on this box yet (re-run the installer).');
    if (!allowedFolder(dir)) throw httpError(403, 'Agent-user shells start in a project under /Projects, a scratch folder or the agent home.');
    try {
        const st = fs.statSync(dir);
        const groupOk = (await run('stat', ['-c', '%G', dir])).stdout.trim() === GROUP;
        if (groupOk && (st.mode & 0o2070) === 0o2070) return false;
    } catch { /* fall through */ }
    if (path.resolve(dir) === a.home) return false;
    await makeGroupWritable(dir);
    return true;
}

// Whether every file in a project is reachable for agent shells and live services (group porthole-dev, writable).
export async function folderReady(dir) {
    if (!info() || !allowedFolder(dir) || path.resolve(dir) === info().home) return { eligible: false, ready: true };
    try {
        const { stdout } = await run('find', [dir, '-path', '*/.porthole/prototype', '-prune', '-o', '(', '-not', '-group', GROUP, '-o', '-not', '-perm', '-g+w', ')', '-not', '-type', 'l', '-print', '-quit'], { timeout: 20_000 });
        return { eligible: true, ready: !stdout.trim(), example: stdout.trim() ? path.relative(dir, stdout.trim()) || '.' : null };
    } catch { return { eligible: true, ready: false, example: null }; }
}

// "Make agent-ready" from Files: the whole tree, even when the top folder already looks right.
export async function makeReady(dir) {
    if (!info()) throw httpError(412, 'The agent user does not exist on this box yet (re-run the installer).');
    if (!allowedFolder(dir) || path.resolve(dir) === info().home) throw httpError(403, 'Only project folders under /Projects can be made agent-ready.');
    await makeGroupWritable(dir);
    return folderReady(dir);
}

async function makeGroupWritable(dir) {
    await run('chgrp', ['-R', GROUP, dir], { timeout: 120_000 });
    await run('chmod', ['-R', 'g+rwX', dir], { timeout: 120_000 });
    await run('find', [dir, '-type', 'd', '-exec', 'chmod', 'g+s', '{}', '+'], { timeout: 120_000 });
    await lockSnapshot(dir).catch(() => {});   // an upgraded project's prototype stays read-only
    log('agentuser', `made ${dir} group-writable for ${GROUP}`);
}

// The command a tmux pane runs for an agent-user shell. Environment set on the session (tmux -e) passes through
// runuser; HOME/USER/LOGNAME/SHELL become the agent's.
export function wrap(cmd) {
    const a = info(); if (!a) throw httpError(412, 'The agent user does not exist on this box yet.');
    const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const pathVar = `${a.home}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin`;
    // 007: group-writable for root shells in the same project, nothing for other accounts (live services).
    const inner = cmd ? `umask 007; ${cmd}` : 'umask 007; exec bash -l';
    // Absolute path: runuser lives in sbin, which the service's PATH may not include.
    const runuser = ['/usr/sbin/runuser', '/sbin/runuser', '/usr/bin/runuser'].find(f => fs.existsSync(f)) || 'runuser';
    return `exec ${runuser} -u ${USER} -- env PATH=${q(pathVar)} PLATO_RUN_AS=agent PORTHOLE_RUN_AS=agent bash -l -c ${q(inner)}`;
}

// The uid owning a process and its real working directory (from /proc, not anything the caller claims).
export function proc(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n < 2) return null;
    try {
        const status = fs.readFileSync(`/proc/${n}/status`, 'utf8');
        const uid = Number((status.match(/^Uid:\s+(\d+)/m) || [])[1]);
        const ppid = Number((status.match(/^PPid:\s+(\d+)/m) || [])[1]);
        return { pid: n, uid, ppid, cwd: cwdOf(n) };
    } catch { return null; }
}
// Reading another user's /proc/<pid>/cwd needs ptrace rights, which containers often drop even for root; the process's
// own user can always read it, so fall back to asking as that user.
function cwdOf(n) {
    try { return fs.readlinkSync(`/proc/${n}/cwd`); } catch { /* no ptrace rights */ }
    try {
        const runuser = ['/usr/sbin/runuser', '/sbin/runuser', '/usr/bin/runuser'].find(f => fs.existsSync(f));
        if (!runuser) return null;
        return execFileSync(runuser, ['-u', USER, '--', 'readlink', `/proc/${n}/cwd`], { encoding: 'utf8', timeout: 3000 }).trim() || null;
    } catch { return null; }
}
export function isDescendant(pid, ancestor) {
    let cur = Number(pid);
    for (let i = 0; i < 64 && cur > 1; i++) {
        if (cur === Number(ancestor)) return true;
        const p = proc(cur); if (!p) return false;
        cur = p.ppid;
    }
    return false;
}

// ---- stage 2: move AI logins from root to the agent user (docs/AGENT-USER.md) ----
// Moved, never copied: two copies of one OAuth login refresh independently and can sign each other out.
// mv, not fs.rename: overlay filesystems (containers) refuse directory renames across layers, and /root and /home
// may be different filesystems.
const mv = (from, to) => run('mv', ['-T', from, to], { timeout: 300_000 });
const LOGIN_ITEMS = ['.claude', '.claude.json', '.agent-profiles', '.codex', '.gemini', '.antigravity'];
const markerFile = () => path.join(config.state, 'logins-moved.json');
export function loginsMoved() { try { return JSON.parse(fs.readFileSync(markerFile(), 'utf8')); } catch { return null; } }
// The home whose AI logins PlatOpypus uses: the agent user's once moved, otherwise root's.
export function loginHome() { const a = info(); return a && loginsMoved() ? a.home : config.home; }

export function rootLogins() { return LOGIN_ITEMS.filter(i => fs.existsSync(path.join(config.home, i))); }

export async function moveLogins({ busy = [] } = {}) {
    const a = info(); if (!a) throw httpError(412, 'The agent user does not exist on this box yet.');
    if (loginsMoved()) throw httpError(409, 'Logins were already moved.');
    if (busy.length) throw httpError(409, `End these root agent shells first (they hold the login open): ${busy.join(', ')}`);
    const items = rootLogins();
    if (!items.length) throw httpError(404, 'Root has no AI logins to move.');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const migrate = path.join(config.state, 'migrate');
    fs.mkdirSync(migrate, { recursive: true, mode: 0o700 });
    const backup = path.join(migrate, `logins-${stamp}.tar.gz`);
    // Backup of both sides first (contains credentials: root-only file).
    const args = ['-czf', backup, '-C', '/', ...items.map(i => path.relative('/', path.join(config.home, i))), ...LOGIN_ITEMS.filter(i => fs.existsSync(path.join(a.home, i))).map(i => path.relative('/', path.join(a.home, i)))];
    await run('tar', args, { timeout: 300_000 });
    fs.chmodSync(backup, 0o600);
    const moved = [];
    for (const i of items) {
        const src = path.join(config.home, i), dst = path.join(a.home, i);
        if (fs.existsSync(dst)) await mv(dst, `${dst}.porthole-pre-move-${stamp}`);
        await mv(src, dst);
        await run('chown', ['-R', `${a.uid}:${a.gid}`, dst], { timeout: 120_000 });
        moved.push(i);
    }
    fs.writeFileSync(markerFile(), JSON.stringify({ at: Date.now(), stamp, items: moved, backup }, null, 2), { mode: 0o600 });
    log('agentuser', `MOVED AI logins to ${a.user}: ${moved.join(', ')} (backup ${backup})`);
    return { moved, backup };
}

export async function undoMoveLogins({ busy = [] } = {}) {
    const a = info(); const m = loginsMoved();
    if (!a || !m) throw httpError(409, 'Nothing to undo.');
    if (busy.length) throw httpError(409, `End these agent-user shells first: ${busy.join(', ')}`);
    for (const i of m.items) {
        const src = path.join(a.home, i), dst = path.join(config.home, i);
        if (!fs.existsSync(src)) continue;
        if (fs.existsSync(dst)) await mv(dst, `${dst}.porthole-undo-${m.stamp}`);
        await mv(src, dst);
        await run('chown', ['-R', '0:0', dst], { timeout: 120_000 });
        const pre = `${src}.porthole-pre-move-${m.stamp}`;
        if (fs.existsSync(pre)) await mv(pre, src);
    }
    fs.rmSync(markerFile(), { force: true });
    log('agentuser', `UNDID login move (${m.items.join(', ')})`);
    return { restored: m.items };
}
