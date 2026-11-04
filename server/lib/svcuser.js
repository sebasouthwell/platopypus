// The account live services and their actions run as: porthole-svc. It has no login shell, no sudo, no logins or
// keys of any kind, and a home that holds nothing but caches. It is in porthole-dev only, so it can read and write
// project folders that are agent-ready and nothing else of the user's. Porthole (root) stays the controller: it
// starts the process, owns the log, and stops or kills the whole process group. A public app that gets broken into
// lands in this account, not in root and not in the agent user (which holds the AI logins).

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from './log.js';

const run = promisify(execFile);
export const USER = process.env.PORTHOLE_SVC_USER || 'porthole-svc';
export const GROUP = 'porthole-dev';
export const HOME = '/var/lib/porthole-svc';
const PATH = '/usr/local/bin:/usr/bin:/bin';

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

export function info() {
    try {
        const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find(l => l.startsWith(USER + ':'));
        if (!line) return null;
        const [, , uid, gid, , home] = line.split(':');
        return { user: USER, uid: Number(uid), gid: Number(gid), home };
    } catch { return null; }
}

// Create the account if this box predates it (the installer also does this). Idempotent.
let ensured = null;
export async function ensure() {
    if (info()) return info();
    if (ensured) return ensured;
    ensured = (async () => {
        try {
            await run('sh', ['-c', `getent group ${GROUP} >/dev/null || groupadd --system ${GROUP}`]);
            await run('useradd', ['--system', '--home-dir', HOME, '--create-home', '--shell', '/usr/sbin/nologin', '--user-group', '--groups', GROUP, USER]);
            fs.chmodSync(HOME, 0o750);
            log('svcuser', `created ${USER} for live services`);
        } catch (e) { if (!info()) throw httpError(500, `Could not create the ${USER} account: ${e.message.split('\n')[0]}`); }
        return info();
    })().finally(() => { ensured = null; });
    return ensured;
}

function runuserBin() { return ['/usr/sbin/runuser', '/sbin/runuser', '/usr/bin/runuser'].find(f => fs.existsSync(f)) || 'runuser'; }
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Shell text that runs cmd as the service account. Used inside a root pane shell, so tee and the log stay root's.
// env -i: the app starts with only its own variables (passed by name from the pane), never Porthole's environment.
export function wrapShell(cmd, envNames = []) {
    const pass = envNames.filter(n => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !['PATH', 'HOME'].includes(n)).map(n => `${n}="$${n}"`).join(' ');
    return `${runuserBin()} -u ${USER} -- env -i PATH=${q(PATH)} HOME=${q(HOME)} LANG=C.UTF-8 PORTHOLE_RUN_AS=service ${pass} bash -c ${q(`umask 002; ${cmd}`)}`;
}

// argv for execFile: run cmd as the service account (actions). The variables the action may see come after env -i
// through execFile's env, so they are added explicitly by the caller via extraEnv.
export function argv(cmd, extraEnv = {}) {
    return [runuserBin(), ['-u', USER, '--', 'env', '-i', 'LANG=C.UTF-8', `PATH=${PATH}`, `HOME=${HOME}`, 'PORTHOLE_RUN_AS=service', ...Object.entries(extraEnv).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !['PATH', 'HOME'].includes(k)).map(([k, v]) => `${k}=${v}`), 'bash', '-c', `umask 002; ${cmd}`]];
}
