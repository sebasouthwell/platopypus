// More → Self-check: what is live and what it is built from, known problems in it, agents that fix the targets you
// tick, and a log of every fix ("Self-remediation complete"). Server side: server/lib/selfcheck.js.
let C = null;
const S = { sel: new Set(), open: new Set(), poll: null, seeded: false };
export function setup(ctx) { C = ctx; }
const SEV = ['critical', 'high', 'moderate', 'low', 'info'];
const SEV_TXT = { critical: 'Critical', high: 'High', moderate: 'Moderate', low: 'Low', info: 'Info' };
const when = t => t ? new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const ACTIVE = ['queued', 'running', 'applying', 'approval'];
const STATUS = { approval: 'Waiting for your approval', discarded: 'Discarded', queued: 'Waiting', running: 'Agent working', applying: 'Applying', done: 'Fixed', failed: 'Failed', 'rolled-back': 'Rolled back', blocked: 'Not applied (drift limit)', skipped: 'Skipped' };

export async function load() {
    const { $, esc, icon } = C; const body = $('#sc-body'); if (!body) return;
    let d; try { d = await C.api('/api/selfcheck'); } catch (e) { body.innerHTML = `<p class="note">${esc(e.message)}</p>`; return; }
    const sc = d.scan; const s = d.settings; const ts = sc?.targets || [];
    if (!S.seeded && ts.length) { for (const id of s.autoTargets) S.sel.add(id); S.seeded = true; }
    const sub = $('#more-selfcheck-sub'); const tot = k => ts.reduce((n, t) => n + (t.counts?.[k] || 0), 0);
    if (sub) sub.textContent = sc ? (tot('critical') + tot('high') ? `${tot('critical') + tot('high')} critical or high · checked ${when(sc.at)}` : `Nothing serious · checked ${when(sc.at)}`) : 'Find and fix vulnerable services and tools';
    const active = d.runs.filter(r => ACTIVE.includes(r.status)); const done = d.runs.filter(r => !ACTIVE.includes(r.status));
    let html = `<div class="card sc-head"><div class="sc-sum">${sc ? SEV.slice(0, 4).map(k => `<span class="sc-pill ${k}"><b>${tot(k)}</b>${SEV_TXT[k].toLowerCase()}</span>`).join('') : '<span class="muted">Not scanned yet.</span>'}</div>
        <div class="sc-meta muted">${d.status.running ? `${icon('refresh')}${esc(d.status.step || 'Scanning')}…` : sc ? `Last scan ${when(sc.at)} (${Math.round(sc.took / 1000)} s, ${sc.trigger})` : ''}${s.enabled && d.next ? ` · next ${when(d.next)}` : ' · schedule off'}</div>
        <div class="r-actions"><button class="btn pri" data-scan ${d.status.running ? 'disabled' : ''}>${icon('search')}${d.status.running ? 'Scanning…' : 'Scan now'}</button><button class="btn" data-settings>${icon('settings')}Settings</button></div>
        ${sc?.errors?.length ? `<p class="sc-err">${sc.errors.map(esc).join('<br>')}</p>` : ''}</div>`;
    if (active.length) html += `<h2 class="section">Fixing now</h2><div class="sc-runs">${active.map(r => runCard(r, true)).join('')}</div>`;
    if (ts.length) {
        html += `<h2 class="section">What is live, and what is wrong with it</h2><p class="note">Tick what you want fixed. Each one gets its own agent, one after another. Projects are fixed on a new branch and their running services restarted on it; you merge when you are happy. PlatOpypus itself is fixed in place with a snapshot and automatic rollback.</p><div class="sc-targets">`;
        html += ts.map(t => targetCard(t, d)).join('');
        html += `</div>${S.sel.size ? `<div class="sc-fixbar"><span>${S.sel.size} selected</span><button class="btn pri" data-fix>${icon('claude')}Fix selected</button></div>` : ''}`;
    }
    html += `<h2 class="section">Self-remediation complete</h2>${done.length ? `<div class="sc-runs">${done.map(r => runCard(r, false)).join('')}</div>` : '<p class="note">No fixes yet. Finished runs land here with their log, what changed and a way back.</p>'}`;
    const dr = d.drift.filter(x => x.state === 'applied');
    if (dr.length) html += `<h2 class="section">Local fixes on PlatOpypus</h2><p class="note">These change PlatOpypus's code on this box only. The next update replaces them; send the patch from each run to the developers so the release includes it.</p>${dr.map(x => `<div class="row"><div class="main"><div class="title">${esc(x.files.join(', '))}</div><div class="sub muted">On ${esc(x.version)} · ${when(x.at)}</div></div><button class="text-btn" data-dev="${x.run}">Patch</button></div>`).join('')}`;
    body.innerHTML = html; wire(body, d);
    clearTimeout(S.poll); if (d.status.running || active.length) S.poll = setTimeout(() => { if (!$('#page-selfcheck')?.hidden) load(); }, 4000);
}
function targetCard(t, d) {
    const { esc, icon } = C; const n = t.findings.length; const top = SEV.find(k => t.counts?.[k]);
    const busy = d.runs.some(r => r.target === t.id && ACTIVE.includes(r.status));
    const fixable = t.findings.some(x => !x.waiting && x.area !== 'container' && !(x.area === 'os' && x.name === 'reboot'));
    const svc = (t.running || []).map(s => `<span class="sc-svc ${s.running ? 'on' : ''}">${s.running ? '●' : '○'} ${esc(s.title || s.slug)}</span>`).join('');
    const warn = t.kind === 'plato' ? '<p class="sc-warn">Fixed in place on this box: dependency upgrades and small patches only. Every code change is logged as a patch for the PlatOpypus developers; the next update replaces it.</p>' : t.kind === 'box' ? '<p class="sc-warn">The agent gets root through elevate for its run only (every command is in the audit log). It never starts a stopped service or reboots.</p>' : t.git === false ? '<p class="sc-warn">Not a git repository, so it is skipped: fixes need a branch to land on and a way back.</p>' : '';
    const open = S.open.has(t.id);
    return `<div class="sc-target ${top || 'clean'}"><div class="sc-th">
        <label class="sc-tick"><input type="checkbox" data-sel="${esc(t.id)}" ${S.sel.has(t.id) ? 'checked' : ''} ${!fixable || busy ? 'disabled' : ''} aria-label="Fix ${esc(t.name)}"></label>
        <button class="sc-tmain" data-open="${esc(t.id)}" aria-expanded="${open}"><div class="title">${esc(t.name)}${t.version ? ` <span class="muted">${esc(t.version)}</span>` : ''}${busy ? ' <span class="sc-busy">fixing</span>' : ''}</div>
        <div class="sub">${svc}${t.kind === 'project' ? `<span class="muted">${t.packages || 0} packages${t.lockfiles?.length ? ` · ${esc(t.lockfiles.slice(0, 3).join(', '))}` : ''}</span>` : t.kind === 'plato' ? `<span class="muted">${t.packages || 0} installed packages</span>` : ''}</div></button>
        <div class="sc-counts">${n ? SEV.filter(k => t.counts[k]).map(k => `<span class="sc-pill ${k} sm"><b>${t.counts[k]}</b></span>`).join('') : `<span class="sc-ok">${icon('check')}</span>`}</div></div>
        ${open ? `${warn}${t.kind === 'box' ? boxInventory(t) : ''}${t.kind === 'box' && t.tools?.length ? `<div class="sc-tools">${t.tools.map(x => `<span><b>${esc(x.name)}</b> ${esc(x.version)}${x.latest && x.latest !== x.version ? ` <i>→ ${esc(x.latest)}</i>` : ''}</span>`).join('')}</div>` : ''}${n ? `<div class="sc-finds">${t.findings.map(findRow).join('')}</div>` : '<p class="note">Nothing known to be wrong.</p>'}` : ''}</div>`;
}
function findRow(x) {
    const { esc } = C;
    return `<div class="sc-find ${x.waiting ? 'waiting' : ''}"><span class="sc-pill ${x.severity} sm">${SEV_TXT[x.severity]}</span><div class="main"><div class="t">${esc(x.name)}${x.version ? ` <span class="mono">${esc(x.version)}</span>` : ''}${x.fixed ? ` → <span class="mono ok">${esc(x.fixed)}</span>` : ''}${x.malicious ? ' <b class="sc-mal">malicious</b>' : ''}${x.kev ? ' <b class="sc-mal">exploited now</b>' : ''}${x.core ? ' <span class="sc-core">PlatOpypus runs on it</span>' : ''}${x.dev ? ' <span class="muted">dev only</span>' : ''}${x.new ? ' <span class="sc-new">new</span>' : ''}${x.waiting ? ` <span class="sc-wait">waiting on ${esc(x.waiting.on)} upstream</span>` : ''}</div>
        ${x.note ? `<div class="n">${esc(x.note)}</div>` : ''}${(x.advisories || []).length ? `<div class="a">${x.advisories.slice(0, 4).map(a => `<a href="https://osv.dev/vulnerability/${encodeURIComponent(a.id)}" target="_blank" rel="noopener noreferrer" title="${esc(a.summary)}">${esc(a.aliases?.[0] || a.id)}</a>`).join(' ')}${x.advisories.length > 4 ? ` +${x.advisories.length - 4}` : ''}</div>` : ''}</div></div>`;
}
function runCard(r, live) {
    const { esc, icon } = C; const ok = r.status === 'done';
    const tail = (r.log || []).slice(-4).map(l => `<div class="${l.by === 'agent' ? 'ag' : ''}">${esc(l.line)}</div>`).join('');
    return `<div class="sc-run ${esc(r.status)}"><div class="h"><b>${esc(r.name)}</b><span class="st">${esc(r.status === 'done' && r.report?.status === 'fixed' && r.waiting?.length ? `Fixed · ${r.waiting.length} waiting upstream` : r.status === 'done' && r.report?.status === 'partial' ? 'Partly fixed' : r.status === 'done' && r.report?.status === 'nothing-to-do' ? 'Nothing to do' : STATUS[r.status] || r.status)}</span></div>
        <div class="sub muted">${esc(when(r.finished || r.started || r.created))} · ${esc(r.trigger)}${r.branch ? ` · branch <span class="mono">${esc(r.branch)}</span>${r.merged ? ' (merged)' : ''}` : ''}${r.files?.length ? ` · ${r.files.length} file${r.files.length === 1 ? '' : 's'}` : ''}${r.upgraded?.length ? ` · ${r.upgraded.length} packages upgraded` : ''}</div>
        ${r.report?.summary ? `<p class="sum">${esc(r.report.summary)}</p>` : ''}${r.blocked ? `<p class="sc-warn">${esc(r.blocked)}</p>` : ''}
        ${live ? `<div class="sc-tail">${tail}</div>` : ''}
        <div class="r-actions">${r.status === 'approval' ? `<button class="btn pri" data-apply="${r.id}">${icon('check')}Apply</button><button class="btn" data-diff="${r.id}">${icon('file-code')}What changed</button><button class="btn" data-discard="${r.id}">${icon('x')}Discard</button>` : ''}${live && r.shell && r.status !== 'approval' ? `<button class="btn" data-watch="${esc(r.shell)}">${icon('eye')}Watch</button>` : ''}<button class="btn" data-log="${r.id}">${icon('file-text')}Log</button>${!live && r.hasDiff ? `<button class="btn" data-diff="${r.id}">${icon('file-code')}What changed</button>` : ''}${!live && r.kind === 'plato' && r.hasDiff ? `<button class="btn" data-dev="${r.id}">${icon('file-text')}For developers</button>` : ''}${!live && r.kind === 'project' && r.branch && !r.merged && ok ? `<button class="btn pri" data-merge="${r.id}">${icon('check')}Merge</button>` : ''}${!live && ok && (r.kind !== 'project' || r.commits?.length) ? `<button class="btn" data-rollback="${r.id}">${icon('refresh')}Roll back</button>` : ''}</div></div>`;
}
function wire(body, d) {
    const { $, $$, esc, icon } = C;
    $('[data-scan]', body)?.addEventListener('click', async () => { try { await C.api('/api/selfcheck/scan', { method: 'POST' }); C.toast('Scanning: this takes a minute or two'); } catch (e) { C.toast(e.message, true); } load(); });
    $('[data-settings]', body)?.addEventListener('click', () => settingsDialog(d));
    $$('[data-sel]', body).forEach(x => x.onchange = () => { x.checked ? S.sel.add(x.dataset.sel) : S.sel.delete(x.dataset.sel); load(); });
    $$('[data-open]', body).forEach(x => x.onclick = () => { S.open.has(x.dataset.open) ? S.open.delete(x.dataset.open) : S.open.add(x.dataset.open); load(); });
    $('[data-fix]', body)?.addEventListener('click', async () => {
        const ids = [...S.sel]; const names = ids.map(id => d.scan.targets.find(t => t.id === id)?.name || id);
        const plato = ids.includes('plato'), box = ids.includes('box');
        // Root without asking is opt-in, per run: unticked, the box agent's root commands wait for approval one by one,
        // and a PlatOpypus fix waits for Apply after you have seen the diff.
        const { panel, close } = C.openDialog(`<h2>${icon('claude')}Fix ${ids.length} target${ids.length === 1 ? '' : 's'}?</h2><p class="muted">${esc(names.join(', '))}. An agent fixes each in turn.</p>
            ${box ? `<label class="sc-check"><input type="checkbox" id="sc-gr" ${d.settings.autoRoot ? 'checked' : ''}>Let the box agent run root commands without asking me (an elevation grant for this run only; every command is still in the audit log)</label><p class="muted sc-hint">Unticked: each root command waits for your approval on the phone.</p>` : ''}
            ${plato ? `<label class="sc-check"><input type="checkbox" id="sc-aa" ${d.settings.autoApply ? 'checked' : ''}>Apply the PlatOpypus fix without asking me once it passes the checks (snapshot, health check and automatic rollback still apply)</label><p class="muted sc-hint">Unticked: it waits for you to read what changed and tap Apply.</p>` : ''}
            <div class="buttons"><button data-close>Cancel</button><button class="primary" data-go>Fix</button></div>`, { size: 'small' });
        $('[data-go]', panel).onclick = async () => {
            const grantRoot = !!$('#sc-gr', panel)?.checked, autoApply = !!$('#sc-aa', panel)?.checked; close();
            try { const r = await C.api('/api/selfcheck/fix', { method: 'POST', body: { targets: ids, grantRoot, autoApply } }); C.toast(r.queued.length ? `${r.queued.length} fix run${r.queued.length === 1 ? '' : 's'} started` : 'Nothing to fix there (or already running)'); S.sel.clear(); } catch (e) { C.toast(e.message, true); }
            load();
        };
    });
    $$('[data-apply]', body).forEach(x => x.onclick = async () => { if (!await C.confirmDialog({ title: 'Apply this fix to PlatOpypus?', text: 'PlatOpypus snapshots the files, applies the change and restarts. If it is not healthy within 45 s it rolls back by itself.', action: 'Apply' })) return; try { await C.api(`/api/selfcheck/runs/${x.dataset.apply}/apply`, { method: 'POST' }); C.toast('Applying: PlatOpypus restarts in a moment'); } catch (e) { C.toast(e.message, true); } load(); });
    $$('[data-discard]', body).forEach(x => x.onclick = async () => { try { await C.api(`/api/selfcheck/runs/${x.dataset.discard}/discard`, { method: 'POST' }); C.toast('Discarded: nothing was applied'); } catch (e) { C.toast(e.message, true); } load(); });
    $$('[data-watch]', body).forEach(x => x.onclick = () => C.openTerminal(x.dataset.watch, 'Self-check'));
    $$('[data-log]', body).forEach(x => x.onclick = async () => { const r = await C.api(`/api/selfcheck/runs/${x.dataset.log}`); textDialog(`${r.name}: log`, [...(r.log || []).map(l => `${new Date(l.at).toLocaleTimeString()}  ${l.by === 'agent' ? 'agent' : l.by === 'phone' ? 'you  ' : 'plato'}  ${l.line}`), ...(r.report ? ['', `Report: ${r.report.status}`, r.report.summary, ...(r.report.fixed || []).map(f => `  fixed: ${f}`), ...(r.report.remaining || []).map(f => `  left: ${f}`), r.report.tests ? `Tests: ${r.report.tests}` : ''] : []), ...(r.upgraded?.length ? ['', 'Packages changed:', ...r.upgraded.map(u => `  ${u}`)] : [])].join('\n')); });
    $$('[data-diff]', body).forEach(x => x.onclick = async () => { const r = await C.api(`/api/selfcheck/runs/${x.dataset.diff}`); textDialog(`${r.name}: what changed`, r.diff || 'No diff.'); });
    $$('[data-dev]', body).forEach(x => x.onclick = async () => { const r = await C.api(`/api/selfcheck/runs/${x.dataset.dev}`); textDialog('For the PlatOpypus developers', r.devNote || r.diff || 'Nothing recorded.', 'Paste this into an issue or message to the developers: it says what was fixed locally and has the patch to apply to the repository.'); });
    $$('[data-merge]', body).forEach(x => x.onclick = async () => { if (!await C.confirmDialog({ title: 'Merge the fix branch?', text: 'Merged back into the branch the project was on, and its running services restarted.', action: 'Merge' })) return; try { await C.api(`/api/selfcheck/runs/${x.dataset.merge}/merge`, { method: 'POST' }); C.toast('Merged'); } catch (e) { C.toast(e.message, true); } load(); });
    $$('[data-rollback]', body).forEach(x => x.onclick = async () => { const r = d.runs.find(y => y.id === x.dataset.rollback); if (!await C.confirmDialog({ title: `Roll back ${r.name}?`, text: r.kind === 'project' ? 'The fix commits are reverted (git revert) and its services restarted.' : r.kind === 'plato' ? 'The files are put back from the snapshot and PlatOpypus restarts.' : 'The nginx configuration comes back from the snapshot. Package upgrades stay: apt cannot safely go back.', action: 'Roll back' })) return; try { await C.api(`/api/selfcheck/runs/${x.dataset.rollback}/rollback`, { method: 'POST' }); C.toast('Rolled back'); } catch (e) { C.toast(e.message, true); } load(); });
    void esc; void icon;
}
function textDialog(title, text, note = '') {
    const { esc, icon } = C;
    const { panel } = C.openDialog(`<div class="sc-textdlg"><h2>${icon('file-text')}${esc(title)}</h2>${note ? `<p class="muted">${esc(note)}</p>` : ''}<pre class="sc-pre">${esc(text)}</pre><div class="buttons"><button data-copy>${icon('file')}Copy</button><button class="primary" data-close>Close</button></div></div>`, { size: 'sheet' });
    panel.querySelector('[data-copy]').onclick = async () => { try { await navigator.clipboard.writeText(text); C.toast('Copied'); } catch { C.toast('Select the text and copy it', true); } };
}
function settingsDialog(d) {
    const { $, $$, esc, icon } = C; const s = d.settings; const ts = d.scan?.targets || [];
    const presets = [['0 6 * * *', 'Every day at 06:00'], ['0 */6 * * *', 'Every 6 hours'], ['0 6 * * 1', 'Mondays at 06:00']];
    const sevOpt = v => ['critical', 'high', 'moderate', 'low'].map(k => `<option value="${k}" ${v === k ? 'selected' : ''}>${SEV_TXT[k]} and above</option>`).join('').replace('Critical and above', 'Critical only');
    const { panel, close } = C.openDialog(`<h2>${icon('settings')}Self-check settings</h2>
        <label class="sc-check"><input type="checkbox" id="sc-en" ${s.enabled ? 'checked' : ''}>Scan on a schedule</label>
        <div class="field"><label for="sc-cron">When (cron, box time)</label><input id="sc-cron" value="${esc(s.cron)}"><div class="sc-presets">${presets.map(([c, l]) => `<button class="chip" data-cron="${c}">${l}</button>`).join('')}</div></div>
        <label class="sc-check"><input type="checkbox" id="sc-al" ${s.alert ? 'checked' : ''}>Alert me about new findings</label>
        <div class="field"><label for="sc-als">Alert for</label><select id="sc-als">${sevOpt(s.alertSeverity)}</select></div>
        <h3 class="sc-h3">Fix on its own after a scheduled scan</h3><p class="muted">Ticked targets are fixed without asking when a scheduled scan finds something at or above the level below. Same rules as fixing by hand: branches for projects, snapshot and rollback for PlatOpypus, elevate for the box.</p>
        <div class="sc-autolist">${(ts.length ? ts : [{ id: 'plato', name: 'PlatOpypus itself' }, { id: 'box', name: 'The box: tooling and system packages' }]).map(t => `<label class="sc-check"><input type="checkbox" data-auto="${esc(t.id)}" ${s.autoTargets.includes(t.id) ? 'checked' : ''}>${esc(t.name)}</label>`).join('')}</div>
        <div class="field"><label for="sc-aus">Fix on its own for</label><select id="sc-aus">${sevOpt(s.autoSeverity)}</select></div>
        <h3 class="sc-h3">Root without asking</h3><p class="muted">Fixes to the box and to PlatOpypus itself need root. These choose whether they get it without asking you: scheduled fixes use them as set, and when you press Fix they are where the choices start (you can still change them for that run).</p>
        <label class="sc-check"><input type="checkbox" id="sc-ar" ${s.autoRoot ? 'checked' : ''}>Box fixes may run root commands without asking (bypass elevate approval)</label><p class="muted sc-hint">Off: each root command waits for your approval on the phone (you get a root-request alert); one left unanswered for 10 minutes is skipped.</p>
        <label class="sc-check"><input type="checkbox" id="sc-aa2" ${s.autoApply ? 'checked' : ''}>PlatOpypus fixes may be applied without asking (root change to PlatOpypus)</label><p class="muted sc-hint">Off: each waits under "Fixing now" for you to read what changed and tap Apply. Snapshot, health check and rollback apply either way.</p>
        <div class="field"><label for="sc-ag">Agent</label><select id="sc-ag">${[['claude', 'Claude Code'], ['codex', 'Codex CLI'], ['antigravity', 'Antigravity CLI']].map(([k, l]) => `<option value="${k}" ${s.agent === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="buttons"><button data-close>Cancel</button><button class="primary" data-ok>Save</button></div>`);
    $$('[data-cron]', panel).forEach(b => b.onclick = () => { $('#sc-cron', panel).value = b.dataset.cron; });
    $('[data-ok]', panel).onclick = async () => {
        try { await C.api('/api/selfcheck/settings', { method: 'POST', body: { enabled: $('#sc-en', panel).checked, cron: $('#sc-cron', panel).value, alert: $('#sc-al', panel).checked, alertSeverity: $('#sc-als', panel).value, autoTargets: $$('[data-auto]', panel).filter(x => x.checked).map(x => x.dataset.auto), autoSeverity: $('#sc-aus', panel).value, autoRoot: $('#sc-ar', panel).checked, autoApply: $('#sc-aa2', panel).checked, agent: $('#sc-ag', panel).value } }); close(); C.toast('Saved'); load(); }
        catch (e) { C.toast(e.message, true); }
    };
}

// The box: what is running (services and listening ports, with their packages) and what is installed outside apt.
function boxInventory(t) {
    const { esc } = C; const svc = t.services || []; const inst = t.installed || {};
    const counts = Object.entries(inst.counts || {}).map(([k, n]) => `<span><b>${n}</b> ${esc(k)}</span>`).join('');
    const bins = (inst.binaries || []);
    return `<details class="sc-inv"><summary>Running now: ${svc.length} service${svc.length === 1 ? '' : 's'} and processes, ${svc.filter(x => x.listening.length).length} listening</summary><div class="sc-svcs">${svc.map(x => `<div><b>${esc(x.units[0] || x.name)}</b> <span class="muted">${esc(x.source ? `${x.source} ${x.version || ''}` : x.exe)}</span>${x.listening.length ? `<i>${esc(x.listening.slice(0, 3).join(', '))}</i>` : ''}</div>`).join('')}</div></details>
        ${(t.patched || []).length ? `<details class="sc-inv" open><summary>Recent serious CVEs already patched here (${t.patched.length})</summary><div class="sc-svcs">${t.patched.map(x => `<div><b>${esc(x.cve)}</b> <span class="muted">${esc(x.package)} · ${esc(x.severity)} · fixed in ${esc(x.fixedIn)}, installed ${esc(x.installed)}</span><i>${esc(x.summary)}</i></div>`).join('')}</div></details>` : ''}
        <details class="sc-inv"><summary>Installed: ${counts ? '' : 'nothing counted'}</summary><div class="sc-tools">${counts}</div>${bins.length ? `<div class="sc-svcs">${bins.map(x => `<div><b>${esc(x.name)}</b> <span class="muted">${esc(x.version)}${x.latest && x.latest !== x.version ? ` → ${esc(x.latest)}` : ''}</span> <i>${esc(x.path)}</i></div>`).join('')}</div>` : ''}</details>`;
}
