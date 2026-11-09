// Cloudflare quick tunnels. Each tunnel is a tmux session named tunnel-<port> running cloudflared
// with its output logged to state/tunnels/<port>.log, so tunnels survive a PlatOpypus restart and can
// be created from a shell too (bin/tunnel). The public URL is parsed from the log.
//
// Security: a quick tunnel is a public, unauthenticated URL. It is random enough not to be guessed,
// but anything on that port is reachable by whoever has the link. Tunnels auto-expire, and the
// PlatOpypus port itself can never be tunnelled.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { listSessions, hasSession, newSession, killSession } from './tmux.js';
import * as dockerMgr from './docker.js';
import * as zoned from './zoned.js';
import { log } from './log.js';

const run = promisify(execFile);
const dir = path.join(config.state, 'tunnels');
const metaFile = path.join(dir, 'tunnels.json');
let meta = {};
try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* first run */ }

function persist() {
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), { mode: 0o600 });
}

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function readUrl(port) {
    try {
        const text = fs.readFileSync(path.join(dir, `${port}.log`), 'utf8');
        const m = text.match(URL_RE);
        return m ? m[0] : null;
    } catch {
        return null;
    }
}

export function validPort(port) {
    const n = Number(port);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export async function list() {
    const live = await listSessions();
    const out = [];
    for (const s of live) {
        if (!s.name.startsWith('tunnel-')) continue;
        const port = Number(s.name.slice('tunnel-'.length));
        const m = meta[port] || {};
        out.push({
            port,
            name: m.name || `Port ${port}`,
            // A tunnel on the user's own domain reports that hostname, never a trycloudflare address.
            url: m.publicUrl || readUrl(port),
            kind: m.publicUrl ? 'zoned' : 'quick',
            created: m.created || s.created,
            expires: m.expires || null,
            owner: m.owner || null,
            origin: m.origin || '127.0.0.1',
        });
    }
    // Hostnames on the user's own domain (zoned.js) are tunnels too, just permanent ones.
    for (const z of await zoned.list().catch(() => [])) out.push(z);
    out.sort((a, b) => b.created - a.created);
    return out;
}

// Container ports are published by the Docker daemon, which may not share this process's loopback.
async function originHostFor(port) {
    if (config.dockerHost === '127.0.0.1') return '127.0.0.1';
    try {
        const containers = await dockerMgr.containers();
        if (containers.some(c => c.ports.some(pp => pp.host === port))) return config.dockerHost;
    } catch { /* docker down */ }
    return '127.0.0.1';
}

export async function create({ port, name = '', ttlMinutes, host }) {
    const p = validPort(port);
    if (!p) throw httpError(400, 'Port must be between 1 and 65535.');
    if (p === config.port) throw httpError(403, 'PlatOpypus itself cannot be exposed through a tunnel.');
    if (await hasSession(`tunnel-${p}`)) throw httpError(409, `Port ${p} already has a tunnel.`);
    if (host !== undefined && !/^[A-Za-z0-9.-]{1,253}$/.test(String(host))) throw httpError(400, 'Bad origin host.');
    const origin = host || await originHostFor(p);
    const label = String(name || '').slice(0, 60).replace(/[\r\n\t]/g, ' ').trim();
    const ttl = Number.isFinite(Number(ttlMinutes)) && Number(ttlMinutes) > 0 ? Number(ttlMinutes) : config.tunnelTtlMinutes;

    const logFile = path.join(dir, `${p}.log`);
    await fsp.rm(logFile, { force: true });
    // Pipe through tee so the session shows the log live and we can parse the URL from the file.
    const cmd = `cloudflared tunnel --no-autoupdate --url http://${origin}:${p} 2>&1 | tee ${shellQuote(logFile)}`;
    await newSession(`tunnel-${p}`, config.home, cmd);
    const owner = await ownerOf(p, origin);
    meta[p] = { name: label, created: Date.now(), expires: Date.now() + ttl * 60_000, origin, owner, misses: 0 };
    persist();
    log('tunnel', `opened tunnel for port ${p} via ${origin} (${label || 'unnamed'}) attached to ${owner || 'nothing yet'}, ttl ${ttl}m`);

    // Wait for the URL (cloudflared usually prints it within a few seconds).
    const deadline = Date.now() + 25_000;
    let url = null;
    while (!url && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500));
        url = readUrl(p);
        if (!url && !(await hasSession(`tunnel-${p}`))) {
            const tail = safeTail(logFile);
            delete meta[p]; persist();
            throw httpError(502, `cloudflared exited before publishing a URL. ${tail}`);
        }
    }
    if (url) log('tunnel', `port ${p} -> ${url}`);
    return { port: p, name: label, url, created: meta[p].created, expires: meta[p].expires };
}

export async function close(port) {
    const p = validPort(port);
    if (!p) throw httpError(400, 'Bad port.');
    if (!(await hasSession(`tunnel-${p}`))) {
        const z = zoned.byPort(p);
        if (z) return zoned.remove(z.slug);
        throw httpError(404, 'No tunnel on that port.');
    }
    await killSession(`tunnel-${p}`);
    delete meta[p];
    persist();
    log('tunnel', `closed tunnel for port ${p}`);
}

export async function extend(port, minutes = 240) {
    const p = validPort(port);
    if (!p || !meta[p]) throw httpError(404, 'No tunnel on that port.');
    meta[p].expires = Date.now() + Number(minutes) * 60_000;
    persist();
    return meta[p];
}

// What is behind a port right now: a local listener ("python", "node"…) or a container ("container app-x").
async function ownerOf(port, origin) {
    if (origin && origin !== '127.0.0.1') {
        try { const c = (await dockerMgr.containers()).find(x => x.ports.some(pp => pp.host === port)); return c ? `container ${c.name}` : null; } catch { return null; }
    }
    const local = (await listeningPorts()).find(x => x.port === port);
    if (local) return local.process || 'local process';
    try { const c = (await dockerMgr.containers()).find(x => x.ports.some(pp => pp.host === port)); return c ? `container ${c.name}` : null; } catch { return null; }
}

const GRACE_MS = 60_000;   // slow starters (image pulls, first boot) are not judged in their first minute
const MISSES_TO_CLOSE = 2; // two consecutive empty checks (~20 s) → the process is gone

// Close tunnels whose time is up or whose target process has disappeared. Runs every 10 s.
export async function sweep() {
    const now = Date.now();
    const current = await list();
    if (!current.length) return;
    let localPorts = null, containerPorts = null;
    const have = async (t) => {
        if (t.origin !== '127.0.0.1') { containerPorts ??= new Set((await dockerMgr.containers().catch(() => [])).filter(c => c.state === 'running').flatMap(c => c.ports.map(p => p.host))); return containerPorts.has(t.port); }
        localPorts ??= new Set((await listeningPorts()).map(p => p.port));
        if (localPorts.has(t.port)) return true;
        containerPorts ??= new Set((await dockerMgr.containers().catch(() => [])).filter(c => c.state === 'running').flatMap(c => c.ports.map(p => p.host)));
        return containerPorts.has(t.port);
    };
    for (const t of current) {
        if (t.kind === 'zoned') continue; // permanent until removed
        if (t.expires && t.expires < now) { log('tunnel', `port ${t.port} expired`); await close(t.port).catch(() => {}); continue; }
        if (now - t.created < GRACE_MS) continue;
        const m = meta[t.port]; if (!m) continue;
        if (await have(t)) { if (m.misses) { m.misses = 0; persist(); } if (!m.owner) { m.owner = await ownerOf(t.port, t.origin); persist(); } continue; }
        m.misses = (m.misses || 0) + 1;
        persist();
        if (m.misses >= MISSES_TO_CLOSE) {
            log('tunnel', `port ${t.port}: ${m.owner || 'target'} is gone — closing tunnel`);
            await close(t.port).catch(() => {});
        }
    }
}

// Processes that belong to the box or to PlatOpypus/agents rather than to the user's projects. They are listed under
// "System" with no share button: tunnelling an agent's local callback port or code-server makes no sense.
const SYSTEM_PROCS = /^(sshd|systemd|systemd-resolve|systemd-resolved|nginx|tailscaled|cloudflared|docker-proxy|dockerd|containerd|code-server|snapd|chronyd|rpcbind|cupsd|avahi-daemon|exim4|postfix|master)$/;
const SYSTEM_CMD = /(^|\/)(claude|codex|agy|antigravity|gemini|code-server|cloudflared|tailscaled)(\s|$)|\/opt\/porthole\/|\.claude\/|\.codex\/|\.gemini\/|\.antigravity\/|\.agent-profiles\//;
function cmdlineOf(pid) { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 200); } catch { return ''; } }

// Ports something is listening on locally, so the UI can offer "open a tunnel" for each.
export async function listeningPorts() {
    let out = '';
    try {
        ({ stdout: out } = await run('ss', ['-ltnpH']));
    } catch {
        return [];
    }
    const seen = new Map();
    for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const cols = line.trim().split(/\s+/);
        const local = cols[3] || '';
        const m = local.match(/:(\d+)$/);
        if (!m) continue;
        const port = Number(m[1]);
        if (port === config.port) continue;
        const proc = (line.match(/users:\(\("([^"]+)"/) || [])[1] || '';
        const pid = Number((line.match(/pid=(\d+)/) || [])[1]) || null;
        const addr = local.replace(/:\d+$/, '');
        if (addr === '127.0.0.11') continue; // Docker's embedded DNS inside a container
        if (seen.has(port)) continue;
        const cmd = pid ? cmdlineOf(pid) : '';
        const system = SYSTEM_PROCS.test(proc) || SYSTEM_CMD.test(cmd) || pid === process.pid || port === 22;   // 22: ssh, also when systemd holds the socket
        seen.set(port, { port, process: proc, addr, pid, cmd, system });
    }
    return [...seen.values()].sort((a, b) => a.port - b.port);
}

function shellQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function safeTail(file) {
    try {
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
        return lines.slice(-3).join(' | ').slice(0, 300);
    } catch {
        return '';
    }
}
