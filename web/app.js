// PlatOpypus v3 front end. Plain ES module, no build step.
// Tabs: Home · Shells · Services · Files · More (+ pushed pages: Vault, Security, Claude). Sheets: terminal, editor.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ASSET_V = document.querySelector('meta[name="porthole-version"]')?.content || '0';
const icon = (name, cls = 'i') => `<svg class="${cls}"><use href="/sprite.svg?v=${ASSET_V}#i-${name}"/></svg>`;

// ---------- API ----------

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function api(path, { method = 'GET', body, raw = false } = {}) {
    const headers = { 'X-Plato': '1' };
    if (body !== undefined && !(body instanceof Blob)) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body), credentials: 'same-origin' });
    noteServerVersion(res.headers.get('x-plato-version') || res.headers.get('x-porthole-version'));
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
    el.innerHTML = `PlatOpypus was updated to ${esc(v)} · <button class="linkish" id="toast-reload">Reload</button>`;
    el.classList.remove('bad'); el.hidden = false; clearTimeout(toastTimer);
    $('#toast-reload').onclick = () => location.reload();
}

function timeAgo(t) { const d = Math.max(0, Date.now() - t); if (d < 60e3) return 'just now'; if (d < 3600e3) return `${Math.round(d / 60e3)} min ago`; if (d < 86400e3) return `${Math.round(d / 3600e3)} h ago`; return `${Math.round(d / 86400e3)} d ago`; }

// Root requests from agent-user shells: a banner while any are waiting; tap to decide.
let elevSeen = new Set();
async function pollElevation() {
    if (document.hidden || $('#app')?.hidden) return;
    let list; try { list = await api('/api/elevate/pending'); } catch { return; }
    let bar = $('#elev-bar');
    if (!list.length) { if (bar) bar.remove(); return; }
    if (!bar) { bar = document.createElement('button'); bar.id = 'elev-bar'; bar.className = 'elev-bar'; document.body.appendChild(bar); }
    bar.innerHTML = `${icon('shield')}<span><b>${esc(list[0].shell)}</b> asks to run as root${list.length > 1 ? ` · +${list.length - 1} more` : ''}</span>`;
    bar.onclick = () => elevationDialog(list[0]);
    if (!elevSeen.has(list[0].id)) { elevSeen.add(list[0].id); try { navigator.vibrate?.(60); } catch { /* ignore */ } }
}
setInterval(pollElevation, 3000);
function elevationDialog(r) {
    const { panel, close } = openDialog(`<h2>${icon('shield')}Run as root?</h2>
        <p class="muted"><b>${esc(r.shell)}</b> · in <span class="mono">${esc(r.cwd)}</span>${r.reason ? `<br>${esc(r.reason)}` : ''}</p>
        <pre style="white-space:pre-wrap;max-height:30vh">${esc(r.cmd)}</pre>
        <p class="sub">Runs once as root in that folder, 10-minute limit. Output goes back to the agent.</p>
        <div class="buttons"><button class="primary" data-allow>Allow once</button><button data-grant>Allow this shell for 30 min</button><button class="danger" data-deny>Deny</button></div>`);
    const decide = async (verb, minutes = 0) => { try { await api(`/api/elevate/${r.id}/${verb}`, { method: 'POST', body: { minutes } }); toast(verb === 'deny' ? 'Denied' : minutes ? 'Allowed · shell elevated for 30 min' : 'Allowed'); } catch (ex) { toast(ex.message, true); } close(); pollElevation(); };
    $('[data-allow]', panel).onclick = () => decide('allow');
    $('[data-grant]', panel).onclick = () => decide('allow', 30);
    $('[data-deny]', panel).onclick = () => decide('deny');
}

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

function openDialog(html, { size = null } = {}) {
    const dlg = $('#dialog'), panel = $('.dialog-panel', dlg);
    panel.innerHTML = html; dlg.hidden = false; dlg.classList.toggle('small', size === 'small');
    forgetSheet();
    const close = () => { dlg.hidden = true; panel.innerHTML = ''; forgetSheet(); };
    $('.dialog-backdrop', dlg).onclick = close;
    $$('[data-close]', panel).forEach(b => (b.onclick = close));
    const first = $('input, textarea', panel);
    if (first) setTimeout(() => first.focus(), 60);
    return { panel, close };
}
function confirmDialog({ title, text, action, danger = true }) {
    return new Promise(resolve => {
        const { panel, close } = openDialog(`<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p><div class="buttons"><button class="${danger ? 'danger' : 'primary'}" data-ok>${esc(action)}</button><button data-close>Cancel</button></div>`, { size: 'small' });
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
async function showApp() { $('#login').hidden = true; $('#app').hidden = false; go(state.tab); resumeSheet(); }

async function postAuth(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Plato': '1' }, body: JSON.stringify(body || {}), credentials: 'same-origin' });
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
    tab: (t => (t === 'research' ? 'apps' : t))(localStorage.getItem('porthole.tab') || 'home'),
    filesPath: localStorage.getItem('porthole.path'),   // null until a folder is chosen → Files opens at home
    servicesFilter: 'projects',
    shells: [],
    expanded: null,
};

$$('.tabs [data-go]').forEach(b => b.addEventListener('click', () => { if (leaveSheets()) return; navOverlay(false); go(b.dataset.go); }));
$$('.tabs [data-nav-page]').forEach(b => b.addEventListener('click', () => { if (leaveSheets()) return; navOverlay(false); go('more'); push(b.dataset.navPage); }));
function go(tab) {
    state.tab = tab; localStorage.setItem('porthole.tab', tab);
    $$('.tabs [data-go]').forEach(b => b.classList.toggle('active', b.dataset.go === tab));
    $$('.tabs [data-nav-page]').forEach(b => b.classList.remove('active'));
    $$('.tab:not(.page)').forEach(t => (t.hidden = t.dataset.tab !== tab));
    $$('.tab.page').forEach(p => (p.hidden = true));
    refresh();
}
function push(page) {
    $$('.tab.page').forEach(p => (p.hidden = p.id !== `page-${page}`));
    $$('.tabs [data-nav-page]').forEach(b => b.classList.toggle('active', b.dataset.navPage === page));
    if (page === 'vault') loadVault().catch(e => toast(e.message, true));
    if (page === 'creds') loadCredsPage().catch(e => toast(e.message, true));
    if (page === 'security') loadSecurity().catch(e => toast(e.message, true));
    if (page === 'audit') loadAudit().catch(e => toast(e.message, true));
    if (page === 'alerts') loadAlerts().catch(e => toast(e.message, true));
    if (page === 'backups') loadBackups().catch(e => toast(e.message, true));
    if (page === 'research') loadResearch().catch(e => toast(e.message, true));
    if (page === 'lab') loadLab().catch(e => toast(e.message, true));
    if (page === 'agents') loadAgents().catch(e => toast(e.message, true));
    if (page === 'github') loadGithub().catch(e => toast(e.message, true));
}
$$('[data-back]').forEach(b => b.addEventListener('click', () => { $$('.tab.page').forEach(p => (p.hidden = true)); $$('.tabs [data-nav-page]').forEach(x => x.classList.remove('active')); refresh(); }));

// ---------- desktop layout ----------
// Phone: bottom tabs. Tablet (720+): an icon rail; the hamburger opens it as a drawer with labels. Desktop (1024+):
// a full sidebar with the More pages and the open shells; the hamburger collapses it to the rail (remembered).
const wideMq = matchMedia('(min-width: 1024px)'), railMq = matchMedia('(min-width: 720px)');
const isWide = () => wideMq.matches;
document.body.classList.toggle('rail', localStorage.getItem('porthole.rail') === '1');
document.body.classList.toggle('keys-on', localStorage.getItem('porthole.keys') === '1');
const relayout = () => setTimeout(() => window.dispatchEvent(new Event('resize')), 230);   // the terminal refits
function syncNav() { document.body.classList.toggle('nav-expanded', (isWide() && !document.body.classList.contains('rail')) || document.body.classList.contains('navopen')); }
function navOverlay(open) {
    document.body.classList.toggle('navopen', !!open); syncNav();
    $('#nav-backdrop').hidden = !open;
    $('#nav-burger').setAttribute('aria-expanded', String(isWide() ? !document.body.classList.contains('rail') : !!open));
}
$('#nav-burger').addEventListener('click', () => {
    if (isWide()) { const r = !document.body.classList.contains('rail'); document.body.classList.toggle('rail', r); localStorage.setItem('porthole.rail', r ? '1' : '0'); $('#nav-burger').setAttribute('aria-expanded', String(!r)); syncNav(); relayout(); }
    else navOverlay(!document.body.classList.contains('navopen'));
});
$('#nav-backdrop').addEventListener('click', () => navOverlay(false));
syncNav();
wideMq.addEventListener('change', () => { navOverlay(false); relayout(); });
railMq.addEventListener('change', relayout);
$('#nav-shell-new').addEventListener('click', () => { navOverlay(false); newShellDialog(state.filesPath || projectsRel()); });
// Leaving the terminal or editor when the sidebar is used. Returns true when navigation should wait (unsaved edits).
function leaveSheets() {
    if (!editorSheet.hidden) { $('#editor-back').click(); return !editorSheet.hidden; }
    if (!termSheet.hidden) closeTerminal();
    return false;
}
// Open shells in the sidebar: one click to switch, the current one marked.
function renderNavShells(list) {
    const wrap = $('#nav-shells-wrap'); if (!wrap) return;
    wrap.hidden = !list.length;
    const cur = termSheet.hidden ? null : termName;
    $('#nav-shells').innerHTML = list.map(x => `<button data-nav-shell="${esc(x.name)}" class="${x.name === cur ? 'active' : ''}" title="${esc(x.name)} · ${esc(shortPath(x.cwd))}"><span class="dot ${x.name === cur || x.attached ? 'live' : ''}"></span><span>${esc(x.name)}</span></button>`).join('');
    $$('#nav-shells [data-nav-shell]').forEach(b => b.onclick = () => { navOverlay(false); if (!editorSheet.hidden && leaveSheets()) return; if (b.dataset.navShell !== termName || termSheet.hidden) openTerminal(b.dataset.navShell, state.tab === 'home' ? 'Home' : 'Shells'); });
}
setInterval(() => { if (railMq.matches && !$('#app').hidden && document.visibilityState === 'visible') api('/api/shells').then(renderNavShells).catch(() => {}); }, 20_000);
$('#term-keys-toggle').addEventListener('click', () => { const on = !document.body.classList.contains('keys-on'); document.body.classList.toggle('keys-on', on); localStorage.setItem('porthole.keys', on ? '1' : '0'); $('#term-keys-toggle').setAttribute('aria-pressed', String(on)); relayout(); });
$('#term-keys-toggle').setAttribute('aria-pressed', String(document.body.classList.contains('keys-on')));
// Escape closes a dialog or the drawer menu (keyboards).
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#dialog').hidden) { $('#dialog .dialog-backdrop').click(); e.preventDefault(); }
    else if (document.body.classList.contains('navopen')) navOverlay(false);
});
$$('[data-page]').forEach(b => b.addEventListener('click', () => push(b.dataset.page)));

async function refresh() {
    if ($('#app').hidden) return;
    try {
        if (state.tab === 'home') await loadHome();
        else if (state.tab === 'shells') await loadShells();
        else if (state.tab === 'services') await loadServices();
        else if (state.tab === 'files') await loadFiles(state.filesPath ?? null);
        else if (state.tab === 'apps') await loadApps();
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
    loadHomeRunning().catch(() => {});
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

    const list = h.projects.filter(p => p !== active && !p.running?.length);
    $('#home-projects').innerHTML = list.map(p => {
        const ag = p.shells.find(s => s.kind === 'agent');
        const shellsPart = ag ? `${esc(agentTitle(ag.agent))} working` : p.shells.length ? `${p.shells.length} shell${p.shells.length > 1 ? 's' : ''} open` : '';
        const status = p.running?.length ? `${runningLine(p.running)}${shellsPart ? ` · ${shellsPart}` : ''}` : ag ? `<span class="live">● ${esc(agentTitle(ag.agent))} running</span>` : shellsPart || 'nothing running';
        return `<button class="row" data-folder="${esc(p.path)}"><span class="ico ${p.running?.length ? 'kelp' : 'brass'}">${icon(p.running?.length ? 'play' : 'folder')}</span><div class="main"><div class="title">${esc(p.name)}${p.repo && p.repo !== 'local' ? `<span class="tag ${p.repo === 'public' ? 'brass' : 'dim'}">${icon(p.repo === 'public' ? 'globe' : 'lock')}${p.repo}</span>` : ''}</div><div class="sub">${status} · ${fmtAgo(p.modified)}</div></div>${icon('chevron', 'i chev')}</button>`;
    }).join('') + `<button class="row" data-new-project><span class="ico">${icon('folder-plus')}</span><div class="main"><div class="title" style="color:var(--brass)">New project</div></div></button>`;
    $$('#home-projects [data-folder]').forEach(b => b.onclick = () => { state.filesPath = b.dataset.folder; go('files'); });
    $('[data-new-project]').onclick = newProjectDialog;
}
$('#home-all-folders').addEventListener('click', () => { state.filesPath = ''; go('files'); });
const projectsRel = () => 'Projects'; // one projects folder: <files root>/Projects (same as the server's projectsDir)
$('#home-new').addEventListener('click', () => newShellDialog(state.filesPath || projectsRel()));
$$('#tab-home .tile').forEach(t => t.addEventListener('click', async () => {
    const act = t.dataset.act;
    if (act === 'agent') return newShellDialog(state.filesPath || projectsRel(), 'agent');
    if (act === 'apps') return go('apps');
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

// Stat bubble: resident+swapped memory and CPU (% of one core) of a shell, server or container. Amber past 400 MB
// or 60 %, red past 900 MB; the box line on the Shells tab says how much is left.
let usageSeen = { shells: {}, servers: {}, containers: {}, box: null };
async function loadUsage() { try { usageSeen = await api('/api/usage'); } catch { /* keep the last */ } return usageSeen; }
function useBubble(u) {
    if (!u) return '';
    const hot = u.mem >= 900 ? 'flare' : (u.mem >= 400 || u.cpu >= 60) ? 'brass' : '';
    return `<span class="tag use ${hot}" title="memory incl. swap · CPU">${u.mem >= 1024 ? (u.mem / 1024).toFixed(1) + ' GB' : u.mem + ' MB'}${u.cpu ? ` · ${u.cpu}%` : ''}</span>`;
}
const liveSlug = (project, key) => `live ${project} ${key}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
function boxLine(b) {
    if (!b) return '';
    const swap = b.swapTotal ? ` · swap ${b.swapUsed >= 1024 ? (b.swapUsed / 1024).toFixed(1) + ' GB' : b.swapUsed + ' MB'} of ${(b.swapTotal / 1024).toFixed(0)} GB` : '';
    const tight = b.memUsed / b.memTotal > 0.9 || (b.swapTotal && b.swapUsed / b.swapTotal > 0.8) || b.load[0] > b.cpus * 2;
    return `<p class="sub boxline ${tight ? 'warn' : ''}">${tight ? 'The box is short of memory: ' : ''}${(b.memUsed / 1024).toFixed(1)} of ${(b.memTotal / 1024).toFixed(1)} GB used${swap} · load ${b.load[0]} on ${b.cpus} vCPU</p>`;
}
async function loadShells() {
    const [shells] = await Promise.all([api('/api/shells'), loadUsage()]);
    state.shells = shells; renderNavShells(shells);
    $('#shell-empty').hidden = shells.length > 0;
    const groups = new Map();
    for (const s of shells) { const k = s.cwd; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    $('#shell-groups').innerHTML = boxLine(usageSeen.box) + [...groups.entries()].map(([cwd, list]) => `<div class="shell-group">
        <div class="group-title">${icon('folder')}${esc(shortPath(cwd))}</div>
        <div class="list">${list.map(shellRow).join('')}</div></div>`).join('');
    $$('#shell-groups .shell-row').forEach(row => row.addEventListener('click', () => openTerminal(row.dataset.name, 'Shells')));
}
function shellRow(s) {
    return `<button class="shell-row" data-name="${esc(s.name)}">
        <div class="shell-head"><span class="dot ${s.attached ? 'live' : ''}"></span><span class="name">${esc(s.name)}</span>${useBubble(usageSeen.shells[s.name])}${s.kind === 'agent' ? `<span class="tag brass">${esc(agentTitle(s.agent))}${s.profile && s.profile !== 'default' ? ' · ' + esc(s.profile) : ''}</span>${s.yolo ? '<span class="tag dim">auto</span>' : ''}${s.scratch ? '<span class="tag dim">scratch</span>' : ''}` : `<span class="tag dim">${s.kind === 'remote-control' ? 'Remote Control' : 'shell'}</span>${s.scratch ? '<span class="tag dim">scratch</span>' : ''}`}${s.runAs === 'agent' ? '<span class="tag">agent user</span>' : s.kind === 'agent' ? '<span class="tag dim" style="color:var(--flare)">root</span>' : ''}${s.security ? `<span class="tag dim">${esc(s.security === 'control' ? 'control' : s.security.replace('-', ' · '))}</span>` : ''}</div>
        ${s.preview?.length ? `<pre class="shell-preview">${esc(s.preview.join('\n'))}</pre>` : ''}
      </button>`;
}
$('#shell-new').addEventListener('click', () => newShellDialog(state.filesPath || projectsRel()));
// Home → "I wish for:": a spec becomes the agent's first message, in a new project folder named after it.
$('#home-wish').addEventListener('submit', e => {
    e.preventDefault();
    const text = $('#wish-text').value.trim(); if (!text) return $('#wish-text').focus();
    const stop = new Set(['a', 'an', 'the', 'i', 'me', 'my', 'that', 'which', 'with', 'for', 'to', 'of', 'and', 'from', 'shows', 'show', 'app', 'want', 'wish']);
    const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w && !stop.has(w)).slice(0, 3);
    const slug = (words.join('-') || `project-${Date.now().toString(36).slice(-4)}`).slice(0, 30);
    newShellDialog(`${projectsRel()}/${slug}`, 'agent', slug, { firstPrompt: text, newFolder: true });
});
$('#wish-text').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#home-wish').requestSubmit(); } });
// Temp: "do this now" — a scratch folder, no root, no questions; the folder goes when the shell ends.
let tempMode = localStorage.getItem('porthole.tempMode') === 'once' ? 'once' : 'session';
const tempLabel = () => { $('#wish-now-label').textContent = tempMode === 'once' ? 'Once' : 'Temp'; };
tempLabel();
$('#wish-now-menu').addEventListener('click', () => {
    const { panel, close } = openDialog(`<h2>${icon('history')}Temp</h2>
        <div class="menu">
          <button data-m="session" class="${tempMode === 'session' ? 'selected' : ''}">${icon('terminal')}<span>Temp session<br><span class="sub">scratch folder, no root; stays open so you can keep talking · folder goes when you end it</span></span></button>
          <button data-m="once" class="${tempMode === 'once' ? 'selected' : ''}">${icon('zap')}<span>One-shot<br><span class="sub">runs your message once (auto-approved, no root), shows the answer, then the shell and folder are destroyed · Claude Code or Codex</span></span></button>
          <button data-m="results">${icon('logs')}<span>One-shot results<br><span class="sub">answers from finished one-shot runs</span></span></button>
        </div><div class="buttons"><button data-close>Close</button></div>`);
    $$('[data-m]', panel).forEach(b => b.onclick = async () => {
        if (b.dataset.m === 'results') { close(); return oneshotResultsDialog(); }
        tempMode = b.dataset.m; localStorage.setItem('porthole.tempMode', tempMode); tempLabel(); close();
    });
});
async function oneshotResultsDialog() {
    const list = await api('/api/oneshot').catch(() => []);
    const { panel } = openDialog(`<h2>${icon('logs')}One-shot results</h2>${list.length ? `<div class="list">${list.map((r, i) => `<button class="row" data-r="${i}"><span class="ico brass">${icon('zap')}</span><div class="main"><div class="title">${esc((r.prompt || '').split('\n')[0].slice(0, 70))}</div><div class="sub">${esc(agentTitle(r.agent))} · ${fmtAgo(r.finished)}</div></div>${icon('chevron', 'i chev')}</button>`).join('')}</div>` : '<p class="empty">No one-shot runs yet.</p>'}<div class="buttons"><button data-close>Close</button></div>`);
    $$('[data-r]', panel).forEach(b => b.onclick = () => { const r = list[Number(b.dataset.r)]; const d = openDialog(`<h2>${esc((r.prompt || '').split('\n')[0].slice(0, 60))}</h2><pre style="max-height:60vh;white-space:pre-wrap">${esc(r.output || '(no output)')}</pre><div class="buttons"><button data-copy-all>${icon('copy')}Copy</button><button data-back>Back</button></div>`); $('[data-copy-all]', d.panel).onclick = () => copyText(r.output || '', 'Copied'); $('[data-back]', d.panel).onclick = () => oneshotResultsDialog(); });
}
$('#wish-now').addEventListener('click', async () => {
    const text = $('#wish-text').value.trim(); if (!text) return $('#wish-text').focus();
    const once = tempMode === 'once';
    const name = `${once ? 'once' : 'temp'}-${Math.random().toString(36).slice(2, 6)}`;
    const au = await api('/api/agent-user').catch(() => ({ available: false }));
    const btn = $('#wish-now'); btn.disabled = true;
    try {
        let agentKey = localStorage.getItem('porthole.agent') || 'claude'; if (once && !['claude', 'codex', 'cline'].includes(agentKey)) agentKey = 'claude';
        const note = once ? 'one-shot run in a scratch folder; it is destroyed when you finish, so answer fully in your final message' : 'temporary session in a scratch folder that is deleted when this shell ends';
        await api('/api/shells', { method: 'POST', body: { name, kind: 'agent', agent: agentKey, scratch: true, oneshot: once, runAs: au.available ? 'agent' : 'root', session: 'project', firstPrompt: `${text}\n\n(From PlatOpypus: ${note}. Just do it; keep anything worth keeping out of this folder.)` } });
        $('#wish-text').value = ''; openTerminal(name, 'Home');
    } catch (ex) { toast(ex.message, true); }
    btn.disabled = false;
});

const AGENT_TITLES = { claude: 'Claude Code', codex: 'Codex CLI', antigravity: 'Antigravity CLI', cline: 'Cline' };
const agentTitle = k => AGENT_TITLES[k] || k || 'agent';
let agentsCache = null;
async function getAgents() { if (!agentsCache) agentsCache = await api('/api/agents'); return agentsCache; }

function newShellDialog(folder = '', preferredKind = 'agent', presetName = null, opts = {}) {
    if (preferredKind === 'claude') preferredKind = 'agent';
    const { firstPrompt = '', newFolder = false } = opts;
    const suggested = presetName ?? (folder.split('/').filter(Boolean).pop() || 'home').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 30);
    const { panel, close } = openDialog(`
        <h2>${firstPrompt ? 'Start on your wish' : 'New shell'}</h2>
        ${firstPrompt ? `<div class="field"><label for="ns-prompt">First message to the agent</label><textarea id="ns-prompt" rows="3">${esc(firstPrompt)}</textarea></div>` : ''}
        <div class="field"><label>Where</label>
          <button type="button" class="row plain picker" data-pick><span class="ico brass">${icon(newFolder ? 'folder-plus' : 'folder')}</span><div class="main"><div class="title mono">${esc(showPath(folder))}</div><div class="sub">${newFolder ? 'New project folder · tap to use an existing one instead' : 'Tap to choose a folder'}</div></div>${icon('chevron', 'i chev')}</button></div>
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
        <div class="field" data-runas-field hidden><label>Run as</label><div class="choices" data-runas>
          <button type="button" data-r="agent">${icon('shield')}Agent user · no root</button>
          <button type="button" data-r="root" class="selected">${icon('lock')}Root</button></div>
          <p class="sub" data-runas-note style="margin:6px 2px 0"></p></div>
        <div class="field"><label for="ns-name">Name</label><input id="ns-name" type="text" value="${esc(suggested)}" class="mono" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
        <div class="buttons"><button class="primary" data-ok>Start</button><button data-close>Cancel</button></div>`);
    let kind = preferredKind, agent = (/^\/?Research\//.test(folder || '') && localStorage.getItem('porthole.researchAgent')) || localStorage.getItem('porthole.agent') || 'claude', yolo = false, resume = false, profile = 'default', scratch = false, runAs = 'root';
    let agentSignIns = {};
    const runNote = () => { const noLogin = runAs === 'agent' && kind === 'agent' && agentSignIns[agent] === false; $('[data-runas-note]', panel).style.color = noLogin ? 'var(--flare)' : ''; $('[data-runas-note]', panel).textContent = noLogin ? `${agentTitle(agent)} is not signed in for the agent user yet: it starts as a fresh install and asks you to sign in (your root login is separate and untouched). ` + 'No root; root commands are asked for on this phone.' : runAs === 'agent' ? 'No root. Root commands are asked for on this phone (elevate). Project credentials via vault get from the project folder. Needs a folder under /Projects or a scratch folder; signs in as the agent user, separately from root logins.' : 'Full access to the whole box, as today.'; };
    api('/api/agent-user').then(a => { if (!a.available) return; const f = $('[data-runas-field]', panel); f.hidden = false; runAs = kind === 'agent' ? 'agent' : 'root'; agentSignIns = a.signedIn || {}; $$('[data-runas] button', panel).forEach(b => { b.classList.toggle('selected', b.dataset.r === runAs); b.onclick = () => { runAs = b.dataset.r; $$('[data-runas] button', panel).forEach(x => x.classList.toggle('selected', x === b)); runNote(); }; }); runNote(); }).catch(() => {});
    $$('[data-kind] button', panel).forEach(b => b.onclick = () => { kind = b.dataset.k; $$('[data-kind] button', panel).forEach(x => x.classList.toggle('selected', x === b)); $('[data-agent-opts]', panel).hidden = kind !== 'agent'; if (!$('[data-runas-field]', panel).hidden) { runAs = kind === 'agent' ? 'agent' : 'root'; $$('[data-runas] button', panel).forEach(x => x.classList.toggle('selected', x.dataset.r === runAs)); runNote(); } });
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
                sel.onchange = () => { if (sel.value === '__new') { sel.value = profile; const keep = $('#ns-name', panel).value.trim(); close(); newProfileDialog(() => newShellDialog(folder, 'agent', keep, { ...opts, firstPrompt: $('#ns-prompt', panel)?.value ?? firstPrompt })); } else profile = sel.value; };
            }
        };
        $$('button[data-a]', box).forEach(b => b.onclick = () => { agent = b.dataset.a; localStorage.setItem('porthole.agent', agent); $$('button[data-a]', box).forEach(x => x.classList.toggle('selected', x === b)); refreshProfiles(); });
        refreshProfiles();
    }).catch(ex => { $('[data-agent]', panel).innerHTML = `<p class="muted">${esc(ex.message)}</p>`; });
    $('[data-pick]', panel).onclick = () => {
        const name = $('#ns-name', panel).value.trim();
        const keepName = name && name !== suggested ? name : null;
        const fp = $('#ns-prompt', panel)?.value ?? firstPrompt;
        folderPicker(newFolder ? projectsRel() : folder, picked => newShellDialog(picked, kind, keepName, { firstPrompt: fp, newFolder: false }), () => newShellDialog(folder, kind, keepName, { ...opts, firstPrompt: fp }));
    };
    const go_ = async () => {
        const name = $('#ns-name', panel).value.trim();
        const finalName = scratch && name === suggested ? `scratch-${Math.random().toString(36).slice(2, 6)}` : name;
        const prompt = ($('#ns-prompt', panel)?.value ?? '').trim();
        if (newFolder) {   // create the project folder first (Projects/<name>)
            const parts = folder.split('/'); const leaf = parts.pop();
            try { await api('/api/files/mkdir', { method: 'POST', body: { path: parts.join('/') || '.', name: leaf } }); } catch (ex) { if (ex.status !== 409) { toast(ex.message, true); return; } }
        }
        const body = { name: finalName, kind, cwd: folder || '.', agent, yolo, resume, profile, scratch, runAs };
        if (kind === 'agent' && prompt) body.firstPrompt = `${prompt}\n\n(From PlatOpypus: you are in ${folder ? '/' + folder.replace(/^\/+/, '') : 'the home folder'}${newFolder ? ', a new empty project folder' : ''}. Restate the goal in one line, then get going.)`;
        if (kind === 'agent') {
            const session = await sessionTypeDialog(folder);
            if (!session) return newShellDialog(folder, kind, finalName, { ...opts, firstPrompt: prompt || firstPrompt });
            body.session = session;
        }
        try { await api('/api/shells', { method: 'POST', body }); close(); openTerminal(finalName, 'Shells'); }
        catch (ex) {
            // Claude as a Security Lab agent: say what to expect, then go ahead only if the user says so.
            if (ex.status === 428 && /Security Lab/.test(ex.message)) {
                const ok = await confirmDialog({ title: 'Use Claude for security testing?', danger: false, action: 'Use Claude anyway', text: 'Claude can run lab commands, but autonomous security testing may not suit it: it follows Anthropic\'s usage policies, so it may decline some tests, ask you to confirm you are authorised, or stop part-way through a long run. Codex or Gemini are the expected agents for autonomous testing here. Every run is still limited to this engagement\'s scope.' });
                if (ok) { try { await api('/api/shells', { method: 'POST', body: { ...body, ackClaude: true } }); close(); openTerminal(finalName, 'Shells'); } catch (e2) { toast(e2.message, true); } }
                return;
            }
            toast(ex.message, true);
        }
    };
    $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
}

// Before an agent starts: control session or project session; a new project also gets its security level (once).
function sessionTypeDialog(folder) {
    return new Promise(resolve => {
        if (/^\/?Research\/[^/]+/.test(folder || '')) return resolve('research');
        if (/^\/?Lab\/[^/]+/.test(folder || '')) return resolve('lab');   // inside a research topic: that is what it is
        const last = localStorage.getItem('porthole.sessionType') || 'project';
        const { panel, close } = openDialog(`<h2>${icon('claude')}What is this session?</h2>
            <div class="menu">
              <button data-s="project" class="${last === 'project' ? 'selected' : ''}">${icon('folder')}<span>Project work<br><span class="sub">build or change this project · follows its security level</span></span></button>
              <button data-s="control" class="${last === 'control' ? 'selected' : ''}">${icon('terminal')}<span>Control session<br><span class="sub">move files, quick recon, check logs, restart things · no project changes</span></span></button>
            </div><div class="buttons"><button data-cancel>Back</button></div>`);
        $('[data-cancel]', panel).onclick = () => { close(); resolve(null); };
        $$('[data-s]', panel).forEach(b => b.onclick = async () => {
            const s = b.dataset.s; localStorage.setItem('porthole.sessionType', s);
            if (s === 'control') { close(); return resolve('control'); }
            let g; try { g = await api(`/api/projects/profile?path=${encodeURIComponent(folder || '.')}`); } catch (ex) { toast(ex.message, true); close(); return resolve(null); }
            if (!g.root || g.profile) { close(); return resolve('project'); }
            close(); const ok = await securityLevelDialog(folder, g.name); resolve(ok ? 'project' : null);
        });
    });
}
function securityLevelDialog(folder, projectName) {
    return new Promise(resolve => {
        let level = null, audience = null, tier = null;
        const { panel, close } = openDialog(`<h2>${icon('shield')}How serious is ${esc(projectName)}?</h2>
            <p class="muted">Asked once per project. The agent gets a security brief to match, every session.</p>
            <div class="menu" data-levels>
              <button data-l="throwaway">${icon('zap')}<span>Throwaway<br><span class="sub">one-off, gone tomorrow · build as fast as possible, no security checks</span></span></button>
              <button data-l="personal">${icon('user')}<span>Personal<br><span class="sub">yours · decent security, nobody can use your login or see your data</span></span></button>
              <button data-l="professional">${icon('shield')}<span>Professional<br><span class="sub">work-grade · boundary tests every iteration, daily CVE checks</span></span></button>
            </div>
            <div data-sub hidden></div>
            <div class="buttons"><button class="primary" data-ok disabled>Save and start</button><button data-cancel>Back</button></div>`);
        const sub = $('[data-sub]', panel), ok = $('[data-ok]', panel);
        const subMenu = (label, opts, pick) => { sub.hidden = false; sub.innerHTML = `<h3 class="section" style="margin-top:10px">${label}</h3><div class="menu">${opts.map(([k, t, d]) => `<button data-o="${k}">${icon(k === 'private' || k === 'internal' ? 'lock' : k === 'regulated' ? 'shield' : 'globe')}<span>${t}<br><span class="sub">${d}</span></span></button>`).join('')}</div>`; $$('[data-o]', sub).forEach(b => b.onclick = () => { pick(b.dataset.o); $$('[data-o]', sub).forEach(x => x.classList.toggle('selected', x === b)); ok.disabled = false; }); };
        $$('[data-l]', panel).forEach(b => b.onclick = () => {
            level = b.dataset.l; audience = tier = null; $$('[data-l]', panel).forEach(x => x.classList.toggle('selected', x === b));
            if (level === 'throwaway') { sub.hidden = true; ok.disabled = false; }
            if (level === 'personal') { ok.disabled = true; subMenu('Who uses it?', [['private', 'Just me', 'only my own data, e.g. a bus tracker with my live location'], ['shared', 'Shared with friends', 'a few people I know, e.g. a party game · cross-site and user boundaries matter']], v => { audience = v; }); }
            if (level === 'professional') { ok.disabled = true; subMenu('Which tier?', [['internal', 'Internal tool', 'used inside a team or company'], ['public', 'Public-facing', 'strangers reach it over the internet'], ['regulated', 'Regulated data', 'GDPR personal data, payments or health data']], v => { tier = v; }); }
        });
        $('[data-cancel]', panel).onclick = () => { close(); resolve(false); };
        ok.onclick = async () => {
            try { const r = await api('/api/projects/profile', { method: 'PUT', body: { path: folder || '.', level, audience, tier } }); toast(`${projectName}: ${r.profile.key.replace('-', ' · ')}`); close(); resolve(true); }
            catch (ex) { toast(ex.message, true); }
        };
    });
}

// Upgrade repo: rebuild a prototype as a new project at a higher level. The original stays as it is; the new
// project gets a read-only copy of it and an agent that proposes an architecture before writing code.
async function upgradeRepoDialog(rel, name) {
    let g = {}; try { g = await api(`/api/projects/profile?path=${encodeURIComponent(rel)}`); } catch { /* no level */ }
    const cur = g.profile ? g.profile.key.replace('-', ' · ') : 'no level set';
    const targets = [['personal', 'shared', 'Personal · Shared', 'a few people you know'], ['professional', 'internal', 'Professional · Internal', 'a team or company'], ['professional', 'public', 'Professional · Public', 'strangers on the internet'], ['professional', 'regulated', 'Professional · Regulated', 'personal data, payments, health']];
    let pick = null;
    const { panel, close } = openDialog(`<h2>${icon('rocket')}Upgrade ${esc(name)}</h2>
        <p class="muted">Original project · ${esc(cur)}<br><span class="mono">${esc(showPath(rel))}</span></p>
        <p class="sub" style="margin:0 2px 10px">Rebuild it as a new project that treats this one as a working prototype: an agent works out what it does, designs the version that deserves to exist, and shows you a proposal before writing code.</p>
        <div class="field"><label for="up-name">New project name</label><input id="up-name" type="text" class="mono" value="${esc(name)}-v2" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
        <div class="field"><label>Target security level</label><div class="menu" data-tl>${targets.map(([l, t, title, d], i) => `<button data-i="${i}">${icon(t === 'shared' ? 'user' : t === 'internal' ? 'lock' : t === 'public' ? 'globe' : 'shield')}<span>${title}<br><span class="sub">${d}</span></span></button>`).join('')}</div></div>
        <p class="sub" style="margin:6px 2px 0">${icon('check')} The original stays unchanged; the new project gets a read-only copy of it (no dependencies, history or .env files).</p>
        <div class="buttons"><button class="primary" data-ok disabled>Plan upgraded project</button><button data-close>Cancel</button></div>`);
    const ok = $('[data-ok]', panel);
    $$('[data-tl] button', panel).forEach(b => b.onclick = () => { pick = targets[Number(b.dataset.i)]; $$('[data-tl] button', panel).forEach(x => x.classList.toggle('selected', x === b)); ok.disabled = false; });
    ok.onclick = async () => {
        const newName = $('#up-name', panel).value.trim();
        const [level, sub] = pick;
        ok.disabled = true; ok.textContent = 'Copying the prototype…';
        try {
            const r = await api('/api/projects/upgrade', { method: 'POST', body: { path: rel, name: newName, level, ...(level === 'personal' ? { audience: sub } : { tier: sub }) } });
            close(); toast(`${r.name} created (${r.level.replace('-', ' · ')})`);
            if (state.filesPath === parentOf(rel)) loadFiles(state.filesPath).catch(() => {});
            newShellDialog(r.folder, 'agent', `upgrade-${r.name}`.slice(0, 40), { firstPrompt: r.prompt });
        } catch (ex) { toast(ex.message, true); ok.disabled = false; ok.textContent = 'Plan upgraded project'; }
    };
}

// .platorun: show exactly what will run (as whom, where, what gets shared, which Vault names), then run it.
async function portholerunDialog(rel) {
    let pl; try { pl = await api(`/api/portholerun?path=${encodeURIComponent(rel)}`); } catch (ex) { return toast(ex.message, true); }
    const who = pl.runAs === 'root' ? '<span class="tag danger">root</span> full control of the box' : pl.runAs === 'agent' ? `the agent user <span class="mono">${esc(pl.account)}</span>` : `<span class="mono">${esc(pl.account)}</span>, this project's own account (no logins, no PlatOpypus access)`;
    const share = !pl.port ? 'nothing (no port)' : pl.share === 'none' ? `nothing; stays local on :${pl.port}` : pl.share === 'domain' ? `<span class="mono">${esc(pl.hostname || '')}</span> (your domain, public)` : `a public quick link to :${pl.port} (closes after 4 h)`;
    const missing = pl.needs.filter(n => !n.present).map(n => n.name);
    const blocked = pl.errors.length || missing.length;
    const { panel, close } = openDialog(`<h2>${icon('rocket')}Run ${esc(pl.name)}</h2>
        <p class="muted"><span class="mono">${esc(showPath(pl.folder))}/.platorun</span>${pl.running ? ' · <span class="live">● running</span>' : ''}</p>
        ${pl.errors.length ? `<div class="banner danger">${pl.errors.map(esc).join('<br>')}</div>` : `
        <div class="${pl.runAs === 'root' ? 'banner danger' : 'note'}" style="margin:0 0 10px">This will run these commands in <span class="mono">${esc(showPath(pl.cwd || pl.folder))}</span> as ${who}:</div>
        <pre style="white-space:pre-wrap;max-height:30vh">${pl.commands.map(c => `${c.step === 'before' ? '# first\n' : ''}${esc(c.cmd)}`).join('\n')}</pre>
        <div class="list" style="margin-top:10px">
          <div class="row plain"><span class="ico ${pl.share === 'none' || !pl.port ? 'dim' : 'kelp'}">${icon('link')}</span><div class="main"><div class="title">Shares</div><div class="sub" style="white-space:normal">${share}</div></div></div>
          ${pl.needs.length ? `<div class="row plain"><span class="ico brass">${icon('key')}</span><div class="main"><div class="title">Vault</div><div class="sub" style="white-space:normal">${pl.needs.map(n => `<span class="mono">${esc(n.name)}</span>${n.present ? '' : ' <span class="warn">missing</span>'}`).join(', ')}</div></div></div>` : ''}
          ${pl.env.length ? `<div class="row plain"><span class="ico">${icon('settings')}</span><div class="main"><div class="title">Settings</div><div class="sub mono" style="white-space:normal">${pl.env.map(esc).join(' ')}</div></div></div>` : ''}
        </div>
        ${missing.length ? `<p class="sub warn" style="margin-top:8px">Add ${missing.map(esc).join(', ')} to the Vault first.</p>` : ''}
        ${pl.gitignored ? '' : '<p class="sub" style="margin-top:8px">PlatOpypus adds <span class="mono">.platorun</span> to the project\'s .gitignore when it runs.</p>'}
        ${pl.link?.url ? `<p class="sub" style="margin-top:8px">Link: <a href="${esc(pl.link.url + (pl.open || ''))}" target="_blank" rel="noopener">${esc(pl.link.url.replace(/^https:\/\//, ''))}</a></p>` : ''}`}
        <div class="buttons">
          ${blocked ? '' : pl.running ? `<button class="primary" data-pr="restart">${icon('restart')}Restart</button><button data-pr="stop">${icon('stop')}Stop</button>` : `<button class="${pl.runAs === 'root' ? 'danger' : 'primary'}" data-pr="run">${icon('play')}Run${pl.runAs === 'root' ? ' as root' : ''}</button>`}
          <button data-pr="edit">${icon('pencil')}Edit .platorun</button><button data-close>Close</button></div>`);
    $$('[data-pr]', panel).forEach(b => b.onclick = async () => {
        const a = b.dataset.pr;
        if (a === 'edit') { close(); return openEditor(rel, '.platorun'); }
        b.disabled = true;
        try {
            if (a === 'stop') { await api('/api/portholerun/stop', { method: 'POST', body: { path: rel } }); close(); toast(`${pl.name} stopped`); return; }
            b.textContent = a === 'restart' ? 'Restarting…' : 'Starting…';
            const r = await api('/api/portholerun/run', { method: 'POST', body: { path: rel, hash: pl.hash, restart: a === 'restart' } });
            close();
            if (r.link?.url) {
                const d = openDialog(`<h2>${icon('rocket')}${esc(r.name)} is ${a === 'restart' ? 'restarted' : 'running'}</h2><p class="muted">${r.port ? `:${r.port} · ` : ''}as ${esc(r.account)}${r.addedToGitignore ? ' · added to .gitignore' : ''}</p>
                    <div class="buttons"><a class="primary" href="${esc(openLink(r.link.url, r.port, credsSeen))}" target="_blank" rel="noopener">${icon('external')}Open ${esc(r.link.url.replace(/^https:\/\//, '').split('/')[0])}</a><button data-copy-link>${icon('copy')}Copy link</button><button data-go-svc>${icon('services')}Services</button><button data-close>Close</button></div>`, { size: 'small' });
                $('[data-copy-link]', d.panel).onclick = () => copyText(r.link.url, 'Link copied');
                $('[data-go-svc]', d.panel).onclick = () => { d.close(); go('services'); };
            } else toast(r.link?.error ? `Running; the link failed: ${r.link.error}` : `${r.name} is running${r.port ? ` on :${r.port}` : ''}`, !!r.link?.error);
        } catch (ex) { toast(ex.message, true); b.disabled = false; }
    });
}

// What runs in a folder, as one line: the first server by name, its port, and how many more.
function runningLine(list) {
    if (!list?.length) return '';
    const r = list[0];
    return `<span class="live">● ${esc(r.name)} running</span>${r.port ? ` · <span class="mono">:${r.port}</span>` : ''}${list.length > 1 ? ` · +${list.length - 1} more` : ''}`;
}

// ---------- Services: one card per project ----------
const PART_LABEL = { live: 'live', run: '.platorun', server: 'server', container: 'container', editor: 'VS Code', port: 'port', link: 'link', 'box-editor': 'VS Code' };
function partIcon(x) {
    if (x.type === 'container') return `<span class="ico ${x.running ? 'dock' : 'dim'} logo"><img src="/api/docker/logo?image=${encodeURIComponent(x.image || '')}" alt="" loading="lazy" data-fb="container"><span class="badge">${icon('container')}</span></span>`;
    const ic = { live: 'globe', run: 'rocket', server: 'devserver', port: 'devserver', editor: 'file-code', 'box-editor': 'file-code', link: 'link' }[x.type] || 'activity';
    return `<span class="ico ${x.running ? (x.type === 'live' || x.type === 'run' || x.type === 'link' ? 'kelp' : 'brass') : 'dim'}">${icon(ic)}</span>`;
}
function partLink(x) {
    if (x.type === 'editor' || x.type === 'box-editor') return x.shared && x.shareUrl ? ` · <a href="${esc(x.shareUrl)}" target="_blank" rel="noopener" class="kelp-link">shared</a>, password-protected${x.expires ? ` · closes in ${fmtIn(x.expires)}` : ''}` : x.running ? ' · not shared' : '';
    const url = (x.url || x.link?.url) ? openLink(x.url || x.link?.url, x.port, credsSeen) : null;
    if (!url) return x.gone ? ' · <span class="warn">folder gone</span>' : x.running && x.port ? ' · local' : '';
    const host = url.replace(/^https:\/\//, '').split('/')[0];
    return ` · <a href="${esc(url)}" target="_blank" rel="noopener" class="kelp-link">${esc(host)}</a>${x.link?.expires ? ` · closes in ${fmtIn(x.link.expires)}` : ''}${x.link?.kind === 'zoned' && x.link.connected === false ? ' · <span style="color:var(--flare)">down</span>' : ''}`;
}
function partControls(x, credChip) {
    const more = sel => `<button class="more" ${sel} aria-label="More">${icon('more_h')}</button>`;
    const cred = x.port ? credChip(x.port) : '';
    if (x.type === 'live') return cred + (x.worker && !x.port ? '' : '') + (x.running ? `<button class="pill sm" data-live="stop" data-p="${esc(x.project)}" data-k="${esc(x.key)}">${icon('stop')}Stop</button>` : `<button class="pill sm" data-live="start" data-p="${esc(x.project)}" data-k="${esc(x.key)}">${icon('play')}Start</button>`) + more(`data-live-page="${esc(x.project)}" data-k="${esc(x.key)}"`);
    if (x.type === 'run' || x.type === 'server') return cred + (x.running ? `<button class="pill sm" data-srv="stop" data-slug="${esc(x.slug)}">${icon('stop')}Stop</button>` : x.canStart ? `<button class="pill sm" data-srv="start" data-slug="${esc(x.slug)}">${icon('play')}Start</button>` : '') + more(`data-srv-menu="${esc(x.slug)}"`);
    if (x.type === 'container') return cred + (x.running ? (x.port && !x.link ? `<button class="pill ghost sm" data-share="${x.port}" data-label="${esc(x.title)}">${icon('share')}Share</button>` : '') : `<button class="pill sm" data-cact="start" data-c="${esc(x.name)}">${icon('play')}Start</button>`) + more(`data-cmenu="${esc(x.name)}"`);
    if (x.type === 'editor' || x.type === 'box-editor') {
        const who = x.type === 'box-editor' ? 'box' : x.name;
        const share = !x.running ? '' : x.shared
            ? `<span class="pill kelp sm" data-open-url="${esc(x.shareUrl || '')}">${icon('external')}Open</span><button class="pill sm" data-cs="unshare" data-who="${esc(who)}">${icon('x')}Unshare</button>`
            : `<button class="pill ghost sm" data-cs="share" data-who="${esc(who)}">${icon('share')}Share</button>`;
        const startStop = x.type === 'box-editor' ? (x.running ? `<button class="pill sm" data-cs="stop" data-who="box">${icon('stop')}Stop</button>` : `<button class="pill sm" data-cs="start" data-who="box">${icon('play')}Start</button>`) : '';
        return share + startStop + more(`data-cs="menu" data-who="${esc(who)}"`);
    }
    if (x.type === 'port') return cred + (x.link ? `<button class="pill sm" data-unshare="${x.port}">${icon('x')}Unshare</button>` : `<button class="pill ghost sm" data-share="${x.port}" data-label="${esc(x.title)}">${icon('share')}Share</button>`) + `<button class="pill ghost sm" data-register="${x.port}" data-label="${esc(x.title)}" title="Register as a server">${icon('plus')}</button>`;
    if (x.type === 'link') return cred + more(`data-link-menu="${x.port}"`);
    return '';
}
function partRow(x, credChip) {
    return `<div class="row prow">${partIcon(x)}<div class="main"><div class="title">${esc(x.title)}<span class="tag dim">${PART_LABEL[x.type] || x.type}</span></div>
        <div class="sub">${x.running ? '<span class="live">● running</span>' + useBubble(partUsage(x)) : `stopped${x.status && x.type === 'container' ? ` · ${esc(x.status.toLowerCase())}` : ''}`}${x.port ? ` · <span class="mono">:${x.port}</span>` : ''}${partLink(x)}</div></div>${partControls(x, credChip)}</div>`;
}
function partUsage(x) {
    if (x.type === 'container' || x.type === 'editor') return usageSeen.containers[x.name];
    if (x.type === 'live') return usageSeen.servers[liveSlug(x.project, x.key)];
    if (x.slug) return usageSeen.servers[x.slug];
    return null;
}
function partsHtml(parts, credChip) {
    // Containers from one compose project fold into a single row that opens to show them.
    const out = [], done = new Set();
    for (const x of parts) {
        if (done.has(x.id)) continue;
        const crew = x.type === 'container' && x.compose ? parts.filter(y => y.type === 'container' && y.compose === x.compose) : [];
        if (crew.length > 1) {
            crew.forEach(y => done.add(y.id));
            const up = crew.filter(y => y.running).length, withLink = crew.find(y => y.link?.url);
            out.push(`<details class="pgroup"><summary class="row prow"><span class="ico ${up ? 'dock' : 'dim'}">${icon('compose')}</span><div class="main"><div class="title">${esc(x.compose)}<span class="tag dim">${crew.length} containers</span></div><div class="sub">${up ? `<span class="live">● ${up} of ${crew.length} running</span>` : 'stopped'}${withLink ? partLink(withLink) : ''}</div></div><button class="more" data-pmenu="${esc(x.compose)}" aria-label="Compose actions">${icon('more_h')}</button></summary>${crew.map(y => partRow(y, credChip)).join('')}</details>`);
            continue;
        }
        done.add(x.id); out.push(partRow(x, credChip));
    }
    return out.join('');
}
function projSummary(p) {
    if (!p.parts.length) return p.canRun ? 'not running · has .platorun' : 'nothing running';
    const up = p.parts.filter(x => x.running);
    if (!up.length) return `stopped · ${p.parts.length} part${p.parts.length === 1 ? '' : 's'}`;
    const names = [];
    const containers = up.filter(x => x.type === 'container').length;
    for (const x of up) if (x.type !== 'container') names.push(x.type === 'editor' ? 'VS Code' : `${x.title}${x.port ? ` :${x.port}` : ''}`);
    if (containers) names.push(`${containers} container${containers === 1 ? '' : 's'}`);
    return names.join(' · ');
}
function projectCard(p, i, credChip) {
    const runUp = p.parts.some(x => x.type === 'run' && x.running);
    const solo = p.parts.length === 1 ? p.parts[0] : null;
    if (solo) {
        const x = solo;
        return `<section class="pcard ${p.running ? 'on' : ''}">
        <div class="pcard-head">
          <button class="pcard-title" data-proj-folder="${esc(p.path)}" title="Open ${esc(p.name)} in Files">
            <span class="ico ${p.running ? 'kelp' : 'brass'}${p.icon ? ' fav' : ''}">${p.icon ? `<img src="/api/files/icon?path=${encodeURIComponent(p.icon)}" alt="" loading="lazy" data-fb="folder">` : icon('folder')}</span>
            <div class="main"><div class="title">${esc(p.name)}<span class="tag dim">${x.type === 'live' ? 'live' : PART_LABEL[x.type] || x.type}</span></div>
              <div class="sub">${x.running ? '<span class="live">● running</span>' : 'stopped'}${x.port ? ` · <span class="mono">:${x.port}</span>` : ''}${partLink(x).replace(/<a [^>]*>([^<]*)<\/a>/, '$1')}</div></div></button>
          ${p.open ? `<a class="pill kelp" href="${esc(openLink(p.open, x.port, credsSeen))}" target="_blank" rel="noopener">${icon('external')}Open</a>` : ''}
          ${partControls(x, credChip).replace(/<button class="more"[^>]*>[\s\S]*?<\/button>$/, '')}
          <button class="more" data-proj-menu="${i}" aria-label="${esc(p.name)} actions">${icon('more_h')}</button>
        </div>${quickChips(p)}</section>`;
    }
    return `<section class="pcard ${p.running ? 'on' : ''}">
        <div class="pcard-head">
          <button class="pcard-title" data-proj-folder="${esc(p.path)}" title="Open ${esc(p.name)} in Files">
            <span class="ico ${p.running ? 'kelp' : 'brass'}${p.icon ? ' fav' : ''}">${p.icon ? `<img src="/api/files/icon?path=${encodeURIComponent(p.icon)}" alt="" loading="lazy" data-fb="folder">` : icon('folder')}</span>
            <div class="main"><div class="title">${esc(p.name)}${p.running ? '<span class="dot live"></span>' : ''}</div><div class="sub">${esc(projSummary(p))}</div></div></button>
          ${p.open ? `<a class="pill kelp" href="${esc(openLink(p.open, null, credsSeen))}" target="_blank" rel="noopener">${icon('external')}Open</a>` : ''}
          ${p.canRun && !runUp ? `<button class="pill ghost-kelp" data-proj-run="${esc(p.path)}">${icon('play')}Run</button>` : ''}
          <button class="more" data-proj-menu="${i}" aria-label="${esc(p.name)} actions">${icon('more_h')}</button>
        </div>${quickChips(p)}
        ${p.parts.length ? `<div class="pcard-parts">${partsHtml(p.parts, credChip)}</div>` : ''}
    </section>`;
}
function projectsView(s, credChip) {
    const projects = s.projects || [], box = s.box || { parts: [] };
    const up = projects.map((p, i) => [p, i]).filter(([p]) => p.running), idle = projects.map((p, i) => [p, i]).filter(([p]) => !p.running);
    let html = '';
    if (!up.length && !box.parts.some(x => x.running)) html += `<p class="empty">Nothing is running. Run a project from Files or below, or tap <b>+</b> to share a port or start an app.</p>`;
    if (up.length) html += `<div class="pgrid">${up.map(([p, i]) => projectCard(p, i, credChip)).join('')}</div>`;
    if (box.parts.length || s.system?.length) {
        html += `<h2 class="section"><span class="bullet"></span>Box<span class="meta">not in a project</span></h2><section class="pcard box"><div class="pcard-parts">${partsHtml(box.parts, credChip)}${s.system?.length ? `<details class="pgroup"><summary class="row prow"><span class="ico dim">${icon('settings')}</span><div class="main"><div class="title">System ports<span class="tag dim">${s.system.length}</span></div><div class="sub">PlatOpypus, agents and box services · not shareable</div></div></summary>${s.system.map(d => `<div class="row prow"><span class="ico dim">${icon('settings')}</span><div class="main"><div class="title">${esc(d.what)}</div><div class="sub">${esc(d.process)} · <span class="mono">${esc(d.addr)}:${d.port}</span></div></div></div>`).join('')}</details>` : ''}</div></section>`;
    }
    if (idle.length) html += `<details class="pidle"${up.length ? '' : ' open'}><summary class="section"><span class="bullet"></span>Not running<span class="meta">${idle.length}</span></summary><div class="pgrid">${idle.map(([p, i]) => projectCard(p, i, credChip)).join('')}</div></details>`;
    return html;
}
function projectMenu(p, s) {
    if (!p) return;
    const lives = p.parts.filter(x => x.type === 'live');
    const { panel, close } = openDialog(`<h2>${icon('folder')}${esc(p.name)}</h2><p class="muted">${esc(projSummary(p))}</p><div class="menu">
        <button data-m="folder">${icon('folder-open')}Open the folder</button>
        <button data-m="agent">${icon('claude')}Start an agent here</button>
        ${p.hasEditor ? '' : `<button data-m="vscode">${icon('file-code')}Open in VS Code<span class="sub" style="margin-left:6px">project editor, sees only this folder</span></button>`}
        ${p.canRun ? `<button data-m="run">${icon('rocket')}.platorun…</button>` : ''}
        ${lives.map(x => `<button data-m="live" data-k="${esc(x.key)}" data-p="${esc(x.project)}">${icon('globe')}${esc(x.title)} · service page</button>`).join('')}
        ${p.parts.filter(x => x.type === 'run' || x.type === 'server').map(x => `<button data-m="srv" data-slug="${esc(x.slug)}">${icon('logs')}${esc(x.title)} · logs and settings</button>`).join('')}
        ${p.parts.filter(x => x.type === 'container').map(x => `<button data-m="ctr" data-name="${esc(x.name)}">${icon('container')}${esc(x.title)} · container</button>`).join('')}
        ${p.parts.filter(x => x.type === 'editor').map(x => `<button data-m="ed" data-name="${esc(x.name)}">${icon('file-code')}VS Code for ${esc(p.name)}</button>`).join('')}
        ${p.open ? `<button data-m="copy">${icon('copy')}Copy the link</button>` : ''}
        <button data-m="share">${icon('share')}Share a port…</button>
    </div><div class="buttons"><button data-close>Close</button></div>`);
    $$('[data-m]', panel).forEach(b => b.onclick = () => {
        const m = b.dataset.m; close();
        if (m === 'folder') { state.filesPath = p.path; go('files'); }
        if (m === 'agent') newShellDialog(p.path, 'agent');
        if (m === 'vscode') codeServerStartWith(p.path, true);
        if (m === 'run') portholerunDialog(join(p.path, '.platorun'));
        if (m === 'live') livePage(s.live.find(x => x.project === b.dataset.p), b.dataset.k);
        if (m === 'copy') copyText(p.open, 'Link copied');   // the bare address: sharing it never hands over a key
        if (m === 'srv') serverMenu(s.servers.find(x => x.slug === b.dataset.slug));
        if (m === 'ctr') containerMenu(s.containers.find(x => x.name === b.dataset.name));
        if (m === 'ed') codeServerAction('menu', b.dataset.name);
        if (m === 'share') shareDialog('', p.name);
    });
}
// Apps in one tap, from the + sheet (they no longer take space on the Services page).
async function appsDialog() {
    const s = await api('/api/services').catch(() => null);
    if (!s?.docker) return toast('Docker is not running on the box.', true);
    const { panel, close } = openDialog(`<h2>${icon('container')}Start an app</h2><p class="muted">Pulls the image, runs it with its own volume and gives it a link.</p>
        <div class="tiles">${s.apps.map(a => `<button class="tile ${a.running ? 'on' : ''}" data-app="${a.key}" data-title="${esc(a.title)}"><span class="ico dock">${icon('app-' + a.key.replace('stirling-pdf', 'stirling').replace('it-tools', 'ittools').replace('uptime-kuma', 'kuma'))}</span>${esc(a.title)}</button>`).join('')}
        <button class="tile dim" data-run-image><span class="ico">${icon('container')}</span>Any image…</button></div><div class="buttons"><button data-close>Close</button></div>`);
    $$('[data-app]', panel).forEach(b => b.onclick = () => { close(); launchApp(b.dataset.app, b.dataset.title); });
    $('[data-run-image]', panel).onclick = () => { close(); runImageDialog(); };
}
// Home: what's running now, one line per project.
async function loadHomeRunning() {
    const host = $('#home-running'); if (!host) return;
    const [s] = await Promise.all([api('/api/services').catch(() => null), loadCreds()]);
    if (s) liveSeen = s.live || [];
    loadHomeQuick(s).catch(() => {});
    const up = (s?.projects || []).filter(p => p.running);
    const boxUp = (s?.box?.parts || []).filter(x => x.running && x.type !== 'link');
    if (!up.length && !boxUp.length) { host.innerHTML = ''; return; }
    host.innerHTML = `<h2 class="section"><span class="bullet kelp"></span>Running now<button class="act" data-go-services>Services</button></h2><div class="list">${up.map(p => `
        <div class="row"><button class="row-main" data-proj-folder="${esc(p.path)}"><span class="ico kelp${p.icon ? ' fav' : ''}">${p.icon ? `<img src="/api/files/icon?path=${encodeURIComponent(p.icon)}" alt="" loading="lazy" data-fb="folder">` : icon('folder')}</span><div class="main"><div class="title">${esc(p.name)}</div><div class="sub">${esc(projSummary(p))}</div></div></button>
          ${p.open ? `<a class="pill kelp sm" href="${esc(openLink(p.open, null, credsSeen))}" target="_blank" rel="noopener">${icon('external')}Open</a>` : ''}</div>${quickChips(p, 'in-row')}`).join('')}
        ${boxUp.length ? `<button class="row" data-go-services><span class="ico">${icon('server')}</span><div class="main"><div class="title">Box</div><div class="sub">${esc(boxUp.map(x => x.title).join(' · '))}</div></div>${icon('chevron', 'i chev')}</button>` : ''}</div>`;
    $$('[data-proj-folder]', host).forEach(b => b.onclick = () => { state.filesPath = b.dataset.projFolder; go('files'); });
    $$('[data-go-services]', host).forEach(b => b.onclick = () => go('services'));
    bindQuickChips(host);
    $$('.ico.fav img', host).forEach(img => img.addEventListener('error', () => { const sp = img.parentElement; if (!sp) return; sp.classList.remove('fav'); sp.innerHTML = icon('folder'); }, { once: true }));
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
            if (!String(c.id).startsWith('svc-')) await api(`/api/creds/${c.id}`, { method: 'DELETE' }).catch(() => {});
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
    termSheet.hidden = false; renderNavShells(shells);

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
// Stop: Ctrl+C to whatever runs in the terminal (interrupts an agent mid-task, or a running command).
$('#composer-stop').addEventListener('click', () => { if (scrollMode) setScrollMode(false); sendInput(''); try { navigator.vibrate?.(30); } catch { /* ignore */ } toast('Sent Ctrl+C'); term?.focus(); });
function sendResize() { if (!term || !fit) return; fit.fit(); if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); }
function closeTerminal() {
    if (scrollMode) setScrollMode(false);
    termSheet.hidden = true; clearTimeout(reconnectTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    if (term) { term.dispose(); term = null; }
    setCtrl(false); setAlt(false); $('#copy-chip').hidden = true;
    state.shells = [];
    $$('#nav-shells [data-nav-shell]').forEach(b => b.classList.remove('active'));
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

var credsSeen = []; // var: read before this line runs (no TDZ)
async function loadCreds() { credsSeen = await api('/api/creds').catch(() => credsSeen); return credsSeen; }
async function loadServices() {
    const [s] = await Promise.all([api('/api/services'), loadUsage()]);
    liveSeen = s.live || [];
    const shared = await loadCreds();
    const credChip = port => { const list = shared.filter(c => c.port === port); return list.length ? `<button class="pill" data-credport="${port}" title="Shared credentials">${icon('key')}${list.length > 1 ? list.length : ''}</button>` : ''; };
    const f = state.servicesFilter;
    const show = k => f === 'all' || f === k;
    let html = f === 'projects' ? projectsView(s, credChip, shared) : '';

    if (show('dev') || show('links')) {
        const liveRows = (s.live || []).flatMap(p => p.services.map(v => ({ p, v })));
        if (liveRows.length || (s.live || []).some(p => p.errors.length)) {
            html += `<h2 class="section"><span class="bullet kelp"></span>Live services<span class="meta">from PORTHOLE.md</span></h2><div class="list">`;
            for (const p of s.live) {
                if (p.errors.length) html += `<button class="row" data-live-errors="${esc(p.project)}"><span class="ico flare">${icon('info')}</span><div class="main"><div class="title">${esc(p.name)}<span class="tag" style="color:var(--flare)">PORTHOLE.md has errors</span></div><div class="sub">${esc(p.errors[0])}</div></div>${icon('chevron', 'i chev')}</button>`;
                for (const v of p.services) html += `
                <div class="row"><span class="ico ${v.running ? 'kelp' : 'dim'}${p.icon ? ' fav' : ''}">${p.icon ? `<img src="/api/files/icon?path=${encodeURIComponent(p.icon)}" alt="" loading="lazy" data-fb="${v.worker ? 'cpu' : 'globe'}">` : icon(v.worker ? 'cpu' : 'globe')}</span>
                  <div class="main"><div class="title">${esc(v.title)}<span class="tag dim">${esc(p.name)}</span>${v.worker ? '<span class="tag dim">worker</span>' : ''}</div>
                    <div class="sub">${v.running ? `<span class="live">● running</span>` + useBubble(usageSeen.servers[v.slug || liveSlug(p.project, v.key)]) : 'stopped'}${v.host ? ` · <a href="${esc(openLink(v.host.url, v.port, shared))}" target="_blank" rel="noopener" style="color:var(--kelp)">${esc(v.host.hostname)}</a>` : v.hostname ? ` · ${esc(v.hostname)} not set up` : v.port ? ` · <span class="mono">:${v.port}</span> local` : ''}</div></div>
                  ${v.running ? `<button class="pill" data-live="stop" data-p="${esc(p.project)}" data-k="${esc(v.key)}">${icon('stop')}Stop</button>` : `<button class="pill" data-live="start" data-p="${esc(p.project)}" data-k="${esc(v.key)}">${icon('play')}Start</button>`}
                  <button class="more" data-live-page="${esc(p.project)}" data-k="${esc(v.key)}" aria-label="Service page">${icon('more_h')}</button>
                </div>`;
            }
            html += `</div>`;
        }
    }
    // One card per thing: with everything shown, a link to a container or a registered server sits on that card.
    const ownedPorts = new Set(f === 'all' ? [...(s.docker ? s.containers.flatMap(c => c.ports.map(pp => pp.host)) : []), ...s.servers.filter(d => d.port).map(d => d.port)] : []);
    const looseLinks = s.links.filter(t => !ownedPorts.has(t.port));
    const linkFor = port => s.links.find(t => t.port === port) || null;
    const linkLine = t => !t ? '' : `<div class="sub mono link-line">${icon('link')}${t.url ? `<a href="${esc(openLink(t.url, t.port, shared))}" target="_blank" rel="noopener">${esc(t.url.replace(/^https:\/\//, ''))}</a>` : 'publishing…'}${t.kind === 'zoned' ? (t.connected ? ' · <span class="live">● connected</span>' : t.alive ? ' · connecting…' : ' · <span style="color:var(--flare)">● down</span>') : ''}${t.expires ? ` · closes in ${fmtIn(t.expires)}` : ''}</div>${t.expires ? `<div class="bar-mini kelp"><div style="width:${Math.max(2, Math.min(100, (t.expires - Date.now()) / (4 * 3600_000) * 100))}%"></div></div>` : ''}`;
    if (show('links')) {
        html += `<h2 class="section"><span class="bullet kelp"></span>Shared links<span class="meta">quick links close after 4 h · your domain stays</span></h2>`;
        html += looseLinks.length ? `<div class="list">${looseLinks.map(t => `
            <div class="row"><span class="ico kelp">${icon('link')}</span>
              <div class="main"><div class="title">${esc(t.name || t.target)}${t.kind === 'zoned' ? '<span class="tag">your domain</span>' : ''}${t.owner ? `<span class="tag dim">${esc(t.owner)}</span>` : ''}</div><div class="sub mono">${t.url ? esc(t.url.replace(/^https:\/\//, '')) : 'publishing…'}${t.kind === 'zoned' ? (t.connected ? ' · <span class="live">● connected</span>' : t.alive ? ' · connecting…' : ' · <span style="color:var(--flare)">● down</span>') : ''}</div>
                ${t.expires ? `<div class="bar-mini kelp"><div style="width:${Math.max(2, Math.min(100, (t.expires - Date.now()) / (4 * 3600_000) * 100))}%"></div></div>` : ''}</div>
              ${credChip(t.port)}${t.url ? `<a class="pill kelp" href="${esc(openLink(t.url, t.port, shared))}" target="_blank" rel="noopener">${icon('external')}Open</a>` : ''}
              <button class="more" data-link-menu="${t.port}" aria-label="Link actions">${icon('more_h')}</button>
            </div>`).join('')}</div>` : `<p class="empty">${s.links.length ? 'Every link is on its container or server card below.' : 'Nothing shared. Share a dev server or container below.'}</p>`;
    }
    if (show('dev')) {
        html += `<h2 class="section"><span class="bullet brass"></span>Servers<span class="meta">registered with svc</span></h2>`;
        html += s.servers.length ? `<div class="list">${s.servers.map(d => `
            <div class="row"><span class="ico ${d.alive ? 'brass' : 'dim'}">${icon('devserver')}</span>
              <div class="main"><div class="title">${esc(d.name)}${d.port ? ` <span class="mono">:${d.port}</span>` : ''}${d.project ? `<span class="tag dim">${esc(d.project)}</span>` : ''}${d.external ? '<span class="tag dim">pid</span>' : ''}</div>
                <div class="sub">${d.alive ? `<span class="live">● running</span>${d.listening === false ? ' · not listening yet' : ''}` : `stopped${d.stoppedAt ? ' · ' + fmtAgo(d.stoppedAt) : ''}`}${d.tunnel?.url && !ownedPorts.has(d.port) ? ` · <a href="${esc(openLink(d.tunnel.url, d.port, shared))}" target="_blank" rel="noopener" style="color:var(--kelp)">${esc(d.tunnel.url.replace(/^https:\/\//, ''))}</a>` : d.alive && d.port && !d.tunnel ? ' · local only' : ''}</div>${ownedPorts.has(d.port) ? linkLine(linkFor(d.port)) : ''}</div>
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
            html += `<details class="sys"><summary><span class="bullet"></span>System · ${s.system.length} local-only port${s.system.length === 1 ? '' : 's'}<span class="meta">PlatOpypus, agents, box services · not shareable</span></summary>
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
                <div class="row"><span class="ico ${c.state === 'running' ? 'dock' : 'dim'} logo"><img src="/api/docker/logo?image=${encodeURIComponent(c.image)}" alt="" loading="lazy" data-fb="${c.app === 'postgres' || c.image.startsWith('postgres') || c.image.startsWith('redis') ? 'database' : 'container'}"><span class="badge">${icon('container')}</span></span>
                  <div class="main"><div class="title">${esc(c.title)}${c.app ? '<span class="tag">app</span>' : ''}${c.compose ? `<span class="tag dim">${esc(c.compose)}</span>` : ''}${c.tunnel && ownedPorts.has(c.tunnel.port || c.ports[0]?.host) ? `<span class="tag">${linkFor(c.ports[0]?.host)?.kind === 'zoned' ? 'your domain' : 'shared'}</span>` : ''}</div>
                    <div class="sub">${c.state === 'running' ? `<span class="live">● ${esc(c.status.replace(/^Up /, 'up '))}</span>` + useBubble(usageSeen.containers[c.name]) : esc(c.status.toLowerCase())}${c.ports.length ? ` · <span class="mono">:${c.ports.map(p => p.host).join(' :')}</span>` : ''}${c.tunnel?.url ? '' : c.ports.length && c.state === 'running' ? ' · local only' : ''}</div>
                    ${ownedPorts.size ? c.ports.map(pp => linkLine(linkFor(pp.host))).join('') : ''}</div>
                  ${c.ports[0] ? credChip(c.ports[0].host) : ''}${c.state !== 'running' ? `<button class="pill" data-cact="start" data-c="${esc(c.name)}">${icon('play')}Start</button>`
                    : c.tunnel?.url ? `<a class="pill kelp" href="${esc(openLink(c.tunnel.url, c.ports[0]?.host, shared))}" target="_blank" rel="noopener">${icon('external')}Open</a>`
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
    $$('[data-proj-folder]', body).forEach(b => b.onclick = () => { state.filesPath = b.dataset.projFolder; go('files'); });
    bindQuickChips(body);
    $$('[data-open-url]', body).forEach(b => b.onclick = e => { e.stopPropagation(); if (b.dataset.openUrl) window.open(b.dataset.openUrl, '_blank', 'noopener'); });
    $$('[data-proj-run]', body).forEach(b => b.onclick = () => portholerunDialog(join(b.dataset.projRun, '.platorun')));
    $$('[data-proj-menu]', body).forEach(b => b.onclick = () => projectMenu(s.projects[Number(b.dataset.projMenu)], s));
    $$('.ico.logo img, .ico.fav img', body).forEach(img => img.addEventListener('error', () => { const sp = img.parentElement; if (!sp) return; sp.classList.remove('fav', 'logo'); sp.innerHTML = icon(img.dataset.fb || 'container'); }, { once: true }));
    $$('[data-live]', body).forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await api(`/api/live/${encodeURIComponent(b.dataset.p)}/${b.dataset.k}/${b.dataset.live}`, { method: 'POST' }); toast(b.dataset.live === 'stop' ? 'Stopped' : r?.tookOver ? `Started (took over from "${r.tookOver}")` : 'Started'); } catch (ex) { toast(ex.message, true); } loadServices(); });
    $$('[data-live-page]', body).forEach(b => b.onclick = () => livePage(s.live.find(p => p.project === b.dataset.livePage), b.dataset.k));
    $$('[data-live-errors]', body).forEach(b => b.onclick = () => { const p = s.live.find(x => x.project === b.dataset.liveErrors); openDialog(`<h2>${icon('info')}${esc(p.name)} · ${esc(p.file || 'PORTHOLE.md')}</h2>${p.errors.map(e => `<p class="muted" style="color:var(--flare)">${esc(e)}</p>`).join('')}${p.warnings.map(w => `<p class="sub">${esc(w)}</p>`).join('')}<p class="sub">Ask the agent in that project to fix it and run <span class="mono">live check</span>.</p><div class="buttons"><button data-close>Close</button></div>`); });
    $$('[data-srv]', body).forEach(b => b.onclick = async () => { b.disabled = true; try { await api(`/api/servers/${b.dataset.slug}/${b.dataset.srv}`, { method: 'POST' }); toast(b.dataset.srv === 'stop' ? 'Stopped' : 'Started'); } catch (ex) { toast(ex.message, true); } loadServices(); });
    $$('[data-srv-menu]', body).forEach(b => b.onclick = () => serverMenu(s.servers.find(x => x.slug === b.dataset.srvMenu)));
    $$('[data-register]', body).forEach(b => b.onclick = () => registerServerDialog(Number(b.dataset.register), b.dataset.label));
    $$('[data-unshare]', body).forEach(b => b.onclick = async () => { try { await api(`/api/tunnels/${b.dataset.unshare}`, { method: 'DELETE' }); toast('Link closed'); loadServices(); } catch (ex) { toast(ex.message, true); } });
    $$('[data-link-menu]', body).forEach(b => b.onclick = () => linkMenu(s.links.find(t => t.port === Number(b.dataset.linkMenu))));
    $$('[data-cact]', body).forEach(b => b.onclick = () => containerAction(b.dataset.c, b.dataset.cact));
    $$('[data-clogs]', body).forEach(b => b.onclick = () => logsSheet(b.dataset.clogs));
    $$('.ico.fav img, .ico.logo img', body).forEach(img => img.addEventListener('error', () => { const sp = img.parentElement; if (!sp) return; sp.classList.remove('fav', 'logo'); sp.innerHTML = icon(img.dataset.fb || 'container'); }));
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

// The page for one live service: state, address, actions as buttons, links, credentials, log.
async function livePage(p, key) {
    const v = p?.services.find(x => x.key === key); if (!v) return;
    const allCreds = await api('/api/creds').catch(() => []);
    const shared = v.port ? allCreds.filter(c => c.port === v.port) : [];
    const base = v.host?.url || null;
    const { panel, close } = openDialog(`<h2>${icon(v.worker ? 'cpu' : 'globe')}${esc(v.title)}</h2>
        <p class="muted">${esc(p.name)}${p.summary ? ` · ${esc(p.summary)}` : ''}</p>
        <p class="sub">${v.running ? '<span class="live">● running</span>' : 'stopped'}${v.port ? ` · <span class="mono">:${v.port}</span>` : ' · worker'}${p.commit ? ` · <span class="mono">${esc(p.commit)}</span>` : ''}${v.update ? ` · updates: ${esc(v.update)}` : ''}</p>
        <p class="sub">${v.runAs === 'root' ? '<span class="tag danger">runs as root</span> approved for these exact commands · <button class="linkish" data-a="unroot">Revoke</button>' : v.runAs === 'blocked' ? '' : `Runs as <span class="mono">${esc(v.account || 'its own account')}</span>, an account for this project only: no logins, no PlatOpypus access, no other project. ${v.vaultNames.length ? `Vault: only ${v.vaultNames.map(esc).join(', ')}.` : 'No Vault values.'} PlatOpypus controls it as root.${v.firewall && v.firewall.ok === false ? `<br><span class="warn">${esc(v.firewall.detail)}</span>` : ''}`}</p>
        ${v.runAs === 'blocked' ? `<div class="banner danger" style="margin:10px 0"><b>This service asks to run as root.</b> PORTHOLE.md says <span class="mono">run_as: root</span>. Root can read every secret on the box, so only allow it if the app really needs it (binding a low port, Docker). The approval covers the start command, every action and the project's code as they are now; if any of them changes, it asks again.<div class="buttons"><button class="danger" data-a="root">Allow as root</button></div></div>` : ''}
        <div class="menu">
          ${v.running ? `<button data-a="stop">${icon('stop')}Stop</button><button data-a="restart">${icon('restart')}Restart</button>` : `<button data-a="start">${icon('play')}Start</button>`}
          ${v.host ? `<a class="row" href="${esc(openLink(v.host.url, v.port, allCreds))}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">${icon('external')}<span>${esc(v.host.hostname)}${v.host.live ? '' : ' · setting up'}</span></a>` : v.hostname ? `<button data-a="hostname">${icon('globe')}Put on ${esc(v.hostname)}<span class="sub" style="margin-left:6px">DNS + nginx + certificate</span></button>` : v.port ? `<button data-a="share">${icon('share')}Share…</button>` : ''}
          ${v.image ? `<button data-a="pull">${icon('cloud-down')}Update image</button>` : ''}
          <button data-a="backup">${icon('cloud-up')}Back up now</button><button data-a="backups">${icon('history')}Backups…</button>
          <button data-a="logs">${icon('logs')}Log</button>
        </div>
        ${v.image ? `<p class="sub" style="margin-top:8px">Container <span class="mono">${esc(v.image)}</span> · the app runs as <span class="mono">${esc(v.account || '')}</span> inside it, with its data folders from this project, reachable from this box only.</p>` : ''}
        ${v.actions.length || v.groups?.length ? `<h3 class="section" style="margin-top:14px">Actions<button class="act" data-pinpick>${icon('pin')}Pin to Home…</button></h3>` : ''}
        ${v.actions.length ? `<div class="chips" style="flex-wrap:wrap">${v.actions.map(a => `<button class="pill" data-act="${a.i}" data-confirm="${a.confirm ? 1 : 0}">${icon('zap')}${esc(a.label)}${a.inputs.length ? '…' : ''}</button>`).join('')}</div><pre data-act-out hidden style="max-height:30vh;margin-top:8px"></pre>` : ''}
        ${(v.groups || []).map(g => `<details class="group" data-group="${g.i}"><summary><span class="ico brass">${icon('package')}</span><span class="gl">${esc(g.label)}</span><span class="meta" data-gcount>${g.hint ? esc(g.hint) : ''}</span>${icon('chevron', 'i chev')}</summary><div class="list" data-gitems><p class="muted" style="padding:10px 12px">Loading…</p></div></details>`).join('')}
        ${v.links.length && base ? `<h3 class="section" style="margin-top:14px">Links</h3><div class="chips" style="flex-wrap:wrap">${v.links.map(l => `<a class="pill" href="${esc(base.replace(/\/$/, '') + (l.path.startsWith('/') ? l.path : '/' + l.path))}" target="_blank" rel="noopener">${icon('external')}${esc(l.label)}</a>`).join('')}</div>` : ''}
        ${v.credentials.length || shared.length ? `<h3 class="section" style="margin-top:14px">Credentials</h3><div class="list">
          ${v.credentials.map((c, i) => `<button class="row" data-cred="${i}"><span class="ico brass">${icon('key')}</span><div class="main"><div class="title">${esc(c.label)}<span class="tag dim">service</span></div><div class="sub">${esc(c.fields.map(f => f.label).join(' · '))}</div></div>${icon('chevron', 'i chev')}</button>`).join('')}
          ${shared.map(c => `<button class="row" data-shared="${esc(c.id)}"><span class="ico kelp">${icon('key')}</span><div class="main"><div class="title">${esc(c.title)}<span class="tag">from agent</span></div><div class="sub">${esc(c.fields.map(f => f.label).join(' · '))} · ${fmtAgo(c.at)}</div></div>${icon('chevron', 'i chev')}</button>`).join('')}</div>` : ''}
        ${p.warnings.length ? `<p class="sub" style="margin-top:12px">${p.warnings.map(esc).join('<br>')}</p>` : ''}
        <div class="buttons"><button data-close>Close</button></div>`);
    const url = a => `/api/live/${encodeURIComponent(p.project)}/${key}/${a}`;
    const refresh_ = async () => { close(); await loadServices(); const fresh = (await api('/api/services')).live?.find(x => x.project === p.project); if (fresh) livePage(fresh, key); };
    $$('[data-a]', panel).forEach(b => b.onclick = async () => {
        const a = b.dataset.a;
        try {
            if (a === 'start' || a === 'stop' || a === 'restart') { b.disabled = true; const r = await api(url(a), { method: 'POST' }); toast(a === 'stop' ? 'Stopped' : r?.tookOver ? `Started (took over from "${r.tookOver}")` : a === 'restart' ? 'Restarted' : 'Started'); return refresh_(); }
            if (a === 'root') { if (!(await confirmDialog({ title: `Run ${v.title} as root?`, text: 'Its start command and every action run with full control of the box, until they or the project’s code change.', action: 'Allow as root' }))) return; await api(url('root'), { method: 'POST' }); toast('Allowed as root'); return refresh_(); }
            if (a === 'backup') { b.disabled = true; b.textContent = 'Backing up…'; const r = await api(`/api/backups/${encodeURIComponent(p.project)}`, { method: 'POST' }); toast(`Backed up ${(r.size / 1048576).toFixed(1)} MB in ${(r.ms / 1000).toFixed(0)} s`); return refresh_(); }
            if (a === 'backups') { close(); return backupsDialog(p.project, () => livePage(p, key)); }
            if (a === 'pull') { b.disabled = true; b.textContent = 'Pulling…'; const r = await api(url('pull'), { method: 'POST' }); toast(r.changed ? (r.restarted ? 'New image pulled and restarted' : 'New image pulled; start it to use it') : 'Already the latest image'); return refresh_(); }
            if (a === 'unroot') { await api(url('root'), { method: 'DELETE' }); toast('Root revoked; restart it to run as porthole-svc'); return refresh_(); }
            if (a === 'hostname') {
                b.disabled = true; b.textContent = 'Creating DNS record, nginx block and certificate…';
                try { await api(url('hostname'), { method: 'POST' }); }
                catch (ex) {
                    if (ex.status !== 409 || !/already points at/.test(ex.message)) throw ex;
                    b.disabled = false; b.textContent = 'Put on hostname';
                    if (!(await confirmDialog({ title: `Move ${v.hostname} to this box?`, text: `${ex.message} Its current records are removed and the name points here; whatever answers there now stops being reachable at this name.`, action: 'Move it here' }))) return;
                    b.disabled = true; b.textContent = 'Moving the name here…';
                    await api(url('hostname'), { method: 'POST', body: { takeOver: true } });
                }
                toast(`${v.hostname} is set up`); return refresh_();
            }
            if (a === 'share') { close(); return shareDialog(v.port, v.title); }
            if (a === 'logs') { const res = await api(url('logs') + '?tail=400', { raw: true }); const text = await res.text(); close(); const d = openDialog(`<h2>${esc(v.title)} · log</h2><pre style="max-height:60vh">${esc(text || '(empty — start the service first)')}</pre><div class="buttons"><button data-copy-all>${icon('copy')}Copy</button><button data-close>Close</button></div>`); $('[data-copy-all]', d.panel).onclick = () => copyText(text, 'Copied'); }
        } catch (ex) { toast(ex.message, true); b.disabled = false; }
    });
    $$('[data-act]', panel).forEach(b => b.onclick = async () => {
        const act = v.actions[Number(b.dataset.act)];
        let inputs = {};
        if (act?.inputs?.length) { inputs = await actionInputsDialog(act, v.title); if (!inputs) return; }
        else if (b.dataset.confirm === '1' && !(await confirmDialog({ title: `Run "${b.textContent.trim()}"?`, text: `In ${p.name}.${act?.restarts ? ' The service is restarted.' : ''} Output appears here and in the service log.`, action: 'Run', danger: false }))) return livePage(p, key);
        const out = $('[data-act-out]', panel); if (out) { out.hidden = false; out.textContent = 'Running…'; }
        $$('[data-act]', panel).forEach(x => { x.disabled = true; });
        try { const r = await api(url(`actions/${b.dataset.act}`), { method: 'POST', body: { inputs } }); const o = $('[data-act-out]', panel); if (o) o.textContent = `${r.label} · exit ${r.code} · ${(r.ms / 1000).toFixed(1)} s\n\n${r.output || '(no output)'}`; }
        catch (ex) { toast(ex.message, true); }
        $$('[data-act]', panel).forEach(x => { x.disabled = false; });
    });
    $$('[data-cred]', panel).forEach(b => b.onclick = async () => {
        try { const c = await api(url(`credentials/${b.dataset.cred}`), { method: 'POST' }); close(); credPanel([{ id: `svc-${key}-${b.dataset.cred}`, title: c.label, project: p.project, note: c.fields.some(f => f.missing) ? `Missing in the Vault: ${c.fields.filter(f => f.missing).map(f => f.ref).join(', ')}` : null, fields: c.fields.filter(f => !f.missing).map(f => ({ label: f.label, value: f.value, secret: f.secret })), openUrl: base, at: Date.now() }]); }
        catch (ex) { toast(ex.message, true); }
    });
    $$('[data-shared]', panel).forEach(b => b.onclick = () => { close(); openSharedCred(b.dataset.shared); });
    $$('details.group', panel).forEach(d => d.addEventListener('toggle', () => {
        if (!d.open || d.dataset.loaded) return;
        d.dataset.loaded = '1';
        fillGroupList(d, { p, key, v, g: v.groups[Number(d.dataset.group)], url });
    }));
    const pp = $('[data-pinpick]', panel); if (pp) pp.onclick = () => pinPicker({ p, key, v, url });
}

// The command sheet for one item of a group (or for all of them): the group's actions as buttons, output below.
function groupItemSheet(r, output = null, { last = null, busy = false } = {}) {
    const { p, key, v, g, items, item, url } = r;
    const all = !item;
    const acts = g.actions.filter(a => !all || a.all);
    const name = all ? `All ${items.length} ${g.item}s` : (item.label || item.id);
    const t = all ? null : { kind: 'item', project: p.project, key, group: g.label, item: item.id, itemLabel: item.label || null };
    const { panel, close } = openDialog(`<h2>${icon('package')}${esc(name)}</h2>
        <p class="muted">${esc(g.label)} · ${esc(v.title)}${all ? '' : ` · <span class="mono">${esc(item.id)}</span>`}${item?.sub ? `<br>${esc(item.sub)}` : ''}</p>
        ${t ? sheetTools(t) : ''}
        <div class="chips" style="flex-wrap:wrap">${acts.map(a => `<button class="pill${a.label === last ? ' ghost-kelp' : ''}" data-ga="${a.i}" ${busy ? 'disabled' : ''}>${icon('zap')}${esc(a.label)}${a.inputs.length ? '…' : ''}</button>`).join('')}</div>
        <pre data-ga-out ${output ? '' : 'hidden'} style="max-height:40vh;margin-top:10px">${output ? esc(output) : ''}</pre>
        <div class="buttons"><button data-glist>${icon('back')}All ${esc(g.item)}s</button><button data-back>${icon('globe')}${esc(v.title)}</button><button data-close>Close</button></div>`);
    if (t) { rememberSheet(t); bindSheetTools(panel, t); }
    $('[data-glist]', panel).onclick = () => groupSheet(r);
    $('[data-back]', panel).onclick = () => { close(); backToService(r); };
    $$('[data-ga]', panel).forEach(b => b.onclick = async () => {
        const a = g.actions[Number(b.dataset.ga)];
        let inputs = {};
        if (a.inputs.length) { inputs = await actionInputsDialog(a, name); if (!inputs) return groupItemSheet(r, output, { last }); }
        else if ((a.confirm || all) && !(await confirmDialog({ title: `${a.label}: ${name}?`, text: all ? `Runs once for each of the ${items.length} ${g.item}s, one after another.${a.restarts ? ' The service restarts once at the end.' : ''}` : `${g.label} · ${item.id}${a.restarts ? '. The service is restarted.' : ''}`, action: 'Run', danger: false }))) return groupItemSheet(r, output, { last });
        groupItemSheet(r, `${a.label}: running…`, { last: a.label, busy: true });
        if (!all) noteItemUse(r, item.id);
        let text;
        try {
            const x = await api(url(`groups/${g.i}/actions/${a.i}`), { method: 'POST', body: { item: all ? '*' : item.id, inputs } });
            text = `${x.label} · ${x.items > 1 ? `${x.items} ${g.item}s${x.failed ? `, ${x.failed} failed` : ''}` : `exit ${x.code}`} · ${(x.ms / 1000).toFixed(1)} s\n\n${x.output || '(no output)'}`;
        } catch (ex) { text = ex.message; toast(ex.message, true); }
        loadQuick().catch(() => {});
        groupItemSheet(r, text, { last: a.label });
    });
}

// ---------- pins and recents ----------
// A pin points at a service action, a whole group, or one item (a room); recents are the last commands run.
// Both live on the box (/api/quick). Opening one goes through the same sheets, confirmations and item checks
// as the service page: a pin is a shortcut, never a way round them.
var liveSeen = [];   // var: read by cards rendered before loadServices assigns it
let quickCache = { pins: [], recents: [] };
let quickEditing = false;
async function loadQuick() { quickCache = await api('/api/quick').catch(() => quickCache); return quickCache; }
const sameTarget = (a, b) => a.kind === b.kind && a.project === b.project && a.key === b.key && (a.group || null) === (b.group || null) && (a.item || null) === (b.item || null) && (a.kind !== 'action' || a.action === b.action);
const pinOf = t => quickCache.pins.find(x => sameTarget(x, t));
const targetName = t => t.kind === 'action' ? t.action : t.kind === 'group' ? t.group : (t.itemLabel || t.item);
const targetIcon = t => t.kind === 'action' ? 'zap' : t.kind === 'group' ? 'package' : 'activity';
async function togglePin(t) {
    const have = pinOf(t);
    try {
        if (have) { await api(`/api/quick/pins/${have.id}`, { method: 'DELETE' }); toast('Removed from Home'); }
        else { await api('/api/quick/pins', { method: 'POST', body: t }); toast('Pinned to Home'); }
    } catch (ex) { toast(ex.message, true); }
    await loadQuick(); renderNavPins();
    return !!pinOf(t);
}
// Finds what a target points at now. Null when the service, action or group is gone from PORTHOLE.md.
function resolveTarget(t, live = liveSeen) {
    const p = (live || []).find(x => x.project === t.project);
    const v = p?.services.find(x => x.key === t.key);
    if (!v) return null;
    const url = a => `/api/live/${encodeURIComponent(p.project)}/${v.key}/${a}`;
    if (t.kind === 'action') { const a = v.actions.find(x => x.label === t.action); return a ? { p, key: v.key, v, a, url } : null; }
    const g = (v.groups || []).find(x => x.label === t.group);
    return g ? { p, key: v.key, v, g, url } : null;
}
// Small Pin / Copy link row used by the sheets.
function sheetTools(t) {
    const on = !!pinOf(t);
    return `<div class="sheet-tools"><button class="pill sm ${on ? 'ghost-kelp' : 'ghost'}" data-pin-toggle aria-pressed="${on}">${icon('pin')}<span>${on ? 'Pinned' : 'Pin to Home'}</span></button><button class="pill sm ghost" data-copy-target>${icon('link')}Copy link</button></div>`;
}
function bindSheetTools(panel, t) {
    const b = $('[data-pin-toggle]', panel);
    if (b) b.onclick = async () => { b.disabled = true; const on = await togglePin(t); b.disabled = false; b.classList.toggle('ghost-kelp', on); b.classList.toggle('ghost', !on); b.setAttribute('aria-pressed', String(on)); $('span', b).textContent = on ? 'Pinned' : 'Pin to Home'; };
    const c = $('[data-copy-target]', panel);
    if (c) c.onclick = () => copyText(targetLink(t), 'Link copied: it opens this sheet after sign-in');
}
// A link that opens the sheet (never runs anything by itself). Add it to the iPhone home screen for a one-tap room.
const targetLink = t => `${location.origin}/#do=${encodeURIComponent(JSON.stringify({ kind: t.kind, project: t.project, key: t.key, action: t.action || undefined, group: t.group || undefined, item: t.item || undefined, itemLabel: t.itemLabel || undefined }))}`;

// Keep your place: the open sheet is remembered for a few minutes, so a reload (iOS does this when you switch away)
// brings it back. Any other dialog, or closing it, forgets it.
const SHEET_KEY = 'porthole.sheet', SHEET_TTL = 10 * 60_000;
function rememberSheet(t) { try { localStorage.setItem(SHEET_KEY, JSON.stringify({ t, at: Date.now() })); } catch { /* private mode */ } }
function forgetSheet() { try { localStorage.removeItem(SHEET_KEY); } catch { /* private mode */ } }
function validTarget(t) { return t && ['action', 'group', 'item'].includes(t.kind) && typeof t.project === 'string' && typeof t.key === 'string' && (t.kind === 'action' ? typeof t.action === 'string' : typeof t.group === 'string') && (t.kind !== 'item' || typeof t.item === 'string'); }
async function resumeSheet() {
    let t = null;
    const m = location.hash.match(/^#do=(.+)$/);
    if (m) { try { t = JSON.parse(decodeURIComponent(m[1])); } catch { t = null; } history.replaceState(null, '', location.pathname + location.search); }
    else { try { const r = JSON.parse(localStorage.getItem(SHEET_KEY) || 'null'); if (r && Date.now() - r.at < SHEET_TTL) t = r.t; } catch { t = null; } }
    if (!validTarget(t)) return;
    await loadQuick();
    openTarget(t, { run: false });
}

// Opens what a pin, recent, card chip or link points at. run: a pinned action or a card chip runs straight away
// (its confirmation and inputs still come first); recents and links only open the sheet.
async function openTarget(t, { run = false } = {}) {
    const s = await api('/api/services').catch(() => null);
    if (s) liveSeen = s.live || [];
    const r = resolveTarget(t);
    if (!r) return goneTarget(t, `${targetName(t)} is no longer in ${t.project}'s PORTHOLE.md.`);
    if (t.kind === 'action') return actionSheet(r, { run });
    if (t.kind === 'group') return groupSheet(r);
    let res;
    try { res = await api(r.url(`groups/${r.g.i}`)); } catch (ex) { return toast(ex.message, true); }
    const items = res.items || [];
    const item = items.find(x => x.id === t.item);
    if (!item) return goneTarget(t, `${t.itemLabel || t.item} is not in ${r.g.label} any more${res.error ? ` (the list failed: ${res.error})` : ''}.`, r);
    groupItemSheet({ ...r, items, item }, null, { last: t.action || null });
}
function goneTarget(t, text, r = null) {
    const pin = pinOf(t);
    const { panel, close } = openDialog(`<h2>${icon(targetIcon(t))}${esc(targetName(t))}</h2><p class="muted">${esc(text)}</p>
        <div class="buttons">${r ? `<button class="primary" data-glist>${icon('package')}${esc(r.g.label)}</button>` : ''}${pin ? `<button data-unpin>${icon('x')}Remove the pin</button>` : ''}<button data-close>Close</button></div>`, { size: 'small' });
    const gl = $('[data-glist]', panel); if (gl) gl.onclick = () => groupSheet(r);
    const u = $('[data-unpin]', panel); if (u) u.onclick = async () => { await togglePin(t); close(); loadHomeQuick().catch(() => {}); };
}
async function backToService(r) {
    const fresh = (await api('/api/services').catch(() => ({}))).live?.find(x => x.project === r.p.project);
    livePage(fresh || r.p, r.key);
}

// One plain action on its own: Run (again), output, pin.
function actionSheet(r, { run = false, output = null, busy = false } = {}) {
    const { p, key, v, a, url } = r;
    const t = { kind: 'action', project: p.project, key, action: a.label };
    const { panel, close } = openDialog(`<h2>${icon('zap')}${esc(a.label)}</h2>
        <p class="muted">${esc(svcLine(p, v))}${a.restarts ? ' · restarts the service' : ''}${a.confirm ? ' · asks first' : ''}</p>
        ${sheetTools(t)}
        <div class="chips"><button class="pill kelp" data-run ${busy ? 'disabled' : ''}>${icon('play')}${output && !busy ? 'Run again' : 'Run'}${a.inputs.length ? '…' : ''}</button></div>
        <pre data-out ${output ? '' : 'hidden'} style="max-height:45vh;margin-top:10px">${output ? esc(output) : ''}</pre>
        <div class="buttons"><button data-back>${icon('globe')}${esc(v.title)}</button><button data-close>Close</button></div>`);
    rememberSheet(t); bindSheetTools(panel, t);
    $('[data-back]', panel).onclick = () => { close(); backToService(r); };
    const go_ = async () => {
        let inputs = {};
        if (a.inputs.length) { inputs = await actionInputsDialog(a, v.title); if (!inputs) return actionSheet(r, { output }); }
        else if (a.confirm && !(await confirmDialog({ title: `Run "${a.label}"?`, text: `In ${p.name}.${a.restarts ? ' The service is restarted.' : ''} Output appears here and in the service log.`, action: 'Run', danger: false }))) return actionSheet(r, { output });
        actionSheet(r, { output: `${a.label}: running…`, busy: true });
        let text;
        try { const x = await api(url(`actions/${a.i}`), { method: 'POST', body: { inputs } }); text = `${x.label} · exit ${x.code} · ${(x.ms / 1000).toFixed(1)} s\n\n${x.output || '(no output)'}`; }
        catch (ex) { text = ex.message; toast(ex.message, true); }
        loadQuick().catch(() => {});
        actionSheet(r, { output: text });
    };
    $('[data-run]', panel).onclick = go_;
    if (run) go_();
}

// A whole group on its own sheet: the item list, recently used first.
function groupSheet(r) {
    const { p, key, v, g } = r;
    const t = { kind: 'group', project: p.project, key, group: g.label };
    const { panel, close } = openDialog(`<h2>${icon('package')}${esc(g.label)}<span class="meta" data-gcount style="margin-left:8px"></span></h2>
        <p class="muted">${esc(svcLine(p, v))}${g.hint ? ` · ${esc(g.hint)}` : ''}</p>
        ${sheetTools(t)}
        <div class="list" data-gitems><p class="muted" style="padding:10px 12px">Loading…</p></div>
        <div class="buttons"><button data-glist-refresh>${icon('refresh')}Refresh</button><button data-back>${icon('globe')}${esc(v.title)}</button><button data-close>Close</button></div>`);
    rememberSheet(t); bindSheetTools(panel, t);
    $('[data-back]', panel).onclick = () => { close(); backToService(r); };
    $('[data-glist-refresh]', panel).onclick = () => groupSheet(r);
    fillGroupList(panel, r);
}
const svcLine = (p, v) => v.title.toLowerCase() === p.name.toLowerCase() ? v.title : `${v.title} · ${p.name}`;
// Recently used items per group, so the rooms you work with sit at the top: this device's picks first, then the
// box's recent runs (from any device).
const itemUseKey = r => `porthole.gi.${r.p.project}/${r.key}/${r.g.label}`;
function recentItemIds(r) {
    let mine = [];
    try { mine = JSON.parse(localStorage.getItem(itemUseKey(r)) || '[]'); } catch { mine = []; }
    const box = quickCache.recents.filter(x => x.kind === 'item' && x.project === r.p.project && x.key === r.key && x.group === r.g.label).map(x => x.item);
    return [...new Set([...mine, ...box])];
}
function noteItemUse(r, id) { try { const mine = JSON.parse(localStorage.getItem(itemUseKey(r)) || '[]'); localStorage.setItem(itemUseKey(r), JSON.stringify([id, ...mine.filter(x => x !== id)].slice(0, 12))); } catch { /* private mode */ } }
async function fillGroupList(host, r) {
    const { g } = r;
    if (!quickCache.recents.length) await loadQuick();
    const box = $('[data-gitems]', host);
    let res;
    try { res = await api(r.url(`groups/${g.i}`)); } catch (ex) { box.innerHTML = `<p class="sub warn" style="padding:8px 12px">${esc(ex.message)}</p>`; return; }
    const items = res.items || [];
    const cnt = $('[data-gcount]', host); if (cnt) cnt.textContent = `${items.length}`;
    const recent = recentItemIds(r);
    const rank = it => { const n = recent.indexOf(it.id); return n < 0 ? 1e6 : n; };
    const order = items.map((it, n) => ({ it, n })).sort((a, b) => rank(a.it) - rank(b.it) || a.n - b.n);
    const allOk = g.actions.some(a => a.all);
    box.innerHTML = (res.error ? `<p class="sub warn" style="padding:8px 12px">${esc(res.error)}</p>` : '')
        + (items.length > 8 ? `<div class="gfilter"><input type="search" data-gfilter placeholder="Filter ${esc(g.item)}s" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></div>` : '')
        + (!items.length ? `<p class="muted" style="padding:10px 12px">No ${esc(g.item)}s right now.</p>` : '')
        + (items.length > 1 && allOk ? `<button class="row" data-gi="*"><span class="ico kelp">${icon('package')}</span><div class="main"><div class="title">All ${items.length} ${esc(g.item)}s</div><div class="sub">Run one command on every ${esc(g.item)}</div></div>${icon('chevron', 'i chev')}</button>` : '')
        + order.map(({ it, n }) => `<button class="row" data-gi="${n}" data-text="${esc(`${it.id} ${it.label || ''} ${it.sub || ''}`.toLowerCase())}"><span class="ico ${rank(it) < 1e6 ? 'brass' : 'dim'}">${icon(rank(it) < 1e6 ? 'history' : 'activity')}</span><div class="main"><div class="title ${it.label ? '' : 'mono'}">${esc(it.label || it.id)}${pinOf({ kind: 'item', project: r.p.project, key: r.key, group: g.label, item: it.id }) ? `<span class="tag">${icon('pin')}pinned</span>` : ''}</div>${it.label || it.sub ? `<div class="sub"><span class="mono">${esc(it.id)}</span>${it.sub ? ` · ${esc(it.sub)}` : ''}</div>` : ''}</div>${icon('chevron', 'i chev')}</button>`).join('');
    $$('[data-gi]', box).forEach(row => row.onclick = () => groupItemSheet({ ...r, items, item: row.dataset.gi === '*' ? null : items[Number(row.dataset.gi)] }));
    const f = $('[data-gfilter]', box);
    if (f) f.oninput = () => { const q = f.value.trim().toLowerCase(); $$('[data-gi]', box).forEach(row => { row.hidden = !!q && (row.dataset.gi === '*' || !row.dataset.text.includes(q)); }); };
}
// Pick what to pin from one service: its actions and its groups (single items are pinned from their sheet).
function pinPicker({ p, key, v, url }) {
    const rows = [
        ...v.actions.map(a => ({ t: { kind: 'action', project: p.project, key, action: a.label }, sub: a.inputs.length ? 'asks for values' : a.confirm ? 'asks first' : 'runs in one tap' })),
        ...(v.groups || []).map(g => ({ t: { kind: 'group', project: p.project, key, group: g.label }, sub: `opens the ${g.item} list` })),
    ];
    const { panel } = openDialog(`<h2>${icon('pin')}Pin to Home</h2><p class="muted">${esc(v.title)} · pinned commands sit at the top of Home${railMq.matches ? ' and in the sidebar' : ''}. To pin one ${esc(v.groups?.[0]?.item || 'item')}, open it and tap Pin.</p>
        <div class="list">${rows.map((x, n) => `<button class="row" data-pk="${n}"><span class="ico ${pinOf(x.t) ? 'brass' : 'dim'}">${icon(targetIcon(x.t))}</span><div class="main"><div class="title">${esc(targetName(x.t))}</div><div class="sub">${esc(x.sub)}</div></div><span class="pill sm ${pinOf(x.t) ? 'ghost-kelp' : 'ghost'}" data-pk-state>${pinOf(x.t) ? 'Pinned' : 'Pin'}</span></button>`).join('')}</div>
        <div class="buttons"><button data-back>${icon('back')}${esc(v.title)}</button><button data-close>Done</button></div>`);
    $('[data-back]', panel).onclick = () => backToService({ p, key });
    $$('[data-pk]', panel).forEach(b => b.onclick = async () => {
        b.disabled = true; const x = rows[Number(b.dataset.pk)]; const on = await togglePin(x.t); b.disabled = false;
        const st = $('[data-pk-state]', b); st.textContent = on ? 'Pinned' : 'Pin'; st.classList.toggle('ghost-kelp', on); st.classList.toggle('ghost', !on);
        $('.ico', b).classList.toggle('brass', on); $('.ico', b).classList.toggle('dim', !on);
    });
}

// Home: Pinned tiles and the Recent list.
async function loadHomeQuick(s = null) {
    const host = $('#home-pinned'); if (!host) return;
    const q = await loadQuick();
    if (s) liveSeen = s.live || [];
    renderNavPins();
    if (!q.pins.length && !q.recents.length) { host.innerHTML = ''; quickEditing = false; return; }
    const svcName = t => { const p = liveSeen.find(x => x.project === t.project); const v = p?.services.find(x => x.key === t.key); return v ? (p.services.length > 1 ? `${p.name} · ${v.title}` : p.name) : t.project; };
    const pinSub = t => t.kind === 'item' ? `${t.group} · ${svcName(t)}` : svcName(t);
    const recentTitle = t => `${t.action || targetName(t)}${t.kind === 'item' ? ` · ${t.itemLabel || t.item}` : t.kind === 'group' ? ` · every ${t.group.toLowerCase()}` : ''}`;
    host.innerHTML = (q.pins.length ? `<h2 class="section"><span class="bullet brass"></span>Pinned<button class="act" data-qedit>${quickEditing ? 'Done' : 'Edit'}</button></h2>
        <div class="qtiles${quickEditing ? ' editing' : ''}">${q.pins.map((t, n) => { const ok = !!resolveTarget(t); return `<button class="qtile${ok ? '' : ' gone'}" data-qpin="${n}" title="${esc(targetName(t))} · ${esc(pinSub(t))}"><span class="ico ${t.kind === 'action' ? 'kelp' : 'brass'}">${icon(targetIcon(t))}</span><span class="qt ${t.kind === 'item' && !t.itemLabel ? 'mono' : ''}">${esc(targetName(t))}</span><span class="qs">${ok ? esc(pinSub(t)) : 'gone'}</span>${quickEditing ? `<span class="qx" aria-label="Remove">${icon('x')}</span>` : ''}</button>`; }).join('')}</div>` : '')
        + (q.recents.length ? `<h2 class="section"><span class="bullet"></span>Recent<button class="act" data-qclear>Clear</button></h2>
        <div class="list">${q.recents.slice(0, 5).map((t, n) => `<button class="row" data-qrecent="${n}"><span class="ico dim">${icon('history')}</span><div class="main"><div class="title">${esc(recentTitle(t))}</div><div class="sub">${esc(svcName(t))} · ${fmtAgo(t.at)}${t.code ? ' · <span class="warn">failed</span>' : ''}</div></div>${icon('chevron', 'i chev')}</button>`).join('')}</div>` : '');
    const e = $('[data-qedit]', host); if (e) e.onclick = () => { quickEditing = !quickEditing; loadHomeQuick(); };
    $$('[data-qpin]', host).forEach(b => b.onclick = async () => {
        const t = q.pins[Number(b.dataset.qpin)];
        if (quickEditing) { b.disabled = true; await togglePin(t); return loadHomeQuick(); }
        openTarget(t, { run: true });
    });
    $$('[data-qrecent]', host).forEach(b => b.onclick = () => openTarget(q.recents[Number(b.dataset.qrecent)], { run: false }));
    const c = $('[data-qclear]', host); if (c) c.onclick = async () => { await api('/api/quick/recents', { method: 'DELETE' }).catch(ex => toast(ex.message, true)); loadHomeQuick(); };
}
// Desktop sidebar: the same pins, one click away from any page.
function renderNavPins() {
    const wrap = $('#nav-pins-wrap'); if (!wrap) return;
    const pins = quickCache.pins;
    wrap.hidden = !pins.length;
    $('#nav-pins').innerHTML = pins.map((t, n) => `<button data-nav-pin="${n}" title="${esc(targetName(t))} · ${esc(t.kind === 'item' ? `${t.group} · ` : '')}${esc(t.project)}">${icon(targetIcon(t))}<span>${esc(targetName(t))}</span></button>`).join('');
    $$('#nav-pins [data-nav-pin]').forEach(b => b.onclick = () => { navOverlay(false); if (leaveSheets()) return; openTarget(pins[Number(b.dataset.navPin)], { run: true }); });
}
// Cards: a running live service shows its first actions and its groups, so the common commands skip the ⋯ menu.
function quickChips(p, where = 'in-card') {
    const out = [];
    for (const x of p.parts.filter(y => y.type === 'live' && y.running)) {
        const v = liveSeen.find(l => l.project === x.project)?.services.find(y => y.key === x.key);
        if (!v) continue;
        const attrs = (kind, label) => `data-qa-kind="${kind}" data-qa-p="${esc(x.project)}" data-qa-k="${esc(v.key)}" data-qa-l="${esc(label)}"`;
        for (const g of v.groups || []) out.push(`<button class="pill sm ghost-kelp" ${attrs('group', g.label)}>${icon('package')}${esc(g.label)}</button>`);
        for (const a of v.actions.slice(0, 3)) out.push(`<button class="pill sm" ${attrs('action', a.label)}>${icon('zap')}${esc(a.label)}${a.inputs.length ? '…' : ''}</button>`);
        if (v.actions.length > 3) out.push(`<button class="pill sm ghost" data-live-page="${esc(x.project)}" data-k="${esc(v.key)}">+${v.actions.length - 3}</button>`);
    }
    return out.length ? `<div class="pcard-quick ${where}">${out.join('')}</div>` : '';
}
function bindQuickChips(root) {
    $$('[data-qa-kind]', root).forEach(b => b.onclick = e => {
        e.stopPropagation();
        const d = b.dataset, t = { kind: d.qaKind, project: d.qaP, key: d.qaK };
        if (d.qaKind === 'action') t.action = d.qaL; else t.group = d.qaL;
        openTarget(t, { run: d.qaKind === 'action' });
    });
    $$('.pcard-quick [data-live-page]', root).forEach(b => b.onclick = e => { e.stopPropagation(); livePage(liveSeen.find(x => x.project === b.dataset.livePage), b.dataset.k); });
}

// A form for an action's typed inputs. Checks on the phone mirror the server's; the server's check is the one that counts.
function actionInputsDialog(act, title) {
    return new Promise(resolve => {
        const field = (f, i) => {
            const id = `ai-${i}`;
            const lab = `<label for="${id}">${esc(f.label)}${f.required ? '' : ' <span class="sub">(optional)</span>'}</label>`;
            const hint = [f.hint, f.min !== null && f.max !== null ? `${f.min} to ${f.max}` : f.min !== null ? `at least ${f.min}` : f.max !== null ? `at most ${f.max}` : null].filter(Boolean).join(' · ');
            const dv = f.default === null ? '' : String(f.default);
            let ctl;
            if (f.type === 'boolean') ctl = `<label class="check"><input id="${id}" type="checkbox" ${dv === 'true' ? 'checked' : ''}> ${esc(f.label)}</label>`;
            else if (f.type === 'choice') ctl = `${lab}<select id="${id}">${(f.choices || []).map(c => `<option ${c === dv ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
            else ctl = `${lab}<input id="${id}" type="text" inputmode="${f.type === 'integer' ? 'numeric' : f.type === 'number' ? 'decimal' : 'text'}" value="${esc(dv)}" autocorrect="off" autocapitalize="off" spellcheck="false">`;
            return `<div class="field">${ctl}${hint ? `<p class="sub">${esc(hint)}</p>` : ''}<p class="sub err" data-err="${i}" hidden></p></div>`;
        };
        const { panel, close } = openDialog(`<h2>${icon('zap')}${esc(act.label)}</h2><p class="muted">${esc(title)}${act.restarts ? ' · the service is restarted' : ''}</p>${act.inputs.map(field).join('')}<div class="buttons"><button class="primary" data-ok>Run</button><button data-close>Cancel</button></div>`);
        $('.dialog-backdrop').addEventListener('click', () => resolve(null), { once: true });
        $('[data-close]', panel).addEventListener('click', () => resolve(null), { once: true });
        const check = (f, raw) => {
            if (f.type === 'boolean') return null;
            if (raw === '') return f.required ? 'Required.' : null;
            if (f.type === 'integer' && !/^-?\d{1,15}$/.test(raw)) return 'A whole number.';
            if (f.type === 'number' && !/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(raw)) return 'A number.';
            if ((f.type === 'integer' || f.type === 'number') && ((f.min !== null && Number(raw) < f.min) || (f.max !== null && Number(raw) > f.max))) return 'Out of range.';
            if (f.pattern) { try { if (!new RegExp(`^(?:${f.pattern})$`).test(raw)) return f.hint || 'Not in the required format.'; } catch { /* server decides */ } }
            return null;
        };
        const go_ = () => {
            const values = {}; let bad = false;
            act.inputs.forEach((f, i) => {
                const el = $(`#ai-${i}`, panel);
                const raw = f.type === 'boolean' ? (el.checked ? 'true' : 'false') : el.value.trim();
                const e = check(f, raw); const er = $(`[data-err="${i}"]`, panel);
                er.hidden = !e; er.textContent = e || ''; if (e) bad = true;
                values[f.name] = raw;
            });
            if (bad) return;
            close(); resolve(values);
        };
        $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
    });
}

// Before an update: what will change on this box. Plan = migrations of the new release not yet applied here.
function updatePlanDialog(u) {
    return new Promise(resolve => {
        const plan = Array.isArray(u.plan) ? u.plan : null;
        const steps = plan === null ? '<p class="sub">The upgrade plan could not be read; the updater still works it out and logs it before changing anything.</p>'
            : plan.length ? `<p class="muted">This update changes data on the box in ${plan.length} step${plan.length === 1 ? '' : 's'}. PlatOpypus archives its state first and puts it back if any step or the new version fails.</p><div class="list">${plan.map(m => `<div class="row plain"><span class="ico brass">${icon('shield')}</span><div class="main"><div class="title">${esc(m.title)} <span class="tag dim">${esc(m.version)}</span></div><div class="sub">${esc(m.detail || '')}</div></div></div>`).join('')}</div>`
            : '<p class="muted">No data changes: only the app is replaced.</p>';
        const { panel, close } = openDialog(`<h2>${icon('refresh')}Update to ${esc(u.latestVersion)}?</h2>${steps}<p class="sub" style="margin-top:10px">PlatOpypus restarts once. Shells, servers, tunnels, containers, files and the Vault stay as they are; if the new version does not come up healthy, the previous version and its data come back automatically.</p><div class="buttons"><button class="primary" data-ok>Update now</button><button data-close>Cancel</button></div>`);
        $('[data-ok]', panel).onclick = () => { close(); resolve(true); };
        $('.dialog-backdrop').addEventListener('click', () => resolve(false), { once: true });
        $('[data-close]', panel).addEventListener('click', () => resolve(false), { once: true });
    });
}

function serverMenu(d) {
    if (!d) return;
    const { panel, close } = openDialog(`<h2>${icon('devserver')}${esc(d.name)}</h2><p class="muted">${d.cmd ? `<span class="mono">${esc(d.cmd.join(' '))}</span><br>` : d.cmdline ? `<span class="mono">${esc(d.cmdline)}</span><br>` : ''}${d.cwd ? `in ${esc(shortPath(d.cwd))} · ` : ''}pid ${d.pid || '—'}${d.port ? ` · :${d.port}` : ''}</p>
        <div class="menu">${d.log ? `<button data-a="logs">${icon('logs')}Logs</button>` : ''}${d.alive && d.canStart && !d.live ? `<button data-a="restart">${icon('refresh')}Restart</button>` : ''}${d.alive ? `<button data-a="stop">${icon('stop')}Stop (whole process group)</button>` : d.canStart ? `<button data-a="start">${icon('play')}Start</button>` : ''}<button data-a="rm" class="danger">${icon('trash')}Stop and forget</button></div><div class="buttons"><button data-close>Close</button></div>`);
    $$('[data-a]', panel).forEach(b => b.onclick = async () => {
        const a = b.dataset.a; close();
        try {
            if (a === 'logs') { const res = await api(`/api/servers/${d.slug}/logs?tail=400`, { raw: true }); const text = await res.text(); const dlg = openDialog(`<h2>${esc(d.name)} · log</h2><pre style="max-height:60vh">${esc(text || '(empty)')}</pre><div class="buttons"><button data-copy-all>${icon('copy')}Copy</button><button data-close>Close</button></div>`); $('[data-copy-all]', dlg.panel).onclick = () => copyText(text, 'Copied'); return; }
            if (a === 'stop' || a === 'start' || a === 'restart') { await api(`/api/servers/${d.slug}/${a}`, { method: 'POST' }); toast(a === 'stop' ? 'Stopped' : a === 'restart' ? 'Restarted' : 'Started'); }
            if (a === 'rm') { if (!(await confirmDialog({ title: `Forget "${d.name}"?`, text: 'It is stopped first (process group and any public link). Nothing on disk is deleted.', action: 'Stop and forget' }))) return; await api(`/api/servers/${d.slug}`, { method: 'DELETE' }); }
            loadServices();
        } catch (ex) { toast(ex.message, true); }
    });
}
function registerServerDialog(port, label = '') {
    const { panel, close } = openDialog(`<h2>${icon('devserver')}Register port ${port}</h2><p class="muted">Gives this process a name so it can be stopped, shared and tracked as a server. PlatOpypus will not know how to restart it; for that, start it with <span class="mono">svc run</span>.</p>
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
        <div class="buttons"><button class="primary" data-ok>Create link</button><button class="danger" data-zoned>${icon('globe')}Share on your domain…</button><button data-close>Cancel</button></div>`);
    $('[data-zoned]', panel).onclick = () => { close(); zonedDialog(port, label); };
    const go_ = async () => {
        const btn = $('[data-ok]', panel); btn.disabled = true; btn.textContent = 'Connecting to Cloudflare…';
        try { const t = await api('/api/tunnels', { method: 'POST', body: { port, name: $('#sh-label', panel).value } }); close(); toast(t.url ? 'Link is live' : 'Link is being published'); loadServices(); }
        catch (ex) { toast(ex.message, true); btn.disabled = false; btn.textContent = 'Create link'; }
    };
    $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
}
// Permanent hostname on the user's own domain: Cloudflare named tunnel + DNS record (+ nginx block), removed as one.
async function zonedDialog(port, label = '') {
    let pre; try { pre = await api('/api/zoned/prereq'); } catch (ex) { toast(ex.message, true); return; }
    if (!pre.ready) {
        const { panel, close } = openDialog(`<h2>${icon('globe')}Share on your domain</h2><p class="muted">${esc(pre.reason)}</p><div class="buttons"><button class="primary" data-vault>Open the Vault</button><button data-close>Cancel</button></div>`);
        $('[data-vault]', panel).onclick = () => { close(); go('more'); push('vault'); };
        return;
    }
    const suggested = `${(label || `port-${port}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'app'}${pre.apex ? '.' + pre.apex : ''}`;
    const { panel, close } = openDialog(`<h2>${icon('globe')}Share port ${port} on your domain</h2>
        <p class="muted">${pre.mode === 'direct' ? 'Creates a DNS record pointing this name at the box, an nginx server block for it and a Let\'s Encrypt certificate, then serves the port directly, no tunnel. Permanent until you remove it; removing deletes the record, the block and the certificate again.' : `This box has no public address, so the name is served through a named Cloudflare tunnel (${esc(pre.via)}) with a DNS record in your zone. Permanent until you remove it; removing deletes everything again.`}</p>
        <div class="field"><label for="zd-host">Hostname</label><input id="zd-host" type="text" class="mono" value="${esc(suggested)}" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url"></div>
        <div class="field"><label for="zd-label">Label</label><input id="zd-label" type="text" value="${esc(label)}" placeholder="what is it"></div>
        <p class="sub" style="margin:0 2px 8px">Public to anyone who knows the name: make sure the service has its own login.</p>
        <div class="buttons"><button class="danger" data-ok>${icon('globe')}Create hostname</button><button data-close>Cancel</button></div>`);
    const go_ = async () => {
        const btn = $('[data-ok]', panel); btn.disabled = true; btn.textContent = 'Creating tunnel, DNS and proxy…';
        try { const z = await api('/api/zoned', { method: 'POST', body: { port, hostname: $('#zd-host', panel).value.trim(), name: $('#zd-label', panel).value } }); close(); toast(z.connected ? `${z.hostname} is live` : `${z.hostname} created · connecting`); loadServices(); }
        catch (ex) { toast(ex.message, true); btn.disabled = false; btn.innerHTML = `${icon('globe')}Create hostname`; }
    };
    $('[data-ok]', panel).onclick = go_; enterSubmits(panel, go_);
}
function linkMenu(t) {
    if (!t) return;
    if (t.kind === 'zoned') {
        const { panel, close } = openDialog(`<h2 class="mono">${esc(t.hostname)}</h2><p class="muted">${t.connected ? '<span class="live">● live</span>' : t.alive ? 'connecting…' : '<span style="color:var(--flare)">● not serving</span>'} · port ${t.port} · ${esc(t.via || t.mode)}</p>
            <div class="menu"><button data-a="copy">${icon('copy')}Copy link</button><button data-a="remove" class="danger">${icon('trash')}Remove from your domain</button></div><div class="buttons"><button data-close>Close</button></div>`);
        $$('[data-a]', panel).forEach(b => b.onclick = async () => {
            const a = b.dataset.a; close();
            try {
                if (a === 'copy') await copyText(t.url, 'Link copied');
                if (a === 'remove') { if (!(await confirmDialog({ title: `Remove ${t.hostname}?`, text: t.mode === 'direct' ? 'Deletes the DNS record, the nginx block and the certificate. The service itself keeps running.' : 'Deletes the DNS record, the Cloudflare tunnel and the nginx block. The service itself keeps running.', action: 'Remove' }))) return; toast('Removing…'); await api(`/api/zoned/${t.slug}`, { method: 'DELETE' }); toast('Removed'); loadServices(); }
            } catch (ex) { toast(ex.message, true); }
        });
        return;
    }
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
        <button data-a="apps">${icon('package')}Start an app</button>
        <button data-a="image">${icon('container')}Run a Docker image</button>
        <button data-a="shell">${icon('terminal')}Open a shell</button></div><div class="buttons"><button data-close>Cancel</button></div>`);
    $$('[data-a]', panel).forEach(b => b.onclick = () => { close(); if (b.dataset.a === 'share') shareDialog(''); if (b.dataset.a === 'image') runImageDialog(); if (b.dataset.a === 'apps') appsDialog(); if (b.dataset.a === 'shell') newShellDialog(state.filesPath, 'shell'); });
}
// Run any image: look it up first (pull + inspect), then edit what the image declares before starting.
function runImageDialog(prefill = '') {
    const { panel, close } = openDialog(`
        <h2>${icon('container')}Run a container</h2>
        <p class="muted">Type an image. PlatOpypus pulls it and shows its ports, default environment and volumes so you can adjust them before it starts.</p>
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
// Shortcuts above the list: the home folder, and the two folders agents work in.
$$('#files-places [data-place]').forEach(b => b.addEventListener('click', () => loadFiles(b.dataset.place === 'home' ? homeRel : b.dataset.place).catch(ex => toast(ex.status === 404 ? `There is no ${b.dataset.place} folder yet.` : ex.message, true))));
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
    if (data.running?.length || data.items.some(i => i.running?.length)) await loadCreds();
    fsRoot = data.root || '/'; homeRel = data.home || '';
    state.filesPath = data.path; localStorage.setItem('porthole.path', data.path);
    renderCrumbs(data.path);
    $$('#files-places [data-place]').forEach(b => { const p = b.dataset.place === 'home' ? homeRel : b.dataset.place; b.classList.toggle('on', data.path === p || (b.dataset.place !== 'home' && data.path.startsWith(p + '/'))); });
    const items = data.items.filter(i => !i.hidden || showHidden || i.name === '.platorun' || i.name === '.portholerun');
    const runFile = data.items.find(i => (i.name === '.platorun' || i.name === '.portholerun') && i.type === 'file');
    $('#files-empty').hidden = items.length > 0;
    $('#files-title').textContent = data.path ? basename(data.path) : (fsRoot === '/' ? 'Root' : 'Files');
    const up = data.path ? `<button class="row plain" data-up><span class="ico dim">${icon('back')}</span><div class="main"><div class="title mono">..</div><div class="sub">${esc(showPath(parentOf(data.path)))}</div></div></button>` : '';
    // A folder with a .platorun gets its Run card right under the git card.
    const mine = (data.running || []).find(r => r.kind === 'run');
    $('#run-card').innerHTML = !runFile ? '' : mine
        ? `<div class="run-card on"><span class="ico kelp">${icon('activity')}</span><div class="main"><div class="title">${esc(basename(data.path) || 'This folder')} is running</div><div class="sub">${mine.port ? `<span class="mono">:${mine.port}</span> · ` : ''}${mine.url ? esc(mine.url.replace(/^https:\/\//, '')) : 'no link'}</div></div>${mine.url ? `<a class="pill kelp" href="${esc(openLink(mine.url, mine.port, credsSeen))}" target="_blank" rel="noopener">${icon('external')}Open</a>` : ''}<button class="pill" data-run-file>${icon('settings')}Manage</button></div>`
        : `<button class="run-card" data-run-file><span class="ico kelp">${icon('rocket')}</span><div class="main"><div class="title">Run ${esc(basename(data.path) || 'this folder')}</div><div class="sub">.platorun · see what it starts, then run it</div></div><span class="pill kelp">${icon('play')}Run</span></button>`;
    $('#run-card [data-run-file]')?.addEventListener('click', () => portholerunDialog(join(data.path, '.platorun')));
    $('#file-list').innerHTML = up + items.map(i => `
        <button class="row" data-name="${esc(i.name)}" data-type="${i.type}" data-size="${i.size ?? 0}"${finePointer() ? ' draggable="true"' : ''}>
          <span class="ico ${i.type === 'dir' ? 'brass' : ''}${i.icon ? ' fav' : ''}">${i.icon ? `<img src="/api/files/icon?path=${encodeURIComponent(join(join(data.path, i.name), i.icon))}" alt="" loading="lazy">` : icon(i.type === 'dir' ? 'folder' : EXT_ICON[extOf(i.name)] || 'file')}</span>
          <div class="main"><div class="title">${esc(i.name)}${i.links?.from ? '<span class="tag">upgrade</span>' : ''}${i.links?.to ? '<span class="tag dim">prototype</span>' : ''}</div><div class="sub">${i.running?.length ? `${runningLine(i.running)} · ` : ''}${i.links?.from ? `upgraded from ${esc(i.links.from.name)} · ` : ''}${i.links?.to ? `upgraded into ${esc(i.links.to.map(t => t.name).join(', '))} · ` : ''}${i.type === 'dir' ? (i.running?.length ? '' : 'Folder · ') : fmtBytes(i.size) + ' · '}${fmtAgo(i.modified)}${i.symlink ? ' · link' : ''}</div></div>
          ${i.running?.[0]?.url ? `<span class="pill kelp sm" data-open-run="${esc(openLink(i.running[0].url, i.running[0].port, credsSeen))}" title="${esc(i.running[0].url)}">${icon('external')}Open</span>` : ''}${i.run ? (i.running?.some(r => r.kind === 'run') ? `<span class="pill ghost-kelp sm" data-run-dir title="Running · restart or stop">${icon('activity')}Running</span>` : `<span class="pill kelp sm" data-run-dir title="Run with .platorun">${icon('play')}Run</span>`) : ''}<span class="more ${state.expanded === join(data.path, i.name) ? 'on' : ''}" data-more>${icon('more_h')}</span>
        </button>`).join('');
    $$('#file-list .ico.fav img').forEach(img => img.addEventListener('error', () => { const s = img.parentElement; s.classList.remove('fav'); s.innerHTML = icon('folder'); }));
    $('#file-list [data-up]')?.addEventListener('click', () => loadFiles(parentOf(state.filesPath)).catch(ex => toast(ex.message, true)));
    $$('#file-list .row[data-name]').forEach(row => {
        const name = row.dataset.name, type = row.dataset.type, size = Number(row.dataset.size), rel = join(state.filesPath, name);
        row.addEventListener('click', e => {
            const openRun = e.target.closest('[data-open-run]'); if (openRun) return window.open(openRun.dataset.openRun, '_blank', 'noopener');
            if (e.target.closest('[data-run-dir]')) return portholerunDialog(join(rel, '.platorun'));
            if (e.target.closest('[data-more]')) return toggleExpand(row, rel, name, type, size);
            if (type === 'dir') return loadFiles(rel).catch(ex => toast(ex.message, true));
            if (name === '.platorun' && type === 'file') return portholerunDialog(rel);
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

// Projects made before the agent user existed: offer to make the whole tree writable for agent shells and services.
async function loadAgentReady(rel) {
    const box = $('#agent-ready-card'); if (!box) return;
    box.innerHTML = '';
    const r = await api(`/api/agent-ready?path=${encodeURIComponent(rel || '.')}`).catch(() => null);
    if (!r || !r.eligible || r.ready || rel !== state.filesPath) return;
    box.innerHTML = `<button class="row plain" data-ready style="background:var(--hull);border:1px solid var(--rail);border-radius:var(--radius);margin-bottom:12px"><span class="ico brass">${icon('shield')}</span><div class="main"><div class="title" style="color:var(--brass)">Make agent-ready</div><div class="sub">Agent shells and live services cannot write everything here yet${r.example ? ` (for example ${esc(r.example)})` : ''}. Gives the porthole-dev group write access; owners stay the same.</div></div></button>`;
    $('[data-ready]', box).onclick = async e => { e.currentTarget.disabled = true; toast('Updating permissions…'); try { const x = await api('/api/agent-ready', { method: 'POST', body: { path: rel } }); toast(x.ready ? 'Agent-ready' : 'Some files could not be changed', !x.ready); loadAgentReady(rel); } catch (ex) { toast(ex.message, true); } };
}

async function loadRepoCard(rel) {
    const card = $('#repo-card');
    if (rel !== state.filesPath) return;
    loadAgentReady(rel);
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
        <div class="field"><label for="cl-dest">Into folder</label><input id="cl-dest" type="text" class="mono" value="${esc(projectsRel())}" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
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
        ${type === 'dir' && parentOf(rel) === projectsRel() ? `<button data-x="upgrade">${icon('rocket')}Upgrade</button>` : ''}
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
            if (x === 'upgrade') return upgradeRepoDialog(rel, name);
            if (x === 'shell') return newShellDialog(rel, 'shell');
            if (x === 'claude') return newShellDialog(ex.previousElementSibling?.dataset.type === 'dir' ? rel : state.filesPath, 'agent');
            if (x === 'trash') {
                if (!(await confirmDialog({ title: `Delete "${name}"?`, text: 'It moves to PlatOpypus\'s trash on the box, so it can be recovered from a shell.', action: 'Delete' }))) return;
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
    if (files.length) await uploadMany(files.map(file => ({ file, sub: '' })), state.filesPath);
});
// Uploads [{ file, sub }] into dir, creating sub-folders first (a dropped folder keeps its structure).
async function uploadMany(list, dir) {
    if (!list.length) return;
    const box = $('#upload-progress'), bar = $('.upbar > div', box), nameEl = $('.upname', box), stateEl = $('.upstate', box);
    box.hidden = false;
    const made = new Set();
    for (const sub of [...new Set(list.map(x => x.sub).filter(Boolean))].sort()) {
        let acc = '';
        for (const part of sub.split('/')) {
            const parent = join(dir, acc); acc = acc ? `${acc}/${part}` : part;
            if (made.has(acc)) continue; made.add(acc);
            try { await api('/api/files/mkdir', { method: 'POST', body: { path: parent || '.', name: part } }); } catch (ex) { if (ex.status !== 409) { toast(`${acc}: ${ex.message}`, true); } }
        }
    }
    let done = 0;
    for (const [n, x] of list.entries()) {
        nameEl.textContent = x.sub ? `${x.sub}/${x.file.name}` : x.file.name; stateEl.textContent = list.length > 1 ? `${n + 1} of ${list.length}` : 'uploading'; bar.style.width = '0%';
        try { await uploadOne(x.file, join(dir, x.sub), pct => (bar.style.width = pct + '%')); done++; }
        catch (ex) { if (ex.message !== 'Skipped') toast(`${x.file.name}: ${ex.message}`, true); }
    }
    box.hidden = true;
    if (done) toast(done === 1 ? `Uploaded to ${basename(dir) || 'the root'}` : `Uploaded ${done} files to ${basename(dir) || 'the root'}`);
    if (state.tab === 'files') loadFiles(state.filesPath);
}

// ---------- drag and drop (mouse) ----------
// From the computer: files or whole folders onto the list (this folder) or onto a folder row / breadcrumb.
// Inside Files: drag a row onto a folder row, the ".." row or a breadcrumb to move it. Out of the browser: drag a
// file to the desktop to download it (Chrome and Edge).
function finePointer() { return matchMedia('(pointer: fine)').matches; }
const DRAG_TYPE = 'application/x-porthole-path';
let dragFrom = null;
function dropTargetOf(el) {
    const row = el.closest?.('#file-list .row[data-name]');
    if (row && row.dataset.type === 'dir') return { el: row, dir: join(state.filesPath, row.dataset.name), label: row.dataset.name };
    const up = el.closest?.('#file-list [data-up]');
    if (up) return { el: up, dir: parentOf(state.filesPath), label: basename(parentOf(state.filesPath)) || 'the parent folder' };
    const cr = el.closest?.('#crumbs button[data-path]');
    if (cr) return { el: cr, dir: cr.dataset.path, label: cr.textContent.trim() };
    if (el.closest?.('#tab-files')) return { el: $('#file-list'), dir: state.filesPath, label: basename(state.filesPath) || 'this folder', here: true };
    return null;
}
function clearDrop() { $$('.drop-on').forEach(x => x.classList.remove('drop-on')); $('#tab-files').classList.remove('dropping'); $('#drop-hint').hidden = true; }
document.addEventListener('dragstart', e => {
    const row = e.target.closest?.('#file-list .row[data-name]'); if (!row) return;
    const rel = join(state.filesPath, row.dataset.name);
    dragFrom = rel;
    e.dataTransfer.setData(DRAG_TYPE, rel);
    e.dataTransfer.setData('text/plain', '/' + rel.replace(/^\/+/, ''));
    if (row.dataset.type === 'file') e.dataTransfer.setData('DownloadURL', `application/octet-stream:${row.dataset.name}:${location.origin}/api/files/download?path=${encodeURIComponent(rel)}`);
    e.dataTransfer.effectAllowed = 'copyMove';
    row.classList.add('dragging');
});
document.addEventListener('dragend', () => { dragFrom = null; $$('.dragging').forEach(x => x.classList.remove('dragging')); clearDrop(); });
document.addEventListener('dragover', e => {
    if (state.tab !== 'files' || $('#tab-files').hidden) return;
    const types = [...(e.dataTransfer?.types || [])];
    const internal = types.includes(DRAG_TYPE), external = types.includes('Files');
    if (!internal && !external) return;
    const t = dropTargetOf(e.target);
    if (!t || (internal && (t.here || t.dir === dragFrom || t.dir === parentOf(dragFrom || '')))) { if (internal) { e.dataTransfer.dropEffect = 'none'; e.preventDefault(); } clearDrop(); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = internal ? 'move' : 'copy';
    if (!t.el.classList.contains('drop-on')) { clearDrop(); t.el.classList.add('drop-on'); }
    if (t.here) $('#tab-files').classList.add('dropping');
    const hint = $('#drop-hint'); hint.hidden = false; hint.textContent = internal ? `Move ${basename(dragFrom)} into ${t.label}` : `Drop to upload into ${t.label}`;
});
document.addEventListener('dragleave', e => { if (!e.relatedTarget || !document.documentElement.contains(e.relatedTarget)) clearDrop(); });
document.addEventListener('drop', async e => {
    if (state.tab !== 'files' || $('#tab-files').hidden) return;
    const types = [...(e.dataTransfer?.types || [])];
    const t = dropTargetOf(e.target); clearDrop();
    if (types.includes(DRAG_TYPE)) {
        e.preventDefault();
        const from = e.dataTransfer.getData(DRAG_TYPE);
        if (!t || t.here || !from) return;
        try { const r = await api('/api/files/move', { method: 'POST', body: { path: from, to: t.dir || '.' } }); if (!r.unchanged) toast(`Moved ${basename(from)} to ${t.label}`); }
        catch (ex) { toast(ex.message, true); }
        return loadFiles(state.filesPath);
    }
    if (!types.includes('Files') || !t) return;
    e.preventDefault();
    // Read the entries now: the drop's data is gone after the first await.
    const entries = [...e.dataTransfer.items].filter(i => i.kind === 'file').map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    const plain = entries.length ? [] : [...e.dataTransfer.files].map(file => ({ file, sub: '' }));
    const list = [...plain];
    const walk = async (entry, sub) => {
        if (entry.isFile) { const file = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null); if (file) list.push({ file, sub }); return; }
        if (!entry.isDirectory) return;
        const reader = entry.createReader(), here = sub ? `${sub}/${entry.name}` : entry.name;
        for (;;) {
            const batch = await new Promise((res, rej) => reader.readEntries(res, rej)).catch(() => []);
            if (!batch.length) break;
            for (const child of batch) await walk(child, here);
        }
    };
    for (const en of entries) await walk(en, '');
    const skip = list.filter(x => /(^|\/)(node_modules|\.git)(\/|$)/.test(x.sub));
    let todo = list;
    if (skip.length && await confirmDialog({ title: `Skip ${skip.length} files in node_modules / .git?`, text: 'They are usually rebuilt on the box (npm install, git clone) rather than uploaded.', action: 'Skip them', danger: false })) todo = list.filter(x => !skip.includes(x));
    if (todo.length > 200 && !(await confirmDialog({ title: `Upload ${todo.length} files?`, text: `Into ${t.label}. Folders are created as needed.`, action: 'Upload', danger: false }))) return;
    await uploadMany(todo, t.dir);
});
function uploadOne(file, dir, onProgress, overwrite = false) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `/api/files/upload?path=${encodeURIComponent(dir || '.')}&name=${encodeURIComponent(file.name)}${overwrite ? '&overwrite=1' : ''}`);
        xhr.setRequestHeader('X-Plato', '1'); xhr.setRequestHeader('Content-Type', 'application/octet-stream');
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

// ---------- keep the box on ----------
// Power status: the box says whether it may be powered off (no agent working, not kept on). Whatever powers it off
// automatically asks that first. Keeping it on until a date makes the answer "no" until then.
async function loadKeepAlive() {
    const { keepAlive: k } = await api('/api/keepalive');
    const card = $('#keepalive-card'); if (!card) return;
    const when = k ? new Date(k.until).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    card.innerHTML = `<button class="row" data-keep><span class="ico ${k ? 'kelp' : ''}">${icon('anchor')}</span><div class="main"><div class="title">${k ? `Kept on until ${esc(when)}` : 'Keep the box on'}</div><div class="sub" style="white-space:normal">${k ? esc(k.reason || 'Automatic power-off is paused') : 'It may be powered off automatically when no agent is working. Tap to keep it on until a date.'}</div></div>${icon('chevron', 'i chev')}</button>`;
    $('[data-keep]', card).onclick = () => keepAliveDialog(k);
    offlineCard();
}
// The Start button for when the box is off: the control URL and key, kept on this device only (the offline page reads them).
function offlineCard() {
    const host = $('#keepalive-card'); if (!host) return;
    let box = $('#offline-card'); if (!box) { box = document.createElement('div'); box.id = 'offline-card'; host.after(box); }
    let c = null; try { c = JSON.parse(localStorage.getItem('plato.control') || 'null'); } catch { /* none */ }
    const sw = 'serviceWorker' in navigator;
    box.className = 'list gap';
    box.innerHTML = `<button class="row" data-offline><span class="ico ${c ? 'kelp' : ''}">${icon('play')}</span><div class="main"><div class="title">${c ? 'Start button ready on this device' : 'Start the box when it is off'}</div><div class="sub" style="white-space:normal">${!sw ? 'This browser cannot keep the offline page.' : c ? 'If the box is off when you open PlatOpypus here, you get a page with a Start button.' : 'Paste the control URL and key once, and this device can start the box when it is off.'}</div></div>${icon('chevron', 'i chev')}</button>`;
    $('[data-offline]', box).onclick = () => {
        const { panel, close } = openDialog(`<h2>${icon('play')}Start the box when it is off</h2>
            <p class="muted">When the box is off, this device shows a page with a Start button instead of an error. It uses the control Lambda, so paste its URL and key (the Telegram message has Copy URL and Copy key). They stay on this device only.</p>
            <div class="field"><label for="oc-url">Control URL</label><input id="oc-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" value="${esc(c?.url || '')}" placeholder="https://….lambda-url.eu-west-2.on.aws/"></div>
            <div class="field"><label for="oc-key">Key</label><input id="oc-key" type="password" autocomplete="off" spellcheck="false" placeholder="${c ? 'saved (enter a new one to change it)' : '40 characters'}"></div>
            <p class="note" id="oc-result"></p>
            <div class="buttons">${c ? '<button data-forget>Forget on this device</button>' : ''}<button data-test>Test</button><button class="primary" data-ok>Save</button></div>`);
        const read = () => ({ url: $('#oc-url', panel).value.trim(), key: $('#oc-key', panel).value.trim() || c?.key || '' });
        const valid = v => /^https:\/\/[a-z0-9]+\.lambda-url\.[a-z0-9-]+\.on\.aws\/?$/.test(v.url) && v.key.length >= 20;
        $('[data-test]', panel).onclick = async () => {
            const v = read(); const out = $('#oc-result', panel); if (!valid(v)) { out.textContent = 'Paste the control URL (….lambda-url….on.aws) and the key first.'; return; }
            out.textContent = 'Asking the control…';
            try { const r = await fetch(v.url.replace(/\/?$/, '/') + '?action=status', { headers: { 'X-Porthole-Key': v.key }, cache: 'no-store' }); const d = await r.json().catch(() => ({})); out.textContent = r.ok ? `It works: the box is ${d.state}.` : r.status === 401 ? 'The key was not accepted.' : `The control answered ${r.status}.`; }
            catch { out.textContent = 'The control cannot be reached from this page yet (it needs the CORS setting applied to the Lambda).'; }
        };
        $('[data-ok]', panel).onclick = () => { const v = read(); if (!valid(v)) return toast('Paste the control URL and the key', true); localStorage.setItem('plato.control', JSON.stringify(v)); close(); toast('Start button ready on this device'); offlineCard(); };
        const f = $('[data-forget]', panel); if (f) f.onclick = () => { localStorage.removeItem('plato.control'); close(); toast('Forgotten on this device'); offlineCard(); };
    };
}
function keepAliveDialog(k) {
    const DAY = 86400_000, MAXD = 60;
    const midnight = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const today = midnight(Date.now());
    const pad = n => String(n).padStart(2, '0');
    const start = k ? new Date(k.until) : new Date(Date.now() + 3 * DAY);
    const sel = { day: midnight(start.getTime()), time: k ? `${pad(start.getHours())}:${pad(start.getMinutes())}` : '23:59' };
    const TIMES = [['09:00', 'Morning'], ['13:00', 'Midday'], ['18:00', 'Evening'], ['23:59', 'End of day']];
    const ymd = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    const { panel, close } = openDialog(`<h2>${icon('anchor')}Keep the box on</h2>
        <p class="muted">Until the time you pick, the box reports that it must not be powered off, whatever the agents are doing.</p>
        <div class="ka-label">How long</div>
        <div class="ka-chips">${[['Tonight', 0], ['Tomorrow', 1], ['3 days', 3], ['A week', 7], ['2 weeks', 14]].map(([l, d]) => `<button type="button" data-days="${d}">${l}</button>`).join('')}</div>
        <div class="ka-label">Or pick the day</div>
        <div class="ka-days" id="ka-days">${Array.from({ length: 14 }, (_, i) => { const d = new Date(today + i * DAY); return `<button type="button" data-day="${today + i * DAY}"><span>${i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' })}</span><b>${d.getDate()}</b><span>${d.toLocaleDateString(undefined, { month: 'short' })}</span></button>`; }).join('')}<label class="ka-later"><span>Later</span><b>${icon('chevron')}</b><span>up to ${MAXD} days</span><input type="date" id="ka-date" min="${ymd(today)}" max="${ymd(today + MAXD * DAY)}" aria-label="A later date"></label></div>
        <div class="ka-label">Until what time</div>
        <div class="ka-chips" id="ka-times">${TIMES.map(([t, l]) => `<button type="button" data-time="${t}">${l}<small>${t}</small></button>`).join('')}<label class="ka-timebox">Other<input type="time" id="ka-time" aria-label="Another time"></label></div>
        <div class="ka-sum" id="ka-sum" aria-live="polite"></div>
        <div class="field"><label>What for (optional)</label><input id="ka-reason" type="text" maxlength="120" placeholder="Why it needs to stay on" value="${esc(k?.reason || '')}"></div>
        <div class="buttons">${k ? '<button data-clear>Stop keeping it on</button>' : ''}<button data-close>Cancel</button><button class="primary" data-ok>Keep it on</button></div>`);
    const until = () => { const [h, m] = sel.time.split(':').map(Number); const d = new Date(sel.day); d.setHours(h, m, 0, 0); return d.getTime(); };
    const paint = () => {
        $$('[data-day]', panel).forEach(b => b.classList.toggle('on', Number(b.dataset.day) === sel.day));
        $('.ka-later', panel).classList.toggle('on', sel.day >= today + 14 * DAY);
        $$('[data-time]', panel).forEach(b => b.classList.toggle('on', b.dataset.time === sel.time));
        $('.ka-timebox', panel).classList.toggle('on', !TIMES.some(([t]) => t === sel.time)); $('#ka-time', panel).value = sel.time; $('#ka-date', panel).value = ymd(sel.day);
        const u = until(), left = u - Date.now(), sum = $('#ka-sum', panel), ok = $('[data-ok]', panel);
        const bad = left < 5 * 60_000 ? 'That time has passed. Pick a later one.' : left > MAXD * DAY ? `The longest is ${MAXD} days.` : '';
        const days = Math.floor(left / DAY), hours = Math.round((left % DAY) / 3600_000);
        sum.textContent = bad || `Kept on until ${new Date(u).toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} · ${days ? `${days} day${days === 1 ? '' : 's'}${hours ? ` ${hours} h` : ''}` : `${Math.max(1, hours)} h`} from now`;
        sum.classList.toggle('bad', !!bad); ok.disabled = !!bad;
    };
    $$('[data-days]', panel).forEach(b => b.onclick = () => { sel.day = today + Number(b.dataset.days) * DAY; sel.time = '23:59'; paint(); $(`[data-day="${sel.day}"]`, panel)?.scrollIntoView({ inline: 'center', block: 'nearest' }); });
    $$('[data-day]', panel).forEach(b => b.onclick = () => { sel.day = Number(b.dataset.day); paint(); });
    $$('[data-time]', panel).forEach(b => b.onclick = () => { sel.time = b.dataset.time; paint(); });
    $('#ka-time', panel).onchange = e => { if (e.target.value) { sel.time = e.target.value; paint(); } };
    $('#ka-date', panel).onchange = e => { if (e.target.value) { const [y, m, d] = e.target.value.split('-').map(Number); sel.day = new Date(y, m - 1, d).getTime(); paint(); } };
    paint(); $(`[data-day="${sel.day}"]`, panel)?.scrollIntoView({ inline: 'center', block: 'nearest' });
    $('[data-ok]', panel).onclick = async () => { try { await api('/api/keepalive', { method: 'PUT', body: { until: until(), reason: $('#ka-reason', panel).value.trim() } }); close(); toast('The box stays on'); loadKeepAlive().catch(() => {}); } catch (ex) { toast(ex.message, true); } };
    const c = $('[data-clear]', panel); if (c) c.onclick = async () => { try { await api('/api/keepalive', { method: 'DELETE' }); close(); toast('Automatic power-off is back on'); loadKeepAlive().catch(() => {}); } catch (ex) { toast(ex.message, true); } };
}

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
    api('/api/alerts').then(a => { const el = $('#more-alerts-sub'); if (el) el.textContent = alertsSub(a); }).catch(() => {});
    loadKeepAlive().catch(() => {});
    api('/api/rename').then(r => {
        const card = $('#rename-card'); if (!card) return;
        card.hidden = !r.pending;
        if (!r.pending) return;
        card.innerHTML = `<div class="row"><span class="ico brass">${icon('restart')}</span><div class="main"><div class="title">Finish the rename</div><div class="sub" style="white-space:normal">Shells and services still run under the old name. One step moves them: live services stop and start again; open shells, plain servers and quick links end (Claude sessions resume in a new shell). About a minute.</div></div><button class="text-btn" data-rename-finish>Do it</button></div>`;
        $('[data-rename-finish]', card).onclick = async b => {
            if (!(await confirmDialog({ title: 'Finish the rename now?', text: 'Every open shell ends (agents resume in a new shell), plain servers and quick links stop, live services restart. Pick a quiet moment.', action: 'Finish the rename' }))) return;
            b.target.disabled = true; b.target.textContent = 'Moving…';
            try { const x = await api('/api/rename/finish', { method: 'POST' }); toast(x.restarted?.length ? `Done; restarted ${x.restarted.join(', ')}` : 'Done'); } catch (ex) { toast(ex.message, true); }
            loadMore().catch(() => {});
        };
    }).catch(() => {});
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
          <div class="main"><div class="title">PlatOpypus ${esc(v.version || '?')}${v.sha ? `<span class="tag dim">${esc(v.sha)}</span>` : ''}</div><div class="sub">${u.inProgress ? 'updating…' : line}</div>${last}</div>
          ${u.inProgress ? '' : u.available ? `<button class="pill accent" data-upd="apply">${icon('cloud-down')}Update</button>` : `<button class="pill" data-upd="check">${icon('refresh')}Check</button>`}
          <button class="more" data-upd="menu" aria-label="Update actions">${icon('more_h')}</button>
        </div>`;
    $$('[data-upd]', $('#update-card')).forEach(b => b.onclick = () => updateAction(b.dataset.upd, u));
    if (u.inProgress) showUpdateOverlay(u);
}

// The update screen: the version change, the four real stages read from the update log, and a ring that turns
// green when done (or red with the reason and the log when it fails).
let overlayPolling = false;
const UPD_STEPS = ['fetch', 'install', 'restart', 'health'];
function updStage(stage, state = 'active') {
    const at = UPD_STEPS.indexOf(stage);
    $$('#upd-steps li').forEach((li, n) => { li.className = n < at || state === 'done' ? 'done' : n === at ? state : ''; });
}
function showUpdateOverlay(u = null) {
    const o = $('#update-overlay'); o.hidden = false;
    if (u) { $('#upd-from').textContent = u.installed?.version || ''; $('#upd-to').textContent = u.latestVersion && u.latestVersion !== u.installed?.version ? u.latestVersion : 'latest'; }
    if (overlayPolling) return;
    overlayPolling = true;
    o.dataset.state = 'working'; $('#upd-actions').hidden = true; $('#upd-logview').hidden = true;
    $('#upd-kicker').textContent = 'Updating PlatOpypus';
    $('#upd-note').textContent = 'Your shells, links and containers keep running. This page reloads by itself.';
    updStage('fetch');
    const started = Date.now();
    let wentDown = false, stage = 'fetch';
    const status = $('#update-overlay-status');
    const finish = (ok, msg) => {
        overlayPolling = false;
        o.dataset.state = ok ? 'done' : 'failed';
        if (ok) { updStage('health', 'done'); $('#upd-kicker').textContent = 'Updated'; $('#upd-note').textContent = 'Reloading…'; setTimeout(() => location.reload(), 1800); }
        else { updStage(stage, 'failed'); $('#upd-kicker').textContent = 'Update failed'; $('#upd-note').textContent = `${msg || 'See the log.'} The previous version is running again.`; $('#upd-actions').hidden = false; }
    };
    const poll = async () => {
        const secs = Math.floor((Date.now() - started) / 1000);
        status.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
        try {
            const r = await fetch('/api/update', { credentials: 'same-origin', cache: 'no-store' });
            if (r.status === 401) { location.reload(); return; }
            if (r.ok) {
                const s = await r.json();
                if (s.installed?.version && !$('#upd-from').textContent) $('#upd-from').textContent = s.installed.version;
                if (!s.inProgress && Date.now() - started > 8000) {
                    if (s.installed?.version) $('#upd-to').textContent = s.installed.version;
                    return finish(!!s.lastResult?.ok, s.lastResult?.message);
                }
                // Where it is, from this run's part of the update log.
                const log = await fetch('/api/update/log', { credentials: 'same-origin', cache: 'no-store' }).then(x => x.ok ? x.text() : '').catch(() => '');
                const run = log.slice(Math.max(0, log.lastIndexOf('[update] fetching')));
                stage = wentDown ? 'health' : /install\.sh finished|restarting|updated /.test(run) ? 'restart' : /upgrade plan|install/.test(run) ? 'install' : 'fetch';
                updStage(stage);
            } else { wentDown = true; stage = 'restart'; updStage(stage); }
        } catch { wentDown = true; stage = 'restart'; updStage(stage); }   // the service is restarting
        if (Date.now() - started < 10 * 60_000) setTimeout(poll, 2500);
        else finish(false, 'This is taking longer than expected.');
    };
    poll();
}
$('#upd-reload').addEventListener('click', () => location.reload());
$('#upd-log').addEventListener('click', async () => {
    const v = $('#upd-logview');
    v.textContent = await fetch('/api/update/log', { credentials: 'same-origin', cache: 'no-store' }).then(x => x.ok ? x.text() : 'The log is not available yet.').catch(() => 'The log is not available yet.');
    v.hidden = false; v.scrollTop = v.scrollHeight;
});

async function updateAction(act, u) {
    try {
        if (act === 'check') { toast('Checking…'); await api('/api/update/check', { method: 'POST' }); return loadUpdate(); }
        if (act === 'apply') {
            const ok = await updatePlanDialog(u);
            if (!ok) return;
            await api('/api/update/apply', { method: 'POST' });
            showUpdateOverlay(u);
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
    const au = await api('/api/agent-user').catch(() => ({ available: false }));
    const moveCard = !au.available ? '' : au.loginsMoved
        ? `<div class="list" style="margin-bottom:12px"><div class="row"><span class="ico kelp">${icon('shield')}</span><div class="main"><div class="title">Agents run without root</div><div class="sub">Logins live with the agent user since ${fmtAgo(au.loginsMoved.at)} · root commands are asked for on this phone</div></div><button class="pill ghost" data-undo-move>Undo</button></div></div>`
        : au.rootLogins?.length ? `<div class="list" style="margin-bottom:12px"><div class="row"><span class="ico brass">${icon('shield')}</span><div class="main"><div class="title">Move logins to the agent user</div><div class="sub">Moves ${esc(au.rootLogins.join(', '))} (Claude with all profiles, Codex, Antigravity) so agents run without root and keep the same accounts. Backed up first; Undo puts them back.</div></div><button class="pill accent" data-move-logins>Move</button></div></div>` : '';
    $('#agents-body').innerHTML = moveCard + list.map(a => `
        <h2 class="section">${esc(a.title)}<span class="meta">${esc(a.vendor)}</span></h2>
        <div class="list">
          <div class="row"><span class="dot ${a.installed ? (a.signedIn ? 'live' : 'warn') : 'off'}" style="margin:0 10px"></span><div class="main"><div class="title">${a.installed ? esc(a.version || 'installed') : 'Not installed'}</div><div class="sub">${a.installed ? (a.signedIn ? 'signed in' : 'not signed in') : esc(a.blurb)}</div></div></div>
          ${a.installed ? `<button class="row plain" data-login="${a.key}"><span class="ico brass">${icon('login')}</span><div class="main"><div class="title">${a.signedIn ? 'Open a session' : 'Sign in'}</div><div class="sub">${a.signedIn ? 'Starts ' + esc(a.title) + ' in your home folder' : 'Opens a shell with the login flow'}</div></div>${icon('chevron', 'i chev')}</button>` : ''}
          ${a.profiles ? a.profiles.map(p => `<div class="row"><span class="ico ${p.signedIn ? 'kelp' : ''}">${icon('user')}</span><div class="main"><div class="title">${esc(p.name)}<span class="tag dim">profile</span></div><div class="sub">${p.signedIn ? 'signed in' : 'not signed in'} · <span class="mono">${esc(shortPath(p.dir))}</span></div></div>${p.name !== 'default' ? `<button class="more" data-prof="${esc(p.name)}" aria-label="Profile actions">${icon('more_h')}</button>` : ''}</div>`).join('') + `<button class="row plain" data-new-profile><span class="ico">${icon('plus')}</span><div class="main"><div class="title" style="color:var(--brass)">New profile</div><div class="sub">Another account or organisation, or separate usage limits</div></div></button>` : ''}
        </div>`).join('');
    const body = $('#agents-body');
    clineCard(body).catch(() => {});
    consultCard(body).catch(() => {});
    $('[data-move-logins]', body)?.addEventListener('click', async e => {
        if (!(await confirmDialog({ title: 'Move AI logins to the agent user?', text: 'Claude (with every profile), Codex and Antigravity logins move from root to the agent user, so new agent shells run without root and keep the same accounts. A backup is made first; root agent shells must be ended. Undo is on this page.', action: 'Move logins', danger: false }))) return;
        e.target.disabled = true;
        try { const r = await api('/api/agent-user/move-logins', { method: 'POST', body: {} }); toast(`Moved: ${r.moved.join(', ')}`); } catch (ex) { toast(ex.message, true); }
        loadAgents();
    });
    $('[data-undo-move]', body)?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Move logins back to root?', text: 'Agent-user shells must be ended first. New agents will run as root again.', action: 'Move back' }))) return;
        try { await api('/api/agent-user/undo-move', { method: 'POST', body: {} }); toast('Logins are back with root'); } catch (ex) { toast(ex.message, true); }
        loadAgents();
    });
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

// Agents asking agents: one switch per kind of session.
async function consultCard(body) {
    const s = await api('/api/agents/consult');
    const box = document.createElement('div'); box.className = 'consult-wrap';
    const rows = [['lab', 'Security Lab', 'Zero trust: the one asked sees only the question, once'], ['research', 'Research', 'Papers and questions on a topic'], ['project', 'Project work', 'Coding in a project'], ['control', 'Control sessions', 'Moving files, checking logs']];
    box.innerHTML = `<h2 class="section">Agents asking each other</h2><div class="list">${rows.map(([k, t, sub]) => `<label class="row consult-row"><span class="ico ${s[k] ? 'brass' : ''}">${icon('send')}</span><div class="main"><div class="title">${t}</div><div class="sub">${sub}</div></div><span class="switch"><input type="checkbox" data-consult="${k}" ${s[k] ? 'checked' : ''}><span></span></span></label>`).join('')}</div>
        <p class="note">When on, an agent in that kind of session can run <span class="mono">consult</span> to ask Claude, Codex, Gemini or Cline (whichever are signed in) for a second view. The one asked can read the folder but not change it. Every question is in the audit log.</p>`;
    body.prepend(box);
    $$('[data-consult]', box).forEach(c => c.onchange = async () => { try { await api('/api/agents/consult', { method: 'PUT', body: { [c.dataset.consult]: c.checked } }); toast(`${rows.find(r => r[0] === c.dataset.consult)[1]}: asking other agents ${c.checked ? 'on' : 'off'}`); c.closest('.row').querySelector('.ico').classList.toggle('brass', c.checked); } catch (ex) { toast(ex.message, true); c.checked = !c.checked; } });
}
// Cline's Ollama server: the address, the model (picked from what the server has), and an optional key.
async function clineCard(body) {
    const sec = [...body.querySelectorAll('h2.section')].find(h => h.textContent.startsWith('Cline')); if (!sec) return;
    const s = await api('/api/agents/cline');
    const box = document.createElement('div'); box.className = 'card cline-card'; sec.nextElementSibling.after(box);
    box.innerHTML = `<div class="tpl-h"><b>Ollama server</b><span>${s.ready ? `${esc(s.endpoint)} · ${esc(s.model)}` : 'not set yet'}</span></div>
        <div class="field"><label for="cl-ep">Server address</label><input id="cl-ep" type="url" inputmode="url" spellcheck="false" autocomplete="off" placeholder="http://10.0.0.20:11434" value="${esc(s.endpoint)}"></div>
        <div class="field"><label for="cl-model">Model</label><div class="cl-row"><input id="cl-model" type="text" list="cl-models" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="type a model name, or load the server's list" value="${esc(s.model)}"><datalist id="cl-models"></datalist><button class="btn" data-cl-load>${icon('refresh')}Load models</button></div></div>
        <div class="field"><label for="cl-key">Ollama API key (optional)</label><input id="cl-key" type="password" autocomplete="off" placeholder="${s.hasKey ? 'saved (enter a new one to change it)' : 'only if your Ollama server requires a key'}"></div>
        <p class="note" id="cl-note">The box must be able to reach this address (for a server at home, use its Tailscale address).</p>
        <div class="r-actions"><button class="btn pri" data-cl-save>${icon('check')}Save</button></div>`;
    const load = async () => { const n = $('#cl-note', box); n.textContent = 'Asking the server…'; try { const r = await api(`/api/agents/cline/models?endpoint=${encodeURIComponent($('#cl-ep', box).value.trim())}`); $('#cl-models', box).innerHTML = r.models.map(m => `<option value="${esc(m.name)}">${m.family ? esc(m.family) : ''}</option>`).join(''); const inp = $('#cl-model', box); if (!inp.value && r.models.length) inp.value = r.models[0].name; n.textContent = r.models.length ? `${r.models.length} model${r.models.length === 1 ? '' : 's'} on ${r.endpoint}: ${r.models.slice(0, 6).map(m => m.name).join(', ')}${r.models.length > 6 ? ', …' : ''}. Pick one or type any name.` : `The server has no models yet. Type the name you will pull (ollama pull …).`; } catch (ex) { n.textContent = ex.message; } };
    $('[data-cl-load]', box).onclick = load;
    $('[data-cl-save]', box).onclick = async () => { const body2 = { endpoint: $('#cl-ep', box).value.trim(), model: $('#cl-model', box).value.trim() }; const k = $('#cl-key', box).value.trim(); if (k) body2.key = k; try { await api('/api/agents/cline', { method: 'PUT', body: body2 }); toast('Cline is set to use this server'); loadAgents(); } catch (ex) { toast(ex.message, true); } };
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

// The address an Open button should use for a site. When a shared credential for the same site carries a path or a
// query (a login link such as /?key=…), open that instead of the bare address. Matches on the same origin, or on the
// same port for a credential that gave a localhost URL (its path and query are moved onto this site's address).
function openLink(base, port, creds) {
    if (!base) return base;
    let b; try { b = new URL(base); } catch { return base; }
    const local = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/i;
    const tail = u => (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
    for (const c of [...(creds || [])].sort((x, y) => (y.at || 0) - (x.at || 0))) {
        for (const raw of [c.url, c.openUrl]) {
            if (!raw) continue;
            let u; try { u = new URL(raw); } catch { continue; }
            const same = u.origin === b.origin || (port && c.port === port && local.test(raw));
            if (same && tail(u) && tail(u) !== tail(b)) return b.origin + (u.pathname || '/') + u.search + u.hash;
        }
    }
    return base;
}

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
    for (const t of items) { const k = t.scope === 'general' ? 'General · any folder, on request' : `Project · ${t.scope}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
    $('#vault-list').innerHTML = '';
    $('#vault-list').insertAdjacentHTML('afterend', '');
    const host = $('#vault-list').parentElement;
    $$('.vault-group', host).forEach(e => e.remove());
    for (const [label, list] of groups) {
        $('#vault-list').insertAdjacentHTML('beforebegin', `<div class="vault-group"><h2 class="section">${esc(label)}</h2><div class="list">${list.map(t => `
            <button class="row" data-id="${t.id}"><span class="ico ${t.oauth ? (t.oauth.connected ? 'kelp' : 'flare') : 'brass'}">${icon(t.oauth ? 'link' : 'key')}</span>
              <div class="main"><div class="title">${esc(t.name)}<span class="tag brass">${esc(t.title || t.provider)}</span>${t.oauth ? `<span class="tag ${t.oauth.connected ? '' : 'dim'}">${t.oauth.connected ? 'connected' : 'not connected'}</span>` : ''}${t.incomplete?.length ? `<span class="tag" style="color:var(--flare)">incomplete</span>` : ''}${t.inShells ? '<span class="tag" style="color:var(--flare)">in new shells</span>' : ''}</div>
                <div class="sub mono">${esc(t.fields.filter(f => !f.missing).map(f => f.env).join(' · '))}${t.incomplete?.length ? ` · missing ${esc(t.incomplete.join(', '))}` : ''}</div></div>
              ${icon('more_h', 'i chev')}</button>`).join('')}</div></div>`);
    }
    $$('.vault-group .row').forEach(r => r.onclick = () => vaultMenu(items.find(i => i.id === r.dataset.id)));
    const q = new URLSearchParams(location.search);
    if (q.get('oauth')) { toast(q.get('oauth') === 'connected' ? `Connected ${q.get('name') || ''}` : `Connection failed: ${q.get('error') || ''}`, q.get('oauth') !== 'connected'); history.replaceState(null, '', '/'); }
}

function vaultMenu(t) {
    const { panel, close } = openDialog(`<h2>${esc(t.name)}</h2>
        <p class="muted">${esc(t.title || t.provider)} · ${esc(t.style)} · ${t.scope === 'general' ? 'any folder' : 'only from ' + esc(t.scope)}${t.oauth?.expiresAt ? `<br>token ${t.oauth.expiresAt > Date.now() ? 'expires in ' + fmtIn(t.oauth.expiresAt) : 'expired (refreshes on use)'}` : ''}${t.notes ? '<br>' + esc(t.notes) : ''}</p>
        <div class="list" style="margin-bottom:10px">${t.fields.map(f => `<div class="row plain" style="min-height:40px;padding:8px 10px"><div class="main"><div class="title mono" style="font-size:13px">${esc(f.env)}</div><div class="sub">${esc(f.label)} · ${f.secret ? esc(f.hint) : esc(f.hint || '—')}</div></div><button class="pill" data-rv="${esc(f.name)}" style="padding:6px 10px">${icon('copy')}</button></div>`).join('')}</div>
        ${t.scope === 'general' ? `<div class="list" style="margin-bottom:10px"><div class="row"><div class="main"><div class="title">Put into new shells</div><div class="sub" style="white-space:normal">${t.inShells ? 'On: every new shell starts with it in its environment. Uses after that are not logged.' : 'Off: agents fetch it when needed with <span class="mono">vault run</span> or <span class="mono">vault get</span>, and each use is in the audit log.'}</div></div><button class="switch ${t.inShells ? 'on' : ''}" data-inshells role="switch" aria-checked="${!!t.inShells}" aria-label="Put into new shells"><span></span></button></div></div>` : ''}
        <div class="menu">
          ${t.oauth ? `<button data-a="connect">${icon('link')}${t.oauth.connected ? 'Reconnect account' : 'Connect account'}</button>${t.oauth.connected ? `<button data-a="refresh">${icon('refresh')}Refresh token now</button>` : ''}` : ''}
          <button data-a="reveal">${icon('eye')}Reveal all</button>
          <button data-a="edit">${icon('edit')}Edit values / scope</button>
          <button data-a="remove" class="danger">${icon('trash')}Delete</button>
        </div>`);
    const sw = $('[data-inshells]', panel);
    if (sw) sw.onclick = async () => {
        const on = !t.inShells;
        if (on && !(await confirmDialog({ title: `Put ${t.name} into every new shell?`, text: 'Each new shell, and every agent in it, will have this value in its environment from the start. PlatOpypus logs that once, when the shell starts; uses after that cannot be seen.', action: 'Put into new shells', danger: true }))) return vaultMenu(t);
        try { await api(`/api/vault/${t.id}`, { method: 'PUT', body: { inShells: on } }); t.inShells = on; toast(on ? 'New shells will get it' : 'New shells will not get it; running shells keep theirs until they end'); loadVault(); vaultMenu(t); }
        catch (ex) { toast(ex.message, true); }
    };
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


// ---- credential form helpers: inline folder picker for the project scope, paste-to-fill, format converters ----
// A folder browser that lives inside the form (the dialog is single-instance, so the big picker cannot be nested).
async function inlineFolderPicker(host, start, onChange) {
    let cur = start || '';
    const load = async p => {
        let data; try { data = await api(`/api/files?path=${encodeURIComponent(p || '.')}`); } catch (ex) { if (p) return load(''); toast(ex.message, true); return; } // a stale start folder falls back to the root
        cur = data.path; onChange(cur);
        const dirs = data.items.filter(i => i.type === 'dir' && !i.hidden);
        host.innerHTML = `<div class="crumbs mini"><button data-p="">${rootLabel()}</button>${cur ? cur.split('/').map((seg, i, all) => `<span class="sep">›</span><button data-p="${esc(all.slice(0, i + 1).join('/'))}">${esc(seg)}</button>`).join('') : ''}</div>
            <div class="list mini">${cur ? `<button class="row" data-d="${esc(parentOf(cur))}"><span class="ico dim">${icon('back')}</span><div class="main"><div class="title mono">..</div></div></button>` : ''}${dirs.map(d => `<button class="row" data-d="${esc(join(cur, d.name))}"><span class="ico brass">${icon('folder')}</span><div class="main"><div class="title">${esc(d.name)}</div></div></button>`).join('') || '<p class="empty">No sub-folders</p>'}</div>`;
        $$('[data-p]', host).forEach(b => b.onclick = e => { e.preventDefault(); load(b.dataset.p); });
        $$('[data-d]', host).forEach(b => b.onclick = e => { e.preventDefault(); load(b.dataset.d); });
    };
    await load(cur);
}
function randomSecret(n = 20) { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!'; const b = new Uint8Array(n); crypto.getRandomValues(b); return [...b].map(x => a[x % a.length]).join(''); }
function fieldEl(panel, pfx, name) { return $(`#${pfx}-${name}`, panel); }
function setField(panel, pfx, name, value) { const el = fieldEl(panel, pfx, name); if (!el) return false; el.value = value; if (el.type === 'password') el.type = 'text'; el.dispatchEvent(new Event('input')); return true; }
function fieldNames(panel, pfx) { return $$(`input[id^="${pfx}-"], textarea[id^="${pfx}-"]`, panel).map(el => el.id.slice(pfx.length + 1)).filter(n => !['name', 'prefix', 'scope', 'notes', 'authUrl', 'tokenUrl'].includes(n)); }
// Paste a .env block or a JSON object and fill whatever matches (by field name, label or env suffix).
function fillFromText(panel, pfx, text) {
    const names = fieldNames(panel, pfx); const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    let pairs = [];
    try { const o = JSON.parse(text); if (o && typeof o === 'object') pairs = Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]); } catch { /* not JSON */ }
    if (!pairs.length) for (const line of text.split(/\r?\n/)) { const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*[=:]\s*(.*)$/); if (m) pairs.push([m[1], m[2].trim().replace(/^(["'])(.*)\1$/, '$2')]); }
    let filled = 0;
    for (const [k, v] of pairs) {
        const nk = norm(k);
        const target = names.find(n => norm(n) === nk) || names.find(n => nk.endsWith(norm(n))) || names.find(n => { const lbl = $(`label[for="${pfx}-${n}"]`, panel)?.textContent || ''; return norm(lbl).includes(nk) || nk.includes(norm(n)); });
        if (target && v) { setField(panel, pfx, target, v); filled++; }
    }
    return filled;
}
function parseDbUrl(u) { try { const x = new URL(u); return { scheme: x.protocol.replace(':', ''), host: x.hostname, port: x.port, user: decodeURIComponent(x.username), password: decodeURIComponent(x.password), database: x.pathname.replace(/^\//, ''), query: x.search.replace(/^\?/, '') }; } catch { return null; } }
function buildDbUrl(p) { const auth = p.user ? `${encodeURIComponent(p.user)}${p.password ? ':' + encodeURIComponent(p.password) : ''}@` : ''; return `${p.scheme || 'postgres'}://${auth}${p.host || 'localhost'}${p.port ? ':' + p.port : ''}/${p.database || ''}${p.query ? '?' + p.query : ''}`; }
function jwtInfo(t) { const parts = String(t).split('.'); if (parts.length !== 3) return null; try { const pl = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))); return { exp: pl.exp ? new Date(pl.exp * 1000) : null, iss: pl.iss || null, sub: pl.sub || null }; } catch { return null; } }
// Helpers per auth style. Each returns pills; the pane below the chips hosts any inline sub-form.
function credHelpers(style, pfx, panel, pane) {
    const show = html => { pane.innerHTML = html; pane.hidden = false; };
    const hide = () => { pane.hidden = true; pane.innerHTML = ''; };
    const copyRow = (label, v) => v ? `<button class="cred-row" data-cp="${esc(v)}"><span class="lbl">${esc(label)}</span><span class="val">${esc(v)}</span>${icon('copy')}</button>` : '';
    const list = [{ label: 'Paste .env / JSON', icon: 'paste', run: () => { show(`<textarea class="mono" rows="4" placeholder="KEY=value lines or a JSON object" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea><div class="buttons"><button class="primary" data-fill>Fill fields</button><button data-hide>Close</button></div>`); $('[data-fill]', pane).onclick = () => { const n = fillFromText(panel, pfx, $('textarea', pane).value); toast(n ? `${n} field${n === 1 ? '' : 's'} filled` : 'Nothing matched', !n); if (n) hide(); }; } }];
    if (style === 'basic' || style === 'smtp') list.push({ label: 'Generate password', icon: 'zap', run: () => { setField(panel, pfx, 'password', randomSecret()); toast('Password generated — copy it to the service too'); } });
    if (style === 'botChat') {
        list.push({ label: 'Check token', icon: 'check', run: async () => { try { const r = await api('/api/vault/derive', { method: 'POST', body: { kind: 'telegram-getme', botToken: fieldEl(panel, pfx, 'botToken')?.value } }); show(`<p class="sub">Bot <b>@${esc(r.username || '?')}</b> (${esc(r.name || '')})</p>${copyRow('Bot ID', r.botId)}<div class="buttons"><button data-hide>Close</button></div>`); } catch (ex) { toast(ex.message, true); } } });
        list.push({ label: 'Find chat ID', icon: 'search', run: async () => { try { const r = await api('/api/vault/derive', { method: 'POST', body: { kind: 'telegram-chats', botToken: fieldEl(panel, pfx, 'botToken')?.value } }); show(r.chats.length ? `<p class="sub">Chats this bot has seen · tap to use</p><div class="list mini">${r.chats.map(c => `<button class="row" data-chat="${esc(c.id)}"><span class="ico brass">${icon('user')}</span><div class="main"><div class="title">${esc(c.title)}</div><div class="sub mono">${esc(c.id)} · ${esc(c.type)}${c.username ? ' · @' + esc(c.username) : ''}</div></div></button>`).join('')}</div><div class="buttons"><button data-hide>Close</button></div>` : `<p class="sub">${esc(r.hint || 'No chats yet.')}</p><div class="buttons"><button data-hide>Close</button></div>`); $$('[data-chat]', pane).forEach(b => b.onclick = () => { setField(panel, pfx, 'chatId', b.dataset.chat); hide(); toast('Chat ID filled'); }); } catch (ex) { toast(ex.message, true); } } });
        list.push({ label: 'Bot ID from token', icon: 'key', run: () => { const t = fieldEl(panel, pfx, 'botToken')?.value || ''; const id = t.split(':')[0]; if (!/^\d+$/.test(id)) return toast('Enter the bot token first', true); show(copyRow('Bot ID', id) + `<div class="buttons"><button data-hide>Close</button></div>`); } });
    }
    if (style === 'dbUrl') {
        list.push({ label: 'Build from parts', icon: 'edit', run: () => { const cur = parseDbUrl(fieldEl(panel, pfx, 'url')?.value || '') || {}; show(['scheme', 'host', 'port', 'user', 'password', 'database'].map(k => `<div class="field"><label>${k}</label><input data-k="${k}" type="text" class="mono" value="${esc(cur[k] || (k === 'scheme' ? 'postgres' : ''))}" autocapitalize="off" autocorrect="off" spellcheck="false"></div>`).join('') + `<div class="buttons"><button class="primary" data-build>Use this URL</button><button data-hide>Close</button></div>`); $('[data-build]', pane).onclick = () => { const p = {}; $$('[data-k]', pane).forEach(i => { p[i.dataset.k] = i.value.trim(); }); setField(panel, pfx, 'url', buildDbUrl(p)); hide(); toast('URL built'); }; } });
        list.push({ label: 'Parts of this URL', icon: 'search', run: () => { const p = parseDbUrl(fieldEl(panel, pfx, 'url')?.value || ''); if (!p) return toast('Not a valid URL yet', true); show(Object.entries(p).map(([k, v]) => copyRow(k, v)).join('') + `<div class="buttons"><button data-hide>Close</button></div>`); } });
    }
    if (style === 'json') list.push({ label: 'Check JSON', icon: 'check', run: () => { const el = fieldEl(panel, pfx, 'json'); try { const o = JSON.parse(el.value); el.value = JSON.stringify(o, null, 2); const info = ['project_id', 'client_email', 'type', 'client_id'].filter(k => o[k]).map(k => copyRow(k, String(o[k]))).join(''); show((info || '<p class="sub">Valid JSON</p>') + `<div class="buttons"><button data-hide>Close</button></div>`); } catch (ex) { toast(`Invalid JSON: ${ex.message}`, true); } } });
    if (style === 'smtp') { for (const [name, host, port] of [['Gmail', 'smtp.gmail.com', '587'], ['Outlook', 'smtp.office365.com', '587'], ['iCloud', 'smtp.mail.me.com', '587']]) list.push({ label: name, icon: 'server', run: () => { setField(panel, pfx, 'host', host); setField(panel, pfx, 'port', port); toast(`${name} server filled`); } }); }
    if (['token', 'apiKey', 'urlToken', 'keyToken', 'header'].includes(style)) list.push({ label: 'Tidy value', icon: 'wrap-text', run: () => { let n = 0; for (const f of fieldNames(panel, pfx)) { const el = fieldEl(panel, pfx, f); if (!el) continue; const v = el.value.trim().replace(/^(["'])(.*)\1$/, '$2').replace(/^Bearer\s+/i, ''); if (v !== el.value) { el.value = v; n++; } const j = jwtInfo(v); if (j) show(`<p class="sub">JWT${j.exp ? ` · expires ${esc(j.exp.toLocaleString())}` : ''}${j.iss ? ` · issuer ${esc(j.iss)}` : ''}</p><div class="buttons"><button data-hide>Close</button></div>`); } toast(n ? 'Tidied' : 'Already tidy'); } });
    if (['urlToken', 'urlTopic', 'webhook'].includes(style)) list.push({ label: 'Trim trailing /', icon: 'wrap-text', run: () => { const el = fieldEl(panel, pfx, 'url'); if (el) { el.value = el.value.trim().replace(/\/+$/, ''); toast('Trimmed'); } } });
    return list;
}
function mountHelpers(panel, style, pfx) {
    const chips = $('[data-helpers]', panel), pane = $('[data-helper-pane]', panel);
    if (!chips || !pane) return;
    const list = credHelpers(style, pfx, panel, pane);
    chips.innerHTML = list.map((h, i) => `<button type="button" class="pill ghost" data-h="${i}">${icon(h.icon)}${esc(h.label)}</button>`).join('');
    $$('[data-h]', chips).forEach(b => b.onclick = () => list[Number(b.dataset.h)].run());
    pane.addEventListener('click', e => { const hideBtn = e.target.closest('[data-hide]'); if (hideBtn) { pane.hidden = true; pane.innerHTML = ''; } const cp = e.target.closest('[data-cp]'); if (cp) copyText(cp.dataset.cp, 'Copied'); });
}
// Project scope: show the inline folder browser under the choice; the input mirrors the chosen folder.
function mountScopePicker(panel, pfx) {
    const input = $(`#${pfx}-scope`, panel); if (!input) return;
    let host = $('[data-scope-pick]', panel);
    if (!host) { host = document.createElement('div'); host.dataset.scopePick = ''; host.hidden = true; host.style.marginTop = '8px'; input.insertAdjacentElement('afterend', host); }
    return { show: async () => { host.hidden = false; if (!host.innerHTML) await inlineFolderPicker(host, input.value || state.filesPath || '', p => { input.value = p; }); }, hide: () => { host.hidden = true; } };
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
        <div class="chips" data-helpers style="margin:-2px 0 8px"></div><div data-helper-pane class="helper-pane" hidden></div>
        <p class="sub" style="margin:0 2px 10px">Save with what you have: missing fields are marked incomplete and can be filled in later from the Vault.</p>
        ${isOAuth ? `<div class="field"><label>Redirect URL to register with ${esc(svc.title)}</label><div class="row plain" style="background:var(--sea-2);border-radius:12px;padding:10px 12px"><div class="main"><div class="title mono" style="font-size:13px;word-break:break-all;white-space:normal">${esc(redirect)}</div></div><button type="button" class="pill" data-copy-redirect>${icon('copy')}</button></div></div>
          ${svc.key === 'custom' || !preset.authUrl ? `<div class="field"><label for="cf-authUrl">Authorization URL</label><input id="cf-authUrl" type="text" class="mono" value="${esc(preset.authUrl || '')}" placeholder="https://provider/oauth/authorize"></div><div class="field"><label for="cf-tokenUrl">Access token URL</label><input id="cf-tokenUrl" type="text" class="mono" value="${esc(preset.tokenUrl || '')}" placeholder="https://provider/oauth/token"></div><div class="field"><label>Client authentication</label><div class="choices" data-cauth><button type="button" data-c="body" class="selected">Body</button><button type="button" data-c="header">Header (basic)</button></div></div><div class="field"><label>PKCE</label><div class="choices" data-pkce><button type="button" data-p="0" class="selected">Off</button><button type="button" data-p="1">On</button></div></div>` : `<p class="sub" style="margin:0 2px">Authorize: <span class="mono">${esc(preset.authUrl)}</span><br>Token: <span class="mono">${esc(preset.tokenUrl)}</span>${preset.pkce ? ' · PKCE' : ''}</p>`}` : ''}
        <div class="field"><label>Scope</label><div class="choices" data-scope><button type="button" data-s="general" class="selected">General</button><button type="button" data-s="project">One project</button></div><input id="cf-scope" type="text" class="mono" value="${esc(state.filesPath || '')}" placeholder="Projects/my-app" style="margin-top:8px" hidden autocapitalize="off" autocorrect="off" spellcheck="false"></div>
        <div class="field"><label for="cf-notes">Notes (optional)</label><input id="cf-notes" type="text" placeholder="Which account, expiry…"></div>
        <div class="buttons"><button class="primary" data-ok>${isOAuth ? 'Save and connect' : 'Save'}</button><button data-back-cat>Back to services</button><button data-close>Cancel</button></div>`);
    let scopeMode = 'general', cauth = preset.clientAuth || 'body', pkce = !!preset.pkce;
    const envPreview = () => { const p = $('#cf-prefix', panel).value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''); $('[data-envpreview]', panel).textContent = def.fields.map(f => `${p}_${f.env}`).join(', '); };
    envPreview(); $('#cf-prefix', panel).addEventListener('input', envPreview);
    mountHelpers(panel, style, 'cf');
    const cfPick = mountScopePicker(panel, 'cf');
    $$('[data-style] button', panel).forEach(b => b.onclick = () => { close(); credentialForm(svc, cat, b.dataset.st); });
    $$('[data-scope] button', panel).forEach(b => b.onclick = () => { scopeMode = b.dataset.s; $$('[data-scope] button', panel).forEach(x => x.classList.toggle('selected', x === b)); $('#cf-scope', panel).hidden = scopeMode === 'general'; if (scopeMode === 'general') cfPick?.hide(); else cfPick?.show(); });
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
            if (afterVaultSave) { const f = afterVaultSave; afterVaultSave = null; f(created); return; }
            if (isOAuth) { const r = await api(`/api/vault/${created.id}/oauth/start`, { method: 'POST' }); location.href = r.url; return; }
            loadVault();
        } catch (ex) { toast(ex.message, true); btn.disabled = false; }
    };
}

function vaultEditDialog(t) {
    const { panel, close } = openDialog(`<h2>${icon('edit')}${esc(t.name)}</h2><p class="muted">Leave a value empty to keep it.</p>
        <div class="field"><label for="ve-name">Name</label><input id="ve-name" type="text" value="${esc(t.name)}"></div>
        ${t.fields.filter(f => !['accessToken', 'refreshToken'].includes(f.name)).map(f => `<div class="field"><label for="ve-${f.name}">${esc(f.label)}${f.missing ? ' <span class="tag" style="color:var(--flare)">missing</span>' : ''} <span class="mono" style="text-transform:none;letter-spacing:0">${esc(f.env)}</span></label><input id="ve-${f.name}" type="${f.secret ? 'password' : 'text'}" class="mono" placeholder="${f.secret ? esc(f.hint) : esc(f.hint || '')}" autocapitalize="off" autocorrect="off" spellcheck="false"></div>`).join('')}
        <div class="chips" data-helpers style="margin:-2px 0 8px"></div><div data-helper-pane class="helper-pane" hidden></div>
        <div class="field"><label>Scope</label><div class="choices" data-scope><button type="button" data-s="general" class="${t.scope === 'general' ? 'selected' : ''}">General</button><button type="button" data-s="project" class="${t.scope !== 'general' ? 'selected' : ''}">One project</button></div><input id="ve-scope" type="text" class="mono" value="${esc(t.scope === 'general' ? (state.filesPath || '') : t.scope)}" style="margin-top:8px" ${t.scope === 'general' ? 'hidden' : ''}></div>
        <div class="field"><label for="ve-notes">Notes</label><input id="ve-notes" type="text" value="${esc(t.notes || '')}"></div>
        <div class="buttons"><button class="primary" data-ok>Save</button><button data-close>Cancel</button></div>`);
    let scopeMode = t.scope === 'general' ? 'general' : 'project';
    mountHelpers(panel, t.style, 've');
    const vePick = mountScopePicker(panel, 've');
    $$('[data-scope] button', panel).forEach(b => b.onclick = () => { scopeMode = b.dataset.s; $$('[data-scope] button', panel).forEach(x => x.classList.toggle('selected', x === b)); $('#ve-scope', panel).hidden = scopeMode === 'general'; if (scopeMode === 'general') vePick?.hide(); else vePick?.show(); });
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

// ---------- research ----------
// Topics under /Research: a paper an agent writes from sources it reads with the `research` tools. The app shows the
// built paper as pages, the sources with their free transcripts and OCR'd frames, the notes, and the things the agent is
// waiting on you for (downloads, frames, images). See docs/RESEARCH.md.
const researchState = { slug: null, tab: 'paper', data: null };
const fmtClock = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const kindIcon = k => ({ video: 'play', pdf: 'file-pdf', web: 'globe', file: 'file-text' }[k] || 'file-text');
const kindTone = k => ({ video: 'dock', pdf: 'flare', web: 'kelp', file: '' }[k] || '');
const askFacts = a => {
    const d = a.detail || {}; const rows = [];
    if (d.video) rows.push(['Video', d.video + (d.duration ? ` · ${fmtClock(d.duration)}` : '')]);
    if (d.url) { try { rows.push(['From', new URL(d.url).hostname]); } catch { /* not a url */ } }
    if (a.type === 'download-audio') { rows.push(['Then', `Whisper (${d.model || 'small'}${d.engine === 'openai' ? ', your OpenAI key' : ', on this box'}); no model tokens`]); rows.push(['Audio', 'deleted after transcribing']); }
    if (a.type === 'frames') { rows.push(['Frames', `1 every ${d.every || 30} s, a low-resolution copy of the video`]); rows.push(['First', 'OCR on the box (free); the video is deleted after']); }
    if (a.type === 'send-frames') rows.push(['Images', `${d.count || '?'} frame${d.count === 1 ? '' : 's'} shown to the agent (uses model tokens)`]);
    return rows;
};
function askCard(a) {
    const icoName = a.type === 'download-audio' ? 'download' : a.type === 'question' ? 'info' : 'image';
    const facts = askFacts(a);
    return `<div class="ask" data-ask="${esc(a.id)}" data-topic="${esc(a.topic)}"><div class="top"><span class="ico ${a.type === 'download-audio' ? 'dock' : 'brass'}">${icon(icoName)}</span><div><h3>${esc(a.title)}</h3><p class="sub">${esc(a.topicTitle || a.topic)}</p></div></div>
        ${facts.length ? `<div class="facts">${facts.map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join('')}</div>` : ''}
        ${a.type === 'question' ? `${a.detail?.why ? `<p class="why">${esc(a.detail.why)}</p>` : ''}${a.detail?.options?.length ? `<div class="opts" data-multi="${a.detail.multi ? 1 : 0}">${a.detail.options.map(o => `<button type="button" data-opt="${esc(o)}" aria-pressed="false">${esc(o)}</button>`).join('')}</div>${a.detail.multi ? '<p class="why">Pick any that apply.</p>' : ''}` : ''}<div class="field"><textarea data-answer rows="2" placeholder="${a.detail?.options?.length ? 'Or in your own words' : 'Your answer'}"></textarea></div>` : ''}
        <div class="go"><button class="btn pri" data-allow>${icon('check')}${a.type === 'question' ? 'Answer' : 'Allow'}</button><button class="btn" data-deny>${icon('x')}${a.type === 'question' ? 'You decide' : 'Skip'}</button></div></div>`;
}
function bindAsks(root, then) {
    $$('[data-ask]', root).forEach(card => {
        const decide = async verb => {
            const body = {}; const ans = $('[data-answer]', card); const isQ = !!ans;
            if (isQ) { body.answer = [...$$('[data-opt].on', card).map(b => b.dataset.opt), ans.value.trim()].filter(Boolean).join('; '); if (verb === 'allow' && !body.answer) return toast('Pick an option or write an answer', true); }
            $$('button', card).forEach(b => { b.disabled = true; });
            try { await api(`/api/research/${encodeURIComponent(card.dataset.topic)}/asks/${card.dataset.ask}/${verb}`, { method: 'POST', body }); toast(isQ ? (verb === 'allow' ? 'Answer sent to the agent' : 'The agent will decide') : verb === 'allow' ? 'Allowed' : 'Skipped'); } catch (ex) { toast(ex.message, true); }
            then();
        };
        const opts = $('.opts', card);
        if (opts) $$('[data-opt]', opts).forEach(b => b.onclick = () => { if (opts.dataset.multi !== '1') $$('[data-opt]', opts).forEach(x => { if (x !== b) { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); } }); const on = b.classList.toggle('on'); b.setAttribute('aria-pressed', String(on)); });
        $('[data-allow]', card).onclick = () => decide('allow'); $('[data-deny]', card).onclick = () => decide('deny');
    });
}

async function loadResearch() {
    const r = await api('/api/research');
    const sub = $('#more-research-sub'); if (sub) sub.textContent = r.asks.length ? `${r.asks.length} need${r.asks.length === 1 ? 's' : ''} you` : r.topics.length ? `${r.topics.length} topic${r.topics.length === 1 ? '' : 's'}` : 'Papers your agents write from sources';
    const body = $('#research-body');
    let html = `<div id="r-agent"></div>`;
    html += `<p class="r-sub">${r.topics.length ? `${r.topics.length} topic${r.topics.length === 1 ? '' : 's'} · papers built from sources your agents read` : 'A paper, written by an agent from real sources you can check.'}</p>`;
    if (r.asks.length) html += `<h2 class="section">Needs you</h2>${r.asks.map(askCard).join('')}`;
    html += r.topics.map(t => `<button class="r-card" data-topic="${esc(t.slug)}"><div class="r-cover" ${t.pages ? `style="background-image:url('/api/research/${encodeURIComponent(t.slug)}/page/1');background-size:cover;background-position:top"` : ''}>${t.pages ? '' : '<div class="t"></div><i></i><i></i><i style="width:60%"></i><i></i><i style="width:70%"></i>'}<div class="c"></div></div>
        <div><h3>${esc(t.title)}</h3><div class="r-meta"><span class="tag ${t.status === 'writing' ? 'brass' : ''}">${esc(t.status)}</span><span class="tag dim">${t.sources} source${t.sources === 1 ? '' : 's'}</span>${t.pages ? `<span class="tag dim">${t.pages} page${t.pages === 1 ? "" : "s"}</span>` : ''}${t.pending ? `<span class="tag brass">${t.pending} for you</span>` : ''}</div><div class="r-line">${t.builtAt ? `Built ${esc(new Date(t.builtAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}` : 'Not built yet'}</div></div></button>`).join('');
    html += `<button class="r-new" data-new-topic><span class="ico brass">${icon('plus')}</span>New research topic</button>`;
    body.innerHTML = html;
    researchAgentCard($('#r-agent', body)).catch(() => {});
    $$('[data-topic].r-card', body).forEach(b => b.onclick = () => openTopic(b.dataset.topic));
    $('[data-new-topic]', body).onclick = newTopicDialog;
    bindAsks(body, () => loadResearch().catch(() => {}));
}
// ---------- apps ----------
// Optional parts with their own tools. A card shows what adding it installs; Add installs it on the box (with its
// progress), then the card opens the app.
function openResearch() { go('apps'); push('research'); }
let appsPoll = null;
async function loadApps() {
    const { apps } = await api('/api/addons'); const box = $('#apps-body'); if (!box) return;
    box.innerHTML = apps.map(a => `<div class="app-card ${a.added ? 'on' : ''}" data-app="${esc(a.id)}">
        <div class="app-top"><span class="ico ${a.added ? 'brass' : ''}">${icon(a.icon)}</span><div class="app-name"><b>${esc(a.title)}</b><span class="app-state ${a.installing ? 'busy' : a.added ? 'ok' : ''}">${a.installing ? 'Adding…' : a.added ? 'Added' : 'Not added'}</span></div>
            ${a.added ? `<button class="btn pri" data-open>${icon('chevron')}Open</button>` : a.installing ? '' : `<button class="btn pri" data-add>${icon('plus')}Add app</button>`}</div>
        <p class="app-blurb">${esc(a.blurb)}</p>
        ${a.added ? '' : `<details class="app-what" ${a.installing ? 'open' : ''}><summary>What adding it installs · ${esc(a.size)}, ${esc(a.time)}</summary><ul>${a.installs.map(i => `<li>${esc(i)}</li>`).join('')}</ul></details>`}
        ${a.installing ? `<div class="app-progress"><span class="dotlive"></span><span>Installing on the box. You can leave this page; it carries on.</span></div><pre class="app-log" data-log></pre>` : ''}
        ${!a.installing && a.lastJob && a.lastJob.code !== null && a.lastJob.code !== 0 && !a.added ? `<p class="app-fail">The last attempt stopped (code ${a.lastJob.code}). <button class="link" data-showlog>Show what happened</button></p><pre class="app-log" data-log hidden></pre>` : ''}
        ${a.added ? `<div class="app-foot"><button class="link" data-remove>Remove app</button></div>` : ''}
    </div>`).join('') + '<p class="note app-more">More apps are on the way.</p>';
    for (const a of apps) {
        const card = $(`[data-app="${a.id}"]`, box);
        const open = $('[data-open]', card); if (open) open.onclick = () => (a.id === 'research' ? openResearch() : a.id === 'lab' ? openLab() : null);
        const add = $('[data-add]', card); if (add) add.onclick = async () => { add.disabled = true; try { await api(`/api/addons/${a.id}/add`, { method: 'POST', body: {} }); toast(`Adding ${a.title}…`); } catch (ex) { toast(ex.message, true); } loadApps().catch(() => {}); };
        const rm = $('[data-remove]', card); if (rm) rm.onclick = async () => { if (!(await confirmDialog({ title: `Remove ${a.title}?`, text: `${a.title} disappears from PlatOpypus. Your ${a.id === 'research' ? 'topics, papers and sources stay on the box' : 'data stays on the box'}, and so do the installed packages; add it again any time.`, action: 'Remove app' }))) return; try { await api(`/api/addons/${a.id}/remove`, { method: 'POST', body: {} }); toast(`${a.title} removed`); } catch (ex) { toast(ex.message, true); } loadApps().catch(() => {}); };
        const show = $('[data-showlog]', card); if (show) show.onclick = async () => { const pre = $('[data-log]', card); pre.hidden = false; pre.textContent = (await api(`/api/addons/${a.id}/log`)).log || '(nothing was written)'; };
        if (a.installing) { const pre = $('[data-log]', card); api(`/api/addons/${a.id}/log`).then(r => { pre.textContent = (r.log || '').split('\n').slice(-14).join('\n'); pre.scrollTop = pre.scrollHeight; }).catch(() => {}); }
    }
    clearTimeout(appsPoll);
    const was = new Set(apps.filter(a => a.installing).map(a => a.id));
    if (was.size) appsPoll = setTimeout(async () => { if (state.tab !== 'apps') return; const before = was; await loadApps().catch(() => {}); const now = (await api('/api/addons')).apps; for (const a of now) if (before.has(a.id) && !a.installing) toast(a.added ? `${a.title} is ready` : `${a.title} could not be added`, !a.added); }, 3000);
}
// ---------- Security Lab ----------
// Engagements: a scope you verify, runs (command, output, summary), findings, and agents that test inside the scope.
const labState = { slug: null, tab: 'scope', tools: {}, poll: null };
function openLab() { go('apps'); push('lab'); }
const mdLite = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/^- (.*)$/gm, '<li>$1</li>').replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`).replace(/^# (.*)$/gm, '<h4>$1</h4>');
async function loadLab() {
    const d = await api('/api/lab'); labState.tools = d.tools; const box = $('#lab-body');
    box.innerHTML = `<p class="r-sub">Test your own domains, services and applications, wherever they are hosted. Each engagement has a scope: only targets in it can be tested, by you or an agent.</p>
        ${d.engagements.map(e => `<button class="row lab-row" data-eng="${esc(e.slug)}"><span class="ico ${e.verified ? 'brass' : ''}">${icon('shield')}</span><div class="main"><div class="title">${esc(e.title)}</div><div class="sub">${e.targets} target${e.targets === 1 ? '' : 's'}${e.targets ? ` · ${e.verified} ready to test` : ''} · ${e.runs} run${e.runs === 1 ? '' : 's'}</div></div>${icon('chevron', 'i chev')}</button>`).join('')}
        <button class="r-new" data-new-eng><span class="ico brass">${icon('plus')}</span>New engagement</button>`;
    $$('[data-eng]', box).forEach(b => b.onclick = () => openEng(b.dataset.eng));
    $('[data-new-eng]', box).onclick = () => {
        const { panel, close } = openDialog(`<h2>${icon('shield')}New engagement</h2><div class="field"><label for="ng-title">Name</label><input id="ng-title" type="text" maxlength="100" placeholder="My sites, November"></div><p class="muted">Then add the domains and services to test on its Scope page.</p><div class="buttons"><button data-close>Cancel</button><button class="primary" data-ok>Create</button></div>`, { size: 'small' });
        const make = async () => { try { const e = await api('/api/lab', { method: 'POST', body: { title: $('#ng-title', panel).value } }); close(); openEng(e.slug, 'scope'); } catch (ex) { toast(ex.message, true); } };
        $('[data-ok]', panel).onclick = make; enterSubmits(panel, make);
    };
}
function openEng(slug, tab) { labState.slug = slug; if (tab) labState.tab = tab; push('eng'); loadEng().catch(e => toast(e.message, true)); }
async function loadEng() {
    const slug = labState.slug; const enc = encodeURIComponent(slug); const e = await api(`/api/lab/${enc}`);
    if (!Object.keys(labState.tools).length) labState.tools = (await api('/api/lab')).tools;
    $('#eng-title').textContent = e.title;
    const running = e.runs.some(r => r.status === 'running');
    $('#eng-seg').innerHTML = [['scope', `Scope${e.scope.length ? `<em>${e.scope.length}</em>` : ''}`], ['runs', `Runs${e.runs.length ? `<em>${e.runs.length}</em>` : ''}`], ['findings', 'Findings'], ['agent', 'Agent']].map(([k, l]) => `<button data-et="${k}" class="${labState.tab === k ? 'on' : ''}">${l}</button>`).join('');
    $$('#eng-seg [data-et]').forEach(b => b.onclick = () => { labState.tab = b.dataset.et; loadEng().catch(x => toast(x.message, true)); });
    const body = $('#eng-body'); const ready = e.scope.filter(t => t.status !== 'unverified');
    if (labState.tab === 'scope') {
        body.innerHTML = `<p class="note">Add what you own or are allowed to test. A domain is proved with a DNS record, which also covers its subdomains and the addresses it points to. Other addresses need your confirmation.</p>
            ${e.scope.map(t => `<div class="sc-row"><div class="sc-main"><b>${esc(t.value)}</b><span class="sc-kind">${esc(t.kind)}</span><span class="sc-st ${t.status}">${t.status === 'verified' ? 'Verified' : t.status === 'declared' ? 'Authorised by you' : 'Not verified yet'}</span></div>
                ${t.status === 'unverified' ? `<div class="sc-verify"><p>Add this TXT record at <span class="mono">${esc(t.value)}</span> (or at <span class="mono">_platopypus.${esc(t.value)}</span>), then check:</p><div class="sc-rec"><code>${esc(t.record)}</code><button class="btn" data-copy="${esc(t.record)}">${icon('copy')}Copy</button></div><div class="r-actions"><button class="btn pri" data-verify="${esc(t.value)}">${icon('check')}Check the record</button></div></div>` : ''}
                <div class="sc-acts"><button class="link" data-unscope="${esc(t.value)}">Remove</button></div></div>`).join('') || '<p class="empty">Nothing in scope yet.</p>'}
            <div class="card sc-add"><div class="field"><label for="sc-val">Domain, IP address or range</label><input id="sc-val" type="text" autocomplete="off" spellcheck="false" placeholder="example.com · 203.0.113.10 · 203.0.113.0/24"></div>
                <label class="chk-row"><input type="checkbox" id="sc-auth"> I own this or am authorised to test it (needed for an IP or range; for a domain it skips the DNS check)</label>
                <div class="r-actions"><button class="btn pri" data-scadd>${icon('plus')}Add to scope</button></div></div>`;
        $('[data-scadd]', body).onclick = async () => { try { await api(`/api/lab/${enc}/scope`, { method: 'POST', body: { value: $('#sc-val', body).value, authorised: $('#sc-auth', body).checked } }); loadEng(); } catch (ex) { toast(ex.message, true); } };
        $$('[data-verify]', body).forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await api(`/api/lab/${enc}/scope/verify`, { method: 'POST', body: { value: b.dataset.verify } }); toast(r.verified ? `${b.dataset.verify} verified` : 'The record was not found yet. DNS can take a few minutes; try again shortly.', !r.verified); loadEng(); } catch (ex) { toast(ex.message, true); b.disabled = false; } });
        $$('[data-copy]', body).forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch { toast('Copy it by hand', true); } });
        $$('[data-unscope]', body).forEach(b => b.onclick = async () => { if (!(await confirmDialog({ title: `Remove ${b.dataset.unscope}?`, text: 'It leaves the scope: nothing can be run against it until it is added again. Past runs are kept.', action: 'Remove' }))) return; try { await api(`/api/lab/${enc}/scope/remove`, { method: 'POST', body: { value: b.dataset.unscope } }); loadEng(); } catch (ex) { toast(ex.message, true); } });
    } else if (labState.tab === 'runs') {
        const tools = labState.tools;
        body.innerHTML = `<div class="card run-new"><div class="run-grid">
                <div class="field"><label for="rn-tool">Tool</label><select id="rn-tool">${Object.entries(tools).map(([k, t]) => `<option value="${esc(k)}">${esc(t.title)}</option>`).join('')}</select></div>
                <div class="field" data-tfield><label for="rn-target">Target</label><select id="rn-target">${ready.length ? ready.map(t => `<option>${esc(t.value)}</option>`).join('') : '<option value="">Nothing in scope yet</option>'}</select></div>
                <div class="field" data-pfield hidden><label for="rn-preset">Preset</label><select id="rn-preset"></select></div></div>
            <div class="r-actions"><button class="btn pri" data-run>${icon('play')}Run</button></div></div>
            ${e.runs.map(r => `<button class="row run-row" data-run-id="${esc(r.id)}"><span class="run-st ${r.status}"></span><div class="main"><div class="title">${esc(r.title)}${r.target ? ` · ${esc(r.target)}` : ''}</div><div class="sub">${r.status === 'running' ? 'Running…' : esc(r.headline || r.status)} · ${esc(new Date(r.started).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}${r.by !== 'phone' ? ` · ${esc(r.by)}` : ''}</div></div>${icon('chevron', 'i chev')}</button>`).join('') || '<p class="empty">No runs yet.</p>'}`;
        const syncTool = () => { const t = tools[$('#rn-tool', body).value]; $('[data-tfield]', body).hidden = !!t.local; const ps = $('[data-pfield]', body); ps.hidden = t.presets.length < 2; $('#rn-preset', body).innerHTML = t.presets.map(p => `<option>${esc(p)}</option>`).join(''); };
        $('#rn-tool', body).onchange = syncTool; syncTool();
        $('[data-run]', body).onclick = async () => { const tool = $('#rn-tool', body).value; try { const r = await api(`/api/lab/${enc}/run`, { method: 'POST', body: { tool, preset: $('#rn-preset', body).value || null, target: tools[tool].local ? null : $('#rn-target', body).value } }); toast(`Started ${r.id}`); loadEng(); } catch (ex) { toast(ex.message, true); } };
        $$('[data-run-id]', body).forEach(b => b.onclick = () => runDialog(slug, b.dataset.runId));
    } else if (labState.tab === 'findings') {
        body.innerHTML = `<p class="note">Agents add what they find here; you can edit it. Each finding should say where, how bad, which run shows it, and what to do.</p><textarea id="fd-text" rows="18" class="fd-text">${esc(e.findings)}</textarea><div class="r-actions"><button class="btn pri" data-fsave>${icon('check')}Save</button></div>`;
        const review = document.createElement('details');
        review.className = 'app-what';
        review.innerHTML = `<summary>Review a local report</summary>
            <p class="note">Open a UTF-8 report, log, or exported inventory up to 1 MiB. The file stays in this browser. Copy relevant excerpts into Findings to keep them.</p>
            <label for="lab-report">Report file</label>
            <input id="lab-report" type="file" accept=".txt,.log,.md,.csv,.tsv,.json,.jsonl,.ndjson,.xml,.html,.htm">
            <p class="note" data-report-status role="status"></p>
            <textarea class="fd-text" data-report-preview aria-label="Report preview" rows="14" readonly hidden></textarea>`;
        body.append(review);
        const input = $('#lab-report', review);
        const status = $('[data-report-status]', review);
        const preview = $('[data-report-preview]', review);
        input.onchange = async () => {
            const file = input.files[0];
            preview.value = '';
            preview.hidden = true;
            status.textContent = '';
            if (!file) return;
            if (file.size > 1024 * 1024) {
                status.textContent = 'Choose a report up to 1 MiB.';
                return;
            }
            try {
                const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
                if (input.files[0] !== file) return;
                if (text.includes('\0')) throw new Error('Binary data');
                preview.value = text;
                preview.hidden = false;
                status.textContent = file.name;
            } catch {
                if (input.files[0] === file) status.textContent = 'Could not read this file as UTF-8 text.';
            }
        };
        $('[data-fsave]', body).onclick = async () => { try { await api(`/api/lab/${enc}/findings`, { method: 'POST', body: { text: $('#fd-text', body).value } }); toast('Findings saved'); } catch (ex) { toast(ex.message, true); } };
    } else {
        const mine = (state.shells || []).filter(s => String(s.cwd || '').includes(`/Lab/${slug}`));
        body.innerHTML = `<p class="note">An agent here tests only what is in scope: its scans go through <span class="mono">lab run</span>, which refuses anything else. Codex or Gemini are the expected agents for autonomous testing.</p>
            ${mine.length ? `<div class="list">${mine.map(s => `<button class="row" data-sh="${esc(s.name)}"><span class="dot ${s.attached ? 'live' : ''}" style="margin:0 10px"></span><div class="main"><div class="title mono">${esc(s.name)}</div><div class="sub">${esc(agentTitle(s.agent))}</div></div>${icon('chevron', 'i chev')}</button>`).join('')}</div>` : '<p class="empty">No agent is working on this engagement.</p>'}
            <div class="r-actions"><button class="btn pri" data-start ${ready.length ? '' : 'disabled'}>${icon('claude')}Start an agent here</button></div>${ready.length ? '' : '<p class="note">Verify something in scope first.</p>'}
            <div class="r-danger"><div><b>Delete this engagement</b><span>Moves it to the box's trash, with its runs and findings.</span></div><button class="btn danger-btn" data-del-eng>${icon('trash')}Delete…</button></div>`;
        $$('[data-sh]', body).forEach(b => b.onclick = () => openTerminal(b.dataset.sh, 'Security Lab'));
        const st = $('[data-start]', body); if (st) st.onclick = () => newShellDialog(`Lab/${slug}`, 'agent', null, { firstPrompt: `Security Lab engagement: ${e.title}. Read .platopypus/lab.md and findings.md, run \`lab status\`, then test what is in scope, lightest checks first, and write what you find to findings.md.` });
        $('[data-del-eng]', body).onclick = () => {
            const { panel, close } = openDialog(`<h2>${icon('trash')}Delete this engagement?</h2><p class="muted">“${esc(e.title)}” moves to the box's trash with its runs and findings.</p><div class="field"><label for="de-name">Type the name to confirm</label><input id="de-name" type="text" autocomplete="off" placeholder="${esc(e.title)}"></div><div class="buttons"><button data-close>Cancel</button><button class="danger" data-ok disabled>Delete</button></div>`, { size: 'small' });
            const inp = $('#de-name', panel), ok = $('[data-ok]', panel); inp.oninput = () => { ok.disabled = inp.value.trim() !== e.title; };
            ok.onclick = async () => { try { await api(`/api/lab/${enc}/delete`, { method: 'POST', body: { confirm: inp.value } }); close(); toast('Moved to the trash'); openLab(); } catch (ex) { toast(ex.message, true); } };
        };
    }
    clearTimeout(labState.poll); if (running && labState.tab === 'runs') labState.poll = setTimeout(() => { if (!$('#page-eng').hidden && labState.tab === 'runs') loadEng().catch(() => {}); }, 4000);
}
async function runDialog(slug, id) {
    const r = await api(`/api/lab/${encodeURIComponent(slug)}/run/${id}`);
    openDialog(`<h2>${icon('terminal')}${esc(r.title)}</h2><p class="muted mono run-cmd">${esc(r.cmd)}</p>
        <div class="run-sum">${r.status === 'running' ? '<p>Still running…</p>' : mdLite(r.summary || '')}</div>
        <details class="run-out"><summary>Full output${r.files?.length ? ` · files: ${r.files.map(esc).join(', ')}` : ''}</summary><pre>${esc(r.output || '(none)')}</pre></details>
        <div class="buttons"><button data-close>Close</button></div>`);
}
// Which agent and model do research work: Ask answers, editor changes, citation checks, and new research sessions.
async function researchAgentCard(box) {
    const s = await api('/api/research-settings');
    const AG = [['claude', 'Claude Code', 'Anthropic', 'for example claude-opus-5-5, claude-sonnet-5-5'], ['codex', 'Codex CLI', 'OpenAI', 'for example gpt-5-codex'], ['antigravity', 'Antigravity', 'Google', 'set in Antigravity itself'], ['cline', 'Cline', 'Ollama', 'empty uses the model set for your Ollama server']];
    const draw = () => {
        box.innerHTML = `<div class="card r-agent"><div class="r-agent-h"><b>Research agent</b><span>${esc(AG.find(a => a[0] === s.agent)[1])}${s.agent !== 'antigravity' && s.models[s.agent] ? ` · ${esc(s.models[s.agent])}` : s.agent !== 'antigravity' ? ' · its default model' : ''}</span></div><div class="seg" role="radiogroup" aria-label="Research agent">${AG.map(([k, t, v]) => `<button role="radio" aria-checked="${s.agent === k}" data-ra="${k}" class="${s.agent === k ? 'on' : ''}"><b>${t}</b><span>${v}</span></button>`).join('')}</div>
            ${s.agent === 'antigravity' ? '<p class="note">Antigravity has no run-once mode, so questions, editor changes and citation checks use Claude Code. Sessions you start yourself use Antigravity.</p>' : `<div class="field"><label for="ra-model">Model (optional)</label><input id="ra-model" type="text" spellcheck="false" autocomplete="off" placeholder="${esc(AG.find(a => a[0] === s.agent)[3])}" value="${esc(s.models[s.agent] || '')}"><p class="note" style="margin-top:6px">Empty uses the agent's own default. The name goes to the agent's --model option as you type it.</p></div><div class="r-actions"><button class="btn" data-ra-save disabled>${icon('check')}Current model</button></div>`}
            <p class="note" style="margin:8px 0 0">Used for Ask, the editor's agent, citation checks, and research sessions you start.</p></div>`;
        $$('[data-ra]', box).forEach(b => b.onclick = async () => { try { Object.assign(s, await api('/api/research-settings', { method: 'PUT', body: { agent: b.dataset.ra } })); localStorage.setItem('porthole.researchAgent', s.agent); draw(); toast(`Research uses ${AG.find(a => a[0] === s.agent)[1]}`); } catch (ex) { toast(ex.message, true); } });
        const inp = $('#ra-model', box), sv0 = $('[data-ra-save]', box);
        if (inp && sv0) inp.oninput = () => { const changed = inp.value.trim() !== (s.models[s.agent] || ''); sv0.disabled = !changed; sv0.innerHTML = `${icon('check')}${changed ? 'Save model' : 'Current model'}`; };
        const sv = $('[data-ra-save]', box); if (sv) sv.onclick = async () => { const m = $('#ra-model', box).value.trim(); try { Object.assign(s, await api('/api/research-settings', { method: 'PUT', body: { models: { [s.agent]: m } } })); toast(m ? `Model set: ${m}` : "Back to the agent's default model"); draw(); } catch (ex) { toast(ex.message, true); } };
    };
    draw();
}
// Template and style for a topic: a LaTeX zip or an example PDF, your style notes, and pictures from it (a logo).
async function templateCard(box, slug) {
    const enc = encodeURIComponent(slug);
    const draw = ({ template: tp, structure, notes, images }) => {
        box.innerHTML = `<div class="card tpl">
            <div class="tpl-h"><b>Template and style</b><span>${tp ? `${esc(tp.name)} · ${tp.kind === 'latex' ? `LaTeX, ${tp.files} files${tp.adopted ? ', used as the paper' : ''}` : `example PDF, ${tp.pages} page${tp.pages === 1 ? '' : 's'}`}` : 'none yet (optional)'}</span></div>
            ${tp ? '' : '<p class="note" style="margin:0 0 10px">Upload a LaTeX template (a zip, such as Overleaf: Menu, Download, Source) or a PDF of a paper whose look you want. The agent keeps to its structure and style; it never cites or copies its text.</p>'}
            <div class="field"><label for="tpl-notes">Style notes (optional)</label><textarea id="tpl-notes" rows="3" placeholder="For example: two columns, Times, IEEE citations, our logo top left, no more than 8 pages">${esc(notes || '')}</textarea></div>
            ${images?.length ? `<p class="tpl-sub">Pictures from it (a logo?). Use one in the paper:</p><div class="tpl-imgs">${images.map(n => `<button class="tpl-img" data-img="${esc(n)}" title="${esc(n)}"><img alt="" src="/api/files/download?inline=1&path=${encodeURIComponent(`Research/${slug}/template/${n}`)}"><span>${esc(n.split('/').pop())}</span></button>`).join('')}</div>` : ''}
            ${!tp || tp.kind === 'latex' ? `<label class="chk-row"><input type="checkbox" id="tpl-adopt"> For a LaTeX zip: make it the paper's starting point (the current paper is kept as a version)</label>` : ''}
            <div class="r-actions"><button class="btn" data-tpl-up>${icon('upload')}${tp ? 'Replace' : 'Upload a zip or PDF'}</button><button class="btn" data-tpl-save>${icon('check')}Save notes</button>${tp ? `<button class="btn" data-tpl-rm>${icon('x')}Remove</button>` : ''}<input type="file" id="tpl-file" accept=".zip,.pdf,application/zip,application/pdf" hidden></div>
            ${structure ? `<details class="tpl-struct"><summary>What the agent takes from it</summary><pre class="r-notes">${esc(structure)}</pre></details>` : ''}</div>`;
        $('[data-tpl-up]', box).onclick = () => $('#tpl-file', box).click();
        $('#tpl-file', box).onchange = async e => { const f = e.target.files[0]; if (!f) return; try { draw(await uploadTemplate(slug, f, !!$('#tpl-adopt', box)?.checked)); } catch (ex) { toast(ex.message, true); } };
        $('[data-tpl-save]', box).onclick = async () => { try { draw(await api(`/api/research/${enc}/template/notes`, { method: 'POST', body: { text: $('#tpl-notes', box).value } })); toast('Style notes saved'); } catch (ex) { toast(ex.message, true); } };
        const rm = $('[data-tpl-rm]', box); if (rm) rm.onclick = async () => { if (!(await confirmDialog({ title: 'Remove the template?', text: 'The template or example, its style notes and its pictures are removed from this topic. Pictures you already copied into the paper stay.', action: 'Remove template' }))) return; try { await api(`/api/research/${enc}/template/remove`, { method: 'POST', body: {} }); draw({ template: null, structure: '', notes: '', images: [] }); } catch (ex) { toast(ex.message, true); } };
        $$('[data-img]', box).forEach(b => b.onclick = async () => { try { const r = await api(`/api/research/${enc}/template/use-image`, { method: 'POST', body: { name: b.dataset.img } }); try { await navigator.clipboard.writeText(r.latex); } catch { /* no clipboard */ } toast(`Copied to ${r.file}. The line to show it is on your clipboard: ${r.latex}`); } catch (ex) { toast(ex.message, true); } });
    };
    draw(await api(`/api/research/${enc}/template`));
}
async function uploadTemplate(slug, file, adopt) {
    toast(`Uploading ${file.name}…`);
    const res = await fetch(`/api/research/${encodeURIComponent(slug)}/template?name=${encodeURIComponent(file.name)}${adopt ? '&adopt=1' : ''}`, { method: 'POST', headers: { 'X-Plato': '1', 'Content-Type': 'application/octet-stream' }, body: file, credentials: 'same-origin' });
    const r = await res.json().catch(() => ({})); if (!res.ok) throw new Error(r.error || res.statusText);
    toast(r.template.adopted ? 'The template is now the paper' : 'Template saved: the agent will keep to it'); return r;
}
// Delete a topic: it goes to the box's trash with its history. Typing the title makes it deliberate.
function deleteTopicDialog(t) {
    const { panel, close } = openDialog(`<h2>${icon('trash')}Delete this topic?</h2>
        <p class="muted">“${esc(t.title)}” moves to the box's trash with its paper, ${t.sources.length} source${t.sources.length === 1 ? '' : 's'}, notes and history. It is not lost until the trash is emptied, but it disappears from Research.</p>
        <div class="field"><label for="del-name">Type the title to confirm</label><input id="del-name" type="text" autocomplete="off" spellcheck="false" placeholder="${esc(t.title)}"></div>
        <div class="buttons"><button data-close>Cancel</button><button class="danger" data-ok disabled>Delete topic</button></div>`, { size: 'small' });
    const inp = $('#del-name', panel), ok = $('[data-ok]', panel);
    inp.oninput = () => { ok.disabled = inp.value.trim() !== t.title; };
    ok.onclick = async () => { ok.disabled = true; try { await api(`/api/research/${encodeURIComponent(t.slug)}/delete`, { method: 'POST', body: { confirm: inp.value } }); close(); toast(`“${t.title}” moved to the trash`); openResearch(); } catch (ex) { toast(ex.message, true); ok.disabled = false; } };
    setTimeout(() => inp.focus(), 50);
}
// Delete a source: say plainly what it would break before doing it.
async function deleteSourceDialog(slug, id, after) {
    const u = await api(`/api/research/${encodeURIComponent(slug)}/source/${id}/uses`);
    const warn = u.uses.length ? `The paper cites it ${u.uses.length} time${u.uses.length === 1 ? '' : 's'} as ${u.key} (${u.uses.slice(0, 4).map(x => `${x.file.replace(/^sections\//, '')} line ${x.line}`).join(', ')}${u.uses.length > 4 ? ', …' : ''}). Those citations will show as missing until you change them.` : u.inBib ? 'It is in refs.bib but not cited anywhere in the paper.' : 'The paper does not cite it.';
    const yes = await confirmDialog({ title: `Delete ${u.id}?`, text: `“${u.title}” and its file, text and record move to this topic's trash, and its entry leaves refs.bib. ${warn}`, action: 'Delete source' });
    if (!yes) return; try { await api(`/api/research/${encodeURIComponent(slug)}/source/${id}/delete`, { method: 'POST', body: {} }); toast(`${u.id} deleted`); after?.(); } catch (ex) { toast(ex.message, true); }
}
function newTopicDialog() {
    const { panel, close } = openDialog(`<h2>${icon('file-text')}New research topic</h2>
        <div class="field"><label for="rt-title">Title</label><input id="rt-title" type="text" maxlength="120" placeholder="Tidal energy storage in coastal grids" autocapitalize="sentences"></div>
        <div class="field"><label>Start with</label><div class="seg2" role="radiogroup"><button type="button" role="radio" aria-checked="true" class="on" data-start="blank"><b>A blank paper</b><span>An empty LaTeX paper. Add sources and write.</span></button><button type="button" role="radio" aria-checked="false" data-start="tpl"><b>A template or example</b><span>A LaTeX zip or a PDF whose look to keep.</span></button></div></div>
        <div data-tplbox hidden><div class="field"><input type="file" id="rt-file" accept=".zip,.pdf,application/zip,application/pdf"></div><label class="chk-row"><input type="checkbox" id="rt-adopt" checked> For a LaTeX zip: make it the paper itself</label><div class="field"><label for="rt-notes">Style notes (optional)</label><textarea id="rt-notes" rows="2" placeholder="Two columns, IEEE citations, our logo top left"></textarea></div></div>
        <div class="field"><label for="rt-brief">What should it find out? (optional, for an agent)</label><textarea id="rt-brief" rows="3" placeholder="Scope, questions, what kind of sources, how long"></textarea></div>
        <label class="chk-row"><input type="checkbox" id="rt-agent"> Start a research agent on it now</label>
        <div class="buttons"><button data-close>Cancel</button><button class="primary" data-ok>Create</button></div>`);
    let start = 'blank';
    $$('[data-start]', panel).forEach(b => b.onclick = () => { start = b.dataset.start; $$('[data-start]', panel).forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); }); $('[data-tplbox]', panel).hidden = start !== 'tpl'; });
    $('[data-ok]', panel).onclick = async () => {
        const title = $('#rt-title', panel).value.trim(), brief = $('#rt-brief', panel).value.trim(), agent = $('#rt-agent', panel).checked;
        if (title.length < 3) return toast('Give the topic a title', true);
        const file = $('#rt-file', panel).files[0]; if (start === 'tpl' && !file) return toast('Choose the template zip or example PDF, or start with a blank paper', true);
        $('[data-ok]', panel).disabled = true;
        try {
            const t = await api('/api/research', { method: 'POST', body: { title, brief, blank: !agent } });
            if (start === 'tpl') { await uploadTemplate(t.slug, file, $('#rt-adopt', panel).checked); const n = $('#rt-notes', panel).value.trim(); if (n) await api(`/api/research/${encodeURIComponent(t.slug)}/template/notes`, { method: 'POST', body: { text: n } }); }
            close(); await openTopic(t.slug, 'paper');
            if (agent) newShellDialog(`Research/${t.slug}`, 'agent', null, { firstPrompt: `Research: ${title}.${brief ? '\n\n' + brief : ''}\n\nRead notes/outline.md and .platopypus/research.md first, then gather sources with the research tools and write the paper.` });
        } catch (ex) { toast(ex.message, true); $('[data-ok]', panel).disabled = false; }
    };
}

async function openTopic(slug, tab) {
    researchState.slug = slug; if (tab) researchState.tab = tab;
    push('topic'); await loadTopic();
}
async function loadTopic() {
    const slug = researchState.slug; if (!slug) return;
    const t = researchState.data = await api(`/api/research/${encodeURIComponent(slug)}`);
    $('#topic-title').textContent = t.title;
    const pendingN = t.asks.filter(a => a.status === 'pending').length;
    $('#topic-seg').innerHTML = [['paper', 'Paper'], ['sources', `Sources${t.sources.length ? `<em>${t.sources.length}</em>` : ''}`], ['notes', 'Notes'], ['ask', 'Ask'], ['agent', `Agent${pendingN ? `<em>${pendingN}</em>` : ''}`]].map(([k, l]) => `<button data-tt="${k}" class="${researchState.tab === k ? 'on' : ''}">${l}</button>`).join('');
    $$('#topic-seg [data-tt]').forEach(b => b.onclick = () => { researchState.tab = b.dataset.tt; loadTopic().catch(e => toast(e.message, true)); });
    const body = $('#topic-body'); const tab = researchState.tab;
    const enc = encodeURIComponent(slug);
    if (tab === 'paper') {
        const b = t.build;
        let html = '';
        if (t.pagesAvailable) html += `<div class="r-pages">${Array.from({ length: t.pagesAvailable }, (_, i) => `<img class="r-page" loading="lazy" alt="Page ${i + 1} of ${t.pagesAvailable}" src="/api/research/${enc}/page/${i + 1}?v=${b?.at || 0}">`).join('')}</div>`;
        else html += `<div class="card"><p style="margin:0">${b && !b.ok ? 'The last build failed.' : 'Not built yet.'} Press Build whenever you want to see it.</p></div>`;
        html += `<div class="r-actions"><button class="btn pri" data-build>${icon('restart')}Build</button><a class="btn" href="/editor.html?topic=${enc}" target="_blank" rel="noopener">${icon('file-text')}Edit</a><button class="btn" data-export>${icon('download')}Export</button></div>`;
        if (b) html += `<div class="r-build ${b.ok ? '' : 'bad'}"><span class="dotlive ${b.ok ? '' : 'flare'}"></span>${b.ok ? `Built ${esc(new Date(b.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))} · ${b.pages} page${b.pages === 1 ? "" : "s"} · ${b.warnings} warning${b.warnings === 1 ? '' : 's'} · ${(b.ms / 1000).toFixed(1)} s` : `Build failed: ${esc((b.errors || []).join(' · ') || 'see paper/build/main.log')}`}</div>${b.undefinedCites?.length ? `<div class="r-build bad"><span class="dotlive flare"></span>Undefined citations: ${esc(b.undefinedCites.join(', '))}</div>` : ''}`;
        body.innerHTML = html;
        $('[data-build]', body).onclick = async e => { const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Building…'; try { const r = await api(`/api/research/${enc}/build`, { method: 'POST' }); toast(r.ok ? `Built: ${r.pages} page${r.pages === 1 ? "" : "s"}` : 'The build failed', !r.ok); } catch (ex) { toast(ex.message, true); } loadTopic().catch(() => {}); };
        $('[data-export]', body).onclick = () => exportDialog(t);
        const tb = document.createElement('div'); tb.className = 'tpl-wrap'; body.appendChild(tb); templateCard(tb, slug).catch(() => {});
        const dz = document.createElement('div'); dz.className = 'r-danger'; dz.innerHTML = `<div><b>Delete this topic</b><span>Moves it to the box's trash, with its history.</span></div><button class="btn danger-btn" data-del-topic>${icon('trash')}Delete…</button>`; body.appendChild(dz); $('[data-del-topic]', dz).onclick = () => deleteTopicDialog(t);
    } else if (tab === 'ask') {
        const questions = (await api(`/api/research/${enc}/questions`)).questions.filter(q => !q.kind);   // edit requests live in the editor
        const cite = s => esc(s).replace(/\[(s\d{2,4})([^\]]{0,24})\]/g, (m, id, w) => `<button class="r-cite" data-src="${id}">${id}${w}</button>`);
        body.innerHTML = `<p class="r-sub">Ask anything about this topic. The answer comes from its sources and stays here as a note unless you add it to the paper.</p>
            <div class="r-thread">${questions.length ? questions.map(q => `<div class="r-q" data-q="${esc(q.id)}"><p class="you">${esc(q.text)}</p>${q.status === 'waiting' ? `<p class="wait"><span class="dotlive"></span>${q.problem ? esc(q.problem) : 'Looking through the sources…'}</p>` : `<div class="ans">${cite(q.answer || '')}</div><div class="r-actions">${q.toPaper === 'done' ? `<span class="tag" style="color:var(--kelp)">In the paper · ${esc(q.section || '')}</span>` : q.toPaper === 'requested' ? `<span class="tag dim">${q.problem ? esc(q.problem) : 'Being added to the paper…'}</span>` : `<button class="btn" data-add>${icon('plus')}Add to paper</button>`}<button class="btn" data-drop>${icon('x')}Remove</button></div>`}</div>`).join('') : '<p class="empty">No questions yet.</p>'}</div>
            <div class="r-askbox"><textarea id="r-ask" rows="2" placeholder="What do you want to know?"></textarea><button class="btn pri" data-send>${icon('send')}Ask</button></div>`;
        $('[data-send]', body).onclick = async e => { const v = $('#r-ask', body).value.trim(); if (!v) return toast('Write the question first', true); e.currentTarget.disabled = true; try { await api(`/api/research/${enc}/questions`, { method: 'POST', body: { text: v } }); } catch (ex) { toast(ex.message, true); } loadTopic().catch(() => {}); };
        $$('.r-q', body).forEach(card => { const id = card.dataset.q;
            const add = $('[data-add]', card); if (add) add.onclick = async () => { add.disabled = true; try { await api(`/api/research/${enc}/questions/${id}/add`, { method: 'POST', body: {} }); toast('An agent is working it into the paper'); } catch (ex) { toast(ex.message, true); } loadTopic().catch(() => {}); };
            const drop = $('[data-drop]', card); if (drop) drop.onclick = async () => { if (!(await confirmDialog({ title: 'Remove this question?', text: 'The question and its answer are removed from this topic. Anything already added to the paper stays.', action: 'Remove' }))) return; try { await api(`/api/research/${enc}/questions/${id}/remove`, { method: 'POST', body: {} }); } catch (ex) { toast(ex.message, true); } loadTopic().catch(() => {}); };
        });
        $$('.r-cite', body).forEach(b => b.onclick = () => sourceDialog(slug, b.dataset.src));
        // While something is being answered, look again every few seconds (only while this tab is still showing).
        clearTimeout(researchState.poll);
        if (questions.some(q => q.status === 'waiting' || q.toPaper === 'requested')) researchState.poll = setTimeout(() => { if (researchState.tab === 'ask' && !$('#page-topic').hidden && !$('#r-ask')?.value) loadTopic().catch(() => {}); }, 6000);
    } else if (tab === 'sources') {
        const c = t.cost;
        let html = `<div class="tokens"><div class="free"><b>${(c.ingestedChars / 1000).toFixed(0)}k</b><span>characters read for you by the tools</span></div><div><b>${c.excerpts + c.searches}</b><span>excerpts and searches by the agent</span></div><div><b>${(c.readChars / 1000).toFixed(1)}k</b><span>characters it actually read</span></div></div>`;
        html += `<div class="r-drop" data-drop><div><b>Drop files here</b><span>PDF, Word, images, text, CSV, HTML, LaTeX, or a .bib of references</span></div><button class="btn" data-addfiles>${icon('upload')}Choose files</button><input type="file" data-filein multiple hidden accept=".pdf,.docx,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.markdown,.csv,.tsv,.tex,.html,.htm,.json,.bib"></div><div class="r-link"><input type="url" data-link placeholder="Or paste a link: a web page, a PDF, a YouTube video"><button class="btn" data-addlink>Add</button></div>`;
        html += t.sources.length ? `<div class="list">${t.sources.map(s => `<button class="row" data-src="${esc(s.id)}"><span class="ico ${kindTone(s.kind)}">${icon(kindIcon(s.kind))}</span><div class="main"><div class="title">${esc(s.title)}</div><div class="sub"><span class="mono">${esc(s.id)}</span> · ${esc(s.kind)}${s.author ? ' · ' + esc(s.author) : ''}${s.year ? ' · ' + esc(s.year) : ''}${s.state?.transcript ? ` · transcript (${esc(s.state.transcript.replace('whisper-', 'Whisper '))})` : s.kind === 'video' ? ' · no transcript yet' : ''}${s.state?.frames ? ` · ${s.state.frames.count} frames` : ''}</div></div>${icon('chevron', 'i chev')}</button>`).join('')}</div>` : '<p class="empty">No sources yet. Drop files above, paste a link, or let an agent find them.</p>';
        body.innerHTML = html;
        $$('[data-src]', body).forEach(b => b.onclick = () => sourceDialog(slug, b.dataset.src));
        // adding sources by hand: drop or choose files (several at once), or paste a link
        const send = async files => {
            let ok = 0; for (const f of files) { toast(`Adding ${f.name}…`);
                try { const res = await fetch(`/api/research/${enc}/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'X-Plato': '1', 'Content-Type': 'application/octet-stream' }, body: f, credentials: 'same-origin' }); const r = await res.json().catch(() => ({})); if (!res.ok) throw new Error(`${f.name}: ${r.error || res.statusText}`); ok += r.imported || 1; } catch (ex) { toast(ex.message, true); } }
            if (ok) toast(`Added ${ok} source${ok === 1 ? '' : 's'}`); loadTopic().catch(() => {});
        };
        const dz = $('[data-drop]', body);
        $('[data-addfiles]', body).onclick = () => $('[data-filein]', body).click();
        $('[data-filein]', body).onchange = e => { const l = [...e.target.files]; e.target.value = ''; if (l.length) send(l); };
        ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
        ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, () => dz.classList.remove('over')));
        dz.addEventListener('drop', e => { e.preventDefault(); const l = [...(e.dataTransfer?.files || [])]; if (l.length) send(l); });
        $('[data-addlink]', body).onclick = async () => { const u = $('[data-link]', body).value.trim(); if (!/^https?:\/\//i.test(u)) return toast('Paste a web address (https://…)', true); toast('Fetching…'); try { const r = await api(`/api/research/${enc}/sources`, { method: 'POST', body: { url: u } }); toast(`Added ${r.meta?.id || 'the source'}`); loadTopic().catch(() => {}); } catch (ex) { toast(ex.message, true); } };
    } else if (tab === 'notes') {
        body.innerHTML = `<h2 class="section">Outline</h2><pre class="r-notes">${esc(t.notes.outline || '(empty)')}</pre><h2 class="section">Claims and their evidence</h2><pre class="r-notes">${esc(t.notes.claims || '(none yet)')}</pre>
            <div class="r-actions"><button class="btn" data-edit="outline">${icon('pencil')}Edit outline</button><button class="btn" data-edit="claims">${icon('pencil')}Edit claims</button></div>`;
        $$('[data-edit]', body).forEach(b => b.onclick = () => openEditor(`Research/${slug}/notes/${b.dataset.edit}.md`, `${b.dataset.edit}.md`));
    } else {
        const mine = (state.shells || []).filter(s => String(s.cwd || '').replace(/\/+$/, '').endsWith(`/Research/${slug}`) || String(s.cwd || '').includes(`/Research/${slug}/`));
        const pend = t.asks.filter(a => a.status === 'pending').map(a => ({ ...a, topicTitle: t.title }));
        body.innerHTML = `${pend.length ? `<h2 class="section">Needs you</h2>${pend.map(askCard).join('')}` : ''}
            <h2 class="section">Tell the agent something</h2>
            <div class="field"><textarea id="r-note" rows="2" placeholder="A change of direction, something to include, something to leave out"></textarea></div>
            <div class="r-actions"><button class="btn" data-note>${icon('send')}Send note</button></div>
            ${(() => { const done = t.asks.filter(a => (a.type === 'question' || a.type === 'note') && a.status !== 'pending').slice(0, 20); return done.length ? `<h2 class="section">Asked and answered</h2><div class="qa">${done.map(a => `<div><p class="q">${esc(a.type === 'note' ? 'Your note' : a.title)}</p><p class="a">${esc(a.status === 'denied' ? 'Left to the agent' : a.answer || '')}</p></div>`).join('')}</div>` : ''; })()}
            <h2 class="section">Agents in this topic</h2>${mine.length ? `<div class="list">${mine.map(s => `<button class="row" data-sh="${esc(s.name)}"><span class="dot ${s.attached ? 'live' : ''}" style="margin:0 10px"></span><div class="main"><div class="title mono">${esc(s.name)}</div><div class="sub">${esc(agentTitle(s.agent))}${useBubble(usageSeen.shells[s.name]) ? '' : ''}</div></div>${icon('chevron', 'i chev')}</button>`).join('')}</div>` : '<p class="empty">No agent is working on this topic.</p>'}
            <div class="r-actions"><button class="btn pri" data-start>${icon('claude')}Start an agent here</button></div>
            <p class="muted" style="margin-top:12px">The agent uses the <span class="mono">research</span> tools: it adds sources, searches them, reads small excerpts and cites as it writes. Downloads, frames and images wait for your Allow.</p>`;
        $$('[data-sh]', body).forEach(b => b.onclick = () => openTerminal(b.dataset.sh, 'Research'));
        $('[data-note]', body).onclick = async () => { const v = $('#r-note', body).value.trim(); if (!v) return toast('Write the note first', true); try { await api(`/api/research/${enc}/note`, { method: 'POST', body: { text: v } }); toast('The agent will see it at its next step'); loadTopic().catch(() => {}); } catch (ex) { toast(ex.message, true); } };
        $('[data-start]', body).onclick = () => newShellDialog(`Research/${slug}`, 'agent', null, { firstPrompt: `Continue the research on: ${t.title}. Read notes/outline.md and .platopypus/research.md first, then \`research status\`.` });
        bindAsks(body, () => loadTopic().catch(() => {}));
    }
}
function exportDialog(t) {
    const enc = encodeURIComponent(t.slug);
    const items = [['pdf', 'PDF', 'file-pdf', t.pagesAvailable ? 'The built paper' : 'Build it first'], ['tex', 'LaTeX source', 'file-code', 'main.tex, sections, references (zip)'], ['bib', 'BibTeX', 'file-text', 'The references file'], ['csv', 'Source list', 'file-text', 'Every source and its record, cited or not (CSV)'], ['zip', 'Everything', 'file-archive', 'Paper, sources, notes (zip, no raw media)']];
    openDialog(`<h2>${icon('download')}Export</h2><div class="list">${items.map(([k, l, ic, sub]) => `<a class="row" href="/api/research/${enc}/export/${k}" download style="text-decoration:none;color:inherit"><span class="ico">${icon(ic)}</span><div class="main"><div class="title">${l}</div><div class="sub">${esc(sub)}</div></div>${icon('download', 'i chev')}</a>`).join('')}</div><div class="buttons"><button data-close>Close</button></div>`);
}
async function sourceDialog(slug, id) {
    let v; try { v = await api(`/api/research/${encodeURIComponent(slug)}/source/${id}`); } catch (ex) { return toast(ex.message, true); }
    const m = v.meta; const enc = encodeURIComponent(slug);
    const frames = (v.frames || []);
    const { panel, close } = openDialog(`<h2>${icon(kindIcon(m.kind))}${esc(m.id)} · ${esc(m.kind)}</h2>
        <h3 style="margin:2px 0 4px;font-size:18px;line-height:1.25">${esc(m.title)}</h3>
        <p class="muted" style="margin:0 0 10px">${esc([m.author, m.year, m.site].filter(Boolean).join(' · '))}${m.url ? ` · <a href="${esc(m.url)}" target="_blank" rel="noopener">open ↗</a>` : ''}</p>
        <div class="chips" style="flex-wrap:wrap;margin-bottom:8px"><span class="tag dim">cite as <span class="mono">${esc(m.key)}</span></span>${m.state?.transcript ? `<span class="tag" style="color:var(--kelp)">transcript · ${esc(m.state.transcript.replace('whisper-', 'Whisper '))}</span>` : ''}<span class="tag dim">${(v.chars / 1000).toFixed(0)}k chars</span>${m.kind === 'pdf' ? `<a class="tag" href="/api/research/${enc}/source/${esc(m.id)}/original">original PDF</a>` : ''}</div>
        ${frames.length ? `<div class="strip">${frames.slice(0, 40).map(f => `<div class="frame"><img class="im" loading="lazy" alt="" src="/api/research/${enc}/source/${esc(m.id)}/frame/${esc(f.frame)}"><div class="ts"><span>${fmtClock(f.t)}</span><span class="ocr">${f.visual ? 'image' : 'OCR ✓'}</span></div></div>`).join('')}</div>` : ''}
        <div style="max-height:46vh;overflow:auto;margin-top:6px">${v.transcript ? v.transcript.map(l => `<div class="tr"><time>${fmtClock(l.t)}</time><span>${esc(l.text)}</span></div>`).join('') : `<pre class="r-notes" style="max-height:none">${esc(v.text)}${v.chars > v.text.length ? '\n\n[…]' : ''}</pre>`}</div>
        <div class="buttons"><button class="danger" data-del-src>Delete source</button><button data-close>Close</button></div>`);
    $('[data-del-src]', panel).onclick = () => { close(); deleteSourceDialog(slug, m.id, () => loadTopic().catch(() => {})); };
}

$('#topic-back').addEventListener('click', () => openResearch());
$('#research-back').addEventListener('click', () => go('apps'));
$('#lab-back').addEventListener('click', () => go('apps'));
$('#eng-back').addEventListener('click', () => openLab());
$('#eng-refresh').addEventListener('click', () => loadEng().catch(e => toast(e.message, true)));
$('#topic-refresh').addEventListener('click', () => loadTopic().catch(e => toast(e.message, true)));

// ---------- backups ----------
let afterStorageSave = null;
async function addBackupStorage() {
    const cat = await getCatalog().catch(ex => { toast(ex.message, true); return null; });
    const svc = cat?.services.find(s => s.key === 'backup-storage');
    if (!svc) return toast('The Backup storage service is missing from the catalogue.', true);
    afterVaultSave = () => push('backups');
    credentialForm(svc, cat, 's3Bucket');
}
function fmtMB(n) { return n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : (n / 1048576).toFixed(1) + ' MB'; }
async function loadBackups() {
    const s = await api('/api/backups');
    const sub = $('#more-backups-sub'); if (sub) sub.textContent = s.storage ? `${s.storage.bucket} · keep ${s.keep}${s.daily !== null ? ` · daily at ${String(s.daily).padStart(2, '0')}:00` : ''}` : 'Not set up · project data to your private S3 bucket';
    const body = $('#backups-body');
    const live = (await api('/api/live').catch(() => [])).filter(p => !p.errors.length);
    let html = '<h2 class="section">Storage</h2>';
    if (!s.storage) html += `<div class="card"><p style="margin:0 0 12px">Backups go to an S3 bucket of yours. Add its key, secret, bucket and region to the Vault as <b>Backup storage (S3)</b>; a key that can only use that one bucket is enough.</p><button class="primary" data-addstorage>${icon('plus')}Add backup storage</button></div>`;
    else html += `<div class="list"><div class="row"><span class="ico kelp">${icon('cloud-up')}</span><div class="main"><div class="title">${esc(s.storage.name)}</div><div class="sub mono">${esc(s.storage.bucket)} · ${esc(s.storage.region)}</div></div><button class="text-btn" data-checkstorage>Test</button></div>
        <div class="row"><div class="main"><div class="title">Keep</div><div class="sub">Archives kept per project; older ones are removed after each run</div></div><input type="number" min="1" max="365" value="${s.keep}" data-keep style="width:72px;text-align:right"></div>
        <div class="row"><div class="main"><div class="title">Daily backup</div><div class="sub">${s.daily === null ? 'Off: only when you tap Back up' : `Every day at ${String(s.daily).padStart(2, '0')}:00 box time, for the projects switched on below`}</div></div><select data-daily><option value="">Off</option>${[...Array(24).keys()].map(h => `<option value="${h}" ${s.daily === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></div></div>`;
    html += `<h2 class="section">Projects</h2>`;
    if (!live.length) html += '<p class="empty">No project with a PORTHOLE.md yet.</p>';
    else html += `<div class="list">${live.map(p => { const st = s.projects[p.project] || {}; return `<div class="row"><span class="ico ${st.last ? 'kelp' : ''}">${icon('folder')}</span><div class="main"><div class="title">${esc(p.name)}</div><div class="sub" style="white-space:normal">${st.lastError ? `<span style="color:var(--flare)">Failed ${new Date(st.lastError.at).toLocaleString()}: ${esc(st.lastError.message)}</span><br>` : ''}${st.last ? `Last: ${new Date(st.last.at).toLocaleString()} · ${fmtMB(st.last.size)} · ${esc(st.last.paths.join(', '))}` : 'Never backed up'}</div></div>${s.daily !== null ? `<button class="switch ${st.daily ? 'on' : ''}" data-pdaily="${esc(p.project)}" role="switch" aria-checked="${!!st.daily}" aria-label="Daily"><span></span></button>` : ''}<button class="text-btn" data-pbackup="${esc(p.project)}" ${s.storage ? '' : 'disabled'}>Back up</button><button class="text-btn" data-plist="${esc(p.project)}" ${s.storage ? '' : 'disabled'}>List</button></div>`; }).join('')}</div>`;
    body.innerHTML = html;
    const put = async b => { try { await api('/api/backups', { method: 'PUT', body: b }); } catch (ex) { toast(ex.message, true); } loadBackups().catch(() => {}); };
    $$('[data-addstorage]', body).forEach(b => b.onclick = () => addBackupStorage());
    const cs = $('[data-checkstorage]', body); if (cs) cs.onclick = async () => { cs.disabled = true; try { const r = await api('/api/backups/check', { method: 'POST' }); toast(`Bucket ${r.bucket} works`); } catch (ex) { toast(ex.message, true); } cs.disabled = false; };
    const k = $('[data-keep]', body); if (k) k.onchange = () => put({ keep: Number(k.value) });
    const d = $('[data-daily]', body); if (d) d.onchange = () => put({ daily: d.value === '' ? null : Number(d.value) });
    $$('[data-pdaily]', body).forEach(b => b.onclick = () => put({ project: { name: b.dataset.pdaily, daily: b.getAttribute('aria-checked') !== 'true' } }));
    $$('[data-pbackup]', body).forEach(b => b.onclick = async () => { b.disabled = true; b.textContent = 'Backing up…'; try { const r = await api(`/api/backups/${encodeURIComponent(b.dataset.pbackup)}`, { method: 'POST' }); toast(`Backed up ${fmtMB(r.size)} in ${(r.ms / 1000).toFixed(0)} s`); } catch (ex) { toast(ex.message, true); } loadBackups().catch(() => {}); });
    $$('[data-plist]', body).forEach(b => b.onclick = () => backupsDialog(b.dataset.plist, () => {}));
}
async function backupsDialog(project, back) {
    let list; try { list = await api(`/api/backups/${encodeURIComponent(project)}`); } catch (ex) { return toast(ex.message, true); }
    const { panel, close } = openDialog(`<h2>${icon('history')}Backups · ${esc(project)}</h2>
        ${list.length ? `<div class="list">${list.map((x, i) => `<div class="row"><span class="ico kelp">${icon('cloud-up')}</span><div class="main"><div class="title">${new Date(x.at).toLocaleString()}</div><div class="sub">${fmtMB(x.size)} · <span class="mono">${esc(x.name)}</span></div></div><button class="text-btn" data-restore="${i}">Restore</button></div>`).join('')}</div>` : '<p class="empty">No backups of this project yet.</p>'}
        <div class="buttons"><button data-bnow>${icon('cloud-up')}Back up now</button><button data-close>Close</button></div>`);
    $('[data-bnow]', panel).onclick = async b => { b.target.disabled = true; try { const r = await api(`/api/backups/${encodeURIComponent(project)}`, { method: 'POST' }); toast(`Backed up ${fmtMB(r.size)}`); close(); backupsDialog(project, back); } catch (ex) { toast(ex.message, true); b.target.disabled = false; } };
    $$('[data-restore]', panel).forEach(b => b.onclick = async () => {
        const x = list[Number(b.dataset.restore)];
        if (!(await confirmDialog({ title: `Restore ${project} from ${new Date(x.at).toLocaleString()}?`, text: 'The service stops, the backed-up folders replace what is there now (the current copy is kept in .porthole/restore-undo-…), then the service starts again.', action: 'Restore' }))) return backupsDialog(project, back);
        b.disabled = true; b.textContent = 'Restoring…';
        try { const r = await api(`/api/backups/${encodeURIComponent(project)}/restore`, { method: 'POST', body: { name: x.name } }); close(); toast(`Restored ${r.restored.join(', ')}${r.restarted.length ? ' and restarted' : ''}`); loadServices().catch(() => {}); back(); }
        catch (ex) { toast(ex.message, true); b.disabled = false; b.textContent = 'Restore'; }
    });
}

// ---------- alerts ----------
// Telegram messages for things that need you (root requests, sign-ins, public links, crashed servers) and, if you
// want them, the busier ones (new connections, Vault use, commits). The bot is a general Vault entry.
let afterVaultSave = null;
async function addTelegramBot() {
    const cat = await getCatalog().catch(ex => { toast(ex.message, true); return null; });
    const svc = cat?.services.find(s => s.key === 'telegram-bot');
    if (!svc) return toast('The Telegram service is missing from the catalogue.', true);
    afterVaultSave = async created => { try { await api('/api/alerts', { method: 'PUT', body: { itemId: created.id } }); } catch { /* pick it by hand */ } push('alerts'); };
    credentialForm(svc, cat, 'botChat');
}
function alertsSub(s) {
    if (!s.ready) return s.itemId ? 'Pick a chat to finish setting up' : 'Off · Telegram messages when something needs you';
    const n = Object.values(s.on).filter(Boolean).length;
    return s.pausedUntil ? `Paused until ${new Date(s.pausedUntil).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : `On · ${s.botName} · ${n} kind${n === 1 ? '' : 's'}`;
}
async function loadAlerts() {
    const s = await api('/api/alerts');
    const sub = $('#more-alerts-sub'); if (sub) sub.textContent = alertsSub(s);
    const body = $('#alerts-body');
    const chat = s.chatId || s.botChatId;
    let html = '<h2 class="section">Send to</h2>';
    if (!s.bots.length) {
        html += `<div class="card"><p style="margin:0 0 12px">Alerts go to you on Telegram through a bot you own. Add one to the Vault: a token from @BotFather, and your chat.</p><button class="primary" data-addbot>${icon('plus')}Add a Telegram bot</button></div>`;
    } else {
        html += `<div class="list">${s.bots.map(b => `<button class="row" data-bot="${esc(b.id)}"><span class="ico ${b.id === s.itemId ? 'kelp' : ''}">${icon(b.id === s.itemId ? 'check' : 'zap')}</span><div class="main"><div class="title">${esc(b.name)}</div><div class="sub">${b.incomplete ? 'No bot token yet: edit it in the Vault' : b.chatId ? `Its chat: ${esc(b.chatId)}` : 'No chat saved with it'}</div></div></button>`).join('')}
            <button class="row" data-addbot><span class="ico">${icon('plus')}</span><div class="main"><div class="title">Add another bot</div><div class="sub">Saved to the Vault as General</div></div></button></div>`;
        if (s.itemId) html += `<div class="list gap"><div class="row"><div class="main"><div class="title">Chat</div><div class="sub">${chat ? `${esc(chat)}${s.chatId ? ' (chosen here)' : ' (saved with the bot)'}` : 'None yet: send your bot a message on Telegram, then tap Find'}</div></div><button class="text-btn" data-findchat>Find</button><button class="text-btn" data-typechat>Type</button></div></div>
            <div class="list gap"><button class="row" data-test ${s.ready ? '' : 'disabled'}><span class="ico brass">${icon('send')}</span><div class="main"><div class="title">Send a test</div><div class="sub">${s.lastError ? `<span style="color:var(--flare)">Last send failed: ${esc(s.lastError.message)}</span>` : s.lastSent ? `Last sent ${new Date(s.lastSent).toLocaleString()}` : 'Check that messages arrive'}</div></div></button>
            <div class="row"><div class="main"><div class="title">${s.pausedUntil ? `Paused until ${new Date(s.pausedUntil).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Pause'}</div><div class="sub">Nothing is sent while paused; the audit log keeps everything</div></div>${s.pausedUntil ? '<button class="text-btn" data-pause="0">Resume</button>' : '<button class="text-btn" data-pause="60">1 h</button><button class="text-btn" data-pause="480">8 h</button>'}</div></div>`;
    }
    const lim = await api('/api/limit').catch(() => null);
    if (lim) html += `<h2 class="section">Limit reached</h2><div class="list">
        <div class="row"><div class="main"><div class="title">Overload guard</div><div class="sub" style="white-space:normal">When the load stays over ${lim.load} (now ${lim.loadNow} on ${lim.cpus} vCPU) for a minute: close every public quick link, then stop servers, runs and containers that are not live services, the heaviest and newest first, until it comes down. Live services and shells are never touched.${lim.last ? ` Last fired ${new Date(lim.last.at).toLocaleString()}: ${lim.last.stopped} stopped, ${lim.last.links} link${lim.last.links === 1 ? '' : 's'} closed.` : ''}</div></div><button class="switch ${lim.on ? 'on' : ''}" data-limit-on role="switch" aria-checked="${lim.on}" aria-label="Overload guard"><span></span></button></div>
        <div class="row"><div class="main"><div class="title">Load limit</div><div class="sub">Fires when the 1-minute load is over this</div></div><input type="number" min="2" max="500" step="1" value="${lim.load}" data-limit-load style="width:72px;text-align:right"></div>
        <button class="row" data-limit-preview><span class="ico brass">${icon('info')}</span><div class="main"><div class="title">What would it stop now?</div><div class="sub">A list, nothing is touched</div></div></button>
        <button class="row" data-limit-now><span class="ico flare">${icon('stop')}</span><div class="main"><div class="title">Do it now</div><div class="sub">Close public links and stop everything that is not a live service</div></div></button></div>`;
    html += `<h2 class="section">What to send</h2><div class="list">${s.kinds.map(k => `<div class="row"><div class="main"><div class="title">${esc(k.title)}</div><div class="sub" style="white-space:normal">${esc(k.sub)}</div></div><button class="switch ${s.on[k.key] ? 'on' : ''}" data-kind="${k.key}" role="switch" aria-checked="${!!s.on[k.key]}" aria-label="${esc(k.title)}"><span></span></button></div>`).join('')}</div>`;
    body.innerHTML = html;
    const put = async b => { try { await api('/api/alerts', { method: 'PUT', body: b }); } catch (ex) { toast(ex.message, true); } loadAlerts().catch(() => {}); };
    $$('[data-addbot]', body).forEach(b => b.onclick = () => addTelegramBot());
    const lo = $('[data-limit-on]', body); if (lo) lo.onclick = async () => { try { await api('/api/limit', { method: 'PUT', body: { on: lo.getAttribute('aria-checked') !== 'true' } }); } catch (ex) { toast(ex.message, true); } loadAlerts().catch(() => {}); };
    const ll = $('[data-limit-load]', body); if (ll) ll.onchange = async () => { try { await api('/api/limit', { method: 'PUT', body: { load: Number(ll.value) } }); toast('Load limit saved'); } catch (ex) { toast(ex.message, true); } };
    const showPlan = (r, done) => openDialog(`<h2>${icon(done ? 'stop' : 'info')}${done ? 'Limit reached: done' : 'What would stop now'}</h2><p class="muted">Load ${r.load}. ${r.links.length ? `${r.links.length} public link${r.links.length === 1 ? '' : 's'}${done ? ' closed' : ' would close'}.` : 'No public links open.'}</p>
        ${(done ? r.stopped : r.left).length ? `<div class="list">${(done ? r.stopped : r.left).map(x => `<div class="row"><div class="main"><div class="title">${esc(x.title)}<span class="tag dim">${esc(x.kind)}</span></div><div class="sub">${x.mem} MB · ${x.cpu}% · started ${x.created ? new Date(x.created).toLocaleString() : '?'}</div></div></div>`).join('')}</div>` : `<p class="empty">${done ? 'Nothing had to be stopped.' : 'Nothing to stop: only live services and shells are running.'}</p>`}
        ${done && r.left.length ? `<p class="sub">Left running (the load came down): ${r.left.map(x => esc(x.title)).join(', ')}</p>` : ''}
        <div class="buttons"><button data-close>Close</button></div>`);
    const lp = $('[data-limit-preview]', body); if (lp) lp.onclick = async () => { lp.disabled = true; try { showPlan(await api('/api/limit/run', { method: 'POST', body: { dry: true } }), false); } catch (ex) { toast(ex.message, true); } lp.disabled = false; };
    const ln = $('[data-limit-now]', body); if (ln) ln.onclick = async () => {
        if (!(await confirmDialog({ title: 'Close links and stop everything that is not a live service?', text: 'Public quick links close; registered servers, .platorun runs and containers stop (they can be started again). Live services and shells stay.', action: 'Do it now' }))) return;
        ln.disabled = true; try { showPlan(await api('/api/limit/run', { method: 'POST', body: {} }), true); loadServices().catch(() => {}); } catch (ex) { toast(ex.message, true); } ln.disabled = false; loadAlerts().catch(() => {});
    };
    $$('[data-bot]', body).forEach(b => b.onclick = () => put({ itemId: b.dataset.bot }));
    $$('[data-kind]', body).forEach(b => b.onclick = () => put({ on: { [b.dataset.kind]: !s.on[b.dataset.kind] } }));
    $$('[data-pause]', body).forEach(b => b.onclick = () => put({ pauseMinutes: Number(b.dataset.pause) }));
    const t = $('[data-test]', body); if (t) t.onclick = async () => { t.disabled = true; try { await api('/api/alerts/test', { method: 'POST' }); toast('Sent. Check Telegram'); } catch (ex) { toast(ex.message, true); } loadAlerts().catch(() => {}); };
    const tc = $('[data-typechat]', body); if (tc) tc.onclick = () => {
        const { panel, close } = openDialog(`<h2>${icon('zap')}Chat ID</h2><p class="muted">Your own chat with the bot is your user ID (a number). A group's ID starts with -. Leave empty to use the chat saved with the bot.</p>
            <div class="field"><input id="al-chat" type="text" inputmode="text" autocapitalize="off" autocorrect="off" value="${esc(s.chatId || '')}" placeholder="123456789"></div>
            <div class="buttons"><button data-close>Cancel</button><button class="primary" data-ok>Save</button></div>`);
        $('[data-ok]', panel).onclick = async () => { try { await api('/api/alerts', { method: 'PUT', body: { chatId: $('#al-chat', panel).value.trim() } }); close(); loadAlerts().catch(() => {}); } catch (ex) { toast(ex.message, true); } };
    };
    const fc = $('[data-findchat]', body); if (fc) fc.onclick = async () => {
        fc.disabled = true;
        let r; try { r = await api('/api/alerts/chats', { method: 'POST', body: { itemId: s.itemId } }); } catch (ex) { fc.disabled = false; return toast(ex.message, true); }
        fc.disabled = false;
        const { panel, close } = openDialog(`<h2>${icon('zap')}Pick a chat</h2>
            ${r.chats.length ? `<div class="list">${r.chats.map(c => `<button class="row" data-c="${esc(c.id)}"><div class="main"><div class="title">${esc(c.title)}</div><div class="sub mono">${esc(c.type)} · ${esc(c.id)}</div></div></button>`).join('')}</div>` : `<p class="muted">The bot has not seen any messages yet. Open Telegram, send ${r.bot ? esc(r.bot) : 'your bot'} a message (or add it to a group), then try again.</p>`}
            <div class="buttons"><button data-close>Close</button></div>`);
        $$('[data-c]', panel).forEach(b => b.onclick = async () => { close(); await put({ chatId: b.dataset.c }); });
    };
}

// ---------- audit log ----------
// Root use (requests, grants, services allowed to run as root), credential use (which Vault values went where) and
// activity (tunnels, servers, hostnames, git, commits), per project. From /api/audit; never values or output.
const auditState = { type: '', project: null };
const AUDIT_TITLES = {
    elevate: {
        request: e => `Root: ${String(e.cmd || '').split('\n')[0]}`, grant: e => `Root without asking, ${e.minutes} min`, 'grant-revoked': () => 'Root grant ended',
        'root-approved': e => `Allowed to run as root: ${e.what}`, 'root-revoked': e => `Root revoked: ${e.what}`, 'root-start': e => `Started as root: ${e.what}`,
    },
    credential: {
        'agent-read': e => `Agent read ${auditNames(e)}`, 'agent-run': e => `Agent ran a command with ${auditNames(e)}`,
        'root-read': e => `Root shell read ${auditNames(e)}`, 'root-run': e => `Root shell ran a command with ${auditNames(e)}`, 'shell-export': e => `Put into a new shell: ${auditNames(e)}`,
        'service-start': e => `Given to ${e.what}: ${auditNames(e)}`, portholerun: e => `Given to .platorun ${e.what}: ${auditNames(e)}`,
        'vault-revealed': e => `Revealed on the phone: ${e.what}`, 'service-revealed': e => `Revealed on the phone: ${e.what}`,
        shared: e => `Shared with you: ${e.what}`, 'shared-revealed': e => `Opened shared card: ${e.what}`,
    },
    network: { 'egress-new': e => `First connection to ${e.host || e.what}${e.port ? `:${e.port}` : ''}` },
    activity: {
        'tunnel-start': e => `Quick link opened · ${e.what}`, 'tunnel-stop': e => `Quick link closed · ${e.what}`,
        'hostname-add': e => `Hostname added · ${e.what}`, 'hostname-remove': e => `Hostname removed · ${e.what}`,
        'server-run': e => `Server started · ${e.what}`, 'server-register': e => `Server registered · ${e.what}`, 'server-start': e => `Server started · ${e.what}`,
        'server-stop': e => `Server stopped · ${e.what}`, 'server-restart': e => `Server restarted · ${e.what}`, 'server-remove': e => `Server removed · ${e.what}`,
        'service-start': e => `Service started · ${e.what}`, 'service-stop': e => `Service stopped · ${e.what}`, 'service-restart': e => `Service restarted · ${e.what}`,
        'service-hostname': e => `Service put on its hostname · ${e.what}`, 'service-action': e => `Ran ${e.what}`, portholerun: e => `.platorun · ${e.what}`,
        'git-commit': e => `Committed from the phone: ${e.what}`, 'git-push': () => 'Pushed', 'git-pull': () => 'Pulled', 'git-publish': () => 'Published to GitHub',
        'git-init': () => 'Started a git repo', 'git-clone': e => `Cloned ${e.what}`, commit: e => e.what, 'alerts-changed': e => e.what, 'image-pull': e => `Image checked · ${e.what}`, 'rename-finished': e => `Rename finished · ${e.what}`, autostop: e => `Auto-stop · ${e.what}`, 'autostop-skipped': e => `Auto-stop skipped · ${e.what}`, 'keepalive-set': e => e.what, 'keepalive-cleared': e => e.what, backup: e => `Backed up · ${e.what}`, 'hostname-moved': e => `Hostname moved here · ${e.what}`, 'backup-failed': e => `Backup failed · ${e.what}`, restore: e => `Restored · ${e.what}`, 'limit-reached': e => `Limit reached · ${e.what}`, 'limit-changed': e => e.what,
    },
};
const auditNames = e => { const n = e.names || []; return n.length ? n.slice(0, 3).join(', ') + (n.length > 3 ? ` +${n.length - 3}` : '') : 'nothing'; };
const auditTitle = e => (AUDIT_TITLES[e.type]?.[e.action] || (() => `${e.action}${e.what ? ` · ${e.what}` : ''}`))(e);
function auditIcon(e) {
    if (e.type === 'elevate') return ['shield', 'flare'];
    if (e.type === 'credential') return ['key', 'brass'];
    if (e.type === 'network') return ['egress', 'dock'];
    if (e.action === 'alerts-changed') return ['bell', 'brass'];
    if (e.action.startsWith('limit-')) return ['stop', 'flare'];
    if (/^(autostop|keepalive)/.test(e.action)) return ['anchor', e.action === 'autostop' ? 'flare' : 'kelp'];
    if (/^(backup|restore)/.test(e.action)) return ['cloud-up', e.action === 'backup-failed' ? 'flare' : 'kelp'];
    if (e.action === 'commit' || e.action.startsWith('git-')) return ['commit', e.agent ? 'brass' : 'dim'];
    if (/tunnel|hostname/.test(e.action)) return ['link', 'kelp'];
    return [/service|portholerun/.test(e.action) ? 'globe' : 'server', 'dock'];
}
function auditStatus(e) {
    if (e.type === 'elevate' && e.action === 'request') {
        if (e.status === 'done') return e.code ? `<span class="tag" style="color:var(--flare)">exit ${e.code}</span>` : '<span class="tag">ran</span>';
        if (e.status === 'denied') return '<span class="tag dim">denied</span>';
        if (e.status === 'expired') return '<span class="tag dim">expired</span>';
        if (e.status === 'running') return '<span class="tag">running</span>';
        return '<span class="tag" style="color:var(--brass)">waiting</span>';
    }
    if (e.action === 'commit') return e.agent ? `<span class="tag">${esc(e.agent)}</span>` : '';
    if (e.action === 'service-action' && e.code) return `<span class="tag" style="color:var(--flare)">exit ${e.code}</span>`;
    return '';
}
const auditWho = e => e.action === 'commit' ? `${e.author}${e.hash ? ` · ${e.hash.slice(0, 7)}` : ''}` : (e.actor || 'PlatOpypus');
async function loadAudit() {
    const q = new URLSearchParams();
    if (auditState.type) q.set('type', auditState.type);
    if (auditState.project !== null) q.set('project', auditState.project);
    const r = await api(`/api/audit?${q}`);
    // Commits join the list (Everything and Activity) by time.
    let events = r.events;
    if (r.commits?.length) events = [...events, ...r.commits].sort((a, b) => b.at - a.at).slice(0, 400);
    // Project chips: everything with any entry, plus projects with commits.
    const proj = new Map(r.projects.map(x => [x.project || '', { ...x, commits: 0, agentCommits: 0 }]));
    const allCommits = auditState.project === null ? (r.commits || []) : [];
    for (const c of allCommits) { const x = proj.get(c.project) || { project: c.project, elevate: 0, rootRuns: 0, credential: 0, activity: 0, names: [], last: 0, commits: 0, agentCommits: 0 }; x.commits++; if (c.agent) x.agentCommits++; x.last = Math.max(x.last, c.at); proj.set(c.project, x); }
    if (auditState.project === null) auditState.chips = [...proj.values()].sort((a, b) => b.last - a.last);
    const chips = auditState.chips || [];
    $('#audit-projects').innerHTML = `<button class="chip ${auditState.project === null ? 'on' : ''}" data-ap="*">All projects</button>` + chips.map(x => `<button class="chip ${auditState.project === (x.project || '') ? 'on' : ''}" data-ap="${esc(x.project || '')}">${esc(x.project || 'Box')}<span class="n">${x.elevate + x.credential + x.activity + (x.network || 0) + (x.commits || 0)}</span></button>`).join('');
    $$('#audit-projects [data-ap]').forEach(b => b.onclick = () => { auditState.project = b.dataset.ap === '*' ? null : b.dataset.ap; loadAudit().catch(e => toast(e.message, true)); });
    // Summary for one project: how much root, which Vault values, what agents did.
    const one = auditState.project !== null ? (chips.find(x => (x.project || '') === auditState.project) || null) : null;
    $('#audit-summary').innerHTML = one ? `<div class="card audit-sum">
        <div class="audit-stats"><div><b>${one.elevate}</b><span>root entr${one.elevate === 1 ? 'y' : 'ies'}${one.rootRuns ? `, ${one.rootRuns} ran` : ''}</span></div><div><b>${one.credential}</b><span>credential use${one.credential === 1 ? '' : 's'}</span></div><div><b>${one.activity}</b><span>activity</span></div><div><b>${one.commits || 0}</b><span>commit${one.commits === 1 ? '' : 's'}${one.agentCommits ? `, ${one.agentCommits} by agents` : ''}</span></div></div>
        ${one.names?.length ? `<p class="sub" style="margin-top:10px">Vault values used: ${one.names.map(n => `<span class="mono">${esc(n)}</span>`).join(', ')}</p>` : ''}</div>` : '';
    if (auditState.type === 'network') return loadEgress();
    if (!events.length) { $('#audit-list').innerHTML = `<p class="empty">Nothing recorded${auditState.type ? ' of this kind' : ''}${auditState.project !== null ? ` for ${esc(auditState.project || 'the box')}` : ''} yet.</p>`; return; }
    // Grouped by day, newest first.
    const day = ts => new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    let html = '', cur = '';
    events.forEach((e, n) => {
        const d = day(e.at);
        if (d !== cur) { if (cur) html += '</div>'; cur = d; html += `<h2 class="section">${esc(d)}</h2><div class="list">`; }
        const [ic, tone] = auditIcon(e);
        html += `<button class="row" data-ae="${n}"><span class="ico ${tone}">${icon(ic)}</span><div class="main"><div class="title audit-t">${esc(auditTitle(e))}${auditStatus(e)}${e.count > 1 ? `<span class="tag dim">×${e.count}</span>` : ''}</div><div class="sub">${esc(auditWho(e))}${e.project && auditState.project === null ? ` · ${esc(e.project)}` : ''} · ${new Date(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</div></div>${icon('chevron', 'i chev')}</button>`;
    });
    $('#audit-list').innerHTML = html + '</div>';
    $$('#audit-list [data-ae]').forEach(b => b.onclick = () => auditDetail(events[Number(b.dataset.ae)]));
}
// Network: where the agent user and the service accounts connect, one row per host and port, last 7 days.
async function loadEgress() {
    const q = new URLSearchParams({ days: '7' });
    if (auditState.project !== null) q.set('project', auditState.project);
    const r = await api(`/api/egress?${q}`);
    const ago = ts => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
    let html = `<div class="card" style="margin-bottom:12px"><div style="display:flex;gap:8px;align-items:center;font-weight:600"><span class="dot ${r.status.on ? 'live' : ''}"></span>${r.status.on ? 'Recording' : 'Not recording'}</div><p class="sub" style="margin:6px 0 0;white-space:normal">${esc(r.status.detail)}</p></div>`;
    if (!r.rows.length) html += `<p class="empty">No connections recorded in the last ${r.days} days${auditState.project !== null ? ` for ${esc(auditState.project || 'the box')}` : ''}.</p>`;
    else {
        const fresh = Date.now() - 86400_000;
        html += `<h2 class="section">Last ${r.days} days · ${r.total} destination${r.total === 1 ? '' : 's'}</h2><div class="list">${r.rows.map((x, n) => `<button class="row" data-eg="${n}"><span class="ico dock">${icon('egress')}</span><div class="main"><div class="title audit-t">${esc(x.host)}${x.port ? `<span class="muted">:${x.port}</span>` : ''}${x.first > fresh ? '<span class="tag" style="color:var(--brass)">new</span>' : ''}<span class="tag dim">×${x.count}</span></div><div class="sub">${esc(x.who)}${x.project && auditState.project === null ? ` · ${esc(x.project)}` : ''}${x.procs?.length ? ` · ${esc(x.procs.join(', '))}` : ''} · ${ago(x.last)}</div></div>${icon('chevron', 'i chev')}</button>`).join('')}</div>`;
    }
    $('#audit-list').innerHTML = html;
    $$('#audit-list [data-eg]').forEach(b => b.onclick = () => {
        const x = r.rows[Number(b.dataset.eg)];
        const rows = [['Host', x.host], ['Address', x.ip !== x.host ? x.ip : null], ['Port', x.port ? `${x.port} (${x.proto})` : x.proto], ['Who', x.who], ['Account', x.user], ['Project', x.project || 'the box (not in a project)'], ['Programs', x.procs?.join(', ')], ['Connections', `${x.count} on ${x.days} day${x.days === 1 ? '' : 's'}`], ['First', new Date(x.first).toLocaleString()], ['Last', new Date(x.last).toLocaleString()]].filter(([, v]) => v);
        openDialog(`<h2>${icon('egress')}${esc(x.host)}</h2><div class="list">${rows.map(([k, v]) => `<div class="row"><div class="main"><div class="sub">${esc(k)}</div><div class="title" style="font-size:14.5px;white-space:normal">${esc(String(v))}</div></div></div>`).join('')}</div><div class="buttons"><button data-close>Close</button></div>`);
    });
}
function auditDetail(e) {
    const rows = [
        ['When', new Date(e.at).toLocaleString()], ['Who', auditWho(e)], ['Through', e.via], ['Project', e.project || (e.type === 'activity' && e.action === 'commit' ? null : 'the box (not in a project)')],
        ['Folder', e.cwd], ['Host', e.host ? `${e.host}${e.port ? `:${e.port}` : ''}` : null], ['Repeated', e.count > 1 ? `${e.count} times, last at ${new Date(e.lastAt).toLocaleTimeString()}` : null], ['Reason', e.reason], ['Decided by', e.decidedBy], ['Exit code', e.code ?? null], ['Minutes', e.minutes], ['Agent', e.agent],
    ].filter(([, v]) => v !== undefined && v !== null && v !== '');
    openDialog(`<h2>${icon(auditIcon(e)[0])}${esc(auditTitle(e))}</h2>
        <div class="list">${rows.map(([k, v]) => `<div class="row"><div class="main"><div class="sub">${esc(k)}</div><div class="title" style="font-size:14.5px;white-space:normal">${esc(String(v))}</div></div></div>`).join('')}</div>
        ${e.cmd ? `<h3 class="section">Command</h3><pre style="max-height:30vh;white-space:pre-wrap">${esc(e.cmd)}</pre>` : ''}
        ${e.names?.length ? `<h3 class="section">Vault values</h3><div class="chips" style="flex-wrap:wrap">${e.names.map(n => `<span class="chip">${esc(n)}</span>`).join('')}</div>` : ''}
        ${e.events?.length ? `<h3 class="section">Timeline</h3><div class="list">${e.events.map(x => `<div class="row"><div class="main"><div class="title" style="font-size:14px">${esc(x.action)}${x.code !== undefined && x.code !== null ? ` · exit ${x.code}` : ''}${x.decidedBy ? ` · ${esc(x.decidedBy)}` : ''}</div><div class="sub">${new Date(x.at).toLocaleTimeString()}</div></div></div>`).join('')}</div>` : ''}
        <div class="buttons">${e.project ? `<button data-af>${icon('history')}Everything for ${esc(e.project)}</button>` : ''}<button data-close>Close</button></div>`);
    const f = $('#dialog [data-af]'); if (f) f.onclick = () => { $('#dialog .dialog-backdrop').click(); auditState.project = e.project; loadAudit().catch(x => toast(x.message, true)); };
}
$$('#audit-seg button').forEach(b => b.addEventListener('click', () => { auditState.type = b.dataset.at; $$('#audit-seg button').forEach(x => x.classList.toggle('on', x === b)); loadAudit().catch(e => toast(e.message, true)); }));
$('#audit-refresh').addEventListener('click', () => loadAudit().catch(e => toast(e.message, true)));

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

// The offline page: kept on this device by a small service worker, shown when the box does not answer.
if ('serviceWorker' in navigator) window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* not allowed here */ }); });
