// Conspiracy: rabbit-hole investigations. Loaded on demand by app.js (setup(ctx) hands over its helpers).
//
// A case has seven views: Briefing (the question, what is new, open questions, theories, probes, the report), Board
// (the pinboard: paper cards on a dark board, joined by red strings whose dash says how well they are supported),
// Timeline, Evidence (sources), Theories (competing explanations weighed against the evidence), Notes and Agent.

let C = null;   // helpers from app.js
const S = { slug: null, tab: 'briefing', data: null, sel: null, focus: 1, lens: 'all', hidden: new Set(), pathPick: null, paths: null, view: null, poll: null, reveal: new Set() };

export const TYPE = {
    person: { label: 'Person', color: '#F0B840', glyph: 'P' }, org: { label: 'Company', color: '#3DD68C', glyph: 'C' }, gov: { label: 'Public body', color: '#6FA8FF', glyph: 'G' },
    asset: { label: 'Asset', color: '#B38CFF', glyph: 'A' }, wallet: { label: 'Wallet', color: '#2EC4B6', glyph: 'W' }, money: { label: 'Money', color: '#F28C38', glyph: '£' },
    deal: { label: 'Deal', color: '#FF7AA8', glyph: 'D' }, document: { label: 'Document', color: '#A7B4C8', glyph: 'F' }, event: { label: 'Event', color: '#C8E06C', glyph: 'E' },
    address: { label: 'Address', color: '#9AA7B8', glyph: '⌂' }, claim: { label: 'Claim', color: '#F46A5C', glyph: '?' },
};
// Ready questions for a probe, by card type. {x} is the card's name.
const DIG = {
    person: ['Which public roles has {x} held, with dates?', 'Which companies list {x} as a director, officer or person with significant control, with appointment and resignation dates?', 'What has {x} declared in registers of interests, gifts or hospitality?', 'Which political donations has {x} given or received, according to official records?', 'What reputable reporting raises questions about {x}\'s business dealings, and what was the response?'],
    org: ['Who are the officers and persons with significant control of {x}, past and present, with dates?', 'What does {x}\'s latest filed accounts say about revenue, profit, related-party transactions and ultimate owner?', 'Which public contracts has {x} won, from which bodies, for how much, and when?', 'Which other companies share {x}\'s registered address or officers?', 'Is {x} part of a group? Who is the ultimate parent, and in which jurisdiction?'],
    gov: ['Which contracts above £1m has {x} awarded in the last five years, to whom, and by which procedure?', 'Who are {x}\'s senior decision-makers, and what interests have they declared?', 'What have audits or watchdogs reported about {x}\'s procurement or spending?'],
    asset: ['Who are the largest holders of {x} according to the latest filings?', 'What insider buying or selling of {x} was filed in the last 12 months?', 'What unusual price or volume moves did {x} have, and what news or filings came just before them?', 'What material events, deals or regulatory actions involve {x}?'],
    wallet: ['What do public block explorers show for {x}: first and last activity, total received and sent?', 'Which addresses or entities did {x} send the most funds to and receive the most from? Are any labelled (exchanges, mixers, known services)?', 'Is {x} linked in public reporting or analytics labels to a known project, person in a public role, or incident?'],
    money: ['What records show the payment {x}: who paid, who received, how much, when, and for what?'],
    deal: ['Who were the parties, advisers and financiers in {x}, and what were the terms?', 'What happened just before and after {x}: share moves, appointments, donations, filings?', 'Was {x} scrutinised by regulators, auditors or courts, and with what outcome?'],
    document: ['What does {x} say, who filed or published it, and when? Summarise the key facts with page references.'],
    event: ['What is on the public record about {x}: who attended, when, where, and what was decided?'],
    address: ['Which companies are or were registered at {x}, with their officers and dates, according to company registers?'],
    claim: ['What evidence supports and what evidence contradicts the claim: {x}? Cite primary sources where possible.'],
};
const STRENGTH_TXT = { documented: 'Documented', reported: 'Reported', alleged: 'Alleged' };
const REL_TXT = { primary: 'Primary record', reputable: 'Reputable reporting', other: 'Other' };
const fmtAmt = (a, c) => { if (a === null || a === undefined || a === '') return ''; const n = Math.abs(a); const s = n >= 1e9 ? `${(a / 1e9).toFixed(1)}bn` : n >= 1e6 ? `${(a / 1e6).toFixed(1)}m` : n >= 1e3 ? `${Math.round(a / 1e3)}k` : String(a); const sym = { GBP: '£', USD: '$', EUR: '€' }[c] || ''; return sym ? `${sym}${s}` : `${s}${c ? ` ${c}` : ''}`; };
const seenKey = slug => `plato.case.seen.${slug}`;

export function setup(ctx) { C = ctx; }

// ---------- the list ----------
export async function loadCases() {
    const { esc, icon, $, $$ } = C; const d = await C.api('/api/cases'); const box = $('#cases-body');
    box.innerHTML = `<p class="r-sub">Follow the big questions down the rabbit hole: who is tied to whom, where the money went, why a deal or a market move happened. Everything on a case's board cites its source.</p>
        ${d.cases.map(c => { const seen = Number(localStorage.getItem(seenKey(c.slug)) || 0); return `<button class="row cs-row" data-case="${esc(c.slug)}"><span class="ico brass">${icon('search')}</span><div class="main"><div class="title">${esc(c.title)}</div><div class="sub">${c.question ? `${esc(c.question)} · ` : ''}${c.nodes} cards · ${c.links} strings · ${c.sources} sources${c.open ? ` · ${c.open} open` : ''}${!seen ? ' · not opened yet' : ''}</div></div>${icon('chevron', 'i chev')}</button>`; }).join('')}
        <button class="r-new" data-new-case><span class="ico brass">${icon('plus')}</span>New case</button>
        <p class="note">For research and journalism on people in public roles, organisations, markets and on-chain activity. Cases do not collect private individuals' personal details; addresses come only from public records and homes are masked.</p>`;
    $$('[data-case]', box).forEach(b => b.onclick = () => openCase(b.dataset.case, 'briefing'));
    $('[data-new-case]', box).onclick = () => newCaseDialog(d.kinds);
}
function newCaseDialog(kinds) {
    const { esc, icon, $ } = C;
    const { panel, close } = C.openDialog(`<h2>${icon('search')}New case</h2>
        <div class="field"><label for="nc-title">Name</label><input id="nc-title" type="text" maxlength="100" placeholder="Hospital contracts 2020–2023"></div>
        <div class="field"><label for="nc-q">The big question</label><textarea id="nc-q" rows="3" maxlength="600" placeholder="Did the firms that won the hospital contracts have ties to the people who awarded them?"></textarea></div>
        <div class="field"><label for="nc-kind">Kind of trail</label><select id="nc-kind">${Object.entries(kinds).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
        <p class="muted">Ask it as a question the public record can answer. The agent looks for evidence against each theory as well as for it.</p>
        <div class="buttons"><button data-close>Cancel</button><button class="primary" data-ok>${icon('plus')}Open the case</button></div>`);
    const make = async () => { try { const c = await C.api('/api/cases', { method: 'POST', body: { title: $('#nc-title', panel).value, question: $('#nc-q', panel).value, kind: $('#nc-kind', panel).value } }); close(); openCase(c.slug, 'board'); } catch (ex) { C.toast(ex.message, true); } };
    $('[data-ok]', panel).onclick = make;
}

// ---------- a case ----------
export function openCase(slug, tab) {
    if (S.slug !== slug) { S.sel = null; S.paths = null; S.pathPick = null; S.view = null; S.hidden = new Set(); S.lens = 'all'; S.reveal = new Set(); }
    S.slug = slug; if (tab) S.tab = tab; C.push('case'); loadCase().catch(e => C.toast(e.message, true));
}
export async function loadCase({ quiet = false } = {}) {
    const { $, $$, esc } = C; const enc = encodeURIComponent(S.slug);
    const d = await C.api(`/api/cases/${enc}`); const prev = S.data; S.data = d;
    if (!quiet || !prev) {
        S.lastSeen = Number(localStorage.getItem(seenKey(S.slug)) || 0);
        localStorage.setItem(seenKey(S.slug), String(Date.now()));
    }
    $('#case-title').textContent = d.title;
    const running = d.probes.filter(p => p.status === 'running').length + (d.asks || []).filter(a => a.status === 'running').length;
    const moneyN = d.board.links.filter(l => l.amount !== null && l.amount !== undefined).length;
    const tabs = [['briefing', 'Briefing'], ['board', `Board<em>${d.nodes}</em>`], ['timeline', 'Timeline'], ['money', `Money${moneyN ? `<em>${moneyN}</em>` : ''}`], ['evidence', `Evidence${d.sources ? `<em>${d.sources}</em>` : ''}`], ['theories', `Theories${d.board.theories.length ? `<em>${d.board.theories.length}</em>` : ''}`], ['ask', 'Ask'], ['notes', 'Notes'], ['agent', `Agent${running ? '<em>●</em>' : ''}`]];
    $('#case-seg').innerHTML = tabs.map(([k, l]) => `<button data-ct="${k}" class="${S.tab === k ? 'on' : ''}" role="tab" aria-selected="${S.tab === k}">${l}</button>`).join('');
    $$('#case-seg [data-ct]').forEach(b => b.onclick = () => { S.tab = b.dataset.ct; loadCase().catch(x => C.toast(x.message, true)); });
    document.getElementById('page-case').classList.toggle('case-boardmode', S.tab === 'board');
    const body = $('#case-body');
    // A quiet refresh of the board keeps the view and only redraws what changed.
    if (quiet && S.tab === 'board' && $('.pb-wrap', body)) drawBoard(body, true);
    else if (quiet && (S.tab === 'notes' || S.tab === 'theories' || (S.tab === 'ask' && document.activeElement?.id === 'ask-q' && document.activeElement.value))) { /* do not disturb typing */ }
    else ({ briefing: renderBriefing, board: renderBoard, timeline: renderTimeline, money: renderMoney, evidence: renderEvidence, theories: renderTheories, ask: renderAsk, notes: renderNotes, agent: renderAgent })[S.tab](body);
    clearTimeout(S.poll);
    const agentHere = (C.state.shells || []).some(s => String(s.cwd || '').includes(`/Cases/${S.slug}`));
    if (running || agentHere) S.poll = setTimeout(() => { if (!document.getElementById('page-case').hidden && S.slug === d.slug) loadCase({ quiet: true }).catch(() => {}); }, running ? 4000 : 8000);
    void esc;
}
const nodeById = id => S.data.board.nodes.find(n => n.id === id);
const nodeName = n => !n ? '?' : (n.type === 'address' && n.residential && !S.reveal.has(n.id) ? 'Residential address' : n.label);
const srcById = id => S.data.board.sources.find(s => s.id === id);

// ---------- Briefing ----------
function renderBriefing(body) {
    const { esc, icon, $, $$ } = C; const d = S.data; const b = d.board; const enc = encodeURIComponent(S.slug);
    const since = S.lastSeen || 0;
    const fresh = since ? [...b.nodes.map(n => ({ at: n.at, by: n.by, html: `pinned <b>${esc(nodeName(n))}</b> (${esc(TYPE[n.type]?.label || n.type)})` })), ...b.links.map(l => ({ at: l.at, by: l.by, html: `strung <b>${esc(nodeName(nodeById(l.from)))}</b> → ${esc(l.label)} → <b>${esc(nodeName(nodeById(l.to)))}</b> <span class="cs-str ${l.strength}">${l.strength}</span>` })), ...b.sources.map(s => ({ at: s.at, by: s.by, html: `added source ${esc(s.id)}: ${esc(s.title)}` })), ...d.probes.filter(p => p.finished).map(p => ({ at: p.finished, by: p.by, html: `probe ${esc(p.id)} on <b>${esc(p.subject)}</b> came back${p.status === 'failed' ? ' (failed)' : ''}` }))].filter(x => x.at > since).sort((x, y) => y.at - x.at) : [];
    const open = b.questions.filter(q => q.status === 'open'); const answered = b.questions.filter(q => q.status === 'answered');
    const running = d.probes.filter(p => p.status === 'running');
    const tally = t => { const v = Object.values(t.evidence); return { f: v.filter(x => x === 'supports').length, a: v.filter(x => x === 'contradicts').length }; };
    body.innerHTML = `<div class="cs-brief">
        <div class="cs-q card"><div class="cs-q-label">The question</div><p class="cs-q-text">${d.question ? esc(d.question) : '<span class="muted">Not set yet.</span>'}</p>
            <div class="cs-stats"><span><b>${d.nodes}</b> cards</span><span><b>${d.links}</b> strings</span><span><b>${d.sources}</b> sources</span><span><b>${d.probes.length}</b> of ${d.budget} probes</span><span>depth <b>${d.depth}</b></span></div>
            <div class="r-actions"><button class="btn" data-edit-q>${icon('pencil')}Edit question and limits</button><button class="btn" data-report>${icon('download')}Report (Markdown)</button><button class="btn" data-print>${icon('file-text')}Printable report</button></div></div>
        ${since ? `<h2 class="section">New since you last looked</h2>${fresh.length ? `<div class="list cs-feed">${fresh.slice(0, 14).map(x => `<div class="row"><div class="main"><div class="sub" style="white-space:normal;color:var(--foam)">${x.html}</div><div class="sub">${esc(String(x.by || '').replace(/^shell /, 'agent '))} · ${new Date(x.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div></div></div>`).join('')}</div>` : '<p class="empty">Nothing new.</p>'}` : ''}
        ${running.length ? `<h2 class="section">Probes out now</h2><div class="list">${running.map(p => `<div class="row"><span class="dotlive" style="margin:0 6px"></span><div class="main"><div class="title">${esc(p.subject)}</div><div class="sub" style="white-space:normal">${esc(p.question)}</div></div></div>`).join('')}</div>` : ''}
        <h2 class="section">Theories</h2>
        ${b.theories.length ? `<div class="list">${b.theories.map(t => { const x = tally(t); const tot = Math.max(1, x.f + x.a); return `<button class="row" data-go-theories><div class="main"><div class="title" style="white-space:normal">${esc(t.text)}</div><div class="cs-meter"><span class="f" style="width:${(x.f / tot) * 100}%"></span><span class="a" style="width:${(x.a / tot) * 100}%"></span></div><div class="sub">${x.f} for · ${x.a} against</div></div></button>`; }).join('')}</div>` : '<p class="empty">No theories yet. Add competing explanations on the Theories page, and weigh the evidence against each.</p>'}
        <h2 class="section">Open questions${open.length ? ` · ${open.length}` : ''}</h2>
        <div class="list">${open.map(q => `<div class="row"><div class="main"><div class="title" style="white-space:normal">${esc(q.text)}</div>${q.node ? `<div class="sub">about ${esc(nodeName(nodeById(q.node)))}</div>` : ''}</div><button class="text-btn" data-answer="${esc(q.id)}">Answer</button></div>`).join('') || '<div class="row"><div class="main"><div class="sub">None open.</div></div></div>'}</div>
        <div class="cs-addq"><input id="cs-newq" type="text" maxlength="400" placeholder="Add an open question"><button class="btn" data-addq>${icon('plus')}Add</button></div>
        ${answered.length ? `<details class="app-what"><summary>Answered · ${answered.length}</summary>${answered.map(q => `<p><b>${esc(q.text)}</b><br>${esc(q.answer)}</p>`).join('')}</details>` : ''}
        <h2 class="section">Probes · ${d.probes.length}</h2>
        ${d.probes.length ? `<div class="list">${d.probes.slice(0, 30).map(p => `<button class="row" data-probe="${esc(p.id)}"><span class="cs-pst ${p.status}"></span><div class="main"><div class="title">${esc(p.subject)}</div><div class="sub" style="white-space:normal">${esc(p.question.slice(0, 160))}</div></div>${C.icon('chevron', 'i chev')}</button>`).join('')}</div>` : '<p class="empty">No probes yet. Open a card on the Board and tap Dig, or let the agent send them.</p>'}
    </div>`;
    $('[data-edit-q]', body).onclick = () => editMeta();
    $('[data-report]', body).onclick = () => { location.href = `/api/cases/${enc}/export`; };
    $('[data-print]', body).onclick = () => printReport();
    $$('[data-go-theories]', body).forEach(x => x.onclick = () => { S.tab = 'theories'; loadCase(); });
    $$('[data-probe]', body).forEach(x => x.onclick = () => probeDialog(x.dataset.probe));
    const addq = async () => { const v = $('#cs-newq', body).value.trim(); if (!v) return; try { await C.api(`/api/cases/${enc}/questions`, { method: 'POST', body: { text: v } }); loadCase(); } catch (ex) { C.toast(ex.message, true); } };
    $('[data-addq]', body).onclick = addq; $('#cs-newq', body).onkeydown = e => { if (e.key === 'Enter') addq(); };
    $$('[data-answer]', body).forEach(x => x.onclick = () => {
        const q = b.questions.find(y => y.id === x.dataset.answer);
        const { panel, close } = C.openDialog(`<h2>${esc(q.text)}</h2><div class="field"><label for="qa-a">Answer</label><textarea id="qa-a" rows="5">${esc(q.answer || '')}</textarea></div><div class="field"><label for="qa-s">Sources (for example S2, S5)</label><input id="qa-s" type="text" value="${esc((q.sources || []).join(', '))}"></div><div class="buttons"><button data-drop>Drop it</button><button data-close>Cancel</button><button class="primary" data-ok>Save answer</button></div>`);
        $('[data-ok]', panel).onclick = async () => { try { await C.api(`/api/cases/${enc}/questions/${q.id}`, { method: 'PUT', body: { answer: $('#qa-a', panel).value, sources: $('#qa-s', panel).value } }); close(); loadCase(); } catch (ex) { C.toast(ex.message, true); } };
        $('[data-drop]', panel).onclick = async () => { try { await C.api(`/api/cases/${enc}/questions/${q.id}`, { method: 'PUT', body: { status: 'dropped' } }); close(); loadCase(); } catch (ex) { C.toast(ex.message, true); } };
    });
}
function editMeta() {
    const { esc, icon, $ } = C; const d = S.data; const enc = encodeURIComponent(S.slug);
    const { panel, close } = C.openDialog(`<h2>${icon('pencil')}The case</h2>
        <div class="field"><label for="cm-t">Name</label><input id="cm-t" type="text" maxlength="100" value="${esc(d.title)}"></div>
        <div class="field"><label for="cm-q">The big question</label><textarea id="cm-q" rows="3" maxlength="600">${esc(d.question)}</textarea></div>
        <div class="sc-two"><div class="field"><label for="cm-d">Depth (links from the start)</label><input id="cm-d" type="number" min="1" max="8" value="${d.depth}"></div><div class="field"><label for="cm-b">Probe budget</label><input id="cm-b" type="number" min="0" max="1000" value="${d.budget}"></div></div>
        <p class="note">Agents stay within the depth and stop asking new probes when the budget is used (${d.probes.length} so far).</p>
        <div class="buttons"><button data-close>Cancel</button><button class="primary" data-ok>${icon('check')}Save</button></div>`);
    $('[data-ok]', panel).onclick = async () => { try { await C.api(`/api/cases/${enc}`, { method: 'PUT', body: { title: $('#cm-t', panel).value, question: $('#cm-q', panel).value, depth: $('#cm-d', panel).value, budget: $('#cm-b', panel).value } }); close(); loadCase(); } catch (ex) { C.toast(ex.message, true); } };
}
function probeDialog(pid) {
    const { esc, icon, $, $$ } = C; const p = S.data.probes.find(x => x.id === pid); const enc = encodeURIComponent(S.slug); if (!p) return;
    const urls = [...new Set((p.answer || '').match(/https?:\/\/[^\s)\]>"'`]+/g) || [])].map(u => u.replace(/[.,;:]+$/, '')).filter(u => !S.data.board.sources.some(s => s.url === u)).slice(0, 25);
    const { panel, close } = C.openDialog(`<h2>${icon('search')}${esc(p.subject)}</h2>
        <p class="note">${esc(p.question)}<br>${p.agent === 'claude' ? 'Claude' : 'Cline'}${p.web ? ' with web search' : ''}, zero trust: it saw only this subject and question. ${p.status === 'running' ? 'Still running.' : ''}</p>
        <pre class="sc-log cs-answer">${esc(p.answer || '…')}</pre>
        ${urls.length ? `<div class="ka-label">Add its links as sources</div><div class="cs-urls">${urls.map((u, i) => `<label class="chk-row"><input type="checkbox" data-u="${i}" checked> <span class="mono">${esc(u)}</span></label>`).join('')}</div>
            <div class="field"><label for="pr-rel">Reliability</label><select id="pr-rel"><option value="other">Other (check them)</option><option value="reputable">Reputable reporting</option><option value="primary">Primary records</option></select></div>` : ''}
        <div class="buttons"><button data-close>Close</button>${urls.length ? `<button class="primary" data-addsrc>${icon('plus')}Add ${urls.length === 1 ? 'source' : 'sources'}</button>` : ''}</div>`);
    const add = $('[data-addsrc]', panel); if (add) add.onclick = async () => {
        const pick = $$('[data-u]', panel).filter(x => x.checked).map(x => urls[Number(x.dataset.u)]); const rel = $('#pr-rel', panel).value; let n = 0;
        for (const u of pick) { try { let host = u; try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { /* keep */ } await C.api(`/api/cases/${enc}/sources`, { method: 'POST', body: { title: `${host}: from probe ${p.id} on ${p.subject}`, url: u, publisher: host, reliability: rel } }); n++; } catch (ex) { C.toast(ex.message, true); break; } }
        close(); C.toast(`${n} source${n === 1 ? '' : 's'} added`); loadCase();
    };
}

// ---------- Board ----------
function renderBoard(body) {
    const { icon, esc } = C;
    body.innerHTML = `<div class="pb-wrap" tabindex="0" aria-label="Case pinboard">
            <div class="pb-world"><svg class="pb-strings" aria-hidden="true"></svg><div class="pb-cards"></div></div>
            <div class="pb-empty" hidden><p>The board is empty. Pin the first card: the person, company, asset or wallet the question starts from.</p><button class="btn pri" data-add>${icon('plus')}Pin a card</button></div>
        </div>
        <div class="pb-bar">
            <div class="pb-lens" role="group" aria-label="Lens">${[['all', 'All'], ['money', 'Follow the money'], ['documented', 'Documented only']].map(([k, l]) => `<button data-lens="${k}" class="${S.lens === k ? 'on' : ''}">${l}</button>`).join('')}<button data-types class="${S.hidden.size ? 'on' : ''}">Types${S.hidden.size ? ` · ${Object.keys(TYPE).length - S.hidden.size}` : ''}</button></div>
            <div class="pb-tools"><button class="icon-btn" data-path title="Find the chains between two cards" aria-label="Find path">${icon('link')}</button><button class="icon-btn" data-tidy title="Tidy the board" aria-label="Tidy">${icon('refresh')}</button><button class="icon-btn" data-zout aria-label="Zoom out">−</button><button class="icon-btn" data-zin aria-label="Zoom in">+</button><button class="icon-btn" data-fit title="Fit everything" aria-label="Fit">${icon('eye')}</button><button class="icon-btn accent" data-add aria-label="Pin a card">${icon('plus')}</button></div>
        </div>
        <div class="pb-pathbar" ${S.pathPick ? '' : 'hidden'}></div>
        <aside class="pb-drawer" hidden></aside>`;
    const q = s => body.querySelector(s);
    body.querySelectorAll('[data-add]').forEach(b => b.onclick = () => cardDialog(null));
    body.querySelectorAll('[data-lens]').forEach(b => b.onclick = () => { S.lens = b.dataset.lens; body.querySelectorAll('[data-lens]').forEach(x => x.classList.toggle('on', x === b)); drawBoard(body, true); });
    q('[data-types]').onclick = () => typesDialog(body);
    q('[data-path]').onclick = () => { S.pathPick = S.pathPick ? null : { a: null }; S.paths = null; if (S.pathPick) { S.sel = null; closeDrawer(body); } pathBar(body); drawBoard(body, true); };
    q('[data-tidy]').onclick = () => tidy(body);
    q('[data-zin]').onclick = () => zoomBy(body, 1.25); q('[data-zout]').onclick = () => zoomBy(body, 0.8); q('[data-fit]').onclick = () => fit(body);
    bindPanZoom(body);
    sizeBoard(body); if (!S.onResize) { S.onResize = () => { const bd = document.querySelector('#case-body'); if (bd && bd.querySelector('.pb-wrap')) sizeBoard(bd); }; window.addEventListener('resize', S.onResize); }
    drawBoard(body, false);
    if (S.sel) openDrawer(body, S.sel);
    pathBar(body); void esc;
}
// Positions: saved ones, else a quick force layout seeded from the ids, so the same board always lays out the same.
function layout(nodes, links, keepSaved = true) {
    const pos = new Map(); const hash = s => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };
    const free = nodes.filter(n => !(keepSaved && Number.isFinite(n.x)));
    nodes.forEach((n, i) => { if (keepSaved && Number.isFinite(n.x)) pos.set(n.id, { x: n.x, y: n.y, fixed: true }); else { const a = hash(n.id) * Math.PI * 2, r = 220 + 260 * hash(n.id + 'r') + i * 6; pos.set(n.id, { x: Math.cos(a) * r, y: Math.sin(a) * r, fixed: false }); } });
    if (!free.length) return pos;
    const seenPair = new Set(); const E = links.filter(l => { const k = [l.from, l.to].sort().join('|'); if (!pos.has(l.from) || !pos.has(l.to) || seenPair.has(k)) return false; seenPair.add(k); return true; }); const K = 220;   // each pair pulls once, however many strings join it
    for (let it = 0; it < 220; it++) {
        const t = 40 * (1 - it / 220) + 2; const disp = new Map(nodes.map(n => [n.id, { x: 0, y: 0 }]));
        for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
            const p = pos.get(nodes[i].id), r = pos.get(nodes[j].id); let dx = p.x - r.x, dy = p.y - r.y; let dd = Math.hypot(dx, dy) || 0.1; if (dd > 900) continue;
            const f = (K * K) / dd; dx /= dd; dy /= dd; const a = disp.get(nodes[i].id), b = disp.get(nodes[j].id); a.x += dx * f; a.y += dy * f; b.x -= dx * f; b.y -= dy * f;
        }
        for (const l of E) { const p = pos.get(l.from), r = pos.get(l.to); let dx = p.x - r.x, dy = p.y - r.y; const dd = Math.hypot(dx, dy) || 0.1; const f = (dd * dd) / K; dx /= dd; dy /= dd; const a = disp.get(l.from), b = disp.get(l.to); a.x -= dx * f; a.y -= dy * f; b.x += dx * f; b.y += dy * f; }
        for (const n of nodes) { const p = pos.get(n.id); if (p.fixed) continue; const v = disp.get(n.id); const m = Math.hypot(v.x, v.y) || 1; p.x += (v.x / m) * Math.min(m, t); p.y += (v.y / m) * Math.min(m, t); p.y += (0 - p.y) * 0.004; p.x += (0 - p.x) * 0.002; }
    }
    // Cards are boxes, not points: push apart any two that overlap (with room for a string label between them).
    const GW = CARD_W + 70, GH = CARD_H + 50;
    for (let pass = 0; pass < 80; pass++) {
        let moved = false;
        for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
            const p = pos.get(nodes[i].id), r = pos.get(nodes[j].id); if (p.fixed && r.fixed) continue;
            const dx = r.x - p.x, dy = r.y - p.y; const ox = GW - Math.abs(dx), oy = GH - Math.abs(dy); if (ox <= 0 || oy <= 0) continue;
            moved = true; const share = p.fixed || r.fixed ? 1 : 0.5;
            if (ox / GW < oy / GH) { const m = (ox + 1) * Math.sign(dx || 1) * share; if (!p.fixed) p.x -= m; if (!r.fixed) r.x += m; }
            else { const m = (oy + 1) * Math.sign(dy || 1) * share; if (!p.fixed) p.y -= m; if (!r.fixed) r.y += m; }
        }
        if (!moved) break;
    }
    return pos;
}
const CARD_W = 176, CARD_H = 92;
function visibleSets() {
    const b = S.data.board; let links = b.links;
    if (S.lens === 'money') links = links.filter(l => { const a = nodeById(l.from), c = nodeById(l.to); return (l.amount !== null && l.amount !== undefined) || ['money', 'deal', 'wallet', 'asset'].includes(a?.type) || ['money', 'deal', 'wallet', 'asset'].includes(c?.type) || /paid|pay|fund|loan|donat|bought|sold|invest|transfer|sent|received|contract|fee|share/i.test(l.label); });
    if (S.lens === 'documented') links = links.filter(l => l.strength === 'documented');
    let nodes = b.nodes.filter(n => !S.hidden.has(n.type));
    if (S.lens !== 'all') { const keep = new Set(links.flatMap(l => [l.from, l.to])); nodes = nodes.filter(n => keep.has(n.id) || n.origin); }
    const ids = new Set(nodes.map(n => n.id)); links = links.filter(l => ids.has(l.from) && ids.has(l.to));
    return { nodes, links };
}
// Strings sharing the same two cards fan out instead of lying on top of each other: a sideways bend per string.
function bends(links) {
    const groups = new Map(); for (const l of links) { const k = [l.from, l.to].sort().join('|'); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
    // b: the sideways bend; t: where along the string its label sits (staggered, so labels of one pair do not stack).
    const out = new Map(); for (const g of groups.values()) g.forEach((l, i) => { const o = i - (g.length - 1) / 2; out.set(l.id, { b: g.length === 1 ? 0 : o * 80 * (l.from < l.to ? 1 : -1), t: g.length === 1 ? 0.5 : Math.min(0.8, Math.max(0.2, 0.5 + o * 0.28)) }); });
    return out;
}
const qpt = (a, k, c, t) => ({ x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * k.x + t * t * c.x, y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * k.y + t * t * c.y });
function ctrl(a, c, bend) { const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2; const dx = c.x - a.x, dy = c.y - a.y; const len = Math.hypot(dx, dy) || 1; const sag = Math.min(40, len * 0.08); return { x: mx - (dy / len) * bend, y: my + (dx / len) * bend + (bend ? 0 : sag) }; }
function neighbours(id, hops) { const out = new Set([id]); let edge = [id]; for (let h = 0; h < hops; h++) { const next = []; for (const l of S.data.board.links) { if (edge.includes(l.from) && !out.has(l.to)) { out.add(l.to); next.push(l.to); } if (edge.includes(l.to) && !out.has(l.from)) { out.add(l.from); next.push(l.from); } } edge = next; } return out; }
function drawBoard(body, keepView) {
    const { esc } = C; const wrap = body.querySelector('.pb-wrap'); if (!wrap) return;
    const { nodes, links } = visibleSets(); const pos = layout(nodes, links); S.pos = pos;
    body.querySelector('.pb-empty').hidden = S.data.board.nodes.length > 0;
    const focus = S.sel ? neighbours(S.sel, S.focus) : null;
    const pathLinks = new Set((S.paths?.paths || []).flat()); const pathNodes = new Set(); if (S.paths) { for (const id of pathLinks) { const l = S.data.board.links.find(x => x.id === id); if (l) { pathNodes.add(l.from); pathNodes.add(l.to); } } }
    const dim = id => (S.paths ? !pathNodes.has(id) : focus ? !focus.has(id) : false);
    const depth = S.data.depths || {};
    body.querySelector('.pb-cards').innerHTML = nodes.map(n => { const p = pos.get(n.id); const t = TYPE[n.type] || TYPE.claim; const masked = n.type === 'address' && n.residential && !S.reveal.has(n.id);
        return `<div class="pb-card st-${n.status}${S.sel === n.id ? ' sel' : ''}${dim(n.id) ? ' dim' : ''}${n.origin ? ' origin' : ''}${S.pathPick && (S.pathPick.a === n.id) ? ' pick' : ''}" data-n="${n.id}" style="left:${p.x - CARD_W / 2}px;top:${p.y - CARD_H / 2}px;--tc:${t.color}" role="button" tabindex="0" aria-label="${esc(t.label)}: ${esc(nodeName(n))}">
            <span class="pb-pin"></span><div class="pb-type"><span class="pb-glyph">${esc(t.glyph)}</span>${esc(t.label)}${n.origin ? '<b class="pb-start">Start</b>' : depth[n.id] !== undefined ? `<span class="pb-depth">${depth[n.id]}</span>` : ''}</div>
            <div class="pb-label${masked ? ' masked' : ''}">${esc(nodeName(n))}</div>
            <div class="pb-meta">${n.sources.length ? `${n.sources.length} source${n.sources.length === 1 ? '' : 's'}` : '<span class="pb-nosrc">no source</span>'}${n.when ? ` · ${esc(n.when)}` : ''}${n.status !== 'lead' ? ` · ${esc(n.status)}` : ''}</div></div>`; }).join('');
    const svg = body.querySelector('.pb-strings'); const bd = bends(links); S.bends = bd;
    svg.innerHTML = links.map(l => { const a = pos.get(l.from), c = pos.get(l.to); if (!a || !c) return ''; const bt = bd.get(l.id) || { b: 0, t: 0.5 }; const k = ctrl(a, c, bt.b); const mx = k.x, my = k.y; const lp = qpt(a, k, c, bt.t);   // a little sag, like string, or a sideways bend for a second string
        const on = pathLinks.has(l.id); const off = S.paths ? !on : focus ? !(focus.has(l.from) && focus.has(l.to)) : false; const money = S.lens === 'money';
        const amt = fmtAmt(l.amount, l.currency);
        return `<g class="pb-s ${l.strength}${on ? ' path' : ''}${off ? ' dim' : ''}${money ? ' money' : ''}" data-l="${l.id}"><path d="M${a.x},${a.y} Q${mx},${my} ${c.x},${c.y}" /><path class="hit" d="M${a.x},${a.y} Q${mx},${my} ${c.x},${c.y}" />
            <g class="pb-tag" transform="translate(${lp.x},${lp.y})"><rect x="-4" y="-11" rx="6" height="20" width="${Math.min(200, (l.label.length + (amt ? amt.length + 3 : 0)) * 6.4 + 10)}" transform="translate(${-Math.min(200, (l.label.length + (amt ? amt.length + 3 : 0)) * 6.4 + 10) / 2 + 4},0)"/><text text-anchor="middle" y="3">${esc(l.label.length > 30 ? l.label.slice(0, 29) + '…' : l.label)}${amt ? ` · ${esc(amt)}` : ''}</text></g></g>`; }).join('');
    // cards: tap to open, drag to move
    body.querySelectorAll('.pb-card').forEach(el => bindCard(body, el));
    svg.querySelectorAll('.pb-s').forEach(g => g.onclick = e => { e.stopPropagation(); linkDialog(g.dataset.l); });
    if (!keepView || !S.view) fit(body); else applyView(body);
}
// The board fills the screen below it, leaving room for its toolbar (and the tab bar on a phone).
function sizeBoard(body) {
    const w = body.querySelector('.pb-wrap'); if (!w) return; const top = w.getBoundingClientRect().top; const phone = innerWidth < 720;
    w.style.height = `${Math.max(320, innerHeight - top - (phone ? 150 : 76))}px`;
    const dr = body.querySelector('.pb-drawer'); if (dr && !phone) dr.style.maxHeight = w.style.height;
}
function applyView(body) { const w = body.querySelector('.pb-world'); if (w && S.view) w.style.transform = `translate(${S.view.x}px,${S.view.y}px) scale(${S.view.k})`; body.querySelector('.pb-wrap')?.classList.toggle('far', S.view?.k < 0.55); }
function fit(body) {
    const wrap = body.querySelector('.pb-wrap'); const r = wrap.getBoundingClientRect(); const ps = [...(S.pos || new Map()).values()];
    if (!ps.length) { S.view = { x: r.width / 2, y: r.height / 2, k: 1 }; return applyView(body); }
    const minx = Math.min(...ps.map(p => p.x)) - CARD_W, maxx = Math.max(...ps.map(p => p.x)) + CARD_W, miny = Math.min(...ps.map(p => p.y)) - CARD_H, maxy = Math.max(...ps.map(p => p.y)) + CARD_H;
    const k = Math.max(0.35, Math.min(1.1, Math.min(r.width / (maxx - minx), r.height / (maxy - miny))));
    S.view = { k, x: r.width / 2 - ((minx + maxx) / 2) * k, y: r.height / 2 - ((miny + maxy) / 2) * k }; applyView(body);
}
function zoomBy(body, f, cx, cy) {
    const r = body.querySelector('.pb-wrap').getBoundingClientRect(); if (cx === undefined) { cx = r.width / 2; cy = r.height / 2; }
    const v = S.view || { x: 0, y: 0, k: 1 }; const k = Math.max(0.2, Math.min(2.5, v.k * f)); const wx = (cx - v.x) / v.k, wy = (cy - v.y) / v.k;
    S.view = { k, x: cx - wx * k, y: cy - wy * k }; applyView(body);
}
function bindPanZoom(body) {
    const wrap = body.querySelector('.pb-wrap'); const pts = new Map(); let start = null;
    wrap.addEventListener('wheel', e => { e.preventDefault(); const r = wrap.getBoundingClientRect(); zoomBy(body, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    wrap.addEventListener('pointerdown', e => {
        if (e.target.closest('.pb-card, .pb-s, .pb-empty')) return;
        wrap.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        start = { view: { ...(S.view || { x: 0, y: 0, k: 1 }) }, pts: new Map([...pts].map(([k, v]) => [k, { ...v }])), moved: false };
    });
    wrap.addEventListener('pointermove', e => {
        if (!pts.has(e.pointerId) || !start) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const r = wrap.getBoundingClientRect();
        if (pts.size === 1) { const [id, p] = [...pts][0]; const s0 = start.pts.get(id); if (!s0) return; const dx = p.x - s0.x, dy = p.y - s0.y; if (Math.hypot(dx, dy) > 3) start.moved = true; S.view = { ...start.view, x: start.view.x + dx, y: start.view.y + dy }; applyView(body); }
        else if (pts.size === 2) {
            const [a, b] = [...pts.values()]; const [a0, b0] = [...start.pts.values()]; if (!a0 || !b0) return; start.moved = true;
            const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1, d1 = Math.hypot(b.x - a.x, b.y - a.y); const k = Math.max(0.2, Math.min(2.5, start.view.k * d1 / d0));
            const c0 = { x: (a0.x + b0.x) / 2 - r.left, y: (a0.y + b0.y) / 2 - r.top }, c1 = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
            const wx = (c0.x - start.view.x) / start.view.k, wy = (c0.y - start.view.y) / start.view.k; S.view = { k, x: c1.x - wx * k, y: c1.y - wy * k }; applyView(body);
        }
    });
    const end = e => { if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId); if (!pts.size) { if (start && !start.moved && !S.pathPick) { S.sel = null; closeDrawer(body); drawBoard(body, true); } start = null; } else start = { view: { ...S.view }, pts: new Map([...pts].map(([k, v]) => [k, { ...v }])), moved: true }; };
    wrap.addEventListener('pointerup', end); wrap.addEventListener('pointercancel', end);
    wrap.addEventListener('keydown', e => { if (e.key === '+' || e.key === '=') zoomBy(body, 1.2); else if (e.key === '-') zoomBy(body, 0.83); });
    // Escape anywhere on the board page: close the card, leave path mode.
    if (!S.onKey) { S.onKey = e => { if (e.key !== 'Escape' || S.tab !== 'board' || document.getElementById('page-case').hidden || !document.getElementById('dialog').hidden) return; const bd = document.querySelector('#case-body'); if (!bd?.querySelector('.pb-wrap')) return; S.sel = null; S.paths = null; S.pathPick = null; closeDrawer(bd); pathBar(bd); drawBoard(bd, true); }; document.addEventListener('keydown', S.onKey); }
}
function bindCard(body, el) {
    const id = el.dataset.n; let drag = null;
    el.addEventListener('pointerdown', e => { e.stopPropagation(); el.setPointerCapture(e.pointerId); const p = S.pos.get(id); drag = { sx: e.clientX, sy: e.clientY, x: p.x, y: p.y, moved: false }; });
    el.addEventListener('pointermove', e => {
        if (!drag) return; const k = S.view?.k || 1; const dx = (e.clientX - drag.sx) / k, dy = (e.clientY - drag.sy) / k;
        if (!drag.moved && Math.hypot(dx, dy) < 5) return; drag.moved = true; el.classList.add('dragging');
        const p = S.pos.get(id); p.x = drag.x + dx; p.y = drag.y + dy; el.style.left = `${p.x - CARD_W / 2}px`; el.style.top = `${p.y - CARD_H / 2}px`; redrawStrings(body);
    });
    el.addEventListener('pointerup', async () => {
        if (!drag) return; const d = drag; drag = null; el.classList.remove('dragging');
        if (d.moved) { const p = S.pos.get(id); const n = nodeById(id); n.x = Math.round(p.x); n.y = Math.round(p.y); C.api(`/api/cases/${encodeURIComponent(S.slug)}/nodes/${id}`, { method: 'PUT', body: { x: n.x, y: n.y } }).catch(ex => C.toast(ex.message, true)); return; }
        cardTapped(body, id);
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cardTapped(body, id); } });
}
function redrawStrings(body) {
    body.querySelectorAll('.pb-s').forEach(g => { const l = S.data.board.links.find(x => x.id === g.dataset.l); const a = S.pos.get(l.from), c = S.pos.get(l.to); if (!a || !c) return; const bt = S.bends?.get(l.id) || { b: 0, t: 0.5 }; const k = ctrl(a, c, bt.b); const mx = k.x, my = k.y; const lp = qpt(a, k, c, bt.t); const dd = `M${a.x},${a.y} Q${mx},${my} ${c.x},${c.y}`; g.querySelectorAll('path').forEach(p => p.setAttribute('d', dd)); g.querySelector('.pb-tag')?.setAttribute('transform', `translate(${lp.x},${lp.y})`); });
}
async function cardTapped(body, id) {
    if (S.pathPick) {
        if (!S.pathPick.a || S.pathPick.a === id || S.pathPick.b) { S.pathPick = { a: id }; S.paths = null; pathBar(body); drawBoard(body, true); return; }
        try { S.paths = await C.api(`/api/cases/${encodeURIComponent(S.slug)}/paths`, { method: 'POST', body: { from: S.pathPick.a, to: id } }); S.pathPick.b = id; } catch (ex) { C.toast(ex.message, true); }
        pathBar(body); drawBoard(body, true); return;
    }
    S.sel = S.sel === id ? null : id; drawBoard(body, true); if (S.sel) { openDrawer(body, id); revealCard(body, id); } else closeDrawer(body);
}
// On a phone the card's sheet covers the lower part of the board: slide the board so the card sits above it.
function revealCard(body, id) {
    if (innerWidth >= 720) return; const p = S.pos?.get(id); const wrap = body.querySelector('.pb-wrap'); if (!p || !wrap || !S.view) return;
    const r = wrap.getBoundingClientRect(); const sheetTop = innerHeight * 0.36; const want = Math.max(70, (sheetTop - r.top) / 2);
    S.view = { ...S.view, x: r.width / 2 - p.x * S.view.k, y: want - p.y * S.view.k }; applyView(body);
}
function pathBar(body) {
    const { esc } = C; const bar = body.querySelector('.pb-pathbar'); if (!bar) return; bar.hidden = !S.pathPick;
    if (!S.pathPick) return;
    const a = S.pathPick.a && nodeById(S.pathPick.a), b = S.pathPick.b && nodeById(S.pathPick.b);
    bar.innerHTML = `<span>${!a ? 'Tap the first card' : !b ? `From <b>${esc(nodeName(a))}</b>: tap the second card` : S.paths?.paths.length ? `${S.paths.paths.length} chain${S.paths.paths.length === 1 ? '' : 's'} from <b>${esc(nodeName(a))}</b> to <b>${esc(nodeName(b))}</b>, shortest ${S.paths.paths[0].length} string${S.paths.paths[0].length === 1 ? '' : 's'}` : `No chain joins <b>${esc(nodeName(a))}</b> and <b>${esc(nodeName(b))}</b> yet`}</span><button class="text-btn" data-endpath>Done</button>`;
    bar.querySelector('[data-endpath]').onclick = () => { S.pathPick = null; S.paths = null; pathBar(body); drawBoard(body, true); };
}
function closeDrawer(body) { const d = body.querySelector('.pb-drawer'); if (d) { d.hidden = true; d.innerHTML = ''; } }
function openDrawer(body, id) {
    const { esc, icon, $, $$ } = C; const n = nodeById(id); if (!n) return closeDrawer(body); const enc = encodeURIComponent(S.slug); const t = TYPE[n.type] || TYPE.claim;
    const d = body.querySelector('.pb-drawer'); d.hidden = false;
    const strings = S.data.board.links.filter(l => l.from === id || l.to === id);
    const probes = S.data.probes.filter(p => p.node === id || p.subject.toLowerCase() === n.label.toLowerCase());
    const masked = n.type === 'address' && n.residential;
    d.innerHTML = `<div class="pb-dh" style="--tc:${t.color}"><span class="pb-glyph">${esc(t.glyph)}</span><div><div class="pb-dtype">${esc(t.label)}${n.origin ? ' · where it starts' : ''}${S.data.depths?.[id] !== undefined && !n.origin ? ` · ${S.data.depths[id]} from the start` : ''}</div><h3>${esc(nodeName(n))}</h3></div><button class="icon-btn" data-x aria-label="Close">${icon('x')}</button></div>
        ${masked ? `<p class="note cs-mask">A home address from public records. It is masked on the board and left out of reports. ${S.reveal.has(id) ? `<b>${esc(n.label)}</b> <button class="link" data-hide>Hide</button>` : '<button class="link" data-reveal>Show it here</button>'}</p>` : ''}
        ${n.note && !masked ? `<p class="pb-note">${esc(n.note)}</p>` : ''}
        <div class="pb-focus">Show <button data-hops="1" class="${S.focus === 1 ? 'on' : ''}">1 link</button><button data-hops="2" class="${S.focus === 2 ? 'on' : ''}">2 links</button> around it</div>
        <div class="ka-label">Dig: ask a probe</div>
        <div class="pb-dig">${(DIG[n.type] || DIG.claim).map((q, i) => `<button data-dig="${i}">${esc(q.replaceAll('{x}', masked ? 'this address' : n.label))}</button>`).join('')}</div>
        <div class="cs-addq"><input data-digq type="text" maxlength="600" placeholder="Or your own question about ${esc(masked ? 'this address' : n.label)}"><button class="btn" data-digown>${icon('send')}Probe</button></div>
        <div class="ka-label">Strings · ${strings.length}</div>
        <div class="list">${strings.map(l => { const other = nodeById(l.from === id ? l.to : l.from); return `<button class="row" data-ls="${l.id}"><span class="cs-str ${l.strength}">${l.strength}</span><div class="main"><div class="title" style="white-space:normal">${l.from === id ? '' : `${esc(nodeName(other))} → `}${esc(l.label)}${l.from === id ? ` → ${esc(nodeName(other))}` : ''}</div><div class="sub">${[l.when, fmtAmt(l.amount, l.currency), l.sources.join(', ')].filter(Boolean).map(esc).join(' · ') || 'no source'}</div></div></button>`; }).join('') || '<div class="row"><div class="main"><div class="sub">Not connected yet.</div></div></div>'}</div>
        <div class="r-actions"><button class="btn" data-connect>${icon('link')}Connect to…</button></div>
        <div class="ka-label">Sources · ${n.sources.length}</div>
        ${n.sources.map(sid => { const s = srcById(sid); return s ? srcHtml(s) : ''; }).join('') || '<p class="note">No source yet: until it has one it is a lead.</p>'}
        ${probes.length ? `<div class="ka-label">Probes about it</div><div class="list">${probes.map(p => `<button class="row" data-probe="${esc(p.id)}"><span class="cs-pst ${p.status}"></span><div class="main"><div class="sub" style="white-space:normal;color:var(--foam)">${esc(p.question.slice(0, 140))}</div></div></button>`).join('')}</div>` : ''}
        <div class="r-actions"><button class="btn" data-edit>${icon('pencil')}Edit card</button><button class="btn danger-btn" data-del>${icon('trash')}Remove</button></div>`;
    $('[data-x]', d).onclick = () => { S.sel = null; closeDrawer(body); drawBoard(body, true); };
    $$('[data-hops]', d).forEach(b => b.onclick = () => { S.focus = Number(b.dataset.hops); drawBoard(body, true); openDrawer(body, id); });
    const rv = $('[data-reveal]', d); if (rv) rv.onclick = () => { S.reveal.add(id); drawBoard(body, true); openDrawer(body, id); };
    const hd = $('[data-hide]', d); if (hd) hd.onclick = () => { S.reveal.delete(id); drawBoard(body, true); openDrawer(body, id); };
    const send = async q => { try { await C.api(`/api/cases/${enc}/probes`, { method: 'POST', body: { subject: n.label, question: q, node: id } }); C.toast('Probe sent: zero trust, web search, this question only'); loadCase({ quiet: true }).then(() => openDrawer(body, id)).catch(() => {}); } catch (ex) { C.toast(ex.message, true); } };
    $$('[data-dig]', d).forEach(b => b.onclick = () => send((DIG[n.type] || DIG.claim)[Number(b.dataset.dig)].replaceAll('{x}', n.label)));
    $('[data-digown]', d).onclick = () => { const v = $('[data-digq]', d).value.trim(); if (v) send(v); };
    $$('[data-ls]', d).forEach(b => b.onclick = () => linkDialog(b.dataset.ls));
    $$('[data-probe]', d).forEach(b => b.onclick = () => probeDialog(b.dataset.probe));
    $('[data-connect]', d).onclick = () => linkDialog(null, id);
    $('[data-edit]', d).onclick = () => cardDialog(id);
    $('[data-del]', d).onclick = async () => { if (!(await C.confirmDialog({ title: `Remove ${nodeName(n)}?`, text: 'The card and its strings come off the board. Its sources stay in Evidence.', action: 'Remove' }))) return; try { await C.api(`/api/cases/${enc}/nodes/${id}`, { method: 'DELETE' }); S.sel = null; loadCase(); } catch (ex) { C.toast(ex.message, true); } };
}
function srcHtml(s) { const { esc } = C; return `<div class="cs-src"><span class="cs-rel ${s.reliability}">${esc(REL_TXT[s.reliability] || s.reliability)}</span> <b>${esc(s.id)}</b> ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>` : esc(s.title)}${s.publisher || s.date ? `<div class="sub">${[s.publisher, s.date].filter(Boolean).map(esc).join(' · ')}</div>` : ''}${s.quote ? `<blockquote>${esc(s.quote)}</blockquote>` : ''}</div>`; }
function typesDialog(body) {
    const { esc, $$, icon } = C;
    const { panel, close } = C.openDialog(`<h2>${icon('eye')}Card types shown</h2><div class="cs-types">${Object.entries(TYPE).map(([k, t]) => `<label class="chk-row"><input type="checkbox" data-t="${k}" ${S.hidden.has(k) ? '' : 'checked'}><span class="pb-glyph" style="--tc:${t.color}">${esc(t.glyph)}</span>${esc(t.label)} <span class="muted">· ${S.data.board.nodes.filter(n => n.type === k).length}</span></label>`).join('')}</div><div class="buttons"><button data-all>Show all</button><button class="primary" data-close>Done</button></div>`, { size: 'small' });
    $$('[data-t]', panel).forEach(x => x.onchange = () => { if (x.checked) S.hidden.delete(x.dataset.t); else S.hidden.add(x.dataset.t); drawBoard(body, true); body.querySelector('[data-types]').classList.toggle('on', S.hidden.size > 0); });
    panel.querySelector('[data-all]').onclick = () => { S.hidden.clear(); close(); renderBoard(body); };
}
async function tidy(body) {
    if (!(await C.confirmDialog({ title: 'Tidy the board?', text: 'Every card is laid out again from its strings. Cards you placed by hand move too.', action: 'Tidy', danger: false }))) return;
    const { nodes, links } = visibleSets(); const pos = layout(nodes, links, false); const enc = encodeURIComponent(S.slug);
    for (const n of nodes) { const p = pos.get(n.id); n.x = Math.round(p.x); n.y = Math.round(p.y); }
    drawBoard(body, false);
    for (const n of nodes) await C.api(`/api/cases/${enc}/nodes/${n.id}`, { method: 'PUT', body: { x: n.x, y: n.y } }).catch(() => {});
}
function cardDialog(id) {
    const { esc, icon, $ } = C; const n = id ? nodeById(id) : null; const enc = encodeURIComponent(S.slug);
    const { panel, close } = C.openDialog(`<h2>${icon(n ? 'pencil' : 'plus')}${n ? 'Edit card' : 'Pin a card'}</h2>
        <div class="sc-two"><div class="field"><label for="cd-type">Type</label><select id="cd-type">${Object.entries(S.data.types).map(([k, v]) => `<option value="${k}" ${n?.type === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
        <div class="field"><label for="cd-status">Status</label><select id="cd-status">${['lead', 'confirmed', 'disputed', 'dead-end'].map(s => `<option ${n?.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div></div>
        <div class="field"><label for="cd-label">Name</label><input id="cd-label" type="text" maxlength="120" value="${esc(n?.label || '')}" placeholder="Acme Holdings Ltd"></div>
        <div class="field"><label for="cd-note">Note</label><textarea id="cd-note" rows="3" maxlength="2000">${esc(n?.note || '')}</textarea></div>
        <div class="sc-two"><div class="field"><label for="cd-when">Date (optional)</label><input id="cd-when" type="text" placeholder="2021-03-14" value="${esc(n?.when || '')}"></div>
        <div class="field"><label for="cd-src">Sources</label><input id="cd-src" type="text" placeholder="S1, S4" value="${esc((n?.sources || []).join(', '))}"></div></div>
        <label class="chk-row"><input type="checkbox" id="cd-origin" ${n?.origin ? 'checked' : ''}> Where the rabbit hole starts (depth is counted from here)</label>
        <label class="chk-row" id="cd-resrow" ${n?.type === 'address' || !n ? '' : 'hidden'}><input type="checkbox" id="cd-res" ${n ? (n.residential ? 'checked' : '') : 'checked'}> Someone lives here (masked on the board, left out of reports)</label>
        <p class="note">People are pinned for their public role. Addresses only from public records.</p>
        <div class="buttons"><button data-close>Cancel</button><button class="primary" data-ok>${icon('check')}${n ? 'Save' : 'Pin it'}</button></div>`);
    const syncRes = () => { $('#cd-resrow', panel).hidden = $('#cd-type', panel).value !== 'address'; }; $('#cd-type', panel).onchange = syncRes; syncRes();
    $('[data-ok]', panel).onclick = async () => {
        const b = { type: $('#cd-type', panel).value, status: $('#cd-status', panel).value, label: $('#cd-label', panel).value, note: $('#cd-note', panel).value, when: $('#cd-when', panel).value, sources: $('#cd-src', panel).value, origin: $('#cd-origin', panel).checked, residential: $('#cd-res', panel).checked };
        try { const r = await C.api(n ? `/api/cases/${enc}/nodes/${n.id}` : `/api/cases/${enc}/nodes`, { method: n ? 'PUT' : 'POST', body: b }); close(); S.sel = r.id; loadCase(); } catch (ex) { C.toast(ex.message, true); }
    };
}
function linkDialog(lid, fromId = null) {
    const { esc, icon, $ } = C; const l = lid ? S.data.board.links.find(x => x.id === lid) : null; const enc = encodeURIComponent(S.slug);
    const opts = sel => S.data.board.nodes.map(n => `<option value="${n.id}" ${sel === n.id ? 'selected' : ''}>${esc(nodeName(n))} (${esc(TYPE[n.type]?.label || n.type)})</option>`).join('');
    const { panel, close } = C.openDialog(`<h2>${icon('link')}${l ? 'String' : 'Connect two cards'}</h2>
        <div class="field"><label for="ln-a">From</label><select id="ln-a" ${l ? 'disabled' : ''}>${opts(l?.from || fromId)}</select></div>
        <div class="field"><label for="ln-label">What joins them</label><input id="ln-label" type="text" maxlength="160" value="${esc(l?.label || '')}" placeholder="director of · paid · owns · registered at · awarded contract to"></div>
        <div class="field"><label for="ln-b">To</label><select id="ln-b" ${l ? 'disabled' : ''}>${opts(l?.to || (S.data.board.nodes.find(n => n.id !== fromId)?.id))}</select></div>
        <div class="ka-label">How well supported</div>
        <div class="ka-chips" id="ln-str">${['documented', 'reported', 'alleged'].map(s => `<button type="button" data-s="${s}" class="${(l?.strength || 'alleged') === s ? 'on' : ''}"><span class="cs-str ${s}">${STRENGTH_TXT[s]}</span></button>`).join('')}</div>
        <p class="note">Documented: a primary record says so. Reported: reputable reporting says so. Both need a source; anything else is alleged.</p>
        <div class="sc-two"><div class="field"><label for="ln-src">Sources</label><input id="ln-src" type="text" placeholder="S2, S3" value="${esc((l?.sources || []).join(', '))}"></div><div class="field"><label for="ln-when">Date</label><input id="ln-when" type="text" placeholder="2022-06" value="${esc(l?.when || '')}"></div></div>
        <div class="sc-two"><div class="field"><label for="ln-amt">Amount (optional)</label><input id="ln-amt" type="text" inputmode="decimal" value="${l?.amount ?? ''}" placeholder="250000"></div><div class="field"><label for="ln-cur">Currency</label><input id="ln-cur" type="text" maxlength="10" value="${esc(l?.currency || '')}" placeholder="GBP · USD · BTC"></div></div>
        ${l ? `<div class="ka-label">Sources</div>${l.sources.map(s => srcById(s)).filter(Boolean).map(srcHtml).join('') || '<p class="note">None yet.</p>'}` : ''}
        <div class="buttons">${l ? `<button class="danger" data-del>${icon('trash')}Cut</button>` : ''}<button data-close>Cancel</button><button class="primary" data-ok>${icon('check')}${l ? 'Save' : 'Connect'}</button></div>`);
    let strength = l?.strength || 'alleged';
    panel.querySelectorAll('#ln-str [data-s]').forEach(b => b.onclick = () => { strength = b.dataset.s; panel.querySelectorAll('#ln-str [data-s]').forEach(x => x.classList.toggle('on', x === b)); });
    $('[data-ok]', panel).onclick = async () => {
        const b = { label: $('#ln-label', panel).value, strength, sources: $('#ln-src', panel).value, when: $('#ln-when', panel).value, amount: $('#ln-amt', panel).value, currency: $('#ln-cur', panel).value };
        try { if (l) await C.api(`/api/cases/${enc}/links/${l.id}`, { method: 'PUT', body: b }); else await C.api(`/api/cases/${enc}/links`, { method: 'POST', body: { ...b, from: $('#ln-a', panel).value, to: $('#ln-b', panel).value } }); close(); loadCase(); } catch (ex) { C.toast(ex.message, true); }
    };
    const del = $('[data-del]', panel); if (del) del.onclick = async () => { try { await C.api(`/api/cases/${enc}/links/${l.id}`, { method: 'DELETE' }); close(); loadCase(); } catch (ex) { C.toast(ex.message, true); } };
}

// ---------- Timeline ----------
function renderTimeline(body) {
    const { esc } = C; const b = S.data.board;
    const items = [...b.nodes.filter(n => n.when).map(n => ({ when: n.when, kind: 'card', n, ids: [n.id] })), ...b.links.filter(l => l.when).map(l => ({ when: l.when, kind: 'string', l, ids: [l.from, l.to] }))].sort((x, y) => x.when.localeCompare(y.when));
    const filt = S.tlFilter && b.nodes.some(n => n.id === S.tlFilter) ? S.tlFilter : null;
    const shown = filt ? items.filter(i => i.ids.includes(filt)) : items;
    const day = w => new Date(`${w.length === 4 ? `${w}-07-01` : w.length === 7 ? `${w}-15` : w}T00:00:00Z`).getTime();
    const chip = id => { const n = nodeById(id); const t = TYPE[n?.type] || TYPE.claim; return `<button class="cs-chip${filt === id ? ' on' : ''}" data-tf="${id}" style="--tc:${t.color}">${esc(nodeName(n))}</button>`; };
    let last = null, year = null; let html = '';
    for (const i of shown) {
        const y = i.when.slice(0, 4); if (y !== year) { html += `<div class="tl-year">${y}</div>`; year = y; }
        const gap = last ? Math.round((day(i.when) - day(last)) / 86400000) : null;
        if (gap !== null && gap >= 0) html += `<div class="tl-gap${gap <= 60 ? ' close' : ''}">${gap === 0 ? 'same time' : gap < 60 ? `${gap} day${gap === 1 ? '' : 's'} later` : gap < 730 ? `${Math.round(gap / 30)} months later` : `${(gap / 365).toFixed(1)} years later`}</div>`;
        last = i.when;
        if (i.kind === 'card') { const t = TYPE[i.n.type] || TYPE.claim; html += `<div class="tl-item" style="--tc:${t.color}"><div class="tl-when">${esc(i.when)}</div><div class="tl-body"><div class="tl-what"><span class="pb-glyph">${esc(t.glyph)}</span>${esc(nodeName(i.n))}</div>${i.n.note && !(i.n.type === 'address' && i.n.residential) ? `<div class="sub">${esc(i.n.note.slice(0, 200))}</div>` : ''}<div class="tl-chips">${chip(i.n.id)}</div></div></div>`; }
        else html += `<div class="tl-item str" style="--tc:#E0584B"><div class="tl-when">${esc(i.when)}</div><div class="tl-body"><div class="tl-what">${esc(nodeName(nodeById(i.l.from)))} <span class="muted">${esc(i.l.label)}</span> ${esc(nodeName(nodeById(i.l.to)))}${fmtAmt(i.l.amount, i.l.currency) ? ` · <b>${esc(fmtAmt(i.l.amount, i.l.currency))}</b>` : ''}</div><div class="tl-chips"><span class="cs-str ${i.l.strength}">${i.l.strength}</span>${chip(i.l.from)}${chip(i.l.to)}${i.l.sources.length ? `<span class="muted">${esc(i.l.sources.join(', '))}</span>` : ''}</div></div></div>`;
    }
    body.innerHTML = `<p class="note">Dated cards and strings in order. Short gaps are highlighted: a company formed weeks before a contract, a donation days before a decision. Tap a name to follow only that card.</p>
        ${filt ? `<p><button class="text-btn" data-tclear>Show everything</button> · following <b>${esc(nodeName(nodeById(filt)))}</b></p>` : ''}
        ${shown.length ? `<div class="tl">${html}</div>` : `<p class="empty">Nothing dated yet. Give cards and strings a date (YYYY, YYYY-MM or YYYY-MM-DD) and they appear here.</p>`}`;
    body.querySelectorAll('[data-tf]').forEach(x => x.onclick = () => { S.tlFilter = filt === x.dataset.tf ? null : x.dataset.tf; renderTimeline(body); });
    const cl = body.querySelector('[data-tclear]'); if (cl) cl.onclick = () => { S.tlFilter = null; renderTimeline(body); };
}

// ---------- Evidence ----------
function renderEvidence(body) {
    const { esc, icon, $, $$ } = C; const b = S.data.board; const enc = encodeURIComponent(S.slug);
    const used = id => [...b.nodes.filter(n => n.sources.includes(id)).map(n => nodeName(n)), ...b.links.filter(l => l.sources.includes(id)).map(l => `${nodeName(nodeById(l.from))} → ${l.label}`)];
    const f = S.relFilter || 'all';
    const list = b.sources.filter(s => f === 'all' || s.reliability === f || (f === 'unused' && !used(s.id).length));
    body.innerHTML = `<div class="pb-lens ev-filter">${[['all', `All · ${b.sources.length}`], ['primary', 'Primary records'], ['reputable', 'Reputable reporting'], ['other', 'Other'], ['unused', 'Not cited']].map(([k, l]) => `<button data-rf="${k}" class="${f === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        ${list.map(s => { const u = used(s.id); return `<div class="card ev-card">${srcHtml(s)}<div class="ev-used">${u.length ? `Cited by ${u.slice(0, 6).map(esc).join(' · ')}${u.length > 6 ? ` and ${u.length - 6} more` : ''}` : '<span class="pb-nosrc">Not cited by anything yet</span>'}</div><div class="ev-acts"><span class="muted">${esc(String(s.by || '').replace(/^shell /, 'agent '))}</span><button class="link" data-rmsrc="${esc(s.id)}">Remove</button></div></div>`; }).join('') || '<p class="empty">No sources here.</p>'}
        <div class="card"><h3 style="margin:0 0 10px">${icon('plus')} Add a source</h3>
            <div class="field"><label for="ev-t">Title</label><input id="ev-t" type="text" maxlength="300" placeholder="Annual report 2023"></div>
            <div class="field"><label for="ev-u">Link</label><input id="ev-u" type="url" placeholder="https://…"></div>
            <div class="sc-two"><div class="field"><label for="ev-p">Publisher</label><input id="ev-p" type="text" maxlength="120"></div><div class="field"><label for="ev-d">Date</label><input id="ev-d" type="text" placeholder="2023-04-30"></div></div>
            <div class="field"><label for="ev-r">Reliability</label><select id="ev-r"><option value="primary">Primary record (register, filing, court, exchange or chain data)</option><option value="reputable">Reputable reporting</option><option value="other" selected>Other</option></select></div>
            <div class="field"><label for="ev-q">The passage that matters (optional)</label><textarea id="ev-q" rows="3" maxlength="1200"></textarea></div>
            <div class="r-actions"><button class="btn pri" data-addsrc>${icon('plus')}Add source</button></div></div>`;
    $$('[data-rf]', body).forEach(x => x.onclick = () => { S.relFilter = x.dataset.rf; renderEvidence(body); });
    $('[data-addsrc]', body).onclick = async () => { try { const s = await C.api(`/api/cases/${enc}/sources`, { method: 'POST', body: { title: $('#ev-t', body).value, url: $('#ev-u', body).value, publisher: $('#ev-p', body).value, date: $('#ev-d', body).value, reliability: $('#ev-r', body).value, quote: $('#ev-q', body).value } }); C.toast(`Added ${s.id}`); loadCase(); } catch (ex) { C.toast(ex.message, true); } };
    $$('[data-rmsrc]', body).forEach(x => x.onclick = async () => { if (!(await C.confirmDialog({ title: `Remove ${x.dataset.rmsrc}?`, text: 'Cards and strings that cite it lose it; a string left without sources becomes "alleged".', action: 'Remove' }))) return; try { await C.api(`/api/cases/${enc}/sources/${x.dataset.rmsrc}`, { method: 'DELETE' }); loadCase(); } catch (ex) { C.toast(ex.message, true); } });
}

// ---------- Theories: competing explanations against the evidence ----------
function renderTheories(body) {
    const { esc, icon, $, $$ } = C; const b = S.data.board; const enc = encodeURIComponent(S.slug);
    // Evidence rows: sources, and strings that are documented or reported.
    const rows = [...b.sources.map(s => ({ id: s.id, label: `${s.id} · ${s.title}`, kind: s.reliability })), ...b.links.filter(l => l.strength !== 'alleged').map(l => ({ id: l.id, label: `${nodeName(nodeById(l.from))} → ${l.label} → ${nodeName(nodeById(l.to))}`, kind: l.strength }))];
    const weighed = new Set(b.theories.flatMap(t => Object.keys(t.evidence)));
    const showAll = S.thAll || !weighed.size; const shownRows = showAll ? rows : rows.filter(r => weighed.has(r.id));
    const mark = v => v === 'supports' ? '<b class="th-f">+</b>' : v === 'contradicts' ? '<b class="th-a">−</b>' : v === 'neutral' ? '<span class="muted">·</span>' : '';
    body.innerHTML = `<p class="note">Write the explanations that could be true, including the innocent one, then mark each piece of evidence: tap a cell to cycle <b class="th-f">+</b> supports, <b class="th-a">−</b> contradicts, · neither. The theory with the least against it usually beats the one with the most for it.</p>
        ${b.theories.length ? `<div class="th-wrap"><table class="th"><thead><tr><th>Evidence</th>${b.theories.map(t => { const v = Object.values(t.evidence); return `<th><button class="th-t" data-th="${t.id}" title="${esc(t.text)}">${esc(t.id)}</button><div class="th-tally"><span class="th-f">${v.filter(x => x === 'supports').length}</span> / <span class="th-a">${v.filter(x => x === 'contradicts').length}</span></div></th>`; }).join('')}</tr></thead>
            <tbody>${shownRows.map(r => `<tr><td class="th-ev"><span class="cs-rel ${r.kind}">${esc(r.kind)}</span> ${esc(r.label)}</td>${b.theories.map(t => `<td><button class="th-cell" data-cell="${t.id}|${r.id}" aria-label="${esc(t.id)} and ${esc(r.id)}">${mark(t.evidence[r.id])}</button></td>`).join('')}</tr>`).join('') || `<tr><td colspan="${b.theories.length + 1}" class="muted">No evidence yet: add sources, or documented and reported strings.</td></tr>`}</tbody></table></div>
            ${weighed.size && rows.length > weighed.size ? `<button class="text-btn" data-thall>${showAll ? 'Only weighed evidence' : `Show all evidence (${rows.length})`}</button>` : ''}
            <div class="list gap">${b.theories.map(t => `<div class="row"><b class="th-id">${esc(t.id)}</b><div class="main"><div class="title" style="white-space:normal">${esc(t.text)}</div><div class="sub">${esc(String(t.by || '').replace(/^shell /, 'agent '))}</div></div><button class="text-btn" data-thdel="${t.id}">Remove</button></div>`).join('')}</div>` : '<p class="empty">No theories yet.</p>'}
        <div class="cs-addq"><input id="th-new" type="text" maxlength="300" placeholder="Add a theory, for example: the contracts were won on price alone"><button class="btn" data-thadd>${icon('plus')}Add</button></div>`;
    const add = async () => { const v = $('#th-new', body).value.trim(); if (!v) return; try { await C.api(`/api/cases/${enc}/theories`, { method: 'POST', body: { text: v } }); loadCase(); } catch (ex) { C.toast(ex.message, true); } };
    $('[data-thadd]', body).onclick = add; $('#th-new', body).onkeydown = e => { if (e.key === 'Enter') add(); };
    const cycle = { undefined: 'supports', supports: 'contradicts', contradicts: 'neutral', neutral: 'none' };
    $$('[data-cell]', body).forEach(x => x.onclick = async () => { const [tid, ref] = x.dataset.cell.split('|'); const t = b.theories.find(y => y.id === tid); const next = cycle[t.evidence[ref]]; try { const r = await C.api(`/api/cases/${enc}/theories/${tid}`, { method: 'PUT', body: { ref, verdict: next } }); t.evidence = r.evidence; renderTheories(body); } catch (ex) { C.toast(ex.message, true); } });
    $$('[data-thdel]', body).forEach(x => x.onclick = async () => { if (!(await C.confirmDialog({ title: `Remove ${x.dataset.thdel}?`, text: 'The theory and how the evidence was weighed against it are removed.', action: 'Remove' }))) return; try { await C.api(`/api/cases/${enc}/theories/${x.dataset.thdel}`, { method: 'DELETE' }); loadCase(); } catch (ex) { C.toast(ex.message, true); } });
    $$('[data-th]', body).forEach(x => x.onclick = () => C.toast(b.theories.find(t => t.id === x.dataset.th)?.text || ''));
    const all = $('[data-thall]', body); if (all) all.onclick = () => { S.thAll = !showAll; renderTheories(body); };
}

// ---------- Money: follow the amounts ----------
// Every string with an amount, grouped by currency: the biggest flows, and what went in and out of each card.
function renderMoney(body) {
    const { esc } = C; const b = S.data.board;
    const flows = b.links.filter(l => l.amount !== null && l.amount !== undefined && Number.isFinite(+l.amount));
    const unknown = b.links.filter(l => (l.amount === null || l.amount === undefined) && /paid|pay|fund|loan|donat|bought|sold|invest|transfer|sent|received|fee|bribe|grant/i.test(l.label));
    const byCur = new Map(); for (const l of flows) { const c = l.currency || '?'; if (!byCur.has(c)) byCur.set(c, []); byCur.get(c).push(l); }
    let html = `<p class="note">Strings that carry an amount, by currency. Direction follows the string (from → to). Amounts are only as good as their sources: check the strength of each.</p>`;
    if (!flows.length) html += '<p class="empty">No amounts yet. Give a string an amount and currency (on the Board, tap the string) and it shows here.</p>';
    for (const [cur, ls] of byCur) {
        const total = ls.reduce((s, l) => s + Math.abs(+l.amount), 0); const max = Math.max(...ls.map(l => Math.abs(+l.amount)));
        const per = new Map(); const add = (id, k, v) => { if (!per.has(id)) per.set(id, { in: 0, out: 0 }); per.get(id)[k] += v; };
        for (const l of ls) { add(l.from, 'out', Math.abs(+l.amount)); add(l.to, 'in', Math.abs(+l.amount)); }
        const ranked = [...ls].sort((x, y) => Math.abs(+y.amount) - Math.abs(+x.amount));
        html += `<h2 class="section">${esc(cur)} · ${esc(fmtAmt(total, cur === '?' ? '' : cur))} across ${ls.length} string${ls.length === 1 ? '' : 's'}</h2>
            <div class="list mn-flows">${ranked.map(l => `<button class="row mn-row" data-ml="${l.id}"><div class="main"><div class="mn-line"><b>${esc(nodeName(nodeById(l.from)))}</b> <span class="muted">${esc(l.label)} →</span> <b>${esc(nodeName(nodeById(l.to)))}</b></div><div class="mn-bar"><span class="${l.strength}" style="width:${Math.max(2, (Math.abs(+l.amount) / max) * 100)}%"></span></div><div class="sub">${esc(fmtAmt(+l.amount, cur === '?' ? '' : cur))} · <span class="cs-str ${l.strength}">${l.strength}</span>${l.when ? ` · ${esc(l.when)}` : ''}${l.sources.length ? ` · ${esc(l.sources.join(', '))}` : ''}</div></div></button>`).join('')}</div>
            <div class="mn-table"><div class="mn-th"><span>Card</span><span>In</span><span>Out</span></div>${[...per].sort((x, y) => (y[1].in + y[1].out) - (x[1].in + x[1].out)).map(([id, v]) => `<div class="mn-tr"><span>${esc(nodeName(nodeById(id)))}</span><span>${v.in ? esc(fmtAmt(v.in, cur === '?' ? '' : cur)) : '–'}</span><span>${v.out ? esc(fmtAmt(v.out, cur === '?' ? '' : cur)) : '–'}</span></div>`).join('')}</div>`;
    }
    if (unknown.length) html += `<h2 class="section">Money strings without an amount · ${unknown.length}</h2><div class="list">${unknown.map(l => `<button class="row" data-ml="${l.id}"><div class="main"><div class="title" style="white-space:normal">${esc(nodeName(nodeById(l.from)))} → ${esc(l.label)} → ${esc(nodeName(nodeById(l.to)))}</div><div class="sub">${l.strength}${l.sources.length ? ` · ${esc(l.sources.join(', '))}` : ' · no source'}</div></div></button>`).join('')}</div>`;
    body.innerHTML = html;
    body.querySelectorAll('[data-ml]').forEach(x => x.onclick = () => linkDialog(x.dataset.ml));
}

// ---------- Ask: questions answered from the case file ----------
const ASK_IDEAS = ['What is the strongest evidence so far, and what is it evidence of?', 'Which strings are only alleged, and how could each one be checked?', 'What would most change the picture if it turned out to be true or false?', 'What is the innocent explanation, and what in the file supports it?', 'Summarise the money flows and which are documented.'];
function renderAsk(body) {
    const { esc, icon, $, $$ } = C; const enc = encodeURIComponent(S.slug); const list = S.data.asks || [];
    const cite = t => esc(t).replace(/\[([Sl][0-9a-f]{1,6}(?:,\s*[Sl][0-9a-f]{1,6})*)\]/g, (m, ids) => `<span class="ask-cite">[${ids}]</span>`)
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/^#{1,4} (.*)$/gm, '<b class="ask-h">$1</b>').replace(/^\s*[-*] (.*)$/gm, '<span class="ask-li">$1</span>').replace(/^\s*(\d+)\. (.*)$/gm, '<span class="ask-li n" data-n="$1">$2</span>');
    body.innerHTML = `<p class="note">Ask about the case. The answer comes only from what is on the board, the sources, theories and notes, with the ids it relies on, and says when the board cannot answer. Homes stay masked. To find something new, send a probe from a card.</p>
        <div class="ask-box"><textarea id="ask-q" rows="2" maxlength="2000" placeholder="Who connects the councillor to Northwind, and how solid is each link?"></textarea><button class="btn pri" data-ask>${icon('send')}Ask</button></div>
        <div class="ask-ideas">${ASK_IDEAS.map((q, i) => `<button data-idea="${i}">${esc(q)}</button>`).join('')}</div>
        ${list.map(a => `<div class="card ask-item"><div class="ask-q"><span class="cs-pst ${a.status}"></span>${esc(a.question)}</div>${a.status === 'running' ? '<p class="muted">Reading the case file…</p>' : `<div class="ask-a">${cite(a.answer).replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>').replace(/<br>(<span class="ask-li)/g, '$1').replace(/(<\/span>)<br>/g, '$1')}</div>`}<div class="sub">${a.agent === 'claude' ? 'Claude' : 'Cline'} · ${new Date(a.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div></div>`).join('') || ''}`;
    const go = async q => { if (!q.trim()) return; try { await C.api(`/api/cases/${enc}/asks`, { method: 'POST', body: { question: q } }); loadCase(); } catch (ex) { C.toast(ex.message, true); } };
    $('[data-ask]', body).onclick = () => go($('#ask-q', body).value);
    $('#ask-q', body).onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) go(e.target.value); };
    $$('[data-idea]', body).forEach(x => x.onclick = () => go(ASK_IDEAS[Number(x.dataset.idea)]));
    $$('.ask-cite', body).forEach(x => { x.title = x.textContent.slice(1, -1).split(/,\s*/).map(id => { const s = srcById(id); if (s) return `${id}: ${s.title}`; const l = S.data.board.links.find(y => y.id === id); return l ? `${nodeName(nodeById(l.from))} → ${l.label} → ${nodeName(nodeById(l.to))}` : id; }).join('\n'); });
}

// ---------- Notes and Agent ----------
function renderNotes(body) {
    const { esc, icon, $ } = C; const enc = encodeURIComponent(S.slug);
    body.innerHTML = `<p class="note">The write-up: what the evidence shows, what it does not, what is still open. Agents add to it; cite sources as [S3]. The report starts from it.</p><textarea id="cs-notes" class="fd-text" rows="22">${esc(S.data.notes)}</textarea><div class="r-actions"><button class="btn pri" data-save>${icon('check')}Save</button></div>`;
    $('[data-save]', body).onclick = async () => { try { await C.api(`/api/cases/${enc}/notes`, { method: 'PUT', body: { text: $('#cs-notes', body).value } }); S.data.notes = $('#cs-notes', body).value; C.toast('Saved'); } catch (ex) { C.toast(ex.message, true); } };
}
function renderAgent(body) {
    const { esc, icon, $, $$ } = C; const d = S.data; const enc = encodeURIComponent(S.slug);
    const mine = (C.state.shells || []).filter(s => String(s.cwd || '').includes(`/Cases/${S.slug}`));
    body.innerHTML = `<p class="note">The lead agent works the case with <span class="mono">sleuth</span>: it pins cards and strings with their sources, weighs theories, and sends probes. Each probe is a fresh zero-trust agent that sees one subject and one question, with web search and nothing else. It stays within depth ${d.depth} and ${d.budget} probes (${d.probes.length} used).</p>
        ${mine.length ? `<div class="list">${mine.map(s => `<button class="row" data-sh="${esc(s.name)}"><span class="dot ${s.attached ? 'live' : ''}" style="margin:0 10px"></span><div class="main"><div class="title mono">${esc(s.name)}</div><div class="sub">${esc(C.agentTitle(s.agent))}</div></div>${icon('chevron', 'i chev')}</button>`).join('')}</div>` : ''}
        <div class="r-actions"><button class="btn pri" data-start>${icon('claude')}Start an agent on this case</button></div>
        <div class="r-danger"><div><b>Delete this case</b><span>Moves it to the box's trash, with its board, sources and probes.</span></div><button class="btn danger-btn" data-del>${icon('trash')}Delete…</button></div>`;
    $$('[data-sh]', body).forEach(b => b.onclick = () => C.openTerminal(b.dataset.sh, 'Conspiracy'));
    $('[data-start]', body).onclick = () => C.newShellDialog(`Cases/${S.slug}`, 'agent', null, { firstPrompt: `Conspiracy case: ${d.title}. The question: ${d.question || '(ask me)'}. Read .platopypus/case.md and notes.md, run \`sleuth status\`, then work the case: pin what the public record shows with sources, send narrow probes, weigh theories, and keep notes.md current.` });
    $('[data-del]', body).onclick = () => {
        const { panel, close } = C.openDialog(`<h2>${icon('trash')}Delete this case?</h2><p class="muted">“${esc(d.title)}” moves to the box's trash.</p><div class="field"><label for="dc-name">Type the name to confirm</label><input id="dc-name" type="text" autocomplete="off" placeholder="${esc(d.title)}"></div><div class="buttons"><button data-close>Cancel</button><button class="danger" data-ok disabled>${icon('trash')}Delete</button></div>`);
        const inp = $('#dc-name', panel), ok = $('[data-ok]', panel); inp.oninput = () => { ok.disabled = inp.value.trim() !== d.title; };
        ok.onclick = async () => { try { await C.api(`/api/cases/${enc}/delete`, { method: 'POST', body: { confirm: inp.value } }); close(); C.toast('Moved to the trash'); C.push('cases'); } catch (ex) { C.toast(ex.message, true); } };
    };
}

// ---------- printable report ----------
// A static picture of the board for the report: cards where they are on the board (or laid out), strings by strength.
function boardSnapshot() {
    const { esc } = C; const b = S.data.board; if (!b.nodes.length) return '';
    const pos = layout(b.nodes, b.links); const ps = [...pos.values()];
    const minx = Math.min(...ps.map(p => p.x)) - 100, maxx = Math.max(...ps.map(p => p.x)) + 100, miny = Math.min(...ps.map(p => p.y)) - 60, maxy = Math.max(...ps.map(p => p.y)) + 60;
    const dash = { documented: '', reported: '9 6', alleged: '2 6' };
    const bd = bends(b.links);
    const strings = b.links.map(l => { const a = pos.get(l.from), c = pos.get(l.to); if (!a || !c) return ''; const bt = bd.get(l.id) || { b: 0, t: 0.5 }; const k = ctrl(a, c, bt.b); const lp = qpt(a, k, c, bt.t); const tx = lp.x, ty = lp.y; return `<path d="M${a.x},${a.y} Q${k.x},${k.y} ${c.x},${c.y}" fill="none" stroke="#C0392B" stroke-width="${l.strength === 'documented' ? 2.4 : 1.8}" stroke-dasharray="${dash[l.strength]}"/><text x="${tx}" y="${ty - 4}" font-size="10" text-anchor="middle" fill="#7a2a20" paint-order="stroke" stroke="#fff" stroke-width="3">${esc(l.label.slice(0, 28))}</text>`; }).join('');
    const wrap2 = t => { const w = t.split(/\s+/); let a = ''; while (w.length && (a + ' ' + w[0]).trim().length <= 22) a = (a + ' ' + w.shift()).trim(); if (!a) a = w.shift().slice(0, 22); let r = w.join(' '); if (r.length > 22) r = r.slice(0, 21) + '…'; return [a, r]; };
    const cards = b.nodes.map(n => { const p = pos.get(n.id); const t = TYPE[n.type] || TYPE.claim; const name = n.type === 'address' && n.residential ? 'Residential address' : n.label; const [l1, l2] = wrap2(name);
        return `<g><rect x="${p.x - 80}" y="${p.y - 28}" width="160" height="56" rx="3" fill="#F6F1E6" stroke="#bbb"/><rect x="${p.x - 80}" y="${p.y - 28}" width="160" height="5" fill="${t.color}"/><text x="${p.x - 72}" y="${p.y - 10}" font-size="9" fill="#666">${esc(t.label)}${n.origin ? ' · start' : ''}</text><text x="${p.x - 72}" y="${p.y + 6}" font-size="12" font-weight="600" fill="#1f2430">${esc(l1)}</text><text x="${p.x - 72}" y="${p.y + 20}" font-size="12" font-weight="600" fill="#1f2430">${esc(l2)}</text></g>`; }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minx} ${miny} ${maxx - minx} ${maxy - miny}" style="width:100%;height:auto;border:1px solid #ddd;background:#fff">${strings}${cards}</svg>`;
}
async function printReport() {
    const { esc } = C; let md = ''; try { const r = await fetch(`/api/cases/${encodeURIComponent(S.slug)}/export`, { headers: { 'X-Plato': '1' }, credentials: 'same-origin' }); md = await r.text(); } catch (ex) { return C.toast(ex.message, true); }
    const html = esc(md).replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/&lt;(https?:\/\/[^&]+)&gt;/g, '<a href="$1">$1</a>').replace(/^- (.*)$/gm, '<li>$1</li>').replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`).replace(/^---$/gm, '<hr>').replace(/\n{2,}/g, '\n<p>');
    const w = window.open('', '_blank'); if (!w) return C.toast('Allow pop-ups to open the report', true);
    const snap = boardSnapshot();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(S.data.title)}</title><style>body{font:15px/1.55 Georgia,serif;max-width:760px;margin:40px auto;padding:0 20px;color:#16181d}h1{font-size:28px}h2{margin-top:32px;border-bottom:1px solid #ccc;padding-bottom:4px}h3{margin-top:22px}li{margin:4px 0}a{color:#1d4ed8;word-break:break-all}.foot{margin-top:40px;font-size:12px;color:#666}</style></head><body>${snap ? html.replace(/<\/h1>/, `</h1><figure style="margin:0 0 24px">${snap}<figcaption style="font-size:12px;color:#666">The board: solid string documented, dashed reported, dotted alleged.</figcaption></figure>`) : html}<p class="foot">Prepared with PlatOpypus Conspiracy · ${new Date().toLocaleDateString()} · Residential addresses are redacted. Strings marked alleged are unverified.</p></body></html>`);
    w.document.close(); setTimeout(() => w.print(), 400);
}
