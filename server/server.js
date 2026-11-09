// PlatOpypus server: static UI + JSON API + WebSocket terminals.
// No framework; Node's http module and `ws` are enough and keep the dependency surface small.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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
const AGENT_ROUTES = [
    ['GET', /^\/api\/me$/], ['GET', /^\/api\/vault$/], ['POST', /^\/api\/agent\/vault$/],
    ['POST', /^\/api\/agent\/elevate$/], ['GET', /^\/api\/agent\/elevate\/[a-f0-9]{12}$/],
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
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob: https://avatars.githubusercontent.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
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
        if (method === 'GET' && !p.startsWith('/api/')) {
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
        if (!res.headersSent) send(res, status, { error: err.message || 'Something went wrong.', ...(err.needProfile ? { needProfile: true } : {}), ...(err.existing ? { existing: err.existing } : {}) });
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
setInterval(() => zoned.ensure().catch(e => console.error(e)), 60_000);

// Alerts: audit lines (root requests, links, credential use, new connections), sign-ins, crashed servers, commits.
audit.onRecord(alerts.fromAudit);
auth.events.on('signin', alerts.fromAuth);
auth.events.on('lockout', alerts.fromAuth);
setInterval(() => alerts.checkServers(services).catch(() => {}), 30_000);
setInterval(() => limit.check().catch(() => {}), 30_000);
setInterval(() => backups.tick().catch(() => {}), 60_000);
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
