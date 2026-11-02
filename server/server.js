// Porthole server: static UI + JSON API + WebSocket terminals.
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
import { log } from './lib/log.js';

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

// ---------- helpers ----------

const RUNNING_VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '0'; } catch { return '0'; } })();

function send(res, status, body, headers = {}) {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Porthole-Version': RUNNING_VERSION,
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
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
            if (!auth.authenticate(req)) return send(res, 401, 'Sign in to Porthole first, then start the connection again from the Vault.');
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

        if (p === '/api/me' && method === 'GET') return send(res, 200, { ok: true, created: session.created, version: RUNNING_VERSION });

        // Shells
        if (p === '/api/shells' && method === 'GET') return send(res, 200, await shells.list());
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
        if ((m = p.match(/^\/api\/creds\/([a-f0-9]+)\/values$/)) && method === 'POST') { const one = (await shared.list({ values: true })).find(c => c.id === m[1]); if (!one) return send(res, 404, { error: 'No such shared credential.' }); log('credshare', `values of "${one.title}" revealed to ${auth.clientAddr(req)}`); return send(res, 200, one); }
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
        if (p === '/api/files' && method === 'GET') return send(res, 200, await files.list(url.searchParams.get('path') || '.'));
        if (p === '/api/files/download' && method === 'GET') {
            const { abs, stat } = await files.stat(url.searchParams.get('path') || '');
            if (!stat.isFile()) return send(res, 400, { error: 'Not a file.' });
            const inline = url.searchParams.get('inline') === '1';
            const ext = path.extname(abs).toLowerCase();
            // Active content (html/svg/xml/js) is shown as plain text and sandboxed, so a file written by any process
            // on the box can never run script in Porthole's origin with the session cookie.
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
        if (p === '/api/files/trash' && method === 'POST') {
            const b = await readJson(req);
            return send(res, 200, await files.trash(b.path));
        }

        // Tunnels
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
        if (p === '/api/security/totp/setup' && method === 'POST') return send(res, 200, totp.setup(req.headers['x-forwarded-host'] || req.headers.host || 'Porthole'));
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
        if (p === '/api/git/status' && method === 'GET') return send(res, 200, await gitMgr.status(url.searchParams.get('path') || '.'));
        if (p === '/api/git/init' && method === 'POST') return send(res, 201, await gitMgr.init((await readJson(req)).path));
        if (p === '/api/git/commit' && method === 'POST') { const b = await readJson(req); return send(res, 200, await gitMgr.commit(b.path, b.message)); }
        if (p === '/api/git/push' && method === 'POST') return send(res, 200, await gitMgr.push((await readJson(req)).path));
        if (p === '/api/git/pull' && method === 'POST') return send(res, 200, await gitMgr.pull((await readJson(req)).path));
        if (p === '/api/git/publish' && method === 'POST') { const b = await readJson(req); return send(res, 201, await gitMgr.publish(b.path, { name: b.name, isPrivate: b.private !== false, description: b.description })); }
        if (p === '/api/git/clone' && method === 'POST') { const b = await readJson(req); return send(res, 201, await gitMgr.clone(b.repo, b.dest)); }
        if (p === '/api/github/account' && method === 'GET') return send(res, 200, await gitMgr.account());
        if (p === '/api/github/repos' && method === 'GET') return send(res, 200, await gitMgr.repos());
        if (p === '/api/github/sshkey' && method === 'GET') return send(res, 200, await gitMgr.sshKey());

        // Aggregates for the Home and Services screens
        if (p === '/api/home' && method === 'GET') return send(res, 200, await home.home());
        if (p === '/api/services' && method === 'GET') return send(res, 200, await home.services());

        // Registered servers (svc CLI / Services tab)
        if (p === '/api/servers' && method === 'GET') return send(res, 200, await services.list());
        if (p === '/api/servers' && method === 'POST') return send(res, 201, await services.add(await readJson(req, 64 * 1024)));
        if (p === '/api/servers/run' && method === 'POST') return send(res, 201, await services.runServer(await readJson(req, 64 * 1024)));
        if ((m = p.match(/^\/api\/servers\/([a-z0-9-]{1,40})\/(stop|start)$/)) && method === 'POST') return send(res, 200, await services[m[2]](m[1]));
        if ((m = p.match(/^\/api\/servers\/([a-z0-9-]{1,40})\/logs$/)) && method === 'GET') return send(res, 200, services.logs(m[1], url.searchParams.get('tail') || 200));
        if ((m = p.match(/^\/api\/servers\/([a-z0-9-]{1,40})$/)) && method === 'DELETE') { await services.remove(m[1]); return send(res, 200, { ok: true }); }

        // Box
        if (p === '/api/status' && method === 'GET') return send(res, 200, await system.status());

        return send(res, 404, { error: 'No such endpoint.' });
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error(err);
        if (!res.headersSent) send(res, status, { error: err.message || 'Something went wrong.' });
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
    if (!m || !auth.authenticate(req) || !auth.originAllowed(req)) {
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

// Daily update check against the public repo (first one a minute after boot).
update.schedule();

server.listen(config.port, config.bind, () => {
    log('porthole', `listening on http://${config.bind}:${config.port}  root=${config.root}  state=${config.state}`);
    if (config.bind !== '127.0.0.1' && config.bind !== '::1') {
        log('porthole', `WARNING: bound to ${config.bind}. Make sure only your private network can reach this port.`);
    }
});
