// Network egress log: every new outbound connection made by the agent user and the service accounts (ps-<project>,
// porthole-svc), with the host name it looked up, the project and the shell or service it came from.
//
// How: an iptables chain (PORTHOLE-EGRESS, jumped to from OUTPUT) LOGs the first packet of each new connection from
// those accounts to the kernel log, with the owner's uid. Porthole follows the kernel log (journalctl -k -f) and the
// resolver (resolvectl monitor), so an address can be shown as the name that was looked up for it.
// Kept: per day, one row per (who, project, host, port) with a count, first and last time. The first time a project
// reaches a host it has not used in 90 days is also an audit line ("network"), which can raise an alert.
//
// Not covered: processes running as root (root shells, agents started as root, Porthole itself, apt), and lookups that
// bypass the box resolver (DNS over HTTPS): those connections show the address only.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { log } from './log.js';
import { record } from './audit.js';

const execFileP = promisify(execFile);
const dir = path.join(config.state, 'egress');
const seenFile = path.join(dir, 'seen.json');
const PREFIX = 'PH-EGRESS ';
const CHAIN = 'PORTHOLE-EGRESS';
const KEEP_DAYS = 90;
const dayOf = ts => new Date(ts).toISOString().slice(0, 10);
const sbin = b => ['/usr/sbin/' + b, '/sbin/' + b].find(p => fs.existsSync(p)) || b;

let status = { on: false, detail: 'Not started.' };
export const getStatus = () => status;

// ---------- names ----------

const ipNames = new Map();     // address → name looked up for it (latest wins)
function remember(ip, name) {
    ipNames.delete(ip); ipNames.set(ip, name);
    if (ipNames.size > 20000) ipNames.delete(ipNames.keys().next().value);
}
function ipFromBytes(a) {
    if (!Array.isArray(a)) return null;
    if (a.length === 4) return a.join('.');
    if (a.length === 16) {
        const parts = []; for (let i = 0; i < 16; i += 2) parts.push(((a[i] << 8) | a[i + 1]).toString(16));
        return parts.join(':').replace(/(^|:)0(:0)+(:|$)/, '::').replace(/:{3,}/, '::');
    }
    return null;
}
const canon6 = ip => ip.includes(':') ? ipFromBytes(expand6(ip)) : ip;
function expand6(ip) {
    const [h, t = ''] = ip.split('::');
    const a = h ? h.split(':') : [], b = t ? t.split(':') : [];
    const all = [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
    return all.flatMap(x => { const n = parseInt(x || '0', 16); return [n >> 8, n & 255]; });
}

// One line of `resolvectl monitor --json=short`.
export function ingestDns(line) {
    let j; try { j = JSON.parse(line); } catch { return 0; }
    const q = j?.question?.[0]?.name;
    if (!q) return 0;
    let n = 0;
    for (const a of j.answer || []) { const ip = ipFromBytes(a?.rr?.address); if (ip) { remember(ip, String(q).replace(/\.$/, '').toLowerCase()); n++; } }
    return n;
}

// ---------- who ----------

let users = { at: 0, byUid: new Map() };
function userOf(uid) {
    if (Date.now() - users.at > 60_000) {
        const m = new Map();
        try { for (const l of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) { const p = l.split(':'); if (p.length > 2) m.set(Number(p[2]), p[0]); } } catch { /* none */ }
        users = { at: Date.now(), byUid: m };
    }
    return users.byUid.get(Number(uid)) || `uid ${uid}`;
}

// The process behind a source port, while the connection is still open: its folder and its Porthole shell name.
let lookups = 0;
async function procOf(proto, sport) {
    if (lookups >= 8) return null;   // a burst of connections: count them, skip naming the process
    lookups++;
    try {
        const { stdout } = await execFileP(sbin('ss'), [proto === 'UDP' ? '-uanpH' : '-tanpH', `sport = :${sport}`], { timeout: 2000 });
        const pid = (stdout.match(/pid=(\d+)/) || [])[1];
        if (!pid) return null;
        const out = { pid: Number(pid) };
        try { out.cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* gone */ }
        try { out.comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { /* gone */ }
        try { const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0'); out.shell = (env.find(e => e.startsWith('PORTHOLE_SHELL_NAME=')) || '').slice(20) || null; } catch { /* gone */ }
        return out;
    } catch { return null; } finally { lookups--; }
}

const projectsDir = () => path.join(config.root, 'Projects');
function projectOf(cwd) {
    if (!cwd) return null;
    const rel = path.relative(projectsDir(), cwd);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep)[0] || null;
}

// ---------- aggregation ----------

let today = { day: null, rows: {} };
let dirty = false;
let seen = null;
function loadSeen() {
    if (seen) return seen;
    try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')); } catch { seen = {}; }
    return seen;
}
function dayFile(day) { return path.join(dir, `${day}.json`); }
function loadDay(day) { try { return JSON.parse(fs.readFileSync(dayFile(day), 'utf8')); } catch { return {}; } }

const KERNEL_RE = /PH-EGRESS .*?\bDST=(\S+).*?\bPROTO=(\w+)(?:.*?\bSPT=(\d+))?(?:.*?\bDPT=(\d+))?.*?\bUID=(\d+)/;

// One kernel log line. Returns the row it counted towards (tests use this).
export async function ingestKernel(line, at = Date.now()) {
    const m = KERNEL_RE.exec(String(line));
    if (!m) return null;
    const [, dstRaw, proto, sport, dport, uid] = m;
    const dst = canon6(dstRaw);
    const user = userOf(uid);
    // DNS to the box resolver is how names are found; it is not a destination.
    if (dport === '53' && (dst === '127.0.0.53' || dst === '127.0.0.54')) return null;
    const p = sport ? await procOf(proto, sport) : null;
    const project = projectOf(p?.cwd) || (user.startsWith('ps-') ? user.slice(3) : null);
    const who = p?.shell ? `shell "${p.shell}"` : user.startsWith('ps-') || user === 'porthole-svc' ? `service account ${user}` : user === 'agent' ? 'agent user' : user;
    const host = ipNames.get(dst) || dst;
    const port = dport ? Number(dport) : null;
    const day = dayOf(at);
    if (today.day !== day) { flush(); today = { day, rows: loadDay(day) }; }
    const key = [who, project || '', host, port || '', proto].join('|');
    const r = today.rows[key] || (today.rows[key] = { who, user, project, host, ip: dst, port, proto, count: 0, first: at, last: at, procs: [] });
    r.count++; r.last = at; r.ip = dst;
    if (p?.comm && !r.procs.includes(p.comm) && r.procs.length < 5) r.procs.push(p.comm);
    dirty = true;
    // First time this project (or account) reaches this host:port.
    const s = loadSeen();
    const sk = [project || user, host, port || ''].join('|');
    if (!s[sk] || at - s[sk] > KEEP_DAYS * 86400_000) {
        s[sk] = at;
        record('network', 'egress-new', { actor: who, project, cwd: p?.cwd, host, port: port ?? undefined, what: `${host}${port ? `:${port}` : ''} (${proto}${host !== dst ? `, ${dst}` : ''})${p?.comm ? ` · ${p.comm}` : ''}`, via: user });
        saveSeen();
    }
    return r;
}

function saveSeen() {
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const cutoff = Date.now() - KEEP_DAYS * 86400_000;
        for (const [k, v] of Object.entries(seen)) if (v < cutoff) delete seen[k];
        fs.writeFileSync(seenFile + '.tmp', JSON.stringify(seen), { mode: 0o600 }); fs.renameSync(seenFile + '.tmp', seenFile);
    } catch { /* best effort */ }
}

export function flush() {
    if (!dirty || !today.day) return;
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const f = dayFile(today.day);
        fs.writeFileSync(f + '.tmp', JSON.stringify(today.rows), { mode: 0o600 }); fs.renameSync(f + '.tmp', f);
        dirty = false;
        const cutoff = dayOf(Date.now() - KEEP_DAYS * 86400_000);
        for (const n of fs.readdirSync(dir)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(n) && n.slice(0, 10) < cutoff) fs.rmSync(path.join(dir, n), { force: true });
    } catch (e) { log('egress', `could not save: ${e.message}`); }
}

// Rows for the last `days` days, merged across days (newest first).
export function query({ days = 7, project = null } = {}) {
    flush();
    const span = Math.max(1, Math.min(Number(days) || 7, KEEP_DAYS));
    const merged = new Map();
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n) && n.slice(0, 10) >= dayOf(Date.now() - (span - 1) * 86400_000)); } catch { /* none */ }
    for (const n of names) for (const [k, r] of Object.entries(loadDay(n.slice(0, 10)))) {
        const m = merged.get(k);
        if (!m) merged.set(k, { ...r, procs: [...(r.procs || [])], days: 1 });
        else { m.count += r.count; m.first = Math.min(m.first, r.first); m.last = Math.max(m.last, r.last); m.days++; for (const p of r.procs || []) if (!m.procs.includes(p) && m.procs.length < 5) m.procs.push(p); }
    }
    let rows = [...merged.values()];
    if (project !== null) rows = rows.filter(r => (r.project || '') === project);
    rows.sort((a, b) => b.last - a.last);
    return { status, days: span, rows: rows.slice(0, 1000), total: rows.length };
}

// ---------- kernel side ----------

async function ipt(bin, args) { return execFileP(sbin(bin), ['-w', '5', ...args], { timeout: 10_000 }); }

export async function applyRules() {
    const owners = [];
    const has = n => { try { return fs.readFileSync('/etc/passwd', 'utf8').split('\n').some(l => l.startsWith(n + ':')); } catch { return false; } };
    const hasGroup = n => { try { return fs.readFileSync('/etc/group', 'utf8').split('\n').some(l => l.startsWith(n + ':')); } catch { return false; } };
    if (has(process.env.PORTHOLE_AGENT_USER || 'agent')) owners.push(['--uid-owner', process.env.PORTHOLE_AGENT_USER || 'agent']);
    if (has('porthole-svc')) owners.push(['--uid-owner', 'porthole-svc']);
    if (hasGroup('porthole-svcs')) owners.push(['--gid-owner', 'porthole-svcs']);
    if (!owners.length) throw new Error('no agent user or service accounts on this box yet');
    for (const bin of ['iptables', 'ip6tables']) {
        try { await ipt(bin, ['-N', CHAIN]); } catch { /* exists */ }
        await ipt(bin, ['-F', CHAIN]);
        await ipt(bin, ['-A', CHAIN, '-o', 'lo', '-j', 'RETURN']);
        await ipt(bin, ['-A', CHAIN, '-m', 'conntrack', '!', '--ctstate', 'NEW', '-j', 'RETURN']);
        for (const o of owners) await ipt(bin, ['-A', CHAIN, '-m', 'owner', ...o, '-m', 'limit', '--limit', '50/second', '--limit-burst', '200', '-j', 'LOG', '--log-prefix', PREFIX, '--log-uid', '--log-level', '6']);
        try { await ipt(bin, ['-C', 'OUTPUT', '-j', CHAIN]); } catch { await ipt(bin, ['-I', 'OUTPUT', '1', '-j', CHAIN]); }
    }
    return owners.length;
}

const children = [];
function follow(cmd, args, onLine, name) {
    let stopped = false;
    const startOne = () => {
        if (stopped) return;
        const ch = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        children.push(ch);
        let buf = '';
        ch.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { onLine(l); } catch { /* one bad line */ } } if (buf.length > 65536) buf = ''; });
        ch.on('exit', code => { log('egress', `${name} exited (${code}); restarting in 10 s`); setTimeout(startOne, 10_000).unref(); });
        ch.on('error', () => { /* exit handler restarts */ });
    };
    startOne();
    return () => { stopped = true; };
}

const which = b => ['/usr/bin/' + b, '/bin/' + b, '/usr/sbin/' + b].find(p => fs.existsSync(p)) || null;

export async function start() {
    if (process.env.PORTHOLE_EGRESS === '0') { status = { on: false, detail: 'Turned off (PORTHOLE_EGRESS=0).' }; return status; }
    const journalctl = which('journalctl'), resolvectl = which('resolvectl');
    if (!journalctl) { status = { on: false, detail: 'This box has no journald, so the kernel log cannot be followed.' }; return status; }
    try { const n = await applyRules(); status = { on: true, detail: `Logging new connections from ${n} account${n === 1 ? '' : 's'} (agent user and service accounts). Root processes are not logged.` }; }
    catch (e) { status = { on: false, detail: `Could not add the firewall logging rules: ${String(e.stderr || e.message).trim().split('\n')[0]}` }; log('egress', status.detail); return status; }
    follow(journalctl, ['-k', '-f', '-n', '0', '-o', 'cat'], l => { if (l.includes(PREFIX)) ingestKernel(l).catch(() => {}); }, 'journalctl');
    if (resolvectl) follow(resolvectl, ['monitor', '--json=short'], ingestDns, 'resolvectl monitor');
    else status.detail += ' No resolvectl: addresses are shown without names.';
    setInterval(flush, 60_000).unref();
    // New service accounts appear when a project's live service first starts: pick them up.
    setInterval(() => applyRules().catch(() => {}), 10 * 60_000).unref();
    log('egress', status.detail);
    return status;
}
export function stop() { flush(); for (const c of children) { try { c.kill(); } catch { /* gone */ } } }
