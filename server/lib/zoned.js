// "Share on your domain": a named Cloudflare Tunnel with a hostname in the user's own zone (parle.example.com),
// instead of a random trycloudflare address. Everything is created through the Cloudflare API with the token
// from the Vault (service "Cloudflare": Zone.DNS edit + Account.Cloudflare Tunnel edit + Zone read):
//
//   1. find the zone for the hostname (walk up the labels until a zone matches)
//   2. create a tunnel `porthole-<slug>` (config managed in Cloudflare), fetch its run token
//   3. ingress: hostname → nginx on loopback (a server block for that hostname proxies to the port), or straight to
//      the port when the box has no nginx
//   4. CNAME hostname → <tunnel>.cfargotunnel.com (proxied)
//   5. run `cloudflared tunnel run` in a tmux session (token via TUNNEL_TOKEN, not on the command line)
//
// Remove undoes all of it — DNS record, tunnel, nginx block — so the hostname is as if it never existed. Records live
// in state/zoned.json with the run token encrypted by the vault key, so sessions can be restarted after a reboot.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { hasSession, newSession, killSession } from './tmux.js';
import { encrypt, decrypt, envForSync } from './vault.js';
import * as dockerMgr from './docker.js';
import { log } from './log.js';

const run = promisify(execFile);
const file = path.join(config.state, 'zoned.json');
const logDir = path.join(config.state, 'zoned');
const CF = 'https://api.cloudflare.com/client/v4';
const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const SESSION_PREFIX = 'zoned-';

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { items: {} }; } }
function save(db) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }
const slugify = h => String(h).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

// ---- Cloudflare token / apex suggestion ----
function cfToken() {
    const env = envForSync(config.home);
    return env.CLOUDFLARE_TOKEN || env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || null;
}
export function apexSuggestion() {
    const d = (process.env.PORTHOLE_DOMAIN || '').toLowerCase();
    const parts = d.split('.').filter(Boolean);
    return parts.length >= 3 ? parts.slice(1).join('.') : (parts.length === 2 ? d : null);
}
export async function prereq() {
    const token = cfToken();
    const nginx = await nginxAvailable();
    return {
        ready: !!token,
        apex: apexSuggestion(),
        via: nginx ? 'nginx' : 'direct',
        reason: token ? null : 'Add a Cloudflare API token in the Vault (service "Cloudflare") with Zone → DNS: Edit, Zone → Zone: Read and Account → Cloudflare Tunnel: Edit for your domain.',
    };
}

async function cf(token, method, p, body) {
    const res = await fetch(CF + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
        const msg = (data.errors || []).map(e => e.message).join('; ') || `HTTP ${res.status}`;
        throw httpError(res.status === 403 ? 403 : 502, `Cloudflare: ${msg}`);
    }
    return data.result;
}

async function findZone(token, hostname) {
    const labels = hostname.split('.');
    for (let i = 1; i < labels.length - 1; i++) {
        const name = labels.slice(i).join('.');
        const zones = await cf(token, 'GET', `/zones?name=${encodeURIComponent(name)}&status=active`);
        if (zones.length) return { id: zones[0].id, name, accountId: zones[0].account?.id };
    }
    throw httpError(404, `No Cloudflare zone for ${hostname} is visible to this token.`);
}

// ---- nginx ----
async function nginxAvailable() {
    if (!fs.existsSync('/etc/nginx/sites-enabled')) return false;
    try { await run('systemctl', ['is-active', '--quiet', 'nginx']); return true; } catch { return false; }
}
function nginxBlock(hostname, port) {
    return `# Porthole zoned share: ${hostname} → 127.0.0.1:${port}. Created and removed by Porthole; do not edit.
server {
    listen 127.0.0.1:80;
    server_name ${hostname};
    if ($host != "${hostname}") { return 444; }
    client_max_body_size 600m;
    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_request_buffering off;
        proxy_buffering off;
    }
}
`;
}
async function nginxWrite(slug, hostname, port) {
    const avail = `/etc/nginx/sites-available/porthole-zoned-${slug}`;
    fs.writeFileSync(avail, nginxBlock(hostname, port), { mode: 0o644 });
    try { fs.symlinkSync(avail, `/etc/nginx/sites-enabled/porthole-zoned-${slug}`); } catch { /* exists */ }
    try { await run('nginx', ['-t']); } catch (e) { nginxRemove(slug); throw httpError(500, `nginx rejected the config: ${String(e.stderr || e.message).slice(0, 300)}`); }
    await run('systemctl', ['reload', 'nginx']);
}
function nginxRemove(slug) {
    for (const f of [`/etc/nginx/sites-enabled/porthole-zoned-${slug}`, `/etc/nginx/sites-available/porthole-zoned-${slug}`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
}

// ---- cloudflared session ----
async function startSession(it, token) {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logFile = path.join(logDir, `${it.slug}.log`);
    const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
    await newSession(SESSION_PREFIX + it.slug, config.home, `cloudflared tunnel --no-autoupdate run 2>&1 | tee -a ${q(logFile)}`, { TUNNEL_TOKEN: token });
}
function connected(slug) {
    try { const t = fs.readFileSync(path.join(logDir, `${slug}.log`), 'utf8'); return /Registered tunnel connection/.test(t.slice(-20000)); } catch { return false; }
}

// ---- public API ----
export async function list() {
    const db = load();
    const out = [];
    for (const it of Object.values(db.items)) {
        const alive = await hasSession(SESSION_PREFIX + it.slug);
        out.push({ slug: it.slug, hostname: it.hostname, port: it.port, name: it.name || it.hostname, url: `https://${it.hostname}`, kind: 'zoned', created: it.created, expires: null, origin: it.origin, owner: it.owner || null, via: it.via, alive, connected: alive && connected(it.slug) });
    }
    return out.sort((a, b) => b.created - a.created);
}

export async function create({ port, hostname, name = '' }) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw httpError(400, 'Port must be between 1 and 65535.');
    if (p === config.port) throw httpError(403, 'Porthole itself cannot be exposed this way.');
    const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
    if (!HOST_RE.test(host)) throw httpError(400, 'Hostname must be a full name in your domain, like app.example.com.');
    if (host === (process.env.PORTHOLE_DOMAIN || '').toLowerCase()) throw httpError(403, 'That is the Porthole hostname.');
    const token = cfToken();
    if (!token) throw httpError(412, (await prereq()).reason);
    const slug = slugify(host);
    const db = load();
    if (db.items[slug]) throw httpError(409, `${host} is already shared. Remove it first.`);
    if (Object.values(db.items).some(i => i.port === p)) throw httpError(409, `Port ${p} already has a hostname.`);

    const zone = await findZone(token, host);
    if (!zone.accountId) throw httpError(502, 'Cloudflare did not return the account for that zone (token needs Zone: Read).');
    const existing = await cf(token, 'GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}`);
    if (existing.length) throw httpError(409, `${host} already has a DNS record (${existing[0].type}). Pick another name or remove it in Cloudflare.`);

    const via = (await nginxAvailable()) ? 'nginx' : 'direct';
    let origin = '127.0.0.1';
    if (via === 'direct' && config.dockerHost !== '127.0.0.1') {
        try { if ((await dockerMgr.containers()).some(c => c.ports.some(pp => pp.host === p))) origin = config.dockerHost; } catch { /* docker down */ }
    }
    const it = { slug, hostname: host, port: p, name: String(name || '').slice(0, 60) || host, zoneId: zone.id, zoneName: zone.name, accountId: zone.accountId, tunnelId: null, dnsRecordId: null, via, origin, created: Date.now(), token: null };
    try {
        const tunnel = await cf(token, 'POST', `/accounts/${zone.accountId}/cfd_tunnel`, { name: `porthole-${slug}`, config_src: 'cloudflare' });
        it.tunnelId = tunnel.id;
        const runToken = await cf(token, 'GET', `/accounts/${zone.accountId}/cfd_tunnel/${tunnel.id}/token`);
        it.token = encrypt(String(runToken));
        const service = via === 'nginx' ? 'http://127.0.0.1:80' : `http://${origin}:${p}`;
        await cf(token, 'PUT', `/accounts/${zone.accountId}/cfd_tunnel/${tunnel.id}/configurations`, { config: { ingress: [{ hostname: host, service, originRequest: via === 'nginx' ? { httpHostHeader: host } : {} }, { service: 'http_status:404' }] } });
        const rec = await cf(token, 'POST', `/zones/${zone.id}/dns_records`, { type: 'CNAME', name: host, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, ttl: 1, comment: 'Porthole zoned share' });
        it.dnsRecordId = rec.id;
        if (via === 'nginx') await nginxWrite(slug, host, p);
        await startSession(it, String(runToken));
    } catch (e) {
        log('zoned', `create ${host} failed: ${e.message}; undoing`);
        await teardown(token, it).catch(() => {});
        throw e;
    }
    db.items[slug] = it;
    save(db);
    log('zoned', `shared :${p} as https://${host} via ${via} (tunnel ${it.tunnelId})`);
    // Give cloudflared a few seconds to connect so the first screen can show it live.
    for (let i = 0; i < 20 && !connected(slug); i++) await new Promise(r => setTimeout(r, 500));
    return (await list()).find(x => x.slug === slug);
}

async function teardown(token, it) {
    try { if (await hasSession(SESSION_PREFIX + it.slug)) await killSession(SESSION_PREFIX + it.slug); } catch { /* ignore */ }
    nginxRemove(it.slug);
    if (it.via === 'nginx') { try { await run('nginx', ['-t']); await run('systemctl', ['reload', 'nginx']); } catch { /* ignore */ } }
    if (it.dnsRecordId) await cf(token, 'DELETE', `/zones/${it.zoneId}/dns_records/${it.dnsRecordId}`).catch(e => log('zoned', `dns delete: ${e.message}`));
    if (it.tunnelId) {
        await cf(token, 'DELETE', `/accounts/${it.accountId}/cfd_tunnel/${it.tunnelId}/connections`).catch(() => {});
        await cf(token, 'DELETE', `/accounts/${it.accountId}/cfd_tunnel/${it.tunnelId}?cascade=true`).catch(e => log('zoned', `tunnel delete: ${e.message}`));
    }
    try { fs.rmSync(path.join(logDir, `${it.slug}.log`), { force: true }); } catch { /* ignore */ }
}

export async function remove(slug) {
    const db = load();
    const it = db.items[slug];
    if (!it) throw httpError(404, 'No such shared hostname.');
    const token = cfToken();
    if (!token) throw httpError(412, 'The Cloudflare token is gone from the Vault; add it back to remove the DNS record and tunnel.');
    await teardown(token, it);
    delete db.items[slug];
    save(db);
    log('zoned', `removed https://${it.hostname} (DNS, tunnel, nginx block)`);
}

export function byPort(port) {
    return Object.values(load().items).find(i => i.port === Number(port)) || null;
}

// After a reboot the tmux sessions are gone: start them again from the stored token.
export async function ensure() {
    for (const it of Object.values(load().items)) {
        if (await hasSession(SESSION_PREFIX + it.slug)) continue;
        try { await startSession(it, decrypt(it.token)); log('zoned', `restarted cloudflared for ${it.hostname}`); } catch (e) { log('zoned', `cannot restart ${it.hostname}: ${e.message}`); }
    }
}
