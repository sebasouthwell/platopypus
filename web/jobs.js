// Job Hunt: an AI-run job board around one person. Loaded on demand by app.js (setup(ctx) hands over its helpers).
//
// Views: Board (wish box, the jobs found, each with its fit and money), Me (a map of everything you have done, and the
// gaps jobs keep asking about), CV (your LaTeX template: swap section variants, preview, save versions; uploaded CVs),
// Applications (a folder and tracker per application), Activity, Setup (what to search, keys, money assumptions).

let C = null;
const S = { tab: 'board', ov: null, filter: 'active', sort: 'match', choice: {}, poll: null, meView: matchMedia('(min-width: 720px)').matches ? 'map' : 'list' };
const VERDICT = { meets: 'Meets', partly: 'Partly', gap: 'Gap' };
const STAGE_TXT = { preparing: 'Preparing', applied: 'Applied', assessment: 'Assessment', interview: 'Interview', final: 'Final round', offer: 'Offer', accepted: 'Accepted', rejected: 'Rejected', withdrawn: 'Withdrawn' };
const KIND_COLOR = { project: '#F0B840', role: '#6FB1F0', skill: '#3FD39A', education: '#B38CFF', cert: '#2EC4B6', achievement: '#FF7AA8', interest: '#93A4BA' };
const SYM = { GBP: '£', EUR: '€', USD: '$', CHF: 'CHF ' };
const money = (n, cur = 'GBP') => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? '–' : `${SYM[cur || 'GBP'] ?? `${cur} `}${Math.round(Number(n)).toLocaleString('en-GB')}`);
const ago = t => { const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const md = s => C.esc(s || '').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/^#{1,4} (.*)$/gm, '<h4>$1</h4>').replace(/^[-*] (.*)$/gm, '<li>$1</li>').replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`).replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n{2,}/g, '<br><br>');
const b64 = file => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => bad(new Error('Could not read the file.')); r.readAsDataURL(file); });

export function setup(ctx) { C = ctx; }
async function runAgent(url, body, msg) {
    try { const r = await C.api(url, { method: 'POST', body }); const { panel, close } = C.openDialog(`<h2>${C.icon('claude')}Started</h2><p class="muted">${C.esc(msg)}</p><div class="buttons"><button data-close>OK</button><button class="primary" data-watch>Watch it work</button></div>`, { size: 'small' }); C.$('[data-watch]', panel).onclick = () => { close(); C.openTerminal(r.shell, 'Job Hunt'); }; }
    catch (e) { C.toast(e.message, true); }
}

export async function loadJobs(tab) {
    if (tab) S.tab = tab; clearInterval(S.poll); S.poll = null;
    const { $, $$ } = C;
    S.ov = await C.api('/api/jobs');
    const c = S.ov.counts;
    const tabs = [['board', 'Jobs'], ['apps', `Applied${c.inProgress ? `<em>${c.inProgress}</em>` : ''}`], ['me', `Me${c.gaps + (c.proposed || 0) ? `<em>${c.gaps + (c.proposed || 0)}</em>` : ''}`], ['cv', 'CV'], ['cpd', 'CPD']];
    $('#jobs-seg').innerHTML = tabs.map(([k, l]) => `<button data-jt="${k}" class="${S.tab === k ? 'on' : ''}" role="tab" aria-selected="${S.tab === k}">${l}</button>`).join('');
    $$('#page-jobs .icon-btn').forEach(x => x.classList.toggle('on', (x.id === 'jobs-activity' && S.tab === 'log') || (x.id === 'jobs-setup' && S.tab === 'setup')));
    $$('#jobs-seg [data-jt]').forEach(b => b.onclick = () => loadJobs(b.dataset.jt).catch(e => C.toast(e.message, true)));
    const fn = { board: renderBoard, me: renderMe, cpd: renderCpd, cv: renderCv, apps: renderApps, log: renderLog, setup: renderSetup }[S.tab];
    await fn($('#jobs-body'));
}
const reload = () => loadJobs().catch(e => C.toast(e.message, true));

// ---------- Board ----------
async function renderBoard(box) {
    const { esc, icon, $, $$ } = C; const ov = S.ov;
    const [b, w] = await Promise.all([C.api('/api/jobs/board'), C.api('/api/jobs/wishes')]);
    const keyed = Object.entries(ov.settings.keys).filter(([, k]) => k.needs.length);
    const noKeys = keyed.every(([, k]) => !k.ready) && localStorage.getItem('jh.keysBanner') !== 'off';
    const live = w.wishes.filter(x => x.status === 'started'); const last = w.wishes.find(x => x.status !== 'started');
    const count = st => b.jobs.filter(j => (st === 'active' ? !['hidden', 'applied'].includes(j.status) : j.status === st)).length;
    const filters = [['active', 'Active'], ['new', 'New'], ['shortlisted', 'Shortlisted'], ['applying', 'Applying'], ['applied', 'Applied'], ['hidden', 'Hidden']];
    box.innerHTML = `
        <form class="jh-ask" data-wish>
          <label for="jh-wish-t" class="jh-ask-l">What job do you want?</label>
          <div class="jh-ask-row"><textarea id="jh-wish-t" rows="1" maxlength="600" placeholder="e.g. junior SOC analyst in Leeds"></textarea><button class="jh-ask-go" type="submit" aria-label="Find jobs">${icon('search')}</button></div>
          <p class="jh-ask-h">An agent sets the search, hunts job sites and the web, then scores the best against Me.</p>
        </form>
        ${live.map(x => `<div class="jh-live"><span class="dot"></span><span class="t">Working on: ${esc(x.text)}</span><button class="text-btn" data-watch="wish-${esc(x.id.slice(1))}">Watch</button></div>`).join('')}
        ${last ? `<details class="jh-last ${last.status}"><summary><span class="dot"></span><span class="t">${last.status === 'done' ? 'Latest result' : 'Last run ended'}: ${esc(last.text)}</span></summary><div class="jh-wishsum">${md(last.summary || '')}</div></details>` : ''}
        ${noKeys ? `<div class="jh-note1">${icon('key')}<span>Job-site keys (Adzuna, Reed, Jooble) find far more UK jobs.</span><button class="text-btn" data-go-setup>Add</button><button class="jh-iconbtn" data-nokeys aria-label="Dismiss">${icon('x')}</button></div>` : ''}
        ${upcomingList(ov.upcoming || [])}
        <div class="jh-chips" role="tablist" aria-label="Filter jobs">${filters.map(([k, l]) => `<button data-f="${k}" class="${S.filter === k ? 'on' : ''}" role="tab" aria-selected="${S.filter === k}">${l}<span>${count(k)}</span></button>`).join('')}</div>
        <div class="jh-bar2">
          <select data-sort aria-label="Sort">${[['match', 'Best match'], ['left', 'Most left over'], ['new', 'Newest'], ['deadline', 'Closing soonest']].map(([k, l]) => `<option value="${k}" ${S.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <button class="jh-tbtn" data-hunt title="Search the job sites">${icon('refresh')}<span>Job sites</span></button>
          <button class="jh-tbtn" data-web title="Search the web">${icon('globe')}<span>Web</span></button>
          <button class="jh-tbtn" data-add title="Add a job">${icon('plus')}<span>Add</span></button>
        </div>
        <div class="jh-jobs">${jobCards(b.jobs) || `<p class="note">${b.jobs.length ? 'Nothing here with this filter.' : 'No jobs yet. Say what you want above, or set the search in Setup and search the job sites.'}</p>`}</div>`;
    const ta = $('#jh-wish-t', box); const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`; }; ta.oninput = grow;
    ta.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('[data-wish]', box).requestSubmit(); } };
    $('[data-wish]', box).onsubmit = async e => {
        e.preventDefault(); const t = ta.value.trim(); if (!t) return ta.focus();
        try { await C.api('/api/jobs/wish', { method: 'POST', body: { text: t } }); C.toast('An agent is on it. New jobs appear here as it finds them.'); await loadJobs(); } catch (x) { C.toast(x.message, true); }
    };
    const gs = $('[data-go-setup]', box); if (gs) gs.onclick = () => loadJobs('setup');
    const nk = $('[data-nokeys]', box); if (nk) nk.onclick = () => { localStorage.setItem('jh.keysBanner', 'off'); nk.parentElement.remove(); };
    $$('[data-watch]', box).forEach(x => x.onclick = () => C.openTerminal(x.dataset.watch, 'Job Hunt').catch(e => C.toast(e.message, true)));
    $$('[data-f]', box).forEach(x => x.onclick = () => { S.filter = x.dataset.f; renderBoard(box); });
    $('[data-sort]', box).onchange = e => { S.sort = e.target.value; renderBoard(box); };
    $('[data-hunt]', box).onclick = async e => { const btn = e.currentTarget; btn.disabled = true; btn.classList.add('busy'); try { const r = await C.api('/api/jobs/hunt', { method: 'POST' }); C.toast(`${r.added} new jobs (${r.found} seen)${Object.keys(r.errors).length ? `; ${Object.keys(r.errors).join(', ')} failed` : ''}`); reload(); } catch (x) { C.toast(x.message, true); btn.disabled = false; btn.classList.remove('busy'); } };
    $('[data-web]', box).onclick = () => runAgent('/api/jobs/websearch', {}, 'An agent is searching career pages and job boards. New jobs appear here.');
    $('[data-add]', box).onclick = addJobDialog;
    $$('[data-job]', box).forEach(x => x.onclick = () => jobDialog(x.dataset.job));
    $$('[data-upjob]', box).forEach(x => x.onclick = () => jobDialog(x.dataset.upjob));
    $$('[data-upapp]', box).forEach(x => x.onclick = async () => { const { apps } = await C.api('/api/jobs/apps'); appDialog(apps.find(a => a.id === x.dataset.upapp)); });
    if (live.length) S.poll = setInterval(() => { if (S.tab === 'board' && !document.hidden && $('#dialog').hidden && document.activeElement !== ta) renderBoard(box).catch(() => {}); }, 20_000);
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
    const sc0 = j.match?.score; const tone0 = sc0 === undefined ? 'none' : sc0 >= 70 ? 'hi' : sc0 >= 45 ? 'mid' : 'lo';
    const { panel, close } = C.openDialog(`
        <header class="jh-sh"><button class="jh-iconbtn" data-close aria-label="Close">${icon('back')}</button><div class="t"><h2>${esc(j.title)}</h2><p>${esc([j.company, j.location, j.salary].filter(Boolean).join(' · '))}${j.url ? ` · <a href="${esc(j.url)}" target="_blank" rel="noopener">advert</a>` : ''}</p></div><span class="jh-fit ${tone0}" style="--v:${sc0 ?? 0}"><b>${sc0 ?? '–'}</b></span>
          <nav class="jh-secnav" aria-label="Sections">${[['project', 'Project'], ['fit', 'Fit'], ['assess', 'Assessment'], ['money', 'Money'], ['advice', 'Advice'], ...(j.description ? [['advert', 'Advert']] : []), ['notes', 'Notes']].map(([k, l]) => `<button data-sec="${k}">${l}</button>`).join('')}</nav></header>
        <div class="jh-actions jh-footbar">
          ${j.status !== 'shortlisted' ? `<button class="btn" data-st="shortlisted">${icon('pin')}Shortlist</button>` : `<button class="btn on" data-st="new">${icon('pin')}Shortlisted</button>`}
          ${['applying', 'applied'].includes(j.status) ? '' : `<button class="btn pri" data-apply>${icon('folder-plus')}Apply</button>`}
          ${j.status !== 'hidden' ? `<button class="btn jh-sq" data-st="hidden" aria-label="Hide this job" title="Hide">${icon('eye')}</button>` : `<button class="btn" data-st="new">Show again</button>`}
        </div>
        <h3 class="jh-h" id="js-project">This job as a project</h3>
        <div class="jh-stages" role="tablist">${d.plan.map((s, i) => { const n = s.items.filter(([k]) => plan.done[`${s.id}.${k}`]).length; return `<button data-stage="${s.id}" class="${s.id === cur.id ? 'on' : ''} ${n === s.items.length ? 'full' : ''}" role="tab" aria-selected="${s.id === cur.id}"><span class="i">${i + 1}</span>${esc(s.title)}<span class="c">${n}/${s.items.length}</span></button>`; }).join('')}</div>
        <div class="jh-stagebox">
          <div class="jh-checks">${cur.items.map(([k, l]) => `<label><input type="checkbox" data-item="${cur.id}.${k}" ${plan.done[`${cur.id}.${k}`] ? 'checked' : ''}>${esc(l)}</label>`).join('')}</div>
          ${cur.ai ? `<div class="jh-work"><textarea data-workx rows="2" maxlength="1500" placeholder="${cur.id === 'research' ? 'Anything to look into? e.g. I need a Skilled Worker visa' : cur.id === 'interview' ? 'What you know about the interview, e.g. 45 min video call with the team lead' : 'Anything the agent should know'}"></textarea>
            ${cur.id === 'research' ? '<div class="jh-topics"><label><input type="checkbox" data-wv>Visa and sponsorship too</label><label><input type="checkbox" data-wp>Pay and cost of living too</label></div>' : ''}
            <button class="btn pri" data-work="${cur.id}">${icon('claude')}${esc(cur.ai)}</button></div>` : '<p class="muted">Nothing for an agent here: tick things off as you do them.</p>'}
          ${['tailor', 'apply'].includes(cur.id) ? `<a class="btn" href="/letter.html?job=${esc(id)}" target="_blank" rel="noopener">${icon('pencil')}Cover letter editor</a>` : ''}
          ${d.drafts.length ? `<div class="jh-drafts">${d.drafts.map(x => `<button class="chip" data-draft="${esc(x.name)}">${icon('file-text')}${esc(x.name)}</button>`).join('')}</div>` : ''}
        </div>
        <h3 class="jh-h" id="js-fit">Fit</h3>
        ${j.match ? `<div class="jh-matchhead"><span class="jh-fit big ${j.match.score >= 70 ? 'hi' : j.match.score >= 45 ? 'mid' : 'lo'}" style="--v:${j.match.score}"><b>${j.match.score}</b></span><div>${j.match.level ? `<b>Comes in at: ${esc(j.match.level)}</b><br>` : ''}${esc(j.match.summary || '')}<div class="muted">by ${esc(j.match.by)} · ${ago(j.match.at)}</div></div></div>
            <div class="jh-lines">${j.match.lines.map(l => `<div class="jh-line ${l.verdict}"><span class="v">${VERDICT[l.verdict]}</span><div><div>${esc(l.requirement)}</div>${l.note ? `<div class="muted">${esc(l.note)}</div>` : ''}${l.evidence.length ? `<div class="jh-ev">${l.evidence.map(e => byId.get(e)).filter(Boolean).map(i => `<span style="--k:${KIND_COLOR[i.kind]}">${esc(i.title)}</span>`).join('')}</div>` : ''}</div></div>`).join('')}</div>`
            : `<p class="note">Not scored yet. ${d.candidates.length ? 'Likely evidence from Me is listed below; ' : ''}an agent scores it when it works a wish, or ask for it now.</p>${d.candidates.length ? `<div class="jh-lines">${d.candidates.map(r => `<div class="jh-line ${r.candidates.length ? 'partly' : 'gap'}"><span class="v">${r.candidates.length ? 'Maybe' : 'Nothing'}</span><div>${esc(r.requirement)}${r.candidates.length ? `<div class="jh-ev">${r.candidates.map(x => `<span style="--k:${KIND_COLOR[x.kind]}">${esc(x.title)}</span>`).join('')}</div>` : ''}</div></div>`).join('')}</div>` : ''}<div class="r-actions"><button class="btn" data-score>${icon('claude')}Score it against Me</button></div>`}
        <h3 class="jh-h" id="js-assess">How they will assess you</h3>
        ${frameworkSection(j, d)}
        <h3 class="jh-h" id="js-money">Money, per year</h3>
        <div class="jh-money">
          ${[['Gross', m?.gross ?? est?.gross], ['Take-home', m?.takeHome ?? est?.takeHome], ['Living costs', m?.living], ['Left over', m?.left]].map(([l, v], i) => `<div class="${i === 3 ? 'left' : ''}"><span>${l}</span><b>${money(v, m?.currency || 'GBP')}</b></div>`).join('')}
        </div>
        <p class="muted jh-assume">${esc(m?.assumptions || est?.assumptions || 'No figures yet: an agent works them out (tax and living costs under the rules where the job is, in its currency) when it scores the job.')}</p>
        <h3 class="jh-h" id="js-advice">Advice</h3>
        <div class="jh-advice-ask">
          <div class="jh-topics">${S.ov.advice.map(a => `<label><input type="checkbox" value="${a.tag}" ${['company', 'role'].includes(a.tag) ? 'checked' : ''}>${esc(a.title)}</label>`).join('')}</div>
          <textarea data-extra rows="2" maxlength="800" placeholder="Anything else? e.g. I would need a Skilled Worker visa; what should I say about my gap year?"></textarea>
          <button class="btn pri" data-advice>${icon('claude')}Ask for advice</button>
          <p class="muted">Each topic goes to its own agent at once (it sees only the job and the question, never Me), and searches the web.</p>
        </div>
        <div class="jh-probes">${d.advice.map(p => `<details class="jh-probe ${p.status}" ${p.status === 'done' ? '' : 'open'}><summary><span class="dot"></span>${esc(S.ov.advice.find(a => a.tag === p.tag)?.title || p.subject)}<span class="muted">${p.status === 'running' ? 'researching…' : `${esc(p.agent)} · ${ago(p.finished || p.at)}`}</span></summary><div class="jh-answer">${p.status === 'running' ? '' : md(p.answer)}</div></details>`).join('')}</div>
        ${j.description ? `<details class="jh-desc" id="js-advert"><summary>The advert</summary><div>${esc(j.description)}</div></details>` : ''}
        <div class="field" id="js-notes"><label for="jd-notes">Your notes</label><textarea id="jd-notes" rows="3">${esc(j.notes || '')}</textarea></div>
        <div class="buttons"><button class="primary" data-save>Save notes</button></div>`, { size: 'sheet' });
    { const fb = panel.querySelector('.jh-footbar'); if (fb) panel.appendChild(fb); }
    $$('[data-sec]', panel).forEach(x => x.onclick = () => { const el = panel.querySelector(`#js-${x.dataset.sec}`); if (el) { if (el.tagName === 'DETAILS') el.open = true; el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); } });
    { const secs = [...panel.querySelectorAll('[id^="js-"]')]; const io = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) $$('[data-sec]', panel).forEach(b => b.classList.toggle('on', `js-${b.dataset.sec}` === e.target.id)); }, { root: panel, rootMargin: '-120px 0px -60% 0px' }); secs.forEach(x => io.observe(x)); }
    $$('[data-stage]', panel).forEach(x => x.onclick = async () => { try { await C.api(`/api/jobs/job/${id}/plan`, { method: 'POST', body: { stage: x.dataset.stage } }); close(); jobDialog(id); } catch (e) { C.toast(e.message, true); } });
    $$('[data-item]', panel).forEach(x => x.onchange = () => C.api(`/api/jobs/job/${id}/plan`, { method: 'POST', body: { item: x.dataset.item, done: x.checked } }).catch(e => C.toast(e.message, true)));
    const wk = $('[data-work]', panel); if (wk) wk.onclick = async () => {
        wk.disabled = true;
        try { const r = await C.api(`/api/jobs/job/${id}/work`, { method: 'POST', body: { stage: wk.dataset.work, extra: $('[data-workx]', panel).value.trim(), visa: !!$('[data-wv]', panel)?.checked, pay: !!$('[data-wp]', panel)?.checked } });
            if (r.shell) { C.toast('An agent is working on it; drafts appear here when it finishes.'); close(); C.openTerminal(r.shell, 'Job Hunt'); } else { close(); jobDialog(id); } }
        catch (e) { C.toast(e.message, true); wk.disabled = false; }
    };
    $$('[data-draft]', panel).forEach(x => { if (/letter/.test(x.dataset.draft)) x.onclick = () => window.open(`/letter.html?job=${id}&name=${encodeURIComponent(x.dataset.draft)}`, '_blank', 'noopener'); });
    $$('[data-draft]', panel).filter(x => !/letter/.test(x.dataset.draft)).forEach(x => x.onclick = async () => { try { const r = await C.api(`/api/jobs/job/${id}/draft?name=${encodeURIComponent(x.dataset.draft)}`); const dd = C.openDialog(`<h2>${icon('file-text')}${esc(r.name)}</h2><div class="jh-answer jh-draft">${md(r.text)}</div><div class="buttons"><button data-copy>Copy</button><button data-close>Close</button></div>`); $('[data-copy]', dd.panel).onclick = () => navigator.clipboard.writeText(r.text).then(() => C.toast('Copied')); } catch (e) { C.toast(e.message, true); } });
    $$('[data-st]', panel).forEach(x => x.onclick = async () => { try { await C.api(`/api/jobs/job/${id}`, { method: 'POST', body: { status: x.dataset.st } }); close(); reload(); } catch (e) { C.toast(e.message, true); } });
    const ap = $('[data-apply]', panel); if (ap) ap.onclick = () => { close(); startApplication(j); };
    $('[data-save]', panel).onclick = async () => { try { await C.api(`/api/jobs/job/${id}`, { method: 'POST', body: { notes: $('#jd-notes', panel).value } }); C.toast('Saved'); } catch (e) { C.toast(e.message, true); } };
    $('[data-advice]', panel).onclick = async () => {
        const topics = $$('.jh-topics input:checked', panel).map(x => x.value); const extra = $('[data-extra]', panel).value.trim();
        if (!topics.length && !extra) return C.toast('Pick a topic or ask a question.', true);
        try { await C.api(`/api/jobs/job/${id}/advice`, { method: 'POST', body: { topics, extra } }); close(); jobDialog(id); } catch (e) { C.toast(e.message, true); }
    };
    const fa = $('[data-fassess]', panel); if (fa) fa.onclick = async () => { try { const r = await C.api(`/api/jobs/job/${id}/assess`, { method: 'POST', body: { framework: $('[data-fpick]', panel).value } }); close(); runAgentShown(r.shell, 'An agent is assessing you against the framework. A blind second assessor then rates the same elements.'); } catch (e) { C.toast(e.message, true); } };
    $$('[data-fblind]', panel).forEach(x => x.onclick = async () => { try { await C.api(`/api/jobs/job/${id}/assess`, { method: 'POST', body: { framework: x.dataset.fblind, blindOnly: true } }); C.toast('Blind review started.'); } catch (e) { C.toast(e.message, true); } });
    const sc = $('[data-score]', panel); if (sc) sc.onclick = async () => { try { await C.api('/api/jobs/wish', { method: 'POST', body: { text: `Score this one job against Me (requirements, fit, money): ${j.id} "${j.title}"${j.company ? ` at ${j.company}` : ''}. Do not hunt for others.` } }); C.toast('An agent is scoring it.'); close(); } catch (e) { C.toast(e.message, true); } };
    if (running) { const t = setInterval(async () => { if ($('#dialog').hidden || !panel.isConnected) return clearInterval(t); const n = await C.api(`/api/jobs/job/${id}`).catch(() => null); if (n && !n.advice.some(p => p.status === 'running')) { clearInterval(t); if (!$('#dialog').hidden) { close(); jobDialog(id); } } }, 8000); }
}

// ---------- Me: a map of everything you have done ----------
async function renderMe(box) {
    const { esc, icon, $, $$ } = C; const [me, dl] = await Promise.all([C.api('/api/jobs/me'), C.api('/api/jobs/docs')]); const kinds = S.ov.kinds;
    const gaps = me.gaps.filter(g => g.status === 'open'); const props = me.items.filter(i => i.status === 'proposed');
    box.innerHTML = `
        <p class="r-sub">Everything you have done, in one place: agents check every job against it, and ask you for examples when a job wants something it cannot find here.</p>
        <div class="jh-meacts"><button class="btn pri" data-talk>${icon('claude')}Talk to an agent about me</button><button class="btn" data-add>${icon('plus')}Add something</button><button class="btn" data-import>${icon('file-text')}Build from my CV</button><button class="btn" data-findme>${icon('globe')}Find me online</button>
          <div class="seg jh-meview">${[['map', 'Map'], ['list', 'List']].map(([k, l]) => `<button data-mv="${k}" class="${S.meView === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        ${props.length ? `<div class="jh-props"><h3 class="jh-h">To confirm <span class="muted">Found by agents; not used for matching until you confirm.</span></h3>${props.map(i => `<div class="jh-prop ${esc(i.confidence || 'medium')}"><div class="main"><div class="t"><span class="kdot" style="--k:${KIND_COLOR[i.kind]}"></span>${esc(i.title)}<span class="conf">${esc(i.confidence || 'medium')}</span></div><div class="muted">${esc([kinds[i.kind], i.org, i.from && `${i.from}${i.to ? `–${i.to}` : ''}`].filter(Boolean).join(' · '))}</div>${i.summary ? `<div class="s">${esc(i.summary)}</div>` : ''}${i.why ? `<div class="why">${esc(i.why)}</div>` : ''}<div class="src">${(i.sources || []).map(x => x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title || x.url.replace(/^https?:\/\//, '').slice(0, 60))}</a>` : `<span>${esc(x.title)}</span>`).join('')}</div></div><div class="acts"><button class="btn pri" data-ok-me="${i.id}">${icon('check')}It's me</button><button class="btn" data-me="${i.id}">Edit</button><button class="btn" data-no-me="${i.id}">${icon('x')}No</button></div></div>`).join('')}${props.length > 1 ? '<div class="r-actions"><button class="text-btn" data-ok-high>Confirm all high-confidence</button></div>' : ''}</div>` : ''}
        ${gaps.length ? `<div class="jh-gaps"><h3 class="jh-h">Jobs keep asking about</h3>${gaps.map(g => `<div class="jh-gap"><div class="main">${esc(g.text)}</div><button class="text-btn" data-gap="${g.id}">Answer</button><button class="text-btn dim" data-dismiss="${g.id}">Not me</button></div>`).join('')}</div>` : ''}
        ${me.items.length ? (S.meView === 'map' ? `<div class="jh-map">${meMap(me.items, kinds)}</div>` : '') : '<p class="note">Nothing here yet. The quickest start: talk to an agent about your projects and jobs, or add your CV on the CV tab and ask the agent to read it.</p>'}
        ${S.meView === 'list' || !me.items.length ? '' : '<p class="muted jh-maphint">Tap a dot to open it. Lines join related things.</p>'}
        <h3 class="jh-h">Notes</h3>
        <p class="note">Context that helps assessors: which example best shows a behaviour, what was yours in a group project, anything a CV line can't say. Levels are judged per job, so they aren't stored here.</p>
        ${(me.notes || []).map(n => `<div class="jh-note"><div class="main">${n.topic ? `<b>${esc(n.topic)}</b> ` : ''}${esc(n.text)}<div class="muted">${esc(n.by)} · ${ago(n.at)}</div></div><button class="text-btn dim" data-ndel="${n.id}" aria-label="Delete note">${icon('x')}</button></div>`).join('')}
        <div class="jh-noteadd"><input data-ntopic maxlength="80" placeholder="Topic (optional), e.g. Delivering at Pace"><textarea data-ntext rows="2" maxlength="4000" placeholder="e.g. For pace under pressure, use the CTF: I organised the team's split of 30 challenges in 48 hours"></textarea><button class="btn" data-nadd>${icon('plus')}Add note</button></div>
        <h3 class="jh-h">My documents</h3>
        <p class="note">Reports, papers, a dissertation, slides: anything that shows what you did. An agent breaks each one into the project, the skills it shows and the results, citing the page.</p>
        ${dl.docs.map(d => `<div class="row"><span class="ico">${icon('file-text')}</span><div class="main"><div class="title">${esc(d.name)}</div><div class="sub muted">${esc([d.kind, d.original, d.read ? 'read into Me' : 'not read yet'].filter(Boolean).join(' · '))}</div></div><a class="text-btn" href="/api/jobs/docs/${d.id}/file" target="_blank" rel="noopener">Open</a><button class="text-btn" data-docread="${d.id}">${d.read ? 'Read again' : 'Read into Me'}</button><button class="text-btn dim" data-docdel="${d.id}">Remove</button></div>`).join('')}
        <div class="r-actions"><label class="btn">${icon('upload')}Add documents<input type="file" multiple accept=".pdf,.docx,.odt,.pptx,.md,.txt,.tex" data-docup hidden></label></div>
        <div class="jh-melist" ${S.meView === 'map' ? 'hidden' : ''}>${Object.entries(kinds).map(([k, l]) => { const its = me.items.filter(i => i.kind === k); return its.length ? `<h3 class="jh-h" style="--k:${KIND_COLOR[k]}"><span class="kdot"></span>${esc(l)}</h3>${its.map(i => `<button class="row" data-me="${i.id}"><div class="main"><div class="title">${esc(i.title)}${i.status === 'proposed' ? ' <span class="jh-def" style="color:var(--brass);border-color:rgba(240,184,64,.4)">to confirm</span>' : ''}</div><div class="sub muted">${esc([i.org, i.from && `${i.from}${i.to ? `–${i.to}` : ''}`, i.level, (i.sources || []).length ? `${i.sources.length} source${i.sources.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '))}</div></div></button>`).join('')}` : ''; }).join('')}</div>`;
    $('[data-talk]', box).onclick = async () => { try { const r = await C.api('/api/jobs/me/interview', { method: 'POST', body: {} }); C.openTerminal(r.shell, 'Job Hunt'); } catch (e) { C.toast(e.message, true); } };
    $('[data-add]', box).onclick = () => meDialog(null, kinds);
    $('[data-import]', box).onclick = importDialog;
    $('[data-nadd]', box).onclick = async () => { const t = $('[data-ntext]', box).value.trim(); if (!t) return; try { await C.api('/api/jobs/notes', { method: 'POST', body: { text: t, topic: $('[data-ntopic]', box).value } }); renderMe(box); } catch (e) { C.toast(e.message, true); } };
    $$('[data-ndel]', box).forEach(x => x.onclick = async () => { await C.api(`/api/jobs/notes/${x.dataset.ndel}/delete`, { method: 'POST' }).catch(e => C.toast(e.message, true)); renderMe(box); });
    $('[data-docup]', box).onchange = async e => {
        const files = [...e.target.files]; if (!files.length) return; const added = [];
        for (const f of files) { try { added.push(await C.api('/api/jobs/docs', { method: 'POST', body: { name: f.name.replace(/\.[^.]+$/, ''), file: f.name, data: await b64(f) } })); } catch (x) { C.toast(`${f.name}: ${x.message}`, true); } }
        if (!added.length) return renderMe(box);
        const { panel, close } = C.openDialog(`<h2>${icon('file-text')}${added.length} document${added.length === 1 ? '' : 's'} added</h2><p class="muted">Read ${added.length === 1 ? 'it' : 'them'} into Me now? An agent breaks each one into the project, skills and results, as proposals for you to confirm.</p><div class="buttons"><button data-close>Later</button><button class="primary" data-ok>Read into Me</button></div>`, { size: 'small' });
        panel.querySelector('[data-close]').addEventListener('click', () => renderMe(box));
        $('[data-ok]', panel).onclick = async () => { close(); for (const d of added) { try { await C.api(`/api/jobs/docs/${d.id}/read`, { method: 'POST', body: {} }); } catch (x) { C.toast(x.message, true); } } C.toast(`Reading ${added.length} document${added.length === 1 ? '' : 's'}: proposals appear under "To confirm".`); renderMe(box); };
    };
    $$('[data-docread]', box).forEach(x => x.onclick = () => runAgent(`/api/jobs/docs/${x.dataset.docread}/read`, {}, 'An agent is reading the document. Its proposals appear under "To confirm".'));
    $$('[data-docdel]', box).forEach(x => x.onclick = async () => { if (await C.confirmDialog({ title: 'Remove this document?', text: 'The file is deleted from the box. Me items found in it stay.', action: 'Remove' })) { await C.api(`/api/jobs/docs/${x.dataset.docdel}/delete`, { method: 'POST' }).catch(e => C.toast(e.message, true)); renderMe(box); } });
    $('[data-findme]', box).onclick = findMeDialog;
    const verify = async (id, action) => { try { await C.api(`/api/jobs/me/${id}/${action}`, { method: 'POST' }); } catch (e) { C.toast(e.message, true); } };
    $$('[data-ok-me]', box).forEach(x => x.onclick = async () => { await verify(x.dataset.okMe, 'confirm'); renderMe(box); });
    $$('[data-no-me]', box).forEach(x => x.onclick = async () => { await verify(x.dataset.noMe, 'reject'); renderMe(box); });
    const hi = $('[data-ok-high]', box); if (hi) hi.onclick = async () => { for (const i of props.filter(p => p.confidence === 'high')) await verify(i.id, 'confirm'); renderMe(box); };
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
        svg += `<g class="leaf${it.status === 'proposed' ? ' prop' : ''}" data-me="${it.id}" tabindex="0" role="button" aria-label="${esc(it.title)}"><circle cx="${p.x}" cy="${p.y}" r="${lv}" style="fill:${KIND_COLOR[p.k]}"/><text x="${p.x + (right ? 12 : -12)}" y="${p.y + 4}" text-anchor="${right ? 'start' : 'end'}">${esc(it.title.length > 26 ? `${it.title.slice(0, 25)}…` : it.title)}</text></g>`; }
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
        ${(x.sources || []).length ? `<div class="field"><label>Sources</label><div class="jh-src">${x.sources.map(s2 => s2.url ? `<a href="${esc(s2.url)}" target="_blank" rel="noopener noreferrer">${esc(s2.title || s2.url)}</a>${s2.note ? ` <span class="muted">${esc(s2.note)}</span>` : ''}` : `<span>${esc(s2.title)}</span>`).join('<br>')}</div></div>` : ''}
        <div class="buttons">${it ? '<button class="danger" data-del>Delete</button>' : ''}<button data-close>Cancel</button><button class="primary" data-ok>${x.status === 'proposed' ? 'Save and confirm' : 'Save'}</button></div>`);
    $('[data-ok]', panel).onclick = async () => {
        try { if (x.status === 'proposed') await C.api(`/api/jobs/me/${x.id}/confirm`, { method: 'POST' }); await C.api('/api/jobs/me', { method: 'POST', body: { kind: $('#me-k', panel).value, title: $('#me-t', panel).value, org: $('#me-o', panel).value, from: $('#me-f', panel).value, to: $('#me-to', panel).value, level: $('#me-l', panel).value || undefined, summary: $('#me-s', panel).value, evidence: $('#me-e', panel).value.split('\n').map(s => s.trim()).filter(Boolean), tags: $('#me-g', panel).value, ...(all.length > 1 ? { links: [...panel.querySelectorAll('.jh-rel input:checked')].map(c => c.value) } : {}) } }); close(); reload(); } catch (e) { C.toast(e.message, true); }
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
    $$('[data-cvimport]', box).forEach(x => x.onclick = () => runAgent('/api/jobs/me/import', { cv: x.dataset.cvimport, template: !t.template }, `An agent is reading this CV${t.template ? '' : ' (and making your LaTeX template from it)'}. Its proposals appear under "To confirm" on the Me tab.`));
    $('[data-cvfile]', box).onchange = async e => { const f = e.target.files[0]; if (!f) return; cvFileDialog(null, f); };
}
const choice = () => Object.fromEntries(Object.entries(S.choice).map(([k, v]) => [k, v === 'off' ? null : v]));
function cvRow(c) { const { esc } = C; return `<div class="row"><div class="main"><div class="title">${esc(c.name)}${(c.defaultFor || []).length ? ' <span class="jh-def">default</span>' : ''}</div><div class="sub muted">${esc(c.original)}${c.notes ? ` · ${esc(c.notes)}` : ''}</div></div><a class="text-btn" href="/api/jobs/cvs/${c.id}/file" target="_blank" rel="noopener">Open</a><button class="text-btn" data-cvedit="${c.id}">Edit</button><button class="text-btn" data-cvimport="${c.id}">Read into Me</button></div>`; }
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
    const { esc, $$ } = C; const [{ apps }, { upcoming }] = await Promise.all([C.api('/api/jobs/apps'), C.api('/api/jobs/upcoming?days=90')]); const c = S.ov.counts; const today = new Date().toISOString().slice(0, 10);
    const order = a => (['rejected', 'withdrawn', 'accepted'].includes(a.stage) ? 2 : a.nextDate ? 0 : 1);
    apps.sort((a, b) => order(a) - order(b) || String(a.nextDate || '9').localeCompare(String(b.nextDate || '9')) || b.created - a.created);
    box.innerHTML = `<div class="jh-stats">${[['Applied', c.applied], ['In progress', c.inProgress], ['To apply', c.toApply]].map(([l, n]) => `<div><b>${n}</b><span>${l}</span></div>`).join('')}</div>
        ${upcomingList(upcoming)}
        ${apps.length ? `<h3 class="jh-h">Applications</h3><div class="jh-apps">${apps.map(a => { const ev = (a.events || []).filter(e => e.date && !e.done && e.date >= today).sort((x, y) => x.date.localeCompare(y.date))[0]; const files = (a.events || []).reduce((n, e) => n + (e.files || []).length, 0); return `<button class="jh-app ${a.stage}" data-app="${a.id}"><span class="n">${String(a.n).padStart(3, '0')}</span><span class="main"><span class="t">${esc(a.title)}</span><span class="s">${esc(a.company)}</span>${ev ? `<span class="nx">${esc(S.ov.eventTypes[ev.type])}${ev.title ? `: ${esc(ev.title)}` : ''} · ${esc(ev.date)}</span>` : a.next ? `<span class="nx ${a.nextDate && a.nextDate < today ? 'late' : ''}">Next: ${esc(a.next)}${a.nextDate ? ` · ${esc(a.nextDate)}` : ''}</span>` : ''}</span><span class="stg">${STAGE_TXT[a.stage]}${(a.events || []).length ? `<br><span class="muted">${a.events.length} entr${a.events.length === 1 ? 'y' : 'ies'}${files ? ` · ${files} file${files === 1 ? '' : 's'}` : ''}</span>` : ''}</span></button>`; }).join('')}</div>` : '<p class="note">No applications yet. Open a job on the board and start one: it gets its own folder, a timeline for notes, tests, interviews and screenshots, and a place in this list.</p>'}`;
    $$('[data-app]', box).forEach(x => x.onclick = () => appDialog(apps.find(a => a.id === x.dataset.app)));
    $$('[data-upapp]', box).forEach(x => x.onclick = () => appDialog(apps.find(a => a.id === x.dataset.upapp)));
    $$('[data-upjob]', box).forEach(x => x.onclick = () => jobDialog(x.dataset.upjob));
}
function upcomingList(list) {
    const { esc } = C; if (!list.length) return '';
    const fmt = d => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    return `<h3 class="jh-h">Coming up</h3><div class="jh-up">${list.map(u => `<button class="jh-upi ${u.late ? 'late' : ''}" ${u.app ? `data-upapp="${u.app}"` : `data-upjob="${u.job}"`}><span class="d">${fmt(u.date)}${u.time ? ` ${esc(u.time)}` : ''}</span><span class="w">${esc(u.what)}</span><span class="o">${esc(u.title)}${u.company ? ` · ${esc(u.company)}` : ''}</span></button>`).join('')}</div>`;
}
const IMG = /\.(png|jpe?g|gif|webp)$/i;
async function appDialog(a0) {
    const { esc, icon, $, $$ } = C;
    const [{ apps }, f, t] = await Promise.all([C.api('/api/jobs/apps'), C.api(`/api/jobs/apps/${a0.id}/files`), C.api('/api/jobs/cv')]);
    const a = apps.find(x => x.id === a0.id) || a0; const types = S.ov.eventTypes; const today = new Date().toISOString().slice(0, 10);
    const fileUrl = rel => `/api/jobs/apps/${a.id}/file?path=${encodeURIComponent(rel)}`;
    const fileChip = rel => IMG.test(rel) ? `<a class="jh-thumb" href="${fileUrl(rel)}" target="_blank" rel="noopener"><img src="${fileUrl(rel)}" alt="${esc(rel)}" loading="lazy"></a>` : `<a class="chip" href="${fileUrl(rel)}" target="_blank" rel="noopener">${icon('file')}${esc(rel.split('/').pop())}</a>`;
    const events = (a.events || []).slice().sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')) || y.created - x.created);
    const attached = new Set(events.flatMap(e => e.files || []));
    const loose = f.files.filter(x => !attached.has(x.path));
    const { panel, close } = C.openDialog(`<header class="jh-sh"><button class="jh-iconbtn" data-close aria-label="Close">${icon('back')}</button><div class="t"><h2>${esc(a.title)}</h2><p>${esc(a.company)} · ${STAGE_TXT[a.stage]}</p></div></header><p class="muted jh-path">${esc(f.folder)}</p>
        <div class="jh-two"><div class="field"><label for="ap-st">Stage</label><select id="ap-st">${S.ov.stages.map(s => `<option value="${s}" ${a.stage === s ? 'selected' : ''}>${STAGE_TXT[s]}</option>`).join('')}</select></div><div class="field"><label for="ap-pr">Priority</label><select id="ap-pr">${['low', 'normal', 'high'].map(p => `<option ${a.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div></div>
        <div class="jh-two"><div class="field"><label for="ap-nx">Next step</label><input id="ap-nx" maxlength="200" value="${esc(a.next || '')}" placeholder="Online test"></div><div class="field"><label for="ap-nd">By</label><input id="ap-nd" type="date" value="${esc(a.nextDate || '')}"></div></div>
        <div class="field"><label for="ap-no">Notes</label><textarea id="ap-no" rows="3">${esc(a.notes || '')}</textarea></div>
        <div class="buttons"><button class="primary" data-ok>Save</button></div>
        <h3 class="jh-h">Timeline</h3>
        <div class="jh-addev">
          <div class="jh-two"><select data-et aria-label="Type">${Object.entries(types).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select><input data-ed type="date" aria-label="Date" value="${today}"></div>
          <input data-ett maxlength="200" placeholder="Title, e.g. Numerical reasoning test, or First interview with the team lead">
          <textarea data-etx rows="2" placeholder="Details, what happened, what to prepare"></textarea>
          <div class="jh-evbar"><label class="btn">${icon('upload')}Attach<input type="file" multiple data-ef hidden></label><span class="muted" data-efn>You can also paste a screenshot here.</span><button class="btn pri" data-eadd>${icon('plus')}Add</button></div>
        </div>
        <div class="jh-tl">${events.map(e => `<div class="jh-ev ${e.type} ${e.done ? 'done' : ''} ${e.date && e.date < today && !e.done && ['test', 'interview', 'deadline'].includes(e.type) ? 'late' : ''}">
            <div class="jh-evh"><span class="ty">${esc(types[e.type] || e.type)}</span><b>${esc(e.title || '')}</b><span class="dt">${esc(e.date || '')}${e.time ? ` ${esc(e.time)}` : ''}</span>
              ${['test', 'interview', 'deadline', 'call'].includes(e.type) ? `<label class="jh-done"><input type="checkbox" data-edone="${e.id}" ${e.done ? 'checked' : ''}>done</label>` : ''}<button class="text-btn dim" data-edel="${e.id}" aria-label="Delete entry">${icon('x')}</button></div>
            ${e.text ? `<div class="tx">${esc(e.text)}</div>` : ''}
            ${(e.files || []).length ? `<div class="jh-files2">${e.files.map(fileChip).join('')}</div>` : ''}
            <label class="text-btn jh-evattach">Attach<input type="file" multiple data-eatt="${e.id}" hidden></label>
          </div>`).join('') || '<p class="muted">Nothing yet. Add notes, tests, interviews and deadlines as they happen, and paste screenshots of each stage.</p>'}</div>
        <h3 class="jh-h">Folder</h3>
        <div class="jh-files2">${loose.map(x => fileChip(x.path)).join('') || '<span class="muted">No other files.</span>'}</div>
        <div class="r-actions"><button class="btn" data-files>${icon('folder-open')}Open in Files</button><label class="btn">${icon('upload')}Add files<input type="file" multiple data-up hidden></label>${t.template ? `<button class="btn" data-tailor>${icon('file-pdf')}Put my current CV in it</button>` : ''}</div>
        <h3 class="jh-h">Stage history</h3><div class="jh-hist">${a.history.map(h => `<div><b>${STAGE_TXT[h.stage]}</b><span class="muted"> · ${new Date(h.at).toLocaleDateString('en-GB')} · ${esc(h.by)}</span></div>`).join('')}</div>
        <div class="buttons"><button data-close>Close</button></div>`, { size: 'sheet' });
    const reopen = () => { close(); appDialog(a); };
    const stageFolder = () => `Stages/${STAGE_TXT[$('#ap-st', panel).value] || 'Other'}`;
    const upload = async (file, sub, event = null) => C.api(`/api/jobs/apps/${a.id}/file`, { method: 'POST', body: { name: file.name || `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`, data: await b64(file), sub, event } });
    let pending = [];
    const showPending = () => { $('[data-efn]', panel).textContent = pending.length ? pending.map(x => x.name || 'screenshot.png').join(', ') : 'You can also paste a screenshot here.'; };
    $('[data-ef]', panel).onchange = e => { pending = [...pending, ...e.target.files]; showPending(); };
    panel.addEventListener('paste', e => { const imgs = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/')).map(i => { const fl = i.getAsFile(); return new File([fl], `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`, { type: fl.type }); }); if (!imgs.length) return; e.preventDefault(); pending = [...pending, ...imgs]; showPending(); if (!$('[data-ett]', panel).value) $('[data-ett]', panel).value = 'Screenshot'; });
    $('[data-eadd]', panel).onclick = async () => {
        const b = $('[data-eadd]', panel); b.disabled = true;
        try { const e = await C.api(`/api/jobs/apps/${a.id}/event`, { method: 'POST', body: { type: $('[data-et]', panel).value, date: $('[data-ed]', panel).value, title: $('[data-ett]', panel).value, text: $('[data-etx]', panel).value, stage: $('#ap-st', panel).value } }); for (const fl of pending) await upload(fl, stageFolder(), e.id); reopen(); }
        catch (x) { C.toast(x.message, true); b.disabled = false; }
    };
    $$('[data-eatt]', panel).forEach(x => x.onchange = async ev => { try { for (const fl of ev.target.files) await upload(fl, stageFolder(), x.dataset.eatt); reopen(); } catch (e) { C.toast(e.message, true); } });
    $$('[data-edone]', panel).forEach(x => x.onchange = () => C.api(`/api/jobs/apps/${a.id}/event`, { method: 'POST', body: { id: x.dataset.edone, done: x.checked } }).catch(e => C.toast(e.message, true)));
    $$('[data-edel]', panel).forEach(x => x.onclick = async () => { await C.api(`/api/jobs/apps/${a.id}/event/${x.dataset.edel}/delete`, { method: 'POST' }).catch(e => C.toast(e.message, true)); reopen(); });
    $('[data-ok]', panel).onclick = async () => { try { await C.api(`/api/jobs/apps/${a.id}`, { method: 'POST', body: { stage: $('#ap-st', panel).value, priority: $('#ap-pr', panel).value, next: $('#ap-nx', panel).value, nextDate: $('#ap-nd', panel).value, notes: $('#ap-no', panel).value } }); C.toast('Saved'); } catch (e) { C.toast(e.message, true); } };
    $('[data-files]', panel).onclick = () => { close(); C.state.filesPath = f.folder; C.go('files'); };
    $('[data-up]', panel).onchange = async e => { try { for (const fl of e.target.files) await upload(fl, /cover|cv|resume/i.test(fl.name) ? 'CV & Cover Letter' : 'Application'); reopen(); } catch (x) { C.toast(x.message, true); } };
    const tl = $('[data-tailor]', panel); if (tl) tl.onclick = async () => { tl.disabled = true; try { const r = await C.api(`/api/jobs/apps/${a.id}/cv`, { method: 'POST', body: { choice: choice() } }); C.toast(r.note || `Saved ${r.pdf || r.tex}`); reopen(); } catch (x) { C.toast(x.message, true); tl.disabled = false; } };
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
          <div class="jh-two"><div class="field"><label for="st-a">Agent for wishes and advice</label><select id="st-a">${['claude', 'codex', 'cline', 'antigravity'].map(a => `<option value="${a}" ${(s.agent || 'claude') === a ? 'selected' : ''}>${esc(C.agentTitle ? C.agentTitle(a) : a)}</option>`).join('')}</select></div><div class="field"><label for="st-mo">Model</label><input id="st-mo" value="${esc(s.model || '')}" placeholder="default (or oss:<ollama model>)"></div></div>
        </div>
        <div class="card jh-form" style="margin-top:8px"><label class="jh-check"><input type="checkbox" id="st-ac" ${s.autoCpd === false ? '' : 'checked'}>Update Me from my CPD log by itself (when 5+ entries are new, at most once a day)</label><label class="jh-check"><input type="checkbox" id="st-aa" ${s.autoAssess === false ? '' : 'checked'}>Assess new jobs that use a framework (Civil Service, SFIA…) automatically</label><div class="field"><label for="st-ad">At most this many agent assessments a day (reused ones are free)</label><input id="st-ad" type="number" min="0" max="50" value="${esc(s.autoAssessPerDay ?? 6)}"></div></div>
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
    $('[data-save]', box).onclick = async () => { try { await C.api('/api/jobs/settings', { method: 'POST', body: { keywords: $('#st-k', box).value, locations: $('#st-l', box).value, countries: $('#st-co', box).value, nationality: $('#st-na', box).value, remote: $('#st-r', box).checked, salaryMin: $('#st-m', box).value, exclude: $('#st-x', box).value, agent: $('#st-a', box).value, model: $('#st-mo', box).value, autoAssess: $('#st-aa', box).checked, autoCpd: $('#st-ac', box).checked, autoAssessPerDay: Number($('#st-ad', box).value), sources: $$('[data-src]', box).filter(x => x.checked).map(x => x.dataset.src), money: { studentLoan: $('#st-sl', box).value, pension: Number($('#st-pe', box).value) || 0, notes: $('#st-mn', box).value } } }); C.toast('Saved'); reload(); } catch (e) { C.toast(e.message, true); } };
    $$('[data-savekey]', box).forEach(b => b.onclick = async () => { const k = b.dataset.savekey; const values = Object.fromEntries($$(`[data-key="${k}"]`, box).map(i => [i.dataset.env, i.value.trim()]).filter(([, v]) => v)); if (!Object.keys(values).length) return C.toast('Paste the key first.', true); try { await C.api('/api/jobs/key', { method: 'POST', body: { source: k, values } }); C.toast('Saved in the Vault'); reload(); } catch (e) { C.toast(e.message, true); } });
}

// Read a CV file into Me (as proposals), optionally making the LaTeX template from it.
async function importDialog() {
    const { esc, icon, $ } = C; const [u, t] = await Promise.all([C.api('/api/jobs/cvs'), C.api('/api/jobs/cv')]);
    if (!u.cvs.length) { C.toast('Add your CV file on the CV tab first.', true); return loadJobs('cv'); }
    const { panel, close } = C.openDialog(`<h2>${icon('file-text')}Build Me from my CV</h2><p class="muted">An agent reads the CV and proposes each project, job, qualification and skill in it. You confirm them here.</p>
        <div class="field"><label for="im-cv">CV file</label><select id="im-cv">${u.cvs.map(c => `<option value="${c.id}">${esc(c.name)} · ${esc(c.original)}</option>`).join('')}</select></div>
        ${t.template ? '' : '<label class="jh-check"><input type="checkbox" id="im-tpl" checked>Also make my LaTeX CV template from it</label>'}
        <div class="buttons"><button data-close>Cancel</button><button class="primary" data-ok>Start</button></div>`);
    $('[data-ok]', panel).onclick = () => { close(); runAgent('/api/jobs/me/import', { cv: $('#im-cv', panel).value, template: !!$('#im-tpl', panel)?.checked }, 'An agent is reading your CV. Its proposals appear under "To confirm" on the Me tab.'); };
}
// Like a Conspiracy probe, aimed at your own public work: sourced proposals you confirm.
function findMeDialog() {
    const { icon, $ } = C;
    const { panel, close } = C.openDialog(`<h2>${icon('globe')}Find me online</h2><p class="muted">An agent searches for your public work (code, projects, publications, talks, awards, articles), using only what you give here. Every find comes with its sources and how sure it is that it's you, and you confirm each one. It doesn't collect private details.</p>
        <div class="field"><label for="fm-n">Your name, as it appears publicly</label><input id="fm-n" maxlength="120"></div>
        <div class="field"><label for="fm-l">Your profiles and links (one per line)</label><textarea id="fm-l" rows="3" placeholder="https://github.com/you&#10;https://your-site.example"></textarea></div>
        <div class="field"><label for="fm-h">Hints: where you studied or worked, topics</label><textarea id="fm-h" rows="2" placeholder="Computer Science, 2021–2025; security; Splunk"></textarea></div>
        <div class="buttons"><button data-close>Cancel</button><button class="primary" data-ok>Search</button></div>`);
    $('[data-ok]', panel).onclick = () => { const name = $('#fm-n', panel).value.trim(); if (!name) return C.toast('Give your name.', true); close(); runAgent('/api/jobs/me/findme', { name, links: $('#fm-l', panel).value, hints: $('#fm-h', panel).value }, 'An agent is looking for your public work. Finds appear under "To confirm" on the Me tab, each with sources.'); };
}

function runAgentShown(shell, msg) { const { panel, close } = C.openDialog(`<h2>${C.icon('claude')}Started</h2><p class="muted">${C.esc(msg)}</p><div class="buttons"><button data-close>OK</button><button class="primary" data-watch>Watch it work</button></div>`, { size: 'small' }); C.$('[data-watch]', panel).onclick = () => { close(); C.openTerminal(shell, 'Job Hunt'); }; }
// The framework the employer uses, the assessment element by element, and the blind second assessor's levels beside it.
function frameworkSection(j, d) {
    const { esc, icon } = C; const det = d.detected || []; const all = d.frameworks || [];
    const pick = `<select data-fpick aria-label="Framework"><option value="">Detect it for me${det[0] ? ` (looks like ${esc(det[0].title)})` : ''}</option>${all.map(f => `<option value="${f.id}">${esc(f.title)}</option>`).join('')}</select>`;
    const tables = (j.assess || []).map(a => {
        const f = all.find(x => x.id === a.framework); const sc = f?.scale || {}; const name = v => (v === null || v === undefined ? '–' : `${v}${sc[v] && String(sc[v]) !== String(v) ? ` <span class="muted">${esc(String(sc[v]).replace(/^\d+\s*/, ''))}</span>` : ''}`);
        const stale = d.meVersion && a.meVersion && a.meVersion !== d.meVersion; const blind = a.blind; const bstate = !blind ? (Date.now() - a.at > 15 * 60_000 ? `<span class="flagtxt">blind review did not finish</span> <button class="text-btn" data-fblind="${a.framework}">Retry</button>` : '<span class="muted">blind review running…</span>') : blind.status === 'done' ? `<span class="muted">blind: ${esc(blind.by)}</span>` : `<span class="flagtxt">blind review ${esc(blind.status)}</span> <button class="text-btn" data-fblind="${a.framework}">Retry</button>`;
        return `<div class="jh-fw"><div class="jh-fwh"><b>${esc(a.title)}</b>${a.target ? `<span class="tg">${esc(a.target)}</span>` : ''}${stale ? '<span class="flagtxt">Me has changed since: assess again</span>' : ''}${a.reusedFrom ? '<span class="muted">reused</span>' : ''}${bstate}</div>
          ${a.summary ? `<p class="jh-fws">${esc(a.summary)}</p>` : ''}
          <table class="jh-fwt"><thead><tr><th>Element</th><th>Needs</th><th>Assessor</th><th>Blind</th></tr></thead><tbody>${a.elements.map(e => `<tr class="${e.flag ? 'flag' : ''}" title="${esc(e.rationale || '')}"><td>${esc(e.name)}${e.kind ? ` <span class="muted">${esc(e.kind)}</span>` : ''}${e.rationale ? `<div class="why">${esc(e.rationale)}</div>` : ''}</td><td>${esc(e.required ?? '–')}</td><td>${name(e.level)}</td><td>${name(e.blind)}${e.flag ? ' <span class="flagtxt">differs</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`;
    }).join('');
    return `${tables}<div class="jh-fwask">${pick}<button class="btn" data-fassess>${icon('shield')}${(j.assess || []).length ? 'Assess again' : 'Assess me like they will'}</button></div>
        <p class="muted">Levels are judged for this job's framework, grade and advert only. Many employers score you against a published framework (Civil Service Success Profiles, SFIA, DDaT and others). An agent assesses you the same way from your confirmed evidence, then a blind assessor rates the same elements without seeing the job or the first scores. Elements where they differ by 2 or more need a clearer example.</p>`;
}

// ---------- CPD log ----------
async function renderCpd(box) {
    const { esc, icon, $, $$ } = C; const [{ entries, types }, me] = await Promise.all([C.api('/api/jobs/cpd'), C.api('/api/jobs/me')]);
    const today = new Date().toISOString().slice(0, 10); const projects = me.items.filter(i => ['project', 'role', 'education'].includes(i.kind) && i.status !== 'proposed');
    const fresh = entries.filter(e => !e.processed).length; const hours = entries.reduce((n, e) => n + (e.hours || 0), 0);
    const days = new Set(entries.map(e => e.date)); let streak = 0; for (let d = new Date(); days.has(d.toISOString().slice(0, 10)); d.setDate(d.getDate() - 1)) streak++;
    const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10); const yearHours = entries.filter(e => e.date >= yearAgo).reduce((n, e) => n + (e.hours || 0), 0);
    const byWeek = new Map(); for (const e of entries.slice().sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created)) { const d = new Date(`${e.date}T12:00:00`); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); const k = d.toISOString().slice(0, 10); if (!byWeek.has(k)) byWeek.set(k, []); byWeek.get(k).push(e); }
    box.innerHTML = `
        <form class="jh-wish" data-cpd>
          <label for="cp-t">What did you do or learn today?</label>
          <textarea id="cp-t" rows="3" maxlength="6000" placeholder="e.g. Wrote a Sigma rule for suspicious PowerShell; learned how to test it against the Splunk lab; found that encoded commands evade my first version"></textarea>
          <div class="jh-cprow">
            <input id="cp-d" type="date" value="${today}" aria-label="Date">
            <select id="cp-y" aria-label="Type">${Object.entries(types).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
            <input id="cp-p" list="cp-pl" maxlength="160" placeholder="Project (optional)" aria-label="Project"><datalist id="cp-pl">${projects.map(p => `<option value="${esc(p.title)}">`).join('')}</datalist>
            <input id="cp-h" type="number" min="0" step="0.25" placeholder="Hours" aria-label="Hours">
            <input id="cp-g" maxlength="200" placeholder="Tags, comma-separated" aria-label="Tags">
            <button class="btn pri" type="submit">${icon('plus')}Log it</button>
          </div>
        </form>
        <div class="jh-stats">${[['Entries', entries.length], ['Day streak', streak], ['Hours, 12 months', Math.round(yearHours * 10) / 10], ['Hours in total', Math.round(hours * 10) / 10], ['Not yet in Me', fresh]].map(([l, n]) => `<div><b>${n}</b><span>${l}</span></div>`).join('')}</div>
        <div class="r-actions"><button class="btn" data-cpdup ${fresh ? '' : 'disabled'}>${icon('claude')}Update Me from my log${fresh ? ` (${fresh} new)` : ''}</button><a class="btn" href="/api/jobs/cpd.csv">${icon('download')}Export CSV</a></div>
        <p class="note">New entries feed Me: an agent turns them into new skills, fresh evidence for your projects and notes, as proposals you confirm. Once 5 or more are new it does this by itself (at most once a day; the switch is in Setup). A changed Me marks job assessments for re-checking.</p>
        ${[...byWeek].map(([wk, es]) => `<h3 class="jh-h">Week of ${new Date(`${wk}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}<span class="muted"> · ${es.reduce((n, e) => n + (e.hours || 0), 0) || '–'} h</span></h3>${es.map(e => `<div class="jh-cpd ${e.processed ? '' : 'new'}"><div class="m"><div class="h"><span class="d">${new Date(`${e.date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })}</span><span class="ty">${esc(types[e.type] || e.type)}</span>${e.project ? `<span class="pj">${esc(e.project)}</span>` : ''}${e.hours ? `<span class="hr">${e.hours} h</span>` : ''}${e.processed ? '' : '<span class="nw">new</span>'}</div><div class="tx">${esc(e.text)}</div>${(e.tags || []).length ? `<div class="tg">${e.tags.map(t => `#${esc(t)}`).join(' ')}</div>` : ''}</div><button class="text-btn dim" data-cpddel="${e.id}" aria-label="Delete entry">${icon('x')}</button></div>`).join('')}`).join('') || '<p class="note">Nothing logged yet. A line a day is enough: what you worked on, what you found out, what you got better at.</p>'}`;
    $('[data-cpd]', box).onsubmit = async ev => {
        ev.preventDefault(); const t = $('#cp-t', box).value.trim(); if (!t) return; const pj = $('#cp-p', box).value.trim();
        try { await C.api('/api/jobs/cpd', { method: 'POST', body: { text: t, date: $('#cp-d', box).value, type: $('#cp-y', box).value, project: pj, meId: projects.find(p => p.title === pj)?.id, hours: $('#cp-h', box).value, tags: $('#cp-g', box).value } }); renderCpd(box); } catch (x) { C.toast(x.message, true); }
    };
    $('[data-cpdup]', box).onclick = () => runAgent('/api/jobs/cpd/update', {}, 'An agent is reading your new log entries into Me. Its proposals appear under "To confirm" on the Me tab.');
    $$('[data-cpddel]', box).forEach(x => x.onclick = async () => { if (await C.confirmDialog({ title: 'Delete this entry?', text: 'It is removed from the log. Anything already added to Me stays.', action: 'Delete' })) { await C.api(`/api/jobs/cpd/${x.dataset.cpddel}/delete`, { method: 'POST' }).catch(e => C.toast(e.message, true)); renderCpd(box); } });
}
