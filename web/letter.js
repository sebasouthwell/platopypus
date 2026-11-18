// The cover-letter editor for one job: write (Markdown, autosave, versions), preview, and a side pane that reviews
// the letter against the job: which requirements and framework elements it covers, the Me evidence for each, an AI
// review that quotes and suggests, and the past letters a generated draft was based on.
(() => {
    'use strict';
    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => [...r.querySelectorAll(s)];
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const qs = new URLSearchParams(location.search); const job = qs.get('job') || ''; const name = qs.get('name') || 'cover-letter';
    const S = { mtime: 0, dirty: false, timer: null, data: null, poll: null };
    async function api(p, { method = 'GET', body } = {}) {
        const r = await fetch(p, { method, headers: { 'X-Plato': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
        if (r.status === 401) { location.href = '/'; throw new Error('Signed out.'); }
        const d = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(d.error || r.statusText); e.status = r.status; throw e; } return d;
    }
    let tt; const toast = (m, bad) => { const t = $('#toast'); t.textContent = m; t.className = `on${bad ? ' bad' : ''}`; clearTimeout(tt); tt = setTimeout(() => { t.className = ''; }, 3500); };
    const md = s => esc(s).replace(/^### (.*)$/gm, '<h4>$1</h4>').replace(/^## (.*)$/gm, '<h3>$1</h3>').replace(/^# (.*)$/gm, '<h2>$1</h2>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>').replace(/^[-*] (.*)$/gm, '<li>$1</li>').replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`).replace(/\[([^\]]+)\]/g, '<mark>[$1]</mark>').split(/\n{2,}/).map(p => (/^<(h\d|ul)/.test(p) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`)).join('');
    const words = s => (s.trim().match(/\S+/g) || []).length;
    const base = `/api/jobs/job/${encodeURIComponent(job)}/letter`;

    function state(t) { $('#state').textContent = t || (S.dirty ? 'Unsaved' : S.mtime ? 'Saved' : ''); $('#save').disabled = !S.dirty; $('#count').textContent = `${words($('#code').value)} words`; }
    async function load(keepText = false) {
        const d = await api(`${base}?name=${encodeURIComponent(name)}`); S.data = d;
        $('#title').textContent = d.job.title; $('#sub').textContent = [d.job.company, d.job.location].filter(Boolean).join(' · '); document.title = `Cover letter · ${d.job.title}`;
        if (!keepText) { $('#code').value = d.text; S.dirty = false; } S.mtime = d.mtime;
        $('#hist').innerHTML = `<option value="">Versions${d.history.length ? ` (${d.history.length})` : ''}</option>${d.history.map(h => `<option value="${h.version}">${new Date(h.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</option>`).join('')}`;
        $('#gen').textContent = d.text.trim() ? 'Regenerate' : 'Generate';
        renderFit(); renderAi(); renderBased(); state(); if (!$('#pv').hidden) preview();
    }
    async function save() {
        if (!S.dirty) return true; clearTimeout(S.timer);
        try { const r = await api(base, { method: 'POST', body: { action: 'save', name, text: $('#code').value, baseMtime: S.mtime } }); S.mtime = r.mtime; S.dirty = false; state(); refreshFit(); return true; }
        catch (e) { toast(e.message, true); if (e.status === 409) state('Changed elsewhere'); return false; }
    }
    async function refreshFit() { try { const d = await api(`${base}?name=${encodeURIComponent(name)}`); S.data.coverage = d.coverage; S.data.review = d.review; S.data.history = d.history; renderFit(); renderAi(); } catch { /* keep the old view */ } }
    $('#code').addEventListener('input', () => { S.dirty = true; state(); clearTimeout(S.timer); S.timer = setTimeout(save, 2500); });
    $('#save').onclick = save;
    addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });
    addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
    function preview() { $('#pv').innerHTML = md($('#code').value) || '<p class="muted">Nothing written yet.</p>'; }
    $$('#edtabs [data-v]').forEach(b => b.onclick = () => { $$('#edtabs [data-v]').forEach(x => x.classList.toggle('on', x === b)); const pv = b.dataset.v === 'preview'; $('#code').hidden = pv; $('#pv').hidden = !pv; if (pv) preview(); });
    $$('#sidetabs [data-p]').forEach(b => b.onclick = () => { $$('#sidetabs [data-p]').forEach(x => x.classList.toggle('on', x === b)); for (const p of ['fit', 'ai', 'based']) $(`#${p}`).hidden = p !== b.dataset.p; });

    // Insert text at the cursor (an evidence line from Me).
    function insert(t) { const c = $('#code'); const a = c.selectionStart, z = c.selectionEnd; c.value = c.value.slice(0, a) + t + c.value.slice(z); c.selectionStart = c.selectionEnd = a + t.length; c.focus(); S.dirty = true; state(); clearTimeout(S.timer); S.timer = setTimeout(save, 2500); }
    function renderFit() {
        const cov = S.data.coverage || []; const box = $('#fit');
        if (!cov.length) { box.innerHTML = '<p class="muted pad">This job has no requirements stored yet. Score it or assess it from the job (Job Hunt), and they appear here.</p>'; return; }
        const n = k => cov.filter(c => c.status === k).length;
        box.innerHTML = `<div class="sum"><span class="covered">${n('covered')} covered</span><span class="partly">${n('partly')} partly</span><span class="missing">${n('missing')} missing</span></div>
            <p class="muted pad">Matched by the words they share with your letter: a guide, not a verdict. The AI review reads it properly.</p>
            ${cov.map((c, i) => `<div class="req ${c.status}"><div class="rh"><span class="dot"></span><span class="rt">${esc(c.text)}</span>${c.kind !== 'requirement' ? `<span class="k">${esc(c.kind)}${c.required ? ` · needs ${esc(c.required)}` : ''}</span>` : ''}</div>
              ${c.evidence.length ? `<div class="ev">${c.evidence.map((e, k) => `<button class="evb" data-ins="${i}.${k}" title="Insert a line about this">${esc(e.title)}${e.level ? ` <span class="muted">${esc(e.level)}</span>` : ''} <span class="plus">+</span></button>`).join('')}</div>` : '<div class="muted small">Nothing in Me matches: a gap, or add it to Me.</div>'}</div>`).join('')}`;
        $$('[data-ins]', box).forEach(b => b.onclick = () => { const [i, k] = b.dataset.ins.split('.').map(Number); const e = cov[i].evidence[k]; insert(`[${e.title}: what you did, how, and the result]`); });
    }
    function renderAi() {
        const r = S.data.review; const box = $('#ai');
        const head = `<div class="pad"><button class="btn pri" id="rev">${r ? 'Review again' : 'Review my letter'}</button><p class="muted">A separate agent reads the advert's requirements and your letter (not your Me profile), quotes where each one is met, and suggests fixes.</p></div>`;
        if (!r) { box.innerHTML = head; } else if (r.status !== 'done') { box.innerHTML = `${head}<p class="pad bad">The review did not come back in the expected form.</p><pre class="pad">${esc(r.note || '')}</pre>`; } else {
            const stale = r.mtime && S.mtime && S.mtime > r.mtime + 1;
            box.innerHTML = `${head}${stale ? '<p class="pad warn">The letter changed since this review.</p>' : ''}
              ${r.overall ? `<div class="ov pad">${r.overall.top_fixes?.length ? `<b>Fix first</b><ol>${r.overall.top_fixes.map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}<div><b>Length</b> ${esc(r.overall.length || '')}</div><div><b>Tone</b> ${esc(r.overall.tone || '')}</div><div><b>Specific to them?</b> ${esc(r.overall.specificity || '')}</div>${(r.overall.cliches || []).length ? `<div><b>Clichés</b> ${r.overall.cliches.map(esc).join(', ')}</div>` : ''}</div>` : ''}
              ${(r.requirements || []).map(q => `<div class="req ${q.verdict === 'covered' ? 'covered' : q.verdict === 'weak' ? 'partly' : 'missing'}"><div class="rh"><span class="dot"></span><span class="rt">${esc(q.requirement)}</span><span class="k">${esc(q.verdict)}</span></div>${q.quote ? `<blockquote data-find="${esc(q.quote)}">${esc(q.quote)}</blockquote>` : ''}${q.suggestion ? `<div class="sg">${esc(q.suggestion)}</div>` : ''}</div>`).join('')}
              <p class="muted pad small">${esc(r.by || '')} · ${new Date(r.at).toLocaleString('en-GB')}</p>`;
            $$('[data-find]', box).forEach(q => q.onclick = () => { const c = $('#code'); const i = c.value.indexOf(q.dataset.find.slice(0, 60)); if (i >= 0) { $('#code').hidden = false; $('#pv').hidden = true; c.focus(); c.setSelectionRange(i, i + q.dataset.find.length); } });
        }
        $('#rev').onclick = async () => { if (!(await save())) return; try { await api(base, { method: 'POST', body: { action: 'review', name } }); toast('Reviewing… this takes a minute.'); $('#rev').disabled = true; waitFor(d => d.review && d.review.at > (r?.at || 0)); } catch (e) { toast(e.message, true); } };
    }
    function renderBased() {
        const sim = S.data.similar || []; const box = $('#based');
        box.innerHTML = `<div class="pad"><p class="muted">Generate starts from your most similar past letters (other jobs' drafts, and letters in your application folders), ranked by how alike the jobs are. Letters from applications that reached interview rank higher.</p></div>
            ${sim.length ? sim.map(s => `<div class="req"><div class="rh"><span class="rt">${esc(s.title)}${s.company ? ` · ${esc(s.company)}` : ''}</span><span class="k">${s.score}% alike</span></div><div class="muted small">${esc(s.label)}${s.stage ? ` · reached ${esc(s.stage)}` : ''}</div></div>`).join('') : '<p class="pad muted">No similar past letters yet: Generate writes a new one.</p>'}`;
    }
    // Poll until the server shows what we are waiting for (a new draft from an agent, or a review).
    function waitFor(test, ms = 10 * 60_000) {
        clearInterval(S.poll); const t0 = Date.now();
        S.poll = setInterval(async () => { if (Date.now() - t0 > ms) return clearInterval(S.poll); try { const d = await api(`${base}?name=${encodeURIComponent(name)}`); if (test(d)) { clearInterval(S.poll); if (S.dirty) { S.data.review = d.review; renderAi(); toast('Done. You have unsaved edits, so the new text was not loaded: see Versions.'); } else { await load(); toast('Done.'); } } } catch { /* keep trying */ } }, 6000);
    }
    $('#gen').onclick = async () => {
        const has = $('#code').value.trim().length > 0; const sim = (S.data?.similar || []).length;
        const extra = prompt(`${has ? 'Your current text is kept in Versions. ' : ''}${sim ? `It will start from your ${sim} most similar past letter${sim === 1 ? '' : 's'}.` : 'No similar past letters: it writes a new one.'}\n\nAnything it should do? (optional)`, '');
        if (extra === null) return; if (!(await save())) return;
        try { await api(base, { method: 'POST', body: { action: 'generate', name, extra } }); state('An agent is writing…'); $('#gen').disabled = true; const m0 = S.mtime; waitFor(d => d.mtime > m0 + 1); }
        catch (e) { toast(e.message, true); }
        finally { setTimeout(() => { $('#gen').disabled = false; }, 4000); }
    };
    $('#hist').onchange = async e => { const v = e.target.value; if (!v) return; if (!confirm('Bring back this version? The current text is kept in Versions too.')) { e.target.value = ''; return; } if (!(await save())) return; try { await api(base, { method: 'POST', body: { action: 'restore', name, version: v } }); await load(); toast('Restored'); } catch (x) { toast(x.message, true); } };
    if (!job) { $('#title').textContent = 'No job'; return; }
    load().catch(e => toast(e.message, true));
})();
