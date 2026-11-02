// End-to-end smoke test. Runs inside the container (needs `ws` from the server's node_modules):
//   docker compose exec porthole node /opt/porthole/test/smoke.mjs
// Env: BASE (default http://127.0.0.1:7331), TOKEN (default porthole-test), TUNNEL=0 to skip the Cloudflare step.

import { createRequire } from 'node:module';
const require = createRequire('/opt/porthole/server/package.json');
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://127.0.0.1:7331';
const TOKEN = process.env.TOKEN || 'porthole-test';
const DO_TUNNEL = process.env.TUNNEL !== '0';
let cookie = '';
let failures = 0;

// A previous interrupted run may have left two-step codes enabled; the suite owns this test box, so reset it.
try { const fs = await import('node:fs'); fs.rmSync(`${process.env.HOME || '/root'}/.porthole/security.json`, { force: true }); fs.rmSync(`${process.env.HOME || '/root'}/.porthole/auth-sessions.json`, { force: true }); } catch { /* ignore */ }

function check(name, ok, extra = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
    if (!ok) failures++;
}

async function call(path, { method = 'GET', body, headers = {}, raw = false, noCsrf = false, redirect = 'follow' } = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (!noCsrf) h['X-Porthole'] = '1';
    if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers: h, body, redirect });
    if (raw) return res;
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1. Unauthenticated access is refused.
let r = await call('/api/shells');
check('unauthenticated /api/shells is 401', r.status === 401);

// 2. First run: setup needs the token; a password-only setup is allowed on this test box. Then password login.
const PASSWORD = 'smoke-password-12345';
r = await call('/api/login');
check('fresh box reports setup needed', r.status === 200 && r.body.setup === true, JSON.stringify(r.body));
r = await call('/api/setup/password', { method: 'POST', body: { token: 'nope', password: PASSWORD } });
check('setup with wrong token is 401', r.status === 401);
r = await call('/api/setup/password', { method: 'POST', body: { token: TOKEN, password: 'short' } });
check('setup with short password is 400', r.status === 400);
r = await call('/api/setup/password', { method: 'POST', body: { token: TOKEN, password: PASSWORD } });
check('setup with token + password signs in', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
cookie = (r.headers.get('set-cookie') || '').split(';')[0];
r = await call('/api/setup/password', { method: 'POST', body: { token: TOKEN, password: PASSWORD } });
check('second setup is refused (409)', r.status === 409);
r = await call('/api/login/token', { method: 'POST', body: { token: TOKEN } });
check('loopback token login still works for box CLIs', r.status === 200);
r = await call('/api/logout', { method: 'POST' }); cookie = '';
r = await call('/api/login/password', { method: 'POST', body: { password: 'wrong-password-123' } });
check('wrong password is 401', r.status === 401);
r = await call('/api/login/password', { method: 'POST', body: { password: PASSWORD } });
check('password login ok', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
cookie = (r.headers.get('set-cookie') || '').split(';')[0];
check('session cookie set, HttpOnly+SameSite', /HttpOnly/.test(r.headers.get('set-cookie') || '') && /SameSite=Strict/.test(r.headers.get('set-cookie') || ''));

// 3. CSRF header required on mutations.
r = await call('/api/shells', { method: 'POST', body: { name: 'x' }, noCsrf: true });
check('mutation without X-Porthole header is 403', r.status === 403);

// 4. Shell lifecycle.
await call('/api/shells/smoke', { method: 'DELETE' }).catch(() => {});
r = await call('/api/shells', { method: 'POST', body: { name: 'smoke', kind: 'shell', cwd: '.' } });
check('create shell', r.status === 201, JSON.stringify(r.body));
r = await call('/api/shells', { method: 'POST', body: { name: '../evil', kind: 'shell' } });
check('bad shell name rejected', r.status === 400);
r = await call('/api/shells');
check('shell listed', Array.isArray(r.body) && r.body.some(s => s.name === 'smoke'));

// 5. WebSocket terminal round trip.
const marker = `porthole-${Math.random().toString(36).slice(2, 8)}`;
const wsOut = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/shell/smoke?cols=100&rows=30`, { headers: { cookie, origin: BASE } });
    let buf = '';
    const t = setTimeout(() => { ws.close(); resolve(buf); }, 9000);
    ws.on('open', () => setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: `echo ${marker}\r` })), 2500));
    ws.on('message', (d, isBinary) => { if (isBinary) buf += d.toString('utf8'); if (buf.split(marker).length > 2) { clearTimeout(t); ws.close(); resolve(buf); } });
    ws.on('error', reject);
});
check('terminal echoes command output', wsOut.split(marker).length > 2);
const badWs = await new Promise(resolve => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/shell/smoke`, { headers: { origin: BASE } });
    ws.on('unexpected-response', (_, res) => resolve(res.statusCode));
    ws.on('open', () => resolve('opened'));
    ws.on('error', () => resolve('error'));
});
check('websocket without cookie refused', badWs === 401);

// 5c. tmux mouse toggle round-trips.
r = await call('/api/shells/smoke/mouse', { method: 'POST', body: { on: true } });
check('mouse on', r.status === 200 && r.body.mouse === true, JSON.stringify(r.body));
r = await call('/api/shells/smoke/mouse', { method: 'POST', body: { on: false } });
check('mouse off', r.status === 200 && r.body.mouse === false, JSON.stringify(r.body));

// 6. Scrollback + history endpoints.
r = await call('/api/shells/smoke/scrollback?lines=200');
check('scrollback contains the echoed marker', r.status === 200 && String(r.body).includes(marker));
r = await call('/api/history');
check('history endpoint', r.status === 200 && Array.isArray(r.body.commands) && Array.isArray(r.body.prompts));

// 7. Files: mkdir, upload, list, download, traversal, rename, trash.
await call('/api/files/trash', { method: 'POST', body: { path: 'smoke-dir' } }).catch(() => {});
r = await call('/api/files/mkdir', { method: 'POST', body: { path: '.', name: 'smoke-dir' } });
check('mkdir', r.status === 201, JSON.stringify(r.body));
const payload = Buffer.from(`hello from smoke ${marker}\n`);
r = await call(`/api/files/upload?path=smoke-dir&name=note.txt`, { method: 'PUT', body: payload, headers: { 'Content-Type': 'application/octet-stream' } });
check('upload', r.status === 201 && r.body.size === payload.length, JSON.stringify(r.body));
r = await call(`/api/files/upload?path=smoke-dir&name=note.txt`, { method: 'PUT', body: payload, headers: { 'Content-Type': 'application/octet-stream' } });
check('duplicate upload is 409', r.status === 409);
r = await call('/api/files?path=smoke-dir');
check('list shows uploaded file', r.status === 200 && r.body.items.some(i => i.name === 'note.txt'));
r = await call('/api/files/download?path=smoke-dir/note.txt', { raw: true });
check('download returns bytes', r.status === 200 && (await r.text()).includes(marker));
r = await call('/api/files?path=../../etc');
const fsRootIsSlash = (await call('/api/files?path=.')).body.root === '/';
check('path traversal contained', fsRootIsSlash ? (r.status === 200 && r.body.path === 'etc') : (r.status === 403 || r.status === 404), `root=${fsRootIsSlash ? '/' : 'home'} status ${r.status} path=${r.body?.path}`);
r = await call('/api/files/upload?path=.&name=../../tmp/evil', { method: 'PUT', body: payload });
check('upload name traversal neutralised', r.status === 201 && r.body.path === 'evil' || r.status === 400, JSON.stringify(r.body));
await call('/api/files/trash', { method: 'POST', body: { path: 'evil' } }).catch(() => {});
r = await call('/api/files/rename', { method: 'POST', body: { path: 'smoke-dir/note.txt', name: 'renamed.txt' } });
check('rename', r.status === 200);
r = await call('/api/files/trash', { method: 'POST', body: { path: 'smoke-dir' } });
check('trash moves folder', r.status === 200 && /trash/.test(r.body.trashed));

// 6b. credshare: the sequence is captured server-side and exposed per shell.
const credOut = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/shell/smoke?cols=100&rows=30`, { headers: { cookie, origin: BASE } });
    let buf = '';
    const t = setTimeout(() => { ws.close(); resolve(buf); }, 25000);
    ws.on('message', (d, isBinary) => { if (!isBinary) { try { const m = JSON.parse(d.toString('utf8')); if (m.type === 'cred' && m.id) buf += `<<CRED-PUSH ${m.id}>>`; } catch { /* ignore */ } } });
    ws.on('open', () => setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: `credshare --title "Smoke login" --user alice --pass "$(echo ${Buffer.from(`p@ss-${marker}`).toString('base64')} | base64 -d)" --url https://example.com/login; echo END-$((40+2))-${marker}\r` })), 2500));
    ws.on('message', (d, isBinary) => { if (isBinary) buf += d.toString('utf8'); if (buf.includes(`END-42-${marker}`)) { clearTimeout(t); ws.close(); resolve(buf); } });
    ws.on('error', reject);
});
check('credshare announces the card (OSC or pushed frame) with a value-free confirmation', (credOut.includes('\x1b]777;porthole-cred;') || credOut.includes('<<CRED-PUSH ')) && credOut.includes('shared to the phone') && !credOut.includes('not registered') && !credOut.replace(/\x1b\]777;porthole-cred;[A-Za-z0-9+/=]+(?:\x07|\x1b\\)/g, '').includes(`p@ss-${marker}`), credOut.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-200));
// Registration does not need an attached terminal: share from a fully detached shell via tmux send-keys.
await call('/api/shells/smoke-detached', { method: 'DELETE' }).catch(() => {});
await call('/api/shells', { method: 'POST', body: { name: 'smoke-detached', kind: 'shell', cwd: '.' } });
await sleep(1500);
{ const { execFileSync } = await import('node:child_process'); execFileSync('tmux', ['-L', 'porthole', 'send-keys', '-t', 'smoke-detached:', '-l', `credshare --title "Detached ${marker}" --secret key=abc-${marker} --port 8099\n`]); }
let detachedFound = false;
for (let i = 0; i < 20 && !detachedFound; i++) { await sleep(1000); detachedFound = (await call('/api/creds')).body.some(c => c.title === `Detached ${marker}` && c.port === 8099); }
check('credshare registers without any terminal attached', detachedFound);
{ const c = (await call('/api/creds')).body.find(c => c.title === `Detached ${marker}`); check('shared credential records its project folder and flags a missing public link', !!c && typeof c.project === 'string' && c.localOnly === true && c.openUrl === null, JSON.stringify(c && { project: c.project, localOnly: c.localOnly, openUrl: c.openUrl })); }
await call('/api/shells/smoke-detached', { method: 'DELETE' });
for (const c of (await call('/api/creds')).body.filter(c => c.title === `Detached ${marker}`)) await call(`/api/creds/${c.id}`, { method: 'DELETE' });
r = await call('/api/shells/smoke/creds');
check('shared credentials available per shell', r.status === 200 && r.body.length >= 1 && r.body[0].title === 'Smoke login' && r.body[0].fields.some(f => f.label === 'Password' && f.secret && f.value === `p@ss-${marker}`), JSON.stringify(r.body[0] || null).slice(0, 160));
r = await call('/api/creds');
check('shared credentials listed globally without values', r.status === 200 && r.body.some(c => c.title === 'Smoke login' && c.fields.every(f => f.value === undefined)));
const scId = r.body.find(c => c.title === 'Smoke login')?.id;
r = await call(`/api/creds/${scId}/values`, { method: 'POST' });
check('shared credential values on explicit request', r.status === 200 && r.body.fields.some(f => f.value === `p@ss-${marker}`));
r = await call(`/api/creds/${scId}`, { method: 'DELETE' });
check('shared credential can be forgotten', r.status === 200);

// 6c. Scratch shells: folder created under ~/scratch, deleted when the shell ends.
await call('/api/shells/smoke-scratch', { method: 'DELETE' }).catch(() => {});
r = await call('/api/shells', { method: 'POST', body: { name: 'smoke-scratch', kind: 'shell', scratch: true } });
check('scratch shell created in ~/scratch', r.status === 201 && /\/scratch\//.test(r.body.cwd), JSON.stringify(r.body));
const scratchDir = r.body.cwd;
r = await call(`/api/files?path=${encodeURIComponent(scratchDir.replace(/^\//, ''))}`);
check('scratch folder exists', r.status === 200);
r = await call('/api/shells/smoke-scratch', { method: 'DELETE' });
r = await call(`/api/files?path=${encodeURIComponent(scratchDir.replace(/^\//, ''))}`);
check('scratch folder deleted with the shell', r.status === 404, `status ${r.status}`);

// 6d. Registered servers: run, observe, stop (process group gone), remove.
await call('/api/servers/smoke-srv', { method: 'DELETE' }).catch(() => {});
r = await call('/api/servers/run', { method: 'POST', body: { name: 'Smoke Srv', port: 8123, cmd: ['python3', '-m', 'http.server', '8123'] } });
check('svc run starts a registered server', r.status === 201 && r.body.slug === 'smoke-srv' && r.body.alive === true, JSON.stringify(r.body).slice(0, 200));
let srv = null; for (let i = 0; i < 15; i++) { await sleep(1000); srv = (await call('/api/servers')).body.find(x => x.slug === 'smoke-srv'); if (srv?.listening) break; }
check('registered server is listening on its port', !!srv && srv.listening === true && srv.alive === true, JSON.stringify(srv && { alive: srv.alive, listening: srv.listening, pid: srv.pid }));
r = await call('/api/services'); check('services lists it under servers, not dev servers', r.status === 200 && r.body.servers.some(x => x.slug === 'smoke-srv') && !r.body.devservers.some(d => d.port === 8123), `servers=${r.body.servers?.length} dev=${JSON.stringify(r.body.devservers?.map(d => d.port))}`);
check('services hides system ports from dev servers', Array.isArray(r.body.system) && !r.body.devservers.some(d => /claude|codex|code-server/.test(d.process)));
const srvPid = srv?.pid;
r = await call('/api/servers/smoke-srv/stop', { method: 'POST' });
await sleep(800);
const stillListening = (await call('/api/servers')).body.find(x => x.slug === 'smoke-srv');
check('stop kills the server and frees the port', r.status === 200 && stillListening && stillListening.alive === false && stillListening.listening === false, JSON.stringify(stillListening && { alive: stillListening.alive, listening: stillListening.listening }));
r = await call('/api/servers/smoke-srv/start', { method: 'POST' }); check('start brings it back', r.status === 201 || r.status === 200, JSON.stringify(r.body).slice(0, 120));
{ const { execFileSync } = await import('node:child_process'); const out = execFileSync('svc', ['ls'], { encoding: 'utf8' }); check('svc ls shows it', /Smoke Srv/.test(out), out.trim().slice(0, 120)); }
r = await call('/api/servers/smoke-srv', { method: 'DELETE' }); check('remove forgets it', r.status === 200 && !(await call('/api/servers')).body.some(x => x.slug === 'smoke-srv'));

// 6e. Publishing flag: local by default, gates publish and the global pre-push hook, settable.
await call('/api/files/trash', { method: 'POST', body: { path: 'smoke-repo' } }).catch(() => {});
r = await call('/api/files/mkdir', { method: 'POST', body: { path: '.', name: 'smoke-repo' } });
r = await call('/api/projects/repo?path=smoke-repo'); check('project is local only by default', r.status === 200 && r.body.flag === 'local' && r.body.allowed === false, JSON.stringify(r.body));
const flagDir = r.body.dir; // files root may be / or the home folder
r = await call('/api/git/init', { method: 'POST', body: { path: 'smoke-repo' } });
r = await call('/api/git/publish', { method: 'POST', body: { path: 'smoke-repo', name: 'smoke-repo' } }); check('publish refused while local only', r.status === 409 && /local only/i.test(r.body.error || ''), `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
{
    const { execFileSync } = await import('node:child_process');
    const dir = flagDir; const bare = `/tmp/smoke-bare-${marker}.git`;
    const sh = (cmd) => execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    sh(`git init -q --bare ${bare} && cd ${dir} && git -c user.email=s@x -c user.name=s commit -q --allow-empty -m init && git remote add origin ${bare}`);
    let blocked = false; try { sh(`cd ${dir} && git push -q origin HEAD:main`); } catch (e) { blocked = /push blocked|local only/i.test(String(e.stderr || e.message)); }
    check('global pre-push hook blocks a push from a local-only folder', blocked);
    r = await call('/api/projects/repo', { method: 'PUT', body: { path: 'smoke-repo', flag: 'private' } }); check('flag set to private', r.status === 200 && r.body.flag === 'private');
    let pushed = false; try { sh(`cd ${dir} && git push -q origin HEAD:main`); pushed = true; } catch (e) { pushed = false; }
    check('push allowed once flagged private', pushed);
    r = await call('/api/projects/repo?path=smoke-repo/sub/deeper'); check('sub-folders inherit the flag', r.body.flag === 'private' && r.body.allowed === true);
    sh(`cd ${dir} && mkdir -p .pasted && echo x > .pasted/img.png && git add -A && git status --porcelain`); check('.pasted is ignored by git everywhere', !/pasted/.test(sh(`cd ${dir} && git status --porcelain --ignored=no`)));
    await call('/api/projects/repo', { method: 'PUT', body: { path: 'smoke-repo', flag: 'local' } });
    sh(`rm -rf ${bare}`);
}
await call('/api/files/trash', { method: 'POST', body: { path: 'smoke-repo' } }).catch(() => {});

// 6f. Zoned share: prerequisites and validation (no Cloudflare token in the test vault).
r = await call('/api/zoned/prereq'); check('zoned prereq reports a missing Cloudflare token', r.status === 200 && r.body.ready === false && /Vault/.test(r.body.reason), JSON.stringify(r.body));
r = await call('/api/zoned', { method: 'POST', body: { port: 8123, hostname: 'not a host' } }); check('zoned rejects a bad hostname', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
r = await call('/api/zoned', { method: 'POST', body: { port: 8123, hostname: 'app.example.com' } }); check('zoned refuses without a token (412)', r.status === 412, `${r.status}`);
r = await call('/api/zoned'); check('zoned list is empty', r.status === 200 && Array.isArray(r.body) && r.body.length === 0);

// 7b. Text editor endpoints.
await call('/api/files/trash', { method: 'POST', body: { path: 'smoke-edit' } }).catch(() => {});
await call('/api/files/mkdir', { method: 'POST', body: { path: '.', name: 'smoke-edit' } });
r = await call('/api/files/create', { method: 'POST', body: { path: 'smoke-edit', name: 'notes.md' } });
check('create empty file', r.status === 201 && r.body.path === 'smoke-edit/notes.md', JSON.stringify(r.body));
r = await call('/api/files/create', { method: 'POST', body: { path: 'smoke-edit', name: 'notes.md' } });
check('create existing file is 409', r.status === 409);
r = await call('/api/files/read?path=smoke-edit/notes.md');
check('read empty file', r.status === 200 && r.body.content === '' && typeof r.body.mtime === 'number');
const mtime0 = r.body.mtime;
await sleep(50); // mtime granularity is a kernel tick; real edits are seconds apart
r = await call('/api/files/write', { method: 'PUT', body: { path: 'smoke-edit/notes.md', content: '# hello\n', mtime: mtime0 } });
check('write file', r.status === 200 && r.body.size === 8, JSON.stringify(r.body));
r = await call('/api/files/write', { method: 'PUT', body: { path: 'smoke-edit/notes.md', content: 'stale', mtime: mtime0 } });
check('stale write is 409', r.status === 409);
r = await call('/api/files/read?path=smoke-edit/notes.md');
check('read back content', r.body.content === '# hello\n');
r = await call(`/api/files/upload?path=smoke-edit&name=blob.bin`, { method: 'PUT', body: Buffer.from([0, 1, 2, 3]), headers: { 'Content-Type': 'application/octet-stream' } });
r = await call('/api/files/read?path=smoke-edit/blob.bin');
check('binary file refused by editor', r.status === 415);
await call('/api/files/trash', { method: 'POST', body: { path: 'smoke-edit' } });

// 7c. Git basics (no GitHub needed).
await call('/api/files/trash', { method: 'POST', body: { path: 'smoke-git' } }).catch(() => {});
await call('/api/files/mkdir', { method: 'POST', body: { path: '.', name: 'smoke-git' } });
r = await call('/api/git/status?path=smoke-git');
check('git status on plain folder', r.status === 200 && r.body.repo === false);
r = await call('/api/git/init', { method: 'POST', body: { path: 'smoke-git' } });
check('git init', r.status === 201 && r.body.repo === true && r.body.branch === 'main', JSON.stringify(r.body).slice(0, 200));
await call('/api/files/write', { method: 'PUT', body: { path: 'smoke-git/README.md', content: '# smoke\n' } });
r = await call('/api/git/status?path=smoke-git');
check('git status sees changes', r.body.changed >= 1);
r = await call('/api/git/commit', { method: 'POST', body: { path: 'smoke-git', message: 'smoke commit' } });
check('git commit', r.status === 200 && r.body.changed === 0 && r.body.last?.subject === 'smoke commit', JSON.stringify(r.body).slice(0, 200));
r = await call('/api/git/push', { method: 'POST', body: { path: 'smoke-git' } });
check('push without remote is a clear 400', r.status === 400);
r = await call('/api/github/account');
check('github account endpoint', r.status === 200 && typeof r.body.connected === 'boolean', `connected=${r.body.connected} installed=${r.body.installed}`);
await call('/api/files/trash', { method: 'POST', body: { path: 'smoke-git' } });

// 8. Tunnels.
r = await call('/api/tunnels', { method: 'POST', body: { port: 7331 } });
check('tunnelling Porthole itself is refused', r.status === 403);
r = await call('/api/tunnels');
check('tunnels list has ports array', r.status === 200 && Array.isArray(r.body.ports));
if (DO_TUNNEL) {
    // Start a throwaway HTTP server to expose.
    const http = await import('node:http');
    const srv = http.createServer((_, res) => res.end(`ok ${marker}`)).listen(8099, '127.0.0.1');
    await sleep(300);
    r = await call('/api/tunnels', { method: 'POST', body: { port: 8099, name: 'smoke' } });
    check('tunnel created with URL', r.status === 201 && /trycloudflare\.com/.test(r.body.url || ''), JSON.stringify(r.body));
    if (r.body.url) {
        let fetched = false;
        for (let i = 0; i < 30 && !fetched; i++) {
            await sleep(2500);
            try { const t = await (await fetch(r.body.url)).text(); fetched = t.includes(marker); } catch { /* DNS propagating */ }
        }
        check('tunnel serves the local server publicly', fetched);
    }
    r = await call('/api/tunnels');
    check('tunnel records its owner process', (r.body.tunnels.find(t => t.port === 8099)?.owner || '').length > 0, JSON.stringify(r.body.tunnels[0]));
    r = await call('/api/tunnels/8099', { method: 'DELETE' });
    check('tunnel closed', r.status === 200);
    srv.close();
    // Watcher: a tunnel whose process disappears is closed automatically (after the 60 s grace + two 10 s checks).
    if (process.env.WATCHER !== '0') {
        const srv2 = http.createServer((_, res) => res.end('bye')).listen(8098, '127.0.0.1');
        await sleep(300);
        r = await call('/api/tunnels', { method: 'POST', body: { port: 8098, name: 'watcher-test' } });
        check('watcher test tunnel created', r.status === 201);
        srv2.close();
        let gone = false;
        for (let i = 0; i < 20 && !gone; i++) { await sleep(6000); gone = !(await call('/api/tunnels')).body.tunnels.some(t => t.port === 8098); }
        check('tunnel closed itself when its process died', gone);
    }
}

// 8b. Vault: add, list (masked), export into a new shell, reveal, scope, delete.
r = await call('/api/vault');
for (const it of r.body) if (it.provider === 'smoketest') await call(`/api/vault/${it.id}`, { method: 'DELETE' });
r = await call('/api/vault', { method: 'POST', body: { provider: 'smoketest', name: 'general key', kind: 'api_key', envName: 'SMOKE_GENERAL', scope: 'general', value: 'general-secret-1234' } });
check('vault add general token', r.status === 201 && r.body.hint === '••••1234' && !('value' in r.body), JSON.stringify(r.body));
const generalId = r.body.id;
r = await call('/api/vault', { method: 'POST', body: { provider: 'smoketest', name: 'project key', kind: 'oauth', envName: 'SMOKE_PROJECT', scope: 'smoke-proj', value: '{"access":"abc","refresh":"def"}' } });
check('vault add project-scoped token', r.status === 201, JSON.stringify(r.body));
const projectId = r.body.id;
r = await call('/api/vault', { method: 'POST', body: { provider: 'smoketest', name: 'dup', envName: 'SMOKE_GENERAL', scope: 'general', value: 'x' } });
check('vault duplicate env name rejected', r.status === 409);
r = await call('/api/vault', { method: 'POST', body: { provider: 'smoketest', name: 'bad', envName: 'PATH', scope: 'general', value: 'x' } });
check('vault reserved env name rejected', r.status === 400);
r = await call('/api/vault');
check('vault list is masked', r.status === 200 && r.body.every(i => !('value' in i)));
await call('/api/files/mkdir', { method: 'POST', body: { path: '.', name: 'smoke-proj' } });
await call('/api/shells/smoke-vault', { method: 'DELETE' }).catch(() => {});
r = await call('/api/shells', { method: 'POST', body: { name: 'smoke-vault', kind: 'shell', cwd: 'smoke-proj' } });
check('shell in project folder', r.status === 201, JSON.stringify(r.body));
const envOut = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/shell/smoke-vault?cols=120&rows=30`, { headers: { cookie, origin: BASE } });
    let buf = '';
    const t = setTimeout(() => { ws.close(); resolve(buf); }, 12000);
    ws.on('open', () => setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: `echo "G=$SMOKE_GENERAL P=$SMOKE_PROJECT"; vault ls; vault get SMOKE_PROJECT; echo; echo END-$((40+2))-${marker}\r` })), 2500));
    // "END-42-…" only appears once the command has actually run (the typed line shows "$((40+2))").
    ws.on('message', (d, isBinary) => { if (isBinary) buf += d.toString('utf8'); if (buf.includes(`END-42-${marker}`)) { clearTimeout(t); ws.close(); resolve(buf); } });
    ws.on('error', reject);
});
// tmux redraws can interleave cursor-movement escapes with text, so strip them before matching.
const plainOut = envOut.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][A-Z0-9]/g, '').replace(/\r/g, '');
check('general + project tokens exported into shell env', plainOut.includes('G=general-secret-1234 P={"access"'), plainOut.slice(-300));
check('vault CLI lists and gets inside shell', /SMOKE_GENERAL\s+smoketest/.test(plainOut) && plainOut.includes('{"access":"abc","refresh":"def"}'), plainOut.slice(-400));
r = await call(`/api/vault/${projectId}/reveal`, { method: 'POST' });
check('vault reveal returns value', r.status === 200 && r.body.value === '{"access":"abc","refresh":"def"}');
await call('/api/shells/smoke-vault', { method: 'DELETE' });
await call('/api/files/trash', { method: 'POST', body: { path: 'smoke-proj' } });
r = await call(`/api/vault/${generalId}`, { method: 'DELETE' });
check('vault delete', r.status === 200);
await call(`/api/vault/${projectId}`, { method: 'DELETE' });

// 8b2. Credential catalogue: typed fields, env prefixes, OAuth2 authorize URL.
r = await call('/api/vault/catalog');
check('vault catalogue lists services and styles', r.status === 200 && r.body.services.some(s => s.key === 'spotify') && r.body.styles.oauth2 && r.body.services.some(s => s.key === 'telegram-bot'), `services=${r.body.services?.length}`);
for (const it of (await call('/api/vault')).body) if (['telegram-bot', 'discord-webhook', 'spotify'].includes(it.provider)) await call(`/api/vault/${it.id}`, { method: 'DELETE' });
r = await call('/api/vault', { method: 'POST', body: { provider: 'telegram-bot', style: 'botChat', name: 'My bot', prefix: 'TELEGRAM', scope: 'general', fields: { botToken: '123:abc', chatId: '42' } } });
check('typed credential (telegram bot) saved with two env vars', r.status === 201 && r.body.fields.map(f => f.env).sort().join(',') === 'TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID', JSON.stringify(r.body.fields));
const tgId = r.body.id;
r = await call('/api/vault', { method: 'POST', body: { provider: 'discord-webhook', style: 'webhook', name: 'Alerts', scope: 'general', fields: { url: 'https://discord.com/api/webhooks/1/x' } } });
check('webhook credential saved', r.status === 201 && r.body.fields[0].env === 'DISCORD_WEBHOOK_URL');
const dcId = r.body.id;
r = await call('/api/vault', { method: 'POST', body: { provider: 'spotify', style: 'oauth2', name: 'Spotify', scope: 'general', fields: { clientId: 'cid', clientSecret: 'csecret' } } });
check('oauth2 credential saved, not connected', r.status === 201 && r.body.oauth && r.body.oauth.connected === false, JSON.stringify(r.body.oauth));
const spId = r.body.id;
r = await call(`/api/vault/${spId}/oauth/start`, { method: 'POST' });
check('oauth2 authorize URL built with state + redirect', r.status === 200 && /^https:\/\/accounts\.spotify\.com\/authorize\?/.test(r.body.url) && /state=/.test(r.body.url) && r.body.url.includes(encodeURIComponent('/oauth/callback')), r.body.url?.slice(0, 120));
r = await call('/oauth/callback?code=x&state=bogus', { raw: true, redirect: 'manual' });
check('oauth callback with bad state is rejected (redirects to failed)', r.status === 302 && /oauth=failed/.test(r.headers.get('location') || ''), `status ${r.status} ${r.headers.get('location')}`);
r = await call(`/api/vault/${tgId}/reveal`, { method: 'POST', body: { field: 'chatId' } });
check('reveal a single field', r.status === 200 && r.body.values.TELEGRAM_CHAT_ID === '42');
await call('/api/shells/smoke-vault2', { method: 'DELETE' }).catch(() => {});
r = await call('/api/shells', { method: 'POST', body: { name: 'smoke-vault2', kind: 'shell', cwd: '.' } });
const envOut2 = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/shell/smoke-vault2?cols=120&rows=30`, { headers: { cookie, origin: BASE } });
    let buf = '';
    const t = setTimeout(() => { ws.close(); resolve(buf); }, 12000);
    ws.on('open', () => setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: `echo "T=$TELEGRAM_BOT_TOKEN C=$TELEGRAM_CHAT_ID D=$DISCORD_WEBHOOK_URL S=$SPOTIFY_CLIENT_ID"; echo END-$((40+2))-${marker}\r` })), 2500));
    ws.on('message', (d, isBinary) => { if (isBinary) buf += d.toString('utf8'); if (buf.includes(`END-42-${marker}`)) { clearTimeout(t); ws.close(); resolve(buf); } });
    ws.on('error', reject);
});
const plain2 = envOut2.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
check('typed credentials exported into shell env', plain2.includes('T=123:abc C=42 D=https://discord.com/api/webhooks/1/x S=cid'), plain2.slice(-200));
await call('/api/shells/smoke-vault2', { method: 'DELETE' });
for (const id of [tgId, dcId, spId]) await call(`/api/vault/${id}`, { method: 'DELETE' });

// 8c. Docker (skipped when the daemon is unreachable).
r = await call('/api/docker');
check('docker endpoint', r.status === 200 && Array.isArray(r.body.containers), `available=${r.body.available}`);
if (r.body.available && process.env.DOCKER !== '0') {
    await call('/api/docker/containers/porthole-smoke/remove', { method: 'POST' }).catch(() => {});
    r = await call('/api/docker/run', { method: 'POST', body: { image: 'nginx:alpine', name: 'porthole-smoke', ports: [{ host: 18080, container: 80 }], env: { SMOKE: '1' } } });
    check('docker quick run', r.status === 201, JSON.stringify(r.body));
    r = await call('/api/docker/run', { method: 'POST', body: { image: 'nginx:alpine; rm -rf /', name: 'x' } });
    check('docker bad image rejected', r.status === 400);
    r = await call('/api/docker');
    const c = r.body.containers.find(x => x.name === 'porthole-smoke');
    check('container listed with port', !!c && c.ports.some(p => p.host === 18080), JSON.stringify(c));
    await sleep(1500);
    r = await call('/api/docker/containers/porthole-smoke/logs?tail=50');
    check('container logs', r.status === 200);
    r = await call('/api/docker/containers/porthole-smoke/stop', { method: 'POST' });
    check('container stop', r.status === 200);
    r = await call('/api/docker/containers/porthole-smoke/remove', { method: 'POST' });
    check('container remove', r.status === 200);
}

// 8d. Two-step codes: enable, login needs code, disable.
const totp = await import('/opt/porthole/server/lib/totp.js');
r = await call('/api/security');
check('security status', r.status === 200 && r.body.totp === false);
r = await call('/api/security/totp/setup', { method: 'POST' });
check('totp setup gives secret + otpauth', r.status === 200 && /^otpauth:\/\/totp\//.test(r.body.otpauth));
const secret = r.body.secret;
r = await call('/api/security/totp/enable', { method: 'POST', body: { code: '000000' } });
check('totp enable with wrong code rejected', r.status === 400);
r = await call('/api/security/totp/enable', { method: 'POST', body: { code: totp.code(secret) } });
check('totp enabled', r.status === 200, JSON.stringify(r.body));
const savedCookie = cookie; cookie = '';
r = await call('/api/login/password', { method: 'POST', body: { password: PASSWORD } });
check('password alone yields a ticket when totp on', r.status === 200 && r.body.needCode === true && r.body.ticket, JSON.stringify(r.body));
let ticket = r.body.ticket;
r = await call('/api/login/totp', { method: 'POST', body: { ticket, code: totp.code(secret, Date.now() + 120_000) } });
check('stale code refused', r.status === 401);
await sleep(31_000); // the code used to enable can't be replayed inside its window
r = await call('/api/login/password', { method: 'POST', body: { password: PASSWORD } });
ticket = r.body.ticket;
r = await call('/api/login/totp', { method: 'POST', body: { ticket, code: totp.code(secret) } });
check('ticket + current code signs in', r.status === 200, JSON.stringify(r.body));
cookie = (r.headers.get('set-cookie') || '').split(';')[0] || savedCookie;
await sleep(31_000);
r = await call('/api/security/totp/disable', { method: 'POST', body: { code: totp.code(secret) } });
check('totp disabled', r.status === 200, JSON.stringify(r.body));

// 8e. One-tap apps (small image so the test stays quick).
r = await call('/api/docker/apps');
check('apps catalog', r.status === 200 && r.body.some(a => a.key === 'stirling-pdf'));
if (r.body.length && process.env.DOCKER !== '0' && (await call('/api/docker')).body.available) {
    await call('/api/docker/containers/app-it-tools/remove', { method: 'POST' }).catch(() => {});
    r = await call('/api/docker/apps/it-tools', { method: 'POST', body: { tunnel: true } });
    check('launch it-tools with tunnel', r.status === 201 && r.body.container === 'app-it-tools' && /trycloudflare/.test(r.body.url || ''), JSON.stringify(r.body));
    const port = r.body.hostPort;
    const appUrl = r.body.url;
    r = await call('/api/docker/apps');
    check('catalog shows it running with url', r.body.find(a => a.key === 'it-tools')?.running === true);
    if (appUrl) {
        // The container's port is published by the Docker daemon, not inside this process: the tunnel must still reach it.
        let code = 0;
        for (let i = 0; i < 30 && code !== 200; i++) { await sleep(3000); try { code = (await fetch(appUrl, { redirect: 'follow' })).status; } catch { /* DNS propagating */ } }
        check('container tunnel serves the app publicly', code === 200, `HTTP ${code}`);
    }
    if (port) await call(`/api/tunnels/${port}`, { method: 'DELETE' });
    await call('/api/docker/containers/app-it-tools/remove', { method: 'POST' });
}

// 8f. code-server: off by default; start/stop when installed; share refused when stopped.
r = await call('/api/codeserver');
check('code-server status (off by default)', r.status === 200 && r.body.running === false, JSON.stringify(r.body));
if (r.body.installed) {
    r = await call('/api/codeserver/share', { method: 'POST' });
    check('share refused while stopped', r.status === 409);
    r = await call('/api/codeserver/start', { method: 'POST', body: { folder: '' } });
    check('code-server start', r.status === 201 && r.body.running === true, JSON.stringify(r.body).slice(0, 200));
    let up = false;
    for (let i = 0; i < 20 && !up; i++) { await sleep(1500); try { up = (await fetch('http://127.0.0.1:8443/')).status < 500; } catch { /* booting */ } }
    check('code-server answers on loopback', up);
    r = await call('/api/codeserver/password', { method: 'POST' });
    check('code-server password reveal', r.status === 200 && r.body.password?.length > 10);
    r = await call('/api/codeserver/stop', { method: 'POST' });
    check('code-server stop', r.status === 200 && r.body.running === false);
}

// 8g. Self-update status (no network assumptions).
r = await call('/api/update');
check('update status reports installed version', r.status === 200 && typeof r.body.installed?.version === 'string' && r.body.inProgress === false, JSON.stringify(r.body.installed));

// 9. Status + cleanup + logout.
r = await call('/api/status');
check('status', r.status === 200 && r.body.hostname, `claude=${r.body.claude?.version ?? 'none'} cloudflared=${r.body.cloudflared ?? 'none'}`);
r = await call('/api/shells/smoke', { method: 'DELETE' });
check('kill shell', r.status === 200);
r = await call('/api/logout', { method: 'POST' });
cookie = '';
r = await call('/api/shells');
check('after logout access is 401', r.status === 401);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
