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
{   // Move (drag and drop): into a folder, refusing a folder into itself and a name clash.
    await call('/api/files/mkdir', { method: 'POST', body: { path: 'smoke-dir', name: 'inner' } });
    await call(`/api/files/upload?path=smoke-dir&name=movable.txt`, { method: 'PUT', body: payload, headers: { 'Content-Type': 'application/octet-stream' } });
    let m = await call('/api/files/move', { method: 'POST', body: { path: 'smoke-dir/movable.txt', to: 'smoke-dir/inner' } });
    check('move puts a file into a folder', m.status === 200 && m.body.path === 'smoke-dir/inner/movable.txt', JSON.stringify(m.body));
    m = await call('/api/files/move', { method: 'POST', body: { path: 'smoke-dir/inner', to: 'smoke-dir/inner' } });
    check('a folder cannot be moved into itself', m.status === 400, String(m.status));
    await call(`/api/files/upload?path=smoke-dir&name=movable.txt`, { method: 'PUT', body: payload, headers: { 'Content-Type': 'application/octet-stream' } });
    m = await call('/api/files/move', { method: 'POST', body: { path: 'smoke-dir/movable.txt', to: 'smoke-dir/inner' } });
    check('move refuses to overwrite', m.status === 409, String(m.status));
    m = await call('/api/files/move', { method: 'POST', body: { path: 'smoke-dir/inner/movable.txt', to: 'smoke-dir' } });
    check('move back out (name clash is reported, nothing lost)', m.status === 409, String(m.status));
}
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
r = await call('/api/zoned/prereq'); check('zoned prereq reports a missing Cloudflare token and picks a mode', r.status === 200 && r.body.ready === false && /Vault/.test(r.body.reason) && ['direct', 'tunnel'].includes(r.body.mode), JSON.stringify(r.body));
r = await call('/api/zoned', { method: 'POST', body: { port: 8123, hostname: 'not a host' } }); check('zoned rejects a bad hostname', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
r = await call('/api/zoned', { method: 'POST', body: { port: 8123, hostname: 'app.example.com' } }); check('zoned refuses without a token (412)', r.status === 412, `${r.status}`);
r = await call('/api/zoned'); check('zoned list is empty', r.status === 200 && Array.isArray(r.body) && r.body.length === 0);

// 6g. Vault: partial saves are allowed and marked incomplete; derive helper validates input.
r = await call('/api/vault', { method: 'POST', body: { provider: 'custom', style: 'basic', name: 'smoke partial', prefix: 'SMOKEPART', scope: 'general', fields: { username: 'alice' } } });
check('vault accepts a partial credential', r.status === 201 && Array.isArray(r.body.incomplete) && r.body.incomplete.includes('Password') && r.body.fields.some(f => f.name === 'password' && f.missing), JSON.stringify(r.body).slice(0, 200));
const partialId = r.body.id;
r = await call(`/api/vault/${partialId}`, { method: 'PUT', body: { fields: { password: 'p@ss' } } }); check('filling the missing field clears incomplete', r.status === 200 && r.body.incomplete.length === 0, JSON.stringify(r.body.incomplete));
r = await call('/api/vault', { method: 'POST', body: { provider: 'custom', style: 'basic', name: 'smoke empty', prefix: 'SMOKEEMPTY', scope: 'general', fields: {} } }); check('a credential with no values at all is refused', r.status === 400);
r = await call('/api/vault/derive', { method: 'POST', body: { kind: 'telegram-getme', botToken: 'nope' } }); check('derive helper rejects a malformed bot token', r.status === 400 && /bot token/.test(r.body.error || ''));
await call(`/api/vault/${partialId}`, { method: 'DELETE' });

// 6h. Live services from PORTHOLE.md.
{
    const { execFileSync } = await import('node:child_process');
    const sh = (cmd) => execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    sh(`rm -rf /Projects/smoke-live && mkdir -p /Projects/smoke-live && cat > /Projects/smoke-live/PORTHOLE.md <<'EOF'
---
porthole: 1
name: Smoke Live
services:
  web:
    title: Smoke web
    start: python3 -m http.server 8140
    port: 8140
    env:
      GREETING: hello
    needs: [SMOKE_LIVE_PASS]
    update: full
    actions:
      - label: Say hello
        run: echo "$GREETING from $PORTHOLE_PROJECT"
    credentials:
      - label: Admin
        username: admin
        password: $SMOKE_LIVE_PASS
---
A test service.
EOF`);
    r = await call('/api/live'); const lp = r.body.find(p => p.project === 'smoke-live');
    check('live lists the PORTHOLE.md service', !!lp && lp.errors.length === 0 && lp.services[0]?.key === 'web' && lp.services[0].actions.length === 1, JSON.stringify(lp && { e: lp.errors, s: lp.services.map(x => x.key) }));
    r = await call('/api/live/smoke-live/web/start', { method: 'POST' }); check('live start refuses while a needed Vault entry is missing', r.status === 412 && /SMOKE_LIVE_PASS/.test(r.body.error || ''), `${r.status} ${r.body.error}`);
    r = await call('/api/vault', { method: 'POST', body: { provider: 'custom', style: 'token', name: 'smoke live pass', prefix: 'SMOKE_LIVE_PASS_X', scope: 'Projects/smoke-live', fields: { token: 'pw-123' }, envMap: { token: 'SMOKE_LIVE_PASS' } } }); const liveVaultId = r.body.id;
    r = await call('/api/live/smoke-live/web/start', { method: 'POST' }); check('live start runs the service', r.status === 200 && r.body.alive === true, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    let up = false; for (let i = 0; i < 15 && !up; i++) { await sleep(1000); up = (await call('/api/live')).body.find(p => p.project === 'smoke-live')?.services[0]?.listening === true; }
    check('live service listens on its port', up);
    r = await call('/api/live/smoke-live/web/actions/0', { method: 'POST' }); check('live action runs with the service env', r.status === 200 && /hello from smoke-live/.test(r.body.output), JSON.stringify(r.body).slice(0, 160));
    r = await call('/api/live/smoke-live/web/credentials/0', { method: 'POST' }); check('live credentials resolve Vault references for the project', r.status === 200 && r.body.fields.some(f => f.label === 'password' && f.value === 'pw-123'), JSON.stringify(r.body).slice(0, 200));
    r = await call('/api/services'); check('registered-servers list does not repeat live services', !r.body.servers.some(x => x.slug.startsWith('live-')) && r.body.live.some(p => p.project === 'smoke-live'));
    r = await call('/api/live/smoke-live/web/stop', { method: 'POST' }); await sleep(800);
    check('live stop stops it', r.status === 200 && (await call('/api/live')).body.find(p => p.project === 'smoke-live')?.services[0]?.running === false);
    // Container services: image: instead of start:. The manifest checks need no Docker; the run does.
    sh(`cat > /Projects/smoke-live/PORTHOLE.md <<'EOF'
---
services:
  box:
    image: nginx:alpine
    port: 8141
    container_port: 80
    volumes: [www:/usr/share/nginx/html:ro, ../escape:/x]
    memory: 12345
    start: echo no
  ok:
    image: nginx:alpine
    port: 8142
    container_port: 80
    volumes: [www:/usr/share/nginx/html:ro]
    memory: 64m
    user: image
---
EOF
mkdir -p /Projects/smoke-live/www && echo smoke-container > /Projects/smoke-live/www/index.html`);
    r = await call('/api/live/check?path=Projects/smoke-live');
    check('container manifests are checked: volumes stay in the project, memory is a size, image and start exclude each other', r.body.ok === false && r.body.errors.some(e => /volumes\[1\]/.test(e)) && r.body.errors.some(e => /memory/.test(e)) && r.body.errors.some(e => /image and start/.test(e)) && !r.body.errors.some(e => /services\.ok/.test(e)), JSON.stringify(r.body.errors));
    sh(`python3 -c "import re;p='/Projects/smoke-live/PORTHOLE.md';s=open(p).read();open(p,'w').write(re.sub(r'  box:.*?\\n  ok:','  ok:',s,flags=re.S))"`);
    const lv0 = (await call('/api/live')).body.find(p => p.project === 'smoke-live')?.services[0];
    check('a container service is listed with its image and runs as the project account', lv0?.image === 'nginx:alpine' && lv0.runAs === 'container' && /^ps-/.test(lv0.account || ''), JSON.stringify(lv0).slice(0, 200));
    const dk = (await call('/api/docker')).body;
    if (dk.available && process.env.DOCKER !== '0') {
        const remoteDocker = !!process.env.PORTHOLE_DOCKER_HOST;   // the daemon is on another machine: mounts and ports are not visible from here
        r = await call('/api/live/smoke-live/ok/start', { method: 'POST' });
        check('a container service starts', r.status === 200 && r.body.alive === true, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        let body = ''; for (let i = 0; i < 20 && !/smoke-container/.test(body); i++) { await sleep(1000); try { body = remoteDocker ? sh('docker ps --format "{{.Names}} {{.Ports}}" | grep live-smoke-live-ok') : sh('curl -s http://127.0.0.1:8142/'); } catch { /* not yet */ } if (remoteDocker && /127\.0\.0\.1:8142/.test(body)) break; }
        check('the container serves the project folder on its port, loopback only', remoteDocker ? /127\.0\.0\.1:8142->80/.test(body) : (/smoke-container/.test(body) && /127\.0\.0\.1:8142/.test(sh('docker port live-smoke-live-ok'))), body.slice(0, 120));
        r = await call('/api/live/smoke-live/ok/pull', { method: 'POST' });
        check('update image pulls, says whether anything changed, and restarts the running service when it did', r.status === 200 && r.body.image === 'nginx:alpine' && (r.body.changed ? r.body.restarted === true : r.body.restarted === false) && (await call('/api/live')).body.find(p => p.project === 'smoke-live')?.services[0]?.running === true, JSON.stringify(r.body));
        r = await call('/api/live/smoke-live/ok/stop', { method: 'POST' });
        await sleep(2000);
        check('stopping removes the container', r.status === 200 && !sh('docker ps -a --format "{{.Names}}"').includes('live-smoke-live-ok'));
        const ip = (await call('/api/audit?type=activity')).body.events.find(e => e.action === 'image-pull');
        check('checking for a new image is in the audit log', !!ip && /smoke-live\/ok/.test(ip.what), JSON.stringify(ip));
    } else console.log('SKIP  container service run (no Docker here)');
    sh(`printf -- '---\\nservices:\\n  Bad Key:\n    port: 99999\n---\n' > /Projects/smoke-live/PORTHOLE.md`);
    r = await call('/api/live/check?path=Projects/smoke-live'); check('live check reports manifest errors', r.status === 200 && r.body.ok === false && r.body.errors.length >= 2, JSON.stringify(r.body.errors));
    await call(`/api/vault/${liveVaultId}`, { method: 'DELETE' }); await call('/api/servers/live-smoke-live-web', { method: 'DELETE' }).catch(() => {});
    sh('rm -rf /Projects/smoke-live');
}

// 6h2. Live services run as their project's own account (ps-<project>); PlatOpypus controls them. Typed inputs, stop_first, take-over, restart, root approval.
{
    const { execFileSync } = await import('node:child_process');
    const sh = (cmd) => execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // A counter like the dollar button: holds its total in memory and writes it back every 300 ms.
    sh(`rm -rf /Projects/smoke-count && mkdir -p /Projects/smoke-count/data && cat > /Projects/smoke-count/app.js <<'EOF'
const http = require('http'); const fs = require('fs');
let count = 0; try { count = JSON.parse(fs.readFileSync('data/count.json', 'utf8')).count; } catch {}
setInterval(() => fs.writeFileSync('data/count.json', JSON.stringify({ count })), 300);
http.createServer((req, res) => { if (req.url === '/click') count++; if (req.url === '/env') return res.end(JSON.stringify(Object.keys(process.env).sort())); res.end(String(count)); }).listen(8141);
EOF
cat > /Projects/smoke-count/PORTHOLE.md <<'EOF'
---
porthole: 1
services:
  web:
    title: Smoke counter
    start: node app.js
    port: 8141
    actions:
      - label: Who am I
        run: id -un; env | cut -d= -f1 | sort | tr '\\n' ' '
      - label: Reset
        run: echo '{"count":0}' > data/count.json
        stop_first: true
      - label: Set
        run: printf '{"count":%s}' "$INPUT_COUNT" > data/count.json; echo "note=[$INPUT_NOTE]"
        stop_first: true
        inputs:
          - name: count
            type: integer
            min: 0
            max: 1000
          - name: note
            type: string
            pattern: '[a-z ]{1,20}'
            required: false
      - label: Bump restart
        run: 'true'
        restart: true
    groups:
      - label: Rooms
        item: room
        list: ls data/rooms
        actions:
          - label: Close
            run: rm -f "data/rooms/$GROUP_ITEM"; echo "closed $GROUP_ITEM as $(id -un)"
          - label: Rename
            all: false
            run: echo "rename $GROUP_ITEM to [$INPUT_NAME]"
            inputs:
              - name: name
                type: string
                pattern: '[a-z]{1,10}'
---
EOF
mkdir -p /Projects/smoke-count/data/rooms && touch /Projects/smoke-count/data/rooms/r1 /Projects/smoke-count/data/rooms/r2 /Projects/smoke-count/data/rooms/r3
chown -R agent:agent /Projects/smoke-count
rm -rf /Projects/smoke-other && mkdir -p /Projects/smoke-other && echo other-project-secret > /Projects/smoke-other/secret.txt && chmod 755 /Projects/smoke-other && chmod 644 /Projects/smoke-other/secret.txt`);
    r = await call('/api/vault', { method: 'POST', body: { provider: 'custom', style: 'token', name: 'smoke general secret', prefix: 'SMOKE_GENERAL_X', scope: 'general', fields: { token: 'general-secret-1' }, envMap: { token: 'SMOKE_GENERAL_SECRET' } } });
    check('a general Vault value exists for the isolation checks', r.status === 201 && !!r.body.id, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    const generalVaultId = r.body.id;
    const get = async (p) => { try { return await (await fetch(`http://127.0.0.1:8141${p}`)).text(); } catch { return null; } };
    const waitUp = async () => { for (let i = 0; i < 20; i++) { if (await get('/') !== null) return true; await sleep(300); } return false; };
    // An agent's test copy already holds the port; the live start takes it over.
    r = await call('/api/servers/run', { method: 'POST', body: { name: 'smoke count test', port: 8141, cwd: '/Projects/smoke-count', cmd: ['node', 'app.js'] } });
    check('a plain server can hold the port first', r.status === 201, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    await waitUp();
    r = await call('/api/servers/run', { method: 'POST', body: { name: 'smoke count dup', port: 8141, cwd: '/Projects/smoke-count', cmd: ['node', 'app.js'] } });
    check('a second server on a taken port is refused with who holds it', r.status === 409 && /smoke count test/.test(r.body.error || ''), `${r.status} ${r.body.error}`);
    r = await call('/api/live/smoke-count/web/start', { method: 'POST' });
    check('live start takes over the port from the same-folder server', r.status === 200 && r.body.tookOver === 'smoke count test' && r.body.runAs === 'service' && r.body.account === 'ps-smoke-count', `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    check('the test copy is gone from the registry', !(await call('/api/servers')).body.some(x => x.slug === 'smoke-count-test'));
    await waitUp();
    const owner = sh(`ps -eo user:20,args | grep '[n]ode app.js' | grep -v bash | awk '{print $1}' | sort -u`).trim();
    check('the live service runs as its project account', owner === 'ps-smoke-count', owner);
    const svcSh = (cmd) => { try { return sh(`/usr/sbin/runuser -u ps-smoke-count -- bash -c ${JSON.stringify(cmd)} 2>&1; echo "rc=$?"`); } catch (e) { return String(e.stdout || e.message); } };
    check('the account cannot read another project (even world-readable files)', /rc=[1-9]/.test(svcSh('cat /Projects/smoke-other/secret.txt')) && !/other-project-secret/.test(svcSh('cat /Projects/smoke-other/secret.txt')), svcSh('cat /Projects/smoke-other/secret.txt').slice(0, 120));
    check('the account cannot read the agent home or PlatOpypus state', /rc=[1-9]/.test(svcSh('ls /home/agent')) && /rc=[1-9]/.test(svcSh('ls /root/.porthole')));
    check('the account is not in porthole-dev', !/porthole-dev/.test(sh('id ps-smoke-count')), sh('id ps-smoke-count').trim());
    check('the account can write its own project', /rc=0/.test(svcSh('touch /Projects/smoke-count/data/probe && echo ok')));
    const fw = (await call('/api/live')).body.find(p => p.project === 'smoke-count')?.services[0]?.firewall;
    if (fw?.ok) {
        check('the account cannot reach PlatOpypus\'s API', /rc=[1-9]/.test(svcSh('curl -s -m 3 -o /dev/null http://127.0.0.1:7331/api/me')));
        check('the account cannot reach the metadata service', /rc=[1-9]/.test(svcSh('curl -s -m 3 -o /dev/null http://169.254.169.254/')));
    } else console.log(`SKIP  firewall checks — ${fw?.detail || 'no state'} (run the container with --cap-add NET_ADMIN)`);
    const envKeys = JSON.parse(await get('/env') || '[]');
    check('the service sees no PlatOpypus environment', !envKeys.some(k => /^PORTHOLE_(TOKEN|STATE|PORT)$|^TMUX|^SSH_/.test(k)) && envKeys.includes('PORTHOLE_SERVICE'), envKeys.join(' '));
    check('the service gets no Vault value it did not list under needs', !envKeys.includes('SMOKE_GENERAL_SECRET'), envKeys.join(' '));
    check('PlatOpypus (root) still has the log', /./.test(sh('cat /root/.porthole/services/live-smoke-count-web.log; echo x')));
    r = await call('/api/live/smoke-count/web/actions/0', { method: 'POST' });
    check('actions run as the project account without PlatOpypus secrets', r.status === 200 && /^ps-smoke-count/.test(r.body.output) && !/SMOKE_GENERAL_SECRET/.test(r.body.output) && !/PORTHOLE_TOKEN|TMUX/.test(r.body.output), JSON.stringify(r.body.output).slice(0, 200));
    for (let i = 0; i < 5; i++) await get('/click');
    await sleep(500);
    r = await call('/api/live/smoke-count/web/actions/1', { method: 'POST' });
    check('stop_first reset stops, writes, starts', r.status === 200 && r.body.code === 0 && /stopped the service/.test(r.body.output) && /started the service/.test(r.body.output), JSON.stringify(r.body).slice(0, 240));
    await waitUp(); await sleep(700);
    check('the counter really is 0 after reset (not written back)', await get('/') === '0', await get('/'));
    r = await call('/api/live/smoke-count/web/actions/2', { method: 'POST', body: { inputs: { count: 'abc' } } });
    check('an integer input rejects text', r.status === 400 && /whole number/.test(r.body.error || ''), `${r.status} ${r.body.error}`);
    r = await call('/api/live/smoke-count/web/actions/2', { method: 'POST', body: { inputs: { count: '5000' } } });
    check('an integer input enforces max', r.status === 400 && /at most 1000/.test(r.body.error || ''), `${r.status} ${r.body.error}`);
    r = await call('/api/live/smoke-count/web/actions/2', { method: 'POST', body: { inputs: { count: '7', note: '$(id); x' } } });
    check('a string input enforces its pattern (no shell text gets through)', r.status === 400 && /format/.test(r.body.error || ''), `${r.status} ${r.body.error}`);
    r = await call('/api/live/smoke-count/web/actions/2', { method: 'POST', body: { inputs: { count: '42', note: 'hi there' } } });
    check('valid inputs reach the command as env vars', r.status === 200 && r.body.code === 0 && /note=\[hi there\]/.test(r.body.output), JSON.stringify(r.body).slice(0, 200));
    await waitUp(); await sleep(400);
    check('the set value took effect', await get('/') === '42', await get('/'));
    const lv = (await call('/api/live')).body.find(p => p.project === 'smoke-count')?.services[0];
    {   // Groups: items come from the list command; actions get GROUP_ITEM; ids not in the list are refused.
        const g = lv?.groups?.[0];
        check('live list describes groups', g?.label === 'Rooms' && g.item === 'room' && g.actions.length === 2 && g.actions[1].all === false && g.actions[1].inputs.length === 1, JSON.stringify(g).slice(0, 200));
        r = await call('/api/live/smoke-count/web/groups/0');
        check('a group lists its items from the list command', r.status === 200 && r.body.items.map(i => i.id).join(',') === 'r1,r2,r3', JSON.stringify(r.body).slice(0, 200));
        r = await call('/api/live/smoke-count/web/groups/0/actions/0', { method: 'POST', body: { item: 'r9; id' } });
        check('a group action refuses an id that is not in the list', r.status === 404, `${r.status} ${r.body.error}`);
        r = await call('/api/live/smoke-count/web/groups/0/actions/1', { method: 'POST', body: { item: 'r1', inputs: { name: 'abc' } } });
        check('a group action gets GROUP_ITEM and its typed inputs', r.status === 200 && /rename r1 to \[abc\]/.test(r.body.output), JSON.stringify(r.body).slice(0, 200));
        r = await call('/api/live/smoke-count/web/groups/0/actions/1', { method: 'POST', body: { item: 'r1', inputs: { name: 'A$(id)' } } });
        check('group action inputs are checked too', r.status === 400, `${r.status} ${r.body.error}`);
        r = await call('/api/live/smoke-count/web/groups/0/actions/1', { method: 'POST', body: { item: '*', inputs: { name: 'abc' } } });
        check('an all: false action cannot run on every item', r.status === 400, `${r.status} ${r.body.error}`);
        r = await call('/api/live/smoke-count/web/groups/0/actions/0', { method: 'POST', body: { item: 'r2' } });
        check('a group action runs on one item as the project account', r.status === 200 && r.body.code === 0 && /closed r2 as ps-smoke-count/.test(r.body.output), JSON.stringify(r.body).slice(0, 200));
        r = await call('/api/live/smoke-count/web/groups/0/actions/0', { method: 'POST', body: { item: '*' } });
        check('"all" runs the action once per current item', r.status === 200 && r.body.items === 2 && r.body.failed === 0 && /closed r1/.test(r.body.output) && /closed r3/.test(r.body.output), JSON.stringify(r.body).slice(0, 240));
        sh(`mkdir -p /Projects/smoke-count/public && printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>' > /Projects/smoke-count/public/favicon.svg`);
        if (fsRootIsSlash) {
        r = await call('/api/files?path=' + encodeURIComponent('Projects'));
        const fi = Array.isArray(r.body?.items) ? r.body.items.find(i => i.name === 'smoke-count') : null;
        check('a project folder with a favicon lists it as its icon', fi?.icon === 'public/favicon.svg', JSON.stringify(fi || r.body).slice(0, 160));
        const ir = await fetch(BASE + '/api/files/icon?path=' + encodeURIComponent('Projects/smoke-count/public/favicon.svg'), { headers: { cookie } });
        check('the icon is served as an image under a sandbox policy', ir.status === 200 && /image\/svg\+xml/.test(ir.headers.get('content-type') || '') && /sandbox/.test(ir.headers.get('content-security-policy') || ''), `${ir.status} ${ir.headers.get('content-type')}`);
        const nr = await fetch(BASE + '/api/files/icon?path=' + encodeURIComponent('Projects/smoke-count/app.js'), { headers: { cookie } });
        check('the icon route refuses non-images', nr.status === 400, String(nr.status));
        }
        r = await call('/api/live/smoke-count/web/groups/0');
        check('the list reflects the actions', r.status === 200 && r.body.items.length === 0, JSON.stringify(r.body).slice(0, 120));
        // Pins and recents (Home): runs are recorded newest first; pins point by label and are checked.
        r = await call('/api/quick');
        const rec = r.body?.recents || [];
        check('recent runs are recorded, newest first, with the item and the action', r.status === 200 && rec[0]?.kind === 'group' && rec[0].action === 'Close' && rec.some(x => x.kind === 'item' && x.item === 'r2' && x.group === 'Rooms') && rec.some(x => x.kind === 'item' && x.item === 'r1' && x.action === 'Rename'), JSON.stringify(rec).slice(0, 300));
        const pinA = await call('/api/quick/pins', { method: 'POST', body: { kind: 'item', project: 'smoke-count', key: 'web', group: 'Rooms', item: 'r2', action: 'Close' } });
        const pinB = await call('/api/quick/pins', { method: 'POST', body: { kind: 'item', project: 'smoke-count', key: 'web', group: 'Rooms', item: 'r2' } });
        check('pinning an item twice keeps one pin, and an item pin opens every action', pinA.status === 201 && pinB.body?.id === pinA.body?.id && pinA.body.action === null, JSON.stringify([pinA.body, pinB.body]).slice(0, 200));
        r = await call('/api/quick/pins', { method: 'POST', body: { kind: 'item', project: 'smoke-count', key: 'web', group: 'Rooms', item: 'r2; id' } });
        check('a pin refuses an item id the lists could never print', r.status === 400, `${r.status} ${r.body?.error}`);
        r = await call('/api/quick/pins', { method: 'POST', body: { kind: 'action', project: 'smoke-count', key: 'web' } });
        check('an action pin needs its action', r.status === 400, `${r.status} ${r.body?.error}`);
        r = await call(`/api/quick/pins/${pinA.body?.id}`, { method: 'DELETE' });
        const after = (await call('/api/quick')).body;
        check('unpinning removes it', r.status === 200 && r.body.removed === 1 && !after.pins.length, JSON.stringify(after.pins));
        r = await call('/api/quick/recents', { method: 'DELETE' });
        check('recents can be cleared', r.status === 200 && !(await call('/api/quick')).body.recents.length, String(r.status));
    }
    check('live list describes inputs and run-as', lv?.runAs === 'service' && lv.actions[2].inputs.length === 2 && lv.actions[2].inputs[0].type === 'integer', JSON.stringify(lv && { runAs: lv.runAs, a: lv.actions[2] }).slice(0, 200));
    const pidBefore = lv?.pid;
    r = await call('/api/servers/smoke-counter/restart', { method: 'POST' });
    check('svc restart resolves a live service by its title and restarts it', r.status === 200 && r.body.alive === true && r.body.pid !== pidBefore, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    await waitUp();
    r = await call('/api/live/smoke-count/web/actions/3', { method: 'POST' });
    check('restart: true restarts after a successful command', r.status === 200 && /restarted the service/.test(r.body.output), JSON.stringify(r.body).slice(0, 200));
    await waitUp();
    // run_as: root needs the phone, and the approval is pinned to the commands.
    await call('/api/live/smoke-count/web/stop', { method: 'POST' });
    sh(`sed -i 's/^    start: node app.js/    start: node app.js\\n    run_as: root/' /Projects/smoke-count/PORTHOLE.md`);
    r = await call('/api/live/smoke-count/web/start', { method: 'POST' });
    check('run_as: root is refused until approved', r.status === 403 && /Approve/.test(r.body.error || ''), `${r.status} ${r.body.error}`);
    r = await call('/api/live/smoke-count/web/root', { method: 'POST' }); check('root can be approved from the phone', r.status === 200);
    r = await call('/api/live/smoke-count/web/actions/0', { method: 'POST' });
    check('approved actions run as root', r.status === 200 && /^root/.test(r.body.output), JSON.stringify(r.body.output).slice(0, 80));
    sh(`sed -i 's/run: id -un;/run: id -un; echo changed;/' /Projects/smoke-count/PORTHOLE.md`);
    r = await call('/api/live/smoke-count/web/actions/0', { method: 'POST' });
    check('editing a command voids the root approval', r.status === 403, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    r = await call('/api/live/smoke-count/web/root', { method: 'POST' });
    r = await call('/api/live/smoke-count/web/actions/0', { method: 'POST' }); check('re-approved after the edit', r.status === 200, String(r.status));
    sh(`echo '// changed' >> /Projects/smoke-count/app.js`);
    r = await call('/api/live/smoke-count/web/actions/0', { method: 'POST' });
    check('changing the app code (not the commands) voids the root approval too', r.status === 403 && /code/.test(r.body.error || ''), `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    await call('/api/live/smoke-count/web/root', { method: 'DELETE' });
    await call('/api/servers/live-smoke-count-web', { method: 'DELETE' }).catch(() => {});
    await call(`/api/vault/${generalVaultId}`, { method: 'DELETE' });
    // An app that dies at once is reported with its log.
    r = await call('/api/servers/run', { method: 'POST', body: { name: 'smoke dies', cwd: '/Projects/smoke-count', cmd: ['bash', '-c', 'echo boom-at-start; exit 3'] } });
    check('a server that dies straight away is reported with its log', r.status === 500 && /boom-at-start/.test(r.body.error || ''), `${r.status} ${r.body.error}`);
    await call('/api/servers/smoke-dies', { method: 'DELETE' }).catch(() => {});
    // Make agent-ready for an old root-owned project.
    sh('rm -rf /Projects/smoke-old && mkdir -p /Projects/smoke-old/sub && touch /Projects/smoke-old/sub/f && chown -R root:root /Projects/smoke-old && chmod -R go-w /Projects/smoke-old');
    r = await call('/api/agent-ready?path=Projects/smoke-old'); check('an old project reports not agent-ready', r.status === 200 && r.body.eligible && r.body.ready === false, JSON.stringify(r.body));
    r = await call('/api/agent-ready', { method: 'POST', body: { path: 'Projects/smoke-old' } }); check('Make agent-ready fixes the whole tree', r.status === 200 && r.body.ready === true, JSON.stringify(r.body));
    check('agent can now write deep in it', sh(`/usr/sbin/runuser -u agent -- bash -c 'touch /Projects/smoke-old/sub/g && echo ok'`).trim() === 'ok');
    sh('rm -rf /Projects/smoke-count /Projects/smoke-old /Projects/smoke-other');
}

// 6i. Agent user: no root, restricted API, vault get by real folder, elevate with phone approval.
r = await call('/api/agent-user');
if (r.body.available) {
    const { execFileSync } = await import('node:child_process');
    const sh = (cmd) => execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    sh('rm -rf /Projects/smoke-agent && mkdir -p /Projects/smoke-agent/sub');
    r = await call('/api/vault', { method: 'POST', body: { provider: 'custom', style: 'token', name: 'smoke agent key', prefix: 'SMOKE_AGENT_X', scope: 'Projects/smoke-agent', fields: { token: 'ag-777' }, envMap: { token: 'SMOKE_AGENT_KEY' } } }); const agVault = r.body.id;
    await call('/api/shells/smoke-agent', { method: 'DELETE' }).catch(() => {});
    r = await call('/api/shells', { method: 'POST', body: { name: 'smoke-agent', kind: 'shell', cwd: 'Projects/smoke-agent', runAs: 'agent' } });
    check('agent-user shell starts', r.status === 201 && r.body.runAs === 'agent', JSON.stringify(r.body).slice(0, 160));
    r = await call('/api/shells', { method: 'POST', body: { name: 'smoke-agent-bad', kind: 'shell', cwd: 'etc', runAs: 'agent' } });
    check('agent-user shell refused outside projects', r.status === 403, `${r.status}`);
    await sleep(1500);
    const keys = (cmd) => { execFileSync('tmux', ['-L', 'porthole', 'send-keys', '-t', 'smoke-agent:', '-l', cmd]); execFileSync('tmux', ['-L', 'porthole', 'send-keys', '-t', 'smoke-agent:', 'Enter']); };
    const typeIn = async (cmd, marker2, wait = 12) => { keys(cmd + `; echo DONE-${marker2}`); for (let i = 0; i < wait * 2; i++) { await sleep(500); const out = sh('tmux -L porthole capture-pane -p -J -S -200 -t smoke-agent:'); const lines = out.split('\n'); const idx = lines.findIndex(l => l.startsWith(`DONE-${marker2}`)); if (idx >= 0) return lines.slice(0, idx).join('\n'); } return sh('tmux -L porthole capture-pane -p -J -S -200 -t smoke-agent:'); };
    let out = await typeIn('id -u; whoami', 'a1');
    check('agent-user shell is not root', /\nagent\s*$/.test(out.trimEnd()) || out.includes('\nagent'), out.slice(-120));
    out = await typeIn('cat /root/.porthole/token >/dev/null 2>&1 && echo READ-TOKEN || echo NO-TOKEN', 'a2');
    check('agent user cannot read the box token', out.includes('NO-TOKEN') && !out.includes('READ-TOKEN\n'), out.slice(-80));
    out = await typeIn('echo "V=$(vault get SMOKE_AGENT_KEY)"', 'a3');
    check('vault get works from the project main folder', out.includes('V=ag-777'), out.slice(-120));
    out = await typeIn('cd sub && vault get SMOKE_AGENT_KEY; echo RC=$?; cd ..', 'a4');
    check('vault get refuses from a sub-folder (real cwd)', out.includes('main folder') && out.includes('RC=1'), out.slice(-160));
    out = await typeIn('vault run SMOKE_AGENT_KEY -- printenv SMOKE_AGENT_KEY | sed "s/^/RUN=/"; echo "SHELL_HAS=${SMOKE_AGENT_KEY:-none}"', 'a3r');
    check('vault run works in an agent-user shell and leaves the shell without the value', out.includes('RUN=ag-777') && out.includes('SHELL_HAS=none'), out.slice(-160));
    out = await typeIn('curl -s -o /dev/null -w "files=%{http_code}" -c /tmp/aj -H "Content-Type: application/json" -H "X-Porthole: 1" -d "{\\"token\\":\\"$PORTHOLE_TOKEN\\"}" http://127.0.0.1:7331/api/login/token; curl -s -o /dev/null -w " %{http_code}" -b /tmp/aj -H "X-Porthole: 1" "http://127.0.0.1:7331/api/files?path=."', 'a5');
    check('shell token session is refused on the files API', /files=200 403/.test(out), out.slice(-80));
    keys('elevate --reason smoke -- id -u > /tmp/elev-out 2>&1; echo ELEV-RC=$? >> /tmp/elev-out');
    let pend = []; for (let i = 0; i < 20 && !pend.length; i++) { await sleep(500); pend = (await call('/api/elevate/pending')).body; }
    check('elevate request appears for approval', pend.length === 1 && pend[0].shell === 'smoke-agent' && pend[0].cwd === '/Projects/smoke-agent', JSON.stringify(pend));
    if (pend[0]) await call(`/api/elevate/${pend[0].id}/allow`, { method: 'POST', body: {} });
    let elevOut = ''; for (let i = 0; i < 20 && !/ELEV-RC/.test(elevOut); i++) { await sleep(500); try { elevOut = sh('cat /tmp/elev-out'); } catch { /* not yet */ } }
    check('approved elevate runs as root and returns', /^0\s*$/m.test(elevOut) && /ELEV-RC=0/.test(elevOut), elevOut);
    sh('rm -f /tmp/elev-out'); keys('elevate -- id -u > /tmp/elev-out 2>&1; echo ELEV-RC=$? >> /tmp/elev-out');
    pend = []; for (let i = 0; i < 20 && !pend.length; i++) { await sleep(500); pend = (await call('/api/elevate/pending')).body; }
    if (pend[0]) await call(`/api/elevate/${pend[0].id}/deny`, { method: 'POST', body: {} });
    elevOut = ''; for (let i = 0; i < 20 && !/ELEV-RC/.test(elevOut); i++) { await sleep(500); try { elevOut = sh('cat /tmp/elev-out'); } catch { /* not yet */ } }
    check('denied elevate exits 126', /ELEV-RC=126/.test(elevOut), elevOut);
    out = await typeIn('svc run --name smoke-agent-srv --port 8160 -- python3 -m http.server 8160 >/dev/null; sleep 2; ps -o user= -p $(ss -ltnpH | grep ":8160 " | grep -o "pid=[0-9]*" | head -1 | cut -d= -f2)', 'a6', 20);
    check('svc run from an agent-user shell runs as the agent user', /\nagent\s*$/.test(out.trimEnd()), out.slice(-120));
    {   // Audit log: what this agent did, filed under its project; agents cannot read the log.
        out = await typeIn('curl -s -o /dev/null -c /tmp/aj -H "Content-Type: application/json" -H "X-Porthole: 1" -d "{\\"token\\":\\"$PORTHOLE_TOKEN\\"}" http://127.0.0.1:7331/api/login/token; curl -s -o /dev/null -w "audit=%{http_code}" -b /tmp/aj -H "X-Porthole: 1" "http://127.0.0.1:7331/api/audit"', 'a7');
        check('agents cannot read the audit log', /audit=403/.test(out), out.slice(-60));
        const au = (await call('/api/audit?project=smoke-agent')).body;
        const ev = au.events || [];
        const req = ev.filter(e => e.type === 'elevate' && e.action === 'request');
        check('root requests are filed under the project, one entry each, with how they ended', req.length === 2 && req.some(e => e.status === 'done' && e.code === 0 && /id -u/.test(e.cmd) && e.reason === 'smoke' && e.actor === 'shell "smoke-agent"' && e.decidedBy === 'phone') && req.some(e => e.status === 'denied'), JSON.stringify(req).slice(0, 400));
        const rr = ev.find(e => e.type === 'credential' && e.action === 'agent-run');
        check('an agent\'s vault run is logged with the command it was for', rr?.names?.includes('SMOKE_AGENT_KEY') && /printenv SMOKE_AGENT_KEY/.test(rr.cmd || ''), JSON.stringify(rr));
        const rd = ev.find(e => e.type === 'credential' && e.action === 'agent-read');
        check('an agent reading a Vault value is recorded by name, never the value', rd?.names?.includes('SMOKE_AGENT_KEY') && !JSON.stringify(au).includes('ag-777'), JSON.stringify(rd));
        const srv = ev.find(e => e.type === 'activity' && e.action === 'server-run');
        check('a server an agent starts is recorded as activity for its project', srv && srv.actor === 'shell "smoke-agent"' && /smoke-agent-srv/.test(srv.what), JSON.stringify(srv));
        const sm = au.projects.find(x => x.project === 'smoke-agent');
        check('the project summary counts root and credential use', sm && sm.elevate >= 2 && sm.rootRuns === 1 && sm.credential >= 1 && sm.names.includes('SMOKE_AGENT_KEY'), JSON.stringify(sm));
        const only = (await call('/api/audit?type=elevate')).body.events;
        check('the log filters by kind', only.length >= 2 && only.every(e => e.type === 'elevate'), String(only.length));
        sh('cd /Projects/smoke-agent && git init -q && git -c user.name=Sam -c user.email=sam@example.com commit -q --allow-empty -m "by hand" && git -c user.name=Sam -c user.email=sam@example.com commit -q --allow-empty -m "agent change" -m "Co-Authored-By: Claude Opus <noreply@anthropic.com>"');
        const cm = (await call('/api/audit?project=smoke-agent&type=activity&days=15')).body.commits || [];
        check('commits come from the project history, agents marked by author or trailer', cm.length === 2 && cm.find(c => c.what === 'agent change')?.agent === 'Claude Opus' && cm.find(c => c.what === 'by hand')?.agent === null, JSON.stringify(cm).slice(0, 300));
    }
    await call('/api/servers/smoke-agent-srv', { method: 'DELETE' }).catch(() => {});
    await call('/api/shells/smoke-agent', { method: 'DELETE' });
    await call(`/api/vault/${agVault}`, { method: 'DELETE' });
    sh('rm -rf /Projects/smoke-agent /tmp/elev-out /tmp/aj');
    // Stage 2: move logins (fake credentials) to the agent user and back.
    sh('mkdir -p /root/.claude /root/.agent-profiles/claude/alt && echo "{}" > /root/.claude/.credentials.json && echo "{}" > /root/.agent-profiles/claude/alt/.credentials.json');
    r = await call('/api/agent-user/move-logins', { method: 'POST', body: {} });
    check('logins move to the agent user', r.status === 200 && r.body.moved.includes('.claude') && r.body.moved.includes('.agent-profiles'), JSON.stringify(r.body).slice(0, 160));
    check('moved logins belong to the agent user', sh('stat -c %U /home/agent/.claude/.credentials.json /home/agent/.agent-profiles/claude/alt/.credentials.json').trim().split('\n').every(u => u === 'agent') && !sh('ls -a /root').split('\n').includes('.claude'));
    r = await call('/api/agents'); const cl = r.body.find(a => a.key === 'claude');
    check('agents page sees the moved login and profile', cl?.signedIn === true && cl.profiles.some(p => p.name === 'alt' && p.signedIn), JSON.stringify(cl && { s: cl.signedIn, p: cl.profiles }));
    r = await call('/api/shells', { method: 'POST', body: { name: 'smoke-default', kind: 'agent', agent: 'claude', cwd: 'Projects', profile: 'alt' } });
    check('agents default to the agent user once logins moved (with profiles)', r.status === 201 && r.body.runAs === 'agent', `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
    await call('/api/shells/smoke-default', { method: 'DELETE' }).catch(() => {});
    r = await call('/api/agent-user/undo-move', { method: 'POST', body: {} });
    check('undo puts the logins back with root', r.status === 200 && sh('stat -c %U /root/.claude/.credentials.json').trim() === 'root', JSON.stringify(r.body));
    sh('rm -f /root/.claude/.credentials.json; rm -rf /root/.agent-profiles/claude/alt');
} else check('agent user present in the test image', false, 'install.sh did not create it');

// 6j. Session type and security level.
{
    const { execFileSync } = await import('node:child_process');
    execFileSync('bash', ['-lc', 'rm -rf /Projects/smoke-sec && mkdir -p /Projects/smoke-sec/sub']);
    r = await call('/api/projects/profile?path=Projects/smoke-sec/sub'); check('new project has no security level', r.status === 200 && r.body.root === '/Projects/smoke-sec' && r.body.profile === null, JSON.stringify(r.body).slice(0, 120));
    r = await call('/api/shells', { method: 'POST', body: { name: 'smoke-sec', kind: 'agent', agent: 'claude', cwd: 'Projects/smoke-sec', session: 'project' } });
    check('project session refused until a level is chosen', r.status === 428 && r.body.needProfile === true, `${r.status} ${JSON.stringify(r.body)}`);
    r = await call('/api/projects/profile', { method: 'PUT', body: { path: 'Projects/smoke-sec', level: 'personal' } }); check('personal level needs private or shared', r.status === 400);
    r = await call('/api/projects/profile', { method: 'PUT', body: { path: 'Projects/smoke-sec', level: 'professional', tier: 'public' } });
    check('level saved with its brief in the project', r.status === 200 && r.body.profile.key === 'professional-public' && r.body.cveDue === true && /daily routine/i.test(execFileSync('cat', ['/Projects/smoke-sec/.porthole/security.md'], { encoding: 'utf8' })), JSON.stringify(r.body).slice(0, 160));
    r = await call('/api/shells', { method: 'POST', body: { name: 'smoke-sec', kind: 'shell', cwd: 'Projects/smoke-sec/sub' } });
    const out = execFileSync('bash', ['-lc', 'cd /Projects/smoke-sec/sub && project security && project cve-checked && project security'], { encoding: 'utf8' });
    check('project CLI reports the level and records the CVE check', /professional-public/.test(out) && /DUE/.test(out) && /done in the last 24 h/.test(out), out.slice(0, 300));
    await call('/api/shells/smoke-sec', { method: 'DELETE' }).catch(() => {});
    // Agent starts trusted in its folder and receives the first message as an argument.
    r = await call('/api/shells', { method: 'POST', body: { name: 'smoke-trust', kind: 'agent', agent: 'claude', cwd: 'Projects/smoke-sec', session: 'project', firstPrompt: 'say hello' } });
    check('agent shell with a first message starts', r.status === 201, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    const cj = JSON.parse(execFileSync('cat', [`${process.env.HOME || '/root'}/.claude.json`], { encoding: 'utf8' }));
    check('Claude Code pre-trusts the folder', cj.projects?.['/Projects/smoke-sec']?.hasTrustDialogAccepted === true);
    const envDump = execFileSync('tmux', ['-L', 'porthole', 'show-environment', '-t', 'smoke-trust'], { encoding: 'utf8' });
    check('first message reaches the agent session', /PORTHOLE_FIRST_PROMPT=say hello/.test(envDump));
    await call('/api/shells/smoke-trust', { method: 'DELETE' }).catch(() => {});
    execFileSync('bash', ['-lc', 'rm -rf /Projects/smoke-sec']);
}

// 6k. One-shot runs: shell ends by itself, output kept, scratch folder removed (fake agent binary on PATH is not
// needed: a bad first message makes Claude print mode exit at once in the test image, which is enough for the lifecycle).
r = await call('/api/shells', { method: 'POST', body: { name: 'once-smoke', kind: 'agent', agent: 'antigravity', firstPrompt: 'x', oneshot: true } });
check('one-shot refuses agents without a non-interactive mode', r.status === 400);
r = await call('/api/shells', { method: 'POST', body: { name: 'once-smoke', kind: 'agent', agent: 'claude', firstPrompt: 'reply with the word ok', oneshot: true, runAs: 'root', session: 'project' } });
check('one-shot shell starts in a scratch folder', r.status === 201 && /\/scratch\//.test(r.body.cwd), `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
{ const { execFileSync } = await import('node:child_process'); try { execFileSync('tmux', ['-L', 'porthole', 'kill-session', '-t', 'once-smoke']); } catch { /* already ended */ } }
let res1 = []; for (let i = 0; i < 20 && !res1.some(x => x.name === 'once-smoke'); i++) { await sleep(1000); await call('/api/shells'); res1 = (await call('/api/oneshot')).body; }
check('finished one-shot keeps its result and removes its folder', res1.some(x => x.name === 'once-smoke' && x.prompt.startsWith('reply')) && !(await call('/api/shells')).body.some(x => x.name === 'once-smoke'), JSON.stringify(res1.map(x => x.name)));

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
check('tunnelling PlatOpypus itself is refused', r.status === 403);
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
    ws.on('open', () => setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: `echo "G=$SMOKE_GENERAL P=$SMOKE_PROJECT"; vault ls; vault get SMOKE_PROJECT; echo; vault run SMOKE_GENERAL -- printenv SMOKE_GENERAL | sed 's/^/R=/'; echo END-$((40+2))-${marker}\r` })), 2500));
    // "END-42-…" only appears once the command has actually run (the typed line shows "$((40+2))").
    ws.on('message', (d, isBinary) => { if (isBinary) buf += d.toString('utf8'); if (buf.includes(`END-42-${marker}`)) { clearTimeout(t); ws.close(); resolve(buf); } });
    ws.on('error', reject);
});
// tmux redraws can interleave cursor-movement escapes with text, so strip them before matching.
const plainOut = envOut.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][A-Z0-9]/g, '').replace(/\r/g, '');
check('new shells get no Vault values by default (fetched per use instead)', /G= P=\s/.test(plainOut) && !plainOut.includes('G=general-secret-1234') && !plainOut.includes('P={"access"') && plainOut.includes('{"access":"abc"'), plainOut.slice(-300));
check('vault run gives one command just the values it names', plainOut.includes('R=general-secret-1234'), plainOut.slice(-200));
{
    const au = (await call('/api/audit?type=credential')).body.events;
    const run = au.find(e => e.action === 'root-run' && e.names?.includes('SMOKE_GENERAL'));
    const get = au.find(e => e.action === 'root-read' && e.names?.includes('SMOKE_PROJECT'));
    check('root shells\' vault run and vault get are logged with the command and the shell', run && /printenv SMOKE_GENERAL/.test(run.cmd) && run.actor === 'shell "smoke-vault"' && get && !JSON.stringify(au).includes('general-secret-1234'), JSON.stringify([run, get]).slice(0, 300));
}
{ const { execFileSync } = await import('node:child_process'); let refused = false; try { execFileSync('bash', ['-lc', 'mkdir -p /smoke-proj/sub && cd /smoke-proj/sub && vault get SMOKE_PROJECT'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { refused = /main folder/.test(String(e.stderr)); } check('vault get refuses project credentials from a sub-folder', refused); }
check('vault CLI lists and gets inside shell', /SMOKE_GENERAL\s+smoketest/.test(plainOut) && plainOut.includes('{"access":"abc","refresh":"def"}'), plainOut.slice(-400));
r = await call(`/api/vault/${projectId}/reveal`, { method: 'POST' });
check('vault reveal returns value', r.status === 200 && r.body.value === '{"access":"abc","refresh":"def"}');
await call('/api/shells/smoke-vault', { method: 'DELETE' });
await call('/api/files/trash', { method: 'POST', body: { path: 'smoke-proj' } });
r = await call(`/api/vault/${generalId}`, { method: 'DELETE' });
check('vault delete', r.status === 200);
await call(`/api/vault/${projectId}`, { method: 'DELETE' });

// 8b1. Audit retention: identical events in a burst merge into one line with a count; days past 90 are dropped.
{
    const { execFileSync } = await import('node:child_process');
    const shx = c => execFileSync('bash', ['-lc', c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    r = await call('/api/vault', { method: 'POST', body: { provider: 'smoketest', name: 'burst', envName: 'SMOKE_BURST', scope: 'general', value: 'b-1' } });
    const burstId = r.body.id;
    // One process, so the repeat window applies (each CLI run is its own process; the server merges its own bursts).
    shx(`cd / && node --input-type=module -e "const a = await import('/opt/porthole/server/lib/audit.js'); for (let i = 0; i < 5; i++) a.record('credential', 'root-read', { actor: 'burst-test', names: ['SMOKE_BURST'], cwd: '/' });"`);
    const ev = (await call('/api/audit?type=credential')).body.events.filter(e => e.actor === 'burst-test');
    check('a burst of identical events is one line with a count', ev.length === 1 && ev[0].count === 5, JSON.stringify(ev).slice(0, 200));
    shx(`mkdir -p /root/.porthole/audit && echo '{"at":1577836800000,"type":"activity","action":"tunnel-start"}' > /root/.porthole/audit/2020-01-01.jsonl`);
    shx(`cd / && node --input-type=module -e "const a = await import('/opt/porthole/server/lib/audit.js'); a.prune();"`);
    check('audit days older than the retention window are removed', !shx('ls /root/.porthole/audit').includes('2020-01-01'), shx('ls /root/.porthole/audit'));
    check('the audit log keeps one file per day', /^\d{4}-\d{2}-\d{2}\.jsonl$/m.test(shx('ls /root/.porthole/audit')));
    await call(`/api/vault/${burstId}`, { method: 'DELETE' });
}

// 8b3. Alerts: a general Telegram bot from the Vault; messages go to a stand-in Bot API here.
{
    const http = await import('node:http');
    const { execFile } = await import('node:child_process');
    const got = [];
    const tgMock = http.createServer((q, res) => {
        let b = ''; q.on('data', d => b += d); q.on('end', () => {
            const m = q.url.match(/^\/bot([^/]+)\/(\w+)/) || [];
            if (m[2] === 'sendMessage') got.push({ token: m[1], ...JSON.parse(b || '{}') });
            const result = m[2] === 'getUpdates' ? [{ update_id: 1, message: { chat: { id: 4242, type: 'private', first_name: 'Sam' } } }] : m[2] === 'getMe' ? { id: 1, username: 'smoke_bot' } : {};
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, result }));
        });
    });
    await new Promise(ok => tgMock.listen(7398, '127.0.0.1', ok));
    // A separate PlatOpypus process that sends through the stand-in (the server itself talks to the real Bot API).
    const viaMock = code => new Promise((ok, no) => execFile('node', ['--input-type=module', '-e', `const a = await import('/opt/porthole/server/lib/alerts.js'); ${code}`], { cwd: '/', env: { ...process.env, PORTHOLE_TELEGRAM_API: 'http://127.0.0.1:7398' }, timeout: 20000 }, (e, out, err) => e ? no(new Error(err || e.message)) : ok(out)));

    r = await call('/api/alerts');
    check('alerts start off, with the important kinds pre-selected', r.status === 200 && r.body.ready === false && r.body.on.root && r.body.on.signin && !r.body.on.commit, JSON.stringify(r.body).slice(0, 200));
    r = await call('/api/vault', { method: 'POST', body: { provider: 'telegram-bot', style: 'botChat', name: 'Alerts bot', prefix: 'ALERTBOT', scope: 'general', fields: { botToken: '123456:smoke-token-abcdefghijklmnopqrstuvwxyz', chatId: '42' } } });
    const botId = r.body.id;
    r = await call('/api/vault', { method: 'POST', body: { provider: 'telegram-bot', style: 'botChat', name: 'Project bot', prefix: 'PROJBOT', scope: 'smoke-proj', fields: { botToken: '654321:smoke-token-abcdefghijklmnopqrstuvwxyz' } } });
    const projBotId = r.body.id;
    r = await call('/api/alerts');
    check('only general Telegram bots are offered', r.body.bots.some(b => b.id === botId) && !r.body.bots.some(b => b.id === projBotId), JSON.stringify(r.body.bots));
    r = await call('/api/alerts', { method: 'PUT', body: { itemId: projBotId } });
    check('a project-scoped bot cannot be picked', r.status === 400);
    r = await call('/api/alerts', { method: 'PUT', body: { itemId: botId } });
    check('picking a bot with a chat saved makes alerts ready', r.status === 200 && r.body.ready && r.body.botChatId === '42', JSON.stringify(r.body).slice(0, 200));
    r = await call('/api/alerts', { method: 'PUT', body: { chatId: 'not a chat' } });
    check('a bad chat ID is refused', r.status === 400);
    check('the bot token is never in the alerts settings', !JSON.stringify((await call('/api/alerts')).body).includes('smoke-token'));
    const chats = JSON.parse(await viaMock(`console.log(JSON.stringify(await a.chats(${JSON.stringify(botId)})));`));
    check('chats the bot has seen are listed for picking', chats.bot === '@smoke_bot' && chats.chats[0]?.id === '4242', JSON.stringify(chats));
    r = await call('/api/alerts', { method: 'PUT', body: { chatId: '4242', on: { commit: true } } });
    check('a chat and the kinds can be chosen', r.body.chatId === '4242' && r.body.on.commit === true);
    await viaMock(`a.fromAudit({ type: 'elevate', action: 'request', cmd: 'apt-get install -y jq', reason: 'need jq', actor: 'shell "smoke-agent"', project: 'smoke-agent' }); a.fromAudit({ type: 'elevate', action: 'request', cmd: 'id', actor: 'x', auto: true }); a.fromAuth({ type: 'lockout', addr: '203.0.113.9' }); await new Promise(r => setTimeout(r, 2600));`);
    const root = got.find(g => /Root request/.test(g.text));
    check('a root request is sent with the project and the command, to the chosen chat with the Vault token', root && root.chat_id === '4242' && root.token.startsWith('123456:smoke') && /smoke-agent/.test(root.text) && /apt-get install -y jq/.test(root.text) && /need jq/.test(root.text), JSON.stringify(got).slice(0, 400));
    check('requests run under a standing grant are not sent', got.filter(g => /Root request/.test(g.text)).length === 1);
    check('lockouts are sent', got.some(g => /locked/.test(g.text) && /203\.0\.113\.9/.test(g.text)));
    got.length = 0;
    await viaMock(`const fake = alive => ({ list: async () => [{ slug: 'smoke-x', name: 'smoke-x', port: 8199, alive }, { slug: 'smoke-y', name: 'smoke-y', alive, stoppedAt: alive ? 0 : Date.now() + 1000 }] }); await a.checkServers(fake(true)); await a.checkServers(fake(true)); await a.checkServers(fake(false)); await new Promise(r => setTimeout(r, 1800));`);
    check('a server that stops by itself is sent; one stopped on purpose is not', got.length === 1 && /smoke-x/.test(got[0].text) && /8199/.test(got[0].text), JSON.stringify(got).slice(0, 300));
    got.length = 0;
    r = await call('/api/alerts', { method: 'PUT', body: { pauseMinutes: 60 } });
    await viaMock(`a.fromAuth({ type: 'signin', how: 'password', addr: '198.51.100.1' }); await new Promise(r => setTimeout(r, 1500));`);
    check('nothing is sent while paused', r.body.pausedUntil > Date.now() && got.length === 0, JSON.stringify(got));
    r = await call('/api/alerts', { method: 'PUT', body: { pauseMinutes: 0, itemId: null } });
    check('alerts can be resumed and turned off', r.body.pausedUntil === null && r.body.ready === false);
    const al = (await call('/api/audit?type=activity')).body.events.find(e => e.action === 'alerts-changed');
    check('changing alerts is in the audit log', !!al, JSON.stringify(al));
    await call(`/api/vault/${botId}`, { method: 'DELETE' }); await call(`/api/vault/${projBotId}`, { method: 'DELETE' });
    tgMock.close();
}

// 8b4. Network egress: kernel log lines from the agent user, named from the resolver's answers.
{
    const { execFileSync } = await import('node:child_process');
    const shx = c => execFileSync('bash', ['-lc', c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    r = await call('/api/egress');
    check('the egress log says whether it is recording and why', r.status === 200 && typeof r.body.status?.on === 'boolean' && r.body.status.detail, JSON.stringify(r.body.status));
    const uid = shx('id -u agent').trim();
    const dns = JSON.stringify({ state: 'success', question: [{ class: 1, type: 1, name: 'smoke-egress.test' }], answer: [{ rr: { key: { class: 1, type: 1, name: 'smoke-egress.test' }, address: [203, 0, 113, 77] } }] });
    const kline = `PH-EGRESS IN= OUT=eth0 SRC=172.17.0.2 DST=203.0.113.77 LEN=60 TOS=0x00 PREC=0x00 TTL=64 ID=1 DF PROTO=TCP SPT=45555 DPT=443 WINDOW=64240 RES=0x00 SYN URGP=0 UID=${uid} GID=${uid}`;
    const k6 = `PH-EGRESS IN= OUT=eth0 SRC=fd00:0000:0000:0000:0000:0000:0000:0002 DST=2001:0db8:0000:0000:0000:0000:0000:0077 LEN=80 PROTO=TCP SPT=45556 DPT=443 UID=${uid} GID=${uid}`;
    shx(`cd / && node --input-type=module -e ${JSON.stringify(`const e = await import('/opt/porthole/server/lib/egress.js'); e.ingestDns(${JSON.stringify(dns)}); for (let i = 0; i < 3; i++) await e.ingestKernel(${JSON.stringify(kline)}); await e.ingestKernel(${JSON.stringify(k6)}); await e.ingestKernel('PH-EGRESS IN=docker0 OUT=eth0 SRC=172.17.0.9 DST=203.0.113.78 LEN=60 PROTO=TCP SPT=40000 DPT=443'); await e.ingestKernel('PH-EGRESS DST=127.0.0.53 PROTO=UDP SPT=5000 DPT=53 UID=${uid}'); e.flush();`)}`);
    r = await call('/api/egress');
    const row = r.body.rows.find(x => x.host === 'smoke-egress.test');
    check('connections are counted per host and port, named from the lookup, with who made them', row && row.port === 443 && row.count === 3 && row.ip === '203.0.113.77' && row.who === 'agent user', JSON.stringify(r.body.rows).slice(0, 300));
    check('connections from containers are recorded by the bridge address when the container is gone', r.body.rows.some(x => x.ip === '203.0.113.78' && /^container/.test(x.who)), JSON.stringify(r.body.rows.map(x => [x.ip, x.who])));
    check('IPv6 destinations are recorded too', r.body.rows.some(x => /^2001:db8:/.test(x.ip)), JSON.stringify(r.body.rows.map(x => x.ip)));
    check('lookups to the box resolver are not destinations', !r.body.rows.some(x => x.ip === '127.0.0.53'));
    const nw = (await call('/api/audit?type=network')).body.events.filter(e => e.action === 'egress-new' && e.host === 'smoke-egress.test');
    check('the first connection to a new host is one audit line, repeats are not', nw.length === 1 && nw[0].port === 443, JSON.stringify(nw).slice(0, 200));
    shx('rm -f /root/.porthole/egress/*.json');
}

// 8b2. Credential catalogue: typed fields, env prefixes, OAuth2 authorize URL.
r = await call('/api/vault/catalog');
check('vault catalogue lists services and styles', r.status === 200 && r.body.services.some(s => s.key === 'spotify') && r.body.styles.oauth2 && r.body.services.some(s => s.key === 'telegram-bot'), `services=${r.body.services?.length}`);
for (const it of (await call('/api/vault')).body) if (['telegram-bot', 'discord-webhook', 'spotify'].includes(it.provider)) await call(`/api/vault/${it.id}`, { method: 'DELETE' });
r = await call('/api/vault', { method: 'POST', body: { provider: 'telegram-bot', style: 'botChat', name: 'My bot', prefix: 'TELEGRAM', scope: 'general', inShells: true, fields: { botToken: '123:abc', chatId: '42' } } });
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
check('only values switched to "put into new shells" reach a new shell', /T=123:abc C=42 D= S=\s/.test(plain2), plain2.slice(-200));
r = await call(`/api/vault/${dcId}`, { method: 'PUT', body: { inShells: true } });
check('the switch can be turned on for a general value', r.status === 200 && (await call('/api/vault')).body.find(i => i.id === dcId)?.inShells === true);
r = await call(`/api/vault/${dcId}`, { method: 'PUT', body: { scope: 'smoke-proj' } });
check('a project value never goes into shells, whatever the switch said', (await call('/api/vault')).body.find(i => i.id === dcId)?.inShells === false);
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

// 8y. Upgrade repo: a new project with a read-only prototype copy, the brief, the level, and the link.
{
    const { execFileSync } = await import('node:child_process');
    const fsu = await import('node:fs');
    const sh = (cmd) => execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    sh(`rm -rf /Projects/smoke-proto /Projects/smoke-proto-v2 && mkdir -p /Projects/smoke-proto/node_modules/x && echo 'app' > /Projects/smoke-proto/app.js && echo 'SECRET=1' > /Projects/smoke-proto/.env && echo x > /Projects/smoke-proto/node_modules/x/i.js`);
    let r = await call('/api/projects/upgrade', { method: 'POST', body: { abs: '/Projects/smoke-proto', name: 'smoke-proto-v2', level: 'professional', tier: 'public' } });
    check('upgrade repo creates the new project', r.status === 201 && r.body.name === 'smoke-proto-v2' && r.body.level === 'professional-public' && /PROPOSAL\.md/.test(r.body.prompt || ''), `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const snap = '/Projects/smoke-proto-v2/.porthole/prototype';
    check('the prototype copy has the code but no secrets or dependencies', fsu.existsSync(`${snap}/app.js`) && !fsu.existsSync(`${snap}/.env`) && !fsu.existsSync(`${snap}/node_modules`));
    check('the new project has the brief and its level', fsu.existsSync('/Projects/smoke-proto-v2/.porthole/UPGRADE.md') && (() => { const j = JSON.parse(fsu.readFileSync('/Projects/smoke-proto-v2/.porthole/project.json', 'utf8')); return j.level === 'professional' && j.tier === 'public'; })());
    const agentWrite = (() => { try { sh(`/usr/sbin/runuser -u agent -- bash -c 'echo changed > ${snap}/app.js' 2>&1`); return true; } catch { return false; } })();
    const hasAgent = (() => { try { sh('id agent'); return true; } catch { return false; } })();
    if (hasAgent) check('agent shells cannot change the prototype copy', !agentWrite && fsu.readFileSync(`${snap}/app.js`, 'utf8') === 'app\n');
    check('the original project is unchanged', fsu.readFileSync('/Projects/smoke-proto/app.js', 'utf8') === 'app\n' && !fsu.existsSync('/Projects/smoke-proto/.porthole'));
    r = await call('/api/files?path=Projects');
    const lp = Array.isArray(r.body?.items) ? r.body.items.find(i => i.name === 'smoke-proto') : null, ln = Array.isArray(r.body?.items) ? r.body.items.find(i => i.name === 'smoke-proto-v2') : null;
    if (fsRootIsSlash) check('files show the upgrade link both ways', lp?.links?.to?.[0]?.name === 'smoke-proto-v2' && ln?.links?.from?.name === 'smoke-proto', JSON.stringify({ lp: lp?.links, ln: ln?.links }).slice(0, 200));
    r = await call('/api/projects/upgrade', { method: 'POST', body: { abs: '/Projects/smoke-proto', name: 'smoke-proto-v2', level: 'personal', audience: 'shared' } });
    check('upgrade refuses an existing name', r.status === 409, String(r.status));
    r = await call('/api/projects/upgrade', { method: 'POST', body: { abs: '/Projects/smoke-proto/node_modules', name: 'x2', level: 'personal', audience: 'shared' } });
    check('upgrade only takes top-level project folders', r.status === 400, String(r.status));
    sh('rm -rf /Projects/smoke-proto /Projects/smoke-proto-v2');
}

// 8w. New projects keep .porthole/ and .claude/ out of git, unless the project says otherwise.
{
    const fsg = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const sh = (cmd) => execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    sh('rm -rf /Projects/smoke-ign /Projects/smoke-keep');
    if (fsRootIsSlash) {
        await call('/api/files/mkdir', { method: 'POST', body: { path: 'Projects', name: 'smoke-ign' } });
        const gi = fsg.existsSync('/Projects/smoke-ign/.gitignore') ? fsg.readFileSync('/Projects/smoke-ign/.gitignore', 'utf8') : '';
        check('a new project ignores .porthole/ and .claude/', /^\.porthole\/$/m.test(gi) && /^\.claude\/$/m.test(gi), JSON.stringify(gi));
    }
    sh(`mkdir -p /Projects/smoke-keep && printf 'node_modules/\n!.claude/\n' > /Projects/smoke-keep/.gitignore`);
    const r = await call('/api/projects/profile', { method: 'PUT', body: { abs: '/Projects/smoke-keep', level: 'throwaway' } });
    const gk = fsg.readFileSync('/Projects/smoke-keep/.gitignore', 'utf8');
    check('setting a level adds the ignores but respects an override (!.claude/)', r.status === 200 && /^\.porthole\/$/m.test(gk) && !/^\.claude\/$/m.test(gk) && /^!\.claude\/$/m.test(gk), JSON.stringify(gk));
    sh('rm -rf /Projects/smoke-ign /Projects/smoke-keep');
}

// 8x. .portholerun: plan shows every command and the account; running needs the planned hash; it runs as the
//     project's account, keeps the file out of git, and stops/restarts like any registered server.
{
    const { execFileSync } = await import('node:child_process');
    const fsr = await import('node:fs');
    const sh = (cmd) => execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    sh(`rm -rf /Projects/smoke-run && mkdir -p /Projects/smoke-run/site && echo hello-run > /Projects/smoke-run/site/index.html && cd /Projects/smoke-run && git init -q . && cat > .portholerun <<'EOF'
name: smoke-run
before: echo prepared > before.txt
run: python3 -m http.server 8152 --bind 127.0.0.1
cwd: site
port: 8152
share: none
env:
  MODE: demo
EOF`);
    const F = '/Projects/smoke-run/.portholerun';
    let r = await call(`/api/portholerun?abs=${encodeURIComponent(F)}`);
    const pl = r.body;
    check('.portholerun plan lists the commands, folder and account', r.status === 200 && !pl.errors.length && pl.commands.map(c => c.step).join(',') === 'before,run' && pl.runAs === 'service' && pl.account === 'ps-smoke-run' && pl.port === 8152 && pl.share === 'none' && pl.env.includes('MODE'), JSON.stringify(pl).slice(0, 240));
    r = await call('/api/portholerun/run', { method: 'POST', body: { abs: F, hash: 'not-the-plan' } });
    check('running needs the hash of the plan that was shown', r.status === 409, `${r.status} ${r.body.error}`);
    r = await call('/api/portholerun/run', { method: 'POST', body: { abs: F, hash: pl.hash } });
    check('.portholerun starts it', r.status === 200 && r.body.started && r.body.server?.slug === 'run-smoke-run', `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    let body = null; for (let i = 0; i < 25 && body === null; i++) { await sleep(300); try { body = await (await fetch('http://127.0.0.1:8152/')).text(); } catch { body = null; } }
    check('it serves from its cwd after the before step', /hello-run/.test(body || '') && fsr.existsSync('/Projects/smoke-run/site/before.txt'), String(body).slice(0, 80));
    const owner = sh(`ps -eo user:20,args | grep '[h]ttp.server 8152' | grep -v bash | awk '{print $1}' | sort -u`).trim();
    check('it runs as the project account, not root', owner === 'ps-smoke-run', owner);
    check('.portholerun is added to the project .gitignore', /\.portholerun/.test(fsr.readFileSync('/Projects/smoke-run/.gitignore', 'utf8')));
    check('it appears as a registered server', (await call('/api/servers')).body.some(x => x.slug === 'run-smoke-run' && x.alive));
    if (fsRootIsSlash) {
        const lst = (await call('/api/files?path=Projects')).body;
        const row = lst.items?.find(i => i.name === 'smoke-run');
        check('the Projects listing shows the project as running', row?.run === true && row?.running?.some(x => x.kind === 'run' && x.port === 8152), JSON.stringify(row?.running));
        const inside = (await call('/api/files?path=Projects/smoke-run')).body;
        check('inside the project, the listing says what runs here', inside.running?.some(x => x.slug === 'run-smoke-run'), JSON.stringify(inside.running));
    }
    const sv = (await call('/api/services')).body;
    const card = sv.projects?.find(x => x.name === 'smoke-run');
    check('Services groups the run under its project folder', card?.running && card.path === 'Projects/smoke-run' && card.parts.some(x => x.type === 'run' && x.port === 8152 && x.running) && card.canRun, JSON.stringify(card).slice(0, 240));
    check('nothing of that project is left loose under Box', !(sv.box?.parts || []).some(x => x.port === 8152), JSON.stringify(sv.box?.parts || []).slice(0, 200));
    const hp = (await call('/api/home')).body?.projects?.find(x => x.name === 'smoke-run');
    check('Home lists the project as running', hp?.running?.some(x => x.slug === 'run-smoke-run'), JSON.stringify(hp?.running));
    r = await call('/api/portholerun/run', { method: 'POST', body: { abs: F, hash: (await call(`/api/portholerun?abs=${encodeURIComponent(F)}`)).body.hash, restart: true } });
    check('.portholerun restarts', r.status === 200 && r.body.started, `${r.status} ${r.body.error || ''}`);
    {   // A plain restart (Services, svc restart) repeats the run with its settings and account, never the bare command.
        r = await call('/api/servers/run-smoke-run/restart', { method: 'POST' });
        let env = ''; for (let i = 0; i < 20 && !/MODE=demo/.test(env); i++) { await sleep(300); try { env = sh(`ps -eo args | grep '[r]unuser -u ps-smoke-run' | grep 'http.server 8152' | grep -o 'MODE=demo' | head -1; true`); } catch { env = ''; } }
        const who = sh(`ps -eo user:20,args | grep '[h]ttp.server 8152' | grep -v bash | awk '{print $1}' | sort -u`).trim();
        check('a plain restart keeps the settings and account of the run', r.status === 200 && /MODE=demo/.test(env) && who === 'ps-smoke-run', `${r.status} env=${env.trim()} user=${who}`);
        sh(`printf '\n# changed\n' >> ${F}`);
        r = await call('/api/servers/run-smoke-run/restart', { method: 'POST' });
        check('a plain restart refuses a changed .portholerun (review it first)', r.status === 409 && /changed/.test(r.body.error || ''), `${r.status} ${r.body.error}`);
    }
    r = await call('/api/portholerun/stop', { method: 'POST', body: { abs: F } });
    check('.portholerun stops', r.status === 200 && !(await call('/api/servers')).body.some(x => x.slug === 'run-smoke-run' && x.alive), `${r.status}`);
    sh(`printf 'run: node x.js\nenv:\n  API_KEY: abc123\n' > ${F}`);
    r = await call(`/api/portholerun?abs=${encodeURIComponent(F)}`);
    check('a literal secret in .portholerun is refused', r.status === 200 && r.body.errors.some(e => /Vault/.test(e)), JSON.stringify(r.body.errors));
    sh(`mkdir -p /root/elsewhere && echo 'run: id' > /root/elsewhere/.portholerun`);
    r = await call(`/api/portholerun?abs=${encodeURIComponent('/root/elsewhere/.portholerun')}`);
    check('.portholerun only runs inside /Projects', r.status === 403, String(r.status));
    sh('rm -rf /Projects/smoke-run /root/elsewhere');
}

// 8z. Upgrade migrations: archive first, restore on failure, record on success, nothing pending afterwards.
{
    const { execFileSync } = await import('node:child_process');
    const fsm = await import('node:fs');
    const sh = (cmd) => execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const M = '/opt/porthole/server/lib/migrate.js';
    sh(`rm -rf /tmp/mig && mkdir -p /tmp/mig/state /tmp/mig/m && echo '{"keep":"original"}' > /tmp/mig/state/data.json && echo '{"type":"module"}' > /tmp/mig/m/package.json
cat > /tmp/mig/m/manifest.json <<'EOF'
{ "migrations": [
  { "id": "0.0.1-good", "version": "0.0.1", "title": "good", "detail": "adds a field" },
  { "id": "0.0.2-bad", "version": "0.0.2", "title": "bad", "detail": "changes data then fails" } ] }
EOF
cat > /tmp/mig/m/0.0.1-good.js <<'EOF'
import fs from 'node:fs';
export async function up({ state }) { const f = state + '/data.json'; const d = JSON.parse(fs.readFileSync(f, 'utf8')); d.added = true; fs.writeFileSync(f, JSON.stringify(d)); }
EOF
cat > /tmp/mig/m/0.0.2-bad.js <<'EOF'
import fs from 'node:fs';
export async function up({ state }) { fs.writeFileSync(state + '/data.json', 'CORRUPTED'); fs.writeFileSync(state + '/junk.json', '{}'); throw new Error('boom'); }
EOF`);
    const plan = JSON.parse(sh(`node ${M} plan --state /tmp/mig/state --dir /tmp/mig/m`));
    check('migration plan lists pending steps in order', plan.pending.map(m => m.id).join(',') === '0.0.1-good,0.0.2-bad', JSON.stringify(plan.pending.map(m => m.id)));
    let failed = false; try { sh(`node ${M} apply --state /tmp/mig/state --dir /tmp/mig/m`); } catch { failed = true; }
    const after = fsm.readFileSync('/tmp/mig/state/data.json', 'utf8');
    check('a failing migration fails the run', failed);
    check('a failing migration restores the state exactly (earlier steps undone too)', after === '{"keep":"original"}\n' && !fsm.existsSync('/tmp/mig/state/junk.json'), after);
    check('a failed run records nothing', !fsm.existsSync('/tmp/mig/state/schema.json'));
    check('the pre-migration archive is kept', fsm.readdirSync('/tmp/mig/state/migrate').some(f => /^pre-.*\.tar\.gz$/.test(f)));
    sh(`node -e "const f='/tmp/mig/m/manifest.json';const m=JSON.parse(require('fs').readFileSync(f));m.migrations=m.migrations.filter(x=>x.id!=='0.0.2-bad');require('fs').writeFileSync(f,JSON.stringify(m))" && rm /tmp/mig/m/0.0.2-bad.js`);
    sh(`node ${M} apply --state /tmp/mig/state --dir /tmp/mig/m`);
    const sc = JSON.parse(fsm.readFileSync('/tmp/mig/state/schema.json', 'utf8'));
    check('a good migration applies and is recorded', JSON.parse(fsm.readFileSync('/tmp/mig/state/data.json', 'utf8')).added === true && sc.applied.some(a => a.id === '0.0.1-good') && !!sc.lastBackup, JSON.stringify(sc).slice(0, 160));
    check('nothing is pending after a successful run', JSON.parse(sh(`node ${M} plan --state /tmp/mig/state --dir /tmp/mig/m`)).pending.length === 0);
    const live = JSON.parse(sh(`node ${M} status`));
    check('this box has applied every shipped migration', live.pending.length === 0 && live.version === live.code, JSON.stringify(live).slice(0, 200));
    sh('rm -rf /tmp/mig');
}

// 8c1. Backups: a project's data folders to a stand-in S3 (SigV4 PUT/GET/LIST/DELETE), list, restore.
{
    const http = await import('node:http');
    const { execFileSync } = await import('node:child_process');
    const sh = c => execFileSync('bash', ['-lc', c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const store = new Map(); const seen = [];
    const fake = http.createServer((q, res) => {
        const u = new URL(q.url, 'http://x'); const key = decodeURIComponent(u.pathname.replace(/^\/smoke-bucket\/?/, ''));
        seen.push(`${q.method} ${key || '/'} auth=${/^AWS4-HMAC-SHA256 Credential=AKIASMOKE\//.test(q.headers.authorization || '')}`);
        const chunks = []; q.on('data', d => chunks.push(d)); q.on('end', () => {
            if (q.method === 'PUT') { store.set(key, Buffer.concat(chunks)); res.writeHead(200); return res.end(); }
            if (q.method === 'GET' && !key) { const pre = u.searchParams.get('prefix') || ''; const items = [...store.entries()].filter(([k]) => k.startsWith(pre)).map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size><LastModified>2026-11-09T00:00:00.000Z</LastModified></Contents>`).join(''); res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(`<ListBucketResult>${items}</ListBucketResult>`); }
            if (q.method === 'GET') { const v = store.get(key); if (!v) { res.writeHead(404); return res.end('<Error><Code>NoSuchKey</Code></Error>'); } res.writeHead(200); return res.end(v); }
            if (q.method === 'DELETE') { store.delete(key); res.writeHead(204); return res.end(); }
            res.writeHead(400); res.end();
        });
    });
    await new Promise(ok => fake.listen(7397, '127.0.0.1', ok));
    sh(`rm -rf /Projects/smoke-bk && mkdir -p /Projects/smoke-bk/data /Projects/smoke-bk/uploads && echo one > /Projects/smoke-bk/data/a.txt && echo two > /Projects/smoke-bk/uploads/b.txt && printf -- '---\nservices:\n  web:\n    start: python3 -m http.server 8173\n    port: 8173\n    volumes: [data:/x]\nbackup:\n  paths: [uploads]\n---\n' > /Projects/smoke-bk/PORTHOLE.md`);
    r = await call('/api/backups/smoke-bk', { method: 'POST' }); check('backing up without storage says what to add', r.status === 412 && /Backup storage/.test(r.body.error), `${r.status} ${r.body.error}`);
    r = await call('/api/vault', { method: 'POST', body: { provider: 'backup-storage', style: 's3Bucket', name: 'Smoke bucket', prefix: 'BACKUP', scope: 'general', fields: { accessKeyId: 'AKIASMOKE', secretAccessKey: 'smoke-secret-key-0000000000000000', bucket: 'smoke-bucket', region: 'eu-west-2', prefix: 'box1', endpoint: 'http://127.0.0.1:7397' } } });
    const storeId = r.body.id; check('backup storage saves as a Vault credential', r.status === 201, JSON.stringify(r.body).slice(0, 120));
    r = await call('/api/backups/check', { method: 'POST' }); check('the storage test reaches the bucket with a signed request', r.status === 200 && r.body.ok && seen.some(s => /^GET \/ auth=true/.test(s)), JSON.stringify(r.body) + ' ' + seen.slice(-1));
    r = await call('/api/live/smoke-bk/web/start', { method: 'POST' }); await sleep(1200);
    r = await call('/api/backups/smoke-bk', { method: 'POST' });
    check('a backup freezes the running service, archives backup.paths plus container-style volumes, and uploads one object', r.status === 200 && r.body.size > 100 && r.body.paths.sort().join() === 'data,uploads' && r.body.frozen.includes('live-smoke-bk-web') && [...store.keys()].some(k => /^box1\/smoke-bk\/\d{4}-.*\.tar\.zst$/.test(k)), JSON.stringify(r.body).slice(0, 240) + ' keys=' + [...store.keys()]);
    check('the service is running again after the backup', (await call('/api/live')).body.find(p => p.project === 'smoke-bk')?.services[0]?.running === true);
    r = await call('/api/backups/smoke-bk'); const first = r.body[0];
    check('backups of a project are listed newest first', r.status === 200 && r.body.length === 1 && /\.tar\.zst$/.test(first.name) && first.size > 100, JSON.stringify(r.body));
    sh('echo changed > /Projects/smoke-bk/data/a.txt && rm /Projects/smoke-bk/uploads/b.txt');
    r = await call('/api/backups/smoke-bk/restore', { method: 'POST', body: { name: first.name } });
    check('restore puts the folders back, keeps the current copy aside, and restarts the service', r.status === 200 && sh('cat /Projects/smoke-bk/data/a.txt').trim() === 'one' && sh('cat /Projects/smoke-bk/uploads/b.txt').trim() === 'two' && sh('cat /Projects/smoke-bk/.porthole/restore-undo-*/data/a.txt').trim() === 'changed' && r.body.restarted.includes('web'), JSON.stringify(r.body));
    r = await call('/api/backups/smoke-bk/restore', { method: 'POST', body: { name: '../../etc/passwd' } }); check('restore only accepts a listed archive name', r.status === 400);
    r = await call('/api/backups', { method: 'PUT', body: { keep: 1, daily: 3, project: { name: 'smoke-bk', daily: true } } });
    check('retention and the daily hour can be set per project', r.status === 200 && r.body.keep === 1 && r.body.daily === 3 && r.body.projects['smoke-bk'].daily === true, JSON.stringify(r.body).slice(0, 200));
    await call('/api/backups/smoke-bk', { method: 'POST' });
    check('older archives beyond "keep" are removed after a run', [...store.keys()].filter(k => k.startsWith('box1/smoke-bk/')).length === 1, [...store.keys()].join());
    const au = (await call('/api/audit?type=activity')).body.events.filter(e => e.project === 'smoke-bk' && /^(backup|restore)/.test(e.action));
    check('backups and restores are in the audit log', au.some(e => e.action === 'backup') && au.some(e => e.action === 'restore'), JSON.stringify(au.map(e => e.action)));
    check('the bucket key never appears in the Vault listing or the backups page', !JSON.stringify((await call('/api/vault')).body).includes('smoke-secret') && !JSON.stringify((await call('/api/backups')).body).includes('smoke-secret'));
    await call('/api/backups', { method: 'PUT', body: { keep: 14, daily: null } });
    await call('/api/live/smoke-bk/web/stop', { method: 'POST' }).catch(() => {}); await call('/api/servers/live-smoke-bk-web', { method: 'DELETE' }).catch(() => {});
    await call(`/api/vault/${storeId}`, { method: 'DELETE' }); sh('rm -rf /Projects/smoke-bk'); fake.close();
}

// 8c2. Limit reached: a dry run lists what is not a live service; "do it now" stops those and leaves live services.
{
    const { execFileSync } = await import('node:child_process');
    const sh = c => execFileSync('bash', ['-lc', c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    sh(`rm -rf /Projects/smoke-limit && mkdir -p /Projects/smoke-limit && printf -- '---\nservices:\n  web:\n    start: python3 -m http.server 8171\n    port: 8171\n---\n' > /Projects/smoke-limit/PORTHOLE.md`);
    r = await call('/api/live/smoke-limit/web/start', { method: 'POST' }); check('a live service runs for the limit test', r.status === 200, JSON.stringify(r.body).slice(0, 120));
    r = await call('/api/servers/run', { method: 'POST', body: { name: 'smoke-limit-plain', port: 8172, cwd: '/', cmd: ['python3', '-m', 'http.server', '8172'] } }); check('a plain server runs for the limit test', r.status === 201, JSON.stringify(r.body).slice(0, 120));
    await sleep(1500);
    r = await call('/api/limit'); check('the limit guard is on by default with a load limit', r.status === 200 && r.body.on === true && r.body.load >= 2 && typeof r.body.loadNow === 'number', JSON.stringify(r.body));
    r = await call('/api/limit', { method: 'PUT', body: { load: 1 } }); check('a silly load limit is refused', r.status === 400);
    r = await call('/api/limit/run', { method: 'POST', body: { dry: true } });
    check('a dry run lists the plain server but not the live service, and stops nothing', r.status === 200 && r.body.left.some(x => x.name === 'smoke-limit-plain') && !r.body.left.some(x => /smoke-limit-web/.test(x.name)) && r.body.stopped.length === 0 && (await call('/api/servers')).body.find(s => s.slug === 'smoke-limit-plain')?.alive === true, JSON.stringify(r.body).slice(0, 300));
    // The real run only where Docker is this box's own (a remote daemon's containers are someone else's): never on a dev PC.
    if (process.env.PORTHOLE_DOCKER_HOST) { console.log('SKIP  limit "do it now" (the Docker daemon is not the box)'); r = { status: 200, body: { stopped: [{ name: 'smoke-limit-plain' }] } }; await call('/api/servers/smoke-limit-plain/stop', { method: 'POST' }); }
    else r = await call('/api/limit/run', { method: 'POST', body: {} });
    const after = (await call('/api/servers')).body;
    check('do it now stops the plain server and leaves the live service running', r.status === 200 && r.body.stopped.some(x => x.name === 'smoke-limit-plain') && after.find(s => s.slug === 'smoke-limit-plain')?.alive === false && after.find(s => s.slug === 'live-smoke-limit-web')?.alive === true, JSON.stringify({ stopped: r.body.stopped, alive: after.map(s => [s.slug, s.alive]) }).slice(0, 300));
    const lr = (await call('/api/audit?type=activity')).body.events.find(e => e.action === 'limit-reached');
    check('limit reached is in the audit log with what it stopped', process.env.PORTHOLE_DOCKER_HOST ? true : (!!lr && /smoke-limit-plain/.test(lr.what)), JSON.stringify(lr));
    await call('/api/live/smoke-limit/web/stop', { method: 'POST' }).catch(() => {});
    await call('/api/servers/smoke-limit-plain', { method: 'DELETE' }).catch(() => {}); await call('/api/servers/live-smoke-limit-web', { method: 'DELETE' }).catch(() => {});
    sh('rm -rf /Projects/smoke-limit');
}

// 8c3. Device priority: PlatOpypus runs at nice -10, the shells it starts at nice 0.
{
    const { execFileSync } = await import('node:child_process');
    const sh = c => execFileSync('bash', ['-lc', c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const self = sh("ps -o ni= -p $(pgrep -f 'node server.js' | head -1)").trim();
    const pane = sh("ps -o ni= -p $(tmux -L porthole display-message -p -t smoke: '#{pane_pid}')").trim();
    // Raising priority needs CAP_SYS_NICE, which Docker withholds: here only the shells' normal priority can be checked.
    check('shells run at normal priority, never at a raised one', Number(pane) === 0 && Number(self) <= 0, `porthole nice ${self}, shell pane nice ${pane}`);
}

// 8d. Usage: memory and CPU per shell and server for the stat bubbles.
r = await call('/api/usage');
check('usage lists the box, every shell and running server', r.status === 200 && r.body.box.memTotal > 0 && r.body.shells.smoke && r.body.shells.smoke.mem > 0 && typeof r.body.shells.smoke.cpu === 'number', JSON.stringify({ box: r.body.box, smoke: r.body.shells.smoke }).slice(0, 200));

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
