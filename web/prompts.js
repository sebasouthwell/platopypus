// More → AI prompts: the master prompts agents get, your own versions, and what an update changed (side by side).
// Loaded on demand by app.js (setup(ctx) hands over its helpers).
let C = null;
export function setup(ctx) { C = ctx; }

// ---------- diff: lines (LCS), then words inside changed lines ----------
function lcs(a, b) {
    const n = a.length, m = b.length; const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = []; let i = 0, j = 0;
    while (i < n && j < m) { if (a[i] === b[j]) { ops.push(['=', a[i], b[j]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i], null]); i++; } else { ops.push(['+', null, b[j]]); j++; } }
    while (i < n) ops.push(['-', a[i++], null]); while (j < m) ops.push(['+', null, b[j++]]);
    return ops;
}
// Pair removed and added runs into "changed" rows so they sit side by side.
export function diffRows(oldText, newText) {
    const ops = lcs(String(oldText).split('\n'), String(newText).split('\n')); const rows = [];
    for (let k = 0; k < ops.length;) {
        if (ops[k][0] === '=') { rows.push({ t: '=', l: ops[k][1], r: ops[k][2] }); k++; continue; }
        const del = [], add = []; while (k < ops.length && ops[k][0] !== '=') { if (ops[k][0] === '-') del.push(ops[k][1]); else add.push(ops[k][2]); k++; }
        for (let x = 0; x < Math.max(del.length, add.length); x++) rows.push({ t: del[x] !== undefined && add[x] !== undefined ? '~' : del[x] !== undefined ? '-' : '+', l: del[x] ?? null, r: add[x] ?? null });
    }
    return rows;
}
function wordMarks(a, b) {
    const { esc } = C; const A = a.split(/(\s+)/), B = b.split(/(\s+)/); if (A.length * B.length > 40000) return [esc(a), esc(b)];
    const ops = lcs(A, B); let l = '', r = '';
    for (const [t, x, y] of ops) { if (t === '=') { l += esc(x); r += esc(y); } else if (t === '-') l += `<del>${esc(x)}</del>`; else r += `<ins>${esc(y)}</ins>`; }
    return [l, r];
}
// Side by side (unified on a narrow screen); unchanged runs fold away.
export function renderDiff(oldText, newText, { left = 'Before', right = 'After' } = {}) {
    const { esc } = C; const rows = diffRows(oldText, newText); const changes = rows.filter(r => r.t !== '=').length;
    if (!changes) return `<p class="note">No differences.</p>`;
    let html = `<div class="df-head"><span>${esc(left)}</span><span>${esc(right)}</span></div><div class="df">`; let ln = 0, rn = 0;
    for (let i = 0; i < rows.length;) {
        if (rows[i].t === '=') {   // a run of unchanged lines: show 2 either side of a change, fold the rest
            let j = i; while (j < rows.length && rows[j].t === '=') j++;
            const run = rows.slice(i, j); const keepHead = i === 0 ? 0 : 2, keepTail = j === rows.length ? 0 : 2;
            const show = r => { ln++; rn++; return `<div class="df-row eq"><span class="df-n">${ln}</span><span class="df-c">${esc(r.l)}</span><span class="df-n">${rn}</span><span class="df-c">${esc(r.r)}</span></div>`; };
            if (run.length > keepHead + keepTail + 3) {
                html += run.slice(0, keepHead).map(show).join('');
                const hidden = run.slice(keepHead, run.length - keepTail);
                html += `<details class="df-fold"><summary>${hidden.length} unchanged lines</summary>${hidden.map(show).join('')}</details>`;
                html += run.slice(run.length - keepTail).map(show).join('');
            } else html += run.map(show).join('');
            i = j; continue;
        }
        const r = rows[i]; let L = r.l !== null ? esc(r.l) : '', R = r.r !== null ? esc(r.r) : '';
        if (r.t === '~') [L, R] = wordMarks(r.l, r.r);
        html += `<div class="df-row ${r.t === '~' ? 'ch' : r.t === '-' ? 'del' : 'add'}"><span class="df-n">${r.l !== null ? ++ln : ''}</span><span class="df-c ${r.l !== null ? 'old' : 'none'}">${L}</span><span class="df-n">${r.r !== null ? ++rn : ''}</span><span class="df-c ${r.r !== null ? 'new' : 'none'}">${R}</span></div>`;
        i++;
    }
    return `${html}</div><p class="note">${changes} changed line${changes === 1 ? '' : 's'}.</p>`;
}

// ---------- the page ----------
const STATE = { default: ['Default', ''], custom: ['Yours', 'kelp'], outdated: ['Yours · based on an old default', 'flare'] };
export async function loadPrompts() {
    const { esc, icon, $, $$ } = C; const d = await C.api('/api/prompts'); const body = $('#prompts-body');
    const sub = $('#more-prompts-sub'); if (sub) sub.textContent = d.review ? `${d.review} need${d.review === 1 ? 's' : ''} your review after an update` : `${d.prompts.filter(p => p.state !== 'default').length} of yours · the instructions agents get`;
    const apps = [...new Set(d.prompts.map(p => p.app))];
    body.innerHTML = `<p class="note">The instructions PlatOpypus gives agents. Edit any of them: your version is used instead of the default. When an update changes a default you edited, it is marked here so you can compare and choose.</p>
        ${d.review ? `<div class="card pr-review">${icon('info')} ${d.review} of your versions ${d.review === 1 ? 'is' : 'are'} based on an older default. Open ${d.review === 1 ? 'it' : 'them'} to see what the update changed.</div>` : ''}
        ${apps.map(a => `<h2 class="section">${esc(a)}</h2><div class="list">${d.prompts.filter(p => p.app === a).map(p => `<button class="row" data-pr="${esc(p.id)}"><div class="main"><div class="title">${esc(p.title)}</div><div class="sub" style="white-space:normal">${esc(p.used)}</div></div>${p.state !== 'default' ? `<span class="pill sm ${STATE[p.state][1] === 'flare' ? 'danger' : 'kelp'} pr-state">${esc(STATE[p.state][0])}</span>` : ''}${icon('chevron', 'i chev')}</button>`).join('')}</div>`).join('')}`;
    $$('[data-pr]', body).forEach(b => b.onclick = () => openPrompt(b.dataset.pr));
}
async function openPrompt(id, tab) {
    const { esc, icon, $, $$ } = C; const p = await C.api(`/api/prompts/${id}`);
    const outdated = p.state === 'outdated'; tab = tab || (outdated ? 'update' : p.customText ? 'compare' : 'view');
    const tabs = [['view', p.customText ? 'Yours' : 'Prompt'], ...(p.customText ? [['compare', 'Yours vs default']] : []), ...(outdated ? [['update', 'What the update changed']] : []), ['edit', p.customText ? 'Edit yours' : 'Make your own'], ...(p.deprecatedVersions.length ? [['old', `Deprecated (${p.deprecatedVersions.length})`]] : [])];
    const { panel, close } = C.openDialog(`<h2>${icon('file-text')}${esc(p.title)}</h2>
        <p class="note">${esc(p.used)}</p>
        ${outdated ? `<div class="pr-warn">An update changed the default since you made your version. Yours is still in use. Compare, then switch to the new default, migrate your changes onto it, or keep yours.</div>` : ''}
        <div class="pr-tabs" role="tablist">${tabs.map(([k, l]) => `<button data-pt="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div data-pbody></div>`, { size: 'wide' });
    panel.closest('.dialog-panel')?.classList.add('wide');
    $$('[data-pt]', panel).forEach(b => b.onclick = () => { close(); openPrompt(id, b.dataset.pt); });
    const body = $('[data-pbody]', panel);
    const act = async (path, msg) => { try { await C.api(`/api/prompts/${id}${path}`, { method: 'POST', body: {} }); C.toast(msg); close(); loadPrompts().catch(() => {}); } catch (ex) { C.toast(ex.message, true); } };
    if (tab === 'view') body.innerHTML = `<pre class="pr-text">${esc(p.customText || p.defaultText)}</pre>${p.customText ? `<div class="buttons"><button class="danger" data-reset>${icon('refresh')}Use the default instead</button></div>` : ''}`;
    if (tab === 'compare') body.innerHTML = `${renderDiff(p.defaultText, p.customText, { left: 'Default', right: 'Yours' })}<div class="buttons"><button class="danger" data-reset>${icon('refresh')}Use the default instead</button></div>`;
    if (tab === 'update') body.innerHTML = `<h3 class="pr-h">The default: old → new</h3>${renderDiff(p.baseText || '', p.defaultText, { left: 'Old default (yours is based on it)', right: 'New default' })}
        <h3 class="pr-h">Yours compared with the new default</h3>${renderDiff(p.defaultText, p.customText, { left: 'New default', right: 'Yours' })}
        <div class="buttons"><button data-keep>${icon('check')}Keep mine as it is</button><button data-migrate>${icon('edit')}Migrate: edit from the new default</button><button class="primary" data-reset>${icon('refresh')}Switch to the new default</button></div>
        <p class="note">Switching keeps your version as deprecated, so you can bring it back.</p>`;
    if (tab === 'edit' || tab === 'migrate') {
        const start = tab === 'migrate' ? p.defaultText : (p.customText || p.defaultText);
        body.innerHTML = `${tab === 'migrate' ? `<p class="note">Starting from the new default. Your old version is on the right below: copy across what you want to keep.</p>` : ''}<textarea class="pr-edit mono" rows="18" spellcheck="false">${esc(start)}</textarea>
            ${tab === 'migrate' ? `<details class="app-what" open><summary>Your old version, compared with the new default</summary>${renderDiff(p.defaultText, p.customText, { left: 'New default', right: 'Your old version' })}</details>` : ''}
            <div class="buttons"><button data-close>Cancel</button><button data-preview>${icon('eye')}Compare with the default</button><button class="primary" data-save>${icon('save')}Save as mine</button></div><div data-pv></div>`;
        const ta = $('.pr-edit', body);
        $('[data-preview]', body).onclick = () => { $('[data-pv]', body).innerHTML = renderDiff(p.defaultText, ta.value, { left: 'Default', right: 'Your edit' }); };
        $('[data-save]', body).onclick = async () => { try { await C.api(`/api/prompts/${id}`, { method: 'PUT', body: { text: ta.value } }); C.toast('Saved: agents get your version from now on'); close(); loadPrompts().catch(() => {}); } catch (ex) { C.toast(ex.message, true); } };
        $$('[data-close]', body).forEach(b => b.onclick = close);
    }
    if (tab === 'old') {
        body.innerHTML = p.deprecatedVersions.map((v, i) => `<div class="card pr-old"><div class="pr-old-h"><b>Retired ${new Date(v.retiredAt).toLocaleString()}</b><button class="btn" data-restore="${i}">${icon('refresh')}Use this again</button></div><details><summary>Compare with the current default</summary>${renderDiff(p.defaultText, v.text, { left: 'Current default', right: 'This old version' })}</details></div>`).join('');
        $$('[data-restore]', body).forEach(b => b.onclick = async () => { try { await C.api(`/api/prompts/${id}/restore`, { method: 'POST', body: { i: Number(b.dataset.restore) } }); C.toast('Restored as your version'); close(); loadPrompts().catch(() => {}); } catch (ex) { C.toast(ex.message, true); } });
    }
    const rs = $('[data-reset]', body); if (rs) rs.onclick = () => act('/reset', 'Using the default now (yours kept as deprecated)');
    const kp = $('[data-keep]', body); if (kp) kp.onclick = () => act('/keep', 'Keeping your version');
    const mg = $('[data-migrate]', body); if (mg) mg.onclick = () => { close(); openPrompt(id, 'migrate'); };
}
