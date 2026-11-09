// The accounts live services and their actions run as: one per project, `ps-<project>`. Each has no login shell,
// no sudo, no logins or keys, its own home for caches, and the primary group porthole-svcs (used only to match
// firewall rules; no file is shared through it). It reaches exactly one folder — its project — through a POSIX ACL;
// it is not in porthole-dev, and projects carry no permissions for "other", so one compromised app cannot read
// another project, the agent's home or PlatOpypus's state. The firewall refuses these accounts the EC2 metadata
// service (the box's AWS role) and PlatOpypus's own API. PlatOpypus (root) stays the controller: it starts the process,
// owns the log, and stops or kills the whole process group.

import fs from 'node:fs';
import { lockSnapshot } from './prototype.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { log } from './log.js';

const run = promisify(execFile);
export const GROUP = 'porthole-svcs';
export const HOME_ROOT = '/var/lib/porthole-svc';
const DEV_GROUP = 'porthole-dev';
const PATH = '/usr/local/bin:/usr/bin:/bin';

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// ps-<project>, at most 32 characters; long names keep a hash so two projects never share an account.
export function userFor(project) {
    const slug = String(project || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
    if (slug.length <= 29) return `ps-${slug}`;
    return `ps-${slug.slice(0, 22)}-${crypto.createHash('sha256').update(slug).digest('hex').slice(0, 6)}`;
}

function passwdLine(user) {
    try { return fs.readFileSync('/etc/passwd', 'utf8').split('\n').find(l => l.startsWith(user + ':')) || null; } catch { return null; }
}
export function info(user) {
    const line = passwdLine(user); if (!line) return null;
    const [, , uid, gid, , home] = line.split(':');
    return { user, uid: Number(uid), gid: Number(gid), home };
}

// sbin tools by absolute path: PlatOpypus's service PATH may not include sbin.
const sbin = name => ['/usr/sbin/', '/sbin/', '/usr/bin/', '/bin/'].map(d => d + name).find(f => fs.existsSync(f)) || name;
const have = async bin => { try { await run('sh', ['-c', `command -v ${bin}`]); return true; } catch { return false; } };

// ---- firewall: no metadata service, no PlatOpypus API for any service account ----
let firewall = { ok: null, detail: 'not applied yet' };
export function firewallState() { return firewall; }
export async function applyFirewall() {
    const rules = [
        ['iptables', ['-d', '169.254.169.254']],                               // EC2 metadata (instance role keys)
        ['iptables', ['-d', '127.0.0.1', '-p', 'tcp', '--dport', String(config.port)]], // PlatOpypus's API
        ['ip6tables', ['-d', 'fd00:ec2::254']],                                // EC2 metadata over IPv6
        ['ip6tables', ['-d', '::1', '-p', 'tcp', '--dport', String(config.port)]],
    ];
    const done = [], failed = [];
    for (const [bin, match] of rules) {
        const spec = ['OUTPUT', ...match, '-m', 'owner', '--gid-owner', GROUP, '-j', 'REJECT'];
        try {
            try { await run(sbin(bin), ['-w', '5', '-C', ...spec]); } catch { await run(sbin(bin), ['-w', '5', '-I', ...spec]); }
            done.push(`${bin} ${match.join(' ')}`);
        } catch (e) { failed.push(`${bin}: ${String(e.stderr || e.message).trim().split('\n')[0]}`); }
    }
    firewall = failed.length ? { ok: false, detail: `Could not add ${failed.length} of ${rules.length} firewall rules (${failed[0]}). Service accounts may reach the metadata service or PlatOpypus's API.` } : { ok: true, detail: 'Service accounts cannot reach the EC2 metadata service or PlatOpypus\'s API.' };
    if (failed.length) log('svcuser', firewall.detail); else log('svcuser', `firewall: ${done.length} rules for ${GROUP}`);
    return firewall;
}

// ---- accounts and folder access ----
async function ensureGroup() {
    await run('sh', ['-c', `getent group ${GROUP} >/dev/null || ${sbin('groupadd')} --system ${GROUP}`]);
}

const locks = new Map();
// Create the project's account if needed and give it (only) that project folder. Idempotent; cheap when done.
export async function ensure(project, root) {
    const user = userFor(project);
    if (locks.has(user)) return locks.get(user);
    const p = (async () => {
        if (!fs.existsSync(sbin('setfacl')) && !(await have('setfacl'))) throw httpError(500, 'Live services need the acl tools (apt-get install acl); re-run the installer.');
        await ensureGroup();
        const home = path.join(HOME_ROOT, user.slice(3));
        if (!info(user)) {
            fs.mkdirSync(HOME_ROOT, { recursive: true, mode: 0o755 });
            await run(sbin('useradd'), ['--system', '--home-dir', home, '--create-home', '--shell', '/usr/sbin/nologin', '--gid', GROUP, user]);
            log('svcuser', `created ${user} for ${project}`);
        }
        const a = info(user);
        try { fs.chmodSync(a.home, 0o700); fs.chownSync(a.home, a.uid, a.gid); } catch { /* home elsewhere */ }
        if (root) await grantFolder(user, root);
        lockProjects();
        if (firewall.ok === null) await applyFirewall();
        return a;
    })().finally(() => locks.delete(user));
    locks.set(user, p);
    return p;
}

// ACL for this one account (now and, through default entries, for files created later), and nothing for "other".
// Default ACLs also override the creating process's umask, so files that root shells add later stay private too.
export async function grantFolder(user, root) {
    const marker = path.join(root, '.porthole', 'acl.json');
    const want = { user, v: 1 };
    try { const had = JSON.parse(fs.readFileSync(marker, 'utf8')); if (had.user === want.user && had.v === want.v && fs.statSync(root).mode % 8 === 0) return false; } catch { /* first time */ }
    const spec = `u:${user}:rwX,g:${DEV_GROUP}:rwX,o::---`;
    await run(sbin('setfacl'), ['-R', '-m', spec, root], { timeout: 180_000 });
    await run('sh', ['-c', `find "$1" -type d -exec ${sbin('setfacl')} -d -m "$2" {} +`, 'sh', root, `${spec},u::rwX,g::rwX`], { timeout: 180_000 });
    await run('chmod', ['-R', 'o-rwx', root], { timeout: 180_000 });
    try { fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, JSON.stringify({ ...want, at: Date.now() })); } catch { /* read-only project */ }
    await lockSnapshot(root).catch(() => {});
    log('svcuser', `${user} can use ${root} (ACL); other accounts cannot`);
    return true;
}

// Every project folder closed to "other": a service account can enter only the project its ACL names. Only the
// top-level folders change (enough to stop traversal); agent and root shells reach them as owner or porthole-dev.
export function lockProjects() {
    const dir = path.join(config.root, 'Projects');
    let n = 0;
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const p = path.join(dir, e.name);
            try { const m = fs.statSync(p).mode; if (m & 0o007) { fs.chmodSync(p, m & 0o7770); n++; } } catch { /* raced */ }
        }
    } catch { /* no projects */ }
    if (n) log('svcuser', `closed ${n} project folder${n === 1 ? '' : 's'} to other accounts`);
    return n;
}

// Retire the 1.14.0 shared account: no group membership, so it reaches nothing even if something still runs as it.
export async function retireShared() {
    if (!passwdLine('porthole-svc')) return;
    try { await run(sbin('gpasswd'), ['-d', 'porthole-svc', DEV_GROUP]); log('svcuser', 'removed the shared porthole-svc account from porthole-dev'); } catch { /* not a member */ }
}

function runuserBin() { return ['/usr/sbin/runuser', '/sbin/runuser', '/usr/bin/runuser'].find(f => fs.existsSync(f)) || 'runuser'; }
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const okName = n => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !['PATH', 'HOME'].includes(n);

// Shell text that runs cmd as the account. Used inside a root pane shell, so tee and the log stay root's.
// env -i: the app starts with only its own variables (passed by name from the pane), never PlatOpypus's environment.
export function wrapShell(user, cmd, envNames = []) {
    const a = info(user); if (!a) throw httpError(500, `No account ${user}.`);
    const pass = envNames.filter(okName).map(n => `${n}="$${n}"`).join(' ');
    return `${runuserBin()} -u ${user} -- env -i PATH=${q(PATH)} HOME=${q(a.home)} LANG=C.UTF-8 PORTHOLE_RUN_AS=service ${pass} bash -c ${q(`umask 007; ${cmd}`)}`;
}

// argv for execFile: run cmd as the account (actions), with exactly the variables in extraEnv.
export function argv(user, cmd, extraEnv = {}) {
    const a = info(user); if (!a) throw httpError(500, `No account ${user}.`);
    return [runuserBin(), ['-u', user, '--', 'env', '-i', 'LANG=C.UTF-8', `PATH=${PATH}`, `HOME=${a.home}`, 'PORTHOLE_RUN_AS=service', ...Object.entries(extraEnv).filter(([k]) => okName(k)).map(([k, v]) => `${k}=${v}`), 'bash', '-c', `umask 007; ${cmd}`]];
}
