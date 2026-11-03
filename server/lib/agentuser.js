// The unprivileged user AI agents run as (docs/AGENT-USER.md). Porthole stays root; agent-user shells run their
// command through runuser, sign in to the API with a per-shell token, and ask for root per command (elevate.js).

import fs from 'node:fs';
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

// Where an agent-user shell may start: projects, scratch folders, its own home.
export function allowedFolder(dir) {
    const a = info(); if (!a) return false;
    const real = fs.realpathSync(dir);
    const roots = [path.join(config.root, 'Projects'), path.join(config.home, 'scratch'), a.home].map(r => { try { return fs.realpathSync(r); } catch { return r; } });
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
    await run('chgrp', ['-R', GROUP, dir], { timeout: 120_000 });
    await run('chmod', ['-R', 'g+rwX', dir], { timeout: 120_000 });
    await run('find', [dir, '-type', 'd', '-exec', 'chmod', 'g+s', '{}', '+'], { timeout: 120_000 });
    log('agentuser', `made ${dir} group-writable for ${GROUP}`);
    return true;
}

// The command a tmux pane runs for an agent-user shell. Environment set on the session (tmux -e) passes through
// runuser; HOME/USER/LOGNAME/SHELL become the agent's.
export function wrap(cmd) {
    const a = info(); if (!a) throw httpError(412, 'The agent user does not exist on this box yet.');
    const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const pathVar = `${a.home}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin`;
    // umask 002 so files the agent creates stay group-writable for root shells in the same project.
    const inner = cmd ? `umask 002; ${cmd}` : 'umask 002; exec bash -l';
    // Absolute path: runuser lives in sbin, which the service's PATH may not include.
    const runuser = ['/usr/sbin/runuser', '/sbin/runuser', '/usr/bin/runuser'].find(f => fs.existsSync(f)) || 'runuser';
    return `exec ${runuser} -u ${USER} -- env PATH=${q(pathVar)} PORTHOLE_RUN_AS=agent bash -l -c ${q(inner)}`;
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
