// Upgrade test (CI "upgrade" job): fill a box running the previous stable release with real data, update it with
// its own updater, then prove nothing was lost and the new release's migrations ran.
//   node test/upgrade.mjs seed     on the old version: creates data, writes /root/upgrade-expect.json
//   node test/upgrade.mjs verify   on the new version: checks every item in that file
// Only uses API routes that exist since 1.3.0 (UPDATE.md: routes are append-only within a MAJOR).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://127.0.0.1:7331';
const TOKEN = process.env.TOKEN || 'porthole-test';
const EXPECT = process.env.EXPECT || '/root/upgrade-expect.json';
const STATE = process.env.PORTHOLE_STATE || '/root/.porthole';
const PASSWORD = 'upgrade-password-12345';
const mode = process.argv[2];
let cookie = '';
let failures = 0, checks = 0;
const check = (name, ok, extra = '') => { checks++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); if (!ok) failures++; };
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sh = cmd => execFileSync('bash', ['-lc', cmd], { encoding: 'utf8' });

async function call(path, { method = 'GET', body } = {}) {
    const h = { 'X-Porthole': '1' };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers: h, body });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

if (mode === 'seed') {
    const ex = { password: PASSWORD, vault: [], files: {}, created: Date.now() };
    let r = await call('/api/setup/password', { method: 'POST', body: { token: TOKEN, password: PASSWORD } });
    check('old version: password setup', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    ex.version = (await call('/api/me')).body.version || null;
    for (const v of [
        { name: 'upgrade general token', prefix: 'UPG_GENERAL', scope: '', value: 'general-' + crypto.randomBytes(6).toString('hex') },
        { name: 'upgrade project token', prefix: 'UPG_PROJECT', scope: 'Projects/upgrade-app', value: 'project-' + crypto.randomBytes(6).toString('hex') },
    ]) {
        r = await call('/api/vault', { method: 'POST', body: { provider: 'custom', style: 'token', name: v.name, prefix: v.prefix, scope: v.scope, fields: { token: v.value } } });
        check(`old version: vault entry "${v.name}"`, r.status === 201 && r.body.id, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
        ex.vault.push({ id: r.body.id, name: v.name, value: v.value });
    }
    sh('mkdir -p /Projects/upgrade-app/data && echo "app code" > /Projects/upgrade-app/app.js && head -c 200000 /dev/urandom > /Projects/upgrade-app/data/blob.bin && echo \'{"count":41}\' > /Projects/upgrade-app/data/count.json');
    for (const f of ['/Projects/upgrade-app/app.js', '/Projects/upgrade-app/data/blob.bin', '/Projects/upgrade-app/data/count.json']) ex.files[f] = sha(f);
    r = await call('/api/shells', { method: 'POST', body: { name: 'upgrade-shell', kind: 'shell', cwd: '/Projects/upgrade-app' } });
    check('old version: a shell', r.status === 201, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    ex.shell = 'upgrade-shell';
    sh(`tmux -L porthole send-keys -t upgrade-shell: 'echo before-upgrade-marker' Enter`);
    r = await call('/api/servers/run', { method: 'POST', body: { name: 'upgrade server', port: 8150, cwd: '/Projects/upgrade-app', cmd: ['python3', '-m', 'http.server', '8150'] } });
    check('old version: a registered server', r.status === 201, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    ex.server = r.body.slug || 'upgrade-server';
    ex.stateFiles = fs.readdirSync(STATE).filter(f => /\.json$/.test(f) && !/^update/.test(f));
    fs.writeFileSync(EXPECT, JSON.stringify(ex, null, 2));
    console.log(`\nseeded ${ex.version}: ${ex.vault.length} vault entries, ${Object.keys(ex.files).length} files, shell, server; state files: ${ex.stateFiles.join(' ')}`);
} else if (mode === 'verify') {
    const ex = JSON.parse(fs.readFileSync(EXPECT, 'utf8'));
    const want = process.env.NEW_VERSION;
    const result = JSON.parse(fs.readFileSync(`${STATE}/update-result.json`, 'utf8'));
    check('the update reports success', result.ok === true, JSON.stringify(result));
    let r = await call('/api/login/password', { method: 'POST', body: { password: ex.password } });
    check('the old password still signs in', r.status === 200, String(r.status));
    const me = (await call('/api/me')).body;
    check(`the box now runs ${want}`, !want || me.version === want, `${ex.version} → ${me.version}`);
    for (const v of ex.vault) {
        r = await call(`/api/vault/${v.id}/reveal`, { method: 'POST', body: {} });
        check(`vault entry "${v.name}" kept its value`, r.status === 200 && (r.body.value === v.value || r.body.fields?.token === v.value), `${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
    }
    for (const [f, h] of Object.entries(ex.files)) check(`project file kept: ${f}`, fs.existsSync(f) && sha(f) === h);
    const shells = (await call('/api/shells')).body;
    check('the shell survived the update', Array.isArray(shells) && shells.some(s => s.name === ex.shell));
    const pane = sh(`tmux -L porthole capture-pane -p -t ${ex.shell}: -S -200 || true`);
    check('the shell kept its scrollback (same tmux session)', /before-upgrade-marker/.test(pane));
    const servers = (await call('/api/servers')).body;
    const srv = Array.isArray(servers) && servers.find(s => s.slug === ex.server);
    check('the registered server is still registered and running', !!srv && srv.alive === true, JSON.stringify(srv && { alive: srv.alive }));
    for (const f of ex.stateFiles) check(`state file kept: ${f}`, fs.existsSync(`${STATE}/${f}`));
    const manifest = JSON.parse(fs.readFileSync('/opt/porthole/server/migrations/manifest.json', 'utf8')).migrations.map(m => m.id);
    const schema = JSON.parse(fs.readFileSync(`${STATE}/schema.json`, 'utf8'));
    check('schema.json records the new version', schema.version === me.version, schema.version);
    check('every migration of the release was applied', manifest.every(id => (schema.applied || []).some(a => a.id === id)), (schema.applied || []).map(a => a.id).join(' '));
    check('a pre-migration archive of the state exists', !manifest.length || (schema.lastBackup && fs.existsSync(schema.lastBackup)), schema.lastBackup || '');
    const plan = fs.existsSync(`${STATE}/update-plan.json`) ? JSON.parse(fs.readFileSync(`${STATE}/update-plan.json`, 'utf8')) : null;
    // The plan file comes from the hand-off updater (1.15.0+). Older updaters install without it; their boxes still
    // migrate at server start, which the checks above prove.
    const cmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
    if (ex.version && cmp(ex.version, '1.15.0') >= 0) check('the updater wrote the upgrade plan before installing', !!plan && Array.isArray(plan.pending), plan ? `${plan.from} → ${plan.to}: ${plan.pending.map(m => m.id).join(' ') || 'none'}` : 'missing');
    else console.log(`INFO  ${ex.version || 'the old version'} has no hand-off updater, so no plan file; migrations ran at server start`);
    console.log(`\n${failures ? `${failures} of ${checks} upgrade checks failed` : `all ${checks} upgrade checks passed`}`);
} else { console.error('usage: upgrade.mjs seed|verify'); process.exit(2); }
process.exit(failures ? 1 : 0);
