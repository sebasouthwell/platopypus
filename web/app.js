// Porthole v3 front end. Plain ES module, no build step.
// Tabs: Home · Shells · Services · Files · More (+ pushed pages: Vault, Security, Claude). Sheets: terminal, editor.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ASSET_V = document.querySelector('meta[name="porthole-version"]')?.content || '0';
const icon = (name, cls = 'i') => `<svg class="${cls}"><use href="/sprite.svg?v=${ASSET_V}#i-${name}"/></svg>`;

// ---------- API ----------

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function api(path, { method = 'GET', body, raw = false } = {}) {
    const headers = { 'X-Porthole': '1' };
    if (body !== undefined && !(body instanceof Blob)) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body), credentials: 'same-origin' });
    noteServerVersion(res.headers.get('x-porthole-version'));
    if (res.status === 401 && !path.startsWith('/api/login')) { showLogin(); throw new ApiError(401, 'Signed out.'); }
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || res.statusText);
    return data;
}

// ---------- helpers ----------

// The server stamps every API response with its version. A page that was loaded before an update (for example one
// started from the box CLI, which shows no overlay) keeps old code; offer a reload instead of failing quietly.
let serverVersion = null, reloadOffered = false;
function noteServerVersion(v) {
    if (!v) return;
    if (serverVersion === null) { serverVersion = v; return; }
    if (v === serverVersion || reloadOffered) return;
    reloadOffered = true;
    const el = $('#toast');
    el.innerHTML = `Porthole was updated to ${esc(v)} · <button class="linkish" id="toast-reload">Reload</button>`;
    el.classList.remove('bad'); el.hidden = false; clearTimeout(toastTimer);
    $('#toast-reload').onclick = () => location.reload();
}

function timeAgo(t) { const d = Math.max(0, Date.now() - t); if (d < 60e3) return 'just now'; if (d < 3600e3) return `${Math.round(d / 60e3)} min ago`; if (d < 86400e3) return `${Math.round(d / 3600e3)} h ago`; return `${Math.round(d / 86400e3)} d ago`; }

let toastTimer;
function toast(message, bad = false) {
    const el = $('#toast');
    el.textContent = message; el.classList.toggle('bad', bad); el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 4200 : 2200);
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtBytes(n) { if (n == null) return ''; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`; }
function fmtAgo(ts) { const s = Math.max(0, (Date.now() - ts) / 1000); if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return `${Math.floor(s / 86400)} d ago`; }
function fmtIn(ts) { const s = Math.max(0, (ts - Date.now()) / 1000); if (s < 60) return '<1 min'; if (s < 3600) return `${Math.ceil(s / 60)} min`; return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`; }
function fmtDuration(sec) { const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60); return d ? `${d} day${d > 1 ? 's' : ''}` : h ? `${h} h ${m} m` : `${m} min`; }
const shortPath = p => String(p || '').replace(/^\/home\/[^/]+(?=\/|$)/, '~').replace(/^\/root(?=\/|$)/, '~');
const basename = p => String(p || '').split('/').filter(Boolean).pop() || '~';


// Copy to the clipboard with fallbacks: async clipboard (https), then the legacy selection copy (works on iOS over
// http inside a tap), and finally a sheet that shows the text large, tap-to-select.
async function copyText(text, label = 'Copied') {
    try { await navigator.clipboard.writeText(text); toast(label); return true; } catch { /* fall through */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
        document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        ta.remove();
        if (ok) { toast(label); return true; }
    } catch { /* fall through */ }
    showCopySheet(text);
    return false;
}
function showCopySheet(text, title = 'Copy') {
    const { panel } = openDialog(`<h2>${icon('copy')}${esc(title)}</h2><p class="muted">Tap the text to select it, then copy.</p>
        <pre class="copybox" tabindex="0" style="font-size:18px;line-height:1.5;letter-spacing:.04em;user-select:all;-webkit-user-select:all;text-align:center;word-break:break-all">${esc(text)}</pre>
        <div class="buttons"><button class="primary" data-retry>Try copy again</button><button data-close>Done</button></div>`);
    const pre = $('.copybox', panel);
    const selectAll = () => { const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); };
    pre.onclick = selectAll; setTimeout(selectAll, 80);
    $('[data-retry]', panel).onclick = async () => { selectAll(); try { if (document.execCommand('copy')) { toast('Copied'); $('.dialog-backdrop').click(); } else toast('Hold the text and choose Copy', true); } catch { toast('Hold the text and choose Copy', true); } };
}

function openDialog(html) {
    const dlg = $('#dialog'), panel = $('.dialog-panel', dlg);
    panel.innerHTML = html; dlg.hidden = false;
    const close = () => { dlg.hidden = true; panel.innerHTML = ''; };
    $('.dialog-backdrop', dlg).onclick = close;
    $$('[data-close]', panel).forEach(b => (b.onclick = close));
    const first = $('input, textarea', panel);
    if (first) setTimeout(() => first.focus(), 60);
    return { panel, close };
}
function confirmDialog({ title, text, action, danger = true }) {
    return new Promise(resolve => {
        const { panel, close } = openDialog(`<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p><div class="buttons"><button class="${danger ? 'danger' : 'primary'}" data-ok>${esc(action)}</button><button data-close>Cancel</button></div>`);
        $('[data-ok]', panel).onclick = () => { close(); resolve(true); };
        $('.dialog-backdrop').addEventListener('click', () => resolve(false), { once: true });
        $('[data-close]', panel).addEventListener('click', () => resolve(false), { once: true });
    });
}
function enterSubmits(panel, fn) { $$('input', panel).forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fn(); } })); }

// ---------- auth ----------

const WA = window.SimpleWebAuthnBrowser;
let loginInfo = null;

async function showLogin() {
    $('#app').hidden = true; $('#term-sheet').hidden = true; $('#editor-sheet').hidden = true; $('#login').hidden = false;
    try { loginInfo = await (await fetch('/api/login', { credentials: 'same-origin' })).json(); } catch { loginInfo = { setup: false, passkeys: [], passwordSet: false }; }
    const setup = !!loginInfo.setup;
    $('#setup-pane').hidden = !setup; $('#login-pane').hidden = setup;
    $('#login-error').textContent = ''; $('#setup-error').textContent = '';
    if (setup) {
        const canPasskey = !!(WA && WA.browserSupportsWebAuthn() && window.isSecureContext);
        $('#setup-password-only').hidden = !(loginInfo.passwordOnlyAllowed && !canPasskey) && !(loginInfo.passwordOnlyAllowed && !canPasskey);
        $('#setup-password-only').hidden = !loginInfo.passwordOnlyAllowed;
        if (!canPasskey) $('#setup-form button[type=submit]').disabled = true;
        $('#setup-token').focus();
    } else {
        const canPasskey = loginInfo.hasPasskeys && WA && WA.browserSupportsWebAuthn() && window.isSecureContext;
        $('#login-passkey').hidden = !canPasskey;
        $('#login-use-password').hidden = !(loginInfo.passwordSet && canPasskey);
        $('#login-form').hidden = canPasskey;           // password form shown directly when passkeys can't be used here
        $('#totp-form').hidden = true;
        $('#login-hint').textContent = canPasskey ? 'Sign in to your dev box.' : loginInfo.passwordSet ? 'Passkeys need https or localhost; sign in with your password here.' : 'Open this site over https to use your passkey.';
        if (!canPasskey && loginInfo.passwordSet) $('#login-password').focus();
    }
}
async function showApp() { $('#login').hidden = true; $('#app').hidden = false; go(state.tab); }

async function postAuth(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Porthole': '1' }, body: JSON.stringify(body || {}), credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || res.statusText);
    return data;
}
// A credential was accepted: either we are in, or two-step asks for a code.
let pendingTicket = null;
async function afterCredential(r) {
    if (r.needCode) { pendingTicket = r.ticket; $('#login-form').hidden = true; $('.login-buttons').hidden = true; $('#totp-form').hidden = false; $('#login-code').value = ''; $('#login-code').focus(); return; }
    await showApp();
}

// first run
$('#setup-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#setup-error'); err.textContent = '';
    const token = $('#setup-token').value.trim(), name = $('#setup-name').value.trim() || 'This device', password = $('#setup-password').value;
    if (password && password.length < 12) { err.textContent = 'Password: at least 12 characters.'; return; }
    try {
        const options = await postAuth('/api/setup/passkey/options', { token, name });
        const response = await WA.startRegistration({ optionsJSON: options });
        const r = await postAuth('/api/setup/passkey/verify', { token, name, response, password: password || undefined });
        toast('Passkey created');
        await afterCredential(r);
        setTimeout(() => { go('more'); push('security'); toast('Turn on two-step codes now'); }, 400);
    } catch (ex) { err.textContent = ex.name === 'NotAllowedError' ? 'Passkey prompt was cancelled.' : ex.message; }
});
$('#setup-password-only').addEventListener('click', async () => {
    const err = $('#setup-error'); err.textContent = '';
    const token = $('#setup-token').value.trim(), password = $('#setup-password').value;
    if (!token) { err.textContent = 'Enter the setup token.'; return; }
    if (password.length < 12) { err.textContent = 'Password: at least 12 characters.'; return; }
    try { await afterCredential(await postAuth('/api/setup/password', { token, password })); setTimeout(() => { go('more'); push('security'); }, 400); }
    catch (ex) { err.textContent = ex.message; }
});

// returning
$('#login-passkey').addEventListener('click', async () => {
    const err = $('#login-error'); err.textContent = '';
    try {
        const options = await postAuth('/api/login/passkey/options', {});
        const response = await WA.startAuthentication({ optionsJSON: options });
        await afterCredential(await postAuth('/api/login/passkey/verify', { response }));
    } catch (ex) { err.textContent = ex.name === 'NotAllowedError' ? 'Passkey prompt was cancelled.' : ex.message; }
});
$('#login-use-password').addEventListener('click', () => { $('#login-form').hidden = false; $('#login-password').focus(); });
$('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#login-error'); err.textContent = '';
    try { await afterCredential(await postAuth('/api/login/password', { password: $('#login-password').value })); $('#login-password').value = ''; }
    catch (ex) { err.textContent = ex.message; }
});
$('#totp-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#login-error'); err.textContent = '';
    try { await postAuth('/api/login/totp', { ticket: pendingTicket, code: $('#login-code').value.trim() }); pendingTicket = null; await showApp(); }
    catch (ex) { err.textContent = ex.message; if (ex.status === 400 || ex.status === 401 && /expired|again/i.test(ex.message)) showLogin(); }
});
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

// ---------- navigation ----------

const state = {
    tab: localStorage.getItem('porthole.tab') || 'home',
    filesPath: localStorage.getItem('porthole.path'),   // null until a folder is chosen → Files opens at home
    servicesFilter: 'all',
    shells: [],
    expanded: null,
};

$$('.tabs button').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
function go(tab) {
    state.tab = tab; localStorage.setItem('porthole.tab', tab);
    $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.go === tab));
    $$('.tab:not(.page)').forEach(t => (t.hidden = t.dataset.tab !== tab));
    $$('.tab.page').forEach(p => (p.hidden = true));
    refresh();
}
function push(page) {
    $$('.tab.page').forEach(p => (p.hidden = p.id !== `page-${page}`));
    if (page === 'vault') loadVault().catch(e => toast(e.message, true));
    if (page === 'creds') loadCredsPage().catch(e => toast(e.message, true));
    if (page === 'security') loadSecurity().catch(e => toast(e.message, true));
    if (page === 'agents') loadAgents().catch(e => toast(e.message, true));
    if (page === 'github') loadGithub().catch(e => toast(e.message, true));
}
$$('[data-back]').forEach(b => b.addEventListener('click', () => { $$('.tab.page').forEach(p => (p.hidden = true)); refresh(); }));
$$('[data-page]').forEach(b => b.addEventListener('click', () => push(b.dataset.page)));

async function refresh() {
    if ($('#app').hidden) return;
    try {
        if (state.tab === 'home') await loadHome();
        else if (state.tab === 'shells') await loadShells();
        else if (state.tab === 'services') await loadServices();
        else if (state.tab === 'files') await loadFiles(state.filesPath ?? null);
        else if (state.tab === 'more') await loadMore();
    } catch (ex) { if (ex.status !== 401) toast(ex.message, true); }
}
setInterval(() => {
    if (document.visibilityState !== 'visible' || $('#app').hidden || !$('#term-sheet').hidden || !$('#editor-sheet').hidden || !$('#dialog').hidden) return;
    if ($$('.tab.page').some(p => !p.hidden)) return;
    if (['home', 'shells', 'services'].includes(state.tab)) refresh();
}, 7000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });

// ---------- home ----------

async function loadHome() {
    const h = await api('/api/home');
    $('#home-sub').textContent = `up ${fmtDuration(h.uptime)}${h.diskFree != null ? ` · ${fmtBytes(h.diskFree)} free` : ''}`;
    $('#home-stats').innerHTML = `
        <button class="stat brass" data-go-tab="shells">${icon('shells')}<div class="num">${h.counts.shells}</div><div class="lbl">shell${h.counts.shells === 1 ? '' : 's'}</div></button>
        <button class="stat kelp" data-go-tab="services">${icon('link')}<div class="num">${h.counts.links}</div><div class="lbl">link${h.counts.links === 1 ? '' : 's'} live</div></button>
        <button class="stat dock" data-go-tab="services">${icon('container')}<div class="num">${h.counts.containers}</div><div class="lbl">container${h.counts.containers === 1 ? '' : 's'}</div></button>`;
    $$('#home-stats [data-go-tab]').forEach(b => b.onclick = () => go(b.dataset.goTab));

    const active = h.projects.find(p => p.shells.length);
    const pick = $('#home-pickup');
    if (active) {
        const shell = [...active.shells].sort((a, b) => b.created - a.created)[0];
        const live = active.shells.some(s => s.kind === 'agent');
        pick.innerHTML = `
            <div class="pickup">
              <div class="head"><span>Pick up where you left off</span><span class="live"><span class="dot ${live ? 'live' : ''}"></span>${live ? agentTitle(active.shells.find(s => s.kind === 'agent')?.agent) + ' running' : 'shell open'}</span></div>
              <div class="name">${esc(active.name)}</div>
              ${shell.preview?.length ? `<pre>${esc(shell.preview.join('\n'))}</pre>` : ''}
              <div class="btns">
                <button class="bigbtn accent" data-open="${esc(shell.name)}">${icon('terminal')}Open shell</button>
                <button class="sq" data-links aria-label="Services">${icon('link')}</button>
                <button class="sq" data-folder="${esc(active.path)}" aria-label="Files">${icon('folder')}</button>
              </div>
            </div>`;
        $('[data-open]', pick).onclick = () => openTerminal(shell.name, 'Home');
        $('[data-links]', pick).onclick = () => go('services');
        $('[data-folder]', pick).onclick = () => { state.filesPath = active.path; go('files'); };
    } else {
        pick.innerHTML = '';
    }

    const list = h.projects.filter(p => p !== active);
    $('#home-projects').innerHTML = list.map(p => {
        const ag = p.shells.find(s => s.kind === 'agent');
        const status = ag ? `<span class="live">● ${esc(agentTitle(ag.agent))} running</span>` : p.shells.length ? `${p.shells.length} shell${p.shells.length > 1 ? 's' : ''} open` : 'nothing running';
        return `<button class="row" data-folder="${esc(p.path)}"><span class="ico brass">${icon('folder')}</span><div class="main"><div class="title">${esc(p.name)}${p.repo && p.repo !== 'local' ? `<span class="tag ${p.repo === 'public' ? 'brass' : 'dim'}">${icon(p.repo === 'public' ? 'globe' : 'lock')}${p.repo}</span>` : ''}</div><div class="sub">${status} · ${fmtAgo(p.modified)}</div></div>${icon('chevron', 'i chev')}</button>`;
    }).join('') + `<button class="row" data-new-project><span class="ico">${icon('folder-plus')}</span><div class="main"><div class="title" style="color:var(--brass)">New project</div></div></button>`;
    $$('#home-projects [data-folder]').forEach(b => b.onclick = () => { state.filesPath = b.dataset.folder; go('files'); });
    $('[data-new-project]').onclick = newProjectDialog;
}
$('#home-all-folders').addEventListener('click', () => { state.filesPath = ''; go('files'); });
const projectsRel = () => join(homeRel, 'Projects');
$('#home-new').addEventListener('click', () => newShellDialog(state.filesPath || projectsRel()));
$$('#tab-home .tile').forEach(t => t.addEventListener('click', async () => {
    const act = t.dataset.act;
    if (act === 'agent') return newShellDialog(state.filesPath || projectsRel(), 'agent');
    if (act === 'shell') return newShellDialog(state.filesPath || homeRel, 'shell');
    if (act === 'upload') { go('files'); return setTimeout(() => $('#files-input').click(), 150); }
    if (act === 'stirling') return launchApp('stirling-pdf', 'Stirling PDF');
    if (act === 'scratch') { const n = `scratch-${Math.random().toString(36).slice(2, 6)}`; try { await api('/api/shells', { method: 'POST', body: { name: n, kind: 'agent', agent: localStorage.getItem('porthole.agent') || 'claude', scratch: true } }); openTerminal(n, 'Home'); } catch (ex) { toast(ex.message, true); } return; }
}));

function newProjectDialog() {
    const { panel, close } = openDialog(`
        <h2>New project</h2>
        <p class="muted">Creates a folder in <span class="mono">~/Projects</span> and starts Claude in it.</p>
        <div class="field"><label for="np-name">Name</label><input id="np-name" type="text" placeholder="my-app" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
        <div class="buttons"><button class="primary" data-ok>Create and start Claude</button><button data-close>Cancel</button></div>`);
    const go_ = async () => {
        const name = $('#np-name', panel).value.trim();
        try {
            const r = await api('/api/files/mkdir', { method: 'POST', body: { path: projectsRel() || 'Projects', name } });
            const shellName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 30);
            await api('/api/shells', { method: 'POST', body: { name: shellName, kind: 'agent', agent: localStorage.getItem('porthole.agent') || 'claude', cwd: r.path } });
            close(); openTerminal(shellName, 'Home');
        } catch (ex) { toast(ex.message, true); }
    };
    $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
}

// Search across projects, shells, containers, vault names, catalog apps.
$('#home-search').addEventListener('click', async () => {
    const { panel } = openDialog(`<h2>Search</h2><div class="field"><input id="q" type="text" placeholder="Project, shell, container, token…" autocapitalize="off" autocorrect="off"></div><div class="results" data-results style="margin-top:10px;max-height:50vh;overflow:auto"></div>`);
    const [h, s, v] = await Promise.all([api('/api/home'), api('/api/services').catch(() => ({ containers: [], apps: [] })), api('/api/vault').catch(() => [])]);
    const items = [
        ...h.projects.map(p => ({ t: p.name, s: 'project · ' + shortPath(p.path), ico: 'folder', cls: 'brass', run: () => { state.filesPath = p.path; go('files'); } })),
        ...h.projects.flatMap(p => p.shells.map(sh => ({ t: sh.name, s: `${sh.kind === 'agent' ? agentTitle(sh.agent) : 'shell'} · ${p.name}`, ico: 'shells', cls: 'brass', run: () => openTerminal(sh.name, 'Home') }))),
        ...s.containers.map(c => ({ t: c.title, s: 'container · ' + c.image, ico: 'container', cls: 'dock', run: () => { go('services'); } })),
        ...s.apps.map(a => ({ t: a.title, s: 'app · ' + a.blurb, ico: 'zap', cls: 'dock', run: () => launchApp(a.key, a.title) })),
        ...v.map(t => ({ t: t.name, s: `token · ${t.provider} · ${t.envName}`, ico: 'key', cls: 'brass', run: () => { go('more'); push('vault'); } })),
    ];
    const box = $('[data-results]', panel);
    const render = q => {
        const ql = q.trim().toLowerCase();
        const hits = ql ? items.filter(i => (i.t + ' ' + i.s).toLowerCase().includes(ql)).slice(0, 12) : items.slice(0, 8);
        box.innerHTML = hits.map((i, n) => `<button data-n="${n}"><span class="ico ${i.cls}">${icon(i.ico)}</span><div class="main"><div class="title">${esc(i.t)}</div><div class="sub">${esc(i.s)}</div></div></button>`).join('') || '<p class="muted">Nothing matches.</p>';
        $$('button[data-n]', box).forEach(b => b.onclick = () => { $('.dialog-backdrop').click(); hits[Number(b.dataset.n)].run(); });
    };
    render('');
    $('#q', panel).addEventListener('input', e => render(e.target.value));
});

// ---------- shells ----------

async function loadShells() {
    const shells = await api('/api/shells');
    state.shells = shells;
    $('#shell-empty').hidden = shells.length > 0;
    const groups = new Map();
    for (const s of shells) { const k = s.cwd; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    $('#shell-groups').innerHTML = [...groups.entries()].map(([cwd, list]) => `
        <div class="group-title">${icon('folder')}${esc(shortPath(cwd))}</div>
        <div class="list">${list.map(shellRow).join('')}</div>`).join('');
    $$('#shell-groups .shell-row').forEach(row => row.addEventListener('click', () => openTerminal(row.dataset.name, 'Shells')));
}
function shellRow(s) {
    return `<button class="shell-row" data-name="${esc(s.name)}">
        <div class="shell-head"><span class="dot ${s.attached ? 'live' : ''}"></span><span class="name">${esc(s.name)}</span>${s.kind === 'agent' ? `<span class="tag brass">${esc(agentTitle(s.agent))}${s.profile && s.profile !== 'default' ? ' · ' + esc(s.profile) : ''}</span>${s.yolo ? '<span class="tag dim">auto</span>' : ''}${s.scratch ? '<span class="tag dim">scratch</span>' : ''}` : `<span class="tag dim">${s.kind === 'remote-control' ? 'Remote Control' : 'shell'}</span>${s.scratch ? '<span class="tag dim">scratch</span>' : ''}`}</div>
        ${s.preview?.length ? `<pre class="shell-preview">${esc(s.preview.join('\n'))}</pre>` : ''}
      </button>`;
}
$('#shell-new').addEventListener('click', () => newShellDialog(state.filesPath || projectsRel()));

const AGENT_TITLES = { claude: 'Claude Code', codex: 'Codex CLI', antigravity: 'Antigravity CLI' };
const agentTitle = k => AGENT_TITLES[k] || k || 'agent';
let agentsCache = null;
async function getAgents() { if (!agentsCache) agentsCache = await api('/api/agents'); return agentsCache; }

function newShellDialog(folder = '', preferredKind = 'agent', presetName = null) {
    if (preferredKind === 'claude') preferredKind = 'agent';
    const suggested = presetName ?? (folder.split('/').filter(Boolean).pop() || 'home').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 30);
    const { panel, close } = openDialog(`
        <h2>New shell</h2>
        <div class="field"><label>Where</label>
          <button type="button" class="row plain picker" data-pick><span class="ico brass">${icon('folder')}</span><div class="main"><div class="title mono">${esc(showPath(folder))}</div><div class="sub">Tap to choose a folder</div></div>${icon('chevron', 'i chev')}</button></div>
        <div class="field"><label>Kind</label><div class="choices" data-kind>
          <button type="button" data-k="agent" class="${preferredKind === 'agent' ? 'selected' : ''}">${icon('claude')}AI agent</button>
          <button type="button" data-k="shell" class="${preferredKind === 'shell' ? 'selected' : ''}">${icon('terminal')}Plain shell</button></div></div>
        <div data-agent-opts ${preferredKind === 'agent' ? '' : 'hidden'}>
          <div class="field"><label>Agent</label><div class="choices" data-agent style="grid-template-columns:1fr 1fr 1fr"><p class="muted">Loading…</p></div></div>
          <div class="field" data-profile-field hidden><label for="ns-profile">Claude profile</label><select id="ns-profile"></select></div>
          <div class="field"><label>Options</label><div class="choices" data-opts>
            <button type="button" data-o="resume">${icon('history')}Resume last session here</button>
            <button type="button" data-o="yolo">${icon('zap')}Auto-approve everything</button>
            <button type="button" data-o="scratch">${icon('trash')}Scratch: temp folder, deleted when the shell ends</button></div>
            <p class="sub" data-yolo-warn hidden style="margin:6px 2px 0;color:var(--flare)">Auto-approve lets the agent run any command without asking. Use it only in folders you can afford to lose.</p></div>
        </div>
        <div class="field"><label for="ns-name">Name</label><input id="ns-name" type="text" value="${esc(suggested)}" class="mono" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
        <div class="buttons"><button class="primary" data-ok>Start</button><button data-close>Cancel</button></div>`);
    let kind = preferredKind, agent = localStorage.getItem('porthole.agent') || 'claude', yolo = false, resume = false, profile = 'default', scratch = false;
    $$('[data-kind] button', panel).forEach(b => b.onclick = () => { kind = b.dataset.k; $$('[data-kind] button', panel).forEach(x => x.classList.toggle('selected', x === b)); $('[data-agent-opts]', panel).hidden = kind !== 'agent'; });
    $$('[data-opts] button', panel).forEach(b => b.onclick = () => {
        if (b.dataset.o === 'resume') resume = !resume; else if (b.dataset.o === 'yolo') yolo = !yolo; else scratch = !scratch;
        b.classList.toggle('selected', b.dataset.o === 'resume' ? resume : b.dataset.o === 'yolo' ? yolo : scratch);
        $('[data-yolo-warn]', panel).hidden = !yolo;
        $('[data-pick]', panel).style.opacity = scratch ? '.4' : '1';
    });
    getAgents().then(list => {
        const box = $('[data-agent]', panel);
        if (!list.some(a => a.key === agent && a.installed)) agent = (list.find(a => a.installed) || list[0]).key;
        box.innerHTML = list.map(a => `<button type="button" data-a="${a.key}" class="${a.key === agent ? 'selected' : ''}" ${a.installed ? '' : 'disabled'} style="flex-direction:column;gap:2px;padding:9px 4px"><span>${esc(a.title)}</span><span class="sub" style="font-size:11px">${a.installed ? (a.signedIn ? 'signed in' : 'not signed in') : 'not installed'}</span></button>`).join('');
        const refreshProfiles = () => {
            const a = list.find(x => x.key === agent);
            const field = $('[data-profile-field]', panel);
            field.hidden = !(a && a.profiles);
            if (a && a.profiles) {
                const sel = $('#ns-profile', panel);
                sel.innerHTML = a.profiles.map(p => `<option value="${esc(p.name)}" ${p.name === profile ? 'selected' : ''}>${esc(p.name)}${p.signedIn ? '' : ' (not signed in)'}</option>`).join('') + `<option value="__new">New profile…</option>`;
                sel.onchange = () => { if (sel.value === '__new') { sel.value = profile; const keep = $('#ns-name', panel).value.trim(); close(); newProfileDialog(() => newShellDialog(folder, 'agent', keep)); } else profile = sel.value; };
            }
        };
        $$('button[data-a]', box).forEach(b => b.onclick = () => { agent = b.dataset.a; localStorage.setItem('porthole.agent', agent); $$('button[data-a]', box).forEach(x => x.classList.toggle('selected', x === b)); refreshProfiles(); });
        refreshProfiles();
    }).catch(ex => { $('[data-agent]', panel).innerHTML = `<p class="muted">${esc(ex.message)}</p>`; });
    $('[data-pick]', panel).onclick = () => {
        const name = $('#ns-name', panel).value.trim();
        const keepName = name && name !== suggested ? name : null;
        folderPicker(folder, picked => newShellDialog(picked, kind, keepName), () => newShellDialog(folder, kind, keepName));
    };
    const go_ = async () => {
        const name = $('#ns-name', panel).value.trim();
        const finalName = scratch && name === suggested ? `scratch-${Math.random().toString(36).slice(2, 6)}` : name;
        try { await api('/api/shells', { method: 'POST', body: { name: finalName, kind, cwd: folder || '.', agent, yolo, resume, profile, scratch } }); close(); openTerminal(finalName, 'Shells'); }
        catch (ex) { toast(ex.message, true); }
    };
    $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
}

function newProfileDialog(done) {
    const { panel, close } = openDialog(`<h2>${icon('user')}New Claude profile</h2><p class="muted">A separate config folder: another Anthropic account or organisation, its own usage limits and settings.</p>
        <div class="field"><input id="np-prof" type="text" class="mono" placeholder="work" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
        <div class="buttons"><button class="primary" data-ok>Create</button><button data-close>Cancel</button></div>`);
    const go_ = async () => { try { await api('/api/agents/claude/profiles', { method: 'POST', body: { name: $('#np-prof', panel).value.trim() } }); close(); toast('Profile created — sign in to it from a Claude shell'); agentsCache = null; done?.(); } catch (ex) { toast(ex.message, true); } };
    $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
}

// Folder browser used by dialogs. onPick(relativePath) when chosen, onCancel() when dismissed.
async function folderPicker(start = '', onPick, onCancel) {
    let cur = start;
    const { panel, close } = openDialog(`<h2>${icon('folder')}Choose a folder</h2><nav class="crumbs" data-crumbs></nav><div class="list" data-dirs style="max-height:45vh;overflow:auto"></div>
        <div class="buttons"><button class="primary" data-ok>Use this folder</button><button data-newdir>New folder here</button><button data-close>Cancel</button></div>`);
    $('.dialog-backdrop').addEventListener('click', () => onCancel?.(), { once: true });
    $('[data-close]', panel).addEventListener('click', () => onCancel?.(), { once: true });
    const load = async path => {
        let data;
        try { data = await api(`/api/files?path=${encodeURIComponent(path || '.')}`); } catch (ex) { toast(ex.message, true); return; }
        cur = data.path;
        const parts = cur ? cur.split('/') : [];
        let acc = '';
        const nav = $('[data-crumbs]', panel);
        nav.innerHTML = [`<button data-p="" class="${parts.length ? '' : 'current'}">${rootLabel()}</button>`, ...parts.map((p, i) => { acc = join(acc, p); return `<span class="sep">›</span><button data-p="${esc(acc)}" class="${i === parts.length - 1 ? 'current' : ''}">${esc(p)}</button>`; })].join('');
        $$('button[data-p]', nav).forEach(b => b.onclick = () => load(b.dataset.p));
        nav.scrollLeft = nav.scrollWidth;
        const dirs = data.items.filter(i => i.type === 'dir' && !i.hidden);
        const box = $('[data-dirs]', panel);
        const upRow = cur ? `<button class="row" data-d="${esc(parentOf(cur))}"><span class="ico dim">${icon('back')}</span><div class="main"><div class="title mono">..</div></div></button>` : '';
        box.innerHTML = upRow + (dirs.length ? dirs.map(d => `<button class="row" data-d="${esc(join(cur, d.name))}"><span class="ico brass">${icon('folder')}</span><div class="main"><div class="title">${esc(d.name)}</div></div>${icon('chevron', 'i chev')}</button>`).join('') : `<p class="empty">No subfolders here.</p>`);
        $$('button[data-d]', box).forEach(b => b.onclick = () => load(b.dataset.d));
        $('[data-ok]', panel).textContent = `Use ${showPath(cur)}`;
    };
    $('[data-ok]', panel).onclick = () => { close(); onPick(cur); };
    $('[data-newdir]', panel).onclick = () => {
        const name = window.prompt ? null : null; // no browser prompts: inline mini form instead
        const box = $('[data-dirs]', panel);
        if ($('[data-mk]', box)) return;
        box.insertAdjacentHTML('afterbegin', `<div class="row plain" data-mk><input type="text" class="mono" placeholder="folder-name" autocapitalize="off" autocorrect="off" spellcheck="false" style="padding:9px 12px"><button class="pill accent" data-mkok>Create</button></div>`);
        const input = $('[data-mk] input', box); input.focus();
        const mk = async () => { try { const r = await api('/api/files/mkdir', { method: 'POST', body: { path: cur || '.', name: input.value } }); await load(r.path); } catch (ex) { toast(ex.message, true); } };
        $('[data-mkok]', box).onclick = mk;
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); mk(); } });
    };
    await load(start);
}

async function killShell(name) {
    const sh = state.shells.find(x => x.name === name);
    if (!(await confirmDialog({ title: `End "${name}"?`, text: sh?.scratch ? 'This is a scratch shell: its temporary folder is deleted too.' : 'Anything running inside stops. Files are kept.', action: sh?.scratch ? 'End and delete folder' : 'End shell' }))) return;
    try { await api(`/api/shells/${encodeURIComponent(name)}`, { method: 'DELETE' }); toast('Shell ended'); closeTerminal(); }
    catch (ex) { toast(ex.message, true); }
}

// ---------- terminal ----------

const termSheet = $('#term-sheet'), termHost = $('#term');
let term, fit, ws, termName, termKind = 'shell', termBackTab = 'shells', ctrlArmed = false, altArmed = false, reconnectTimer;
let fontSize = Number(localStorage.getItem('porthole.font')) || 13;
let seenCreds = [];           // credentials shared via `credshare` in the current shell
let credTail = '';
const CRED_RE = /\x1b\]777;porthole-cred;([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)/g;
// Returns the text with credential sequences removed; queues any complete ones for the card row.
function extractCreds(text) {
    let buf = credTail + text; credTail = '';
    const start = buf.lastIndexOf('\x1b]777;porthole-cred;');
    if (start >= 0 && !buf.slice(start).includes('\x07')) { credTail = buf.slice(start); buf = buf.slice(0, start); }
    let changed = false;
    buf = buf.replace(CRED_RE, (_, b64) => {
        try {
            const c = JSON.parse(atob(b64));
            if (c.id && !Array.isArray(c.fields)) showSharedCred(c.id);
            else if (Array.isArray(c.fields)) { seenCreds.unshift({ ...c, id: c.id || Math.random().toString(36).slice(2, 10), at: Date.now() }); changed = true; }
        } catch { /* ignore */ }
        return '';
    });
    if (changed) { seenCreds = seenCreds.slice(0, 8); renderCreds(); announceCred(seenCreds[0]); }
    return buf;
}
// A credential registered by `credshare` (pushed by the server or announced in the terminal): fetch values once.
const shownCreds = new Set();
function showSharedCred(id) {
    if (shownCreds.has(id)) return; shownCreds.add(id);
    api(`/api/creds/${id}/values`, { method: 'POST' }).then(full => { seenCreds = [full, ...seenCreds.filter(x => x.id !== full.id)].slice(0, 8); renderCreds(); announceCred(full); }).catch(() => shownCreds.delete(id));
}
function renderCreds() {
    const row = $('#term-creds');
    row.hidden = seenCreds.length === 0;
    row.innerHTML = seenCreds.length ? `<button data-creds>${icon('key')}<span>${seenCreds.length === 1 ? esc(seenCreds[0].title || 'Credentials') : `${seenCreds.length} credentials`}</span>${icon('chevron')}</button>` : '';
    const b = $('[data-creds]', row); if (b) b.onclick = () => credPanel(seenCreds);
}
function announceCred(c) {
    const el = $('#toast');
    el.innerHTML = `${icon('key')} ${esc(c.title || 'Credentials')} shared · <button class="linkish" id="toast-cred">View</button>`;
    el.classList.remove('bad'); el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
    $('#toast-cred').onclick = () => { el.hidden = true; credPanel(seenCreds, { focus: c.id }); };
}
function credFor(c) {
    const bits = [];
    if (c.project) bits.push(`for <b>${esc(c.project.split('/').filter(Boolean).pop() || c.project)}</b>`);
    if (c.shell) bits.push(`shell ${esc(c.shell)}`);
    if (c.at) bits.push(timeAgo(c.at));
    return bits.join(' · ');
}
// Dropdown of shared credentials: every field is a tap-to-copy row; the open button goes to the tunnel, not localhost.
function credPanel(list, { persisted = false, focus = null } = {}) {
    if (!list?.length) return;
    const revealed = new Set();
    const { panel, close } = openDialog(`<h2>${icon('key')}Shared credentials</h2><div data-creds-body></div><div class="buttons"><button data-close>Close</button></div>`);
    const render = () => {
        $('[data-creds-body]', panel).innerHTML = list.map((c, ci) => `
        <details class="cred" ${list.length === 1 || c.id === focus ? 'open' : ''} data-ci="${ci}">
          <summary><span class="cred-title">${esc(c.title || 'Credentials')}</span><span class="sub">${credFor(c)}</span></summary>
          ${c.note ? `<p class="muted cred-note">${esc(c.note)}</p>` : ''}
          ${c.service ? `<p class="sub cred-svc">${c.service.live ? '<span class="live">● live</span>' : '<span style="color:var(--flare)">● not running</span>'}${c.service.container ? ` · ${esc(c.service.container)}` : ''} · port ${c.port}${c.service.tunnel ? ` · tunnel` : c.localOnly ? ' · no public link yet' : ''}</p>` : ''}
          <div class="cred-rows">
            ${c.openUrl ? `<a class="cred-row" href="${esc(c.openUrl)}" target="_blank" rel="noopener"><span class="lbl">Open</span><span class="val" style="color:var(--kelp)">${esc(c.openUrl)}</span>${icon('external')}</a>` : ''}
            ${c.url && c.url !== c.openUrl ? `<button class="cred-row" data-copy="${ci}:url"><span class="lbl">URL</span><span class="val">${esc(c.url)}</span>${icon('copy')}</button>` : ''}
            ${c.fields.map((f, fi) => `<button class="cred-row" data-copy="${ci}:${fi}"><span class="lbl">${esc(f.label)}</span><span class="val">${f.secret && !revealed.has(`${ci}:${fi}`) ? '••••••••' : esc(f.value)}</span>${f.secret ? `<span class="pill" data-reveal="${ci}:${fi}" role="button">${icon(revealed.has(`${ci}:${fi}`) ? 'x' : 'eye')}</span>` : ''}${icon('copy')}</button>`).join('')}
          </div>
          <div class="chips cred-actions">
            ${c.localOnly && c.service?.live ? `<button class="pill" data-tunnel="${ci}">${icon('link')}Open a public link</button>` : ''}
            <button class="pill" data-env="${ci}">${icon('copy')}Copy all</button>
            <button class="pill" data-vault="${ci}">${icon('lock')}Save to Vault</button>
            <button class="pill danger" data-forget="${ci}">${icon('trash')}Forget</button>
          </div>
        </details>`).join('');
        $$('[data-copy]', panel).forEach(el => el.onclick = ev => {
            if (ev.target.closest('[data-reveal]')) return;
            const [ci, fi] = el.dataset.copy.split(':'); const c = list[Number(ci)];
            const v = fi === 'url' ? c.url : c.fields[Number(fi)].value; const label = fi === 'url' ? 'URL' : c.fields[Number(fi)].label;
            copyText(v, `${label} copied`);
        });
        $$('[data-reveal]', panel).forEach(el => el.onclick = ev => { ev.preventDefault(); ev.stopPropagation(); const k = el.dataset.reveal; revealed.has(k) ? revealed.delete(k) : revealed.add(k); render(); });
        $$('[data-env]', panel).forEach(el => el.onclick = () => { const c = list[Number(el.dataset.env)]; copyText(c.fields.map(f => `${f.label.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}=${f.value}`).concat(c.openUrl || c.url ? [`URL=${c.openUrl || c.url}`] : []).join('\n'), 'Copied all'); });
        $$('[data-vault]', panel).forEach(el => el.onclick = () => { close(); saveSharedToVault(list[Number(el.dataset.vault)]); });
        $$('[data-tunnel]', panel).forEach(el => el.onclick = async () => {
            const c = list[Number(el.dataset.tunnel)]; el.disabled = true; el.textContent = 'Opening…';
            try { await api('/api/tunnels', { method: 'POST', body: { port: c.port, name: c.title } }); const fresh = await api(`/api/creds/${c.id}/values`, { method: 'POST' }); Object.assign(c, fresh); render(); toast('Public link opened'); }
            catch (ex) { toast(ex.message, true); render(); }
        });
        $$('[data-forget]', panel).forEach(el => el.onclick = async () => {
            const c = list[Number(el.dataset.forget)];
            seenCreds = seenCreds.filter(x => x.id !== c.id); renderCreds();
            await api(`/api/creds/${c.id}`, { method: 'DELETE' }).catch(() => {});
            list.splice(Number(el.dataset.forget), 1);
            if (persisted) { loadCredsPage().catch(() => {}); if (state.tab === 'services') loadServices(); }
            list.length ? render() : close();
        });
    };
    render();
}
function saveSharedToVault(c) {
    getCatalog().then(cat => {
        if (!cat) return;
        const svc = cat.services.find(s => s.key === 'custom');
        credentialForm(svc, cat, c.fields.some(f => /pass/i.test(f.label)) && c.fields.some(f => /user/i.test(f.label)) ? 'basic' : 'token');
        setTimeout(() => {
            const name = $('#cf-name'); if (name) name.value = c.title || 'Shared credential';
            const u = c.fields.find(f => /user/i.test(f.label)), p = c.fields.find(f => /pass/i.test(f.label)), t = c.fields.find(f => f.secret) || c.fields[0];
            if ($('#cf-username') && u) $('#cf-username').value = u.value; if ($('#cf-password') && p) $('#cf-password').value = p.value; if ($('#cf-token') && t) $('#cf-token').value = t.value;
        }, 150);
    }).catch(() => {});
}
let seenLinks = [];           // most recent URLs printed by the current shell
let linkTail = '';            // carry-over so URLs split across chunks are still found
const URL_RE = /https?:\/\/[^\s'"<>()\[\]{}|\^`]+/g;
function noteLinks(text) {
    const plain = (linkTail + text).replace(/\[[0-9;?]*[A-Za-z]/g, '');
    linkTail = plain.slice(-200);
    let changed = false;
    for (const m of plain.matchAll(URL_RE)) {
        const url = m[0].replace(/[.,;:!?]+$/, '');
        if (url.length < 12) continue;
        const i = seenLinks.indexOf(url);
        if (i === 0) continue;
        if (i > 0) seenLinks.splice(i, 1);
        seenLinks.unshift(url); changed = true;
    }
    if (seenLinks.length > 6) seenLinks.length = 6;
    if (changed) renderLinks();
}
function renderLinks() {
    const row = $('#term-links');
    row.hidden = seenLinks.length === 0;
    row.innerHTML = seenLinks.map(u => `<button data-url="${esc(u)}" title="${esc(u)}">${icon('external')}<span>${esc(u.replace(/^https?:\/\//, ''))}</span></button>`).join('');
    $$('button', row).forEach(b => {
        b.onclick = () => window.open(b.dataset.url, '_blank', 'noopener');
        b.oncontextmenu = e => { e.preventDefault(); copyText(b.dataset.url, 'Link copied'); };
    });
}
async function setMouse(on) {
    try {
        const r = await api(`/api/shells/${encodeURIComponent(termName)}/mouse`, { method: 'POST', body: { on } });
        $('#key-mouse').classList.toggle('armed', r.mouse);
        toast(r.mouse ? 'Mouse goes to tmux: wheel scrolls history' : 'Selection mode: drag to select text');
    } catch (ex) { toast(ex.message, true); }
}
$('#key-mouse').addEventListener('click', () => setMouse(!$('#key-mouse').classList.contains('armed')));

// Scroll mode: swap the live terminal for a natively scrollable, selectable view of the full tmux history.
// Typing, sending or pressing a key returns to the live terminal (select mode).
let scrollMode = false, scrollTimer = null;
async function setScrollMode(on) {
    scrollMode = on;
    const pane = $('#term-history');
    $('#key-scroll').classList.toggle('armed', on);
    pane.hidden = !on;
    clearInterval(scrollTimer); scrollTimer = null;
    if (!on) { term?.focus(); return; }
    const pre = $('pre', pane);
    const load = async first => {
        try {
            const res = await api(`/api/shells/${encodeURIComponent(termName)}/scrollback?lines=5000`, { raw: true });
            const text = await res.text();
            const atBottom = first || (pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40);
            if (pre.textContent !== text) { pre.textContent = text; if (atBottom) pre.scrollTop = pre.scrollHeight; }
        } catch (ex) { pre.textContent = ex.message; }
    };
    await load(true);
    scrollTimer = setInterval(() => load(false), 2000);
}
$('#key-scroll').addEventListener('click', () => setScrollMode(!scrollMode));
$('#history-close').addEventListener('click', () => setScrollMode(false));
$('#composer-input').addEventListener('focus', () => { if (scrollMode) setScrollMode(false); });

const QUICK = {
    claude: ['yes', 'no', 'continue', 'show the diff', 'run the tests', 'run it and share a link', 'commit this', '/compact', '/clear'],
    codex: ['yes', 'no', 'continue', 'show the diff', 'run the tests', 'commit this', '/compact', '/new'],
    antigravity: ['yes', 'no', 'continue', 'show the diff', 'run the tests', 'commit this', '/compress', '/clear'],
    shell: ['ls -la', 'git status', 'git pull', 'docker ps', 'npm run dev', 'python3 -m http.server 8000', 'tunnel 8000', 'vault ls', 'claude', 'codex'],
};

async function openTerminal(name, backLabel = 'Shells') {
    const shells = state.shells.length ? state.shells : await api('/api/shells').catch(() => []);
    state.shells = shells;
    const s = shells.find(x => x.name === name) || { name, kind: 'shell', cwd: '' };
    termName = name; termKind = s.kind === 'agent' ? (s.agent || 'claude') : 'shell'; termBackTab = backLabel.toLowerCase();
    $('#term-back-label').textContent = backLabel;
    $('#term-title').textContent = name;
    $('#term-subtitle').textContent = `${s.kind === 'agent' ? agentTitle(s.agent) + (s.profile && s.profile !== 'default' ? ' · ' + s.profile : '') + (s.yolo ? ' · auto-approve' : '') : s.kind === 'remote-control' ? 'Remote Control' : 'shell'} · ${shortPath(s.cwd)}`;
    $('#term-chips').innerHTML = shells.map(x => `<button class="chip ${x.name === name ? 'on' : ''}" data-chip="${esc(x.name)}"><span class="dot ${x.name === name || x.attached ? 'live' : ''}"></span>${esc(x.name)}</button>`).join('') + `<button class="chip plus" data-chip-new>${icon('plus')}</button>`;
    $$('#term-chips [data-chip]').forEach(c => c.onclick = () => { if (c.dataset.chip !== termName) openTerminal(c.dataset.chip, backLabel); });
    $('#term-chips [data-chip-new]').onclick = () => newShellDialog(s.cwd ? shortPath(s.cwd).replace(/^~\/?/, '') : '');
    $('#quick-replies').innerHTML = (QUICK[termKind] || QUICK.shell).map(q => `<button data-q="${esc(q)}">${esc(q)}</button>`).join('');
    $$('#quick-replies button').forEach(b => b.onclick = () => { sendInput(b.dataset.q + '\r'); term?.focus(); });
    $('#composer-input').placeholder = termKind !== 'shell' ? `Message ${agentTitle(termKind).split(' ')[0]}` : 'Run a command';
    seenLinks = []; linkTail = ''; renderLinks();
    seenCreds = []; credTail = ''; renderCreds();
    api(`/api/shells/${encodeURIComponent(name)}/creds`).then(list => { if (list.length) { seenCreds = list; renderCreds(); } }).catch(() => {});
    api(`/api/shells/${encodeURIComponent(name)}/mouse`).then(r => $('#key-mouse').classList.toggle('armed', !!r.mouse)).catch(() => {});
    termSheet.hidden = false;

    if (term) { term.dispose(); term = null; }
    term = new Terminal({
        cursorBlink: true, fontFamily: '"Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace', fontSize, lineHeight: 1.2, scrollback: 5000,
        allowProposedApi: true, macOptionIsMeta: true, scrollOnUserInput: true, rightClickSelectsWord: true, macOptionClickForcesSelection: true,
        theme: { background: '#070D18', foreground: '#E6ECF3', cursor: '#F0B840', cursorAccent: '#070D18', selectionBackground: 'rgba(240,184,64,0.35)',
            black: '#0A1120', red: '#F46A5C', green: '#3FD39A', yellow: '#F0B840', blue: '#6FB1F0', magenta: '#C293D9', cyan: '#5FC5CF', white: '#E6ECF3',
            brightBlack: '#5B6E86', brightRed: '#FF8A78', brightGreen: '#6EDBB5', brightYellow: '#F5CB6B', brightBlue: '#93BDF0', brightMagenta: '#D8B3EA', brightCyan: '#86DCE4', brightWhite: '#FFFFFF' },
    });
    fit = new FitAddon.FitAddon(); term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank', 'noopener')));
    try { term.loadAddon(new Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = '11'; } catch { /* optional */ }
    try { term.loadAddon(new ClipboardAddon.ClipboardAddon()); } catch { /* optional */ }
    term.open(termHost);
    try { const webgl = new WebglAddon.WebglAddon(); webgl.onContextLoss(() => webgl.dispose()); term.loadAddon(webgl); } catch { /* optional */ }
    fit.fit();
    // Desktop paste: xterm sends Ctrl+V to the shell as ^V, so handle Ctrl+V / Ctrl+Shift+V / Shift+Insert ourselves.
    term.attachCustomKeyEventHandler(ev => {
        if (ev.type !== 'keydown') return true;
        const isPasteCombo = (ev.ctrlKey && !ev.altKey && ev.key.toLowerCase() === 'v') || (ev.shiftKey && ev.key === 'Insert');
        if (!isPasteCombo || /Mac/i.test(navigator.platform)) return true;
        ev.preventDefault();
        pasteFromClipboard();
        return false;
    });
    // Native paste events (context menu → Paste, Cmd+V on Mac) still arrive on xterm's textarea; wrap multi-line text.
    termHost.addEventListener('paste', ev => {
        const text = ev.clipboardData?.getData('text');
        if (!text) return;
        ev.preventDefault(); ev.stopPropagation();
        sendInput(text.includes('\n') ? bracketed(text) : text);
    }, true);
    term.onTitleChange(t => { if (t) $('#term-subtitle').textContent = t; });
    term.onSelectionChange(() => { $('#copy-chip').hidden = !term.hasSelection(); });
    term.onData(data => {
        if (ctrlArmed && data.length === 1) { const c = data.toUpperCase().charCodeAt(0); if (c >= 64 && c <= 95) data = String.fromCharCode(c - 64); setCtrl(false); }
        else if (altArmed && data.length === 1) { data = '\x1b' + data; setAlt(false); }
        sendInput(data);
    });
    connect();
}

function connect() {
    clearTimeout(reconnectTimer);
    if (ws) { ws.onclose = null; ws.close(); }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/shell/${encodeURIComponent(termName)}?cols=${term.cols}&rows=${term.rows}`);
    ws.binaryType = 'arraybuffer';
    const dec = new TextDecoder();
    ws.onmessage = ev => {
        if (ev.data instanceof ArrayBuffer) { const text = extractCreds(dec.decode(ev.data, { stream: true })); term.write(text); noteLinks(text); }
        else { let msg; try { msg = JSON.parse(ev.data); } catch { return; } if (msg.type === 'error') toast(msg.message, true); if (msg.type === 'exit') term.write('\r\n\x1b[90m[shell ended]\x1b[0m\r\n'); if (msg.type === 'cred' && msg.id) showSharedCred(msg.id); }
    };
    ws.onopen = () => { sendResize(); };
    ws.onclose = ev => { if (termSheet.hidden || ev.code === 1008 || ev.code === 1000) return; term.write('\r\n\x1b[90m[reconnecting…]\x1b[0m\r\n'); reconnectTimer = setTimeout(connect, 1500); };
}
function sendInput(data) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data })); }
function sendResize() { if (!term || !fit) return; fit.fit(); if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); }
function closeTerminal() {
    if (scrollMode) setScrollMode(false);
    termSheet.hidden = true; clearTimeout(reconnectTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    if (term) { term.dispose(); term = null; }
    setCtrl(false); setAlt(false); $('#copy-chip').hidden = true;
    state.shells = [];
    if (['home', 'shells', 'files'].includes(termBackTab)) go(termBackTab); else refresh();
}
$('#term-back').addEventListener('click', closeTerminal);
$('#term-kill').addEventListener('click', () => killShell(termName));

function setCtrl(on) { ctrlArmed = on; if (on) setAlt(false); $('#key-ctrl').classList.toggle('armed', on); }
function setAlt(on) { altArmed = on; if (on) setCtrl(false); $('#key-alt').classList.toggle('armed', on); }
$('#key-ctrl').addEventListener('click', () => { setCtrl(!ctrlArmed); term?.focus(); });
$('#key-alt').addEventListener('click', () => { setAlt(!altArmed); term?.focus(); });
$$('.keys button[data-key]').forEach(b => b.addEventListener('click', () => { if (scrollMode) setScrollMode(false); sendInput(JSON.parse(`"${b.dataset.key}"`)); term?.focus(); }));
$('#key-kbd').addEventListener('click', () => term?.focus());
function setFont(d) { fontSize = Math.min(22, Math.max(9, fontSize + d)); localStorage.setItem('porthole.font', String(fontSize)); if (term) { term.options.fontSize = fontSize; sendResize(); } }
$('#key-font-down').addEventListener('click', () => setFont(-1));
$('#key-font-up').addEventListener('click', () => setFont(1));
async function pasteFromClipboard() {
    try {
        const text = await navigator.clipboard.readText();
        if (text) { sendInput(text.includes('\n') ? bracketed(text) : text); term?.focus(); return; }
    } catch { /* no permission or plain http: fall through to the manual sheet */ }
    pasteSheet();
}
$('#key-paste').addEventListener('click', pasteFromClipboard);
// Manual paste: iOS offers its own Paste menu on a long-press in a real textarea, which the terminal canvas cannot.
function pasteSheet() {
    const { panel, close } = openDialog(`<h2>${icon('paste')}Paste into the shell</h2><p class="muted">Long-press in the box and choose Paste, then send it. Multi-line text goes in as one paste.</p>
        <div class="field"><textarea id="paste-box" rows="5" placeholder="Paste here" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea></div>
        <div class="buttons"><button class="primary" data-send-run>Paste and press Enter</button><button data-send>Paste only</button><button data-close>Cancel</button></div>`);
    const send = run => {
        const text = $('#paste-box', panel).value;
        if (!text) return;
        sendInput(text.includes('\n') ? bracketed(text) : text);
        if (run) setTimeout(() => sendInput('\r'), 60);
        close(); term?.focus();
    };
    $('[data-send-run]', panel).onclick = () => send(true);
    $('[data-send]', panel).onclick = () => send(false);
}
$('#copy-chip').addEventListener('click', async () => {
    if (!term?.hasSelection()) return;
    if (await copyText(term.getSelection(), 'Copied')) term.clearSelection();
});
$('#key-copy').addEventListener('click', async () => {
    if (term?.hasSelection()) { await copyText(term.getSelection(), 'Copied selection'); return; }
    scrollbackSheet();
});
async function scrollbackSheet() {
    const { panel } = openDialog(`<h2>${icon('copy')}Scrollback</h2><p class="muted">Everything this shell has printed. Long-press to select, or copy it all.</p><pre style="max-height:55vh">Loading…</pre>
        <div class="buttons"><button class="primary" data-copy-all>Copy all</button><button data-copy-tail>Copy last 40 lines</button><button data-close>Close</button></div>`);
    let text = '';
    try { const res = await api(`/api/shells/${encodeURIComponent(termName)}/scrollback?lines=3000`, { raw: true }); text = await res.text(); const pre = $('pre', panel); pre.textContent = text; pre.scrollTop = pre.scrollHeight; }
    catch (ex) { $('pre', panel).textContent = ex.message; }
    const copy = (t, label) => copyText(t, label);
    $('[data-copy-all]', panel).onclick = () => copy(text, 'Copied scrollback');
    $('[data-copy-tail]', panel).onclick = () => copy(text.trimEnd().split('\n').slice(-40).join('\n'), 'Copied last 40 lines');
}
$('#key-history').addEventListener('click', async () => {
    const { panel, close } = openDialog(`<h2>${icon('history')}History</h2>
        <div class="choices" data-seg><button type="button" data-s="commands" class="selected">Commands</button><button type="button" data-s="prompts">Claude prompts</button></div>
        <div class="menu" data-items style="max-height:50vh;overflow:auto;margin-top:10px"><p class="muted">Loading…</p></div><div class="buttons"><button data-close>Close</button></div>`);
    let data = { commands: [], prompts: [] };
    try { data = await api('/api/history'); } catch (ex) { toast(ex.message, true); }
    const render = seg => {
        const items = seg === 'commands' ? data.commands.map(c => ({ text: c })) : data.prompts;
        const box = $('[data-items]', panel);
        box.innerHTML = items.length ? items.map((it, i) => `<button data-i="${i}" class="mono" style="font-size:13px;white-space:pre-wrap;word-break:break-word">${esc(it.text.length > 240 ? it.text.slice(0, 240) + '…' : it.text)}</button>`).join('') : '<p class="muted">Nothing here yet.</p>';
        $$('button[data-i]', box).forEach(b => b.onclick = () => { composerInput.value = items[Number(b.dataset.i)].text; composerInput.dispatchEvent(new Event('input')); close(); composerInput.focus(); });
    };
    render('commands');
    $$('[data-seg] button', panel).forEach(b => b.onclick = () => { $$('[data-seg] button', panel).forEach(x => x.classList.toggle('selected', x === b)); render(b.dataset.s); });
});
const bracketed = text => `\x1b[200~${text}\x1b[201~`;
const composerInput = $('#composer-input');
$('#composer').addEventListener('submit', e => { e.preventDefault(); sendComposer(); });
composerInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComposer(); } });
composerInput.addEventListener('input', () => { composerInput.style.height = 'auto'; composerInput.style.height = Math.min(140, composerInput.scrollHeight) + 'px'; });
function sendComposer() {
    const text = composerInput.value;
    if (!text.trim()) return;
    if (scrollMode) setScrollMode(false);
    if (ctrlArmed) { const c = text.trim().toUpperCase().charCodeAt(0); if (c >= 64 && c <= 95) sendInput(String.fromCharCode(c - 64)); setCtrl(false); }
    else if (text.includes('\n')) { sendInput(bracketed(text)); setTimeout(() => sendInput('\r'), 60); }
    else sendInput(text + '\r');
    composerInput.value = ''; composerInput.style.height = 'auto';
}
// ---------- attachments: paste / drop / pick a file → upload to the shell's folder → reference in the message ----------

function cwdRel() {
    const s = state.shells.find(x => x.name === termName);
    const abs = s?.cwd || '';
    if (!abs) return homeRel;
    if (fsRoot === '/') return abs.replace(/^\/+/, '');
    const base = fsRoot.replace(/\/$/, '');
    return abs.startsWith(base) ? abs.slice(base.length).replace(/^\/+/, '') : homeRel;
}
function stamp() { const d = new Date(); return d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-'); }
async function attachFiles(files) {
    const list = [...files].filter(f => f && f.size >= 0);
    if (!list.length) return;
    const btn = $('#composer-attach'); btn.classList.add('busy');
    const dir = join(cwdRel(), '.pasted');
    await api('/api/files/mkdir', { method: 'POST', body: { path: cwdRel() || '.', name: '.pasted' } }).catch(() => {});
    const refs = [];
    for (const f of list) {
        const ext = (f.name && f.name.includes('.')) ? '' : (f.type === 'image/png' ? '.png' : f.type === 'image/jpeg' ? '.jpg' : f.type === 'image/gif' ? '.gif' : f.type === 'image/webp' ? '.webp' : '');
        const base = (f.name && f.name !== 'image.png' ? f.name : `paste${ext || '.png'}`).replace(/[^\w.\-]+/g, '_');
        const name = `${stamp()}-${base}`;
        try {
            await uploadOne(new File([f], name, { type: f.type }), dir, () => {}, true);
            const abs = (fsRoot === '/' ? '/' : fsRoot.replace(/\/$/, '') + '/') + join(dir, name);
            refs.push(abs);
        } catch (ex) { toast(`${base}: ${ex.message}`, true); }
    }
    btn.classList.remove('busy');
    if (!refs.length) return;
    const ta = composerInput;
    const lead = ta.value && !/\s$/.test(ta.value) ? ' ' : '';
    ta.value += lead + refs.map(r => (list.length === 1 && /\.(png|jpe?g|gif|webp)$/i.test(r) ? `Look at the image ${r}` : r)).join(' ') + ' ';
    ta.dispatchEvent(new Event('input')); ta.focus();
    toast(refs.length === 1 ? 'Attached: path added to your message' : `Attached ${refs.length} files`);
}
composerInput.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); attachFiles(files); }
});
$('#composer-attach').addEventListener('click', () => $('#composer-file').click());
$('#composer-file').addEventListener('change', e => { attachFiles(e.target.files); e.target.value = ''; });
termSheet.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); termSheet.classList.add('dropping'); } });
termSheet.addEventListener('dragleave', () => termSheet.classList.remove('dropping'));
termSheet.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) { e.preventDefault(); termSheet.classList.remove('dropping'); attachFiles(e.dataTransfer.files); } });
// Pasting an image while the terminal itself has focus also attaches it.
termHost.addEventListener('paste', e => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); e.stopPropagation(); attachFiles(files); } }, true);

const onViewport = () => { if (!termSheet.hidden) sendResize(); };
window.addEventListener('resize', onViewport);
window.visualViewport?.addEventListener('resize', onViewport);

// ---------- services ----------

$$('#services-seg button').forEach(b => b.addEventListener('click', () => { state.servicesFilter = b.dataset.f; $$('#services-seg button').forEach(x => x.classList.toggle('on', x === b)); loadServices().catch(e => toast(e.message, true)); }));
$('#services-new').addEventListener('click', startSomethingDialog);

async function loadServices() {
    const s = await api('/api/services');
    const shared = await api('/api/creds').catch(() => []);
    const credChip = port => { const list = shared.filter(c => c.port === port); return list.length ? `<button class="pill" data-credport="${port}" title="Shared credentials">${icon('key')}${list.length > 1 ? list.length : ''}</button>` : ''; };
    const f = state.servicesFilter;
    const show = k => f === 'all' || f === k;
    let html = '';

    if (show('links')) {
        html += `<h2 class="section"><span class="bullet kelp"></span>Shared links<span class="meta">public · 4 h max</span></h2>`;
        html += s.links.length ? `<div class="list">${s.links.map(t => `
            <div class="row"><span class="ico kelp">${icon('link')}</span>
              <div class="main"><div class="title">${esc(t.name || t.target)}${t.kind === 'zoned' ? '<span class="tag">your domain</span>' : ''}${t.owner ? `<span class="tag dim">${esc(t.owner)}</span>` : ''}</div><div class="sub mono">${t.url ? esc(t.url.replace(/^https:\/\//, '')) : 'publishing…'}</div>
                ${t.expires ? `<div class="bar-mini kelp"><div style="width:${Math.max(2, Math.min(100, (t.expires - Date.now()) / (4 * 3600_000) * 100))}%"></div></div>` : ''}</div>
              ${credChip(t.port)}${t.url ? `<a class="pill kelp" href="${esc(t.url)}" target="_blank" rel="noopener">${icon('external')}Open</a>` : ''}
              <button class="more" data-link-menu="${t.port}" aria-label="Link actions">${icon('more_h')}</button>
            </div>`).join('')}</div>` : `<p class="empty">Nothing shared. Share a dev server or container below.</p>`;
    }
    if (show('dev')) {
        html += `<h2 class="section"><span class="bullet brass"></span>Servers<span class="meta">registered with svc</span></h2>`;
        html += s.servers.length ? `<div class="list">${s.servers.map(d => `
            <div class="row"><span class="ico ${d.alive ? 'brass' : 'dim'}">${icon('devserver')}</span>
              <div class="main"><div class="title">${esc(d.name)}${d.port ? ` <span class="mono">:${d.port}</span>` : ''}${d.project ? `<span class="tag dim">${esc(d.project)}</span>` : ''}${d.external ? '<span class="tag dim">pid</span>' : ''}</div>
                <div class="sub">${d.alive ? `<span class="live">● running</span>${d.listening === false ? ' · not listening yet' : ''}` : `stopped${d.stoppedAt ? ' · ' + fmtAgo(d.stoppedAt) : ''}`}${d.tunnel?.url ? ` · <a href="${esc(d.tunnel.url)}" target="_blank" rel="noopener" style="color:var(--kelp)">${esc(d.tunnel.url.replace(/^https:\/\//, ''))}</a>` : d.alive && d.port ? ' · local only' : ''}</div></div>
              ${d.port ? credChip(d.port) : ''}${d.alive && d.port && !d.tunnel ? `<button class="pill ghost" data-share="${d.port}" data-label="${esc(d.name)}">${icon('share')}Share</button>` : ''}
              ${d.alive ? `<button class="pill" data-srv="stop" data-slug="${esc(d.slug)}">${icon('stop')}Stop</button>` : d.canStart ? `<button class="pill" data-srv="start" data-slug="${esc(d.slug)}">${icon('play')}Start</button>` : ''}
              <button class="more" data-srv-menu="${esc(d.slug)}" aria-label="Server actions">${icon('more_h')}</button>
            </div>`).join('')}</div>` : `<p class="empty">No registered servers. Agents start them with <span class="mono">svc run --name … --port … -- &lt;command&gt;</span>; anything else listening shows below.</p>`;
        if (s.devservers.length) {
            html += `<h2 class="section"><span class="bullet brass"></span>Other listening ports<span class="meta">unregistered</span></h2>`;
            html += `<div class="list">${s.devservers.map(d => `
            <div class="row"><span class="ico brass">${icon('devserver')}</span>
              <div class="main"><div class="title">${esc(d.process)} · <span class="mono">:${d.port}</span></div><div class="sub">${d.tunnel ? '<span class="live">● shared</span>' : 'local only'}${d.shell ? ` · ${esc(d.shell)} shell` : ''}</div></div>
              ${credChip(d.port)}<button class="pill ghost" data-register="${d.port}" data-label="${esc(d.process)}" title="Register as a server">${icon('plus')}</button>${d.tunnel ? `<button class="pill" data-unshare="${d.port}">${icon('x')}Unshare</button>` : `<button class="pill ghost" data-share="${d.port}" data-label="${esc(d.process)}">${icon('share')}Share</button>`}
            </div>`).join('')}</div>`;
        }
        if (s.system?.length) {
            html += `<details class="sys"><summary><span class="bullet"></span>System · ${s.system.length} local-only port${s.system.length === 1 ? '' : 's'}<span class="meta">Porthole, agents, box services · not shareable</span></summary>
            <div class="list">${s.system.map(d => `<div class="row plain"><span class="ico dim">${icon('settings')}</span><div class="main"><div class="title">${esc(d.what)}</div><div class="sub">${esc(d.process)} · <span class="mono">${esc(d.addr)}:${d.port}</span></div></div></div>`).join('')}</div></details>`;
        }
    }
    if (show('dev')) {
        const cs = await api('/api/codeserver').catch(() => null);
        if (cs) {
            const shareNote = `public link · ${cs.shareMinutes} min`;
            const linkRow = (shared, url, expires, who) => shared
                ? `<div class="row plain"><div class="main"><div class="sub"><a href="${esc(url)}" target="_blank" rel="noopener" style="color:var(--kelp)">${esc((url || '').replace(/^https:\/\//, ''))}</a> · public, password-protected${expires ? ` · closes in ${fmtIn(expires)}` : ''}</div></div><a class="pill kelp" href="${esc(url)}" target="_blank" rel="noopener">${icon('external')}Open</a><button class="pill" data-cs="unshare" data-who="${esc(who)}">${icon('x')}Unshare</button></div>`
                : `<div class="row plain"><div class="main"><div class="sub">Only reachable from the box until you share it.</div></div><button class="pill ghost" data-cs="share" data-who="${esc(who)}">${icon('share')}Share link</button></div>`;
            html += `<h2 class="section"><span class="bullet ${cs.running || cs.projects.some(p => p.running) ? 'kelp' : ''}"></span>Code editor<span class="meta">VS Code in the browser · ${esc(shareNote)}</span></h2>
            <div class="list">
              <div class="row"><span class="ico ${cs.running ? 'kelp' : 'dim'}">${icon('file-code')}</span>
                <div class="main"><div class="title">Box editor<span class="tag dim">root · whole box</span>${cs.shared ? '<span class="tag brass">public</span>' : ''}</div>
                  <div class="sub">${!cs.installed ? 'code-server not installed on the box' : cs.running ? `<span class="live">● running</span> · <span class="mono">:${cs.port}</span> · ${esc(shortPath(cs.folder || ''))}` : 'stopped · off by default'}</div></div>
                ${!cs.installed ? '' : cs.running ? `<button class="pill" data-cs="stop" data-who="box">${icon('stop')}Stop</button>` : `<button class="pill" data-cs="start" data-who="box">${icon('play')}Start</button>`}
                ${cs.installed ? `<button class="more" data-cs="menu" data-who="box" aria-label="Box editor actions">${icon('more_h')}</button>` : ''}
              </div>
              ${cs.running ? linkRow(cs.shared, cs.url, cs.expires, 'box') : ''}
              ${cs.projects.map(p => `
              <div class="row"><span class="ico ${p.running ? 'dock' : 'dim'}">${icon('container')}</span>
                <div class="main"><div class="title">${esc(p.name.replace(/^code-/, ''))}<span class="tag">project · Docker</span>${p.shared ? '<span class="tag brass">public</span>' : ''}</div>
                  <div class="sub">${p.running ? `<span class="live">● running</span> · <span class="mono">:${p.port}</span>` : esc(p.status || 'stopped')} · ${esc(shortPath(p.folder || ''))}</div></div>
                <button class="pill" data-cs="stop" data-who="${esc(p.name)}">${icon('trash')}Remove</button>
                <button class="more" data-cs="menu" data-who="${esc(p.name)}" aria-label="Editor actions">${icon('more_h')}</button>
              </div>
              ${p.running ? linkRow(p.shared, p.url, p.expires, p.name) : ''}`).join('')}
              <button class="row plain" data-cs="start" data-who="project"><span class="ico dock">${icon('plus')}</span><div class="main"><div class="title" style="color:var(--brass)">Project editor</div><div class="sub">code-server in Docker that can only see one project folder — the safer one to share</div></div></button>
            </div>`;
        }
    }
    if (show('docker')) {
        html += `<h2 class="section"><span class="bullet dock"></span>Docker<span class="meta">${s.docker ? `${s.containers.length} container${s.containers.length === 1 ? '' : 's'}` : 'not running'}</span></h2>`;
        if (s.docker) {
            const rows = [
                ...s.containers.map(c => `
                <div class="row"><span class="ico ${c.state === 'running' ? 'dock' : 'dim'}">${icon(c.app === 'postgres' || c.image.startsWith('postgres') || c.image.startsWith('redis') ? 'database' : 'container')}</span>
                  <div class="main"><div class="title">${esc(c.title)}${c.app ? '<span class="tag">app</span>' : ''}${c.compose ? `<span class="tag dim">${esc(c.compose)}</span>` : ''}</div>
                    <div class="sub">${c.state === 'running' ? `<span class="live">● ${esc(c.status.replace(/^Up /, 'up '))}</span>` : esc(c.status.toLowerCase())}${c.ports.length ? ` · <span class="mono">:${c.ports.map(p => p.host).join(' :')}</span>` : ''}${c.tunnel?.url ? ' · shared' : c.ports.length && c.state === 'running' ? ' · local only' : ''}</div></div>
                  ${c.ports[0] ? credChip(c.ports[0].host) : ''}${c.state !== 'running' ? `<button class="pill" data-cact="start" data-c="${esc(c.name)}">${icon('play')}Start</button>`
                    : c.tunnel?.url ? `<a class="pill kelp" href="${esc(c.tunnel.url)}" target="_blank" rel="noopener">${icon('external')}Open</a>`
                    : c.ports.length && !c.noTunnel ? `<button class="pill ghost" data-share="${c.ports[0].host}" data-label="${esc(c.title)}">${icon('share')}Share</button>`
                    : `<button class="pill" data-clogs="${esc(c.name)}">${icon('logs')}Logs</button>`}
                  <button class="more" data-cmenu="${esc(c.name)}" aria-label="Container actions">${icon('more_h')}</button>
                </div>`),
                ...s.compose.filter(p => !s.containers.some(c => c.compose === p.name)).map(p => `
                <div class="row"><span class="ico dim">${icon('compose')}</span><div class="main"><div class="title">${esc(p.name)}<span class="tag">compose</span></div><div class="sub">${esc(p.status)}</div></div><button class="more" data-pmenu="${esc(p.name)}" aria-label="Project actions">${icon('more_h')}</button></div>`),
            ];
            html += rows.length ? `<div class="list">${rows.join('')}</div>` : `<p class="empty">No containers. Start an app below or run an image.</p>`;
            html += `<h2 class="section"><span class="bullet dock"></span>Apps in one tap<span class="meta">pull · run · link</span></h2>
                <div class="tiles">${s.apps.map(a => `<button class="tile ${a.running ? 'on' : ''}" data-app="${a.key}" data-title="${esc(a.title)}"><span class="ico dock">${icon('app-' + a.key.replace('stirling-pdf', 'stirling').replace('it-tools', 'ittools').replace('uptime-kuma', 'kuma'))}</span>${esc(a.title)}</button>`).join('')}
                <button class="tile dim" data-run-image><span class="ico">${icon('container')}</span>Any image…</button></div>`;
        } else {
            html += `<p class="empty">Docker is not running on the box.</p>`;
        }
    }
    $('#services-body').innerHTML = html;
    const body = $('#services-body');
    $$('[data-credport]', body).forEach(b => b.onclick = () => { const list = shared.filter(c => c.port === Number(b.dataset.credport)); if (list.length === 1) openSharedCred(list[0].id); else sharedCredsSheet(list); });
    $$('[data-share]', body).forEach(b => b.onclick = () => shareDialog(Number(b.dataset.share), b.dataset.label));
    $$('[data-srv]', body).forEach(b => b.onclick = async () => { b.disabled = true; try { await api(`/api/servers/${b.dataset.slug}/${b.dataset.srv}`, { method: 'POST' }); toast(b.dataset.srv === 'stop' ? 'Stopped' : 'Started'); } catch (ex) { toast(ex.message, true); } loadServices(); });
    $$('[data-srv-menu]', body).forEach(b => b.onclick = () => serverMenu(s.servers.find(x => x.slug === b.dataset.srvMenu)));
    $$('[data-register]', body).forEach(b => b.onclick = () => registerServerDialog(Number(b.dataset.register), b.dataset.label));
    $$('[data-unshare]', body).forEach(b => b.onclick = async () => { try { await api(`/api/tunnels/${b.dataset.unshare}`, { method: 'DELETE' }); toast('Link closed'); loadServices(); } catch (ex) { toast(ex.message, true); } });
    $$('[data-link-menu]', body).forEach(b => b.onclick = () => linkMenu(s.links.find(t => t.port === Number(b.dataset.linkMenu))));
    $$('[data-cact]', body).forEach(b => b.onclick = () => containerAction(b.dataset.c, b.dataset.cact));
    $$('[data-clogs]', body).forEach(b => b.onclick = () => logsSheet(b.dataset.clogs));
    $$('[data-cmenu]', body).forEach(b => b.onclick = () => containerMenu(s.containers.find(c => c.name === b.dataset.cmenu)));
    $$('[data-pmenu]', body).forEach(b => b.onclick = () => composeMenu(b.dataset.pmenu));
    $$('[data-app]', body).forEach(b => b.onclick = () => launchApp(b.dataset.app, b.dataset.title));
    $$('[data-cs]', body).forEach(b => b.onclick = () => codeServerAction(b.dataset.cs, b.dataset.who || 'box'));
    $('[data-run-image]', body)?.addEventListener('click', () => runImageDialog());
}

async function codeServerAction(act, who = 'box') {
    const isBox = who === 'box';
    const base = isBox ? '/api/codeserver' : `/api/codeserver/project/${encodeURIComponent(who)}`;
    try {
        if (act === 'start') {
            const project = who === 'project';
            const { panel, close } = openDialog(`<h2>${icon(project ? 'container' : 'file-code')}${project ? 'Start a project editor' : 'Start the box editor'}</h2>
                <p class="muted">${project ? 'Runs the official code-server image in Docker with only this folder mounted. It has its own password and cannot see the rest of the box.' : 'Runs code-server natively as root with the whole box visible, bound to loopback with a generated password. Nothing is public until you share it.'}</p>
                <div class="field"><label>Folder</label><button type="button" class="row plain picker" data-pick><span class="ico brass">${icon('folder')}</span><div class="main"><div class="title mono" data-folder-label>${esc(showPath(state.filesPath || homeRel))}</div><div class="sub">Tap to choose</div></div>${icon('chevron', 'i chev')}</button></div>
                <div class="buttons"><button class="primary" data-ok>Start</button><button data-close>Cancel</button></div>`);
            let folder = state.filesPath || homeRel;
            $('[data-pick]', panel).onclick = () => { close(); folderPicker(folder, picked => codeServerStartWith(picked, project), () => codeServerAction('start', who)); };
            $('[data-ok]', panel).onclick = async () => { close(); codeServerStartWith(folder, project); };
            return;
        }
        if (act === 'stop') {
            if (!isBox && !(await confirmDialog({ title: 'Remove this project editor?', text: 'The container is removed; the project folder is untouched.', action: 'Remove' }))) return;
            toast('Stopping…'); await api(`${base}/stop`, { method: 'POST' }); toast(isBox ? 'Box editor stopped' : 'Project editor removed');
        }
        if (act === 'unshare') { await api(`${base}/share`, { method: 'DELETE' }); toast('Link closed'); }
        if (act === 'share') {
            const ok = await confirmDialog({ title: 'Make this editor public?', text: `This creates a PUBLIC https URL on the internet, protected only by the editor's password${isBox ? ' — and the box editor runs as root with the whole box visible' : ''}. Only do this if two-step codes are on and this box is yours to lose. The link closes after 20 minutes.`, action: 'I understand, share it' });
            if (!ok) return;
            toast('Connecting to Cloudflare…');
            await api(`${base}/share`, { method: 'POST' });
            toast('Public link is live for 20 minutes');
        }
        if (act === 'menu') {
            const { panel, close } = openDialog(`<h2>${icon('file-code')}${isBox ? 'Box editor' : esc(who.replace(/^code-/, ''))}</h2><div class="menu"><button data-a="pw">${icon('eye')}Reveal password</button>${isBox ? `<button data-a="rotate">${icon('refresh')}New password</button>` : ''}</div><div class="buttons"><button data-close>Close</button></div>`);
            $$('[data-a]', panel).forEach(b => b.onclick = async () => {
                close();
                try {
                    if (b.dataset.a === 'pw') { const r = await api(`${base}/password`, { method: 'POST' }); if (!(await copyText(r.password, 'Password copied'))) { /* sheet shown */ } else showCopySheet(r.password, 'Editor password'); }
                    if (b.dataset.a === 'rotate') { await api('/api/codeserver/password/rotate', { method: 'POST' }); toast('New password set; restart the box editor to apply'); }
                } catch (ex) { toast(ex.message, true); }
            });
            return;
        }
    } catch (ex) { toast(ex.message, true); }
    loadServices();
}
async function codeServerStartWith(folder, project = false) {
    try {
        toast(project ? 'Pulling and starting the project editor…' : 'Starting VS Code…');
        await api(project ? '/api/codeserver/project/start' : '/api/codeserver/start', { method: 'POST', body: { folder } });
        toast(project ? 'Project editor is running' : 'Box editor is running');
    } catch (ex) { toast(ex.message, true); }
    loadServices();
}

function serverMenu(d) {
    if (!d) return;
    const { panel, close } = openDialog(`<h2>${icon('devserver')}${esc(d.name)}</h2><p class="muted">${d.cmd ? `<span class="mono">${esc(d.cmd.join(' '))}</span><br>` : d.cmdline ? `<span class="mono">${esc(d.cmdline)}</span><br>` : ''}${d.cwd ? `in ${esc(shortPath(d.cwd))} · ` : ''}pid ${d.pid || '—'}${d.port ? ` · :${d.port}` : ''}</p>
        <div class="menu">${d.log ? `<button data-a="logs">${icon('logs')}Logs</button>` : ''}${d.alive ? `<button data-a="stop">${icon('stop')}Stop (whole process group)</button>` : d.canStart ? `<button data-a="start">${icon('play')}Start</button>` : ''}<button data-a="rm" class="danger">${icon('trash')}Stop and forget</button></div><div class="buttons"><button data-close>Close</button></div>`);
    $$('[data-a]', panel).forEach(b => b.onclick = async () => {
        const a = b.dataset.a; close();
        try {
            if (a === 'logs') { const res = await api(`/api/servers/${d.slug}/logs?tail=400`, { raw: true }); const text = await res.text(); const dlg = openDialog(`<h2>${esc(d.name)} · log</h2><pre style="max-height:60vh">${esc(text || '(empty)')}</pre><div class="buttons"><button data-copy-all>${icon('copy')}Copy</button><button data-close>Close</button></div>`); $('[data-copy-all]', dlg.panel).onclick = () => copyText(text, 'Copied'); return; }
            if (a === 'stop' || a === 'start') await api(`/api/servers/${d.slug}/${a}`, { method: 'POST' });
            if (a === 'rm') { if (!(await confirmDialog({ title: `Forget "${d.name}"?`, text: 'It is stopped first (process group and any public link). Nothing on disk is deleted.', action: 'Stop and forget' }))) return; await api(`/api/servers/${d.slug}`, { method: 'DELETE' }); }
            loadServices();
        } catch (ex) { toast(ex.message, true); }
    });
}
function registerServerDialog(port, label = '') {
    const { panel, close } = openDialog(`<h2>${icon('devserver')}Register port ${port}</h2><p class="muted">Gives this process a name so it can be stopped, shared and tracked as a server. Porthole will not know how to restart it; for that, start it with <span class="mono">svc run</span>.</p>
        <div class="field"><label for="rs-name">Name</label><input id="rs-name" type="text" value="${esc(label)}" autocorrect="off"></div>
        <div class="buttons"><button class="primary" data-ok>Register</button><button data-close>Cancel</button></div>`);
    const go_ = async () => { try { await api('/api/servers', { method: 'POST', body: { name: $('#rs-name', panel).value, port } }); close(); toast('Registered'); loadServices(); } catch (ex) { toast(ex.message, true); } };
    $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
}
function shareDialog(port, label = '') {
    const { panel, close } = openDialog(`
        <h2>${icon('share')}Share port ${port}</h2>
        <p class="muted">Creates a public https link through Cloudflare. Anyone with the link can use it. It closes itself after four hours.</p>
        <div class="field"><label for="sh-label">Label</label><input id="sh-label" type="text" value="${esc(label)}" placeholder="what is it"></div>
        <div class="buttons"><button class="primary" data-ok>Create link</button><button data-close>Cancel</button></div>`);
    const go_ = async () => {
        const btn = $('[data-ok]', panel); btn.disabled = true; btn.textContent = 'Connecting to Cloudflare…';
        try { const t = await api('/api/tunnels', { method: 'POST', body: { port, name: $('#sh-label', panel).value } }); close(); toast(t.url ? 'Link is live' : 'Link is being published'); loadServices(); }
        catch (ex) { toast(ex.message, true); btn.disabled = false; btn.textContent = 'Create link'; }
    };
    $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
}
function linkMenu(t) {
    if (!t) return;
    const { panel, close } = openDialog(`<h2 class="mono">${esc(t.url || `port ${t.port}`)}</h2><p class="muted">${t.expires ? `Closes in ${fmtIn(t.expires)}.` : ''}</p>
        <div class="menu"><button data-a="copy">${icon('copy')}Copy link</button><button data-a="extend">${icon('history')}Keep open 4 more hours</button><button data-a="close" class="danger">${icon('x')}Close link</button></div>`);
    $$('[data-a]', panel).forEach(b => b.onclick = async () => {
        const a = b.dataset.a; close();
        try {
            if (a === 'copy') await copyText(t.url, 'Link copied');
            if (a === 'extend') { await api(`/api/tunnels/${t.port}/extend`, { method: 'POST', body: { minutes: 240 } }); toast('Extended'); loadServices(); }
            if (a === 'close') { await api(`/api/tunnels/${t.port}`, { method: 'DELETE' }); toast('Link closed'); loadServices(); }
        } catch (ex) { toast(ex.message, true); }
    });
}
async function containerAction(name, act) {
    if (act === 'remove' && !(await confirmDialog({ title: `Remove "${name}"?`, text: 'The container is deleted. Volumes and mounted folders are kept.', action: 'Remove' }))) return;
    try { await api(`/api/docker/containers/${encodeURIComponent(name)}/${act}`, { method: 'POST' }); toast(`${act} ${name}`); loadServices(); } catch (ex) { toast(ex.message, true); }
}
function containerMenu(c) {
    if (!c) return;
    const running = c.state === 'running';
    const { panel, close } = openDialog(`<h2 class="mono">${esc(c.name)}</h2><p class="muted">${esc(c.image)} · ${esc(c.status)}</p>
        <div class="menu">
          ${running ? `<button data-a="stop">${icon('stop')}Stop</button><button data-a="restart">${icon('restart')}Restart</button>` : `<button data-a="start">${icon('play')}Start</button>`}
          <button data-a="logs">${icon('logs')}Logs</button>
          ${running && c.ports.length && !c.tunnel ? `<button data-a="share">${icon('share')}Share port ${c.ports[0].host}</button>` : ''}
          ${c.tunnel ? `<button data-a="unshare">${icon('x')}Close shared link</button>` : ''}
          <button data-a="remove" class="danger">${icon('trash')}Remove container</button>
        </div>`);
    $$('[data-a]', panel).forEach(b => b.onclick = async () => {
        const a = b.dataset.a; close();
        if (a === 'logs') return logsSheet(c.name);
        if (a === 'share') return shareDialog(c.ports[0].host, c.title);
        if (a === 'unshare') { try { await api(`/api/tunnels/${c.tunnel.port}`, { method: 'DELETE' }); toast('Link closed'); loadServices(); } catch (ex) { toast(ex.message, true); } return; }
        containerAction(c.name, a);
    });
}
function composeMenu(project) {
    const { panel, close } = openDialog(`<h2>${esc(project)}</h2><div class="menu"><button data-a="up">${icon('play')}Up</button><button data-a="restart">${icon('restart')}Restart</button><button data-a="pull">${icon('download')}Pull images</button><button data-a="down" class="danger">${icon('stop')}Down</button></div>`);
    $$('[data-a]', panel).forEach(b => b.onclick = async () => { close(); toast(`compose ${b.dataset.a}…`); try { await api(`/api/docker/compose/${encodeURIComponent(project)}/${b.dataset.a}`, { method: 'POST' }); toast(`${project}: ${b.dataset.a} done`); loadServices(); } catch (ex) { toast(ex.message, true); } });
}
async function logsSheet(name) {
    const { panel } = openDialog(`<h2 class="mono">${esc(name)} · logs</h2><pre style="max-height:60vh">Loading…</pre><div class="buttons"><button data-refresh>Refresh</button><button data-close>Close</button></div>`);
    const load = async () => { try { const res = await api(`/api/docker/containers/${encodeURIComponent(name)}/logs?tail=300`, { raw: true }); const pre = $('pre', panel); pre.textContent = (await res.text()) || '(no output)'; pre.scrollTop = pre.scrollHeight; } catch (ex) { $('pre', panel).textContent = ex.message; } };
    $('[data-refresh]', panel).onclick = load; await load();
}
async function launchApp(key, title) {
    const { panel, close } = openDialog(`<h2>${icon('zap')}${esc(title)}</h2><p class="muted">Pulls the image if needed, starts it on the box, and opens a shared link. First start can take a minute.</p>
        <div class="buttons"><button class="primary" data-ok>Start ${esc(title)}</button><button data-close>Cancel</button></div>`);
    $('[data-ok]', panel).onclick = async () => {
        const btn = $('[data-ok]', panel); btn.disabled = true; btn.textContent = 'Pulling and starting…';
        try { const r = await api(`/api/docker/apps/${key}`, { method: 'POST', body: { tunnel: true } }); close(); toast(r.url ? `${title} is live` : `${title} is running on :${r.hostPort}`); go('services'); }
        catch (ex) { toast(ex.message, true); btn.disabled = false; btn.textContent = `Start ${title}`; }
    };
}
function startSomethingDialog() {
    const { panel, close } = openDialog(`<h2>Start something</h2><div class="menu">
        <button data-a="share">${icon('share')}Share a port</button>
        <button data-a="image">${icon('container')}Run a Docker image</button>
        <button data-a="shell">${icon('terminal')}Open a shell</button></div><div class="buttons"><button data-close>Cancel</button></div>`);
    $$('[data-a]', panel).forEach(b => b.onclick = () => { close(); if (b.dataset.a === 'share') shareDialog(''); if (b.dataset.a === 'image') runImageDialog(); if (b.dataset.a === 'shell') newShellDialog(state.filesPath, 'shell'); });
}
// Run any image: look it up first (pull + inspect), then edit what the image declares before starting.
function runImageDialog(prefill = '') {
    const { panel, close } = openDialog(`
        <h2>${icon('container')}Run a container</h2>
        <p class="muted">Type an image. Porthole pulls it and shows its ports, default environment and volumes so you can adjust them before it starts.</p>
        <div class="field"><label for="dr-image">Image</label><div style="display:flex;gap:8px"><input id="dr-image" type="text" class="mono" value="${esc(prefill)}" placeholder="nginx:alpine · ghcr.io/org/app:tag" autocapitalize="off" autocorrect="off" spellcheck="false"><button class="pill accent" data-lookup>${icon('search')}Look up</button></div></div>
        <div data-details></div>
        <div class="buttons" data-initial><button data-close>Cancel</button></div>`);
    const lookup = async () => {
        const image = $('#dr-image', panel).value.trim();
        if (!image) return;
        const btn = $('[data-lookup]', panel); btn.disabled = true; btn.innerHTML = `${icon('refresh')}Pulling…`;
        try { renderDetails(await api('/api/docker/inspect', { method: 'POST', body: { image } })); }
        catch (ex) { toast(ex.message, true); }
        btn.disabled = false; btn.innerHTML = `${icon('search')}Look up`;
    };
    const renderDetails = d => {
        $('[data-initial]', panel).hidden = true;
        const cmd = [...(d.entrypoint || []), ...(d.cmd || [])].join(' ');
        $('[data-details]', panel).innerHTML = `
            ${d.existing ? `<p class="muted" style="margin:10px 0 0">${icon('container')}<b>${esc(d.existing.name)}</b> already exists from this image (${esc(d.existing.state)}). Quick runs keep one container per image: ${d.existing.state === 'running' ? 'manage it in Services' : 'Run below starts the existing one'}.</p>` : ''}
            ${d.title || d.description ? `<p class="muted" style="margin:10px 0 0">${esc(d.title || '')}${d.title && d.description ? ' — ' : ''}${esc(d.description || '')}</p>` : ''}
            <p class="sub" style="margin:6px 2px 0">${esc(d.arch)} · ${fmtBytes(d.size)}${cmd ? ` · <span class="mono">${esc(cmd.slice(0, 80))}</span>` : ''}</p>
            <div class="field"><label for="dr-name">Name</label><input id="dr-name" type="text" class="mono" value="${esc(d.name)}" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
            <div class="field"><label>Ports (box port → container port)</label>
              ${d.ports.length
                ? d.ports.map((p, i) => `<div class="two" style="margin-bottom:6px"><input type="number" inputmode="numeric" data-host="${i}" value="${p.host}"><input type="number" inputmode="numeric" data-cont="${i}" value="${p.container}" title="${p.proto}"></div>`).join('')
                : `<div class="two"><input type="number" inputmode="numeric" data-host="0" placeholder="8080"><input type="number" inputmode="numeric" data-cont="0" placeholder="80"></div><p class="sub" style="margin:6px 2px 0">The image declares no ports. Add one if it serves anything.</p>`}</div>
            <div class="field"><label for="dr-env">Environment (defaults from the image; edit or add KEY=value lines)</label><textarea id="dr-env" rows="${Math.min(8, Math.max(2, d.env.length + 1))}" autocapitalize="off" autocorrect="off" spellcheck="false">${esc(d.env.map(e => `${e.key}=${e.value}`).join('\n'))}</textarea></div>
            <div class="field"><label for="dr-vol">Volumes (folder on the box : path in container, one per line)</label><textarea id="dr-vol" rows="${Math.min(5, Math.max(2, d.volumes.length + 1))}" class="mono" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${esc(join(homeRel, 'apps/' + d.name + '/data'))}:/data">${esc(d.volumes.map(v => `${join(homeRel, v.folder)}:${v.target}`).join('\n'))}</textarea></div>
            <div class="field"><label>Restart</label><div class="choices" data-restart><button type="button" data-r="unless-stopped" class="selected">Keep running</button><button type="button" data-r="no">Run once</button></div></div>
            <div class="buttons">${d.existing?.state === 'running' ? `<button class="primary" data-services>Open Services</button>` : `<button class="primary" data-ok>${d.existing ? `Start ${esc(d.existing.name)}` : `Run ${esc(d.name)}`}</button>`}<button data-close>Cancel</button></div>`;
        let restart = 'unless-stopped';
        $$('[data-restart] button', panel).forEach(b => b.onclick = () => { restart = b.dataset.r; $$('[data-restart] button', panel).forEach(x => x.classList.toggle('selected', x === b)); });
        $$('[data-close]', panel).forEach(b => (b.onclick = close));
        if ($('[data-services]', panel)) { $('[data-services]', panel).onclick = () => { close(); go('services'); }; return; }
        $('[data-ok]', panel).onclick = async () => {
            const btn = $('[data-ok]', panel);
            const ports = $$('[data-host]', panel).map((h, i) => ({ host: Number(h.value), container: Number($(`[data-cont="${i}"]`, panel).value) })).filter(p => p.host && p.container);
            const env = {}; for (const line of $('#dr-env', panel).value.split('\n')) { const i = line.indexOf('='); if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1); }
            const volumes = $('#dr-vol', panel).value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const i = l.indexOf(':'); return i > 0 ? { folder: l.slice(0, i), target: l.slice(i + 1) } : null; }).filter(Boolean);
            const name = $('#dr-name', panel).value.trim();
            btn.disabled = true; btn.textContent = 'Starting…';
            try { await api('/api/docker/run', { method: 'POST', body: { image: d.image, name, ports, env, volumes, restart } }); close(); toast(`${name} is running`); loadServices(); }
            catch (ex) { toast(ex.message, true); btn.disabled = false; btn.textContent = `Run ${d.name}`; }
        };
    };
    $('[data-lookup]', panel).onclick = lookup;
    $('#dr-image', panel).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } });
    if (prefill) lookup();
}

// ---------- files ----------

let showHidden = localStorage.getItem('porthole.hidden') === '1';
let fsRoot = '/', homeRel = '';
const join = (a, b) => (a ? `${a}/${b}` : b);
const parentOf = p => p.split('/').slice(0, -1).join('/');
const rootLabel = () => (fsRoot === '/' ? '/' : '~');
const showPath = p => (fsRoot === '/' ? '/' + p : p ? '~/' + p : '~');
const EXT_ICON = { png: 'file-image', jpg: 'file-image', jpeg: 'file-image', gif: 'file-image', webp: 'file-image', svg: 'file-image', heic: 'file-image', pdf: 'file-pdf', md: 'file-text', txt: 'file-text', csv: 'file-text', log: 'file-text', json: 'file-json', yml: 'file-code', yaml: 'file-code', js: 'file-code', mjs: 'file-code', ts: 'file-code', py: 'file-code', sh: 'file-code', html: 'file-code', css: 'file-code', tf: 'file-code', go: 'file-code', rs: 'file-code', zip: 'file-archive', tar: 'file-archive', gz: 'file-archive', tgz: 'file-archive', '7z': 'file-archive' };
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'env', 'html', 'htm', 'css', 'scss', 'csv', 'tsv', 'log', 'tf', 'tfvars', 'ini', 'conf', 'cfg', 'xml', 'sql', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'hpp', 'rb', 'php', 'swift', 'kt', 'lua', 'r', 'ps1', 'bat', 'gitignore', 'editorconfig', 'lock', 'properties', 'svg', 'vue', 'svelte']);
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);
const extOf = n => (n.includes('.') ? n.split('.').pop().toLowerCase() : '');
const isTextName = (n, size = 0) => (TEXT_EXT.has(extOf(n)) || extOf(n) === '' || /^(dockerfile|makefile|readme|license)$/i.test(n)) && size <= 2 * 1024 * 1024;

async function loadFiles(path = null) {
    if (path === null) path = localStorage.getItem('porthole.path');
    if (path === null) { const probe = await api('/api/files?path=.'); path = probe.home || ''; }
    const data = await api(`/api/files?path=${encodeURIComponent(path || '.')}`);
    fsRoot = data.root || '/'; homeRel = data.home || '';
    state.filesPath = data.path; localStorage.setItem('porthole.path', data.path);
    renderCrumbs(data.path);
    const items = data.items.filter(i => !i.hidden || showHidden);
    $('#files-empty').hidden = items.length > 0;
    $('#files-title').textContent = data.path ? basename(data.path) : (fsRoot === '/' ? 'Root' : 'Files');
    const up = data.path ? `<button class="row plain" data-up><span class="ico dim">${icon('back')}</span><div class="main"><div class="title mono">..</div><div class="sub">${esc(showPath(parentOf(data.path)))}</div></div></button>` : '';
    $('#file-list').innerHTML = up + items.map(i => `
        <button class="row" data-name="${esc(i.name)}" data-type="${i.type}" data-size="${i.size ?? 0}">
          <span class="ico ${i.type === 'dir' ? 'brass' : ''}">${icon(i.type === 'dir' ? 'folder' : EXT_ICON[extOf(i.name)] || 'file')}</span>
          <div class="main"><div class="title">${esc(i.name)}</div><div class="sub">${i.type === 'dir' ? 'Folder' : fmtBytes(i.size)} · ${fmtAgo(i.modified)}${i.symlink ? ' · link' : ''}</div></div>
          <span class="more ${state.expanded === join(data.path, i.name) ? 'on' : ''}" data-more>${icon('more_h')}</span>
        </button>`).join('');
    $('#file-list [data-up]')?.addEventListener('click', () => loadFiles(parentOf(state.filesPath)).catch(ex => toast(ex.message, true)));
    $$('#file-list .row[data-name]').forEach(row => {
        const name = row.dataset.name, type = row.dataset.type, size = Number(row.dataset.size), rel = join(state.filesPath, name);
        row.addEventListener('click', e => {
            if (e.target.closest('[data-more]')) return toggleExpand(row, rel, name, type, size);
            if (type === 'dir') return loadFiles(rel).catch(ex => toast(ex.message, true));
            if (isTextName(name, size)) return openEditor(rel, name);
            previewFile(rel, name);
        });
        if (state.expanded === rel) row.insertAdjacentHTML('afterend', expandRow(rel, name, type, size));
    });
    bindExpand();

    // Shells running in this folder.
    const shells = await api('/api/shells').catch(() => []);
    state.shells = shells;
    const absHere = fsRoot === '/' ? '/' + data.path : fsRoot.replace(/\/$/, '') + (data.path ? '/' + data.path : '');
    const here = shells.filter(s => s.cwd.replace(/\/$/, '') === absHere.replace(/\/$/, ''));
    $('#files-shells').innerHTML = here.map(s => `<button class="row" data-open="${esc(s.name)}"><span class="dot ${s.attached ? 'live' : ''}" style="margin:0 10px"></span><div class="main"><div class="title mono">${esc(s.name)}</div><div class="sub">${s.kind === 'agent' ? esc(agentTitle(s.agent)) : 'shell'}${s.preview?.length ? ' · ' + esc(s.preview[s.preview.length - 1].slice(0, 60)) : ''}</div></div>${icon('chevron', 'i chev')}</button>`).join('')
        + `<button class="row" data-start-claude><span class="ico brass">${icon('claude')}</span><div class="main"><div class="title" style="color:var(--brass)">Start an agent in this folder</div></div></button>`;
    $$('#files-shells [data-open]').forEach(b => b.onclick = () => openTerminal(b.dataset.open, 'Files'));
    $('#files-shells [data-start-claude]').onclick = () => newShellDialog(data.path, 'agent');
    loadRepoCard(data.path).catch(() => { $('#repo-card').innerHTML = ''; });
}

// ---------- git ----------

async function loadRepoCard(rel) {
    const card = $('#repo-card');
    if (rel !== state.filesPath) return;
    const st = await api(`/api/git/status?path=${encodeURIComponent(rel || '.')}`);
    if (rel !== state.filesPath) return;
    if (!st.repo) {
        card.innerHTML = rel && rel !== homeRel ? `<button class="row plain" data-git-init style="background:var(--hull);border:1px solid var(--rail);border-radius:var(--radius);margin-bottom:12px"><span class="ico">${icon('branch')}</span><div class="main"><div class="title" style="color:var(--brass)">Make this folder a Git repository</div><div class="sub">Then publish it to GitHub as a private repo</div></div></button>` : '';
        $('[data-git-init]', card)?.addEventListener('click', async () => { try { await api('/api/git/init', { method: 'POST', body: { path: rel } }); toast('Repository created'); loadFiles(rel); } catch (ex) { toast(ex.message, true); } });
        return;
    }
    const sync = st.upstream ? `${st.ahead ? `<span class="warn">↑${st.ahead} to push</span>` : ''}${st.behind ? `<span class="warn">↓${st.behind} to pull</span>` : ''}${!st.ahead && !st.behind ? '<span class="live">● in sync</span>' : ''}` : (st.remote ? '<span class="warn">never pushed</span>' : '<span class="warn">no remote</span>');
    card.innerHTML = `
        <div class="repo">
          <div class="head"><span class="ico brass">${icon('branch')}</span><div class="name">${st.github ? esc(`${st.github.owner}/${st.github.repo}`) : esc(basename(rel))}</div>${st.github ? `<a class="pill" href="${esc(st.github.url)}" target="_blank" rel="noopener">${icon('external')}GitHub</a>` : ''}</div>
          <div class="meta"><span class="mono">${esc(st.branch)}</span>${sync}<span>${st.changed ? `<span class="warn">${st.changed} changed</span>` : 'clean'}</span>${st.last ? `<span>${esc(st.last.subject.slice(0, 48))} · ${esc(st.last.when)}</span>` : ''}</div>
          <div class="btns">
            <button class="pill ${st.changed ? 'accent' : ''}" data-g="commit" ${st.changed ? '' : 'disabled'}>${icon('commit')}Commit</button>
            ${st.remote ? `<button class="pill ${st.ahead || !st.upstream ? 'accent' : ''}" data-g="push">${icon('cloud-up')}Push</button><button class="pill" data-g="pull">${icon('cloud-down')}Pull</button>` : `<button class="pill accent" data-g="publish">${icon('rocket')}Publish to GitHub</button>`}
            <button class="pill ${st.publish === 'local' ? 'ghost' : ''}" data-g="flag" title="Publishing allowed?">${icon(st.publish === 'public' ? 'globe' : st.publish === 'private' ? 'lock' : 'shield')}${st.publish === 'local' ? 'Local only' : st.publish === 'public' ? 'Public repo' : 'Private repo'}</button>
          </div>
        </div>`;
    $$('[data-g]', card).forEach(b => b.onclick = () => gitAction(rel, b.dataset.g, st));
}

// Where may this folder go? Nothing leaves the box until the user says private or public here.
function repoFlagDialog(rel, current = 'local', { forPublish = false } = {}) {
    return new Promise(resolve => {
        const { panel, close } = openDialog(`<h2>${icon('shield')}Publishing for ${esc(basename(rel) || 'this folder')}</h2>
            <p class="muted">${forPublish ? 'This folder is local only, so it cannot be published yet. ' : ''}Local only means no push, no remote, nothing leaves the box; commits still work. Choosing Private or Public allows publishing to GitHub with that visibility, and agents may push.</p>
            <div class="menu">
              <button data-f="local" class="${current === 'local' ? 'selected' : ''}">${icon('shield')}<span>Local only<br><span class="sub">default · commits stay on the box</span></span></button>
              <button data-f="private" class="${current === 'private' ? 'selected' : ''}">${icon('lock')}<span>Private repo<br><span class="sub">may be pushed to a private GitHub repository</span></span></button>
              <button data-f="public" class="${current === 'public' ? 'selected' : ''}">${icon('globe')}<span>Public repo<br><span class="sub">may be pushed to a public repository · check for secrets first</span></span></button>
            </div><div class="buttons"><button data-close>Cancel</button></div>`);
        $('[data-close]', panel).addEventListener('click', () => resolve(null));
        $$('[data-f]', panel).forEach(b => b.onclick = async () => {
            try { const r = await api('/api/projects/repo', { method: 'PUT', body: { path: rel || '.', flag: b.dataset.f } }); close(); toast(r.flag === 'local' ? 'Local only' : `${r.flag} repo`); resolve(r.flag); }
            catch (ex) { toast(ex.message, true); resolve(null); }
        });
    });
}

async function gitAction(rel, act, st) {
    const busy = (label) => { $$('#repo-card [data-g]').forEach(b => { b.disabled = true; }); toast(label); };
    try {
        if (act === 'flag') { await repoFlagDialog(rel, st.publish); loadRepoCard(rel); refresh(); return; }
        if (act === 'commit') {
            const { panel, close } = openDialog(`<h2>${icon('commit')}Commit ${st.changed} change${st.changed === 1 ? '' : 's'}</h2>
                <div class="menu" style="max-height:30vh;overflow:auto;margin-bottom:8px">${st.files.map(f => `<div class="row plain" style="min-height:36px;padding:6px 4px"><span class="tag ${f.state === '??' ? 'brass' : 'dim'}">${esc(f.state === '??' ? 'new' : f.state)}</span><span class="mono" style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.file)}</span></div>`).join('')}</div>
                <div class="field"><label for="gc-msg">Message</label><textarea id="gc-msg" rows="2" placeholder="What changed and why" style="font-family:var(--font)"></textarea></div>
                <div class="buttons"><button class="primary" data-ok>Commit${st.remote ? ' and push' : ''}</button><button data-close>Cancel</button></div>`);
            $('[data-ok]', panel).onclick = async () => {
                const msg = $('#gc-msg', panel).value;
                try { await api('/api/git/commit', { method: 'POST', body: { path: rel, message: msg } }); close(); toast('Committed'); if (st.remote) { busy('Pushing…'); await api('/api/git/push', { method: 'POST', body: { path: rel } }); toast('Pushed'); } loadRepoCard(rel); }
                catch (ex) { toast(ex.message, true); loadRepoCard(rel); }
            };
            return;
        }
        if (act === 'push') { busy('Pushing…'); await api('/api/git/push', { method: 'POST', body: { path: rel } }); toast('Pushed'); }
        if (act === 'pull') { busy('Pulling…'); await api('/api/git/pull', { method: 'POST', body: { path: rel } }); toast('Pulled'); }
        if (act === 'publish') {
            let flag = st.publish || 'local';
            if (flag === 'local') { flag = await repoFlagDialog(rel, flag, { forPublish: true }); if (!flag || flag === 'local') { loadRepoCard(rel); return; } }
            const { panel, close } = openDialog(`<h2>${icon('rocket')}Publish to GitHub</h2><p class="muted">Creates a <b>${flag}</b> repository on your GitHub account (from this folder's Repo setting) and pushes this folder to it.</p>
                <div class="field"><label for="gp-name">Repository name</label><input id="gp-name" type="text" class="mono" value="${esc(basename(rel))}" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
                <div class="field"><label for="gp-desc">Description (optional)</label><input id="gp-desc" type="text"></div>
                <div class="buttons"><button class="primary" data-ok>Create ${flag} repo and push</button><button data-close>Cancel</button></div>`);
            $('[data-ok]', panel).onclick = async () => {
                const btn = $('[data-ok]', panel); btn.disabled = true; btn.textContent = 'Creating…';
                try { await api('/api/git/publish', { method: 'POST', body: { path: rel, name: $('#gp-name', panel).value.trim(), description: $('#gp-desc', panel).value } }); close(); toast('Published to GitHub'); loadRepoCard(rel); }
                catch (ex) { toast(ex.message, true); btn.disabled = false; btn.textContent = 'Create and push'; if (ex.status === 401) { go('more'); push('github'); } }
            };
            return;
        }
    } catch (ex) { toast(ex.message, true); }
    loadRepoCard(rel);
}

// ---------- github page ----------

async function loadGithub() {
    const a = await api('/api/github/account');
    const box = $('#github-account');
    if (a.connected) {
        box.innerHTML = `<div class="row">${a.avatar ? `<img class="avatar" src="${esc(a.avatar)}" alt="">` : `<span class="ico kelp">${icon('user')}</span>`}<div class="main"><div class="title">${esc(a.name || a.login)}<span class="tag brass">@${esc(a.login)}</span></div><div class="sub"><span class="live">● connected</span> · via ${esc(a.via)}</div></div></div>
            <button class="row plain" data-sshkey><span class="ico">${icon('key')}</span><div class="main"><div class="title">SSH key for this box</div><div class="sub">Show the public key to add at github.com/settings/keys</div></div>${icon('chevron', 'i chev')}</button>`;
    } else {
        box.innerHTML = `<div class="row"><span class="ico flare">${icon('user')}</span><div class="main"><div class="title">Not connected</div><div class="sub">${a.installed ? 'Pick a way to connect below' : 'GitHub CLI is not installed on the box'}</div></div></div>
            <button class="row plain" data-gh-token><span class="ico brass">${icon('key')}</span><div class="main"><div class="title">Use a token from the Vault</div><div class="sub">Add a fine-grained token as <span class="mono">GH_TOKEN</span>, general scope</div></div>${icon('chevron', 'i chev')}</button>
            <button class="row plain" data-gh-login><span class="ico brass">${icon('login')}</span><div class="main"><div class="title">Sign in with a device code</div><div class="sub">Opens a shell; tap the link it prints and enter the code</div></div>${icon('chevron', 'i chev')}</button>
            <button class="row plain" data-sshkey><span class="ico">${icon('key')}</span><div class="main"><div class="title">SSH key for this box</div><div class="sub">For git over SSH instead of tokens</div></div>${icon('chevron', 'i chev')}</button>`;
    }
    $('[data-sshkey]', box)?.addEventListener('click', async () => {
        try { const k = await api('/api/github/sshkey'); openDialog(`<h2>${icon('key')}Box SSH key</h2><p class="muted">Add this at github.com → Settings → SSH and GPG keys. Long-press to copy, or tap Copy.</p><pre style="user-select:all">${esc(k.publicKey)}</pre><div class="buttons"><button class="primary" data-copy>Copy</button><a href="https://github.com/settings/ssh/new" target="_blank" rel="noopener">Open GitHub key settings</a><button data-close>Close</button></div>`); $('[data-copy]').onclick = () => copyText(k.publicKey, 'Key copied'); }
        catch (ex) { toast(ex.message, true); }
    });
    $('[data-gh-token]', box)?.addEventListener('click', () => { push('vault'); setTimeout(() => vaultDialog({ name: 'GitHub token', provider: 'github', kind: 'api_key', envName: 'GH_TOKEN', scope: 'general', notes: 'Fine-grained token: Contents + Metadata + Administration (repo create) on the repos you want' }), 200); });
    $('[data-gh-login]', box)?.addEventListener('click', async () => {
        try {
            if (!(await api('/api/shells')).some(x => x.name === 'github-login')) await api('/api/shells', { method: 'POST', body: { name: 'github-login', kind: 'shell', cwd: homeRel } });
            await openTerminal('github-login', 'More');
            setTimeout(() => sendInput('gh auth login --hostname github.com --git-protocol https --web\r'), 1500);
        } catch (ex) { toast(ex.message, true); }
    });

    const list = $('#github-repos'), empty = $('#github-empty');
    if (!a.connected) { list.innerHTML = ''; $('#github-count').textContent = ''; empty.textContent = 'Connect to see your repositories.'; empty.hidden = false; return; }
    try {
        const repos = await api('/api/github/repos');
        $('#github-count').textContent = `${repos.length}`;
        empty.hidden = repos.length > 0; empty.textContent = 'No repositories yet.';
        list.innerHTML = repos.map(r => `<div class="row"><span class="ico ${r.private ? 'brass' : ''}">${icon(r.private ? 'lock' : 'globe')}</span><div class="main"><div class="title">${esc(r.name)}${r.fork ? '<span class="tag dim">fork</span>' : ''}</div><div class="sub">${esc(r.description || r.full)} · ${fmtAgo(Date.parse(r.updated))}</div></div><button class="pill ghost" data-clone="${esc(r.full)}">${icon('cloud-down')}Clone</button></div>`).join('');
        $$('[data-clone]', list).forEach(b => b.onclick = () => cloneDialog(b.dataset.clone));
    } catch (ex) { empty.textContent = ex.message; empty.hidden = false; }
}
$('#github-clone').addEventListener('click', () => cloneDialog(''));
function cloneDialog(repo) {
    const { panel, close } = openDialog(`<h2>${icon('cloud-down')}Clone a repository</h2>
        <div class="field"><label for="cl-repo">Repository</label><input id="cl-repo" type="text" class="mono" value="${esc(repo)}" placeholder="owner/name or https://github.com/…" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
        <div class="field"><label for="cl-dest">Into folder</label><input id="cl-dest" type="text" class="mono" value="${esc(join(homeRel, 'Projects'))}" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
        <div class="buttons"><button class="primary" data-ok>Clone</button><button data-close>Cancel</button></div>`);
    const go_ = async () => {
        const btn = $('[data-ok]', panel); btn.disabled = true; btn.textContent = 'Cloning…';
        try { const r = await api('/api/git/clone', { method: 'POST', body: { repo: $('#cl-repo', panel).value.trim(), dest: $('#cl-dest', panel).value.trim() } }); close(); toast(`Cloned ${r.name}`); state.filesPath = r.path; go('files'); }
        catch (ex) { toast(ex.message, true); btn.disabled = false; btn.textContent = 'Clone'; }
    };
    $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
}
function toggleExpand(row, rel, name, type, size) {
    const open = state.expanded === rel;
    $$('#file-list .expand').forEach(e => e.remove());
    $$('#file-list .more').forEach(m => m.classList.remove('on'));
    state.expanded = open ? null : rel;
    if (!open) { row.insertAdjacentHTML('afterend', expandRow(rel, name, type, size)); $('.more', row).classList.add('on'); bindExpand(); }
}
function expandRow(rel, name, type, size) {
    const text = type === 'file' && isTextName(name, size);
    return `<div class="expand" data-for="${esc(rel)}">
        ${type === 'dir' ? `<button data-x="open">${icon('folder-open')}Open</button>` : text ? `<button data-x="edit">${icon('pencil')}Edit</button>` : `<button data-x="preview">${icon('eye')}Preview</button>`}
        <button data-x="rename">${icon('edit')}Rename</button>
        ${type === 'dir' ? `<button data-x="shell">${icon('terminal')}Shell</button>` : `<button data-x="download">${icon('download')}Save</button>`}
        <button data-x="claude" class="brass">${icon('claude')}Claude</button>
        <button data-x="trash" class="flare">${icon('trash')}Trash</button>
      </div>`;
}
function bindExpand() {
    $$('#file-list .expand').forEach(ex => {
        const rel = ex.dataset.for, name = basename(rel);
        $$('[data-x]', ex).forEach(b => b.onclick = async () => {
            const x = b.dataset.x;
            if (x === 'open') return loadFiles(rel);
            if (x === 'edit') return openEditor(rel, name);
            if (x === 'preview') return previewFile(rel, name);
            if (x === 'download') return window.open(`/api/files/download?path=${encodeURIComponent(rel)}`, '_blank', 'noopener');
            if (x === 'rename') return renameDialog(rel, name);
            if (x === 'shell') return newShellDialog(rel, 'shell');
            if (x === 'claude') return newShellDialog(ex.previousElementSibling?.dataset.type === 'dir' ? rel : state.filesPath, 'agent');
            if (x === 'trash') {
                if (!(await confirmDialog({ title: `Delete "${name}"?`, text: 'It moves to Porthole\'s trash on the box, so it can be recovered from a shell.', action: 'Delete' }))) return;
                try { await api('/api/files/trash', { method: 'POST', body: { path: rel } }); toast('Deleted'); state.expanded = null; loadFiles(state.filesPath); } catch (e) { toast(e.message, true); }
            }
        });
    });
}
function renderCrumbs(path) {
    const parts = path ? path.split('/') : [];
    let acc = '';
    const crumbs = [`<button data-path="" class="${parts.length ? '' : 'current'}">${rootLabel()}</button>`];
    if (homeRel && path !== homeRel && !path.startsWith(homeRel + '/')) crumbs.push(`<button data-path="${esc(homeRel)}">~ home</button>`);
    parts.forEach((p, i) => { acc = join(acc, p); crumbs.push(`<span class="sep">›</span><button data-path="${esc(acc)}" class="${i === parts.length - 1 ? 'current' : ''}">${esc(p)}</button>`); });
    crumbs.push(`<span class="sep">·</span><button data-hidden>${showHidden ? 'hide dotfiles' : 'dotfiles'}</button>`);
    const nav = $('#crumbs'); nav.innerHTML = crumbs.join('');
    $$('button[data-path]', nav).forEach(b => b.onclick = () => loadFiles(b.dataset.path).catch(ex => toast(ex.message, true)));
    $('[data-hidden]', nav).onclick = () => { showHidden = !showHidden; localStorage.setItem('porthole.hidden', showHidden ? '1' : '0'); loadFiles(state.filesPath); };
    nav.scrollLeft = nav.scrollWidth;
}
function renameDialog(rel, name) {
    const { panel, close } = openDialog(`<h2>Rename</h2><div class="field"><input id="rn" type="text" class="mono" value="${esc(name)}" autocapitalize="off" autocorrect="off" spellcheck="false"></div><div class="buttons"><button class="primary" data-ok>Rename</button><button data-close>Cancel</button></div>`);
    const go_ = async () => { try { await api('/api/files/rename', { method: 'POST', body: { path: rel, name: $('#rn', panel).value } }); close(); state.expanded = null; loadFiles(state.filesPath); } catch (ex) { toast(ex.message, true); } };
    $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
}
async function previewFile(rel, name) {
    const ext = extOf(name), url = `/api/files/download?path=${encodeURIComponent(rel)}`;
    const actions = `<div class="buttons"><a class="primary" href="${url}&inline=1" target="_blank" rel="noopener">Open</a><a href="${url}">Save to phone</a><button data-close>Close</button></div>`;
    if (IMG_EXT.has(ext)) return openDialog(`<h2 class="mono">${esc(name)}</h2><img src="${url}&inline=1" alt="">${actions}`);
    openDialog(`<h2 class="mono">${esc(name)}</h2><p class="muted">No in-app preview for this type.</p>${actions}`);
}
$('#files-mkdir').addEventListener('click', () => {
    const { panel, close } = openDialog(`<h2>${icon('folder-plus')}New folder</h2><div class="field"><input id="nf" type="text" class="mono" placeholder="folder-name" autocapitalize="off" autocorrect="off" spellcheck="false"></div><div class="buttons"><button class="primary" data-ok>Create</button><button data-close>Cancel</button></div>`);
    const go_ = async () => { try { await api('/api/files/mkdir', { method: 'POST', body: { path: state.filesPath || '.', name: $('#nf', panel).value } }); close(); loadFiles(state.filesPath); } catch (ex) { toast(ex.message, true); } };
    $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
});
$('#files-claude').addEventListener('click', () => newShellDialog(state.filesPath, 'agent'));

const NEW_EXTS = ['.md', '.txt', '.py', '.js', '.ts', '.json', '.yml', '.sh', '.html', '.css', '.env', '.csv', '.toml', '.sql'];
$('#files-newfile').addEventListener('click', () => {
    const { panel, close } = openDialog(`<h2>${icon('file-plus')}New file</h2>
        <div class="field"><label for="nfn">Name</label><input id="nfn" type="text" class="mono" placeholder="notes" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
        <div class="field"><label>Type</label><div class="choices wrap" data-ext>${NEW_EXTS.map((e, i) => `<button type="button" data-e="${e}" class="${i === 0 ? 'selected' : ''}">${e}</button>`).join('')}<button type="button" data-e="">no extension</button></div></div>
        <div class="buttons"><button class="primary" data-ok>Create and edit</button><button data-close>Cancel</button></div>`);
    let ext = NEW_EXTS[0];
    $$('[data-ext] button', panel).forEach(b => b.onclick = () => { ext = b.dataset.e; $$('[data-ext] button', panel).forEach(x => x.classList.toggle('selected', x === b)); });
    const go_ = async () => {
        let name = $('#nfn', panel).value.trim();
        if (!name) return toast('Give the file a name.', true);
        if (ext && !name.toLowerCase().endsWith(ext)) name += ext;
        try { const r = await api('/api/files/create', { method: 'POST', body: { path: state.filesPath || '.', name } }); close(); await loadFiles(state.filesPath); openEditor(r.path, name); }
        catch (ex) { toast(ex.message, true); }
    };
    $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
});

$('#files-upload').addEventListener('click', () => $('#files-input').click());
$('#files-input').addEventListener('change', async e => {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length) return;
    const box = $('#upload-progress'), bar = $('.upbar > div', box), nameEl = $('.upname', box), stateEl = $('.upstate', box);
    box.hidden = false;
    let done = 0;
    for (const f of files) {
        nameEl.textContent = f.name; stateEl.textContent = files.length > 1 ? `${done + 1} of ${files.length}` : 'uploading'; bar.style.width = '0%';
        try { await uploadOne(f, state.filesPath, pct => (bar.style.width = pct + '%')); done++; }
        catch (ex) { toast(`${f.name}: ${ex.message}`, true); }
    }
    box.hidden = true;
    if (done) toast(done === 1 ? 'Uploaded' : `Uploaded ${done} files`);
    loadFiles(state.filesPath);
});
function uploadOne(file, dir, onProgress, overwrite = false) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `/api/files/upload?path=${encodeURIComponent(dir || '.')}&name=${encodeURIComponent(file.name)}${overwrite ? '&overwrite=1' : ''}`);
        xhr.setRequestHeader('X-Porthole', '1'); xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = ev => { if (ev.lengthComputable) onProgress(Math.round(ev.loaded / ev.total * 100)); };
        xhr.onload = async () => {
            if (xhr.status < 300) return resolve();
            if (xhr.status === 409 && !overwrite) {
                const ok = await confirmDialog({ title: `Replace "${file.name}"?`, text: 'A file with that name is already there.', action: 'Replace' });
                return ok ? uploadOne(file, dir, onProgress, true).then(resolve, reject) : reject(new Error('Skipped'));
            }
            let msg; try { msg = JSON.parse(xhr.responseText).error; } catch { /* ignore */ }
            reject(new Error(msg || xhr.statusText || 'Upload failed'));
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(file);
    });
}

// ---------- editor ----------

const editorSheet = $('#editor-sheet'), editorText = $('#editor-text'), editorSave = $('#editor-save');
let editing = null; // { path, name, mtime, original }

async function openEditor(rel, name) {
    try {
        const f = await api(`/api/files/read?path=${encodeURIComponent(rel)}`);
        editing = { path: f.path, name, mtime: f.mtime, original: f.content };
        editorText.value = f.content;
        $('#editor-title').textContent = name;
        updateEditorStatus();
        editorSave.disabled = true;
        editorSheet.hidden = false;
        editorText.classList.toggle('wrap', localStorage.getItem('porthole.wrap') === '1');
        $('#editor-wrap').classList.toggle('on', localStorage.getItem('porthole.wrap') === '1');
    } catch (ex) { toast(ex.message, true); }
}
function updateEditorStatus() {
    const dirty = editing && editorText.value !== editing.original;
    const lines = editorText.value.split('\n').length;
    $('#editor-subtitle').textContent = `${lines} line${lines === 1 ? '' : 's'} · ${fmtBytes(new Blob([editorText.value]).size)}${dirty ? ' · unsaved' : ''}`;
    editorSave.disabled = !dirty;
}
editorText.addEventListener('input', updateEditorStatus);
editorText.addEventListener('keydown', e => {
    if (e.key === 'Tab') { e.preventDefault(); insertAtCursor('\t'); }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveEditor(); }
});
function insertAtCursor(text) {
    const s = editorText.selectionStart, en = editorText.selectionEnd;
    const pair = text.length === 2 && text !== '\t' ? text : null;
    const v = editorText.value;
    if (pair) { editorText.value = v.slice(0, s) + pair[0] + v.slice(s, en) + pair[1] + v.slice(en); editorText.selectionStart = editorText.selectionEnd = s + 1 + (en - s); }
    else { editorText.value = v.slice(0, s) + text + v.slice(en); editorText.selectionStart = editorText.selectionEnd = s + text.length; }
    editorText.focus(); updateEditorStatus();
}
$$('.editor-bar button[data-ins]').forEach(b => b.addEventListener('click', () => insertAtCursor(JSON.parse(`"${b.dataset.ins.replace(/"/g, '\\"')}"`))));
$('#editor-wrap').addEventListener('click', () => { const on = !editorText.classList.contains('wrap'); editorText.classList.toggle('wrap', on); $('#editor-wrap').classList.toggle('on', on); localStorage.setItem('porthole.wrap', on ? '1' : '0'); });
async function saveEditor(force = false) {
    if (!editing) return;
    editorSave.disabled = true;
    try {
        const r = await api('/api/files/write', { method: 'PUT', body: { path: editing.path, content: editorText.value, mtime: force ? undefined : editing.mtime } });
        editing.mtime = r.mtime; editing.original = editorText.value; updateEditorStatus(); toast('Saved');
    } catch (ex) {
        if (ex.status === 409) { if (await confirmDialog({ title: 'File changed on the box', text: 'Something else edited this file since you opened it. Overwrite it with your version?', action: 'Overwrite' })) return saveEditor(true); }
        else toast(ex.message, true);
        updateEditorStatus();
    }
}
editorSave.addEventListener('click', () => saveEditor());
$('#editor-back').addEventListener('click', async () => {
    if (editing && editorText.value !== editing.original) {
        const { panel, close } = openDialog(`<h2>Unsaved changes</h2><p class="muted">${esc(editing.name)} has changes you have not saved.</p><div class="buttons"><button class="primary" data-a="save">Save and close</button><button class="danger" data-a="discard">Discard</button><button data-close>Keep editing</button></div>`);
        $$('[data-a]', panel).forEach(b => b.onclick = async () => { close(); if (b.dataset.a === 'save') await saveEditor(); closeEditor(); });
        return;
    }
    closeEditor();
});
function closeEditor() { editorSheet.hidden = true; editing = null; loadFiles(state.filesPath).catch(() => {}); }

// ---------- more ----------

async function loadMore() {
    const s = await api('/api/status');
    $('#more-sub').textContent = location.host;
    const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
    const memUsed = s.mem.total - s.mem.free;
    const metric = (label, big, small, p, cls) => `<div><div class="sub">${label}</div><div style="font-size:22px;font-weight:700;letter-spacing:-.02em;margin:2px 0">${big}</div><div class="bar-mini ${cls}"><div style="width:${p}%"></div></div><div class="sub" style="margin-top:4px">${small}</div></div>`;
    $('#box-card').innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><div style="display:flex;align-items:center;gap:8px;font-weight:600"><span class="dot live"></span>This box · up ${fmtDuration(s.uptime)}</div><button class="icon-btn" id="box-refresh" aria-label="Refresh" style="width:36px;height:36px">${icon('refresh')}</button></div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px">
          ${metric('Load', s.load[0].toFixed(2), `${s.cpus} vCPU`, Math.min(100, s.load[0] / s.cpus * 100), s.load[0] / s.cpus > 0.9 ? 'flare' : '')}
          ${metric('Memory', fmtBytes(memUsed), `of ${fmtBytes(s.mem.total)}`, pct(memUsed, s.mem.total), pct(memUsed, s.mem.total) > 90 ? 'flare' : 'kelp')}
          ${s.disk ? metric('Disk', fmtBytes(s.disk.used), `of ${fmtBytes(s.disk.total)}`, pct(s.disk.used, s.disk.total), pct(s.disk.used, s.disk.total) > 90 ? 'flare' : 'dock') : ''}
        </div>`;
    $('#box-refresh').onclick = () => loadMore().catch(e => toast(e.message, true));
    loadUpdate().catch(() => {});
    const c = s.claude;
    $('#more-claude-sub').textContent = `Claude ${c.version ? c.version.replace(/\s*\(Claude Code\)/, '') : 'not installed'} · Codex · Antigravity · profiles`;
    $('#more-remote-sub').textContent = c.remoteControl ? 'Running — open the Claude app' : c.signedIn ? 'Off' : 'Sign in to Claude first';
    const sw = $('#remote-switch'); sw.setAttribute('aria-checked', String(!!c.remoteControl));
    sw.onclick = async () => {
        try {
            if (c.remoteControl) { await api('/api/shells/remote-control', { method: 'DELETE' }); toast('Remote Control stopped'); }
            else { if (!c.signedIn) { toast('Sign in to Claude first (Claude Code → Sign in)', true); return; } await api('/api/shells', { method: 'POST', body: { name: 'remote-control', kind: 'remote-control', cwd: '.' } }); toast('Remote Control starting'); }
            loadMore();
        } catch (ex) { toast(ex.message, true); }
    };
    const sec = await api('/api/security').catch(() => null);
    if (sec) $('#more-security-sub').innerHTML = `${sec.totp ? '<span class="live">● two-step on</span>' : 'two-step off'} · ${sec.sessions} device${sec.sessions === 1 ? '' : 's'} signed in`;
    api('/api/github/account').then(g => { $('#more-github-sub').textContent = g.connected ? `@${g.login} · connected` : 'Not connected'; }).catch(() => {});
    api('/api/creds').then(cl => { $('#more-creds-sub').textContent = cl.length ? `${cl.length} shared · ${cl.filter(c => c.service?.live).length} live` : 'Logins agents handed to you'; }).catch(() => {});
    const v = await api('/api/vault').catch(() => []);
    $('#more-vault-sub').textContent = v.length ? `${v.length} token${v.length === 1 ? '' : 's'} · ${v.filter(t => t.scope === 'general').length} general, ${v.filter(t => t.scope !== 'general').length} project` : 'No tokens yet';
    const conn = (ico, title, val, cls = '') => `<div class="row"><span class="ico ${cls}">${icon(ico)}</span><div class="main"><div class="title">${title}</div></div><div class="kv">${val}</div></div>`;
    $('#box-conn').innerHTML = [
        conn('network', 'Tailscale', s.tailscale.installed ? (s.tailscale.online ? esc(s.tailscale.dnsName || s.tailscale.ips?.[0] || 'online') : esc(s.tailscale.backend || 'offline')) : 'not installed'),
        conn('cloud', 'cloudflared', s.cloudflared ? esc(s.cloudflared.replace(/^cloudflared version\s*/i, '').split(' ')[0]) : 'not installed'),
        conn('container', 'Docker', s.docker ? esc(s.docker) : 'not running', 'dock'),
        conn('terminal', 'Node', esc(s.node)),
        conn('folder', 'Files root', esc(shortPath(s.root))),
    ].join('');
}

// ---------- self-update ----------

async function loadUpdate() {
    const u = await api('/api/update');
    const v = u.installed || {};
    const line = u.error ? `check failed · ${esc(u.error)}` : u.checkedAt ? (u.available ? `<span style="color:var(--brass)">Update available: ${esc(u.latestVersion)} @ ${esc(u.latestSha || '')}</span>` : `up to date · checked ${fmtAgo(u.checkedAt)}`) : 'not checked yet';
    const last = u.lastResult ? `<div class="sub">last update: ${u.lastResult.ok ? 'ok' : 'failed'} · ${esc(u.lastResult.message || '')} · ${fmtAgo(u.lastResult.at)}</div>` : '';
    $('#update-card').innerHTML = `
        <div class="row"><span class="ico ${u.available ? 'brass' : u.inProgress ? 'warn' : ''}">${icon(u.inProgress ? 'refresh' : u.available ? 'cloud-down' : 'check')}</span>
          <div class="main"><div class="title">Porthole ${esc(v.version || '?')}${v.sha ? `<span class="tag dim">${esc(v.sha)}</span>` : ''}</div><div class="sub">${u.inProgress ? 'updating…' : line}</div>${last}</div>
          ${u.inProgress ? '' : u.available ? `<button class="pill accent" data-upd="apply">${icon('cloud-down')}Update</button>` : `<button class="pill" data-upd="check">${icon('refresh')}Check</button>`}
          <button class="more" data-upd="menu" aria-label="Update actions">${icon('more_h')}</button>
        </div>`;
    $$('[data-upd]', $('#update-card')).forEach(b => b.onclick = () => updateAction(b.dataset.upd, u));
    if (u.inProgress) showUpdateOverlay();
}

let overlayPolling = false;
function showUpdateOverlay() {
    $('#update-overlay').hidden = false;
    if (overlayPolling) return;
    overlayPolling = true;
    const started = Date.now();
    const status = $('#update-overlay-status');
    const poll = async () => {
        const mins = Math.floor((Date.now() - started) / 60000), secs = Math.floor(((Date.now() - started) % 60000) / 1000);
        status.textContent = `waiting for the service… ${mins}:${String(secs).padStart(2, '0')}`;
        try {
            const r = await fetch('/api/update', { credentials: 'same-origin', cache: 'no-store' });
            if (r.status === 401) { location.reload(); return; }
            if (r.ok) {
                const s = await r.json();
                if (!s.inProgress && Date.now() - started > 8000) {
                    status.textContent = s.lastResult?.ok ? `Updated to ${s.installed?.version || ''}. Reloading…` : `Update failed: ${s.lastResult?.message || 'see the update log'}. Reloading…`;
                    setTimeout(() => location.reload(), 2500);
                    return;
                }
            }
        } catch { /* service restarting */ }
        if (Date.now() - started < 10 * 60_000) setTimeout(poll, 3000);
        else { status.textContent = 'This is taking longer than expected. Check the update log under More once the service is back.'; overlayPolling = false; }
    };
    poll();
}

async function updateAction(act, u) {
    try {
        if (act === 'check') { toast('Checking…'); await api('/api/update/check', { method: 'POST' }); return loadUpdate(); }
        if (act === 'apply') {
            const ok = await confirmDialog({ title: `Update to ${u.latestVersion}?`, text: 'Porthole shuts down for approximately 5 minutes and restarts itself after the update. Shells, tunnels, containers, files and the vault are untouched; if the service does not come back it rolls back automatically.', action: 'Update now', danger: false });
            if (!ok) return;
            await api('/api/update/apply', { method: 'POST' });
            showUpdateOverlay();
            return;
        }
        if (act === 'menu') {
            const { panel, close } = openDialog(`<h2>${icon('cloud-down')}Updates</h2><p class="muted">Source: <span class="mono">${esc(u.installed?.repo || '')}</span> @ ${esc(u.installed?.branch || 'master')}${u.latestDate ? ` · latest ${fmtAgo(Date.parse(u.latestDate))}` : ''}</p>
                ${(u.notes || []).length ? `<div class="menu">${u.notes.map(n => `<div class="row plain" style="min-height:36px;padding:6px 4px"><span class="tag dim">${esc(n.sha)}</span><span style="font-size:14px">${esc(n.message)}</span></div>`).join('')}</div>` : ''}
                <div class="buttons"><button data-a="check">Check now</button><button data-a="log">Show update log</button><button data-close>Close</button></div>`);
            $$('[data-a]', panel).forEach(b => b.onclick = async () => { close(); if (b.dataset.a === 'check') return updateAction('check', u); const res = await api('/api/update/log', { raw: true }); openDialog(`<h2>Update log</h2><pre style="max-height:60vh">${esc((await res.text()) || '(empty)')}</pre><div class="buttons"><button data-close>Close</button></div>`); });
        }
    } catch (ex) { toast(ex.message, true); }
}

// ---------- agents page ----------

async function loadAgents() {
    agentsCache = null;
    const list = await getAgents();
    $('#agents-body').innerHTML = list.map(a => `
        <h2 class="section">${esc(a.title)}<span class="meta">${esc(a.vendor)}</span></h2>
        <div class="list">
          <div class="row"><span class="dot ${a.installed ? (a.signedIn ? 'live' : 'warn') : 'off'}" style="margin:0 10px"></span><div class="main"><div class="title">${a.installed ? esc(a.version || 'installed') : 'Not installed'}</div><div class="sub">${a.installed ? (a.signedIn ? 'signed in' : 'not signed in') : esc(a.blurb)}</div></div></div>
          ${a.installed ? `<button class="row plain" data-login="${a.key}"><span class="ico brass">${icon('login')}</span><div class="main"><div class="title">${a.signedIn ? 'Open a session' : 'Sign in'}</div><div class="sub">${a.signedIn ? 'Starts ' + esc(a.title) + ' in your home folder' : 'Opens a shell with the login flow'}</div></div>${icon('chevron', 'i chev')}</button>` : ''}
          ${a.profiles ? a.profiles.map(p => `<div class="row"><span class="ico ${p.signedIn ? 'kelp' : ''}">${icon('user')}</span><div class="main"><div class="title">${esc(p.name)}<span class="tag dim">profile</span></div><div class="sub">${p.signedIn ? 'signed in' : 'not signed in'} · <span class="mono">${esc(shortPath(p.dir))}</span></div></div>${p.name !== 'default' ? `<button class="more" data-prof="${esc(p.name)}" aria-label="Profile actions">${icon('more_h')}</button>` : ''}</div>`).join('') + `<button class="row plain" data-new-profile><span class="ico">${icon('plus')}</span><div class="main"><div class="title" style="color:var(--brass)">New profile</div><div class="sub">Another account or organisation, or separate usage limits</div></div></button>` : ''}
        </div>`).join('');
    const body = $('#agents-body');
    $$('[data-login]', body).forEach(b => b.onclick = async () => {
        const key = b.dataset.login, a = list.find(x => x.key === key);
        const name = `${key}-home`;
        try {
            if (!(await api('/api/shells')).some(x => x.name === name)) await api('/api/shells', { method: 'POST', body: { name, kind: 'agent', agent: key, cwd: homeRel, login: !a.signedIn } });
            openTerminal(name, 'More');
        } catch (ex) { toast(ex.message, true); }
    });
    $('[data-new-profile]', body)?.addEventListener('click', () => newProfileDialog(loadAgents));
    $$('[data-prof]', body).forEach(b => b.onclick = () => {
        const name = b.dataset.prof;
        const { panel, close } = openDialog(`<h2>${esc(name)}</h2><div class="menu"><button data-a="signin">${icon('login')}Sign in to this profile</button><button data-a="rc">${icon('remote')}Remote Control with this profile</button><button data-a="remove" class="danger">${icon('trash')}Remove profile</button></div>`);
        $$('[data-a]', panel).forEach(x => x.onclick = async () => {
            close();
            try {
                if (x.dataset.a === 'signin') { const sn = `claude-${name}`; if (!(await api('/api/shells')).some(s => s.name === sn)) await api('/api/shells', { method: 'POST', body: { name: sn, kind: 'agent', agent: 'claude', profile: name, cwd: homeRel } }); openTerminal(sn, 'More'); }
                if (x.dataset.a === 'rc') { await api('/api/shells/remote-control', { method: 'DELETE' }).catch(() => {}); await api('/api/shells', { method: 'POST', body: { name: 'remote-control', kind: 'remote-control', profile: name, cwd: homeRel } }); toast(`Remote Control started with profile ${name}`); openTerminal('remote-control', 'More'); }
                if (x.dataset.a === 'remove') { if (!(await confirmDialog({ title: `Remove profile "${name}"?`, text: 'Its sign-in and settings on the box are deleted.', action: 'Remove' }))) return; await api(`/api/agents/claude/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' }); toast('Profile removed'); loadAgents(); }
            } catch (ex) { toast(ex.message, true); }
        });
    });
}

// ---------- claude page (legacy helpers) ----------

async function loadClaude() {
    const s = await api('/api/status');
    const c = s.claude;
    const row = (title, val, dot) => `<div class="row"><span class="dot ${dot}" style="margin:0 10px"></span><div class="main"><div class="title">${title}</div></div><div class="kv">${val}</div></div>`;
    $('#claude-body').innerHTML = [
        row('Claude Code', c.version ? esc(c.version.replace(/\s*\(Claude Code\)/, '')) : 'not installed', c.version ? 'live' : 'off'),
        row('Signed in', c.signedIn ? 'yes' : 'no', c.signedIn ? 'live' : 'off'),
        row('Remote Control', c.remoteControl ? 'running' : 'stopped', c.remoteControl ? 'live' : 'warn'),
        `<button class="row plain" data-a="login"><span class="ico brass">${icon('claude')}</span><div class="main"><div class="title">${c.signedIn ? 'Open a Claude session' : 'Sign in to Claude'}</div><div class="sub">${c.signedIn ? 'Starts Claude in your home folder' : 'Follow the link printed in the shell'}</div></div>${icon('chevron', 'i chev')}</button>`,
        c.remoteControl ? `<button class="row plain" data-a="rc"><span class="ico kelp">${icon('remote')}</span><div class="main"><div class="title">Open the Remote Control shell</div></div>${icon('chevron', 'i chev')}</button>` : '',
    ].join('');
    $('[data-a="login"]', $('#claude-body')).onclick = async () => {
        try { if (!(await api('/api/shells')).some(x => x.name === 'claude-home')) await api('/api/shells', { method: 'POST', body: { name: 'claude-home', kind: 'claude', cwd: '.' } }); openTerminal('claude-home', 'More'); }
        catch (ex) { toast(ex.message, true); }
    };
    $('[data-a="rc"]', $('#claude-body'))?.addEventListener('click', () => openTerminal('remote-control', 'More'));
}

// ---------- vault (credentials, n8n-style) ----------

let catalogCache = null;
async function getCatalog() { if (!catalogCache) catalogCache = await api('/api/vault/catalog'); return catalogCache; }

async function openSharedCred(id) {
    try { const c = await api(`/api/creds/${id}/values`, { method: 'POST' }); credPanel([c], { persisted: true }); } catch (ex) { toast(ex.message, true); }
}
function sharedCredsSheet(list) {
    const { panel, close } = openDialog(`<h2>${icon('key')}Shared credentials</h2><div class="menu">${list.map(c => `<button data-id="${c.id}">${icon('key')}<span>${esc(c.title)}</span><span class="sub" style="margin-left:auto">${fmtAgo(c.at)}</span></button>`).join('')}</div><div class="buttons"><button data-close>Close</button></div>`);
    $$('[data-id]', panel).forEach(b => b.onclick = () => { close(); openSharedCred(b.dataset.id); });
}
// Shared credentials page (More → Shared credentials). Separate from the Vault: these are logins handed to the
// user, the Vault holds tokens agents use.
async function loadCredsPage() {
    const list = await api('/api/creds').catch(() => []);
    const host = $('#creds-list'); if (!host) return;
    $('#creds-empty').hidden = list.length > 0;
    const stale = list.filter(c => c.service && c.service.live === false);
    const staleBtn = $('#creds-stale'); staleBtn.hidden = stale.length === 0; staleBtn.textContent = `Delete ${stale.length} stale`;
    const groups = new Map();
    for (const c of list) { const k = c.project ? c.project.split('/').filter(Boolean).pop() : (c.shell || 'Other'); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
    host.innerHTML = [...groups].map(([label, items]) => `<h2 class="section">${esc(label)}<span class="meta">${items.length}</span></h2><div class="list">${items.map(c => `
        <button class="row" data-sc="${c.id}"><span class="ico ${c.service ? (c.service.live ? 'kelp' : 'flare') : 'brass'}">${icon('key')}</span>
          <div class="main"><div class="title">${esc(c.title)}${c.port ? `<span class="tag ${c.service?.live ? '' : 'dim'}">:${c.port} · ${c.service?.live ? (c.openUrl ? 'public link' : 'live') : 'gone'}</span>` : ''}</div>
            <div class="sub">${esc(c.fields.map(f => f.label).join(' · '))}${c.note ? ` · ${esc(c.note)}` : ''} · ${fmtAgo(c.at)}</div></div>${icon('chevron', 'i chev')}</button>`).join('')}</div>`).join('');
    $$('[data-sc]', host).forEach(b => b.onclick = () => openSharedCred(b.dataset.sc));
    staleBtn.onclick = async () => {
        if (!(await confirmDialog({ title: `Delete ${stale.length} stale credential${stale.length === 1 ? '' : 's'}?`, text: 'Their services are no longer running.', action: 'Delete' }))) return;
        for (const c of stale) await api(`/api/creds/${c.id}`, { method: 'DELETE' }).catch(() => {});
        loadCredsPage();
    };
}
const loadSharedSection = loadCredsPage; // older call sites

async function loadVault() {
    const items = await api('/api/vault');
    $('#vault-empty').hidden = items.length > 0;
    const groups = new Map();
    for (const t of items) { const k = t.scope === 'general' ? 'General · every shell' : `Project · ${t.scope}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
    $('#vault-list').innerHTML = '';
    $('#vault-list').insertAdjacentHTML('afterend', '');
    const host = $('#vault-list').parentElement;
    $$('.vault-group', host).forEach(e => e.remove());
    for (const [label, list] of groups) {
        $('#vault-list').insertAdjacentHTML('beforebegin', `<div class="vault-group"><h2 class="section">${esc(label)}</h2><div class="list">${list.map(t => `
            <button class="row" data-id="${t.id}"><span class="ico ${t.oauth ? (t.oauth.connected ? 'kelp' : 'flare') : 'brass'}">${icon(t.oauth ? 'link' : 'key')}</span>
              <div class="main"><div class="title">${esc(t.name)}<span class="tag brass">${esc(t.title || t.provider)}</span>${t.oauth ? `<span class="tag ${t.oauth.connected ? '' : 'dim'}">${t.oauth.connected ? 'connected' : 'not connected'}</span>` : ''}</div>
                <div class="sub mono">${esc(t.fields.map(f => f.env).join(' · '))}</div></div>
              ${icon('more_h', 'i chev')}</button>`).join('')}</div></div>`);
    }
    $$('.vault-group .row').forEach(r => r.onclick = () => vaultMenu(items.find(i => i.id === r.dataset.id)));
    const q = new URLSearchParams(location.search);
    if (q.get('oauth')) { toast(q.get('oauth') === 'connected' ? `Connected ${q.get('name') || ''}` : `Connection failed: ${q.get('error') || ''}`, q.get('oauth') !== 'connected'); history.replaceState(null, '', '/'); }
}

function vaultMenu(t) {
    const { panel, close } = openDialog(`<h2>${esc(t.name)}</h2>
        <p class="muted">${esc(t.title || t.provider)} · ${esc(t.style)} · ${t.scope === 'general' ? 'every shell' : 'shells in ' + esc(t.scope)}${t.oauth?.expiresAt ? `<br>token ${t.oauth.expiresAt > Date.now() ? 'expires in ' + fmtIn(t.oauth.expiresAt) : 'expired (refreshes on use)'}` : ''}${t.notes ? '<br>' + esc(t.notes) : ''}</p>
        <div class="list" style="margin-bottom:10px">${t.fields.map(f => `<div class="row plain" style="min-height:40px;padding:8px 10px"><div class="main"><div class="title mono" style="font-size:13px">${esc(f.env)}</div><div class="sub">${esc(f.label)} · ${f.secret ? esc(f.hint) : esc(f.hint || '—')}</div></div><button class="pill" data-rv="${esc(f.name)}" style="padding:6px 10px">${icon('copy')}</button></div>`).join('')}</div>
        <div class="menu">
          ${t.oauth ? `<button data-a="connect">${icon('link')}${t.oauth.connected ? 'Reconnect account' : 'Connect account'}</button>${t.oauth.connected ? `<button data-a="refresh">${icon('refresh')}Refresh token now</button>` : ''}` : ''}
          <button data-a="reveal">${icon('eye')}Reveal all</button>
          <button data-a="edit">${icon('edit')}Edit values / scope</button>
          <button data-a="remove" class="danger">${icon('trash')}Delete</button>
        </div>`);
    $$('[data-rv]', panel).forEach(b => b.onclick = async () => { try { const r = await api(`/api/vault/${t.id}/reveal`, { method: 'POST', body: { field: b.dataset.rv } }); await copyText(Object.values(r.values)[0], 'Copied'); } catch (ex) { toast(ex.message, true); } });
    $$('[data-a]', panel).forEach(b => b.onclick = async () => {
        const a = b.dataset.a; close();
        try {
            if (a === 'connect') { const r = await api(`/api/vault/${t.id}/oauth/start`, { method: 'POST' }); location.href = r.url; }
            if (a === 'refresh') { await api(`/api/vault/${t.id}/refresh`, { method: 'POST' }); toast('Token refreshed'); loadVault(); }
            if (a === 'reveal') { const r = await api(`/api/vault/${t.id}/reveal`, { method: 'POST' }); showCopySheet(Object.entries(r.values).map(([k, v]) => `${k}=${v}`).join('\n'), t.name); }
            if (a === 'edit') vaultEditDialog(t);
            if (a === 'remove') { if (!(await confirmDialog({ title: `Delete "${t.name}"?`, text: 'Shells already running keep their copy until they end.', action: 'Delete' }))) return; await api(`/api/vault/${t.id}`, { method: 'DELETE' }); toast('Deleted'); loadVault(); }
        } catch (ex) { toast(ex.message, true); }
    });
}

$('#vault-new').addEventListener('click', catalogDialog);

async function catalogDialog() {
    const cat = await getCatalog().catch(ex => { toast(ex.message, true); return null; });
    if (!cat) return;
    const { panel, close } = openDialog(`<h2>${icon('key')}Add a credential</h2>
        <div class="field"><input id="cat-q" type="text" placeholder="Search services… (spotify, telegram, postgres)" autocapitalize="off" autocorrect="off"></div>
        <div data-cat style="max-height:55vh;overflow:auto;margin-top:8px"></div>
        <div class="buttons"><button data-close>Cancel</button></div>`);
    const box = $('[data-cat]', panel);
    const render = q => {
        const ql = q.trim().toLowerCase();
        const list = cat.services.filter(s => !ql || `${s.title} ${s.key} ${s.category} ${s.env}`.toLowerCase().includes(ql));
        const cats = [...new Set(list.map(s => s.category))];
        box.innerHTML = cats.map(c => `<h2 class="section" style="margin-top:12px">${esc(c)}</h2><div class="list">${list.filter(s => s.category === c).map(s => `<button class="row" data-svc="${s.key}"><span class="ico ${s.oauth2 ? 'kelp' : s.key === 'custom' ? '' : 'brass'}">${icon(s.oauth2 ? 'link' : s.category === 'Database' ? 'database' : s.category === 'Communication' ? 'zap' : 'key')}</span><div class="main"><div class="title">${esc(s.title)}</div><div class="sub">${esc(s.styles.map(st => cat.styles[st]?.title || st).join(' · '))}</div></div>${icon('chevron', 'i chev')}</button>`).join('')}</div>`).join('') || '<p class="empty">Nothing matches. Pick "Custom service".</p>';
        $$('[data-svc]', box).forEach(b => b.onclick = () => { close(); credentialForm(cat.services.find(s => s.key === b.dataset.svc), cat); });
    };
    render('');
    $('#cat-q', panel).addEventListener('input', e => render(e.target.value));
}

function credentialForm(svc, cat, styleKey = null) {
    const style = styleKey || svc.styles[0];
    const def = cat.styles[style];
    const isOAuth = style === 'oauth2';
    const preset = svc.oauth2 || {};
    const redirect = `${location.origin}/oauth/callback`;
    const { panel, close } = openDialog(`<h2>${icon(isOAuth ? 'link' : 'key')}${esc(svc.title)}</h2>
        ${svc.note ? `<p class="muted">${esc(svc.note)}</p>` : ''}${svc.docs ? `<p class="muted"><a href="${esc(svc.docs)}" target="_blank" rel="noopener">Where to get it ↗</a></p>` : ''}
        ${svc.styles.length > 1 ? `<div class="field"><label>Auth style</label><div class="choices wrap" data-style>${svc.styles.map(st => `<button type="button" data-st="${st}" class="${st === style ? 'selected' : ''}">${esc(cat.styles[st]?.title || st)}</button>`).join('')}</div></div>` : ''}
        <div class="field"><label for="cf-name">Name</label><input id="cf-name" type="text" value="${esc(svc.title)}" autocorrect="off"></div>
        <div class="field"><label for="cf-prefix">Environment prefix</label><input id="cf-prefix" type="text" class="mono" value="${esc(svc.env)}" autocapitalize="characters" autocorrect="off" spellcheck="false"><p class="sub" style="margin:6px 2px 0">Variables: <span class="mono" data-envpreview></span></p></div>
        ${def.fields.filter(f => !f.derived).map(f => `<div class="field"><label for="cf-${f.name}">${esc(f.label)}${f.optional ? ' (optional)' : ''}</label>${f.multiline ? `<textarea id="cf-${f.name}" rows="4" class="mono" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${esc(f.placeholder || '')}">${f.name === 'scopes' ? esc(preset.scopes || '') : ''}</textarea>` : `<input id="cf-${f.name}" type="${f.secret ? 'password' : 'text'}" class="mono" value="${f.name === 'scopes' ? esc(preset.scopes || '') : ''}" placeholder="${esc(f.placeholder || '')}" autocapitalize="off" autocorrect="off" spellcheck="false">`}</div>`).join('')}
        ${isOAuth ? `<div class="field"><label>Redirect URL to register with ${esc(svc.title)}</label><div class="row plain" style="background:var(--sea-2);border-radius:12px;padding:10px 12px"><div class="main"><div class="title mono" style="font-size:13px;word-break:break-all;white-space:normal">${esc(redirect)}</div></div><button type="button" class="pill" data-copy-redirect>${icon('copy')}</button></div></div>
          ${svc.key === 'custom' || !preset.authUrl ? `<div class="field"><label for="cf-authUrl">Authorization URL</label><input id="cf-authUrl" type="text" class="mono" value="${esc(preset.authUrl || '')}" placeholder="https://provider/oauth/authorize"></div><div class="field"><label for="cf-tokenUrl">Access token URL</label><input id="cf-tokenUrl" type="text" class="mono" value="${esc(preset.tokenUrl || '')}" placeholder="https://provider/oauth/token"></div><div class="field"><label>Client authentication</label><div class="choices" data-cauth><button type="button" data-c="body" class="selected">Body</button><button type="button" data-c="header">Header (basic)</button></div></div><div class="field"><label>PKCE</label><div class="choices" data-pkce><button type="button" data-p="0" class="selected">Off</button><button type="button" data-p="1">On</button></div></div>` : `<p class="sub" style="margin:0 2px">Authorize: <span class="mono">${esc(preset.authUrl)}</span><br>Token: <span class="mono">${esc(preset.tokenUrl)}</span>${preset.pkce ? ' · PKCE' : ''}</p>`}` : ''}
        <div class="field"><label>Scope</label><div class="choices" data-scope><button type="button" data-s="general" class="selected">General</button><button type="button" data-s="project">One project</button></div><input id="cf-scope" type="text" class="mono" value="${esc(state.filesPath || '')}" placeholder="Projects/my-app" style="margin-top:8px" hidden autocapitalize="off" autocorrect="off" spellcheck="false"></div>
        <div class="field"><label for="cf-notes">Notes (optional)</label><input id="cf-notes" type="text" placeholder="Which account, expiry…"></div>
        <div class="buttons"><button class="primary" data-ok>${isOAuth ? 'Save and connect' : 'Save'}</button><button data-back-cat>Back to services</button><button data-close>Cancel</button></div>`);
    let scopeMode = 'general', cauth = preset.clientAuth || 'body', pkce = !!preset.pkce;
    const envPreview = () => { const p = $('#cf-prefix', panel).value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''); $('[data-envpreview]', panel).textContent = def.fields.map(f => `${p}_${f.env}`).join(', '); };
    envPreview(); $('#cf-prefix', panel).addEventListener('input', envPreview);
    $$('[data-style] button', panel).forEach(b => b.onclick = () => { close(); credentialForm(svc, cat, b.dataset.st); });
    $$('[data-scope] button', panel).forEach(b => b.onclick = () => { scopeMode = b.dataset.s; $$('[data-scope] button', panel).forEach(x => x.classList.toggle('selected', x === b)); $('#cf-scope', panel).hidden = scopeMode === 'general'; });
    $$('[data-cauth] button', panel).forEach(b => b.onclick = () => { cauth = b.dataset.c; $$('[data-cauth] button', panel).forEach(x => x.classList.toggle('selected', x === b)); });
    $$('[data-pkce] button', panel).forEach(b => b.onclick = () => { pkce = b.dataset.p === '1'; $$('[data-pkce] button', panel).forEach(x => x.classList.toggle('selected', x === b)); });
    $('[data-copy-redirect]', panel)?.addEventListener('click', () => copyText(redirect, 'Redirect URL copied'));
    $('[data-back-cat]', panel).onclick = () => { close(); catalogDialog(); };
    $('[data-ok]', panel).onclick = async () => {
        const fields = {};
        for (const f of def.fields) { if (f.derived) continue; const el = $(`#cf-${f.name}`, panel); if (el && el.value !== '') fields[f.name] = el.value; }
        const body = { provider: svc.key, style, name: $('#cf-name', panel).value, prefix: $('#cf-prefix', panel).value, scope: scopeMode === 'general' ? 'general' : $('#cf-scope', panel).value.trim(), notes: $('#cf-notes', panel).value, fields };
        if (isOAuth) body.oauth = { authUrl: $('#cf-authUrl', panel)?.value || preset.authUrl, tokenUrl: $('#cf-tokenUrl', panel)?.value || preset.tokenUrl, clientAuth: cauth, pkce };
        const btn = $('[data-ok]', panel); btn.disabled = true;
        try {
            const created = await api('/api/vault', { method: 'POST', body });
            close(); toast('Saved');
            if (isOAuth) { const r = await api(`/api/vault/${created.id}/oauth/start`, { method: 'POST' }); location.href = r.url; return; }
            loadVault();
        } catch (ex) { toast(ex.message, true); btn.disabled = false; }
    };
}

function vaultEditDialog(t) {
    const { panel, close } = openDialog(`<h2>${icon('edit')}${esc(t.name)}</h2><p class="muted">Leave a value empty to keep it.</p>
        <div class="field"><label for="ve-name">Name</label><input id="ve-name" type="text" value="${esc(t.name)}"></div>
        ${t.fields.filter(f => !['accessToken', 'refreshToken'].includes(f.name)).map(f => `<div class="field"><label for="ve-${f.name}">${esc(f.label)} <span class="mono" style="text-transform:none;letter-spacing:0">${esc(f.env)}</span></label><input id="ve-${f.name}" type="${f.secret ? 'password' : 'text'}" class="mono" placeholder="${f.secret ? esc(f.hint) : esc(f.hint || '')}" autocapitalize="off" autocorrect="off" spellcheck="false"></div>`).join('')}
        <div class="field"><label>Scope</label><div class="choices" data-scope><button type="button" data-s="general" class="${t.scope === 'general' ? 'selected' : ''}">General</button><button type="button" data-s="project" class="${t.scope !== 'general' ? 'selected' : ''}">One project</button></div><input id="ve-scope" type="text" class="mono" value="${esc(t.scope === 'general' ? (state.filesPath || '') : t.scope)}" style="margin-top:8px" ${t.scope === 'general' ? 'hidden' : ''}></div>
        <div class="field"><label for="ve-notes">Notes</label><input id="ve-notes" type="text" value="${esc(t.notes || '')}"></div>
        <div class="buttons"><button class="primary" data-ok>Save</button><button data-close>Cancel</button></div>`);
    let scopeMode = t.scope === 'general' ? 'general' : 'project';
    $$('[data-scope] button', panel).forEach(b => b.onclick = () => { scopeMode = b.dataset.s; $$('[data-scope] button', panel).forEach(x => x.classList.toggle('selected', x === b)); $('#ve-scope', panel).hidden = scopeMode === 'general'; });
    $('[data-ok]', panel).onclick = async () => {
        const fields = {}; for (const f of t.fields) { const el = $(`#ve-${f.name}`, panel); if (el && el.value) fields[f.name] = el.value; }
        try { await api(`/api/vault/${t.id}`, { method: 'PUT', body: { name: $('#ve-name', panel).value, notes: $('#ve-notes', panel).value, scope: scopeMode === 'general' ? 'general' : $('#ve-scope', panel).value.trim(), fields } }); close(); toast('Saved'); loadVault(); }
        catch (ex) { toast(ex.message, true); }
    };
}
// Kept for the GitHub page shortcut (legacy single-value form).
function vaultDialog(preset) { credentialFormFromLegacy(preset); }
async function credentialFormFromLegacy(preset) {
    const cat = await getCatalog().catch(() => null); if (!cat) return;
    const svc = cat.services.find(s => s.key === (preset?.provider || 'custom')) || cat.services.find(s => s.key === 'custom');
    credentialForm(svc, cat, svc.styles.includes('token') ? 'token' : svc.styles[0]);
}

// ---------- security ----------

async function loadSecurity() {
    const s = await api('/api/security');
    const canPasskey = !!(WA && WA.browserSupportsWebAuthn() && window.isSecureContext);
    $('#security-body').innerHTML = `
        <div class="row"><span class="ico ${s.totp ? 'kelp' : 'flare'}">${icon('shield')}</span><div class="main"><div class="title">Two-step code at sign-in</div><div class="sub">${s.totp ? 'On — a 6-digit code is required after your passkey or password' : 'Off — turn this on; it is your second lock'}</div></div></div>
        <button class="row plain" data-totp><span class="ico">${icon(s.totp ? 'x' : 'check')}</span><div class="main"><div class="title" style="color:${s.totp ? 'var(--flare)' : 'var(--brass)'}">${s.totp ? 'Turn two-step codes off' : 'Turn two-step codes on'}</div></div></button>
        ${s.passkeys.map(p => `<div class="row"><span class="ico kelp">${icon('key')}</span><div class="main"><div class="title">${esc(p.name)}</div><div class="sub">passkey · added ${fmtAgo(p.created)}${p.lastUsed ? ` · used ${fmtAgo(p.lastUsed)}` : ''}</div></div><button class="more" data-pk="${esc(p.id)}" aria-label="Passkey actions">${icon('more_h')}</button></div>`).join('')}
        <button class="row plain" data-add-passkey ${canPasskey ? '' : 'disabled'}><span class="ico brass">${icon('plus')}</span><div class="main"><div class="title" style="color:var(--brass)">Add a passkey for this device</div><div class="sub">${canPasskey ? 'Face ID / Touch ID / security key' : 'Needs https or localhost'}</div></div></button>
        <div class="row"><span class="ico ${s.passwordSet ? 'brass' : 'dim'}">${icon('lock')}</span><div class="main"><div class="title">Password</div><div class="sub">${s.passwordSet ? 'Set — alternative to a passkey' : 'Not set'}</div></div><button class="pill" data-password>${s.passwordSet ? 'Change' : 'Set'}</button></div>
        <div class="row plain"><span class="ico">${icon('remote')}</span><div class="main"><div class="title">Signed-in devices</div></div><div class="kv">${s.sessions}</div>${s.sessions > 1 ? `<button class="pill danger" data-revoke>Sign out others</button>` : ''}</div>`;
    const body = $('#security-body');
    $('[data-revoke]', body)?.addEventListener('click', async () => { try { const r = await api('/api/security/sessions/revoke-others', { method: 'POST' }); toast(`Signed out ${r.revoked} other device${r.revoked === 1 ? '' : 's'}`); loadSecurity(); } catch (ex) { toast(ex.message, true); } });
    $('[data-totp]', body).onclick = () => (s.totp ? totpDisableDialog() : totpEnableDialog());
    $('[data-add-passkey]', body).onclick = addPasskeyDialog;
    $('[data-password]', body).onclick = () => passwordDialog(s.passwordSet);
    $$('[data-pk]', body).forEach(b => b.onclick = () => passkeyMenu(s.passkeys.find(p => p.id === b.dataset.pk)));
}
function addPasskeyDialog() {
    const { panel, close } = openDialog(`<h2>${icon('key')}Add a passkey</h2><p class="muted">Name the device so you can recognise it later.</p>
        <div class="field"><input id="pk-name" type="text" placeholder="Seb's iPad" autocorrect="off"></div>
        <div class="buttons"><button class="primary" data-ok>Create passkey</button><button data-close>Cancel</button></div>`);
    const go_ = async () => {
        const name = $('#pk-name', panel).value.trim() || 'Device';
        try { const options = await api('/api/security/passkey/options', { method: 'POST', body: { name } }); const response = await WA.startRegistration({ optionsJSON: options }); await api('/api/security/passkey/verify', { method: 'POST', body: { response } }); close(); toast('Passkey added'); loadSecurity(); }
        catch (ex) { toast(ex.name === 'NotAllowedError' ? 'Passkey prompt was cancelled.' : ex.message, true); }
    };
    $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
}
function passkeyMenu(p) {
    if (!p) return;
    const { panel, close } = openDialog(`<h2>${esc(p.name)}</h2><p class="muted">Added ${fmtAgo(p.created)}${p.transports?.length ? ' · ' + esc(p.transports.join(', ')) : ''}</p>
        <div class="menu"><button data-a="rename">${icon('edit')}Rename</button><button data-a="remove" class="danger">${icon('trash')}Remove passkey</button></div>`);
    $$('[data-a]', panel).forEach(b => b.onclick = async () => {
        close();
        if (b.dataset.a === 'rename') {
            const d = openDialog(`<h2>Rename passkey</h2><div class="field"><input id="pk-rn" type="text" value="${esc(p.name)}"></div><div class="buttons"><button class="primary" data-ok>Save</button><button data-close>Cancel</button></div>`);
            const go_ = async () => { try { await api(`/api/security/passkey/${encodeURIComponent(p.id)}`, { method: 'PUT', body: { name: $('#pk-rn', d.panel).value } }); d.close(); loadSecurity(); } catch (ex) { toast(ex.message, true); } };
            $('[data-ok]', d.panel).onclick = go_; enterSubmits(d.panel, go_);
        }
        if (b.dataset.a === 'remove') {
            if (!(await confirmDialog({ title: `Remove "${p.name}"?`, text: 'That device will no longer be able to sign in with its passkey.', action: 'Remove' }))) return;
            try { await api(`/api/security/passkey/${encodeURIComponent(p.id)}`, { method: 'DELETE' }); toast('Passkey removed'); loadSecurity(); } catch (ex) { toast(ex.message, true); }
        }
    });
}
function passwordDialog(isSet) {
    const { panel, close } = openDialog(`<h2>${icon('lock')}${isSet ? 'Change password' : 'Set a password'}</h2><p class="muted">At least 12 characters. A passkey is still the better way in; the password is the fallback for places passkeys don't work.</p>
        ${isSet ? `<div class="field"><input id="pw-cur" type="password" autocomplete="current-password" placeholder="Current password"></div>` : ''}
        <div class="field"><input id="pw-new" type="password" autocomplete="new-password" placeholder="New password"></div>
        <div class="field"><input id="pw-new2" type="password" autocomplete="new-password" placeholder="Repeat new password"></div>
        <div class="buttons"><button class="primary" data-ok>Save</button>${isSet ? '<button class="danger" data-remove>Remove password</button>' : ''}<button data-close>Cancel</button></div>`);
    const go_ = async () => {
        const a = $('#pw-new', panel).value, b = $('#pw-new2', panel).value;
        if (a !== b) return toast('Passwords do not match.', true);
        try { await api('/api/security/password', { method: 'POST', body: { current: $('#pw-cur', panel)?.value, password: a } }); close(); toast('Password saved'); loadSecurity(); } catch (ex) { toast(ex.message, true); }
    };
    $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
    $('[data-remove]', panel)?.addEventListener('click', async () => {
        try { await api('/api/security/password', { method: 'DELETE', body: { current: $('#pw-cur', panel)?.value } }); close(); toast('Password removed'); loadSecurity(); } catch (ex) { toast(ex.message, true); }
    });
}
async function totpEnableDialog() {
    let setup;
    try { setup = await api('/api/security/totp/setup', { method: 'POST' }); } catch (ex) { return toast(ex.message, true); }
    const { panel, close } = openDialog(`
        <h2>${icon('shield')}Two-step codes</h2>
        <p class="muted">Add this account to your authenticator (iOS Passwords, Google Authenticator, 1Password…) and enter the code it shows.</p>
        <a class="primary" style="display:block;text-decoration:none" href="${esc(setup.otpauth)}">Add to authenticator on this phone</a>
        <img class="qr" alt="QR code for authenticator" src="${qrDataUrl(setup.otpauth)}">
        <p class="muted" style="text-align:center">or enter the key manually:<br><span class="mono" style="user-select:all;color:var(--foam)">${esc(setup.secret.match(/.{1,4}/g).join(' '))}</span></p>
        <div class="field"><input id="totp-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code"></div>
        <div class="buttons"><button class="primary" data-ok>Turn on</button><button data-close>Cancel</button></div>`);
    const go_ = async () => { try { await api('/api/security/totp/enable', { method: 'POST', body: { code: $('#totp-code', panel).value } }); close(); toast('Two-step codes are on'); loadSecurity(); } catch (ex) { toast(ex.message, true); } };
    $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
}
function totpDisableDialog() {
    const { panel, close } = openDialog(`<h2>Turn two-step codes off?</h2><p class="muted">Only the login token will protect the box afterwards. Enter a current code to confirm.</p>
        <div class="field"><input id="totp-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code"></div>
        <div class="buttons"><button class="danger" data-ok>Turn off</button><button data-close>Cancel</button></div>`);
    const go_ = async () => { try { await api('/api/security/totp/disable', { method: 'POST', body: { code: $('#totp-code', panel).value } }); close(); toast('Two-step codes are off'); loadSecurity(); } catch (ex) { toast(ex.message, true); } };
    $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
}

// Minimal QR encoder (byte mode, EC level L, versions 1–10) → SVG data URL. Enough for otpauth URLs.
function qrDataUrl(text) {
    const M = qrEncode(text); if (!M) return '';
    const n = M.length, cell = 4, pad = 4 * cell, size = n * cell + pad * 2;
    let rects = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (M[y][x]) rects += `<rect x="${pad + x * cell}" y="${pad + y * cell}" width="${cell}" height="${cell}"/>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g></svg>`);
}
function qrEncode(text) {
    const data = new TextEncoder().encode(text);
    const V = [[17, 26, 7, 1], [32, 44, 10, 1], [53, 70, 15, 1], [78, 100, 20, 1], [106, 134, 26, 1], [134, 172, 18, 2], [154, 196, 20, 2], [192, 242, 24, 2], [230, 292, 30, 2], [271, 346, 18, 4]];
    let ver = V.findIndex(v => data.length <= v[0]); if (ver < 0) return null;
    const [, total, ecLen, blocks] = V[ver]; ver += 1;
    const n = ver * 4 + 17, bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(4, 4); push(data.length, ver < 10 ? 8 : 16); for (const b of data) push(b, 8);
    const dataLen = total - ecLen * blocks;
    push(0, Math.min(4, dataLen * 8 - bits.length)); while (bits.length % 8) bits.push(0);
    const cw = []; for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let p = 0; cw.length < dataLen; p++) cw.push(p % 2 ? 0x11 : 0xec);
    const EXP = new Array(512), LOG = new Array(256);
    for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
    const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
    let gen = [1];
    for (let i = 0; i < ecLen; i++) { const nx = new Array(gen.length + 1).fill(0); for (let j = 0; j < gen.length; j++) { nx[j] ^= gen[j]; nx[j + 1] ^= mul(gen[j], EXP[i]); } gen = nx; }
    const rs = block => { const r = block.concat(new Array(ecLen).fill(0)); for (let i = 0; i < block.length; i++) { const c = r[i]; if (c) for (let j = 0; j < gen.length; j++) r[i + j] ^= mul(gen[j], c); } return r.slice(block.length); };
    const per = Math.floor(dataLen / blocks), dB = [], eB = [];
    for (let b = 0; b < blocks; b++) { const d = cw.slice(b * per, (b + 1) * per); dB.push(d); eB.push(rs(d)); }
    const seq = []; for (let i = 0; i < per; i++) for (const d of dB) seq.push(d[i]); for (let i = 0; i < ecLen; i++) for (const e of eB) seq.push(e[i]);
    const M = Array.from({ length: n }, () => new Array(n).fill(null));
    const setF = (r, c, v) => { if (r >= 0 && r < n && c >= 0 && c < n) M[r][c] = v; };
    const finder = (r, c) => { for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) { const on = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6 && (dy === 0 || dy === 6 || dx === 0 || dx === 6 || (dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4)); setF(r + dy, c + dx, on ? 1 : 0); } };
    finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
    for (let i = 8; i < n - 8; i++) { M[6][i] = i % 2 === 0 ? 1 : 0; M[i][6] = i % 2 === 0 ? 1 : 0; }
    const AP = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]][ver] || [];
    for (const r of AP) for (const c of AP) { if (M[r][c] !== null) continue; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) M[r + dy][c + dx] = Math.max(Math.abs(dy), Math.abs(dx)) !== 1 ? 1 : 0; }
    for (let i = 0; i < 9; i++) { if (M[8][i] === null) M[8][i] = 0; if (M[i][8] === null) M[i][8] = 0; }
    for (let i = 0; i < 8; i++) { if (M[8][n - 1 - i] === null) M[8][n - 1 - i] = 0; if (M[n - 1 - i][8] === null) M[n - 1 - i][8] = 0; }
    M[n - 8][8] = 1;
    if (ver >= 7) { const VI = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 }[ver]; for (let i = 0; i < 18; i++) { const b = (VI >>> i) & 1; M[Math.floor(i / 3)][n - 11 + (i % 3)] = b; M[n - 11 + (i % 3)][Math.floor(i / 3)] = b; } }
    let bi = 0, up = true;
    const all = seq.flatMap(b => [7, 6, 5, 4, 3, 2, 1, 0].map(i => (b >>> i) & 1));
    for (let c = n - 1; c > 0; c -= 2) { if (c === 6) c--; for (let k = 0; k < n; k++) { const r = up ? n - 1 - k : k; for (const cc of [c, c - 1]) { if (M[r][cc] !== null) continue; let v = bi < all.length ? all[bi++] : 0; if ((r + cc) % 2 === 0) v ^= 1; M[r][cc] = v; } } up = !up; }
    const fmt = 0x77c4;
    for (let i = 0; i < 15; i++) { const b = (fmt >>> i) & 1; if (i < 6) M[i][8] = b; else if (i < 8) M[i + 1][8] = b; else M[n - 15 + i][8] = b; if (i < 8) M[8][n - 1 - i] = b; else if (i < 9) M[8][15 - i] = b; else M[8][14 - i] = b; }
    return M;
}

// ---------- boot ----------

(async () => {
    try { await api('/api/me'); await showApp(); } catch { showLogin(); }
})();
