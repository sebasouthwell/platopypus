// "Share on your domain": a hostname in the user's own Cloudflare zone (parle.example.com) in front of a local port.
//
// Two modes, picked automatically:
//   direct  (default on a box with a public address, nginx and Let's Encrypt, i.e. the same setup Porthole itself uses)
//           1. find the zone; 2. A record hostname → the box (proxied through Cloudflare like the Porthole hostname, so
//           the security group stays closed to everything but Cloudflare's edge); 3. nginx server block on :80 with the
//           ACME path; 4. certbot certonly (webroot) for the hostname; 5. nginx :443 block with that certificate
//           proxying to the port. Renewal rides on certbot's timer. No tunnel process at all.
//   tunnel  (boxes without a public address, e.g. the local Docker test box): a named Cloudflare Tunnel, remotely
//           managed config, CNAME to <tunnel>.cfargotunnel.com, cloudflared in a tmux session (token via TUNNEL_TOKEN).
//
// Remove undoes everything the mode created (DNS record, nginx block, certificate / tunnel), so the hostname is as if it
// never existed. Records live in state/zoned.json; a tunnel's run token is encrypted with the vault key so sessions can
// be restarted after a reboot. The Cloudflare API token comes from the Vault (service "Cloudflare": Zone.Zone read,
// Zone.DNS edit, and Account.Cloudflare Tunnel edit for tunnel mode).

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
const WEBROOT = '/var/www/html';
const COMING_UP_DIR = '/var/www/porthole';
const COMING_UP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10"><title>Coming up</title>
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#0b1424;color:#dde5ee;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:34ch;padding:24px;text-align:center}h1{font-size:22px;margin:0 0 6px;color:#e8b86d}p{margin:0;color:#9fb0c3}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#3fd39a;margin-right:8px;animation:p 1.4s infinite}@keyframes p{50%{opacity:.25}}@media (prefers-reduced-motion:reduce){.dot{animation:none}}</style></head>
<body><main><h1><span class="dot"></span>Coming up</h1><p>This service is starting or being updated. The page refreshes by itself.</p></main></body></html>
`;
function ensureComingUp() { try { fs.mkdirSync(COMING_UP_DIR, { recursive: true, mode: 0o755 }); fs.writeFileSync(path.join(COMING_UP_DIR, 'coming-up.html'), COMING_UP, { mode: 0o644 }); } catch { /* not a box */ } }
const COMING_UP_NGINX = `
    error_page 502 503 504 /__porthole_coming_up.html;
    location = /__porthole_coming_up.html { root ${COMING_UP_DIR}; try_files /coming-up.html =503; internal; add_header Cache-Control "no-store" always; add_header Retry-After "10" always; }`;
export const SESSION_PREFIX = 'zoned-';

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { items: {} }; } }
function save(db) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }
const slugify = h => String(h).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const porthole = () => (process.env.PORTHOLE_DOMAIN || '').toLowerCase();

// ---- prerequisites ----
function cfToken() {
    const env = envForSync(config.home);
    return env.CLOUDFLARE_TOKEN || env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || null;
}
export function apexSuggestion() {
    const parts = porthole().split('.').filter(Boolean);
    return parts.length >= 3 ? parts.slice(1).join('.') : (parts.length === 2 ? porthole() : null);
}
async function nginxAvailable() {
    if (!fs.existsSync('/etc/nginx/sites-enabled')) return false;
    try { await run('systemctl', ['is-active', '--quiet', 'nginx']); return true; } catch { return false; }
}
async function directAvailable() {
    return (await nginxAvailable()) && !!porthole() && !!process.env.LE_EMAIL && fs.existsSync(`/etc/letsencrypt/live/${porthole()}/fullchain.pem`) && (await run('certbot', ['--version']).then(() => true).catch(() => false));
}
export async function prereq() {
    const token = cfToken();
    const direct = await directAvailable();
    const nginx = direct || await nginxAvailable();
    return {
        ready: !!token,
        apex: apexSuggestion(),
        mode: direct ? 'direct' : 'tunnel',
        via: direct ? 'nginx + Let\'s Encrypt' : nginx ? 'tunnel → nginx' : 'tunnel → port',
        reason: token ? null : 'Add a Cloudflare API token in the Vault (service "Cloudflare") with Zone → DNS: Edit and Zone → Zone: Read for your domain (plus Account → Cloudflare Tunnel: Edit on boxes without a public address).',
    };
}

// ---- Cloudflare ----
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
// The box's public address: the A record Porthole itself is served from (no metadata-service dependency).
async function boxAddress(token, zone) {
    const recs = await cf(token, 'GET', `/zones/${zone.id}/dns_records?type=A&name=${encodeURIComponent(porthole())}`);
    if (!recs.length) throw httpError(502, `No A record for ${porthole()} in the zone; cannot tell the box's address.`);
    return { ip: recs[0].content, proxied: recs[0].proxied !== false };
}

// ---- nginx ----
const PROXY = port => `
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_connect_timeout 3s;`;
function blockHttp(host) {
    return `# Porthole share: ${host}. Created and removed by Porthole; do not edit.
server {
    listen 80;
    listen [::]:80;
    server_name ${host};
    location ^~ /.well-known/acme-challenge/ { root ${WEBROOT}; }
    location / { return 301 https://$host$request_uri; }
}
`;
}
function blockSsl(host, port) {
    return blockHttp(host) + `
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${host};
    ssl_certificate     /etc/letsencrypt/live/${host}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${host}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 600m;${COMING_UP_NGINX}
    location / {${PROXY(port)}
    }
}
`;
}
function blockLoopback(host, port) {
    return `# Porthole share (tunnel): ${host} → 127.0.0.1:${port}. Created and removed by Porthole; do not edit.
server {
    listen 127.0.0.1:80;
    server_name ${host};
    if ($host != "${host}") { return 444; }
    client_max_body_size 600m;${COMING_UP_NGINX}
    location / {${PROXY(port)}
    }
}
`;
}
async function nginxApply(slug, text) {
    ensureComingUp();
    const avail = `/etc/nginx/sites-available/porthole-zoned-${slug}`;
    fs.writeFileSync(avail, text, { mode: 0o644 });
    try { fs.symlinkSync(avail, `/etc/nginx/sites-enabled/porthole-zoned-${slug}`); } catch { /* exists */ }
    try { await run('nginx', ['-t']); } catch (e) { nginxRemove(slug); throw httpError(500, `nginx rejected the config: ${String(e.stderr || e.message).slice(0, 300)}`); }
    await run('systemctl', ['reload', 'nginx']);
}
function nginxRemove(slug) {
    for (const f of [`/etc/nginx/sites-enabled/porthole-zoned-${slug}`, `/etc/nginx/sites-available/porthole-zoned-${slug}`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
}
async function nginxReloadQuiet() { try { await run('nginx', ['-t']); await run('systemctl', ['reload', 'nginx']); } catch { /* ignore */ } }

// ---- Let's Encrypt ----
async function certbotObtain(host) {
    const args = ['certonly', '--webroot', '-w', WEBROOT, '--non-interactive', '--agree-tos', '--no-eff-email', '-m', process.env.LE_EMAIL, '-d', host, '--deploy-hook', 'systemctl reload nginx'];
    let last = '';
    for (let i = 0; i < 4; i++) {
        try { await run('certbot', args, { timeout: 180_000 }); return; } catch (e) { last = String(e.stderr || e.stdout || e.message).split('\n').filter(l => /error|fail|detail|type:/i.test(l)).slice(-3).join(' | ').slice(0, 400); }
        await sleep(8000); // DNS at the edge is usually instant; give it a few tries anyway
    }
    throw httpError(502, `Let's Encrypt did not issue a certificate for ${host}: ${last || 'no detail'}`);
}
const certExists = host => fs.existsSync(`/etc/letsencrypt/live/${host}/fullchain.pem`);
async function certbotDelete(host) { try { await run('certbot', ['delete', '--cert-name', host, '--non-interactive'], { timeout: 60_000 }); } catch { /* none */ } }

// ---- tunnel mode ----
async function startSession(it, token) {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logFile = path.join(logDir, `${it.slug}.log`);
    const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
    await newSession(SESSION_PREFIX + it.slug, config.home, `cloudflared tunnel --no-autoupdate run 2>&1 | tee -a ${q(logFile)}`, { TUNNEL_TOKEN: token });
}
function tunnelConnected(slug) {
    try { const t = fs.readFileSync(path.join(logDir, `${slug}.log`), 'utf8'); return /Registered tunnel connection/.test(t.slice(-20000)); } catch { return false; }
}

// ---- public API ----
export async function list() {
    const out = [];
    for (const it of Object.values(load().items)) {
        let alive, connected;
        if (it.mode === 'direct') { alive = certExists(it.hostname) && fs.existsSync(`/etc/nginx/sites-enabled/porthole-zoned-${it.slug}`); connected = alive; }
        else { alive = await hasSession(SESSION_PREFIX + it.slug); connected = alive && tunnelConnected(it.slug); }
        out.push({ slug: it.slug, hostname: it.hostname, port: it.port, name: it.name || it.hostname, url: `https://${it.hostname}`, kind: 'zoned', mode: it.mode, created: it.created, expires: null, origin: it.origin, owner: it.owner || null, via: it.via, alive, connected });
    }
    return out.sort((a, b) => b.created - a.created);
}

export async function create({ port, hostname, name = '' }) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw httpError(400, 'Port must be between 1 and 65535.');
    if (p === config.port) throw httpError(403, 'Porthole itself cannot be exposed this way.');
    const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
    if (!HOST_RE.test(host)) throw httpError(400, 'Hostname must be a full name in your domain, like app.example.com.');
    if (host === porthole()) throw httpError(403, 'That is the Porthole hostname.');
    const token = cfToken();
    if (!token) throw httpError(412, (await prereq()).reason);
    const slug = slugify(host);
    const db = load();
    if (db.items[slug]) throw httpError(409, `${host} is already shared. Remove it first.`);
    if (Object.values(db.items).some(i => i.port === p)) throw httpError(409, `Port ${p} already has a hostname.`);

    const zone = await findZone(token, host);
    const existing = await cf(token, 'GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}`);
    if (existing.length) throw httpError(409, `${host} already has a DNS record (${existing[0].type}). Pick another name or remove it in Cloudflare.`);

    const mode = (await directAvailable()) ? 'direct' : 'tunnel';
    const it = { slug, hostname: host, port: p, name: String(name || '').slice(0, 60) || host, mode, zoneId: zone.id, zoneName: zone.name, accountId: zone.accountId, tunnelId: null, dnsRecordId: null, via: null, origin: '127.0.0.1', created: Date.now(), token: null };
    try {
        if (mode === 'direct') {
            it.via = 'nginx + Let\'s Encrypt';
            const addr = await boxAddress(token, zone);
            const rec = await cf(token, 'POST', `/zones/${zone.id}/dns_records`, { type: 'A', name: host, content: addr.ip, proxied: addr.proxied, ttl: 1, comment: 'Porthole share' });
            it.dnsRecordId = rec.id;
            await nginxApply(slug, blockHttp(host));
            await certbotObtain(host);
            await nginxApply(slug, blockSsl(host, p));
        } else {
            if (!zone.accountId) throw httpError(502, 'Cloudflare did not return the account for that zone (token needs Zone: Read).');
            const nginx = await nginxAvailable();
            it.via = nginx ? 'tunnel → nginx' : 'tunnel → port';
            if (!nginx && config.dockerHost !== '127.0.0.1') { try { if ((await dockerMgr.containers()).some(c => c.ports.some(pp => pp.host === p))) it.origin = config.dockerHost; } catch { /* docker down */ } }
            const tunnel = await cf(token, 'POST', `/accounts/${zone.accountId}/cfd_tunnel`, { name: `porthole-${slug}`, config_src: 'cloudflare' });
            it.tunnelId = tunnel.id;
            const runToken = await cf(token, 'GET', `/accounts/${zone.accountId}/cfd_tunnel/${tunnel.id}/token`);
            it.token = encrypt(String(runToken));
            const service = nginx ? 'http://127.0.0.1:80' : `http://${it.origin}:${p}`;
            await cf(token, 'PUT', `/accounts/${zone.accountId}/cfd_tunnel/${tunnel.id}/configurations`, { config: { ingress: [{ hostname: host, service, originRequest: nginx ? { httpHostHeader: host } : {} }, { service: 'http_status:404' }] } });
            const rec = await cf(token, 'POST', `/zones/${zone.id}/dns_records`, { type: 'CNAME', name: host, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, ttl: 1, comment: 'Porthole share (tunnel)' });
            it.dnsRecordId = rec.id;
            if (nginx) await nginxApply(slug, blockLoopback(host, p));
            await startSession(it, String(runToken));
        }
    } catch (e) {
        log('zoned', `create ${host} (${mode}) failed: ${e.message}; undoing`);
        await teardown(token, it).catch(() => {});
        throw e;
    }
    db.items[slug] = it;
    save(db);
    log('zoned', `shared :${p} as https://${host} via ${it.via}`);
    if (mode === 'tunnel') for (let i = 0; i < 20 && !tunnelConnected(slug); i++) await sleep(500);
    return (await list()).find(x => x.slug === slug);
}

async function teardown(token, it) {
    if (it.mode === 'direct') {
        nginxRemove(it.slug); await nginxReloadQuiet();
        if (certExists(it.hostname)) await certbotDelete(it.hostname);
    } else {
        try { if (await hasSession(SESSION_PREFIX + it.slug)) await killSession(SESSION_PREFIX + it.slug); } catch { /* ignore */ }
        nginxRemove(it.slug); await nginxReloadQuiet();
        if (it.tunnelId) {
            await cf(token, 'DELETE', `/accounts/${it.accountId}/cfd_tunnel/${it.tunnelId}/connections`).catch(() => {});
            await cf(token, 'DELETE', `/accounts/${it.accountId}/cfd_tunnel/${it.tunnelId}?cascade=true`).catch(e => log('zoned', `tunnel delete: ${e.message}`));
        }
        try { fs.rmSync(path.join(logDir, `${it.slug}.log`), { force: true }); } catch { /* ignore */ }
    }
    if (it.dnsRecordId) await cf(token, 'DELETE', `/zones/${it.zoneId}/dns_records/${it.dnsRecordId}`).catch(e => log('zoned', `dns delete: ${e.message}`));
}

export async function remove(slug) {
    const db = load();
    const it = db.items[slug];
    if (!it) throw httpError(404, 'No such shared hostname.');
    const token = cfToken();
    if (!token) throw httpError(412, 'The Cloudflare token is gone from the Vault; add it back so the DNS record can be removed too.');
    await teardown(token, it);
    delete db.items[slug];
    save(db);
    log('zoned', `removed https://${it.hostname} (${it.mode}: DNS, nginx block, ${it.mode === 'direct' ? 'certificate' : 'tunnel'})`);
}

export function byPort(port) {
    return Object.values(load().items).find(i => i.port === Number(port)) || null;
}

// After a reboot: tunnel sessions are gone and must be started again; direct shares need nothing (nginx + certbot
// timer are system services).
export async function ensure() {
    for (const it of Object.values(load().items)) {
        if (it.mode !== 'tunnel' || (await hasSession(SESSION_PREFIX + it.slug))) continue;
        try { await startSession(it, decrypt(it.token)); log('zoned', `restarted cloudflared for ${it.hostname}`); } catch (e) { log('zoned', `cannot restart ${it.hostname}: ${e.message}`); }
    }
}
