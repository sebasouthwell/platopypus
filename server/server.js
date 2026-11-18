// PlatOpypus server: static UI + JSON API + WebSocket terminals.
// No framework; Node's http module and `ws` are enough and keep the dependency surface small.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { config, loadToken } from './lib/config.js';
import * as auth from './lib/auth.js';
import * as shells from './lib/shells.js';
import * as files from './lib/files.js';
import * as tunnels from './lib/tunnels.js';
import * as system from './lib/system.js';
import * as history from './lib/history.js';
import * as vault from './lib/vault.js';
import * as dockerMgr from './lib/docker.js';
import * as totp from './lib/totp.js';
import * as apps from './lib/apps.js';
import * as home from './lib/home.js';
import * as gitMgr from './lib/git.js';
import * as creds from './lib/credentials.js';
import * as agents from './lib/agents.js';
import * as codeserver from './lib/codeserver.js';
import * as catalog from './lib/catalog.js';
import * as update from './lib/update.js';
import * as shared from './lib/sharedcreds.js';
import * as services from './lib/services.js';
import * as projectFlags from './lib/projects.js';
import * as zoned from './lib/zoned.js';
import * as derive from './lib/derive.js';
import * as live from './lib/live.js';
import * as quick from './lib/quick.js';
import * as audit from './lib/audit.js';
import * as alerts from './lib/alerts.js';
import * as egress from './lib/egress.js';
import * as usage from './lib/usage.js';
import * as limit from './lib/limit.js';
import * as activity from './lib/activity.js';
import * as research from './lib/research.js';
import * as addons from './lib/addons.js';
import * as lab from './lib/lab.js';
import * as clineLib from './lib/cline.js';
import * as consult from './lib/consult.js';
import * as schedules from './lib/schedules.js';
import * as cases from './lib/cases.js';
import * as jobs from './lib/jobs.js';
import * as kitTools from './lib/kit/tools.js';
import * as workspaces from './lib/kit/workspaces.js';
import * as zipstream from './lib/zipstream.js';
import * as prefs from './lib/prefs.js';
import * as transfers from './lib/transfers.js';
import * as promptsLib from './lib/prompts.js';
import { spawn as spawnProc } from 'node:child_process';
import * as editor from './lib/researcheditor.js';
import * as repo from './lib/researchrepo.js';
import * as qa from './lib/researchqa.js';
import * as template from './lib/researchtemplate.js';
import * as backups from './lib/backup.js';
import os from 'node:os';
import * as logos from './lib/logos.js';
import * as upgrade from './lib/upgrade.js';
import * as portholerun from './lib/portholerun.js';
import * as agentUser from './lib/agentuser.js';
import * as elevate from './lib/elevate.js';
import * as profile from './lib/profile.js';
import { log } from './lib/log.js';
import * as migrate from './lib/migrate.js';

// Upgrade migrations run before anything else reads the state. A failure has already restored the state archive;
// exit so nothing runs on it (systemd retries; the updater's health check rolls the code back).
try {
    const r = await migrate.boot(config.state, m => log('migrate', m));
    if (r.applied.length) log('migrate', `applied ${r.applied.map(a => a.id).join(', ')}; backup ${r.backup}`);
} catch (e) { log('migrate', e.message); process.exit(78); }

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');
const vendor = {
    '/vendor/xterm.css': path.join(here, 'node_modules/@xterm/xterm/css/xterm.css'),
    '/vendor/xterm.js': path.join(here, 'node_modules/@xterm/xterm/lib/xterm.js'),
    '/vendor/addon-fit.js': path.join(here, 'node_modules/@xterm/addon-fit/lib/addon-fit.js'),
    '/vendor/addon-web-links.js': path.join(here, 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js'),
    '/vendor/addon-unicode11.js': path.join(here, 'node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js'),
    '/vendor/addon-webgl.js': path.join(here, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js'),
    '/vendor/addon-clipboard.js': path.join(here, 'node_modules/@xterm/addon-clipboard/lib/addon-clipboard.js'),
    '/vendor/webauthn.js': path.join(here, 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js'),
};

const TOKEN = loadToken();
elevate.setShellLookup(name => shells.shellMeta(name)?.cwd || null);

// ---------- helpers ----------

// What a restricted (agent-user shell) session may call: the box CLIs and nothing else.
// Job Hunt's one-shot agents (automatic assessments, CPD and document reading) start through this.
async function jobsRunner(prompt, base) { const st = jobs.settings(); const name = `${base}-${Math.random().toString(36).slice(2, 4)}`; await shells.create({ name, kind: 'agent', agent: st.agent || 'claude', model: st.model || '', runAs: 'agent', session: 'jobs', cwd: path.relative(config.root, jobs.ROOT) || 'Jobs', firstPrompt: prompt, oneshot: true }); return name; }
setTimeout(() => { try { if (jobs.ready()) { jobs.setAgentRunner(jobsRunner); jobs.queueDocReads(); jobs.queueCodeReads(); } } catch { /* Job Hunt not set up */ } }, 30_000);
setInterval(() => { try { if (jobs.ready()) { jobs.setAgentRunner(jobsRunner); jobs.takeRequests(jobsRunner); } } catch { /* Job Hunt not set up */ } }, 20_000);
const AGENT_ROUTES = [
    ['GET', /^\/api\/agent\/tools\/[a-z][a-z0-9-]{1,30}$/], ['POST', /^\/api\/agent\/tools\/[a-z][a-z0-9-]{1,30}\/[a-z_]{2,40}$/],   // app tools (kit/tools.js); each app checks the shell
    ['GET', /^\/api\/me$/], ['GET', /^\/api\/vault$/], ['POST', /^\/api\/agent\/vault$/],
    ['POST', /^\/api\/agent\/elevate$/], ['GET', /^\/api\/agent\/elevate\/[a-f0-9]{12}$/],
    ['POST', /^\/api\/agent\/research\/ask$/], ['GET', /^\/api\/agent\/research\/ask\/[a-f0-9]{12}$/],
    ['GET', /^\/api\/agent\/consult$/], ['POST', /^\/api\/agent\/consult$/],
    ['GET', /^\/api\/agent\/schedules$/], ['POST', /^\/api\/agent\/schedules$/],
    ['GET', /^\/api\/agent\/case$/], ['POST', /^\/api\/agent\/case\/(source|pin|link|ask|answer|theory|weigh|path|probe|note|adopt)$/], ['GET', /^\/api\/agent\/case\/probes\/p\d{1,5}$/],
    ['GET', /^\/api\/agent\/lab\/status$/], ['POST', /^\/api\/agent\/lab\/run$/], ['GET', /^\/api\/agent\/lab\/run\/r\d{3,5}$/],
    ['POST', /^\/api\/creds\/share$/],
    ['GET', /^\/api\/servers$/], ['POST', /^\/api\/servers(\/run)?$/], ['POST', /^\/api\/servers\/[a-z0-9-]{1,40}\/(stop|start|restart)$/], ['GET', /^\/api\/servers\/[a-z0-9-]{1,40}\/logs$/], ['DELETE', /^\/api\/servers\/[a-z0-9-]{1,40}$/],
    ['GET', /^\/api\/live$/], ['GET', /^\/api\/live\/check$/],
    ['GET', /^\/api\/projects\/repo$/], ['GET', /^\/api\/projects\/profile$/], ['POST', /^\/api\/projects\/profile\/cve-checked$/],
    ['GET', /^\/api\/tunnels$/], ['POST', /^\/api\/tunnels$/], ['DELETE', /^\/api\/tunnels\/\d{1,5}$/], ['POST', /^\/api\/tunnels\/\d{1,5}\/extend$/],
];

// Things that change what the box runs or publishes. Each successful call is kept in the audit log as Activity,
// with who asked (an agent shell, the box CLI from a root shell, or the phone) and the project it concerns.
const ACTIVITY = [
    ['POST', /^\/api\/tunnels$/, 'tunnel-start', (m, b, r) => ({ what: `port ${r?.port ?? b.port}${r?.url ? ` → ${r.url}` : ''}`, port: r?.port ?? b.port })],
    ['DELETE', /^\/api\/tunnels\/(\d+)$/, 'tunnel-stop', m => ({ what: `port ${m[1]}`, port: Number(m[1]) })],
    ['POST', /^\/api\/zoned$/, 'hostname-add', (m, b) => ({ what: `${b.hostname || b.name || ''} → port ${b.port}`, port: b.port })],
    ['DELETE', /^\/api\/zoned\/([a-z0-9-]{1,50})$/, 'hostname-remove', m => ({ what: m[1] })],
    ['POST', /^\/api\/servers\/run$/, 'server-run', (m, b, r) => ({ what: `${r?.name || b.name || ''}${r?.port || b.port ? ` :${r?.port || b.port}` : ''} · ${[].concat(b.cmd || []).join(' ').slice(0, 300)}`, cwd: r?.cwd || b.cwd })],
    ['POST', /^\/api\/servers$/, 'server-register', (m, b, r) => ({ what: `${r?.name || b.name || ''}${b.port ? ` :${b.port}` : ''}`, cwd: r?.cwd || b.cwd })],
    ['POST', /^\/api\/servers\/([a-z0-9-]{1,40})\/(stop|start|restart)$/, m => `server-${m[2]}`, (m, b, r) => ({ what: m[1], cwd: r?.cwd })],
    ['DELETE', /^\/api\/servers\/([a-z0-9-]{1,40})$/, 'server-remove', m => ({ what: m[1] })],
    ['POST', /^\/api\/live\/([^/]{1,80})\/([a-z0-9-]{1,31})\/(start|stop|restart|hostname)$/, m => `service-${m[3]}`, m => ({ what: `${decodeURIComponent(m[1])}/${m[2]}`, project: decodeURIComponent(m[1]) })],
    ['POST', /^\/api\/live\/([^/]{1,80})\/([a-z0-9-]{1,31})\/(actions|groups)\//, 'service-action', (m, b, r) => ({ what: `${r?.label || 'action'}${b.item ? ` · ${b.item}` : ''}`, project: decodeURIComponent(m[1]), code: r?.code })],
    ['POST', /^\/api\/live\/([^/]{1,80})\/([a-z0-9-]{1,31})\/pull$/, 'image-pull', (m, b, r) => ({ what: `${decodeURIComponent(m[1])}/${m[2]} · ${r?.image || ''} (${r?.changed ? (r.restarted ? 'new image, restarted' : 'new image') : 'no change'})`, project: decodeURIComponent(m[1]) })],
    ['POST', /^\/api\/portholerun\/run$/, 'portholerun', (m, b, r) => ({ what: r?.slug || '', cwd: b.abs ? String(b.abs).replace(/\/[^/]*$/, '') : undefined })],
    ['POST', /^\/api\/rename\/finish$/, 'rename-finished', (m, b, r) => ({ what: `shells and services moved to the plato socket; restarted ${(r?.restarted || []).join(', ') || 'nothing'}` })],
    ['PUT', /^\/api\/keepalive$/, 'keepalive-set', (m, b, r) => ({ what: `Box kept on until ${r?.keepAlive ? new Date(r.keepAlive.until).toUTCString() : '?'}${r?.keepAlive?.reason ? ` (${r.keepAlive.reason})` : ''}` })],
    ['DELETE', /^\/api\/keepalive$/, 'keepalive-cleared', () => ({ what: 'Keep-alive cleared' })],
    ['PUT', /^\/api\/limit$/, 'limit-changed', (m, b, r) => ({ what: `Limit reached guard ${r?.on ? 'on' : 'off'}, load over ${r?.load}` })],
    ['PUT', /^\/api\/alerts$/, 'alerts-changed', (m, b, r) => ({ what: `Telegram alerts${r?.botName ? ` via ${r.botName}` : ''}: ${r ? Object.entries(r.on).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none' : ''}${r?.pausedUntil ? ' (paused)' : ''}` })],
    ['POST', /^\/api\/git\/(commit|push|pull|publish|init|clone)$/, m => `git-${m[1]}`, (m, b) => ({ what: m[1] === 'commit' ? String(b.message || '').split(String.fromCharCode(10))[0].slice(0, 160) : m[1] === 'clone' ? String(b.repo || '') : '', cwd: b.path ? files.resolveInRoot(b.path) : b.dest ? files.resolveInRoot(b.dest) : undefined })],
];
function actorOf(session) {
    if (session.agent) { const sh = shells.shellMeta(session.agent); return { actor: `shell "${session.agent}"`, via: 'agent shell', cwd: sh?.cwd }; }
    if (/local token/.test(session.how || '')) return { actor: 'box CLI', via: 'root shell' };
    return { actor: 'phone', via: session.how || 'phone' };
}

const RUNNING_VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '0'; } catch { return '0'; } })();

function send(res, status, body, headers = {}) {
    if (res.auditHook && status < 300) { try { res.auditHook(body); } catch { /* never block the reply */ } }
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    // Apps whose web views keep a cache (web/appcache.js) get an ETag: an unchanged answer comes back as 304, no body.
    const rq = res.req; if (status === 200 && rq && rq.method === 'GET' && typeof body !== 'string' && /^\/api\/(jobs|cases|research|lab|prompts|schedules|addons)(\/|$|\?)/.test(rq.url || '')) {
        const tag = `W/"${crypto.createHash('sha1').update(data).digest('base64url').slice(0, 22)}"`;
        if (rq.headers['if-none-match'] === tag) { res.writeHead(304, { ETag: tag, 'Cache-Control': 'private, no-cache', ...securityHeaders() }); return res.end(); }
        headers = { ...headers, ETag: tag, 'Cache-Control': 'private, no-cache' };
    }
    res.writeHead(status, {
        'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Plato-Version': RUNNING_VERSION, 'X-Porthole-Version': RUNNING_VERSION,
        ...securityHeaders(),
        ...headers,
    });
    res.end(data);
}

function securityHeaders() {
    return {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'Content-Security-Policy': `default-src 'self'; img-src 'self' data: blob: https://avatars.githubusercontent.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss: https://*.lambda-url.${process.env.AWS_REGION || 'eu-west-2'}.on.aws; frame-ancestors 'self'; base-uri 'none'; form-action 'self'`,
    };
}

async function readJson(req, limit = 1024 * 1024) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw shells.httpError(413, 'Body too large.');
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return (req.jsonBody = JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
        throw shells.httpError(400, 'Invalid JSON.');
    }
}

// index.html is served with every asset reference stamped with the running version (and a meta tag app.js reads for
// the icon sprite), so a proxy cache can only ever hand out matching files.
let indexCache = null;
function serveIndex(res) {
    try {
        if (!indexCache) {
            const v = encodeURIComponent(RUNNING_VERSION);
            indexCache = Buffer.from(fs.readFileSync(path.join(webDir, 'index.html'), 'utf8')
                .replace('<head>', `<head><meta name="porthole-version" content="${v}">`)
                .replace('href="/styles.css"', `href="/styles.css?v=${v}"`)
                .replace('src="/app.js"', `src="/app.js?v=${v}"`)
                .replace(/\/sprite\.svg#/g, `/sprite.svg?v=${v}#`));
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': indexCache.length, 'Cache-Control': 'no-cache', ...securityHeaders() });
        res.end(indexCache);
    } catch { send(res, 404, 'Not found'); }
}

function serveFile(res, file, cacheable = false) {
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) return send(res, 404, 'Not found');
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, {
            'Content-Type': files.mimeByExt[ext] || 'application/octet-stream',
            'Content-Length': st.size,
            'Cache-Control': cacheable ? 'public, max-age=86400' : 'no-cache',
            ...securityHeaders(),
        });
        fs.createReadStream(file).pipe(res);
    });
}

// ---------- routing ----------

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const method = req.method;

    try {
        // Static: UI and vendored libs. Everything else under /api needs auth.
        if (p === '/oauth/callback' && method === 'GET') {
            if (!auth.authenticate(req)) return send(res, 401, 'Sign in to PlatOpypus first, then start the connection again from the Vault.');
            try {
                const r = await vault.handleCallback(Object.fromEntries(url.searchParams));
                res.writeHead(302, { Location: `/?oauth=connected&name=${encodeURIComponent(r.name)}`, ...securityHeaders() });
                return res.end();
            } catch (e) {
                res.writeHead(302, { Location: `/?oauth=failed&error=${encodeURIComponent(e.message)}`, ...securityHeaders() });
                return res.end();
            }
        }
        if (method === 'GET' && vendor[p]) return serveFile(res, vendor[p], true);
        if (method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/dl/')) {   // /dl/: transfer links, further down
            if (p === '/' || p === '/index.html') return serveIndex(res);
            const file = path.normalize(path.join(webDir, p));
            if (!file.startsWith(webDir)) return send(res, 404, 'Not found');
            return serveFile(res, file, p.startsWith('/icons/') || p.startsWith('/fonts/'));
        }

        // Auth endpoints.
        // ----- sign-in / first-run setup -----
        if (p === '/api/login' && method === 'GET') return send(res, 200, creds.summary(false));
        if (p.startsWith('/api/login/') || p.startsWith('/api/setup/')) {
            if (method !== 'POST') return send(res, 405, { error: 'POST only.' });
            if (!auth.originAllowed(req)) return send(res, 403, { error: 'Bad origin.' });
            const body = await readJson(req, 64 * 1024);
            const finish = (how) => {
                const r = auth.finishLogin(req, how);
                return r.needCode ? send(res, 200, { needCode: true, ticket: r.ticket }) : send(res, 200, { ok: true }, { 'Set-Cookie': r.cookie });
            };
            // First run: setup token + passkey (and/or password when explicitly allowed).
            if (p === '/api/setup/passkey/options') {
                if (creds.hasCredentials()) return send(res, 409, { error: 'Already set up.' });
                if (!auth.checkToken(req, body.token, TOKEN)) return send(res, 401, { error: 'Setup token is not right.' });
                return send(res, 200, await creds.registrationOptions(req, body.name));
            }
            if (p === '/api/setup/passkey/verify') {
                if (creds.hasCredentials()) return send(res, 409, { error: 'Already set up.' });
                if (!auth.checkToken(req, body.token, TOKEN)) return send(res, 401, { error: 'Setup token is not right.' });
                const pk = await creds.registrationVerify(req, body.response);
                if (body.password) creds.setPassword(body.password);
                return finish(`setup passkey "${pk.name}"`);
            }
            if (p === '/api/setup/password') {
                if (creds.hasCredentials()) return send(res, 409, { error: 'Already set up.' });
                if (!creds.allowPasswordOnly) return send(res, 403, { error: 'A passkey is required to set this box up.' });
                if (!auth.checkToken(req, body.token, TOKEN)) return send(res, 401, { error: 'Setup token is not right.' });
                creds.setPassword(body.password);
                return finish('setup password');
            }
            // Returning user.
            if (p === '/api/login/passkey/options') return send(res, 200, await creds.authenticationOptions(req));
            if (p === '/api/login/passkey/verify') {
                if (auth.lockedOut(req)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
                try { const pk = await creds.authenticationVerify(req, body.response); return finish(`passkey "${pk.name}"`); }
                catch (e) { auth.recordFailure(req, 'passkey'); throw e; }
            }
            if (p === '/api/login/password') {
                if (auth.lockedOut(req)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
                if (!creds.verifyPassword(body.password)) { auth.recordFailure(req, 'password'); return send(res, 401, { error: 'That password is not right.' }); }
                return finish('password');
            }
            if (p === '/api/login/totp') {
                if (auth.lockedOut(req)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
                const r = auth.finishTotp(req, body.ticket, body.code);
                if (!r.ok) return send(res, r.status, { error: r.error });
                return send(res, 200, { ok: true }, { 'Set-Cookie': r.cookie });
            }
            // Box-local CLIs (vault, tunnel): token login from loopback only, never via the proxy.
            if (p === '/api/login/token') {
                if (!creds.isLoopbackDirect(req)) return send(res, 403, { error: 'Token sign-in is only available from the box itself.' });
                const sh = await shells.shellForToken(body.token);
                if (sh) return send(res, 200, { ok: true, agent: true }, { 'Set-Cookie': auth.agentLogin(req, sh.name).cookie });
                if (!auth.checkToken(req, body.token, TOKEN)) return send(res, 401, { error: 'Token is not right.' });
                const r = auth.finishLogin(req, 'local token', { skipTotp: true });
                return send(res, 200, { ok: true }, { 'Set-Cookie': r.cookie });
            }
            return send(res, 404, { error: 'No such endpoint.' });
        }
        if (p === '/api/logout' && method === 'POST') {
            return send(res, 200, { ok: true }, { 'Set-Cookie': auth.logout(req) });
        }

        // Transfer links: /dl/<token>/<name> fetches one file, or a folder as a zip, without signing in. The token is the
        // credential: random, 2 minutes, one download by default. Wrong tokens count towards the sign-in lockout.
        if (p.startsWith('/dl/') && method === 'GET') {
            const plain = (status, text) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders() }); res.end(text + '\n'); };
            if (auth.lockedOut(req)) return plain(429, 'Too many attempts. Try again in a few minutes.');
            const t = transfers.take(p.split('/')[2] || '');
            if (!t) { auth.recordFailure(req, 'transfer link'); return plain(404, 'No such transfer link.'); }
            if (t.gone) return plain(410, t.gone);
            const { link } = t; const who = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?'); const ua = String(req.headers['user-agent'] || '').slice(0, 80);
            audit.record('activity', 'transfer-used', { actor: `transfer link ${link.id}`, via: 'transfer link', what: `${link.rel || '/'} as ${link.name} to ${who}${ua ? ` (${ua})` : ''}`, cwd: link.abs });
            try {
                const st = await fs.promises.stat(link.abs).catch(() => null);
                if (!st || (link.kind === 'zip') !== st.isDirectory()) return plain(410, 'What this link pointed to is no longer there.');
                const head = { 'Content-Disposition': `attachment; filename="${link.name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
                if (link.kind === 'file') {
                    res.writeHead(200, { ...head, 'Content-Type': 'application/octet-stream', 'Content-Length': st.size });
                    await new Promise(ok => { const rs = fs.createReadStream(link.abs); rs.on('error', () => { res.destroy(); ok(); }); res.on('close', ok); rs.pipe(res); });
                } else {
                    const plan = await zipstream.plan(link.abs, { skip: link.all ? [] : zipstream.DEFAULT_SKIP });
                    if (plan.tooBig) return plain(413, 'Too big for one zip (over 65 535 items or 4 GB).');
                    res.writeHead(200, { ...head, 'Content-Type': 'application/zip' });
                    try { await zipstream.write(link.abs, plan, res); res.end(); } catch (e) { log('files', `transfer ${link.id} stopped: ${e.message}`); res.destroy(); }
                }
            } finally { t.done(); }
            return;
        }

        // Everything below requires a session.
        const session = auth.authenticate(req);
        if (!session) return send(res, 401, { error: 'Sign in first.' });
        if (method !== 'GET') {
            if (!auth.originAllowed(req)) return send(res, 403, { error: 'Bad origin.' });
            if (!auth.hasCsrfHeader(req)) return send(res, 403, { error: 'Missing request header.' });
        }

        // Activity audit: recorded when the call succeeds (send() runs the hook for 2xx replies).
        if (method !== 'GET') {
            const hit = ACTIVITY.find(([meth, re]) => meth === method && re.test(p));
            if (hit) {
                const [, re, act, fn] = hit; const mm = p.match(re);
                res.auditHook = reply => {
                    const who = actorOf(session); const d = fn(mm, req.jsonBody || {}, reply && typeof reply === 'object' ? reply : null) || {};
                    audit.record('activity', typeof act === 'function' ? act(mm) : act, { ...who, ...d, cwd: d.cwd || who.cwd, project: d.project !== undefined ? d.project : undefined });
                };
            }
        }

        // Agent-user shells: only the routes the box CLIs need (docs/AGENT-USER.md).
        if (session.agent) {
            let am;
            const allowed = AGENT_ROUTES.some(([meth, re]) => meth === method && re.test(p));
            if (!allowed) { log('agent', `"${session.agent}" refused ${method} ${p}`); return send(res, 403, { error: 'Not available to agent-user shells. Ask the user, or use elevate for root commands.' }); }
            const sh = shells.shellMeta(session.agent);
            if (!sh || !(await shells.panePid(session.agent))) return send(res, 401, { error: 'That shell has ended.' });
            const ag = agentUser.info();
            // The calling process must be this shell's, run as the agent user; its real folder comes from /proc.
            const caller = async (pid) => {
                const pr = agentUser.proc(pid);
                const pane = await shells.panePid(session.agent);
                if (!pr || pr.uid !== ag.uid || !agentUser.isDescendant(pr.pid, pane)) throw shells.httpError(403, 'Caller is not a process of this shell.');
                if (!pr.cwd) throw shells.httpError(403, 'Cannot tell which folder the caller is in.');
                return pr;
            };
            if (p === '/api/agent/vault' && method === 'POST') {
                const b = await readJson(req, 4096);
                const pr = await caller(b.pid);
                const env = await vault.envFor(pr.cwd, { project: 'exact' });
                if (Array.isArray(b.names)) {   // vault run NAME[,NAME] -- cmd: just these, for this command
                    const want = b.names.map(String).slice(0, 30);
                    const gone = want.filter(n => !(n in env));
                    if (gone.length) return send(res, 404, { error: `not available here: ${gone.join(', ')} (vault ls; project values need the project's main folder)` });
                    log('vault', `"${session.agent}" ran ${String(b.cmd || '').slice(0, 200)} with ${want.join(', ')} from ${pr.cwd}`);
                    audit.record('credential', 'agent-run', { actor: `shell "${session.agent}"`, via: 'vault run', cwd: pr.cwd, names: want, cmd: String(b.cmd || '').slice(0, 2000) });
                    return send(res, 200, { env: Object.fromEntries(want.map(n => [n, env[n]])) });
                }
                if (b.name) {
                    if (!(b.name in env)) { const it = vault.list().find(i => i.fields.some(f => f.env === b.name)); return send(res, 404, { error: it ? `${b.name} belongs to project ${it.scope}; run vault get from that project's main folder (/${it.scope}), not elsewhere or a sub-folder` : `no variable named ${b.name} (try: vault ls)` }); }
                    log('vault', `"${session.agent}" read ${b.name} from ${pr.cwd}`);
                    audit.record('credential', 'agent-read', { actor: `shell "${session.agent}"`, via: 'vault get', cwd: pr.cwd, names: [b.name] });
                    return send(res, 200, { value: env[b.name] });
                }
                log('vault', `"${session.agent}" read ${Object.keys(env).length} values from ${pr.cwd}`);
                audit.record('credential', 'agent-read', { actor: `shell "${session.agent}"`, via: 'vault env', cwd: pr.cwd, names: Object.keys(env) });
                return send(res, 200, { env });
            }
            if (p === '/api/agent/elevate' && method === 'POST') {
                const b = await readJson(req, 16 * 1024);
                const pr = await caller(b.pid);
                return send(res, 201, elevate.request(session.agent, { cmd: b.cmd, cwd: pr.cwd, reason: b.reason }));
            }
            if ((am = p.match(/^\/api\/agent\/elevate\/([a-f0-9]{12})$/)) && method === 'GET') return send(res, 200, elevate.get(am[1], session.agent));
            // Asking another agent: allowed or not by this shell's session type; the asked agent runs read-only in this folder.
            // Scheduled routines: agents may see the list and propose one; it stays off until the user approves it.
            if (p === '/api/agent/schedules' && method === 'GET') return send(res, 200, { folder: schedules.ROOT, items: schedules.list().items.map(({ id, name, cron, state, runAs, next, last }) => ({ id, name, cron, state, runAs, next, last })) });
            if (p === '/api/agent/schedules' && method === 'POST') { const b = await readJson(req, 96 * 1024); return send(res, 201, schedules.propose({ name: b.name, cron: b.cron, script: b.script, why: b.why, from: session.agent })); }
            if (p === '/api/agent/consult' && method === 'GET') return send(res, 200, await consult.available(sh.session || null));
            if (p === '/api/agent/consult' && method === 'POST') { const b = await readJson(req, 64 * 1024); const pr = await caller(b.pid); return send(res, 200, await consult.ask({ from: session.agent, fromAgent: sh.agent, session: sh.session || null, cwd: pr.cwd, to: b.to, question: b.question, web: !!b.web, model: b.model })); }
            // App tools (kit/tools.js): one declared list per app, used by plato-tool and plato-mcp. The app decides what this shell may act on.
            if ((am = p.match(/^\/api\/agent\/tools\/([a-z][a-z0-9-]{1,30})$/)) && method === 'GET') return send(res, 200, { tools: kitTools.list(am[1], sh) });
            if ((am = p.match(/^\/api\/agent\/tools\/([a-z][a-z0-9-]{1,30})\/([a-z_]{2,40})$/)) && method === 'POST') { const b = await readJson(req, 512 * 1024); await caller(b.pid); return send(res, 200, await kitTools.call(am[1], am[2], sh, b.args || {}, `shell "${session.agent}"`)); }
            // Security Lab: the engagement is the one this shell works in; every run is checked against its scope.
            if (p.startsWith('/api/agent/lab/')) {
                const slug = lab.engagementOf(sh.cwd); if (!slug) return send(res, 403, { error: 'This shell is not in a Security Lab engagement.' });
                if (p === '/api/agent/lab/status' && method === 'GET') { const d = lab.detail(slug); return send(res, 200, { title: d.title, scope: d.scope, runs: d.runs, tools: Object.fromEntries(Object.entries(lab.TOOLS).map(([k, t]) => [k, { title: t.title, presets: Object.keys(t.presets), local: !!t.local }])) }); }
                if (p === '/api/agent/lab/run' && method === 'POST') { const b = await readJson(req, 16 * 1024); await caller(b.pid); return send(res, 201, await lab.run(slug, { tool: String(b.tool || ''), preset: b.preset || null, target: b.target || null, args: Array.isArray(b.args) ? b.args : null, by: `agent shell "${session.agent}"` })); }
                if ((am = p.match(/^\/api\/agent\/lab\/run\/(r\d{3,5})$/)) && method === 'GET') return send(res, 200, lab.getRun(slug, am[1]));
            }
            // Conspiracy: the case is the one this shell works in.
            if (p === '/api/agent/case' || p.startsWith('/api/agent/case/')) {
                const cslug = cases.caseOf(sh.cwd); if (!cslug) return send(res, 403, { error: 'This shell is not in a Conspiracy case.' });
                const by = `shell "${session.agent}"`;
                if (p === '/api/agent/case' && method === 'GET') return send(res, 200, { ...cases.detail(cslug), todo: cases.todo(cslug) });
                if ((am = p.match(/^\/api\/agent\/case\/probes\/(p\d{1,5})$/)) && method === 'GET') return send(res, 200, cases.getProbe(cslug, am[1]));
                const b = await readJson(req, 64 * 1024); await caller(b.pid);
                const op = p.slice('/api/agent/case/'.length);
                if (op === 'source') return send(res, 201, await cases.addSource(cslug, b, by));
                if (op === 'pin') return send(res, 201, await cases.addNode(cslug, b, by));
                if (op === 'link') return send(res, 201, await cases.addLink(cslug, b, by));
                if (op === 'ask') return send(res, 201, await cases.addQuestion(cslug, b, by));
                if (op === 'answer') return send(res, 200, await cases.answerQuestion(cslug, String(b.id || ''), b));
                if (op === 'theory') return send(res, 201, await cases.addTheory(cslug, b, by));
                if (op === 'weigh') return send(res, 200, await cases.weigh(cslug, String(b.id || ''), { ref: b.ref, verdict: b.verdict }));
                if (op === 'path') return send(res, 200, cases.paths(cslug, b.from, b.to));
                if (op === 'probe') return send(res, 201, await cases.probe(cslug, b, by));
                if (op === 'note') return send(res, 200, cases.appendNote(cslug, b.text, by));
                if (op === 'adopt') return send(res, 201, await cases.adopt(cslug, String(b.id || ''), { reliability: b.reliability }, by));
            }
            if (p === '/api/agent/research/ask' && method === 'POST') { const b = await readJson(req, 16 * 1024); const pr = await caller(b.pid); return send(res, 201, research.createAsk(pr.cwd, b)); }
            if ((am = p.match(/^\/api\/agent\/research\/ask\/([a-f0-9]{12})$/)) && method === 'GET') return send(res, 200, research.getAsk(sh.cwd, am[1]));
            if (p === '/api/servers/run' && method === 'POST') { const b = await readJson(req, 64 * 1024); return send(res, 201, await services.runServer({ ...b, env: {}, owner: session.agent })); }
            if (p === '/api/servers' && method === 'POST') { const b = await readJson(req, 64 * 1024); return send(res, 201, await services.add({ ...b, owner: session.agent })); }
            if ((am = p.match(/^\/api\/tunnels\/(\d{1,5})$/)) && method === 'DELETE' && zoned.byPort(am[1])) return send(res, 403, { error: 'Hostnames on your domain are removed from the phone.' });
            if ((am = p.match(/^\/api\/servers\/([a-z0-9-]{1,40})(\/(stop|start|restart))?$/)) && (method === 'POST' || method === 'DELETE') && !services.ownerOf(services.resolve(am[1]))) return send(res, 403, { error: 'That server was not started from an agent-user shell.' });
        }

        if (p === '/api/me' && method === 'GET') return send(res, 200, { ok: true, created: session.created, version: RUNNING_VERSION });

        // Shells
        if (p === '/api/shells' && method === 'GET') return send(res, 200, await shells.list());
        // Memory and CPU per shell, server and container (the stat bubbles). Shells and servers by their pane's tree.
        if (p === '/api/usage' && method === 'GET') {
            usage.sample();
            const [shellList, servers, ctrs] = await Promise.all([shells.list(), services.list().catch(() => []), usage.containers()]);
            const out = { at: Date.now(), box: usage.box(), shells: {}, servers: {}, containers: Object.fromEntries(ctrs) };
            for (const s of shellList) { const t = usage.tree(await shells.panePid(s.name)); if (t) out.shells[s.name] = t; }
            for (const r of servers) {
                if (!r.alive) continue;
                const c = r.runAs === 'container' ? ctrs.get(r.slug) : null;
                const t = c || usage.tree(r.pid);
                if (t) out.servers[r.slug] = t;
            }
            return send(res, 200, out);
        }
        if (p === '/api/shells' && method === 'POST') return send(res, 201, await shells.create(await readJson(req)));
        let m;
        if ((m = p.match(/^\/api\/shells\/([^/]+)\/mouse$/)) && (method === 'GET' || method === 'POST')) {
            const b = method === 'POST' ? await readJson(req, 1024) : {};
            return send(res, 200, await shells.mouse(decodeURIComponent(m[1]), method === 'POST' ? !!b.on : undefined));
        }
        if ((m = p.match(/^\/api\/shells\/([^/]+)\/creds$/)) && method === 'GET') return send(res, 200, await shared.list({ shell: decodeURIComponent(m[1]), values: true }));
        if (p === '/api/creds' && method === 'GET') return send(res, 200, await shared.list({ port: url.searchParams.get('port'), values: url.searchParams.get('values') === '1' }));
        if (p === '/api/creds/share' && method === 'POST') { const b = await readJson(req, 256 * 1024); if (!Array.isArray(b.fields)) return send(res, 400, { error: 'fields[] required' }); const id = await shared.add(b.shell || null, b); const one = (await shared.list({})).find(c => c.id === id); return send(res, 201, { id, port: one?.port || null }); }
        if ((m = p.match(/^\/api\/creds\/([a-f0-9]+)$/)) && method === 'DELETE') { shared.remove(m[1]); return send(res, 200, { ok: true }); }
        if ((m = p.match(/^\/api\/creds\/([a-f0-9]+)\/values$/)) && method === 'POST') { const one = (await shared.list({ values: true })).find(c => c.id === m[1]); if (!one) return send(res, 404, { error: 'No such shared credential.' }); log('credshare', `values of "${one.title}" revealed to ${auth.clientAddr(req)}`); audit.record('credential', 'shared-revealed', { actor: 'phone', what: one.title, project: audit.projectOf(one.project) }); return send(res, 200, one); }
        if (p === '/api/creds/stale' && method === 'DELETE') return send(res, 200, { removed: shared.removeStale() });
        if ((m = p.match(/^\/api\/shells\/([^/]+)\/scrollback$/)) && method === 'GET') {
            const text = await shells.scrollback(decodeURIComponent(m[1]), url.searchParams.get('lines') || 2000);
            return send(res, 200, text);
        }
        if (p === '/api/history' && method === 'GET') {
            const [commands, prompts] = await Promise.all([history.commands(), history.prompts()]);
            return send(res, 200, { commands, prompts });
        }
        if ((m = p.match(/^\/api\/shells\/([^/]+)$/)) && method === 'DELETE') {
            await shells.kill(decodeURIComponent(m[1]), { deleteScratch: url.searchParams.get('keep') !== '1' });
            return send(res, 200, { ok: true });
        }

        // Files
        if (p === '/api/files' && method === 'GET') {
            const out = await files.list(url.searchParams.get('path') || '.');
            // Project folders show where an upgrade came from or went to.
            try { const dir = files.resolveInRoot(out.path || '.'); for (const i of out.items) if (i.type === 'dir') { const l = upgrade.linksFor(path.join(dir, i.name)); if (l) i.links = l; } } catch { /* ignore */ }
            // What runs in this folder and in each folder listed (servers, .portholerun, live services).
            try {
                const dir = files.resolveInRoot(out.path || '.'), all = await home.runningServers();
                if (all.length) { out.running = home.runningIn(dir, all); for (const i of out.items) if (i.type === 'dir') { const r = home.runningIn(path.join(dir, i.name), all); if (r.length) i.running = r; } }
            } catch { /* ignore */ }
            return send(res, 200, out);
        }
        // Folder icons for the file list: image files only, served as images under a sandbox policy (an SVG shown in
        // <img> cannot run script; opened directly, the sandbox still blocks it).
        if (p === '/api/docker/logo' && method === 'GET') {
            const f = await logos.logoFor(url.searchParams.get('image') || '');
            if (!f) return send(res, 404, { error: 'No logo for that image.' });
            const st = fs.statSync(f);
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': st.size, 'Cache-Control': 'private, max-age=86400', ...securityHeaders(), 'Content-Security-Policy': "sandbox; default-src 'none'" });
            return fs.createReadStream(f).pipe(res);
        }
        if (p === '/api/files/icon' && method === 'GET') {
            const { abs, stat } = await files.stat(url.searchParams.get('path') || '');
            const type = files.ICON_TYPES[path.extname(abs).toLowerCase()];
            if (!stat.isFile() || !type || stat.size > 512 * 1024) return send(res, 400, { error: 'Not an icon.' });
            res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=300', ...securityHeaders(), 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" });
            return fs.createReadStream(abs).pipe(res);
        }
        // Save a folder as a zip: first what it would hold (and what is skipped), then the zip itself, streamed.
        if ((p === '/api/files/zip/plan' || p === '/api/files/zip') && method === 'GET') {
            const rel = url.searchParams.get('path') || '';
            const { abs, stat } = await files.stat(rel);
            if (!stat.isDirectory()) return send(res, 400, { error: 'Not a folder.' });
            const skip = url.searchParams.get('all') === '1' ? [] : zipstream.DEFAULT_SKIP;
            const plan = await zipstream.plan(abs, { skip });
            if (p === '/api/files/zip/plan') return send(res, 200, { files: plan.files, folders: plan.folders, bytes: plan.bytes, links: plan.links, skipped: plan.skipped, tooBig: plan.tooBig, skipList: zipstream.DEFAULT_SKIP });
            if (plan.tooBig) return send(res, 413, { error: 'Too big for one zip (over 65 535 items or 4 GB). Zip a smaller folder, or use a shell.' });
            const name = `${path.basename(abs) || 'root'}.zip`;
            res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            audit.record('activity', 'files-zip', { actor: 'phone', via: 'Files', what: `${rel || '/'} as ${name}: ${plan.files} files, ${Math.round(plan.bytes / 1048576)} MB${skip.length ? '' : ' (everything)'}`, cwd: abs });
            try { await zipstream.write(abs, plan, res); res.end(); } catch (e) { log('files', `zip of ${rel} stopped: ${e.message}`); res.destroy(); }
            return;
        }
        // Transfer links (see /dl above): made from the phone only; listed and revocable while they last.
        if (p === '/api/files/transfer' && method === 'POST') {
            if (String(session.how || '').includes('local token')) return send(res, 403, { error: 'Transfer links are made from the phone.' });
            const b = await readJson(req, 4096); const rel = String(b.path || '');
            const { abs, stat } = await files.stat(rel);
            const kind = stat.isDirectory() ? 'zip' : stat.isFile() ? 'file' : null; if (!kind) return send(res, 400, { error: 'Only a file or a folder can be sent.' });
            const l = transfers.create({ rel, abs, kind, all: !!b.all, once: b.once !== false });
            audit.record('activity', 'transfer-created', { actor: 'phone', via: 'Files', what: `${rel || '/'} as ${l.name}: ${l.once ? 'one download' : 'any number of downloads'}, 2 minutes (link ${l.id})`, cwd: abs });
            return send(res, 201, { ...l, path: `/dl/${l.token}/${encodeURIComponent(l.name)}`, token: undefined });
        }
        if (p === '/api/files/transfers' && method === 'GET') return send(res, 200, { links: transfers.list() });
        { const tm = p.match(/^\/api\/files\/transfers\/([0-9a-f]{10})$/); if (tm && method === 'DELETE') { const r = transfers.revoke(tm[1]); audit.record('activity', 'transfer-revoked', { actor: 'phone', via: 'Files', what: `link ${tm[1]}` }); return send(res, 200, r); } }
        // AI prompts: the master prompts, your versions, and what an update changed.
        if (p === '/api/prompts' && method === 'GET') return send(res, 200, promptsLib.list());
        { const pm = p.match(/^\/api\/prompts\/([a-z0-9-]{2,40})(?:\/(reset|keep|restore))?$/);
          if (pm) {
            if (!pm[2] && method === 'GET') return send(res, 200, promptsLib.get(pm[1]));
            if (!pm[2] && method === 'PUT') return send(res, 200, promptsLib.save(pm[1], await readJson(req, 256 * 1024)));
            if (pm[2] === 'reset' && method === 'POST') return send(res, 200, promptsLib.reset(pm[1]));
            if (pm[2] === 'keep' && method === 'POST') return send(res, 200, promptsLib.acknowledge(pm[1]));
            if (pm[2] === 'restore' && method === 'POST') return send(res, 200, promptsLib.restore(pm[1], (await readJson(req, 4096)).i));
          } }
        // Interface preferences (Files: hidden items), the same on every device.
        if (p === '/api/prefs' && method === 'GET') return send(res, 200, prefs.get());
        if (p === '/api/prefs' && method === 'PUT') return send(res, 200, prefs.set(await readJson(req, 8192)));
        if (p === '/api/files/download' && method === 'GET') {
            const { abs, stat } = await files.stat(url.searchParams.get('path') || '');
            if (!stat.isFile()) return send(res, 400, { error: 'Not a file.' });
            const inline = url.searchParams.get('inline') === '1';
            const ext = path.extname(abs).toLowerCase();
            // Active content (html/svg/xml/js) is shown as plain text and sandboxed, so a file written by any process
            // on the box can never run script in PlatOpypus's origin with the session cookie.
            const active = ['.html', '.htm', '.xhtml', '.svg', '.xml', '.js', '.mjs'].includes(ext);
            const mime = inline ? (active ? 'text/plain; charset=utf-8' : (files.mimeByExt[ext] || 'application/octet-stream')) : 'application/octet-stream';
            res.writeHead(200, {
                'Content-Type': mime,
                'Content-Length': stat.size,
                'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`,
                'Cache-Control': 'no-store',
                ...securityHeaders(),
                'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
            });
            return fs.createReadStream(abs).pipe(res);
        }
        if (p === '/api/files/upload' && method === 'PUT') {
            const r = await files.upload(req, url.searchParams.get('path') || '.', url.searchParams.get('name') || '', url.searchParams.get('overwrite') === '1');
            return send(res, 201, r);
        }
        if (p === '/api/files/read' && method === 'GET') return send(res, 200, await files.read(url.searchParams.get('path') || ''));
        if (p === '/api/files/write' && method === 'PUT') {
            const b = await readJson(req, 3 * 1024 * 1024);
            return send(res, 200, await files.write(b.path, b.content, b.mtime));
        }
        if (p === '/api/files/create' && method === 'POST') {
            const b = await readJson(req);
            return send(res, 201, await files.create(b.path || '.', b.name));
        }
        if (p === '/api/files/mkdir' && method === 'POST') {
            const b = await readJson(req);
            return send(res, 201, await files.mkdir(b.path || '.', b.name));
        }
        if (p === '/api/files/rename' && method === 'POST') {
            const b = await readJson(req);
            return send(res, 200, await files.rename(b.path, b.name));
        }
        if (p === '/api/files/move' && method === 'POST') {
            const b = await readJson(req);
            return send(res, 200, await files.move(b.path, b.to));
        }
        if (p === '/api/files/trash' && method === 'POST') {
            const b = await readJson(req);
            return send(res, 200, await files.trash(b.path));
        }

        // Tunnels
        // Share on your own domain (named Cloudflare tunnel + DNS + nginx block)
        if (p === '/api/zoned' && method === 'GET') return send(res, 200, await zoned.list());
        if (p === '/api/zoned/prereq' && method === 'GET') return send(res, 200, await zoned.prereq());
        if (p === '/api/zoned/repoint' && method === 'POST') return send(res, 200, await zoned.repoint({ force: true }));
        if (p === '/api/zoned' && method === 'POST') { const b = await readJson(req); return send(res, 201, await zoned.create({ port: b.port, hostname: b.hostname, name: b.name })); }
        if ((m = p.match(/^\/api\/zoned\/([a-z0-9-]{1,50})$/)) && method === 'DELETE') { await zoned.remove(m[1]); return send(res, 200, { ok: true }); }
        if (p === '/api/tunnels' && method === 'GET') {
            const [list, ports] = await Promise.all([tunnels.list(), tunnels.listeningPorts()]);
            const tunnelled = new Set(list.map(t => t.port));
            return send(res, 200, { tunnels: list, ports: ports.filter(x => !tunnelled.has(x.port)) });
        }
        if (p === '/api/tunnels' && method === 'POST') { const b = await readJson(req); return send(res, 201, await tunnels.create({ port: b.port, name: b.name, ttlMinutes: b.ttlMinutes })); }
        if ((m = p.match(/^\/api\/tunnels\/(\d+)$/)) && method === 'DELETE') {
            await tunnels.close(m[1]);
            return send(res, 200, { ok: true });
        }
        if ((m = p.match(/^\/api\/tunnels\/(\d+)\/extend$/)) && method === 'POST') {
            const b = await readJson(req);
            return send(res, 200, await tunnels.extend(m[1], b.minutes || 240));
        }

        // Vault
        if (p === '/api/vault/derive' && method === 'POST') return send(res, 200, await derive.run(await readJson(req, 64 * 1024)));
        if (p === '/api/vault/catalog' && method === 'GET') return send(res, 200, { services: catalog.publicCatalog(), styles: Object.fromEntries(Object.entries(catalog.AUTH_STYLES).map(([k, v]) => [k, { title: v.title, fields: v.fields }])) });
        if (p === '/api/vault' && method === 'GET') return send(res, 200, vault.list());
        if ((m = p.match(/^\/api\/vault\/([a-f0-9]+)\/oauth\/start$/)) && method === 'POST') { const { origin } = creds.rp(req); return send(res, 200, vault.authorizeUrl(m[1], origin)); }
        if ((m = p.match(/^\/api\/vault\/([a-f0-9]+)\/refresh$/)) && method === 'POST') return send(res, 200, await vault.refresh(m[1]));
        if (p === '/api/vault' && method === 'POST') return send(res, 201, vault.create(await readJson(req, 256 * 1024)));
        if ((m = p.match(/^\/api\/vault\/([a-f0-9]+)$/)) && method === 'PUT') return send(res, 200, vault.update(m[1], await readJson(req, 256 * 1024)));
        if ((m = p.match(/^\/api\/vault\/([a-f0-9]+)$/)) && method === 'DELETE') { vault.remove(m[1]); return send(res, 200, { ok: true }); }
        if ((m = p.match(/^\/api\/vault\/([a-f0-9]+)\/reveal$/)) && method === 'POST') { const b = await readJson(req, 1024); return send(res, 200, await vault.reveal(m[1], auth.clientAddr(req), b.field || null)); }

        // Docker
        if (p === '/api/docker' && method === 'GET') {
            if (!(await dockerMgr.available())) return send(res, 200, { available: false, containers: [], compose: [] });
            const [containers, compose] = await Promise.all([dockerMgr.containers(), dockerMgr.composeProjects()]);
            return send(res, 200, { available: true, containers, compose });
        }
        if (p === '/api/docker/run' && method === 'POST') return send(res, 201, await dockerMgr.quickRun(await readJson(req), files.resolveInRoot));
        if (p === '/api/docker/inspect' && method === 'POST') return send(res, 200, await dockerMgr.inspectImage((await readJson(req)).image));
        if ((m = p.match(/^\/api\/docker\/containers\/([^/]+)\/(start|stop|restart|remove)$/)) && method === 'POST') {
            await dockerMgr.action(decodeURIComponent(m[1]), m[2]);
            return send(res, 200, { ok: true });
        }
        if ((m = p.match(/^\/api\/docker\/containers\/([^/]+)\/logs$/)) && method === 'GET') {
            return send(res, 200, await dockerMgr.logs(decodeURIComponent(m[1]), url.searchParams.get('tail') || 200));
        }
        if ((m = p.match(/^\/api\/docker\/compose\/([^/]+)\/(up|down|restart|pull)$/)) && method === 'POST') {
            await dockerMgr.composeAction(decodeURIComponent(m[1]), m[2]);
            return send(res, 200, { ok: true });
        }

        // Security (two-step codes)
        if (p === '/api/security' && method === 'GET') return send(res, 200, { ...creds.summary(true), sessions: auth.sessionCount() });
        if (p === '/api/security/passkey/options' && method === 'POST') return send(res, 200, await creds.registrationOptions(req, (await readJson(req, 4096)).name));
        if (p === '/api/security/passkey/verify' && method === 'POST') { const pk = await creds.registrationVerify(req, (await readJson(req, 64 * 1024)).response); auth.revokeOtherSessions(req); return send(res, 201, pk); }
        if ((m = p.match(/^\/api\/security\/passkey\/([A-Za-z0-9_-]+)$/)) && method === 'DELETE') { creds.removePasskey(m[1]); auth.revokeOtherSessions(req); return send(res, 200, { ok: true }); }
        if ((m = p.match(/^\/api\/security\/passkey\/([A-Za-z0-9_-]+)$/)) && method === 'PUT') { creds.renamePasskey(m[1], (await readJson(req, 4096)).name); return send(res, 200, { ok: true }); }
        if (p === '/api/security/password' && method === 'POST') {
            const b = await readJson(req, 4096);
            if (creds.summary().passwordSet && !creds.verifyPassword(b.current)) return send(res, 401, { error: 'Current password is not right.' });
            creds.setPassword(b.password); auth.revokeOtherSessions(req); return send(res, 200, { ok: true });
        }
        if (p === '/api/security/sessions/revoke-others' && method === 'POST') return send(res, 200, { revoked: auth.revokeOtherSessions(req) });
        if (p === '/api/security/password' && method === 'DELETE') {
            const b = await readJson(req, 4096);
            if (!creds.verifyPassword(b.current)) return send(res, 401, { error: 'Current password is not right.' });
            creds.clearPassword(); auth.revokeOtherSessions(req); return send(res, 200, { ok: true });
        }
        if (p === '/api/security/totp/setup' && method === 'POST') return send(res, 200, totp.setup(req.headers['x-forwarded-host'] || req.headers.host || 'PlatOpypus'));
        if (p === '/api/security/totp/enable' && method === 'POST') { totp.enable((await readJson(req, 1024)).code); auth.revokeOtherSessions(req); return send(res, 200, { ok: true }); }
        if (p === '/api/security/totp/disable' && method === 'POST') { totp.disable((await readJson(req, 1024)).code); auth.revokeOtherSessions(req); return send(res, 200, { ok: true }); }

        // App catalog
        if (p === '/api/docker/apps' && method === 'GET') return send(res, 200, await apps.list());
        if ((m = p.match(/^\/api\/docker\/apps\/([a-z0-9-]+)$/)) && method === 'POST') {
            const b = await readJson(req, 1024);
            return send(res, 201, await apps.launch(m[1], { tunnel: b.tunnel !== false }));
        }

        // code-server (VS Code in the browser) — off by default
        if (p === '/api/codeserver' && method === 'GET') return send(res, 200, await codeserver.status());
        if (p === '/api/codeserver/start' && method === 'POST') return send(res, 201, await codeserver.start((await readJson(req)).folder));
        if (p === '/api/codeserver/stop' && method === 'POST') return send(res, 200, await codeserver.stop());
        if (p === '/api/codeserver/share' && method === 'POST') return send(res, 201, await codeserver.share());
        if (p === '/api/codeserver/share' && method === 'DELETE') return send(res, 200, await codeserver.unshare());
        if (p === '/api/codeserver/password' && method === 'POST') return send(res, 200, codeserver.revealPassword(auth.clientAddr(req)));
        if (p === '/api/codeserver/password/rotate' && method === 'POST') return send(res, 200, codeserver.rotatePassword());
        if (p === '/api/codeserver/project/start' && method === 'POST') return send(res, 201, await codeserver.startProject((await readJson(req)).folder));
        if ((m = p.match(/^\/api\/codeserver\/project\/([a-z0-9_.-]+)\/(stop|share|unshare|password)$/)) && (method === 'POST' || (method === 'DELETE' && m[2] === 'share'))) {
            const [, name, act] = m;
            if (act === 'stop') return send(res, 200, await codeserver.stopProject(name));
            if (act === 'share') return method === 'DELETE' ? send(res, 200, await codeserver.unshareProject(name)) : send(res, 201, await codeserver.shareProject(name));
            if (act === 'unshare') return send(res, 200, await codeserver.unshareProject(name));
            if (act === 'password') return send(res, 200, codeserver.revealProjectPassword(name, auth.clientAddr(req)));
        }

        // Self-update
        if (p === '/api/update' && method === 'GET') return send(res, 200, update.status());
        if (p === '/api/update/check' && method === 'POST') return send(res, 200, await update.check('manual'));
        if (p === '/api/update/apply' && method === 'POST') return send(res, 202, await update.apply());
        if (p === '/api/update/log' && method === 'GET') { try { return send(res, 200, fs.readFileSync(path.join(config.state, 'update.log'), 'utf8').split('\n').slice(-80).join('\n')); } catch { return send(res, 200, ''); } }

        // AI agents + Claude profiles
        if (p === '/api/agents' && method === 'GET') return send(res, 200, await agents.status());
        if (p === '/api/agents/consult' && method === 'GET') return send(res, 200, consult.settings());
        if (p === '/api/agents/consult' && method === 'PUT') return send(res, 200, consult.configure(await readJson(req, 4096)));
        if (p === '/api/agents/cline' && method === 'GET') return send(res, 200, clineLib.settings());
        if (p === '/api/agents/cline' && method === 'PUT') return send(res, 200, clineLib.configure(await readJson(req, 8192)));
        if (p === '/api/agents/cline/models' && method === 'GET') return send(res, 200, await clineLib.models(url.searchParams.get('endpoint') || ''));
        if (p === '/api/agents/claude/profiles' && method === 'GET') return send(res, 200, agents.listProfiles());
        if (p === '/api/agents/claude/profiles' && method === 'POST') return send(res, 201, agents.createProfile((await readJson(req)).name));
        if ((m = p.match(/^\/api\/agents\/claude\/profiles\/([A-Za-z0-9_-]+)$/)) && method === 'DELETE') { agents.removeProfile(m[1]); return send(res, 200, { ok: true }); }

        // Git / GitHub
        // Project publishing flag (local | private | public). `abs` from box CLIs, `path` (root-relative) from the app.
        if (p === '/api/projects/repo' && method === 'GET') { const rel = url.searchParams.get('path') || '.'; let abs = url.searchParams.get('abs'); if (!abs) { try { abs = files.resolveInRoot(rel); } catch { abs = path.resolve(config.root, rel.replace(/^\/+/, '')); if (!abs.startsWith(config.root)) throw shells.httpError(403, 'Outside the allowed folder.'); } } return send(res, 200, projectFlags.allowPush(abs)); }
        if (p === '/api/projects/repo' && method === 'PUT') { const b = await readJson(req); const abs = b.abs || files.resolveInRoot(b.path || '.'); return send(res, 200, projectFlags.setRepoFlag(abs, b.flag)); }
        if (p === '/api/agent-ready' && (method === 'GET' || method === 'POST')) {
            const rel = method === 'GET' ? (url.searchParams.get('path') || '.') : ((await readJson(req)).path || '.');
            const abs = files.resolveInRoot(rel);
            return send(res, 200, method === 'GET' ? await agentUser.folderReady(abs) : await agentUser.makeReady(abs));
        }
        if (p === '/api/projects/repo/all' && method === 'GET') return send(res, 200, projectFlags.listFlags());
        if (p === '/api/git/status' && method === 'GET') return send(res, 200, await gitMgr.status(url.searchParams.get('path') || '.'));
        if (p === '/api/git/init' && method === 'POST') return send(res, 201, await gitMgr.init((await readJson(req)).path));
        if (p === '/api/git/commit' && method === 'POST') { const b = await readJson(req); return send(res, 200, await gitMgr.commit(b.path, b.message)); }
        if (p === '/api/git/push' && method === 'POST') return send(res, 200, await gitMgr.push((await readJson(req)).path));
        if (p === '/api/git/pull' && method === 'POST') return send(res, 200, await gitMgr.pull((await readJson(req)).path));
        if (p === '/api/git/publish' && method === 'POST') { const b = await readJson(req); return send(res, 201, await gitMgr.publish(b.path, { name: b.name, description: b.description })); }
        if (p === '/api/git/clone' && method === 'POST') { const b = await readJson(req); return send(res, 201, await gitMgr.clone(b.repo, b.dest)); }
        if (p === '/api/github/account' && method === 'GET') return send(res, 200, await gitMgr.account());
        if (p === '/api/github/repos' && method === 'GET') return send(res, 200, await gitMgr.repos());
        if (p === '/api/github/sshkey' && method === 'GET') return send(res, 200, await gitMgr.sshKey());

        // Aggregates for the Home and Services screens
        if (p === '/api/home' && method === 'GET') return send(res, 200, await home.home());
        if (p === '/api/services' && method === 'GET') return send(res, 200, await home.services());

        // Project security profile (level chosen on the phone; brief injected into agent sessions)
        if (p === '/api/portholerun' && method === 'GET') return send(res, 200, await portholerun.plan(url.searchParams.get('abs') || files.resolveInRoot(url.searchParams.get('path') || '')));
        if (p === '/api/portholerun/run' && method === 'POST') { const b = await readJson(req, 4096); return send(res, 200, await portholerun.run(b.abs || files.resolveInRoot(b.path || ''), String(b.hash || ''), { restart: !!b.restart })); }
        if (p === '/api/portholerun/stop' && method === 'POST') { const b = await readJson(req, 4096); return send(res, 200, await portholerun.stop(b.abs || files.resolveInRoot(b.path || ''))); }
        if (p === '/api/projects/upgrade' && method === 'POST') { const b = await readJson(req, 4096); return send(res, 201, await upgrade.upgrade({ from: b.abs || files.resolveInRoot(b.path || ''), name: b.name, level: b.level, audience: b.audience, tier: b.tier })); }
        if (p === '/api/projects/links' && method === 'GET') return send(res, 200, upgrade.linksFor(url.searchParams.get('abs') || files.resolveInRoot(url.searchParams.get('path') || '.')) || {});
        if (p === '/api/projects/profile' && method === 'GET') { const abs = url.searchParams.get('abs') || files.resolveInRoot(url.searchParams.get('path') || '.'); return send(res, 200, { ...profile.get(abs), levels: profile.LEVELS }); }
        if (p === '/api/projects/profile' && method === 'PUT') { const b = await readJson(req, 4096); return send(res, 200, profile.set(b.abs || files.resolveInRoot(b.path || '.'), b)); }
        if (p === '/api/projects/profile/cve-checked' && method === 'POST') { const b = await readJson(req, 4096); return send(res, 200, profile.cveChecked(b.abs || files.resolveInRoot(b.path || '.'))); }

        // Elevation (phone side)
        if (p === '/api/elevate/pending' && method === 'GET') return send(res, 200, elevate.pending());
        if ((m = p.match(/^\/api\/elevate\/([a-f0-9]{12})\/(allow|deny)$/)) && method === 'POST') { const b = await readJson(req, 1024); return send(res, 200, elevate.decide(m[1], { allow: m[2] === 'allow', minutes: Number(b.minutes) || 0 })); }
        if ((m = p.match(/^\/api\/shells\/([^/]+)\/elevation$/)) && method === 'POST') { const b = await readJson(req, 1024); return send(res, 200, { until: elevate.grant(decodeURIComponent(m[1]), b.minutes) }); }
        if (p === '/api/oneshot' && method === 'GET') return send(res, 200, shells.oneshotResults());
        if (p === '/api/agent-user' && method === 'GET') { const a = agentUser.info(); return send(res, 200, a ? { available: true, user: a.user, home: a.home, signedIn: agentUser.signIns(), loginsMoved: agentUser.loginsMoved(), rootLogins: agentUser.rootLogins() } : { available: false }); }
        if ((m = p.match(/^\/api\/agent-user\/(move-logins|undo-move)$/)) && method === 'POST') {
            const list = await shells.list();
            const busy = list.filter(s => (s.kind === 'agent' || s.kind === 'remote-control') && (m[1] === 'move-logins' ? s.runAs !== 'agent' : s.runAs === 'agent')).map(s => s.name);
            return send(res, 200, m[1] === 'move-logins' ? await agentUser.moveLogins({ busy }) : await agentUser.undoMoveLogins({ busy }));
        }

        // Audit: escalations, credential use, activity (never values or output)
        if (p === '/api/audit' && method === 'GET') {
            const type = url.searchParams.get('type'), project = url.searchParams.get('project');
            const r = audit.query({ type: ['elevate', 'credential', 'activity', 'network'].includes(type) ? type : null, project: project === null ? null : project, limit: url.searchParams.get('limit'), days: url.searchParams.get('days') });
            if (!type || type === 'activity') r.commits = await audit.commits({ project: project === null ? null : project, days: Number(url.searchParams.get('days')) || 14 });
            return send(res, 200, r);
        }

        // Push alerts (Telegram bot from the Vault) and the network egress log
        // 2.0 rename: whether the tmux server still runs on the old socket, and the step that moves it.
        if (p === '/api/rename' && method === 'GET') return send(res, 200, { pending: !!config.renamePending, socket: config.tmuxSocket });
        if (p === '/api/rename/finish' && method === 'POST') return send(res, 200, await live.finishRename());
        // Backups to S3: settings, a storage check, back up / list / restore per project.
        if (p === '/api/backups' && method === 'GET') return send(res, 200, backups.settings());
        if (p === '/api/backups' && method === 'PUT') return send(res, 200, backups.configure(await readJson(req, 8 * 1024)));
        if (p === '/api/backups/check' && method === 'POST') return send(res, 200, await backups.check());
        if ((m = p.match(/^\/api\/backups\/([^/]{1,80})$/)) && method === 'GET') return send(res, 200, await backups.list(decodeURIComponent(m[1])));
        if ((m = p.match(/^\/api\/backups\/([^/]{1,80})$/)) && method === 'POST') return send(res, 200, await backups.backup(decodeURIComponent(m[1])));
        if ((m = p.match(/^\/api\/backups\/([^/]{1,80})\/restore$/)) && method === 'POST') { const b = await readJson(req, 4096); return send(res, 200, await backups.restore(decodeURIComponent(m[1]), String(b.name || ''))); }
        // Research: topics under /Research, the paper's pages, sources, exports, and the asks agents wait on.
        // Apps: optional parts with their own tools, added from the Apps tab (not installed with the box).
        if (p === '/api/addons' && method === 'GET') return send(res, 200, { apps: await addons.list() });
        if ((m = p.match(/^\/api\/addons\/([a-z-]{1,30})\/(add|remove)$/)) && method === 'POST') return send(res, 200, await (m[2] === 'add' ? addons.add(m[1]) : addons.remove(m[1])));
        if ((m = p.match(/^\/api\/addons\/([a-z-]{1,30})\/log$/)) && method === 'GET') return send(res, 200, { log: addons.logTail(m[1]) });
        // Security Lab: engagements, scope (with DNS verification), runs and findings. Needs the add-on.
        if (p === '/api/lab' || p.startsWith('/api/lab/')) {
            if (!(await addons.isAdded('lab'))) return send(res, 409, { error: 'Add Security Lab first (Apps tab).', needApp: 'lab' });
            if (p === '/api/lab' && method === 'GET') return send(res, 200, { engagements: lab.list(), tools: Object.fromEntries(Object.entries(lab.TOOLS).map(([k, t]) => [k, { title: t.title, presets: Object.keys(t.presets), local: !!t.local }])) });
            if (p === '/api/lab' && method === 'POST') return send(res, 201, lab.create(await readJson(req, 4096)));
            const lm = p.match(/^\/api\/lab\/([\w.-]{1,60})(?:\/(.*))?$/);
            if (lm) {
                const [ls, lr = ''] = [lm[1], lm[2] || '']; let x;
                if (lr === '' && method === 'GET') return send(res, 200, lab.detail(ls));
                if (lr === 'scope' && method === 'POST') return send(res, 201, lab.addTarget(ls, await readJson(req, 4096)));
                if (lr === 'scope/remove' && method === 'POST') return send(res, 200, lab.removeTarget(ls, (await readJson(req, 4096)).value));
                if (lr === 'scope/verify' && method === 'POST') return send(res, 200, await lab.verify(ls, (await readJson(req, 4096)).value));
                if (lr === 'run' && method === 'POST') { const b = await readJson(req, 16 * 1024); return send(res, 201, await lab.run(ls, { tool: String(b.tool || ''), preset: b.preset || null, target: b.target || null, args: Array.isArray(b.args) ? b.args : null, by: 'phone' })); }
                if ((x = lr.match(/^run\/(r\d{3,5})$/)) && method === 'GET') return send(res, 200, lab.getRun(ls, x[1]));
                if (lr === 'findings' && method === 'POST') return send(res, 200, lab.setFindings(ls, (await readJson(req, 256 * 1024)).text));
                if (lr === 'delete' && method === 'POST') return send(res, 200, lab.remove(ls, (await readJson(req, 4096)).confirm));
            }
        }
        // Conspiracy: cases, the pinboard, theories, probes. Needs the app.
        // Job Hunt (lib/jobs.js). Files go up as base64 in JSON (CVs, application documents).
        jobs.setAgentRunner(jobsRunner);
        if (p === '/api/jobs' || p.startsWith('/api/jobs/')) {
            if (!(await addons.isAdded('jobs'))) return send(res, 409, { error: 'Add Job Hunt first (Apps tab).', needApp: 'jobs' });
            if (!jobs.ready()) jobs.setup();
            jobs.dedupeOnce();
            const fileOut = (file, type, name, inline = true) => { const st = fs.statSync(file); res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store', ...securityHeaders(), 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'" }); fs.createReadStream(file).pipe(res); };
            const typeOf = f => ({ '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword', '.tex': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' }[path.extname(f).toLowerCase()] || 'application/octet-stream');
            const rest = p.slice('/api/jobs'.length).replace(/^\//, ''); let jm;
            const body = async (n = 64 * 1024) => (method === 'POST' ? await readJson(req, n) : {});
            if (rest === '' && method === 'GET') return send(res, 200, { ...jobs.overview(), stages: jobs.STAGES, statuses: jobs.STATUSES, kinds: jobs.ME_KINDS, advice: jobs.ADVICE.map(a => ({ tag: a.tag, title: a.title })), folder: path.relative(config.root, jobs.ROOT) });
            if (rest === 'settings' && method === 'POST') return send(res, 200, jobs.setSettings(await body()));
            if (rest === 'key' && method === 'POST') { const b = await body(); return send(res, 200, jobs.setKey(String(b.source || ''), b.values || {})); }
            if (rest === 'hunt' && method === 'POST') return send(res, 200, await jobs.hunt('phone'));
            if (rest === 'log' && method === 'GET') return send(res, 200, { log: jobs.readLog(300) });
            if (rest === 'wishes' && method === 'GET') return send(res, 200, { wishes: jobs.wishes() });
            // A wish: kept, then worked by a one-shot agent in the Job Hunt folder (agent user, jobs tools).
            if (rest === 'wish' && method === 'POST') {
                jobs.writeBrief(); const b = await body(); const s = jobs.settings(); const w = jobs.addWish(b.text, 'phone');
                const agent = b.agent || s.agent || 'claude'; const model = b.model ?? s.model ?? '';
                const name = `wish-${w.id.slice(1)}`;
                try { await shells.create({ name, kind: 'agent', agent, model, runAs: 'agent', session: 'jobs', cwd: path.relative(config.root, jobs.ROOT) || 'Jobs', firstPrompt: jobs.wishPrompt(w), oneshot: true }); }
                catch (e) { jobs.finishWish(w.id, { status: 'failed', summary: e.message }); throw e; }
                return send(res, 201, { wish: w, shell: name });
            }
            // Talk to an agent about yourself: an interactive shell that interviews you and fills in Me.
            if (rest === 'me/interview' && method === 'POST') {
                jobs.writeBrief(); const b = await body(); const s = jobs.settings(); const name = `me-${Math.random().toString(36).slice(2, 6)}`;
                const prompt = `Interview me to build my "Me" map for job hunting. Start with me_summary to see what is there. Then ask me about ${b.topic ? `this first: ${String(b.topic).slice(0, 300)}. Then ` : ''}my projects, jobs, education, skills and achievements, one or two questions at a time. For each thing I tell you, save it with add_me (kind, title, summary, level, dates, tags, concrete evidence, links to related items). Push for specifics: what I did myself, results, numbers, tools. Never add anything I did not say. Also answer the open gaps (ask me about them).`;
                await shells.create({ name, kind: 'agent', agent: b.agent || s.agent || 'claude', model: b.model ?? s.model ?? '', runAs: 'agent', session: 'jobs', cwd: path.relative(config.root, jobs.ROOT) || 'Jobs', firstPrompt: prompt });
                return send(res, 201, { shell: name });
            }
            // Agent runs that propose Me items for you to confirm: import a CV, or find your work online. Also a web job search.
            if (rest === 'me/dates' && method === 'POST') { jobs.writeBrief(); const name = await jobsRunner(jobs.datingPrompt(), 'dates'); return send(res, 201, { shell: name }); }
            if (['me/import', 'me/findme', 'websearch'].includes(rest) && method === 'POST') {
                jobs.writeBrief(); const b = await body(); const st = jobs.settings();
                let prompt, label;
                if (rest === 'me/import') { const cv = jobs.cvs().find(x => x.id === b.cv); if (!cv) return send(res, 400, { error: 'Pick a CV file (CV tab: add one first).' }); prompt = jobs.importPrompt(cv, { template: !!b.template }); label = 'import'; }
                else if (rest === 'me/findme') { if (!String(b.name || '').trim()) return send(res, 400, { error: 'Give your name.' }); prompt = jobs.findMePrompt(b); label = 'findme'; }
                else { prompt = jobs.webHuntPrompt(st); label = 'web'; }
                const name = `${label}-${Math.random().toString(36).slice(2, 6)}`;
                await shells.create({ name, kind: 'agent', agent: b.agent || st.agent || 'claude', model: b.model ?? st.model ?? '', runAs: 'agent', session: 'jobs', cwd: path.relative(config.root, jobs.ROOT) || 'Jobs', firstPrompt: prompt, oneshot: true });
                jobs.log({ kind: label === 'web' ? 'hunt' : 'me', by: 'phone', what: label === 'import' ? 'Agent reading a CV into Me' : label === 'findme' ? 'Agent looking for your work online' : 'Agent searching the web for jobs' });
                return send(res, 201, { shell: name });
            }
            if (rest === 'frameworks' && method === 'GET') return send(res, 200, { frameworks: jobs.frameworks() });
            if (rest === 'wants' && method === 'POST') return send(res, 200, jobs.setWants((await body()).wants || [], 'phone'));
            if (rest === 'plan' && method === 'GET') return send(res, 200, { plan: jobs.plan(), kinds: jobs.MILESTONE_KINDS, wantKinds: jobs.WANT_KINDS });
            if (rest === 'plan' && method === 'POST') return send(res, 200, jobs.savePlan(await body(), 'phone'));
            if ((jm = rest.match(/^plan\/milestone\/(s[0-9a-f]{6}|new)$/)) && method === 'POST') return send(res, 200, jobs.setMilestone(jm[1], await body(), 'phone'));
            if (rest === 'plan/adopt' && method === 'POST') return send(res, 200, jobs.adoptWishPlan(String((await body()).wish || ''), 'phone'));
            if (rest === 'plan/update' && method === 'POST') { jobs.writeBrief(); const st = jobs.settings(); const name = `plan-${Math.random().toString(36).slice(2, 6)}`; await shells.create({ name, kind: 'agent', agent: st.agent || 'claude', model: st.model || '', runAs: 'agent', session: 'jobs', cwd: path.relative(config.root, jobs.ROOT) || 'Jobs', firstPrompt: jobs.planPrompt(), oneshot: true }); jobs.log({ kind: 'plan', by: 'phone', what: 'Updating the plan' }); return send(res, 201, { shell: name }); }
            if (rest === 'cpd' && method === 'GET') return send(res, 200, { entries: jobs.cpd(), types: jobs.CPD_TYPES });
            if (rest === 'cpd' && method === 'POST') return send(res, 201, jobs.saveCpd(await body(), 'phone'));
            if ((jm = rest.match(/^cpd\/(p[0-9a-f]{6})\/delete$/)) && method === 'POST') return send(res, 200, jobs.removeCpd(jm[1]));
            if (rest === 'cpd.csv' && method === 'GET') { const csv = jobs.cpdCsv(); res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="cpd-log.csv"', 'Cache-Control': 'no-store', ...securityHeaders() }); return res.end(csv); }
            if (rest === 'cpd/update' && method === 'POST') { jobs.writeBrief(); const st = jobs.settings(); const name = `cpd-${Math.random().toString(36).slice(2, 6)}`; await shells.create({ name, kind: 'agent', agent: st.agent || 'claude', model: st.model || '', runAs: 'agent', session: 'jobs', cwd: path.relative(config.root, jobs.ROOT) || 'Jobs', firstPrompt: jobs.cpdPrompt(), oneshot: true }); jobs.log({ kind: 'cpd', by: 'phone', what: 'Updating Me from the CPD log' }); return send(res, 201, { shell: name }); }
            if (rest === 'notes' && method === 'POST') return send(res, 201, jobs.addNote(await body(), 'phone'));
            if ((jm = rest.match(/^notes\/(n[0-9a-f]{6})\/delete$/)) && method === 'POST') return send(res, 200, jobs.removeNote(jm[1]));
            if (rest === 'code' && method === 'GET') return send(res, 200, { code: jobs.codes(), identities: jobs.settings().gitIdentities || '' });
            if (rest === 'code' && method === 'POST') {
                const ids = url.searchParams.get('identities') || ''; if (ids) jobs.setSettings({ gitIdentities: ids });
                if ((req.headers['content-type'] || '').startsWith('application/json')) { const b = await body(); if (b.identities) jobs.setSettings({ gitIdentities: b.identities }); return send(res, 201, await jobs.addCodeGit(b, 'phone')); }
                return send(res, 201, await jobs.addCodeZip(req, { name: url.searchParams.get('name') || 'code.zip', identities: ids }, 'phone'));
            }
            if ((jm = rest.match(/^code\/(k[0-9a-f]{6})\/(delete|read)$/)) && method === 'POST') { if (jm[2] === 'delete') return send(res, 200, jobs.removeCode(jm[1])); const list = jobs.codes(); const k = list.find(x => x.id === jm[1]); if (!k) return send(res, 404, { error: 'No such code.' }); jobs.writeBrief(); const name = await jobsRunner(jobs.codePrompt(k), `code-${k.id.slice(1)}`); return send(res, 201, { shell: name }); }
            if (rest === 'docs' && method === 'GET') return send(res, 200, { docs: jobs.docs() });
            if (rest === 'docs' && method === 'POST') return send(res, 201, jobs.addDoc(await body(56 * 1024 * 1024), 'phone'));
            if ((jm = rest.match(/^docs\/(d[0-9a-f]{6})\/(delete|file|read)$/))) {
                if (jm[2] === 'delete' && method === 'POST') return send(res, 200, jobs.removeDoc(jm[1]));
                if (jm[2] === 'file' && method === 'GET') { const f = jobs.docPath(jm[1]); return fileOut(f.file, typeOf(f.file), f.name, url.searchParams.get('download') !== '1'); }
                if (jm[2] === 'read' && method === 'POST') {
                    jobs.writeBrief(); const b = await body(); const st = jobs.settings(); const d = jobs.docPath(jm[1]).doc; const name = `doc-${jm[1].slice(1)}-${Math.random().toString(36).slice(2, 4)}`;
                    await shells.create({ name, kind: 'agent', agent: b.agent || st.agent || 'claude', model: b.model ?? st.model ?? '', runAs: 'agent', session: 'jobs', cwd: path.relative(config.root, jobs.ROOT) || 'Jobs', firstPrompt: jobs.docPrompt(d, b.extra || ''), oneshot: true });
                    jobs.log({ kind: 'me', by: 'phone', what: `Agent reading "${d.name}" into Me` }); return send(res, 201, { shell: name });
                }
            }
            if (rest === 'me/verify' && method === 'POST') return send(res, 200, jobs.verifyMany(await body(256 * 1024)));
            if ((jm = rest.match(/^me\/(m[0-9a-f]{6})\/(confirm|reject)$/)) && method === 'POST') return send(res, 200, jobs.verifyMe(jm[1], jm[2]));
            if (rest === 'me' && method === 'GET') return send(res, 200, jobs.me());
            if (rest === 'me' && method === 'POST') return send(res, 201, jobs.addMe(await body(), 'phone'));
            if ((jm = rest.match(/^me\/(m[0-9a-f]{6})\/delete$/)) && method === 'POST') return send(res, 200, jobs.removeMe(jm[1]));
            if ((jm = rest.match(/^gap\/(g[0-9a-f]{6})$/)) && method === 'POST') { const b = await body(); return send(res, 200, jobs.closeGap(jm[1], b)); }
            // The board list: cards only (the advert text, fingerprints and source list come with the job itself).
            if (rest === 'board' && method === 'GET') { const bd = jobs.board(); return send(res, 200, { jobs: bd.jobs.map(({ description, keys, sources, requirements, ...j }) => ({ ...j, nsources: (sources || []).length, nreq: (requirements || []).length })) }); }
            if (rest === 'board/delete' && method === 'POST') { const b = await body(); try { return send(res, 200, jobs.deleteJobs(b.ids || [], { confirm: !!b.confirm }, 'phone')); } catch (e) { if (e.needConfirm) return send(res, 409, { error: e.message, needConfirm: e.needConfirm }); throw e; } }
            if (rest === 'board' && method === 'POST') return send(res, 201, jobs.addJob(await body(256 * 1024), 'phone'));
            if ((jm = rest.match(/^job\/(j[0-9a-f]{6})(?:\/(\w+))?$/))) {
                const [id, op = ''] = [jm[1], jm[2] || ''];
                if (op === '' && method === 'GET') return send(res, 200, { job: jobs.getJob(id), advice: jobs.adviceFor(id), drafts: jobs.drafts(id), plan: jobs.PLAN, detected: jobs.detectFrameworks(id), meVersion: jobs.meVersion(), frameworks: jobs.frameworks().map(f => ({ id: f.id, title: f.title, scale: f.scale })), candidates: jobs.getJob(id).requirements?.length ? jobs.candidates(jobs.getJob(id).requirements) : [], estimate: jobs.getJob(id).salaryMin ? jobs.ukEstimate(jobs.getJob(id).salaryMin, jobs.settings().money) : null });
                if (op === '' && method === 'POST') return send(res, 200, jobs.updateJob(id, await body(), 'phone'));
                if (op === 'advice' && method === 'POST') { const b = await body(); return send(res, 201, { probes: await jobs.askAdvice(id, b, 'phone') }); }
                if (op === 'money' && method === 'POST') return send(res, 200, jobs.setMoney(id, await body(), 'phone'));
                if (op === 'assess' && method === 'POST') {
                    const b = await body(); const j = jobs.getJob(id); const st = jobs.settings(); jobs.writeBrief();
                    if (b.blindOnly) return send(res, 201, await jobs.blindReview(id, String(b.framework || ''), 'phone'));
                    const name = `assess-${id.slice(1)}-${Math.random().toString(36).slice(2, 4)}`;
                    await shells.create({ name, kind: 'agent', agent: b.agent || st.agent || 'claude', model: b.model ?? st.model ?? '', runAs: 'agent', session: 'jobs', cwd: path.relative(config.root, jobs.ROOT) || 'Jobs', firstPrompt: jobs.assessPrompt(j, b.framework || ''), oneshot: true });
                    jobs.log({ kind: 'assess', by: 'phone', what: `${j.title}: framework assessment started` }); return send(res, 201, { shell: name });
                }
                // Cover letters (web/letter.html): read with fit coverage, save, generate, review, restore a version.
                if (op === 'letter' && method === 'GET') { const nm = String(url.searchParams.get('name') || 'cover-letter'); const j = jobs.getJob(id); const sim = await jobs.similarLetters(id); return send(res, 200, { job: { id: j.id, title: j.title, company: j.company || '', url: j.url || '', location: j.location || '', match: j.match || null }, ...jobs.letter(id, nm), coverage: jobs.coverage(id, nm), similar: sim.map(x => ({ title: x.title, company: x.company, label: x.label, score: Math.round(x.score * 100), stage: x.stage || null })) }); }
                if (op === 'letter' && method === 'POST') {
                    const b = await body(512 * 1024); const nm = String(b.name || 'cover-letter');
                    if (!b.action || b.action === 'save') return send(res, 200, jobs.writeLetter(id, nm, b.text, { baseMtime: b.baseMtime }, 'phone'));
                    if (b.action === 'restore') return send(res, 200, jobs.restoreLetter(id, nm, b.version));
                    if (b.action === 'review') return send(res, 201, await jobs.reviewLetter(id, nm, 'phone'));
                    if (b.action === 'generate') {
                        jobs.writeBrief(); const st = jobs.settings(); const name = `letter-${id.slice(1)}-${Math.random().toString(36).slice(2, 4)}`;
                        await shells.create({ name, kind: 'agent', agent: b.agent || st.agent || 'claude', model: b.model ?? st.model ?? '', runAs: 'agent', session: 'jobs', cwd: path.relative(config.root, jobs.ROOT) || 'Jobs', firstPrompt: await jobs.letterPrompt(id, { name: nm, extra: b.extra || '', fresh: !!b.fresh }), oneshot: true });
                        jobs.log({ kind: 'draft', by: 'phone', what: `${jobs.getJob(id).title}: letter generation started` }); return send(res, 201, { shell: name });
                    }
                    return send(res, 400, { error: 'action: save, generate, review or restore.' });
                }
                if (op === 'plan' && method === 'POST') return send(res, 200, jobs.setPlan(id, await body(), 'phone'));
                if (op === 'draft' && method === 'GET') return send(res, 200, { name: url.searchParams.get('name'), text: jobs.readDraft(id, String(url.searchParams.get('name') || '')) });
                // The AI work for a stage: research fans out probes; the others run a one-shot agent that writes drafts.
                if (op === 'work' && method === 'POST') {
                    const b = await body(); const j = jobs.getJob(id); const s = jobs.settings();
                    if (b.stage === 'research') return send(res, 201, { probes: await jobs.askAdvice(id, { topics: ['company', 'role', ...(b.visa ? ['visa'] : []), ...(b.pay ? ['pay'] : [])], extra: b.extra || '' }, 'phone') });
                    const prompt = jobs.stagePrompt(j, String(b.stage || ''), b.extra || ''); jobs.writeBrief();
                    const name = `${String(b.stage).slice(0, 6)}-${id.slice(1)}-${Math.random().toString(36).slice(2, 5)}`;
                    await shells.create({ name, kind: 'agent', agent: b.agent || s.agent || 'claude', model: b.model ?? s.model ?? '', runAs: 'agent', session: 'jobs', cwd: path.relative(config.root, jobs.ROOT) || 'Jobs', firstPrompt: prompt, oneshot: true });
                    jobs.log({ kind: 'plan', by: 'phone', what: `${j.title}: agent started for ${b.stage}` });
                    return send(res, 201, { shell: name });
                }
                if (op === 'estimate' && method === 'POST') { const b = await body(); return send(res, 200, jobs.ukEstimate(b.gross, jobs.settings().money)); }
            }
            if (rest === 'cvs' && method === 'GET') return send(res, 200, { cvs: jobs.cvs() });
            if (rest === 'cvs' && method === 'POST') return send(res, 201, jobs.addCv(await body(22 * 1024 * 1024), 'phone'));
            if ((jm = rest.match(/^cvs\/(c[0-9a-f]{6})(?:\/(delete|file))?$/))) {
                if (!jm[2] && method === 'POST') return send(res, 200, jobs.updateCv(jm[1], await body()));
                if (jm[2] === 'delete' && method === 'POST') return send(res, 200, jobs.removeCv(jm[1]));
                if (jm[2] === 'file' && method === 'GET') { const f = jobs.cvPath(jm[1]); return fileOut(f.file, typeOf(f.file), f.name, url.searchParams.get('download') !== '1'); }
            }
            const tq = url.searchParams.get('t') || undefined;
            if (rest === 'cv' && method === 'GET') return send(res, 200, jobs.cvTemplate(tq));
            if (rest === 'cv/templates' && method === 'POST') { const b = await body(400 * 1024); const t = jobs.createTemplate(b, 'phone'); if (b.fill) { jobs.writeBrief(); jobs.queueFill(t.template.id); } return send(res, 201, t); }
            if ((jm = rest.match(/^cv\/templates\/(t[0-9a-f]{6})(?:\/(delete|duplicate|fill))?$/)) && method === 'POST') { if (jm[2] === 'fill') { jobs.writeBrief(); return send(res, 202, jobs.queueFill(jm[1])); } if (jm[2] === 'delete') { const b = await body(); try { return send(res, 200, jobs.removeTemplate(jm[1], { confirm: !!b.confirm })); } catch (e) { if (e.needConfirm) return send(res, 409, { error: e.message, needConfirm: e.needConfirm }); throw e; } } if (jm[2] === 'duplicate') return send(res, 201, jobs.duplicateTemplate(jm[1], 'phone')); return send(res, 200, jobs.updateTemplateMeta(jm[1], await body())); }
            if (rest === 'cv/templates/delete' && method === 'POST') { const b = await body(); try { return send(res, 200, jobs.removeTemplates(b.ids || [], { confirm: !!b.confirm })); } catch (e) { if (e.needConfirm) return send(res, 409, { error: e.message, needConfirm: e.needConfirm }); throw e; } }
            if (rest === 'cv/design' && method === 'POST') { jobs.writeBrief(); const b = await body(); const name = await jobsRunner(jobs.designPrompt(b), 'cvdesign'); jobs.log({ kind: 'cv', by: 'phone', what: 'Agent designing a CV template' }); return send(res, 201, { shell: name }); }
            if (rest === 'cv/template' && method === 'POST') { const b = await body(400 * 1024); return send(res, 200, jobs.setTemplate({ tex: b.tex || undefined, name: b.name }, 'phone', tq)); }
            if (rest === 'cv/variant' && method === 'POST') { const b = await body(96 * 1024); return send(res, 201, jobs.addVariant(b.section, { ...b, template: b.template || tq }, 'phone')); }
            if (rest === 'cv/variant/delete' && method === 'POST') { const b = await body(); return send(res, 200, jobs.removeVariant(b.section, b.id, b.template || tq)); }
            if (rest === 'cv/render' && method === 'POST') { const b = await body(); return send(res, 200, { tex: jobs.renderCv(b.choice || {}, b.template || tq) }); }
            if (rest === 'cv/preview' && method === 'POST') { const b = await body(); return send(res, 200, await jobs.previewCv(b.choice || {}, b.template || tq)); }
            if (rest === 'cv/preview.pdf' && method === 'GET') return fileOut(jobs.previewFile(tq), 'application/pdf', 'CV preview.pdf');
            if (rest === 'cv/version' && method === 'POST') { const b = await body(); return send(res, 201, await jobs.saveVersion({ ...b, template: b.template || tq }, 'phone')); }
            if ((jm = rest.match(/^cv\/version\/(cv[0-9a-f]{6})\.(pdf|tex)$/)) && method === 'GET') return fileOut(jobs.versionFile(jm[1], jm[2], tq), typeOf(`x.${jm[2]}`), `CV.${jm[2]}`, url.searchParams.get('download') !== '1');
            if (rest === 'apps' && method === 'GET') return send(res, 200, { apps: jobs.applications().map(a => ({ ...a, folder: path.relative(config.root, a.folder) })) });
            if (rest === 'apps' && method === 'POST') { const a = jobs.createApplication(await body(), 'phone'); return send(res, 201, { ...a, folder: path.relative(config.root, a.folder) }); }
            if (rest === 'upcoming' && method === 'GET') return send(res, 200, { upcoming: jobs.upcoming(Number(url.searchParams.get('days')) || 90) });
            if ((jm = rest.match(/^apps\/(a[0-9a-f]{6})\/event(?:\/(e[0-9a-f]{6})\/delete)?$/)) && method === 'POST') return send(res, 200, jm[2] ? jobs.removeEvent(jm[1], jm[2]) : jobs.saveEvent(jm[1], await body(), 'phone'));
            if ((jm = rest.match(/^apps\/(a[0-9a-f]{6})(?:\/(files|file|cv))?$/))) {
                const [id, op = ''] = [jm[1], jm[2] || ''];
                if (op === '' && method === 'POST') return send(res, 200, jobs.updateApplication(id, await body(), 'phone'));
                if (op === 'files' && method === 'GET') { const f = jobs.appFiles(id); return send(res, 200, { ...f, folder: path.relative(config.root, f.folder) }); }
                if (op === 'file' && method === 'POST') return send(res, 201, jobs.saveAppFile(id, await body(70 * 1024 * 1024)));
                if (op === 'file' && method === 'GET') { const f = jobs.appFilePath(id, url.searchParams.get('path')); const ext = path.extname(f).toLowerCase(); const t = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || typeOf(f); return fileOut(f, t, path.basename(f), url.searchParams.get('download') !== '1'); }
                if (op === 'cv' && method === 'POST') { const b = await body(); return send(res, 201, await jobs.cvForApplication(id, b.choice || {}, 'phone', b.template || tq)); }
            }
            return send(res, 404, { error: 'Not found.' });
        }

        // Editor workspaces (lib/kit/workspaces.js): the LaTeX editor on any registered folder (web/editor.html?ws=<id>).
        if ((m = p.match(/^\/api\/ws\/([a-z][a-z0-9-]{1,40})(?:\/(.*))?$/)) && (method === 'GET' || method === 'POST')) {
            const [id, rest = ''] = [m[1], m[2] || '']; let w2;
            if (rest === '' && method === 'GET') return send(res, 200, workspaces.info(id));
            if (rest === 'files' && method === 'GET') return send(res, 200, workspaces.files(id));
            if (rest === 'file' && method === 'GET') return send(res, 200, workspaces.readFile(id, url.searchParams.get('path')));
            if (rest === 'file' && method === 'POST') { const b = await readJson(req, 3 * 1024 * 1024); return send(res, 200, workspaces.writeFile(id, b.path, b.text, { baseMtime: b.baseMtime })); }
            if (rest === 'build' && method === 'POST') return send(res, 200, await workspaces.build(id));
            if (rest === 'spell' && method === 'POST') { const b = await readJson(req, 3 * 1024 * 1024); return send(res, 200, await workspaces.spell(id, b.text || '', b.lang)); }
            if (((w2 = rest.match(/^page\/(\d{1,4})$/)) || rest === 'pdf') && method === 'GET') {
                const file = w2 ? workspaces.pageFile(id, w2[1]) : workspaces.pdfFile(id); const st = fs.statSync(file);
                res.writeHead(200, { 'Content-Type': w2 ? 'image/png' : 'application/pdf', 'Content-Length': st.size, 'Content-Disposition': `inline; filename="${w2 ? `page-${w2[1]}.png` : 'main.pdf'}"`, 'Cache-Control': 'no-store', ...securityHeaders(), 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'" });
                return fs.createReadStream(file).pipe(res);
            }
            return send(res, 404, { error: 'Not found.' });
        }
        if (p === '/api/cases' || p.startsWith('/api/cases/')) {
            if (!(await addons.isAdded('cases'))) return send(res, 409, { error: 'Add Conspiracy first (Apps tab).', needApp: 'cases' });
            if (p === '/api/cases' && method === 'GET') return send(res, 200, { cases: cases.list(), kinds: cases.KINDS });
            if (p === '/api/cases' && method === 'POST') return send(res, 201, cases.create(await readJson(req, 8192)));
            const cm = p.match(/^\/api\/cases\/([\w.-]{1,60})(?:\/(.*))?$/);
            if (cm) {
                const cs = cm[1], cr = cm[2] || ''; let x;
                const body = () => readJson(req, 256 * 1024);
                if (cr === '' && method === 'GET') return send(res, 200, cases.detail(cs));
                if (cr === '' && method === 'PUT') return send(res, 200, cases.setMeta(cs, await body()));
                if (cr === 'notes' && method === 'PUT') { const r = cases.setNotes(cs, (await body()).text); cases.logEvent(cs, { kind: 'note', by: 'phone', what: 'Notes edited' }); return send(res, 200, r); }
                if (cr === 'log' && method === 'GET') return send(res, 200, cases.readLog(cs));
                if (cr === 'todo' && method === 'GET') return send(res, 200, { todo: cases.todo(cs) });
                if (cr === 'delete' && method === 'POST') return send(res, 200, cases.remove(cs, (await body()).confirm));
                if (cr === 'export' && method === 'GET') { const e = cases.exportMarkdown(cs); res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${e.name}"`, 'Cache-Control': 'no-store' }); return res.end(e.text); }
                if (cr === 'nodes' && method === 'POST') return send(res, 201, await cases.addNode(cs, await body()));
                if ((x = cr.match(/^nodes\/(n[0-9a-f]{6})$/))) { if (method === 'PUT') return send(res, 200, await cases.updateNode(cs, x[1], await body())); if (method === 'DELETE') return send(res, 200, await cases.removeNode(cs, x[1])); }
                if (cr === 'links' && method === 'POST') return send(res, 201, await cases.addLink(cs, await body()));
                if ((x = cr.match(/^links\/(l[0-9a-f]{6})$/))) { if (method === 'PUT') return send(res, 200, await cases.updateLink(cs, x[1], await body())); if (method === 'DELETE') return send(res, 200, await cases.removeLink(cs, x[1])); }
                if (cr === 'sources' && method === 'POST') return send(res, 201, await cases.addSource(cs, await body()));
                if ((x = cr.match(/^sources\/(S\d{1,5})$/)) && method === 'DELETE') return send(res, 200, await cases.removeSource(cs, x[1]));
                if (cr === 'questions' && method === 'POST') return send(res, 201, await cases.addQuestion(cs, await body()));
                if ((x = cr.match(/^questions\/(Q\d{1,5})$/)) && method === 'PUT') return send(res, 200, await cases.answerQuestion(cs, x[1], await body()));
                if (cr === 'theories' && method === 'POST') return send(res, 201, await cases.addTheory(cs, await body()));
                if ((x = cr.match(/^theories\/(T\d{1,3})$/))) { if (method === 'PUT') return send(res, 200, await cases.weigh(cs, x[1], await body())); if (method === 'DELETE') return send(res, 200, await cases.removeTheory(cs, x[1])); }
                if (cr === 'paths' && method === 'POST') { const b = await body(); return send(res, 200, cases.paths(cs, b.from, b.to)); }
                if (cr === 'probes' && method === 'POST') return send(res, 201, await cases.probe(cs, await body()));
                if (cr === 'asks' && method === 'POST') return send(res, 201, await cases.ask(cs, await body()));
                if ((x = cr.match(/^probes\/(p\d{1,5})$/)) && method === 'GET') return send(res, 200, cases.getProbe(cs, x[1]));
            }
        }
        // Research screens need the Research app.
        if ((p === '/api/research' || p.startsWith('/api/research/')) && !(await addons.isAdded('research'))) return send(res, 409, { error: 'Add the Research app first (Apps tab).', needApp: 'research' });
        if (p === '/api/research' && method === 'GET') return send(res, 200, { topics: research.list(), asks: research.pendingAsks() });
        if (p === '/api/research' && method === 'POST') return send(res, 201, await research.create(await readJson(req, 16 * 1024)));
        if (p === '/api/research-settings' && method === 'GET') return send(res, 200, { ...research.settings(), runner: research.runner() });
        if (p === '/api/research-settings' && method === 'PUT') return send(res, 200, research.setSettings(await readJson(req, 4096)));
        if (p === '/api/research/tools' && method === 'GET') return send(res, 200, await (await import('./lib/researchtools.js')).doctor());
        if (p === '/api/research/asks' && method === 'GET') return send(res, 200, research.pendingAsks());
        if ((m = p.match(/^\/api\/research\/([\w.-]{1,60})(?:\/(.*))?$/)) && (method === 'GET' || method === 'POST')) {
            const [slug, rest = ''] = [m[1], m[2] || ''];
            const sendFile = (file, type, name, { inline = false, remove = false } = {}) => {
                const st = fs.statSync(file);
                res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store', ...securityHeaders(), 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'" });
                const rs = fs.createReadStream(file); rs.pipe(res); if (remove) res.on('close', () => fs.rm(file, { force: true }, () => {}));
            };
            let r2;
            if (rest === '' && method === 'GET') return send(res, 200, research.detail(slug));
            if (rest === 'files' && method === 'GET') return send(res, 200, { files: editor.files(slug), bib: editor.bibEntries(slug), lang: editor.language(slug), langs: editor.LANGS });
            if (rest === 'language' && method === 'POST') return send(res, 200, editor.setLanguage(slug, String((await readJson(req, 4096)).lang || '')));
            if (rest === 'spell' && method === 'POST') return send(res, 200, await editor.spell(slug, (await readJson(req, 3 * 1024 * 1024)).text || ''));
            if (rest === 'spell/learn' && method === 'POST') return send(res, 200, editor.learnWord(slug, (await readJson(req, 4096)).word));
            if (rest === 'file' && method === 'GET') return send(res, 200, editor.readFile(slug, url.searchParams.get('path')));
            if (rest === 'file' && method === 'POST') { const b = await readJson(req, 3 * 1024 * 1024); return send(res, 200, editor.writeFile(slug, b.path, b.text, { baseMtime: b.baseMtime })); }
            if (rest === 'section' && method === 'POST') return send(res, 201, editor.newSection(slug, (await readJson(req, 4096)).name));
            if (rest === 'cite' && method === 'POST') { const b = await readJson(req, 8192); return send(res, 200, editor.citeSource(slug, String(b.id || ''), { at: b.at || null, page: b.page || null, claim: b.claim || '' })); }
            if (rest === 'sources' && method === 'POST') { const b = await readJson(req, 8192); return send(res, 201, await editor.addSource(slug, b.url, b.note)); }
            if (rest === 'upload' && method === 'POST') return send(res, 201, await repo.upload(slug, req, url.searchParams.get('name') || ''));
            if (rest === 'commit' && method === 'POST') return send(res, 200, await repo.commit(slug, (await readJson(req, 4096).catch(() => ({}))).message));
            if (rest === 'diff' && method === 'GET') return send(res, 200, await repo.diff(slug, url.searchParams.get('version') || ''));
            if (rest === 'citecheck' && method === 'GET') return send(res, 200, { scan: editor.citeScan(slug), ...qa.checkReport(slug) });
            if (rest === 'citecheck' && method === 'POST') { const b = await readJson(req, 4096).catch(() => ({})); return send(res, 201, await qa.check(slug, { agent: b.agent, scan: editor.citeScan(slug) })); }
            if (rest === 'versions' && method === 'GET') return send(res, 200, await repo.state(slug));
            if (rest === 'revert' && method === 'POST') return send(res, 200, await repo.revert(slug));
            if (rest === 'edits' && method === 'POST') { const b = await readJson(req, 64 * 1024); return send(res, 201, await qa.edit(slug, b.text, { agent: b.agent, file: b.file, selection: b.selection })); }
            if (rest === 'history' && method === 'GET') return send(res, 200, { versions: await repo.history(slug) });
            if (rest === 'questions' && method === 'GET') return send(res, 200, { questions: qa.list(slug) });
            if (rest === 'questions' && method === 'POST') { const b = await readJson(req, 8192); return send(res, 201, await qa.ask(slug, b.text, { agent: b.agent })); }
            if ((r2 = rest.match(/^questions\/([a-f0-9]{10})\/(add|remove)$/)) && method === 'POST') { const b = await readJson(req, 4096).catch(() => ({})); return send(res, 200, r2[2] === 'add' ? await qa.addToPaper(slug, r2[1], { agent: b.agent }) : qa.remove(slug, r2[1])); }
            if (rest === 'template' && method === 'GET') return send(res, 200, template.get(slug));
            if (rest === 'template' && method === 'POST') return send(res, 201, await template.upload(slug, req, url.searchParams.get('name') || '', { adopt: url.searchParams.get('adopt') === '1' }));
            if (rest === 'template/remove' && method === 'POST') return send(res, 200, template.remove(slug));
            if (rest === 'template/notes' && method === 'POST') return send(res, 200, template.setNotes(slug, (await readJson(req, 16 * 1024)).text));
            if (rest === 'template/use-image' && method === 'POST') return send(res, 200, template.useImage(slug, (await readJson(req, 4096)).name));
            if (rest === 'note' && method === 'POST') return send(res, 201, research.addNote(slug, (await readJson(req, 8192)).text));
            if ((r2 = rest.match(/^source\/(s\d{2,4})\/lines\/(\d{1,4})$/)) && method === 'GET') return send(res, 200, await editor.sourceLines(slug, r2[1], r2[2]));
            if ((r2 = rest.match(/^source\/(s\d{2,4})\/record$/)) && method === 'POST') { const b = await readJson(req, 16 * 1024); return send(res, 200, editor.setRecord(slug, r2[1], b.fields || {})); }
            if (rest === 'links' && method === 'GET') return send(res, 200, await editor.links(slug));
            if ((r2 = rest.match(/^source\/(s\d{2,4})\/page\/(\d{1,4})$/)) && method === 'GET') return sendFile(await editor.sourcePage(slug, r2[1], r2[2]), 'image/png', `${r2[1]}-${r2[2]}.png`, { inline: true });
            if (rest === 'delete' && method === 'POST') return send(res, 200, await research.removeTopic(slug, (await readJson(req, 4096)).confirm));
            if ((r2 = rest.match(/^source\/(s\d{2,4})\/uses$/)) && method === 'GET') return send(res, 200, research.sourceUses(slug, r2[1]));
            if ((r2 = rest.match(/^source\/(s\d{2,4})\/delete$/)) && method === 'POST') return send(res, 200, research.removeSource(slug, r2[1]));
            if (rest === 'build' && method === 'POST') { const r = await research.build(slug); if (r.ok) await repo.commit(slug, `Build: ${r.pages} page${r.pages === 1 ? '' : 's'}`).catch(() => {}); return send(res, 200, r); }
            if (rest === 'pdf' && method === 'GET') return sendFile(research.pdfFile(slug), 'application/pdf', `${slug}.pdf`, { inline: url.searchParams.get('download') !== '1' });
            if ((r2 = rest.match(/^page\/(\d{1,4})$/)) && method === 'GET') return sendFile(research.pageFile(slug, r2[1]), 'image/png', `page-${r2[1]}.png`, { inline: true });
            if ((r2 = rest.match(/^source\/(s\d{2,4})$/)) && method === 'GET') return send(res, 200, research.sourceView(slug, r2[1], { from: url.searchParams.get('from') || 0 }));
            if ((r2 = rest.match(/^source\/(s\d{2,4})\/frame\/(f\d{4}\.jpg)$/)) && method === 'GET') return sendFile(research.frameFile(slug, r2[1], r2[2]), 'image/jpeg', r2[2], { inline: true });
            if ((r2 = rest.match(/^source\/(s\d{2,4})\/original$/)) && method === 'GET') return sendFile(research.sourceOriginal(slug, r2[1]), 'application/pdf', `${r2[1]}.pdf`);
            if ((r2 = rest.match(/^export\/(pdf|bib|tex|zip|csv)$/)) && method === 'GET') { const e = await research.exportFile(slug, r2[1]); return sendFile(e.file, e.type, e.name, { remove: !!e.remove }); }
            if ((r2 = rest.match(/^asks\/([a-f0-9]{12})\/(allow|deny)$/)) && method === 'POST') { const b = await readJson(req, 4096).catch(() => ({})); return send(res, 200, research.decide(slug, r2[1], { allow: r2[2] === 'allow', answer: b.answer })); }
        }

        // Keep-alive and power status: is an agent working, is the box kept on, may it be powered off.
        if (p === '/api/keepalive' && method === 'GET') return send(res, 200, { keepAlive: activity.keepAlive() });
        if (p === '/api/keepalive' && method === 'PUT') return send(res, 200, { keepAlive: activity.setKeepAlive(await readJson(req, 4096)) });
        if (p === '/api/keepalive' && method === 'DELETE') return send(res, 200, { keepAlive: activity.clearKeepAlive() });
        if (p === '/api/activity' && method === 'GET') return send(res, 200, await activity.status({}));
        // Power status: one answer to "may this box be powered off now?", the way a health check answers "is it up?".
        // Read-only and the same for every caller: a cloud schedule, cron, a UPS script, a home-automation rule.
        if (p === '/api/power' && method === 'GET') {
            const st = await activity.status({ settle: url.searchParams.get('settle') === '0' ? 0 : 20_000 }); const d = activity.decide(st);
            return send(res, 200, { canPowerOff: !!d.stop, why: d.why, message: d.message, agents: st.agents, keepAlive: st.keepAlive });
        }
        // The same question, asked by whatever is about to act on the answer: this one is recorded and sends the alert.
        if ((p === '/api/power/check' || p === '/api/autostop/check') && method === 'POST') {
            const b = await readJson(req, 4096).catch(() => ({}));
            const st = await activity.status({ settle: b.dry ? 0 : 20_000 });
            const d = activity.decide(st);
            if (!b.dry) {
                audit.record('activity', d.stop ? 'autostop' : 'autostop-skipped', { actor: String(session.how || '').includes('local token') ? 'schedule' : 'phone', via: 'auto-stop', what: d.message });
                await alerts.notifyNow('autostop', d.stop ? 'The box is powering off now (automatic power-off): no agent is working and it is not kept on.' : `${d.message} The automatic power-off was skipped this time.`);
            }
            return send(res, 200, { ...d, canPowerOff: !!d.stop, agents: st.agents, keepAlive: st.keepAlive, dry: !!b.dry });
        }
        // Power off now, from the phone. The app only offers it on a device that has the Start button set up (the
        // control Lambda), so the box can be started again. The box powers itself off; EC2 treats that as a stop.
        if (p === '/api/power/off' && method === 'POST') {
            if (String(session.how || '').includes('local token')) return send(res, 403, { error: 'Power off is for the phone.' });
            const b = await readJson(req, 4096).catch(() => ({}));
            const can = fs.existsSync('/run/systemd/system');
            if (b.dry) return send(res, 200, { dry: true, canPowerOff: can, message: can ? 'The box would power off now.' : 'This box cannot power itself off (no systemd here).' });
            if (!can) return send(res, 409, { error: 'This box cannot power itself off (no systemd here).' });
            audit.record('activity', 'power-off', { actor: 'phone', via: 'More', what: 'Powered off from the phone' });
            await alerts.notifyNow('autostop', 'The box is powering off now: you asked from the phone. Start it again from the Start page.').catch(() => {});
            setTimeout(() => { try { spawnProc('systemctl', ['poweroff'], { detached: true, stdio: 'ignore' }).unref(); } catch { /* reported by the box going away, or not */ } }, 2500);
            return send(res, 200, { ok: true, message: 'Powering off in a few seconds.' });
        }
        // Scheduled routines (More → Schedules).
        if (p === '/api/schedules' && method === 'GET') return send(res, 200, schedules.list());
        if (p === '/api/schedules' && method === 'POST') return send(res, 201, schedules.create(await readJson(req, 96 * 1024)));
        {
            let sm;
            if ((sm = p.match(/^\/api\/schedules\/([a-z0-9][a-z0-9-]{0,47})$/))) {
                if (method === 'GET') return send(res, 200, schedules.get(sm[1]));
                if (method === 'PUT') return send(res, 200, schedules.update(sm[1], await readJson(req, 96 * 1024)));
                if (method === 'DELETE') return send(res, 200, schedules.remove(sm[1]));
            }
            if ((sm = p.match(/^\/api\/schedules\/([a-z0-9][a-z0-9-]{0,47})\/approve$/)) && method === 'POST') return send(res, 200, schedules.approve(sm[1], await readJson(req, 4096)));
            if ((sm = p.match(/^\/api\/schedules\/([a-z0-9][a-z0-9-]{0,47})\/run$/)) && method === 'POST') { const id = sm[1]; const r = schedules.run(id, { why: 'phone' }); r.catch(() => {}); const quick = await Promise.race([r, new Promise(ok => setTimeout(() => ok(null), 400))]); return send(res, 202, { started: true, finished: quick, ...schedules.list().items.find(x => x.id === id) }); }
            if ((sm = p.match(/^\/api\/schedules\/([a-z0-9][a-z0-9-]{0,47})\/runs\/(\d{8}T\d{6}Z)$/)) && method === 'GET') return send(res, 200, schedules.runLog(sm[1], sm[2]));
        }
        // Limit reached: the overload guard (settings, a dry run of what it would stop, and "do it now").
        if (p === '/api/limit' && method === 'GET') return send(res, 200, limit.settings());
        if (p === '/api/limit' && method === 'PUT') return send(res, 200, limit.configure(await readJson(req, 4096)));
        if (p === '/api/limit/run' && method === 'POST') { const b = await readJson(req, 4096).catch(() => ({})); return send(res, 200, await limit.act({ reason: b.dry ? 'preview' : 'asked from the phone', dry: !!b.dry, force: !b.dry })); }
        if (p === '/api/alerts' && method === 'GET') return send(res, 200, alerts.settings());
        if (p === '/api/alerts' && method === 'PUT') return send(res, 200, alerts.configure(await readJson(req, 8 * 1024), req.headers.origin || null));
        if (p === '/api/alerts/test' && method === 'POST') return send(res, 200, await alerts.test());
        if (p === '/api/alerts/chats' && method === 'POST') { const b = await readJson(req, 4096); return send(res, 200, await alerts.chats(String(b.itemId || ''))); }
        if (p === '/api/egress' && method === 'GET') { const pr = url.searchParams.get('project'); return send(res, 200, egress.query({ days: url.searchParams.get('days'), project: pr === null ? null : pr })); }

        // Pins and recents for live-service actions (Home)
        if (p === '/api/quick' && method === 'GET') return send(res, 200, quick.get());
        if (p === '/api/quick/pins' && method === 'POST') return send(res, 201, quick.pin(await readJson(req, 8 * 1024)));
        if ((m = p.match(/^\/api\/quick\/pins\/([a-f0-9]{12})$/)) && method === 'DELETE') return send(res, 200, quick.unpin(m[1]));
        if (p === '/api/quick/recents' && method === 'DELETE') return send(res, 200, quick.clearRecents());

        // Live services (PORTHOLE.md)
        if (p === '/api/live' && method === 'GET') return send(res, 200, await live.list());
        if (p === '/api/live/check' && method === 'GET') return send(res, 200, live.check(url.searchParams.get('abs') || files.resolveInRoot(url.searchParams.get('path') || '.')));
        if ((m = p.match(/^\/api\/live\/([^/]{1,80})\/([a-z0-9-]{1,31})\/(start|stop|restart|hostname)$/)) && method === 'POST') {
            const [proj, key, act] = [decodeURIComponent(m[1]), m[2], m[3]];
            const hb = act === 'hostname' ? await readJson(req, 4096).catch(() => ({})) : {};
            return send(res, 200, act === 'hostname' ? await live.putOnHostname(proj, key, { takeOver: !!hb.takeOver }) : await live[act](proj, key));
        }
        if ((m = p.match(/^\/api\/live\/([^/]{1,80})\/([a-z0-9-]{1,31})\/actions\/(\d{1,3})$/)) && method === 'POST') { const b = await readJson(req, 64 * 1024).catch(() => ({})); return send(res, 200, await live.action(decodeURIComponent(m[1]), m[2], m[3], b?.inputs || {})); }
        if ((m = p.match(/^\/api\/live\/([^/]{1,80})\/([a-z0-9-]{1,31})\/groups\/(\d{1,3})$/)) && method === 'GET') return send(res, 200, await live.groupItems(decodeURIComponent(m[1]), m[2], m[3]));
        if ((m = p.match(/^\/api\/live\/([^/]{1,80})\/([a-z0-9-]{1,31})\/groups\/(\d{1,3})\/actions\/(\d{1,3})$/)) && method === 'POST') { const b = await readJson(req, 64 * 1024).catch(() => ({})); if (typeof b?.item !== 'string' || !b.item) return send(res, 400, { error: 'item: an id from the list, or * for all' }); return send(res, 200, await live.groupAction(decodeURIComponent(m[1]), m[2], m[3], m[4], b.item, b?.inputs || {})); }
        if ((m = p.match(/^\/api\/live\/([^/]{1,80})\/([a-z0-9-]{1,31})\/pull$/)) && method === 'POST') return send(res, 200, await live.pull(decodeURIComponent(m[1]), m[2]));
        if ((m = p.match(/^\/api\/live\/([^/]{1,80})\/([a-z0-9-]{1,31})\/root$/)) && (method === 'POST' || method === 'DELETE')) return send(res, 200, method === 'POST' ? live.approveRoot(decodeURIComponent(m[1]), m[2]) : live.revokeRoot(decodeURIComponent(m[1]), m[2]));
        if ((m = p.match(/^\/api\/live\/([^/]{1,80})\/([a-z0-9-]{1,31})\/credentials\/(\d{1,3})$/)) && method === 'POST') return send(res, 200, await live.credentials(decodeURIComponent(m[1]), m[2], m[3]));
        if ((m = p.match(/^\/api\/live\/([^/]{1,80})\/([a-z0-9-]{1,31})\/logs$/)) && method === 'GET') return send(res, 200, services.logs(services.slugify(`live ${decodeURIComponent(m[1])} ${m[2]}`), url.searchParams.get('tail') || 300));

        // Registered servers (svc CLI / Services tab)
        if (p === '/api/servers' && method === 'GET') return send(res, 200, await services.list());
        if (p === '/api/servers' && method === 'POST') return send(res, 201, await services.add(await readJson(req, 64 * 1024)));
        if (p === '/api/servers/run' && method === 'POST') return send(res, 201, await services.runServer(await readJson(req, 64 * 1024)));
        if ((m = p.match(/^\/api\/servers\/([a-z0-9-]{1,40})\/(stop|start|restart)$/)) && method === 'POST') {
            const slug = services.resolve(m[1]);
            // Live services and .portholerun runs start from their own definitions (settings, Vault values, account),
            // never from the bare command in the registry.
            if (m[2] !== 'stop' && slug.startsWith('live-')) return send(res, 200, await live.restartSlug(slug));
            if (m[2] !== 'stop' && portholerun.isRunSlug(slug)) return send(res, 200, await portholerun.startSlug(slug, { restart: m[2] === 'restart' }));
            if (m[2] !== 'stop' && slug.startsWith('run-')) return send(res, 409, { error: 'Start it from its .portholerun (Files → the project → Run), so it gets its settings and Vault values.' });
            return send(res, 200, await services[m[2]](slug));
        }
        if ((m = p.match(/^\/api\/servers\/([a-z0-9-]{1,40})\/logs$/)) && method === 'GET') return send(res, 200, services.logs(m[1], url.searchParams.get('tail') || 200));
        if ((m = p.match(/^\/api\/servers\/([a-z0-9-]{1,40})$/)) && method === 'DELETE') { await services.remove(m[1]); return send(res, 200, { ok: true }); }

        // Box
        if (p === '/api/status' && method === 'GET') return send(res, 200, await system.status());

        return send(res, 404, { error: 'No such endpoint.' });
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error(err);
        if (!res.headersSent) send(res, status, { error: err.message || 'Something went wrong.', ...(err.needProfile ? { needProfile: true } : {}), ...(err.needAck ? { needAck: err.needAck } : {}), ...(err.existing ? { existing: err.existing } : {}) });
        else res.end();
    }
});

// ---------- WebSocket terminals ----------
// Client → server: text frames with JSON {type:"input",data} | {type:"resize",cols,rows} | {type:"ping"}
// Server → client: binary frames with raw terminal output; text frames with JSON {type:"exit"} etc.

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const m = url.pathname.match(/^\/ws\/shell\/([^/]+)$/);
    if (!m || !auth.authenticate(req) || auth.authenticate(req).agent || !auth.originAllowed(req)) {
        log('ws', `rejected upgrade from ${auth.clientAddr(req)} for ${url.pathname}`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
        wss.emit('connection', ws, req, decodeURIComponent(m[1]), url.searchParams);
    });
});

wss.on('connection', async (ws, req, name, params) => {
    let proc;
    try {
        proc = await shells.attach(name, params.get('cols'), params.get('rows'));
    } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
        ws.close(1008, err.message);
        return;
    }
    log('ws', `attached to "${name}" from ${auth.clientAddr(req)}`);
    let alive = true;

    proc.onData(data => { shared.capture(name, data); if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data, 'utf8'), { binary: true }); });
    // Credentials registered by `credshare` from this shell are pushed as a text frame (tmux may eat the OSC).
    const onCred = c => { if (c.shell === name && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'cred', id: c.id, title: c.title, port: c.port })); };
    shared.events.on('added', onCred);
    proc.onExit(({ exitCode }) => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
            ws.close(1000, 'detached');
        }
    });

    ws.on('message', (raw, isBinary) => {
        if (isBinary) { proc.write(raw.toString('utf8')); return; }
        let msg;
        try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
        if (msg.type === 'input' && typeof msg.data === 'string') proc.write(msg.data);
        else if (msg.type === 'resize') proc.resize(shells.clampInt(msg.cols, 20, 500, 80), shells.clampInt(msg.rows, 5, 300, 24));
        else if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    });
    ws.on('close', () => {
        shared.events.off('added', onCred);
        if (!alive) return;
        alive = false;
        try { proc.kill(); } catch { /* already gone */ }
        log('ws', `detached from "${name}"`);
    });
    ws.on('error', () => ws.close());
});

// Heartbeat so dead phones get cleaned up.
setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.isAlive === false) { ws.terminate(); continue; }
        ws.isAlive = false;
        ws.ping();
    }
}, 30_000);
wss.on('connection', ws => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });

// Tunnel watcher: expiry + "is the process behind this port still there?"
setInterval(() => tunnels.sweep().catch(e => console.error(e)), 10_000);
zoned.ensure().catch(e => console.error(e));
setInterval(() => shells.reapOneshots().catch(e => console.error(e)), 15_000);
try { promptsLib.startup(); } catch (e) { console.error(e); }   // your prompt versions: readable copies and the agents' instruction block
// Conspiracy log: an agent working a case is logged as finished once its shell is gone.
setInterval(() => shells.list().then(l => { const live = new Set(l.map(s => s.name)); cases.sweepAgents(live); const au = agentUser.info(); if (au) clineLib.sweepHubs(au.home, live, au.uid); clineLib.sweepHubs(config.home, live, 0); }).catch(() => {}), 10_000);
setInterval(() => zoned.ensure().catch(e => console.error(e)), 60_000);

// Alerts: audit lines (root requests, links, credential use, new connections), sign-ins, crashed servers, commits.
audit.onRecord(alerts.fromAudit);
auth.events.on('signin', alerts.fromAuth);
auth.events.on('lockout', alerts.fromAuth);
setInterval(() => alerts.checkServers(services).catch(() => {}), 30_000);
setInterval(() => limit.check().catch(() => {}), 30_000);
activity.start();
setInterval(() => backups.tick().catch(() => {}), 60_000);
setInterval(() => { try { schedules.tick(); } catch (e) { console.error(e); } }, 10_000);
setInterval(() => alerts.checkCommits(audit).catch(() => {}), 5 * 60_000);
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { try { egress.stop(); } catch { /* exiting */ } process.exit(0); });

// Daily update check against the public repo (first one a minute after boot).
update.schedule();

function groupExists(name) { try { return fs.readFileSync('/etc/group', 'utf8').split('\n').some(l => l.startsWith(name + ':')); } catch { return false; } }
// PlatOpypus first: raise its own priority (the systemd unit does this too; this covers Docker mode and old units).
try { if (os.getPriority() > -10) os.setPriority(process.pid, -10); } catch { /* not allowed: fine */ }
server.listen(config.port, config.bind, () => {
    log('porthole', `listening on http://${config.bind}:${config.port}  root=${config.root}  state=${config.state}`);
    // iptables rules do not survive a reboot: put the service-account limits back before any live service starts.
    import('./lib/svcuser.js').then(m => { try { if (groupExists(m.GROUP)) m.applyFirewall(); } catch { /* no group yet */ } });
    egress.start().catch(e => log('egress', `not started: ${e.message}`));
    // Live services that were running when the box went down come back (tmux survives a PlatOpypus restart, not a reboot).
    setTimeout(() => live.autostart().catch(e => log('live', `autostart: ${e.message}`)), 15_000).unref();
    if (config.bind !== '127.0.0.1' && config.bind !== '::1') {
        log('porthole', `WARNING: bound to ${config.bind}. Make sure only your private network can reach this port.`);
    }
});
