// Job Hunt: an AI-run job board around one person. Loaded on demand by app.js (setup(ctx) hands over its helpers).
//
// Views: Board (wish box, the jobs found, each with its fit and money), Me (a map of everything you have done, and the
// gaps jobs keep asking about), CV (your LaTeX template: swap section variants, preview, save versions; uploaded CVs),
// Applications (a folder and tracker per application), Activity, Setup (what to search, keys, money assumptions).

let C = null;
const S = { tab: 'board', ov: null, filter: 'active', sort: 'match', choice: {}, poll: null, meView: 'map' };
const VERDICT = { meets: 'Meets', partly: 'Partly', gap: 'Gap' };
const STAGE_TXT = { preparing: 'Preparing', applied: 'Applied', assessment: 'Assessment', interview: 'Interview', final: 'Final round', offer: 'Offer', accepted: 'Accepted', rejected: 'Rejected', withdrawn: 'Withdrawn' };
const KIND_COLOR = { project: '#F0B840', role: '#6FB1F0', skill: '#3FD39A', education: '#B38CFF', cert: '#2EC4B6', achievement: '#FF7AA8', interest: '#93A4BA' };
const SYM = { GBP: '£', EUR: '€', USD: '$', CHF: 'CHF ' };
const money = (n, cur = 'GBP') => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? '–' : `${SYM[cur || 'GBP'] ?? `${cur} `}${Math.round(Number(n)).toLocaleString('en-GB')}`);
const ago = t => { const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const md = s => C.esc(s || '').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/^#{1,4} (.*)$/gm, '<h4>$1</h4>').replace(/^[-*] (.*)$/gm, '<li>$1</li>').replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`).replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n{2,}/g, '<br><br>');
const b64 = file => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => bad(new Error('Could not read the file.')); r.readAsDataURL(file); });

export function setup(ctx) { C = ctx; }

export async function loadJobs(tab) {
    if (tab) S.tab = tab; clearInterval(S.poll); S.poll = null;
    const { $, $$ } = C;
    S.ov = await C.api('/api/jobs');
    const c = S.ov.counts;
    const tabs = [['board', `Board${c.new ? `<em>${c.new}</em>` : ''}`], ['me', `Me${c.gaps ? `<em>${c.gaps}</em>` : ''}`], ['cv', 'CV'], ['apps', 'Applications'], ['log', 'Activity'], ['setup', 'Setup']];
    $('#jobs-seg').innerHTML = tabs.map(([k, l]) => `<button data-jt="${k}" class="${S.tab === k ? 'on' : ''}" role="tab" aria-selected="${S.tab === k}">${l}</button>`).join('');
    $$('#jobs-seg [data-jt]').forEach(b => b.onclick = () => loadJobs(b.dataset.jt).catch(e => C.toast(e.message, true)));
    const fn = { board: renderBoard, me: renderMe, cv: renderCv, apps: renderApps, log: renderLog, setup: renderSetup }[S.tab];
    await fn($('#jobs-body'));
}
const reload = () => loadJobs().catch(e => C.toast(e.message, true));

// ---------- Board ----------
async function renderBoard(box) {
    const { esc, icon, $, $$ } = C; const ov = S.ov; const c = ov.counts;
    const [b, w] = await Promise.all([C.api('/api/jobs/board'), C.api('/api/jobs/wishes')]);
    const keyed = Object.entries(ov.settings.keys).filter(([, k]) => k.needs.length);
    const noKeys = keyed.every(([, k]) => !k.ready);
    const live = w.wishes.filter(x => x.status === 'started');
    box.innerHTML = `
        <form class="jh-wish" data-wish>
          <label for="jh-wish-t">What job do you want?</label>
          <textarea id="jh-wish-t" rows="2" maxlength="600" placeholder="A junior security analyst job in Leeds or remote, from £28k"></textarea>
          <div class="jh-wish-row"><span class="muted">An agent sets the search, hunts job sites and the web, then scores the best against Me.</span><button class="btn pri" type="submit">${icon('search')}Find jobs</button></div>
        </form>
        ${noKeys ? `<div class="jh-banner"><b>Do you have job-search API keys?</b> Adzuna, Reed and Jooble give far more UK jobs (all free to sign up). Without them the hunt uses Remotive and Arbeitnow only. <button class="text-btn" data-go-setup>Add keys</button></div>` : ''}
        ${w.wishes.length ? `<div class="jh-wishes">${w.wishes.slice(0, 4).map(x => `<div class="jh-wishline ${x.status}"><span class="dot"></span><div class="main"><div>${esc(x.text)}</div>${x.summary ? `<div class="jh-wishsum">${md(x.summary)}</div>` : `<div class="muted">${x.status === 'started' ? `Working on it · started ${ago(x.at)}` : esc(x.status)}</div>`}</div>${x.status === 'started' ? `<button class="text-btn" data-watch="wish-${esc(x.id.slice(1))}">Watch</button>` : ''}</div>`).join('')}</div>` : ''}
        <div class="jh-stats">
          ${[['Jobs', c.jobs], ['Shortlisted', c.shortlisted], ['To apply', c.toApply], ['Applied', c.applied], ['In progress', c.inProgress]].map(([l, n]) => `<div><b>${n}</b><span>${l}</span></div>`).join('')}
        </div>
        <div class="jh-tools">
          <div class="seg jh-filter">${[['active', 'Active'], ['new', 'New'], ['shortlisted', 'Shortlisted'], ['applying', 'Applying'], ['applied', 'Applied'], ['hidden', 'Hidden']].map(([k, l]) => `<button data-f="${k}" class="${S.filter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
          <div class="jh-toolrow">
            <select data-sort aria-label="Sort">${[['match', 'Best match'], ['left', 'Most left over'], ['new', 'Newest'], ['deadline', 'Deadline']].map(([k, l]) => `<option value="${k}" ${S.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <button class="btn" data-hunt>${icon('refresh')}Search job sites</button><button class="btn" data-add>${icon('plus')}Add a job</button>
          </div>
        </div>
        <div class="jh-jobs">${jobCards(b.jobs) || `<p class="note">${b.jobs.length ? 'Nothing here with this filter.' : 'No jobs yet. Tell it what you want above, or set the search in Setup and search the job sites.'}</p>`}</div>`;
    $('[data-wish]', box).onsubmit = async e => {
        e.preventDefault(); const t = $('#jh-wish-t', box).value.trim(); if (!t) return;
        try { const r = await C.api('/api/jobs/wish', { method: 'POST', body: { text: t } }); C.toast('An agent is on it. New jobs appear here as it finds them.'); S.tab = 'board'; await loadJobs(); void r; } catch (x) { C.toast(x.message, true); }
    };
    const gs = $('[data-go-setup]', box); if (gs) gs.onclick = () => loadJobs('setup');
    $$('[data-watch]', box).forEach(x => x.onclick = () => C.openTerminal(x.dataset.watch, 'Job Hunt').catch(e => C.toast(e.message, true)));
    $$('[data-f]', box).forEach(x => x.onclick = () => { S.filter = x.dataset.f; renderBoard(box); });
    $('[data-sort]', box).onchange = e => { S.sort = e.target.value; renderBoard(box); };
    $('[data-hunt]', box).onclick = async e => { const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Searching…'; try { const r = await C.api('/api/jobs/hunt', { method: 'POST' }); C.toast(`${r.added} new jobs (${r.found} seen)${Object.keys(r.errors).length ? `; ${Object.keys(r.errors).join(', ')} failed` : ''}`); reload(); } catch (x) { C.toast(x.message, true); btn.disabled = false; } };
    $('[data-add]', box).onclick = addJobDialog;
    $$('[data-job]', box).forEach(x => x.onclick = () => jobDialog(x.dataset.job));
    if (live.length) S.poll = setInterval(() => { if (S.tab === 'board' && !document.hidden && $('#dialog').hidden) renderBoard(box).catch(() => {}); }, 20_000);
}
function jobCards(jobs) {
    const { esc } = C; const today = new Date().toISOString().slice(0, 10);
    const list = jobs.filter(j => (S.filter === 'active' ? !['hidden', 'applied'].includes(j.status) : j.status === S.filter));
    const key = { match: j => -(j.match?.score ?? -1), left: j => -(j.money?.left ?? -1e9), new: j => -j.found, deadline: j => (j.deadline || '9999') }[S.sort];
    list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    return list.map(j => {
        const sc = j.match?.score; const tone = sc === undefined ? 'none' : sc >= 70 ? 'hi' : sc >= 45 ? 'mid' : 'lo';
        const late = j.deadline && j.deadline < today;
        return `<button class="jh-job" data-job="${esc(j.id)}">
            <span class="jh-fit ${tone}" style="--v:${sc ?? 0}"><b>${sc ?? '–'}</b></span>
            <span class="main"><span class="t">${esc(j.title)}</span><span class="s">${esc([j.company, j.location].filter(Boolean).join(' · '))}</span>
              <span class="m">${j.salary ? `<span>${esc(j.salary)}</span>` : ''}${j.money?.left !== undefined && j.money?.left !== null ? `<span class="left">${money(j.money.left, j.money.currency)} left / yr</span>` : ''}${j.deadline ? `<span class="${late ? 'late' : ''}">closes ${esc(j.deadline)}</span>` : ''}${j.status !== 'new' ? `<span class="st">${esc(j.status)}</span>` : ''}<span class="src">${esc(j.source || j.by || '')}</span></span></span>
        </button>`;
    }).join('');
}
function addJobDialog() {
    const { icon, $ } = C;
    const { panel, close } = C.openDialog(`<h2>${icon('plus')}Add a job</h2>
        <div class="field"><label for="aj-t">Title</label><input id="aj-t" maxlength="200"></div>
        <div class="field"><label for="aj-c">Company</label><input id="aj-c" maxlength="160"></div>
        <div class="field"><label for="aj-l">Location</label><input id="aj-l" maxlength="160"></div>
        <div class="field"><label for="aj-s">Salary</label><input id="aj-s" maxlength="160" placeholder="£30,000"></div>
        <div class="field"><label for="aj-d">Deadline</label><input id="aj-d" type="date"></div>
        <div class="field"><label for="aj-u">Link</label><input id="aj-u" type="url" maxlength="800"></div>
        <div class="field"><label for="aj-x">The advert</label><textarea id="aj-x" rows="5" placeholder="Paste the job description: requirements are read from it when it is scored."></textarea></div>
        <div class="buttons"><button data-close>Cancel</button><button class="primary" data-ok>Add</button></div>`);
    $('[data-ok]', panel).onclick = async () => { try { const n = Number(String($('#aj-s', panel).value).replace(/[^0-9.]/g, '')); await C.api('/api/jobs/board', { method: 'POST', body: { title: $('#aj-t', panel).value, company: $('#aj-c', panel).value, location: $('#aj-l', panel).value, salary: $('#aj-s', panel).value, salaryMin: n > 1000 ? n : undefined, deadline: $('#aj-d', panel).value, url: $('#aj-u', panel).value, description: $('#aj-x', panel).value, source: 'added by you' } }); close(); reload(); } catch (x) { C.toast(x.message, true); } };
}

// One job: fit, money, advice, and what to do next.
async function jobDialog(id) {
    const { esc, icon, $, $$ } = C;
    const [d, me] = await Promise.all([C.api(`/api/jobs/job/${id}`), C.api('/api/jobs/me')]);
    const j = d.job; const byId = new Map(me.items.map(i => [i.id, i]));
    const m = j.money; const est = d.estimate;
    const running = d.advice.some(p => p.status === 'running');
    const plan = j.plan || { stage: 'research', done: {} }; const cur = d.plan.find(s => s.id === plan.stage) || d.plan[0];
    const { panel, close } = C.openDialog(`
        <h2>${icon('file-text')}${esc(j.title)}</h2>
        <p class="muted">${esc([j.company, j.location, j.salary].filter(Boolean).join(' · '))}${j.url ? ` · <a href="${esc(j.url)}" target="_blank" rel="noopener">the advert</a>` : ''}</p>
        <div class="jh-actions">
          ${j.status !== 'shortlisted' ? `<button class="btn" data-st="shortlisted">${icon('pin')}Shortlist</button>` : `<button class="btn" data-st="new">Unshortlist</button>`}
          ${['applying', 'applied'].includes(j.status) ? '' : `<button class="btn pri" data-apply>${icon('folder-plus')}Start an application</button>`}
          ${j.status !== 'hidden' ? `<button class="btn" data-st="hidden">${icon('eye')}Hide</button>` : `<button class="btn" data-st="new">Show again</button>`}
        </div>
        <h3 class="jh-h">This job as a project</h3>
        <div class="jh-stages" role="tablist">${d.plan.map((s, i) => { const n = s.items.filter(([k]) => plan.done[`${s.id}.${k}`]).length; return `<button data-stage="${s.id}" class="${s.id === cur.id ? 'on' : ''} ${n === s.items.length ? 'full' : ''}" role="tab" aria-selected="${s.id === cur.id}"><span class="i">${i + 1}</span>${esc(s.title)}<span class="c">${n}/${s.items.length}</span></button>`; }).join('')}</div>
        <div class="jh-stagebox">
          <div class="jh-checks">${cur.items.map(([k, l]) => `<label><input type="checkbox" data-item="${cur.id}.${k}" ${plan.done[`${cur.id}.${k}`] ? 'checked' : ''}>${esc(l)}</label>`).join('')}</div>
          ${cur.ai ? `<div class="jh-work"><textarea data-workx rows="2" maxlength="1500" placeholder="${cur.id === 'research' ? 'Anything to look into? e.g. I need a Skilled Worker visa' : cur.id === 'interview' ? 'What you know about the interview, e.g. 45 min video call with the team lead' : 'Anything the agent should know'}"></textarea>
            ${cur.id === 'research' ? '<div class="jh-topics"><label><input type="checkbox" data-wv>Visa and sponsorship too</label><label><input type="checkbox" data-wp>Pay and cost of living too</label></div>' : ''}
            <button class="btn pri" data-work="${cur.id}">${icon('claude')}${esc(cur.ai)}</button></div>` : '<p class="muted">Nothing for an agent here: tick things off as you do them.</p>'}
          ${d.drafts.length ? `<div class="jh-drafts">${d.drafts.map(x => `<button class="chip" data-draft="${esc(x.name)}">${icon('file-text')}${esc(x.name)}</button>`).join('')}</div>` : ''}
        </div>
        <h3 class="jh-h">Fit</h3>
        ${j.match ? `<div class="jh-matchhead"><span class="jh-fit big ${j.match.score >= 70 ? 'hi' : j.match.score >= 45 ? 'mid' : 'lo'}" style="--v:${j.match.score}"><b>${j.match.score}</b></span><div>${j.match.level ? `<b>Comes in at: ${esc(j.match.level)}</b><br>` : ''}${esc(j.match.summary || '')}<div class="muted">by ${esc(j.match.by)} · ${ago(j.match.at)}</div></div></div>
            <div class="jh-lines">${j.match.lines.map(l => `<div class="jh-line ${l.verdict}"><span class="v">${VERDICT[l.verdict]}</span><div><div>${esc(l.requirement)}</div>${l.note ? `<div class="muted">${esc(l.note)}</div>` : ''}${l.evidence.length ? `<div class="jh-ev">${l.evidence.map(e => byId.get(e)).filter(Boolean).map(i => `<span style="--k:${KIND_COLOR[i.kind]}">${esc(i.title)}</span>`).join('')}</div>` : ''}</div></div>`).join('')}</div>`
            : `<p class="note">Not scored yet. ${d.candidates.length ? 'Likely evidence from Me is listed below; ' : ''}an agent scores it when it works a wish, or ask for it now.</p>${d.candidates.length ? `<div class="jh-lines">${d.candidates.map(r => `<div class="jh-line ${r.candidates.length ? 'partly' : 'gap'}"><span class="v">${r.candidates.length ? 'Maybe' : 'Nothing'}</span><div>${esc(r.requirement)}${r.candidates.length ? `<div class="jh-ev">${r.candidates.map(x => `<span style="--k:${KIND_COLOR[x.kind]}">${esc(x.title)}</span>`).join('')}</div>` : ''}</div></div>`).join('')}</div>` : ''}<div class="r-actions"><button class="btn" data-score>${icon('claude')}Score it against Me</button></div>`}
        <h3 class="jh-h">Money, per year</h3>
        <div class="jh-money">
          ${[['Gross', m?.gross ?? est?.gross], ['Take-home', m?.takeHome ?? est?.takeHome], ['Living costs', m?.living], ['Left over', m?.left]].map(([l, v], i) => `<div class="${i === 3 ? 'left' : ''}"><span>${l}</span><b>${money(v, m?.currency || 'GBP')}</b></div>`).join('')}
        </div>
        <p class="muted jh-assume">${esc(m?.assumptions || est?.assumptions || 'No figures yet: an agent works them out (tax and living costs under the rules where the job is, in its currency) when it scores the job.')}</p>
        <h3 class="jh-h">Advice</h3>
        <div class="jh-advice-ask">
          <div class="jh-topics">${S.ov.advice.map(a => `<label><input type="checkbox" value="${a.tag}" ${['company', 'role'].includes(a.tag) ? 'checked' : ''}>${esc(a.title)}</label>`).join('')}</div>
          <textarea data-extra rows="2" maxlength="800" placeholder="Anything else? e.g. I would need a Skilled Worker visa; what should I say about my gap year?"></textarea>
          <button class="btn pri" data-advice>${icon('claude')}Ask for advice</button>
          <p class="muted">Each topic goes to its own agent at once (it sees only the job and the question, never Me), and searches the web.</p>
        </div>
        <div class="jh-probes">${d.advice.map(p => `<details class="jh-probe ${p.status}" ${p.status === 'done' ? '' : 'open'}><summary><span class="dot"></span>${esc(S.ov.advice.find(a => a.tag === p.tag)?.title || p.subject)}<span class="muted">${p.status === 'running' ? 'researching…' : `${esc(p.agent)} · ${ago(p.finished || p.at)}`}</span></summary><div class="jh-answer">${p.status === 'running' ? '' : md(p.answer)}</div></details>`).join('')}</div>
        ${j.description ? `<details class="jh-desc"><summary>The advert</summary><div>${esc(j.description)}</div></details>` : ''}
        <div class="field"><label for="jd-notes">Your notes</label><textarea id="jd-notes" rows="3">${esc(j.notes || '')}</textarea></div>
        <div class="buttons"><button data-close>Close</button><button class="primary" data-save>Save notes</button></div>`);
    $$('[data-stage]', panel).forEach(x => x.onclick = async () => { try { await C.api(`/api/jobs/job/${id}/plan`, { method: 'POST', body: { stage: x.dataset.stage } }); close(); jobDialog(id); } catch (e) { C.toast(e.message, true); } });
    $$('[data-item]', panel).forEach(x => x.onchange = () => C.api(`/api/jobs/job/${id}/plan`, { method: 'POST', body: { item: x.dataset.item, done: x.checked } }).catch(e => C.toast(e.message, true)));
    const wk = $('[data-work]', panel); if (wk) wk.onclick = async () => {
        wk.disabled = true;
        try { const r = await C.api(`/api/jobs/job/${id}/work`, { method: 'POST', body: { stage: wk.dataset.work, extra: $('[data-workx]', panel).value.trim(), visa: !!$('[data-wv]', panel)?.checked, pay: !!$('[data-wp]', panel)?.checked } });
            if (r.shell) { C.toast('An agent is working on it; drafts appear here when it finishes.'); close(); C.openTerminal(r.shell, 'Job Hunt'); } else { close(); jobDialog(id); } }
        catch (e) { C.toast(e.message, true); wk.disabled = false; }
    };
    $$('[data-draft]', panel).forEach(x => x.onclick = async () => { try { const r = await C.api(`/api/jobs/job/${id}/draft?name=${encodeURIComponent(x.dataset.draft)}`); const dd = C.openDialog(`<h2>${icon('file-text')}${esc(r.name)}</h2><div class="jh-answer jh-draft">${md(r.text)}</div><div class="buttons"><button data-copy>Copy</button><button data-close>Close</button></div>`); $('[data-copy]', dd.panel).onclick = () => navigator.clipboard.writeText(r.text).then(() => C.toast('Copied')); } catch (e) { C.toast(e.message, true); } });
    $$('[data-st]', panel).forEach(x => x.onclick = async () => { try { await C.api(`/api/jobs/job/${id}`, { method: 'POST', body: { status: x.dataset.st } }); close(); reload(); } catch (e) { C.toast(e.message, true); } });
    const ap = $('[data-apply]', panel); if (ap) ap.onclick = () => { close(); startApplication(j); };
    $('[data-save]', panel).onclick = async () => { try { await C.api(`/api/jobs/job/${id}`, { method: 'POST', body: { notes: $('#jd-notes', panel).value } }); C.toast('Saved'); } catch (e) { C.toast(e.message, true); } };
    $('[data-advice]', panel).onclick = async () => {
        const topics = $$('.jh-topics input:checked', panel).map(x => x.value); const extra = $('[data-extra]', panel).value.trim();
        if (!topics.length && !extra) return C.toast('Pick a topic or ask a question.', true);
        try { await C.api(`/api/jobs/job/${id}/advice`, { method: 'POST', body: { topics, extra } }); close(); jobDialog(id); } catch (e) { C.toast(e.message, true); }
    };
    const sc = $('[data-score]', panel); if (sc) sc.onclick = async () => { try { await C.api('/api/jobs/wish', { method: 'POST', body: { text: `Score this one job against Me (requirements, fit, money): ${j.id} "${j.title}"${j.company ? ` at ${j.company}` : ''}. Do not hunt for others.` } }); C.toast('An agent is scoring it.'); close(); } catch (e) { C.toast(e.message, true); } };
    if (running) { const t = setInterval(async () => { if ($('#dialog').hidden || !panel.isConnected) return clearInterval(t); const n = await C.api(`/api/jobs/job/${id}`).catch(() => null); if (n && !n.advice.some(p => p.status === 'running')) { clearInterval(t); if (!$('#dialog').hidden) { close(); jobDialog(id); } } }, 8000); }
}

// ---------- Me: a map of everything you have done ----------
async function renderMe(box) {
    const { esc, icon, $, $$ } = C; const me = await C.api('/api/jobs/me'); const kinds = S.ov.kinds;
    const gaps = me.gaps.filter(g => g.status === 'open');
    box.innerHTML = `
        <p class="r-sub">Everything you have done, in one place: agents check every job against it, and ask you for examples when a job wants something it cannot find here.</p>
        <div class="r-actions"><button class="btn pri" data-talk>${icon('claude')}Talk to an agent about me</button><button class="btn" data-add>${icon('plus')}Add something</button>
          <div class="seg jh-meview">${[['map', 'Map'], ['list', 'List']].map(([k, l]) => `<button data-mv="${k}" class="${S.meView === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        ${gaps.length ? `<div class="jh-gaps"><h3 class="jh-h">Jobs keep asking about</h3>${gaps.map(g => `<div class="jh-gap"><div class="main">${esc(g.text)}</div><button class="text-btn" data-gap="${g.id}">Answer</button><button class="text-btn dim" data-dismiss="${g.id}">Not me</button></div>`).join('')}</div>` : ''}
        ${me.items.length ? (S.meView === 'map' ? `<div class="jh-map">${meMap(me.items, kinds)}</div>` : '') : '<p class="note">Nothing here yet. The quickest start: talk to an agent about your projects and jobs, or add your CV on the CV tab and ask the agent to read it.</p>'}
        ${S.meView === 'list' || !me.items.length ? '' : '<p class="muted jh-maphint">Tap a dot to open it. Lines join related things.</p>'}
        <div class="jh-melist" ${S.meView === 'map' ? 'hidden' : ''}>${Object.entries(kinds).map(([k, l]) => { const its = me.items.filter(i => i.kind === k); return its.length ? `<h3 class="jh-h" style="--k:${KIND_COLOR[k]}"><span class="kdot"></span>${esc(l)}</h3>${its.map(i => `<button class="row" data-me="${i.id}"><div class="main"><div class="title">${esc(i.title)}</div><div class="sub muted">${esc([i.org, i.from && `${i.from}${i.to ? `–${i.to}` : ''}`, i.level].filter(Boolean).join(' · '))}</div></div></button>`).join('')}` : ''; }).join('')}</div>`;
    $('[data-talk]', box).onclick = async () => { try { const r = await C.api('/api/jobs/me/interview', { method: 'POST', body: {} }); C.openTerminal(r.shell, 'Job Hunt'); } catch (e) { C.toast(e.message, true); } };
    $('[data-add]', box).onclick = () => meDialog(null, kinds);
    $$('[data-mv]', box).forEach(x => x.onclick = () => { S.meView = x.dataset.mv; renderMe(box); });
    $$('[data-me]', box).forEach(x => x.onclick = () => meDialog(me.items.find(i => i.id === x.dataset.me), kinds, me.items));
    $$('[data-gap]', box).forEach(x => x.onclick = () => gapDialog(me.gaps.find(g => g.id === x.dataset.gap), kinds));
    $$('[data-dismiss]', box).forEach(x => x.onclick = async () => { await C.api(`/api/jobs/gap/${x.dataset.dismiss}`, { method: 'POST', body: { status: 'dismissed' } }).catch(e => C.toast(e.message, true)); reload(); });
}
// A radial map: Me in the middle, one branch per kind, items around it; related items joined by curves.
function meMap(items, kinds) {
    const { esc } = C; const W = 760, H = 560, cx = W / 2, cy = H / 2;
    const used = Object.keys(kinds).filter(k => items.some(i => i.kind === k)); const pos = new Map(); let svg = '';
    used.forEach((k, ki) => {
        const its = items.filter(i => i.kind === k); const a0 = (ki / used.length) * Math.PI * 2 - Math.PI / 2; const span = (Math.PI * 2 / used.length) * 0.8;
        const hx = cx + Math.cos(a0) * 105, hy = cy + Math.sin(a0) * 80;
        svg += `<line x1="${cx}" y1="${cy}" x2="${hx}" y2="${hy}" class="br" style="stroke:${KIND_COLOR[k]}"/>`;
        its.forEach((it, i) => {
            const a = a0 + (its.length === 1 ? 0 : (i / (its.length - 1) - 0.5) * span); const ring = i % 2 ? 1 : 0;
            const x = cx + Math.cos(a) * (215 + ring * 60), y = cy + Math.sin(a) * (175 + ring * 45); pos.set(it.id, { x, y, k });
            svg += `<path d="M${hx},${hy} Q${(hx + x) / 2},${(hy + y) / 2 + 10} ${x},${y}" class="tw" style="stroke:${KIND_COLOR[k]}"/>`;
        });
        svg += `<g class="hub"><circle cx="${hx}" cy="${hy}" r="7" style="fill:${KIND_COLOR[k]}"/><text x="${hx}" y="${hy - 12}" text-anchor="middle">${esc(kinds[k].split(' ')[0])}</text></g>`;
    });
    for (const it of items) for (const l of it.links || []) { const a = pos.get(it.id), b = pos.get(l); if (a && b && it.id < l) svg += `<path d="M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}" class="ln"/>`; }
    for (const it of items) { const p = pos.get(it.id); if (!p) continue; const lv = { aware: 4, working: 5.5, strong: 7, expert: 8.5 }[it.level] || 5; const right = p.x >= cx;
        svg += `<g class="leaf" data-me="${it.id}" tabindex="0" role="button" aria-label="${esc(it.title)}"><circle cx="${p.x}" cy="${p.y}" r="${lv}" style="fill:${KIND_COLOR[p.k]}"/><text x="${p.x + (right ? 12 : -12)}" y="${p.y + 4}" text-anchor="${right ? 'start' : 'end'}">${esc(it.title.length > 26 ? `${it.title.slice(0, 25)}…` : it.title)}</text></g>`; }
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of your experience">${svg}<g class="me"><circle cx="${cx}" cy="${cy}" r="26"/><text x="${cx}" y="${cy + 5}" text-anchor="middle">Me</text></g></svg>`;
}
function meDialog(it, kinds, all = []) {
    const { esc, icon, $ } = C; const x = it || {};
    const { panel, close } = C.openDialog(`<h2>${icon(it ? 'edit' : 'plus')}${it ? esc(it.title) : 'Add to Me'}</h2>
        <div class="field"><label for="me-k">Kind</label><select id="me-k">${Object.entries(kinds).map(([k, l]) => `<option value="${k}" ${x.kind === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        <div class="field"><label for="me-t">Title</label><input id="me-t" maxlength="160" value="${esc(x.title || '')}" placeholder="Home lab SIEM with Splunk"></div>
        <div class="field"><label for="me-o">Where</label><input id="me-o" maxlength="120" value="${esc(x.org || '')}" placeholder="Company, university, client or personal"></div>
        <div class="jh-two"><div class="field"><label for="me-f">From</label><input id="me-f" maxlength="20" value="${esc(x.from || '')}" placeholder="2024-09"></div><div class="field"><label for="me-to">To</label><input id="me-to" maxlength="20" value="${esc(x.to || '')}" placeholder="now"></div></div>
        <div class="field"><label for="me-l">Level</label><select id="me-l">${['', 'aware', 'working', 'strong', 'expert'].map(l => `<option value="${l}" ${x.level === l ? 'selected' : ''}>${l || '—'}</option>`).join('')}</select></div>
        <div class="field"><label for="me-s">What it was and what you did</label><textarea id="me-s" rows="4">${esc(x.summary || '')}</textarea></div>
        <div class="field"><label for="me-e">Evidence (one per line: results, numbers, links)</label><textarea id="me-e" rows="3">${esc((x.evidence || []).join('\n'))}</textarea></div>
        <div class="field"><label for="me-g">Skills and tools it shows (comma-separated)</label><input id="me-g" value="${esc((x.tags || []).join(', '))}"></div>
        ${all.length > 1 ? `<div class="field"><label>Related</label><div class="jh-rel">${all.filter(o => o.id !== x.id).map(o => `<label><input type="checkbox" value="${o.id}" ${(x.links || []).includes(o.id) ? 'checked' : ''}>${esc(o.title)}</label>`).join('')}</div></div>` : ''}
        <div class="buttons">${it ? '<button class="danger" data-del>Delete</button>' : ''}<button data-close>Cancel</button><button class="primary" data-ok>Save</button></div>`);
    $('[data-ok]', panel).onclick = async () => {
        try { await C.api('/api/jobs/me', { method: 'POST', body: { kind: $('#me-k', panel).value, title: $('#me-t', panel).value, org: $('#me-o', panel).value, from: $('#me-f', panel).value, to: $('#me-to', panel).value, level: $('#me-l', panel).value || undefined, summary: $('#me-s', panel).value, evidence: $('#me-e', panel).value.split('\n').map(s => s.trim()).filter(Boolean), tags: $('#me-g', panel).value, ...(all.length > 1 ? { links: [...panel.querySelectorAll('.jh-rel input:checked')].map(c => c.value) } : {}) } }); close(); reload(); } catch (e) { C.toast(e.message, true); }
    };
    const del = $('[data-del]', panel); if (del) del.onclick = async () => { close(); if (await C.confirmDialog({ title: `Delete "${it.title}"?`, text: 'It goes from Me and from any links.', action: 'Delete' })) { await C.api(`/api/jobs/me/${it.id}/delete`, { method: 'POST' }).catch(e => C.toast(e.message, true)); reload(); } };
}
function gapDialog(g, kinds) {
    const { esc, icon, $ } = C;
    const { panel, close } = C.openDialog(`<h2>${icon('claude')}${esc(g.text)}</h2><p class="muted">Give an example: what you did, where, and what came of it. It is kept with the gap, and you can add it to Me as well.</p>
        <div class="field"><textarea id="gp-a" rows="5"></textarea></div>
        <label class="jh-check"><input type="checkbox" id="gp-me" checked>Add it to Me as a skill</label>
        <div class="buttons"><button data-close>Cancel</button><button class="primary" data-ok>Save</button></div>`);
    $('[data-ok]', panel).onclick = async () => { const a = $('#gp-a', panel).value.trim(); if (!a) return; try { await C.api(`/api/jobs/gap/${g.id}`, { method: 'POST', body: { answer: a } }); if ($('#gp-me', panel).checked) await C.api('/api/jobs/me', { method: 'POST', body: { kind: 'skill', title: g.text.slice(0, 150), summary: a, evidence: [a.slice(0, 480)] } }); close(); reload(); } catch (e) { C.toast(e.message, true); } };
    void kinds;
}

// ---------- CV: template sections you swap, versions, and uploaded CVs ----------
async function renderCv(box) {
    const { esc, icon, $, $$ } = C; const [t, u] = await Promise.all([C.api('/api/jobs/cv'), C.api('/api/jobs/cvs')]);
    const cats = [...new Set(u.cvs.flatMap(c => c.categories))];
    let html = '';
    if (!t.template) {
        html += `<div class="card jh-cvstart"><h3>Your CV as a LaTeX template</h3><p class="note">Mark each section with a line <code>% @section{Experience}</code> before it and <code>% @end</code> after it. Each section can then hold several versions (yours and AI suggestions for a job) that you swap in and build to a PDF.</p>
            <div class="r-actions"><button class="btn pri" data-starter>${icon('file-plus')}Start from a simple template</button><label class="btn">${icon('upload')}Use my .tex file<input type="file" accept=".tex" data-texfile hidden></label></div></div>`;
    } else {
        html += `<div class="jh-cvbar"><div><b>${esc(t.template.name)}</b><span class="muted"> · ${t.sections.length} sections</span></div>
            <div class="r-actions"><a class="btn" href="/editor.html?ws=jobs-cv" target="_blank" rel="noopener">${icon('file-code')}Edit template</a><button class="btn" data-preview>${icon('eye')}Preview PDF</button><button class="btn pri" data-version>${icon('save')}Save as version</button></div></div>
            ${t.hasLatex ? '' : '<p class="jh-banner">LaTeX is not on this box yet, so PDFs cannot be built. Add the Research app (Apps tab) to get it.</p>'}
            <div class="jh-sections">${t.sections.map(s => { const cur = S.choice[s.name] ?? 'base'; const v = s.variants.find(x => x.id === cur); return `<div class="jh-sec ${cur === 'off' ? 'off' : ''}">
                <div class="jh-sechead"><b>${esc(s.name)}</b><select data-sec="${esc(s.name)}" aria-label="${esc(s.name)} version">${s.variants.map(x => `<option value="${x.id}" ${cur === x.id ? 'selected' : ''}>${esc(x.label)}${x.job ? ' · for a job' : ''}${x.by && x.by !== 'phone' && x.id !== 'base' ? ' · AI' : ''}</option>`).join('')}<option value="off" ${cur === 'off' ? 'selected' : ''}>Leave out</option></select></div>
                ${v ? `<pre class="jh-tex">${esc(v.text.length > 600 ? `${v.text.slice(0, 600)}…` : v.text)}</pre>` : ''}
                <div class="jh-secact"><button class="text-btn" data-mine="${esc(s.name)}">Write my own version</button>${v && v.id !== 'base' ? `<button class="text-btn dim" data-delvar="${esc(s.name)}|${v.id}">Delete this version</button>` : ''}</div></div>`; }).join('')}</div>
            ${t.versions.length ? `<h3 class="jh-h">Saved versions</h3>${t.versions.slice().reverse().map(v => `<div class="row"><div class="main"><div class="title">${esc(v.name)}</div><div class="sub muted">${esc(v.categories.join(', ') || 'no category')} · ${ago(v.at)}</div></div>${v.pdf ? `<a class="text-btn" href="/api/jobs/cv/version/${v.id}.pdf" target="_blank" rel="noopener">PDF</a>` : ''}<a class="text-btn" href="/api/jobs/cv/version/${v.id}.tex?download=1">.tex</a><button class="text-btn" data-use="${v.id}">Load</button></div>`).join('')}` : ''}`;
    }
    html += `<h3 class="jh-h">CV files</h3><p class="note">Other CVs you keep (PDF or Word), sorted by the kind of job they are for.</p>
        ${cats.map(c => `<h4 class="jh-cat">${esc(c)}</h4>${u.cvs.filter(x => x.categories.includes(c)).map(cvRow).join('')}`).join('')}
        ${u.cvs.filter(x => !x.categories.length).map(cvRow).join('')}
        <div class="r-actions"><label class="btn">${icon('upload')}Add a CV file<input type="file" accept=".pdf,.doc,.docx,.odt,.md,.txt,.tex" data-cvfile hidden></label></div>`;
    box.innerHTML = html;
    const st = $('[data-starter]', box); if (st) st.onclick = async () => { try { await C.api('/api/jobs/cv/template', { method: 'POST', body: {} }); reload(); } catch (e) { C.toast(e.message, true); } };
    const tf = $('[data-texfile]', box); if (tf) tf.onchange = async () => { const f = tf.files[0]; if (!f) return; try { await C.api('/api/jobs/cv/template', { method: 'POST', body: { tex: await f.text(), name: f.name.replace(/\.tex$/, '') } }); reload(); } catch (e) { C.toast(e.message, true); } };
    $$('[data-sec]', box).forEach(x => x.onchange = () => { S.choice[x.dataset.sec] = x.value; renderCv(box); });
    $$('[data-mine]', box).forEach(x => x.onclick = () => variantDialog(t.sections.find(s => s.name === x.dataset.mine)));
    $$('[data-delvar]', box).forEach(x => x.onclick = async () => { const [s, id] = x.dataset.delvar.split('|'); await C.api('/api/jobs/cv/variant/delete', { method: 'POST', body: { section: s, id } }).catch(e => C.toast(e.message, true)); S.choice[s] = 'base'; renderCv(box); });
    $$('[data-use]', box).forEach(x => x.onclick = () => { const v = t.versions.find(y => y.id === x.dataset.use); S.choice = { ...Object.fromEntries(Object.entries(v.choice).map(([k, val]) => [k, val === null ? 'off' : val])) }; renderCv(box); C.toast(`Loaded "${v.name}"`); });
    const pv = $('[data-preview]', box); if (pv) pv.onclick = async () => { const w = window.open('', '_blank'); pv.disabled = true; try { const r = await C.api('/api/jobs/cv/preview', { method: 'POST', body: { choice: choice() } }); if (r.pdf) { if (w) w.location = `/api/jobs/cv/preview.pdf?t=${Date.now()}`; } else { w?.close(); C.toast(r.note || 'No PDF.', true); } } catch (e) { w?.close(); C.toast(e.message, true); } pv.disabled = false; };
    const sv = $('[data-version]', box); if (sv) sv.onclick = () => saveVersionDialog(cats);
    $$('[data-cvdef]', box).forEach(x => x.onclick = async () => { await C.api(`/api/jobs/cvs/${x.dataset.cvdef}`, { method: 'POST', body: { defaultFor: x.dataset.cat } }).catch(e => C.toast(e.message, true)); renderCv(box); });
    $$('[data-cvedit]', box).forEach(x => x.onclick = () => cvFileDialog(u.cvs.find(c => c.id === x.dataset.cvedit)));
    $('[data-cvfile]', box).onchange = async e => { const f = e.target.files[0]; if (!f) return; cvFileDialog(null, f); };
}
const choice = () => Object.fromEntries(Object.entries(S.choice).map(([k, v]) => [k, v === 'off' ? null : v]));
function cvRow(c) { const { esc } = C; return `<div class="row"><div class="main"><div class="title">${esc(c.name)}${(c.defaultFor || []).length ? ' <span class="jh-def">default</span>' : ''}</div><div class="sub muted">${esc(c.original)}${c.notes ? ` · ${esc(c.notes)}` : ''}</div></div><a class="text-btn" href="/api/jobs/cvs/${c.id}/file" target="_blank" rel="noopener">Open</a><button class="text-btn" data-cvedit="${c.id}">Edit</button></div>`; }
function cvFileDialog(cv, file) {
    const { esc, icon, $ } = C;
    const { panel, close } = C.openDialog(`<h2>${icon('file-text')}${cv ? esc(cv.name) : 'Add a CV file'}</h2>
        <div class="field"><label for="cf-n">Name</label><input id="cf-n" maxlength="120" value="${esc(cv?.name || (file?.name || '').replace(/\.[^.]+$/, ''))}"></div>
        <div class="field"><label for="cf-c">Categories (comma-separated)</label><input id="cf-c" value="${esc((cv?.categories || []).join(', '))}" placeholder="Security, Software, Graduate schemes"></div>
        <div class="field"><label for="cf-x">Notes</label><input id="cf-x" maxlength="300" value="${esc(cv?.notes || '')}" placeholder="One page, ATS-friendly"></div>
        ${cv && cv.categories.length ? `<div class="field"><label>Make it the default for</label><div class="choices wrap">${cv.categories.map(c => `<button data-def="${esc(c)}" class="${(cv.defaultFor || []).includes(c) ? 'selected' : ''}">${esc(c)}</button>`).join('')}</div></div>` : ''}
        <div class="buttons">${cv ? '<button class="danger" data-del>Delete</button>' : ''}<button data-close>Cancel</button><button class="primary" data-ok>${cv ? 'Save' : 'Add'}</button></div>`);
    $('[data-ok]', panel).onclick = async () => { try { if (cv) await C.api(`/api/jobs/cvs/${cv.id}`, { method: 'POST', body: { name: $('#cf-n', panel).value, categories: $('#cf-c', panel).value, notes: $('#cf-x', panel).value } }); else await C.api('/api/jobs/cvs', { method: 'POST', body: { name: $('#cf-n', panel).value, file: file.name, data: await b64(file), categories: $('#cf-c', panel).value, notes: $('#cf-x', panel).value } }); close(); reload(); } catch (e) { C.toast(e.message, true); } };
    panel.querySelectorAll('[data-def]').forEach(x => x.onclick = async () => { await C.api(`/api/jobs/cvs/${cv.id}`, { method: 'POST', body: { defaultFor: x.dataset.def } }).catch(e => C.toast(e.message, true)); close(); reload(); });
    const del = $('[data-del]', panel); if (del) del.onclick = async () => { close(); if (await C.confirmDialog({ title: `Delete "${cv.name}"?`, text: 'The file is removed from the box.', action: 'Delete' })) { await C.api(`/api/jobs/cvs/${cv.id}/delete`, { method: 'POST' }).catch(e => C.toast(e.message, true)); reload(); } };
}
function variantDialog(sec) {
    const { esc, icon, $ } = C; const base = sec.variants.find(v => v.id === (S.choice[sec.name] || 'base')) || sec.variants[0];
    const { panel, close } = C.openDialog(`<h2>${icon('pencil')}${esc(sec.name)}: your version</h2><p class="muted">LaTeX, in the same style as the template. Agents add suggestions here too, tagged with the job they wrote them for.</p>
        <div class="field"><label for="vr-l">Label</label><input id="vr-l" maxlength="60" placeholder="Security-focused"></div>
        <div class="field"><label for="vr-t">LaTeX</label><textarea id="vr-t" rows="14" class="mono" spellcheck="false">${esc(base.text)}</textarea></div>
        <div class="buttons"><button data-close>Cancel</button><button class="primary" data-ok>Save version</button></div>`);
    $('[data-ok]', panel).onclick = async () => { try { const v = await C.api('/api/jobs/cv/variant', { method: 'POST', body: { section: sec.name, label: $('#vr-l', panel).value || 'Mine', text: $('#vr-t', panel).value } }); S.choice[sec.name] = v.id; close(); reload(); } catch (e) { C.toast(e.message, true); } };
}
function saveVersionDialog(cats) {
    const { esc, icon, $ } = C;
    const { panel, close } = C.openDialog(`<h2>${icon('save')}Save this CV</h2><p class="muted">Keeps the sections you picked, and builds the PDF.</p>
        <div class="field"><label for="sv-n">Name</label><input id="sv-n" maxlength="80" placeholder="Security analyst, one page"></div>
        <div class="field"><label for="sv-c">Categories</label><input id="sv-c" placeholder="${esc(cats.join(', ') || 'Security, Software')}"></div>
        <div class="buttons"><button data-close>Cancel</button><button class="primary" data-ok>Save and build</button></div>`);
    $('[data-ok]', panel).onclick = async e => { e.currentTarget.disabled = true; try { const v = await C.api('/api/jobs/cv/version', { method: 'POST', body: { name: $('#sv-n', panel).value, categories: $('#sv-c', panel).value, choice: choice() } }); close(); C.toast(v.note || 'Saved and built'); reload(); } catch (x) { C.toast(x.message, true); e.currentTarget.disabled = false; } };
}

// ---------- Applications ----------
async function startApplication(j) {
    const { esc, icon, $ } = C; const u = await C.api('/api/jobs/cvs');
    const { panel, close } = C.openDialog(`<h2>${icon('folder-plus')}Apply: ${esc(j.title)}</h2><p class="muted">Makes a folder for this application (CV & Cover Letter, Application, Notes) with the advert saved in Notes, and starts tracking it.</p>
        <div class="field"><label for="sa-cv">CV file to put in it</label><select id="sa-cv"><option value="">None (make a tailored one from the template later)</option>${u.cvs.map(c => `<option value="${c.id}">${esc(c.name)}${c.categories.length ? ` · ${esc(c.categories.join(', '))}` : ''}</option>`).join('')}</select></div>
        <div class="buttons"><button data-close>Cancel</button><button class="primary" data-ok>Start</button></div>`);
    $('[data-ok]', panel).onclick = async () => { try { await C.api('/api/jobs/apps', { method: 'POST', body: { job: j.id, cv: $('#sa-cv', panel).value || null } }); close(); loadJobs('apps'); } catch (e) { C.toast(e.message, true); } };
}
async function renderApps(box) {
    const { esc, $$ } = C; const { apps } = await C.api('/api/jobs/apps'); const c = S.ov.counts; const today = new Date().toISOString().slice(0, 10);
    const order = a => (['rejected', 'withdrawn', 'accepted'].includes(a.stage) ? 2 : a.nextDate ? 0 : 1);
    apps.sort((a, b) => order(a) - order(b) || String(a.nextDate || '9').localeCompare(String(b.nextDate || '9')) || b.created - a.created);
    box.innerHTML = `<div class="jh-stats">${[['Applied', c.applied], ['In progress', c.inProgress], ['To apply', c.toApply]].map(([l, n]) => `<div><b>${n}</b><span>${l}</span></div>`).join('')}</div>
        ${apps.length ? `<div class="jh-apps">${apps.map(a => `<button class="jh-app ${a.stage}" data-app="${a.id}"><span class="n">${String(a.n).padStart(3, '0')}</span><span class="main"><span class="t">${esc(a.title)}</span><span class="s">${esc(a.company)}</span>${a.next ? `<span class="nx ${a.nextDate && a.nextDate < today ? 'late' : ''}">Next: ${esc(a.next)}${a.nextDate ? ` · ${esc(a.nextDate)}` : ''}</span>` : ''}</span><span class="stg">${STAGE_TXT[a.stage]}</span></button>`).join('')}</div>` : '<p class="note">No applications yet. Open a job on the board and start one: it gets its own folder and a place in this list.</p>'}`;
    $$('[data-app]', box).forEach(x => x.onclick = () => appDialog(apps.find(a => a.id === x.dataset.app)));
}
async function appDialog(a) {
    const { esc, icon, $ } = C; const [f, t] = await Promise.all([C.api(`/api/jobs/apps/${a.id}/files`), C.api('/api/jobs/cv')]);
    const { panel, close } = C.openDialog(`<h2>${icon('folder')}${esc(a.title)}</h2><p class="muted">${esc(a.company)} · ${esc(f.folder)}</p>
        <div class="field"><label for="ap-st">Stage</label><select id="ap-st">${S.ov.stages.map(s => `<option value="${s}" ${a.stage === s ? 'selected' : ''}>${STAGE_TXT[s]}</option>`).join('')}</select></div>
        <div class="jh-two"><div class="field"><label for="ap-nx">Next step</label><input id="ap-nx" maxlength="200" value="${esc(a.next || '')}" placeholder="Online test"></div><div class="field"><label for="ap-nd">By</label><input id="ap-nd" type="date" value="${esc(a.nextDate || '')}"></div></div>
        <div class="field"><label for="ap-no">Notes</label><textarea id="ap-no" rows="4">${esc(a.notes || '')}</textarea></div>
        <h3 class="jh-h">Files</h3>
        <div class="jh-files">${f.files.map(x => `<div>${esc(x.path)}<span class="muted"> · ${Math.max(1, Math.round(x.size / 1024))} KB</span></div>`).join('') || '<p class="muted">Empty.</p>'}</div>
        <div class="r-actions"><button class="btn" data-files>${icon('folder-open')}Open in Files</button><label class="btn">${icon('upload')}Add a file<input type="file" data-up hidden></label>${t.template ? `<button class="btn" data-tailor>${icon('file-pdf')}Put my current CV in it</button>` : ''}</div>
        <h3 class="jh-h">History</h3><div class="jh-hist">${a.history.map(h => `<div><b>${STAGE_TXT[h.stage]}</b><span class="muted"> · ${new Date(h.at).toLocaleDateString('en-GB')} · ${esc(h.by)}</span></div>`).join('')}</div>
        <div class="buttons"><button data-close>Close</button><button class="primary" data-ok>Save</button></div>`);
    $('[data-ok]', panel).onclick = async () => { try { await C.api(`/api/jobs/apps/${a.id}`, { method: 'POST', body: { stage: $('#ap-st', panel).value, next: $('#ap-nx', panel).value, nextDate: $('#ap-nd', panel).value, notes: $('#ap-no', panel).value } }); close(); reload(); } catch (e) { C.toast(e.message, true); } };
    $('[data-files]', panel).onclick = () => { close(); C.state.filesPath = f.folder; C.go('files'); };
    $('[data-up]', panel).onchange = async e => { const file = e.target.files[0]; if (!file) return; try { await C.api(`/api/jobs/apps/${a.id}/file`, { method: 'POST', body: { name: file.name, data: await b64(file), sub: /cover|cv|resume/i.test(file.name) ? 'CV & Cover Letter' : 'Application' } }); close(); appDialog(a); } catch (x) { C.toast(x.message, true); } };
    const tl = $('[data-tailor]', panel); if (tl) tl.onclick = async () => { tl.disabled = true; try { const r = await C.api(`/api/jobs/apps/${a.id}/cv`, { method: 'POST', body: { choice: choice() } }); C.toast(r.note || `Saved ${r.pdf || r.tex}`); close(); appDialog(a); } catch (x) { C.toast(x.message, true); tl.disabled = false; } };
}

// ---------- Activity ----------
async function renderLog(box) {
    const { esc } = C; const { log } = await C.api('/api/jobs/log');
    box.innerHTML = log.length ? `<div class="jh-log">${log.map(e => `<div class="jh-ev-row ${esc(e.kind)}"><span class="tm">${new Date(e.t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span><span class="by">${esc(e.by)}</span><span class="w">${esc(e.what)}${e.ms ? ` <span class="muted">(${Math.round(e.ms / 1000)} s)</span>` : ''}</span></div>`).join('')}</div>` : '<p class="note">Nothing yet.</p>';
}

// ---------- Setup ----------
async function renderSetup(box) {
    const { esc, icon, $, $$ } = C; const s = S.ov.settings; const mo = s.money || {};
    box.innerHTML = `
        <h3 class="jh-h">What to look for</h3>
        <div class="card jh-form">
          <div class="field"><label for="st-k">Keywords</label><input id="st-k" value="${esc(s.keywords)}" placeholder="security analyst"></div>
          <div class="field"><label for="st-l">Places (comma-separated)</label><input id="st-l" value="${esc(s.locations)}" placeholder="Leeds, Manchester, Bristol"></div>
          <div class="jh-two"><div class="field"><label for="st-co">Countries for Adzuna</label><input id="st-co" value="${esc(s.countries || 'gb')}" placeholder="gb, de, nl, ie"></div><div class="field"><label for="st-na">Passport(s) you hold</label><input id="st-na" value="${esc(s.nationality || '')}" placeholder="for visa advice, e.g. British"></div></div>
          <label class="jh-check"><input type="checkbox" id="st-r" ${s.remote ? 'checked' : ''}>Include remote jobs</label>
          <div class="jh-two"><div class="field"><label for="st-m">Lowest salary</label><input id="st-m" type="number" min="0" step="1000" value="${esc(s.salaryMin ?? '')}"></div><div class="field"><label for="st-x">Rule out</label><input id="st-x" value="${esc(s.exclude)}" placeholder="senior, principal"></div></div>
        </div>
        <h3 class="jh-h">Agents</h3>
        <div class="card jh-form">
          <div class="jh-two"><div class="field"><label for="st-a">Agent for wishes and advice</label><select id="st-a">${['claude', 'codex', 'cline'].map(a => `<option value="${a}" ${(s.agent || 'claude') === a ? 'selected' : ''}>${esc(C.agentTitle ? C.agentTitle(a) : a)}</option>`).join('')}</select></div><div class="field"><label for="st-mo">Model</label><input id="st-mo" value="${esc(s.model || '')}" placeholder="default (or oss:<ollama model>)"></div></div>
        </div>
        <h3 class="jh-h">Money</h3>
        <div class="card jh-form">
          <div class="jh-two"><div class="field"><label for="st-sl">Student loan</label><select id="st-sl">${[['none', 'None'], ['plan1', 'Plan 1'], ['plan2', 'Plan 2'], ['plan4', 'Plan 4 (Scotland)'], ['plan5', 'Plan 5'], ['postgrad', 'Postgraduate']].map(([k, l]) => `<option value="${k}" ${mo.studentLoan === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div class="field"><label for="st-pe">Pension (% of pay)</label><input id="st-pe" type="number" min="0" max="40" value="${esc(mo.pension ?? 5)}"></div></div>
          <div class="field"><label for="st-mn">Anything else agents should assume</label><textarea id="st-mn" rows="2" placeholder="I'd share a flat; I don't own a car">${esc(mo.notes || '')}</textarea></div>
        </div>
        <div class="r-actions"><button class="btn pri" data-save>${icon('save')}Save</button></div>
        <h3 class="jh-h">Job sites</h3>
        <p class="note">Keys are kept in the Vault. Remotive and Arbeitnow need none.</p>
        ${Object.entries(s.keys).map(([k, v]) => `<div class="card jh-key"><div class="jh-keyhead"><b>${esc(v.title)}</b><span class="${v.ready ? 'live' : 'muted'}">${v.ready ? 'ready' : v.needs.length ? 'no key' : 'ready, no key needed'}</span><label class="jh-check"><input type="checkbox" data-src="${k}" ${s.sources.includes(k) ? 'checked' : ''}>Use</label></div>
            ${v.needs.length ? `<div class="jh-keyrow">${v.needs.map(n => `<input data-key="${k}" data-env="${n}" type="password" autocomplete="off" placeholder="${esc(n)}${v.ready ? ' (saved; paste to replace)' : ''}">`).join('')}<button class="btn" data-savekey="${k}">Save</button></div>${v.signup ? `<a class="text-btn" href="${esc(v.signup)}" target="_blank" rel="noopener">Get a key</a>` : ''}` : ''}</div>`).join('')}`;
    $('[data-save]', box).onclick = async () => { try { await C.api('/api/jobs/settings', { method: 'POST', body: { keywords: $('#st-k', box).value, locations: $('#st-l', box).value, countries: $('#st-co', box).value, nationality: $('#st-na', box).value, remote: $('#st-r', box).checked, salaryMin: $('#st-m', box).value, exclude: $('#st-x', box).value, agent: $('#st-a', box).value, model: $('#st-mo', box).value, sources: $$('[data-src]', box).filter(x => x.checked).map(x => x.dataset.src), money: { studentLoan: $('#st-sl', box).value, pension: Number($('#st-pe', box).value) || 0, notes: $('#st-mn', box).value } } }); C.toast('Saved'); reload(); } catch (e) { C.toast(e.message, true); } };
    $$('[data-savekey]', box).forEach(b => b.onclick = async () => { const k = b.dataset.savekey; const values = Object.fromEntries($$(`[data-key="${k}"]`, box).map(i => [i.dataset.env, i.value.trim()]).filter(([, v]) => v)); if (!Object.keys(values).length) return C.toast('Paste the key first.', true); try { await C.api('/api/jobs/key', { method: 'POST', body: { source: k, values } }); C.toast('Saved in the Vault'); reload(); } catch (e) { C.toast(e.message, true); } });
}
