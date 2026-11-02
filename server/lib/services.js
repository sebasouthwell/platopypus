// Registered servers: long-running processes the user (or an agent) wants to see and control as a thing of their
// own — not just "something is listening on :8000". A server is either started by Porthole in its own tmux session
// (`svc run`) so it can be stopped, restarted and its log read, or an existing process registered by pid/port
// (`svc add`) so it can at least be stopped cleanly. Stopping kills the whole process group, then closes any tunnel
// on its port. Records live in state/services.json; logs in state/services/<slug>.log.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { tmux, hasSession, newSession, killSession } from './tmux.js';
import * as tunnels from './tunnels.js';
import { log } from './log.js';

const run = promisify(execFile);
const file = path.join(config.state, 'services.json');
const logDir = path.join(config.state, 'services');
export const SESSION_PREFIX = 'svc-';

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { items: {} }; } }
function save(db) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }

export function slugify(name) {
    const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!s) throw httpError(400, 'Give the server a name.');
    return s;
}

function pidAlive(pid) {
    if (!pid) return false;
    try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return !/\) Z /.test(st); } catch { return false; }
}
function pgidOf(pid) {
    try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[2]) || null; } catch { return null; }
}
function cmdlineOf(pid) {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 200); } catch { return ''; }
}
// Every descendant of pid (children first order does not matter for signalling).
function descendants(pid) {
    const out = []; const queue = [pid];
    let byParent = null;
    try {
        byParent = new Map();
        for (const d of fs.readdirSync('/proc')) {
            if (!/^\d+$/.test(d)) continue;
            try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); if (!byParent.has(ppid)) byParent.set(ppid, []); byParent.get(ppid).push(Number(d)); } catch { /* raced */ }
        }
    } catch { return out; }
    while (queue.length) { const p = queue.shift(); for (const c of byParent.get(p) || []) { out.push(c); queue.push(c); } }
    return out;
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Terminate a process and everything under it: TERM the group (or the tree), wait, then KILL what is left.
async function killTree(pid, { group = true } = {}) {
    if (!pidAlive(pid)) return;
    const pgid = group ? pgidOf(pid) : null;
    const targets = pgid && pgid > 1 ? [-pgid] : [pid, ...descendants(pid)];
    const signal = sig => { for (const t of targets) { try { process.kill(t, sig); } catch { /* gone */ } } };
    signal('SIGTERM');
    for (let i = 0; i < 25 && pidAlive(pid); i++) await sleep(200);
    if (pidAlive(pid)) { signal('SIGKILL'); await sleep(300); }
}

// Which pid listens on a local port (so `svc add --port 8000` works without a pid).
async function pidOnPort(port) {
    try {
        const { stdout } = await run('ss', ['-ltnpH']);
        for (const line of stdout.split('\n')) {
            if (!new RegExp(`:${port}\\s`).test(line)) continue;
            const m = line.match(/pid=(\d+)/); if (m) return Number(m[1]);
        }
    } catch { /* no ss */ }
    return null;
}

export async function list() {
    const db = load();
    const items = Object.values(db.items);
    if (!items.length) return [];
    const [ports, tl] = await Promise.all([tunnels.listeningPorts().catch(() => []), tunnels.list().catch(() => [])]);
    const out = [];
    for (const it of items) {
        const alive = it.session ? await hasSession(it.session) && pidAlive(it.pid) : pidAlive(it.pid);
        const listening = it.port ? ports.some(p => p.port === it.port) : null;
        const t = it.port ? tl.find(x => x.port === it.port) : null;
        out.push({ ...it, alive, listening, tunnel: t ? { url: t.url, kind: t.kind || 'quick' } : null, canStart: Array.isArray(it.cmd) && it.cmd.length > 0 });
    }
    return out.sort((a, b) => (b.alive - a.alive) || (b.created - a.created));
}

export async function get(slug) {
    const it = load().items[slug];
    if (!it) throw httpError(404, 'No such server.');
    return it;
}

// Start a command in its own tmux session and register it.
export async function runServer({ name, port, cwd, cmd, project = null }) {
    const slug = slugify(name);
    if (!Array.isArray(cmd) || !cmd.length || cmd.some(c => typeof c !== 'string')) throw httpError(400, 'Command is required.');
    const p = port === undefined || port === null || port === '' ? null : tunnels.validPort(port);
    if (port && !p) throw httpError(400, 'Port must be between 1 and 65535.');
    if (p === config.port) throw httpError(403, 'That is Porthole\'s own port.');
    const dir = cwd && fs.existsSync(cwd) ? cwd : config.home;
    const session = SESSION_PREFIX + slug;
    const db = load();
    if (db.items[slug] && (await hasSession(session))) throw httpError(409, `"${name}" is already running. Stop it first.`);
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logFile = path.join(logDir, `${slug}.log`);
    const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
    // The pane shell is the process-group leader; the command and tee hang off it, so TERM -pgid takes everything.
    const shellCmd = `cd ${q(dir)} && (${cmd.map(q).join(' ')}) 2>&1 | tee -a ${q(logFile)}; echo "[svc] exited $?" | tee -a ${q(logFile)}; sleep 1`;
    await newSession(session, dir, shellCmd, { PORTHOLE_SERVICE: slug });
    let pid = null;
    try { pid = Number((await tmux('display-message', '-p', '-t', `${session}:`, '#{pane_pid}')).trim()) || null; } catch { /* no pane yet */ }
    db.items[slug] = { slug, name: String(name).slice(0, 60), port: p, cwd: dir, cmd, pid, session, project, created: Date.now(), stoppedAt: null, log: logFile, external: false };
    save(db);
    log('svc', `started "${slug}" (${cmd.join(' ')}) in ${dir}${p ? ` on :${p}` : ''}`);
    return (await list()).find(s => s.slug === slug);
}

// Register a process that is already running (started by an agent in its shell, for example).
export async function add({ name, pid, port, cwd, project = null }) {
    const slug = slugify(name);
    const p = port === undefined || port === null || port === '' ? null : tunnels.validPort(port);
    if (port && !p) throw httpError(400, 'Port must be between 1 and 65535.');
    if (p === config.port) throw httpError(403, 'That is Porthole\'s own port.');
    let id = Number(pid) || null;
    if (!id && p) id = await pidOnPort(p);
    if (!id) throw httpError(400, 'Give --pid, or a --port something is already listening on.');
    if (!pidAlive(id)) throw httpError(404, `No process with pid ${id}.`);
    if (id === process.pid) throw httpError(403, 'That is Porthole itself.');
    const db = load();
    db.items[slug] = { slug, name: String(name).slice(0, 60), port: p, cwd: cwd || null, cmd: null, pid: id, session: null, project, created: Date.now(), stoppedAt: null, log: null, external: true, cmdline: cmdlineOf(id) };
    save(db);
    log('svc', `registered "${slug}" pid ${id}${p ? ` on :${p}` : ''}`);
    return (await list()).find(s => s.slug === slug);
}

// Complete shutdown: process group (or tree), tmux session, tunnel on its port.
export async function stop(slug) {
    const db = load();
    const it = db.items[slug];
    if (!it) throw httpError(404, 'No such server.');
    if (it.pid) await killTree(it.pid, { group: !!it.session });
    if (it.session && (await hasSession(it.session))) await killSession(it.session).catch(() => {});
    if (it.port) { try { await tunnels.close(it.port); } catch { /* no tunnel */ } }
    it.stoppedAt = Date.now();
    save(db);
    log('svc', `stopped "${slug}"`);
    return (await list()).find(s => s.slug === slug);
}

export async function start(slug) {
    const it = await get(slug);
    if (!Array.isArray(it.cmd) || !it.cmd.length) throw httpError(400, 'This server was registered from a running process; Porthole does not know how to start it.');
    return runServer({ name: it.name, port: it.port, cwd: it.cwd, cmd: it.cmd, project: it.project });
}

export async function remove(slug) {
    if (!load().items[slug]) throw httpError(404, 'No such server.');
    await stop(slug).catch(() => {});
    const db = load();
    const it = db.items[slug];
    delete db.items[slug];
    save(db);
    if (it?.log) { try { fs.rmSync(it.log, { force: true }); } catch { /* ignore */ } }
    log('svc', `removed "${slug}"`);
}

export function logs(slug, tail = 200) {
    const it = load().items[slug];
    if (!it) throw httpError(404, 'No such server.');
    if (!it.log) return '';
    try {
        const lines = fs.readFileSync(it.log, 'utf8').split('\n');
        return lines.slice(-Math.min(Number(tail) || 200, 5000)).join('\n');
    } catch { return ''; }
}

// Ports owned by registered servers (so they are not listed again as anonymous dev servers).
export function registeredPorts() {
    return new Set(Object.values(load().items).map(i => i.port).filter(Boolean));
}
