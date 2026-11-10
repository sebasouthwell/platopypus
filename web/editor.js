// The paper editor: edit LaTeX and refs.bib in the browser, build, and open any citation's source.
(() => {
    'use strict';
    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => [...r.querySelectorAll(s)];
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const slug = new URLSearchParams(location.search).get('topic') || '';
    const enc = encodeURIComponent(slug);
    const S = { files: [], bib: new Map(), sources: [], cur: null, mtime: 0, dirty: false, conflict: false, detail: null, timer: null, links: null };

    async function api(path, { method = 'GET', body } = {}) {
        const res = await fetch(path, { method, headers: { 'X-Plato': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
        if (res.status === 401) { location.href = '/'; throw new Error('Signed out.'); }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; throw e; }
        return data;
    }
    let toastT;
    function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.className = 'on' + (bad ? ' bad' : ''); clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, 3500); }
    const fmt = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

    // ----- layout on narrow screens -----
    function view(v) { $('#grid').dataset.view = v; $$('#views button').forEach(b => b.classList.toggle('on', b.dataset.view === v)); }
    $$('#views button').forEach(b => b.onclick = () => view(b.dataset.view));
    // "both" keeps the source open beside the preview, so you can write against the original and see the result.
    function pane(p) {
        if (p === 'checks') p = localStorage.getItem('editor.check') === 'spelling' ? 'spelling' : 'cites';
        if (p === 'cites' || p === 'spelling') localStorage.setItem('editor.check', p);
        $('#checkseg').hidden = !(p === 'cites' || p === 'spelling'); $$('#checkseg button').forEach(b => b.classList.toggle('on', b.dataset.check === p));
        S.pane = p; const both = p === 'both'; localStorage.setItem('editor.pane', both ? 'both' : 'preview');
        $('#preview').hidden = !(p === 'preview' || both); $('#source').hidden = !(p === 'source' || both); $('#spelling').hidden = p !== 'spelling'; $('#agent').hidden = p !== 'agent'; if (p === 'agent') drawAgent(); $('#changes').hidden = p !== 'changes'; if (p === 'changes') drawChanges(); $('#citecheck').hidden = p !== 'cites'; if (p === 'cites') drawCiteCheck();
        $('#side').classList.toggle('both', both); $('#grid').classList.toggle('wide-side', both);
        if (both && !$('#source').innerHTML.trim()) $('#source').innerHTML = '<div class="empty">Open a source from References, or click a citation, and it stays here while you write.</div>';
        if (p === 'spelling') checkSpelling(); const tabOf = x => (x === 'cites' || x === 'spelling' ? 'checks' : x); $$('#tabs button[data-pane]').forEach(b => { const on = b.dataset.pane === tabOf(p); b.classList.toggle('on', on); if (on) b.classList.remove('ping'); });
    }
    $$('#tabs button').forEach(b => b.onclick = () => pane(b.dataset.pane));

    // ----- loading -----
    async function loadAll() {
        const [d, f] = await Promise.all([api(`/api/research/${enc}`), api(`/api/research/${enc}/files`)]);
        S.detail = d; S.files = f.files; S.bib = new Map(f.bib.map(e => [e.key, e])); S.sources = d.sources;
        $('#title').textContent = d.title; document.title = d.title + ' · editor'; $('#back').href = '/';
        S.langs = f.langs; $('#lang').innerHTML = Object.entries(f.langs).map(([k, v]) => `<option value="${esc(k)}" ${k === f.lang ? 'selected' : ''}>${esc(v)}</option>`).join(''); applyLang(f.lang);
        renderFiles(); renderRefs();
    }
    function renderFiles() {
        $('#files').innerHTML = S.files.map(f => `<li><button data-f="${esc(f.path)}" class="${S.cur === f.path ? 'on' : ''}">${esc(f.label)}</button></li>`).join('');
        $$('#files [data-f]').forEach(b => b.onclick = () => openFile(b.dataset.f).catch(e => toast(e.message, true)));
    }
    async function openFile(p) {
        if (S.dirty) await save();
        const r = await api(`/api/research/${enc}/file?path=${encodeURIComponent(p)}`);
        S.cur = p; S.mtime = r.mtime; S.dirty = false; S.conflict = false; $('#code').value = r.text; paint(); gutter(); state(); renderFiles(); cites(); view('edit');
    }
    function gutter() { const n = $('#code').value.split('\n').length; $('#gutter').textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); $('#gutter').scrollTop = $('#code').scrollTop; }
    function state(extra) {
        $('#state').textContent = extra || (S.conflict ? 'Changed by an agent' : S.dirty ? 'Unsaved' : S.cur ? 'Saved' : '');
        $('#save').textContent = S.conflict ? 'Overwrite' : 'Save'; $('#save').disabled = !S.cur || (!S.dirty && !S.conflict);
    }

    // ----- saving and building -----
    async function save() {
        if (!S.cur || (!S.dirty && !S.conflict)) return true;
        clearTimeout(S.timer);
        try {
            const r = await api(`/api/research/${enc}/file`, { method: 'POST', body: { path: S.cur, text: $('#code').value, baseMtime: S.conflict ? 0 : S.mtime } });
            S.mtime = r.mtime; S.dirty = false; S.conflict = false; state();
            if (S.cur === 'refs.bib') { const f = await api(`/api/research/${enc}/files`); S.bib = new Map(f.bib.map(e => [e.key, e])); renderRefs(); cites(); }
            return true;
        } catch (e) { if (e.status === 409) { S.conflict = true; state(); toast(e.message, true); } else toast(e.message, true); return false; }
    }
    async function build() {
        const b = $('#build'); if (!(await save())) return; b.disabled = true; b.textContent = 'Building…';
        try { const r = await api(`/api/research/${enc}/build`, { method: 'POST' }); toast(r.ok ? `Built: ${r.pages} page${r.pages === 1 ? "" : "s"}` : 'The build failed', !r.ok); }
        catch (e) { toast(e.message, true); }
        b.disabled = false; b.textContent = 'Build';
        await refreshPreview();
    }
    $('#save').onclick = () => save();
    $('#build').onclick = build;
    $('#autobuild').checked = localStorage.getItem('editor.autobuild') === '1';
    $('#autobuild').onchange = e => localStorage.setItem('editor.autobuild', e.target.checked ? '1' : '0');

    const code = $('#code');
    code.addEventListener('input', () => {
        S.dirty = true; state(); gutter(); cites();
        clearTimeout(S.timer); S.timer = setTimeout(async () => { if (await save() && $('#autobuild').checked) build(); }, 1600);
    });
    code.addEventListener('scroll', () => { $('#gutter').scrollTop = code.scrollTop; });
    code.addEventListener('keydown', e => {
        const mod = e.ctrlKey || e.metaKey;
        if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !mod) { e.preventDefault(); const a = code.selectionStart; code.setRangeText('  ', a, code.selectionEnd, 'end'); code.dispatchEvent(new Event('input')); }
        else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save().then(ok => { if (ok && $('#autobuild').checked) build(); }); }
        else if (mod && e.key === 'Enter') { e.preventDefault(); build(); }
    });
    addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

    // ----- citation marks: the check's findings shown on the text itself -----
    // Found by searching the text (not by stored positions), so they stay on the right sentence while you write.
    // A third layer under the coloured text carries only the backgrounds and underlines.
    S.cred = null; S.marks = []; S.marksOn = localStorage.getItem('editor.marks') !== '0';
    const VERDICT = { partly: 'Partly supported', unsupported: 'Not supported', unclear: 'Could not check' };
    async function loadCred() { try { const d = await api(`/api/research/${enc}/citecheck`); S.cred = d.report ? { items: d.report.items, uncited: d.report.uncited } : null; } catch { S.cred = null; } paint(); cites(); }
    function sentenceStart(text, i, floor) { let j = i; while (j > floor) { const c = text[j - 1]; if ((c === '.' || c === '?' || c === '!') && /\s/.test(text[j] || '')) break; if (c === '\n') { const prev = text.slice(text.lastIndexOf('\n', j - 2) + 1, j - 1).trim(); if (!prev || prev.startsWith('\\') || prev.startsWith('%')) break; } j--; } while (j < i && /\s/.test(text[j])) j++; return j; }
    function computeMarks(text, force = false) {
        const out = []; if (!S.cred || (!S.marksOn && !force) || !S.cur) return out;
        const lineStart = n => { let p = 0; for (let k = 1; k < n && p >= 0; k++) p = text.indexOf('\n', p) + 1; return Math.max(0, p); };
        const paraOf = pos => { let a = text.lastIndexOf('\n\n', pos); a = a < 0 ? 0 : a + 2; let b = text.indexOf('\n\n', pos); b = b < 0 ? text.length : b; return [a, b]; };
        for (const it of S.cred.items) {
            if (it.file !== S.cur || it.verdict === 'supported') continue;
            // the \cite holding this key nearest to the line the report names
            const re = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g; const near = lineStart(it.line); let best = null;
            for (const m of text.matchAll(re)) if (m[1].split(',').map(x => x.trim()).includes(it.key)) { const d = Math.abs(m.index - near); if (!best || d < best.d) best = { d, at: m.index, end: m.index + m[0].length }; }
            // too far from where the check saw it: that citation has moved or gone since, so do not mark a different one
            // (the report names the line its paragraph starts on, so: still inside that paragraph, or within a few lines)
            if (!best) continue; { const [qa, qb] = paraOf(near); if (!(best.at >= qa && best.at <= qb) && Math.abs(text.slice(0, best.at).split('\n').length - it.line) > 8) continue; }
            const [pa] = paraOf(best.at); out.push({ from: sentenceStart(text, best.at, pa), to: best.end, cls: `m-${it.verdict}`, label: VERDICT[it.verdict] || it.verdict, note: it.note, fix: it.fix, key: it.key });
        }
        const words = s => new Set(String(s).toLowerCase().match(/[a-z][a-z-]{3,}/g) || []);
        for (const u of S.cred.uncited) {
            if (u.file !== S.cur) continue;
            const [pa, pb] = paraOf(Math.min(lineStart(u.line), Math.max(0, text.length - 1))); const want = words(u.note); let best = null;
            // the sentence in that paragraph that shares the most words with the agent's note
            for (const m of text.slice(pa, pb).matchAll(/[^.!?]+[.!?]?/g)) { const s = m[0]; const got = [...words(s)].filter(w => want.has(w)).length; if (got >= 2 && (!best || got > best.got)) { const lead = s.length - s.trimStart().length; best = { got, from: pa + m.index + lead, to: pa + m.index + s.trimEnd().length }; } }
            if (best) out.push({ from: best.from, to: best.to, cls: 'm-uncited', label: 'Needs a citation', note: u.note });
        }
        return out.sort((x, y) => x.from - y.from).filter((m, i, a) => !i || m.from >= a[i - 1].to);   // no overlaps
    }
    function paintMarks(text) {
        S.marks = computeMarks(text); let html = '', last = 0;
        for (const m of S.marks) { html += esc(text.slice(last, m.from)) + `<mark class="${m.cls}">${esc(text.slice(m.from, m.to))}</mark>`; last = m.to; }
        $('#marks').innerHTML = html + esc(text.slice(last)) + '\n ';
        $('#marks').scrollTop = code.scrollTop;
    }

    // ----- colour for LaTeX and BibTeX -----
    // The text box itself stays a plain text box (so typing, selection, spelling and undo behave as usual). Its letters
    // are transparent, and the same text, coloured, sits exactly underneath.
    const TEX = /(%[^\n]*)|(\\(?:begin|end)\{[^}\n]*\})|(\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]\n]*\])*\{[^}\n]*\})|(\\(?:part|chapter|section|subsection|subsubsection|paragraph|title)\*?\{[^}\n]*\})|(\\(?:[a-zA-Z@]+\*?|.))|(\$\$?[^$\n]*\$\$?)|([{}\[\]])/g;
    const BIB = /(%[^\n]*)|(@[a-zA-Z]+)(\s*\{\s*)([^,\s}]*)|(^[ \t]*[a-zA-Z_]+)(?=\s*=)|([{}])/gm;
    function paint() {
        const text = code.value, bib = /\.bib$/.test(S.cur || ''); let out = '', last = 0;
        const put = (cls, s) => { out += `<span class="${cls}">${esc(s)}</span>`; };
        if (text.length > 400000) { $('#hl').textContent = text + '\n '; paintMarks(text); return; }      // very large file: plain, still aligned
        for (const m of text.matchAll(bib ? BIB : TEX)) {
            out += esc(text.slice(last, m.index)); last = m.index + m[0].length;
            if (bib) {
                if (m[1]) put('t-com', m[1]); else if (m[2]) { put('t-env', m[2]); put('t-br', m[3]); put('t-cite', m[4]); } else if (m[5]) put('t-cmd', m[5]); else put('t-br', m[6]);
            } else if (m[1]) put('t-com', m[1]);
            else if (m[2]) put('t-env', m[2]);
            else if (m[3]) { const i = m[3].lastIndexOf('{'); put('t-cmd', m[3].slice(0, i)); put('t-br', '{'); put('t-cite', m[3].slice(i + 1, -1)); put('t-br', '}'); }
            else if (m[4]) { const i = m[4].indexOf('{'); put('t-cmd', m[4].slice(0, i)); put('t-br', '{'); put('t-head', m[4].slice(i + 1, -1)); put('t-br', '}'); }
            else if (m[5]) put('t-cmd', m[5]);
            else if (m[6]) put('t-math', m[6]);
            else put('t-br', m[7]);
        }
        $('#hl').innerHTML = out + esc(text.slice(last)) + '\n ';
        $('#hl').scrollTop = code.scrollTop; $('#hl').scrollLeft = code.scrollLeft; paintMarks(text);
    }
    code.addEventListener('input', paint);
    code.addEventListener('scroll', () => { $('#hl').scrollTop = code.scrollTop; $('#hl').scrollLeft = code.scrollLeft; $('#marks').scrollTop = code.scrollTop; });

    // ----- the "more" menu: the settings you change rarely -----
    const menu = $('#menu'), more = $('#more');
    const setMenu = open => { menu.hidden = !open; more.setAttribute('aria-expanded', String(open)); };
    more.onclick = e => { e.stopPropagation(); setMenu(menu.hidden); };
    document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { setMenu(false); more.focus(); } });
    $$('#checkseg button').forEach(b => b.onclick = () => pane(b.dataset.check));

    // ----- size and layout: text size on the left, zoom on the right, a side panel you can put away -----
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const Z = { text: Number(localStorage.getItem('editor.textZoom')) || 1, view: Number(localStorage.getItem('editor.viewZoom')) || 1 };
    function applyZoom() {
        Z.text = clamp(Math.round(Z.text * 20) / 20, 0.7, 2.2); Z.view = clamp(Math.round(Z.view * 10) / 10, 0.4, 3);
        $('#edbox').style.setProperty('--ts', `${13 * Z.text}px`); $('#tz-val').textContent = `${Math.round(Z.text * 100)}%`;
        $('#side').style.setProperty('--z', Z.view); $('#vz-val').textContent = `${Math.round(Z.view * 100)}%`;
        localStorage.setItem('editor.textZoom', Z.text); localStorage.setItem('editor.viewZoom', Z.view);
    }
    $('#tz-in').onclick = () => { Z.text += 0.1; applyZoom(); }; $('#tz-out').onclick = () => { Z.text -= 0.1; applyZoom(); };
    $('#vz-in').onclick = () => { Z.view += 0.1; applyZoom(); }; $('#vz-out').onclick = () => { Z.view -= 0.1; applyZoom(); }; $('#vz-val').onclick = () => { Z.view = 1; applyZoom(); };
    // Ctrl/Cmd + wheel zooms the side it is over (and not the whole page).
    $('#side').addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); Z.view += e.deltaY < 0 ? 0.1 : -0.1; applyZoom(); } }, { passive: false });
    code.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); Z.text += e.deltaY < 0 ? 0.05 : -0.05; applyZoom(); } }, { passive: false });
    applyZoom();
    function railShown(on) { $('#grid').classList.toggle('norail', !on); $('#railtoggle').setAttribute('aria-pressed', String(on)); localStorage.setItem('editor.rail', on ? '1' : '0'); }
    $('#railtoggle').onclick = () => railShown($('#grid').classList.contains('norail'));
    railShown(localStorage.getItem('editor.rail') !== '0');
    $$('.fold').forEach(b => { const target = b.dataset.fold === 'files' ? $('#files') : $('#refs-wrap'); const key = `editor.fold.${b.dataset.fold}`;
        const set = open => { target.hidden = !open; b.setAttribute('aria-expanded', String(open)); localStorage.setItem(key, open ? '1' : '0'); };
        b.onclick = () => set(target.hidden); set(localStorage.getItem(key) !== '0'); });

    // ----- citations under the cursor -----
    const CITE = /\\[a-zA-Z]*cite[a-zA-Z]*\*?((?:\[[^\]]*\])*)\{([^}]*)\}/g;
    function citesAt(pos) {
        const text = code.value; const ls = text.lastIndexOf('\n', pos - 1) + 1; let le = text.indexOf('\n', pos); if (le < 0) le = text.length;
        const line = text.slice(ls, le); const out = []; CITE.lastIndex = 0; let m;
        while ((m = CITE.exec(line))) {
            const start = ls + m.index, end = start + m[0].length; if (pos < start || pos > end) continue;
            const open = start + m[0].lastIndexOf('{') + 1; const opt = (m[1].match(/\[([^\]]*)\]/g) || []).pop() || ''; let at = open;
            for (const k of m[2].split(',')) { const key = k.trim(); const a = at + k.indexOf(key); out.push({ key, where: opt.slice(1, -1), from: a, to: a + key.length }); at += k.length + 1; }
        }
        return out;
    }
    function cites() {
        const list = citesAt(code.selectionStart); const box = $('#cites');
        const at = code.selectionStart; const mk = S.marksOn ? S.marks.find(m => at >= m.from && at <= m.to) : null;
        const pos = `${mk ? `<span class="mk-info ${mk.cls}"><b>${esc(mk.label)}${mk.key ? ` · ${esc(mk.key)}` : ''}</b> ${esc(mk.note || '')}${mk.fix ? `<br><span class="fixlbl">Fix</span> ${esc(mk.fix)}` : ''}</span>` : ''}<span class="stat">${S.build ? `<button class="bchip ${S.build.ok ? 'ok' : 'bad'}" title="${S.build.ok ? 'The last build worked' : 'Show what went wrong'}">${S.build.ok ? `Built · ${S.build.pages} page${S.build.pages === 1 ? '' : 's'}` : S.build.failed ? 'Build failed' : `${S.build.n} warning${S.build.n === 1 ? '' : 's'}`}</button>` : ''}${S.cred ? `<button class="mk-toggle" aria-pressed="${S.marksOn}" title="Show the citation check on the text">Marks ${S.marksOn ? 'on' : 'off'}</button>` : ''}<span id="pos">Ln ${code.value.slice(0, at).split('\n').length}</span></span>`;
        const bindToggle = () => { const t = $('.mk-toggle', box); if (t) t.onclick = () => { S.marksOn = !S.marksOn; localStorage.setItem('editor.marks', S.marksOn ? '1' : '0'); paint(); cites(); };
            const bc = $('.bchip', box); if (bc) bc.onclick = () => { S.showProblems = !S.showProblems; $('#problems').classList.toggle('on', S.showProblems && !!S.build?.n); };
            const mi = $('.mk-info', box); if (mi) mi.onclick = () => mi.classList.toggle('open'); };
        if (!list.length) { box.innerHTML = (mk ? '' : '<span class="hint">Cursor in a \\cite{…} shows its source</span>') + pos; bindToggle(); return; }
        box.innerHTML = list.map((c, i) => { const e = S.bib.get(c.key); return `<span class="chip ${e ? '' : 'bad'}"><b>${esc(c.key)}</b>${e ? `<span>${esc(e.title.slice(0, 46))}${c.where ? ` · ${esc(c.where)}` : ''}</span><button class="pill" data-open="${i}">Open source</button>` : '<span>not in refs.bib</span>'}</span>`; }).join('') + pos;
        $$('#cites [data-open]', box).forEach(b => b.onclick = () => openSource(list[+b.dataset.open].key, list[+b.dataset.open].where)); bindToggle();
    }
    ['keyup', 'click'].forEach(ev => code.addEventListener(ev, e => {
        cites();
        if (ev === 'click' && (e.ctrlKey || e.metaKey)) { const c = citesAt(code.selectionStart).find(c => code.selectionStart >= c.from && code.selectionStart <= c.to); if (c) openSource(c.key, c.where); }
    }));

    // ----- references -----
    function renderRefs() {
        const q = $('#refq').value.trim().toLowerCase(); const inBib = new Set(S.bib.keys());
        const rows = [...S.bib.values()].filter(e => !q || (e.key + ' ' + e.title + ' ' + e.author + ' ' + e.year).toLowerCase().includes(q));
        let html = rows.map(e => `<li data-k="${esc(e.key)}" title="${esc([e.title, [e.author, e.year].filter(Boolean).join(', ')].filter(Boolean).join(' — '))}"><div class="rl"><span class="k">${esc(e.key)}</span><span class="kind">${e.source ? esc(e.source.kind) : 'no file'}</span></div><span class="t">${esc(e.title)}</span><div class="acts"><button class="pill" data-cite="${esc(e.key)}">Cite</button><button class="pill" data-view="${esc(e.key)}">Open</button></div></li>`).join('');
        const loose = S.sources.filter(s => !inBib.has(s.key) && (!q || (s.title + s.key).toLowerCase().includes(q)));
        if (loose.length) html += `<li style="cursor:default"><span class="a">Sources not cited yet</span></li>` + loose.map(s => `<li><span class="k">${esc(s.id)}</span><span class="kind">${esc(s.kind)}</span><span class="t">${esc(s.title)}</span><div class="acts"><button class="pill" data-add="${esc(s.id)}">Cite and add to refs.bib</button></div></li>`).join('');
        $('#refs').innerHTML = html || '<li class="muted" style="cursor:default">No references yet. Add a source, or ask the agent.</li>';
        $$('#refs [data-cite]').forEach(b => b.onclick = () => insert(`\\cite{${b.dataset.cite}}`));
        $$('#refs [data-view]').forEach(b => b.onclick = () => openSource(b.dataset.view, ''));
        $$('#refs [data-add]').forEach(b => b.onclick = async () => { try { const r = await api(`/api/research/${enc}/cite`, { method: 'POST', body: { id: b.dataset.add } }); await reloadBib(); insert(r.latex); } catch (e) { toast(e.message, true); } });
    }
    $('#refq').oninput = renderRefs;
    async function reloadBib() { const f = await api(`/api/research/${enc}/files`); S.bib = new Map(f.bib.map(e => [e.key, e])); S.files = f.files; renderRefs(); renderFiles(); if (S.cur === 'refs.bib' && !S.dirty) await openFile('refs.bib'); }
    function insert(text) {
        if (!S.cur || S.cur === 'refs.bib') { toast('Open a section or main.tex to insert a citation.', true); return; }
        code.focus(); code.setRangeText(text, code.selectionStart, code.selectionEnd, 'end'); code.dispatchEvent(new Event('input')); view('edit');
    }
    $('#newsec').onclick = async () => { const n = prompt('Section file name (for example methods)'); if (!n) return; try { const r = await api(`/api/research/${enc}/section`, { method: 'POST', body: { name: n } }); await loadAll(); await openFile(r.path); } catch (e) { toast(e.message, true); } };
    $('#addsrc').onclick = async () => {
        const u = prompt('Address of a web page, PDF or YouTube video'); if (!u) return;
        toast('Fetching…');
        try { const r = await api(`/api/research/${enc}/sources`, { method: 'POST', body: { url: u } }); await loadAll(); toast(`Added ${r.meta?.id || 'source'}`); } catch (e) { toast(e.message, true); }
    };

    // PDFs from this device become sources (stored on the box, in the topic's local history, never pushed).
    $('#addpdf').onclick = () => $('#pdffile').click();
    async function uploadPdfs(list) {
        for (const f of list) {
            if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { toast(`${f.name} is not a PDF.`, true); continue; }
            toast(`Uploading ${f.name}…`);
            try {
                const res = await fetch(`/api/research/${enc}/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'X-Plato': '1', 'Content-Type': 'application/pdf' }, body: f, credentials: 'same-origin' });
                const r = await res.json().catch(() => ({})); if (!res.ok) throw new Error(r.error || res.statusText);
                toast(r.doi ? `Added ${r.id}: details from DOI ${r.doi}` : `Added ${r.id}. No DOI found: the agent can fill in author and year (research meta ${r.id}).`);
            } catch (e) { toast(e.message, true); }
        }
        await loadAll(); if (S.cur === 'refs.bib' && !S.dirty) await openFile('refs.bib');
    }
    $('#pdffile').onchange = e => { const l = [...e.target.files]; e.target.value = ''; uploadPdfs(l); };
    addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
    addEventListener('drop', e => { const l = [...(e.dataTransfer?.files || [])]; if (l.length) { e.preventDefault(); uploadPdfs(l); } });
    $('#version').onclick = async () => {
        if (!(await save())) return;
        try { const r = await api(`/api/research/${enc}/commit`, { method: 'POST', body: { message: 'Saved from the editor' } }); toast(r.paper || r.research ? 'Version saved' : 'Nothing has changed since the last version'); } catch (e) { toast(e.message, true); }
    };

    // ----- language and spelling -----
    // The browser underlines as you type in the topic's language; "Check spelling" asks the box, which understands LaTeX.
    function applyLang(l) { S.lang = l; code.lang = l; document.documentElement.lang = l; code.spellcheck = false; code.spellcheck = true; }
    $('#lang').onchange = async e => { try { await api(`/api/research/${enc}/language`, { method: 'POST', body: { lang: e.target.value } }); applyLang(e.target.value); if (!$('#spelling').hidden) checkSpelling(); } catch (ex) { toast(ex.message, true); } };
    async function checkSpelling() {
        const box = $('#spelling'); box.innerHTML = '<div class="empty">Checking…</div>';
        let r; try { r = await api(`/api/research/${enc}/spell`, { method: 'POST', body: { text: code.value } }); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
        if (!r.words.length) { box.innerHTML = `<div class="empty">No spelling problems in ${esc(S.cur || 'this file')}.</div>`; return; }
        box.innerHTML = `<div class="build">${r.words.length} word${r.words.length === 1 ? '' : 's'} to look at in ${esc(S.cur || '')} · ${esc(S.langs?.[r.lang] || r.lang)}</div>` + r.words.map(w => `<div class="sp"><b>${esc(w.word)}</b><span class="n">${w.n > 1 ? `×${w.n}` : ''}</span><button class="pill" data-find="${esc(w.word)}">Find</button><button class="pill" data-learn="${esc(w.word)}">It is a word</button></div>`).join('');
        $$('[data-find]', box).forEach(b => b.onclick = () => findWord(b.dataset.find));
        $$('[data-learn]', box).forEach(b => b.onclick = async () => { try { await api(`/api/research/${enc}/spell/learn`, { method: 'POST', body: { word: b.dataset.learn } }); b.closest('.sp').remove(); } catch (e) { toast(e.message, true); } });
    }
    function findWord(w) {
        const re = new RegExp(`(?<![\\p{L}\\\\])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'gu'); re.lastIndex = code.selectionEnd;
        let m = re.exec(code.value); if (!m) { re.lastIndex = 0; m = re.exec(code.value); } if (!m) return toast('Not found in this file.', true);
        view('edit'); code.focus(); code.setSelectionRange(m.index, m.index + w.length);
        const line = code.value.slice(0, m.index).split('\n').length; code.scrollTop = Math.max(0, (line - 6) * parseFloat(getComputedStyle(code).lineHeight));
    }

    // ----- tell me when an agent is done -----
    // One watcher for every kind of agent task (an edit, a citation check, a question). It runs whichever pane is open,
    // marks the pane's tab, and shows a note you can click.
    const seenDone = new Set(); let watchPrimed = false, watchTimer = null;
    function notice(msg, paneName) {
        const t = $('#toast'); t.textContent = msg; t.className = 'on act'; clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, 12000);
        t.onclick = () => { t.className = ''; pane(paneName); if (innerWidth <= 900) view('side'); };
        const tab = $(`#tabs [data-pane="${paneName === 'cites' || paneName === 'spelling' ? 'checks' : paneName}"]`); if (tab && S.pane !== paneName) tab.classList.add('ping');
        if (document.hidden) { document.title = `● ${document.title.replace(/^● /, '')}`; if (window.Notification && Notification.permission === 'granted') { try { new Notification('PlatOpypus', { body: msg, icon: '/icons/icon-192.png' }); } catch { /* not allowed here */ } } }
    }
    addEventListener('visibilitychange', () => { if (!document.hidden) document.title = document.title.replace(/^● /, ''); });
    async function watch() {
        clearTimeout(watchTimer); let qs; try { qs = (await api(`/api/research/${enc}/questions`)).questions; } catch { watchTimer = setTimeout(watch, 15000); return; }
        for (const q of qs) {
            const done = q.status !== 'waiting' && (q.toPaper !== 'requested');
            if (!watchPrimed) { if (done) seenDone.add(q.id + (q.toPaper || '')); continue; }
            const key = q.id + (q.toPaper || ''); if (!done || seenDone.has(key)) continue; seenDone.add(key);
            if (q.kind === 'check') { notice('Citation check finished: problems are marked on the text. Click for the report.', 'cites'); loadCred(); if (S.pane === 'cites') drawCiteCheck(); }
            else if (q.kind === 'edit') { notice('The agent has finished its change. Click to see what changed.', 'changes'); if (!S.dirty && S.cur) openFile(S.cur).catch(() => {}); refreshPreview(); if (S.pane === 'agent') drawAgent(); }
            else notice(q.toPaper === 'done' ? 'An answer was added to the paper.' : 'Your question has been answered (see Ask on the topic page).', 'agent');
        }
        watchPrimed = true;
        const busy = qs.some(q => (q.status === 'waiting' && !q.problem) || q.toPaper === 'requested');
        watchTimer = setTimeout(watch, busy ? 5000 : 30000);
    }
    const kick = () => { clearTimeout(watchTimer); watchTimer = setTimeout(watch, 1500); if (window.Notification && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); };

    // ----- citation check: the mechanical part at once, the agent's reading of each source on request -----
    let ccPoll = null;
    // Go to what a report row is about: the marked sentence itself when it can be found, otherwise the paragraph.
    async function jump(file, line, { key = '', uncited = null } = {}) {
        if (S.cur !== file) await openFile(file).catch(e => toast(e.message, true));
        if (key || uncited) {
            const marks = computeMarks(code.value, true); const lineAt = pos => code.value.slice(0, pos).split('\n').length;
            const pick = marks.filter(m => uncited ? m.cls === 'm-uncited' && m.note === uncited.note : m.key === key).sort((a, b) => Math.abs(lineAt(a.from) - line) - Math.abs(lineAt(b.from) - line))
                // the same rule as the marks: inside the paragraph the report names (it starts on `line`), or within a few lines
                .filter(m => { const ls = code.value.split('\n'); let end = line - 1; while (end < ls.length && ls[end].trim()) end++; const l = lineAt(m.from); return (l >= line && l <= end) || Math.abs(l - line) <= 8; })[0];
            if (!pick) toast(uncited ? 'That sentence has changed since the check: showing its paragraph.' : 'That citation has moved or been removed since the check: showing where it was.', true);
            if (pick) {
                view('edit'); if (innerWidth > 900 && S.pane !== 'cites') pane('cites');
                code.focus(); code.setSelectionRange(pick.from, pick.to);
                // scroll so the sentence sits a third of the way down, using the marks layer (it wraps exactly like the text)
                const el = [...$('#marks').querySelectorAll('mark')].find(x => x.textContent === code.value.slice(pick.from, pick.to));
                if (el) code.scrollTop = Math.max(0, el.offsetTop - code.clientHeight / 3);
                $('#marks').scrollTop = code.scrollTop; $('#hl').scrollTop = code.scrollTop; cites(); return;
            }
        }
        const ls = code.value.split('\n'); const from = ls.slice(0, Math.max(0, line - 1)).join('\n').length + (line > 1 ? 1 : 0); let to = from; for (let i = line - 1; i < ls.length && ls[i].trim(); i++) to += ls[i].length + 1;
        view('edit'); code.focus(); code.setSelectionRange(from, Math.max(from, to - 1)); code.scrollTop = Math.max(0, (line - 4) * parseFloat(getComputedStyle(code).lineHeight)); cites();
    }
    async function drawCiteCheck() {
        const box = $('#citecheck'); if (box.hidden) return;
        let d; try { d = await api(`/api/research/${enc}/citecheck`); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
        const sc = d.scan, rp = d.report, busy = d.run && d.run.status === 'waiting' && !d.run.problem;
        S.cred = rp ? { items: rp.items, uncited: rp.uncited } : null; paint();
        const queues = new Map(); if (rp) for (const i of rp.items) { const k = `${i.file}|${i.key}`; if (!queues.has(k)) queues.set(k, []); queues.get(k).push(i); }
        const byKey = new Map(); for (const it of sc.items) for (const c of it.cites) { const r = queues.get(`${it.file}|${c.key}`)?.shift(); if (r) byKey.set(`${it.n}:${c.key}:${c.where}`, r); }
        const count = v => rp ? rp.items.filter(i => i.verdict === v).length : 0; const LABEL = { supported: 'Supported', partly: 'Partly', unsupported: 'Not supported', unclear: 'Could not tell' };
        const stale = rp && sc.items.some(it => it.cites.some(c => c.source && !byKey.has(`${it.n}:${c.key}:${c.where}`)));
        // The report reads top-down: the counts, then one row per thing that needs you (a problem, where it is, what
        // to do), then everything that is fine, folded away.
        const where = it => `${esc(it.file.replace(/^sections\//, ''))} · line ${it.line}`;
        const attention = []; const fine = [];
        for (const it of sc.items) for (const c of it.cites) {
            const r = byKey.get(`${it.n}:${c.key}:${c.where}`);
            const row = { it, c, r };
            if (c.problems.length || (r && r.verdict !== 'supported')) attention.push(row); else fine.push(row);
        }
        const order = { unsupported: 0, partly: 1, unclear: 2 }; attention.sort((x, y) => (order[x.r?.verdict] ?? 3) - (order[y.r?.verdict] ?? 3));
        const rowHtml = ({ it, c, r }) => `<div class="cc-cite"><div class="cc-row">${r ? `<span class="v ${r.verdict}">${LABEL[r.verdict]}</span>` : c.problems.length ? '<span class="v unsupported">Problem</span>' : '<span class="v unclear">Not checked</span>'}<b class="ckey">${esc(c.key)}</b>${c.where ? `<span class="cwhere">${esc(c.where)}</span>` : ''}<button class="loc" data-jump="${esc(it.file)}|${it.line}" data-jkey="${esc(c.key)}">${where(it)}</button><span class="cc-acts">${c.source ? `<button class="ghost" data-src-key="${esc(c.key)}" data-src-where="${esc(c.where)}">Source</button>` : ''}${r && r.verdict !== 'supported' || c.problems.length ? `<button class="edit-it" data-jump="${esc(it.file)}|${it.line}" data-jkey="${esc(c.key)}">Edit</button>` : ''}</span></div>${c.problems.map(p => `<p class="cc-prob">${esc(p)}</p>`).join('')}${r?.note ? `<p class="cc-note">${esc(r.note)}</p>` : ''}${r?.fix ? `<p class="cc-fix"><span>Fix</span>${esc(r.fix)}</p>` : ''}</div>`;
        const nUncited = rp?.uncited.length || 0;
        box.innerHTML = `<div class="cc-top"><div><b>${sc.citations} citation${sc.citations === 1 ? '' : 's'} in ${sc.paragraphs} paragraph${sc.paragraphs === 1 ? '' : 's'}</b><span>${sc.problems ? `${sc.problems} problem${sc.problems === 1 ? '' : 's'} found without reading the sources` : 'Keys, source files, pages and times all line up'}</span></div><button class="btn pri" id="cc-run" ${busy || !sc.citations ? 'disabled' : ''}>${busy ? 'Checking…' : rp ? 'Check again' : 'Check against the sources'}</button></div>
            ${busy ? '<div class="s-note">An agent is reading each cited passage. This takes a few minutes for a long paper; you can keep writing and you will be told when it is done.</div>' : d.run?.problem ? `<div class="s-note">${esc(d.run.problem)}</div>` : !rp ? '<p class="muted cc-hint">"Check against the sources" has an agent open every cited page or moment and judge whether it supports the sentence: wrong numbers, overstated claims, the right source at the wrong page. It reports; it does not edit.</p>' : ''}
            ${rp ? (() => { const total = rp.items.length || 1; const segs = ['supported', 'partly', 'unsupported', 'unclear'].map(v => [v, count(v)]).filter(x => x[1]);
                const extra = [nUncited ? `${nUncited} statement${nUncited === 1 ? '' : 's'} need${nUncited === 1 ? 's' : ''} a citation` : '', sc.unused.length ? `${sc.unused.length} reference${sc.unused.length === 1 ? '' : 's'} never cited` : ''].filter(Boolean).join(', ');
                return `<div class="cc-state"><div class="cc-bar" role="img" aria-label="${segs.map(([v, n]) => `${n} ${LABEL[v].toLowerCase()}`).join(', ')}">${segs.map(([v, n]) => `<i class="${v}" style="flex:${n}"></i>`).join('')}</div><p class="cc-legend">${segs.map(([v, n]) => `<span class="dot ${v}"></span>${n} ${LABEL[v].toLowerCase()}`).join('<span class="sep"></span>')}</p>${extra ? `<p class="cc-extra">${extra}.</p>` : ''}<p class="cc-when">Checked ${esc(new Date(rp.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}${d.run?.by ? ` by ${esc(d.run.by)}` : ''}${stale ? '. The paper has changed since, so some citations have no verdict yet.' : ''}</p></div>`; })() : ''}
            ${attention.length ? `<h3 class="cc-h">Needs a look (${attention.length})</h3>${attention.map(rowHtml).join('')}` : rp ? '<div class="s-note ok">Every citation checked out against its source.</div>' : ''}
            ${nUncited ? `<h3 class="cc-h">Statements with no citation (${nUncited})</h3>${rp.uncited.map((u, ui) => `<div class="cc-cite"><div class="cc-row"><span class="v uncited">No citation</span><button class="loc" data-jump="${esc(u.file)}|${u.line}" data-juncited="${ui}">${where(u)}</button><span class="cc-acts"><button class="edit-it" data-jump="${esc(u.file)}|${u.line}" data-juncited="${ui}">Edit</button></span></div><p class="cc-note">${esc(u.note)}</p></div>`).join('')}` : ''}
            ${sc.unused.length ? `<h3 class="cc-h">In refs.bib but never cited (${sc.unused.length})</h3><p class="cc-note cc-keys">${sc.unused.map(k => `<span>${esc(k)}</span>`).join('')}</p>` : ''}
            ${rp?.summary ? `<details class="cc-fold"><summary>The agent's summary</summary><p class="cc-note">${esc(rp.summary)}</p></details>` : ''}
            ${fine.length ? `<details class="cc-fold" ${rp || attention.length ? '' : 'open'}><summary>${rp ? `Supported citations (${fine.length})` : `All citations (${fine.length})`}</summary>${fine.map(rowHtml).join('')}</details>` : ''}
            ${!sc.items.length ? '<div class="empty">No citations in the paper yet.</div>' : ''}`;
        $('#cc-run').onclick = async () => { if (!(await save())) return; try { await api(`/api/research/${enc}/citecheck`, { method: 'POST', body: {} }); kick(); } catch (e) { toast(e.message, true); } drawCiteCheck(); };
        $$('[data-jump]', box).forEach(b => b.onclick = () => { const [f, l] = b.dataset.jump.split('|'); jump(f, Number(l), { key: b.dataset.jkey, uncited: b.dataset.juncited !== undefined ? rp?.uncited[Number(b.dataset.juncited)] : null }); });
        $$('[data-src-key]', box).forEach(b => b.onclick = () => openSource(b.dataset.srcKey, b.dataset.srcWhere));
        clearTimeout(ccPoll); if (busy) ccPoll = setTimeout(drawCiteCheck, 6000);
    }

    // ----- changes: what is different since the last version, or what a saved version changed -----
    // Within a changed line the words that differ are marked, because a LaTeX paragraph is one long line.
    function wordDiff(a, b) {
        const A = a.split(/(\s+)/), B = b.split(/(\s+)/); if (A.length * B.length > 250000) return [esc(a), esc(b)];
        const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
        for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
        let i = 0, j = 0, x = '', y = '';
        while (i < n && j < m) { if (A[i] === B[j]) { x += esc(A[i]); y += esc(B[j]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) x += `<del>${esc(A[i++])}</del>`; else y += `<ins>${esc(B[j++])}</ins>`; }
        while (i < n) x += `<del>${esc(A[i++])}</del>`; while (j < m) y += `<ins>${esc(B[j++])}</ins>`;
        return [x.replace(/<\/del><del>/g, ''), y.replace(/<\/ins><ins>/g, '')];
    }
    function renderFileDiff(f) {
        if (f.binary) return '<div class="d-line ctx">(not text)</div>';
        let html = '', i = 0; const ls = f.lines;
        while (i < ls.length) {
            const l = ls[i];
            if (l.t === 'h') { html += `<div class="d-hunk">around line ${l.b}</div>`; i++; continue; }
            if (l.t === ' ') { html += `<div class="d-line ctx">${esc(l.s) || '&nbsp;'}</div>`; i++; continue; }
            const dels = [], adds = []; while (i < ls.length && ls[i].t === '-') dels.push(ls[i++].s); while (i < ls.length && ls[i].t === '+') adds.push(ls[i++].s);
            const pairs = Math.min(dels.length, adds.length);
            for (let k = 0; k < pairs; k++) { const [x, y] = wordDiff(dels[k], adds[k]); html += `<div class="d-line del">${x || '&nbsp;'}</div><div class="d-line add">${y || '&nbsp;'}</div>`; }
            for (let k = pairs; k < dels.length; k++) html += `<div class="d-line del"><del>${esc(dels[k]) || '&nbsp;'}</del></div>`;
            for (let k = pairs; k < adds.length; k++) html += `<div class="d-line add"><ins>${esc(adds[k]) || '&nbsp;'}</ins></div>`;
        }
        return html + (f.cut ? '<div class="d-line ctx">(more changes not shown)</div>' : '');
    }
    async function drawChanges(version = '') {
        const box = $('#changes'); if (box.hidden) return; box.innerHTML = '<div class="empty">Comparing…</div>';
        let d, h; try { [d, h] = await Promise.all([api(`/api/research/${enc}/diff${version ? `?version=${version}` : ''}`), api(`/api/research/${enc}/history`)]); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
        const vers = h.versions.filter(v => v.where === 'paper');
        const add = d.files.reduce((n, f) => n + f.added, 0), rem = d.files.reduce((n, f) => n + f.removed, 0);
        box.innerHTML = `<div class="d-top"><select id="d-ver" aria-label="What to compare"><option value="">Since the last version (not saved yet)</option>${vers.map(v => `<option value="${esc(v.id)}" ${v.id === version ? 'selected' : ''}>${esc(new Date(v.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))} · ${esc(v.message.slice(0, 60))}</option>`).join('')}</select><span class="d-stat">${d.files.length ? `<ins>+${add}</ins> <del>−${rem}</del> in ${d.files.length} file${d.files.length === 1 ? '' : 's'}` : ''}</span></div>`
            + (d.files.length ? d.files.map(f => `<section class="d-file"><header><button class="d-open" data-open-file="${esc(f.path)}">${esc(f.path)}</button><span>${f.isNew ? 'new file · ' : f.deleted ? 'deleted · ' : ''}<ins>+${f.added}</ins> <del>−${f.removed}</del></span></header>${renderFileDiff(f)}</section>`).join('') : `<div class="empty">${version ? 'That version changed nothing in the paper.' : 'Nothing has changed since the last version.'}</div>`);
        $('#d-ver').onchange = e => drawChanges(e.target.value);
        $$('[data-open-file]', box).forEach(b => b.onclick = () => openFile(b.dataset.openFile).catch(e => toast(e.message, true)));
    }

    // ----- agent: ask for a change to the paper, with a saved version to fall back on -----
    let agentPoll = null;
    async function drawAgent() {
        const box = $('#agent'); if (box.hidden) return;
        let st, qs; try { [st, qs] = await Promise.all([api(`/api/research/${enc}/versions`), api(`/api/research/${enc}/questions`)]); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
        const edits = qs.questions.filter(q => q.kind === 'edit').reverse(); const busy = edits.some(q => q.status === 'waiting' && !q.problem);
        const sel = code.value.slice(code.selectionStart, code.selectionEnd); const keep = $('#ag-text')?.value || '';
        const when = st.last ? new Date(st.last.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
        box.innerHTML = `<div class="ag-ver ${st.dirty ? 'warn' : ''}"><div><b>${st.dirty ? 'You have changes that are not in a version' : st.last ? 'Everything is saved in a version' : 'No version saved yet'}</b><span>${st.dirty ? `${esc(st.changed.join(', '))}. Save a version before the agent edits, so you can go back.` : st.last ? `Last version ${esc(when)}: ${esc(st.last.message)}` : 'Save one before the agent edits, so you can go back.'}</span></div>${st.dirty || !st.last ? '<button class="btn" id="ag-save">Save version</button>' : ''}</div>
            <textarea id="ag-text" rows="4" placeholder="What should the agent change? For example: tighten the introduction, or add a paragraph on pumped hydro losses with sources." ${busy ? 'disabled' : ''}></textarea>
            <div class="ag-row"><span class="muted">${sel.trim() ? `Your selection (${sel.length} characters) goes with it.` : `It will know you have ${esc(S.cur || 'no file')} open. Select text to point at a passage.`}</span><button class="btn pri" id="ag-run" ${busy ? 'disabled' : ''}>${busy ? 'Working…' : 'Ask the agent'}</button></div>
            <div id="ag-choice"></div>
            ${st.last && st.dirty ? '<div class="ag-row"><span class="muted">Not happy with the changes since the last version?</span><button class="pill" id="ag-revert">Go back to the last version</button></div>' : ''}
            ${edits.map(q => `<div class="ag-item"><p class="q">${esc(q.text)}</p>${q.status === 'waiting' ? `<p class="muted">${q.problem ? esc(q.problem) : 'The agent is working on it…'}</p>` : `<p class="a">${esc(q.answer || '')}</p>`}</div>`).join('')}${edits.some(q => q.status !== 'waiting') ? '<div class="ag-row"><span class="muted">See exactly what is different.</span><button class="pill" id="ag-diff">Show changes</button></div>' : ''}`;
        const dbtn = $('#ag-diff'); if (dbtn) dbtn.onclick = () => pane('changes');
        $('#ag-text').value = keep;
        const saveVersion = async msg => { if (!(await save())) return false; try { await api(`/api/research/${enc}/commit`, { method: 'POST', body: { message: msg } }); return true; } catch (e) { toast(e.message, true); return false; } };
        const sv = $('#ag-save'); if (sv) sv.onclick = async () => { if (await saveVersion('Saved from the editor')) { toast('Version saved'); drawAgent(); } };
        const run = async () => {
            const text = $('#ag-text').value.trim(); if (!text) return toast('Say what you want changed.', true);
            try { await api(`/api/research/${enc}/edits`, { method: 'POST', body: { text, file: S.cur || '', selection: sel } }); $('#ag-text').value = ''; kick(); } catch (e) { toast(e.message, true); }
            drawAgent();
        };
        $('#ag-run').onclick = async () => {
            if (!$('#ag-text').value.trim()) return toast('Say what you want changed.', true);
            if (!(await save())) return;
            const now = await api(`/api/research/${enc}/versions`);
            if (!now.dirty && now.last) return run();
            // Recommended, not forced: a version first means one tap undoes whatever the agent does.
            $('#ag-choice').innerHTML = `<div class="ag-ask"><p>Save a version first? Then you can go back if you do not like what the agent does.</p><div><button class="btn pri" id="ag-yes">Save version, then ask</button><button class="btn" id="ag-no">Ask without saving</button></div></div>`;
            $('#ag-yes').onclick = async () => { if (await saveVersion('Before the agent edits')) run(); }; $('#ag-no').onclick = run;
        };
        const rv = $('#ag-revert'); if (rv) rv.onclick = async () => {
            $('#ag-choice').innerHTML = `<div class="ag-ask"><p>Drop every change since the last version (${esc(when)})? This cannot be undone.</p><div><button class="btn" id="ag-rv-yes">Yes, go back</button><button class="btn" id="ag-rv-no">Keep my changes</button></div></div>`;
            $('#ag-rv-no').onclick = drawAgent;
            $('#ag-rv-yes').onclick = async () => { try { await api(`/api/research/${enc}/revert`, { method: 'POST', body: {} }); S.dirty = false; S.conflict = false; await loadAll(); if (S.cur) await openFile(S.cur).catch(() => openFile('main.tex')); toast('Back to the last version'); } catch (e) { toast(e.message, true); } pane('agent'); };
        };
        clearTimeout(agentPoll);
        if (busy) agentPoll = setTimeout(async () => { await drawAgent(); }, 5000);
        S.agentWasBusy = busy;
    }

    // ----- the preview, with clickable citations -----
    async function refreshPreview() {
        const box = $('#preview'); let d; try { d = await api(`/api/research/${enc}`); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
        S.detail = d; const b = d.build; let html = '';
        if (b) html += `<div class="build ${b.ok ? '' : 'bad'}">${b.ok ? `Built · ${b.pages} page${b.pages === 1 ? '' : 's'} · ${b.warnings} warning${b.warnings === 1 ? '' : 's'}` : `Build failed: ${esc((b.errors || []).join(' · ') || 'see paper/build/main.log')}`}</div>`;
        const pr = $('#problems'); const msgs = [...(b && !b.ok ? b.errors || [] : []), ...(b?.undefinedCites?.length ? [`Undefined citations: ${b.undefinedCites.join(', ')}`] : [])];
        pr.textContent = msgs.join('\n'); S.build = b ? { ok: !!b.ok && !msgs.length, failed: !b.ok, n: msgs.length, pages: b.pages } : null; pr.classList.toggle('on', msgs.length > 0 && !!S.showProblems); cites();
        if (!d.pagesAvailable) { box.innerHTML = html + '<div class="empty">Nothing built yet. Press Build.</div>'; return; }
        let links = { pages: [] }; try { links = await api(`/api/research/${enc}/links`); } catch { /* pages still show */ }
        html += Array.from({ length: d.pagesAvailable }, (_, i) => {
            const L = (links.pages[i]?.links || []).map(l => `<a class="l" href="#" data-key="${esc(l.key)}" title="${esc(l.key)}" style="left:${l.x * 100}%;top:${l.y * 100}%;width:${l.w * 100}%;height:${l.h * 100}%"></a>`).join('');
            return `<div class="pg"><img alt="Page ${i + 1}" src="/api/research/${enc}/page/${i + 1}?v=${b?.at || 0}">${L}</div>`;
        }).join('');
        box.innerHTML = html;
        $$('#preview a.l').forEach(a => a.onclick = e => { e.preventDefault(); openSource(a.dataset.key, ''); });
    }

    // ----- opening a source: PDF page, video moment, or text -----
    function parseWhere(w) {
        w = String(w || ''); const t = w.match(/(\d+):(\d{2})(?::(\d{2}))?/); const p = w.match(/(?:pp?\.?|page)[\s~]*(\d+)/i);
        return { sec: t ? (t[3] ? +t[1] * 3600 + +t[2] * 60 + +t[3] : +t[1] * 60 + +t[2]) : null, page: p ? +p[1] : null };
    }
    async function openSource(key, where) {
        const e = S.bib.get(key); const box = $('#source'); pane(S.pane === 'both' ? 'both' : 'source'); if (innerWidth <= 900) view('side');
        if (!e) { box.innerHTML = `<div class="empty">${esc(key)} is not in refs.bib.</div>`; return; }
        if (!e.source) { box.innerHTML = `<div class="src"><h2>${esc(e.title)}</h2><div class="meta">${esc([e.author, e.year].filter(Boolean).join(', '))}</div><p class="muted">This reference has no source file in the topic.${e.url ? ` <a target="_blank" rel="noopener" href="${esc(e.url)}">Open the link</a>` : ''}</p><p class="muted">Add its file or page as a source and put <b>source = {sNN}</b> in its refs.bib entry to link it.</p></div>`; return; }
        box.innerHTML = '<div class="empty">Loading…</div>';
        let v; try { v = await api(`/api/research/${enc}/source/${e.source.id}`); } catch (er) { box.innerHTML = `<div class="empty">${esc(er.message)}</div>`; return; }
        const w = parseWhere(where); const m = v.meta; const sid = e.source.id;
        let head = `<div class="src"><h2>${esc(m.title || e.title)}</h2><div class="meta"><span>${esc([m.author, m.year].filter(Boolean).join(', '))}</span><span class="pill">${esc(m.kind)}</span>${where ? `<span class="pill">${esc(where)}</span>` : ''}${m.url ? `<a target="_blank" rel="noopener" href="${esc(m.url)}">Original</a>` : ''}</div>`;
        if (e.source.hasPdf) {
            // Every page, one under another: scroll to read. A citation with a page opens there; without one, the banner
            // says what the source was cited for and which page that is on.
            const pages = m.pages || 1; const claims = (v.claims || []);
            const target = w.page ? Math.min(Math.max(w.page, 1), pages) : (claims.find(c => c.page)?.page || 1);
            const banner = w.page ? `<div class="s-note"><b>This citation points to page ${w.page}.</b>${w.page > pages ? ` The file only has ${pages} pages: the page number may be the journal's, not the file's.` : ''}</div>`
                : claims.length ? `<div class="s-note"><b>${where ? esc(where) + ': ' : ''}No page in this citation.</b> It was cited for:<ul>${claims.map(c => `<li>${esc(c.claim)}${c.quote ? ` <q>${esc(c.quote)}</q>` : ''} ${c.page ? `<button class="pill" data-goto="${c.page}">page ${c.page}${c.found ? ' (found by its quote)' : ''}</button>` : '<span class="muted">(page not known: search the text for the quote)</span>'}</li>`).join('')}</ul></div>`
                : `<div class="s-note"><b>No page in this citation,</b> and nothing was logged about why it was cited. Scroll the pages, or use Text to search.</div>`;
            box.innerHTML = head + `<div class="nav sticky"><span id="pn"></span><button class="pill" id="pcite">Cite this page</button><a class="pill" href="/api/research/${enc}/source/${sid}/original" download>Download PDF</a><button class="pill" id="ptxt">Text</button></div>${banner}<pre id="ptext" hidden></pre>
                <div id="ppages">${Array.from({ length: pages }, (_, i) => `<figure class="pg spg ${w.page === i + 1 ? 'cited' : ''}" data-p="${i + 1}"><img loading="lazy" alt="Page ${i + 1}" src="/api/research/${enc}/source/${sid}/page/${i + 1}"><figcaption>${i + 1}</figcaption></figure>`).join('')}</div></div>`;
            let cur = target; const label = () => { $('#pn', box).textContent = `Page ${cur} of ${pages}`; };
            const go = n => { const f = $(`.spg[data-p="${n}"]`, box); if (f) { box.scrollTop = f.offsetTop - 56; cur = n; label(); } };
            // which page is in view decides what "Cite this page" cites
            const io = new IntersectionObserver(es => { const vis = es.filter(x => x.isIntersecting).sort((x, y) => y.intersectionRatio - x.intersectionRatio)[0]; if (vis) { cur = Number(vis.target.dataset.p); label(); } }, { root: box, threshold: [0.2, 0.5, 0.8] });
            $$('.spg', box).forEach(f => io.observe(f)); label(); setTimeout(() => go(target), 60);
            // Real text over each page image, so you can select and copy from the PDF. Each word is placed on its printed
            // word and stretched to reach the next one (the space between is part of it, so copying keeps the spaces);
            // the page box takes the page's real shape, and everything is laid out again when the page changes size.
            const fit = fig => {
                const img = fig.querySelector('img'); const W = img.clientWidth, H = img.clientHeight; if (!W || !H) return;
                for (const d of fig.querySelectorAll('.tl > span')) { d.style.fontSize = `${Math.max(3, Number(d.dataset.h) * H * 0.86)}px`; d.style.transform = ''; const nat = d.offsetWidth; const want = Number(d.dataset.w) * W; if (nat > 0) d.style.transform = `scaleX(${want / nat})`; }
            };
            const ro = new ResizeObserver(es => es.forEach(e => fit(e.target)));
            const layer = async fig => {
                if (fig.dataset.text) return; fig.dataset.text = '1';
                const img = fig.querySelector('img'); if (img.naturalWidth) fig.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
                let r; try { r = await api(`/api/research/${enc}/source/${sid}/lines/${fig.dataset.p}`); } catch { return; }
                const tl = document.createElement('div'); tl.className = 'tl';
                tl.innerHTML = r.lines.map(l => l.words.map((wd, i) => { const next = l.words[i + 1]; const last = !next || next.x <= wd.x; const width = last ? wd.w : next.x - wd.x;
                    return `<span data-w="${width}" data-h="${l.h}" style="left:${wd.x * 100}%;top:${l.y * 100}%">${esc(wd.s)}${last ? '\n' : ' '}</span>`; }).join('')).join('');
                fig.appendChild(tl); fit(fig); ro.observe(fig);
            };
            const tio = new IntersectionObserver(es => es.forEach(x => { if (x.isIntersecting) { const img = x.target.querySelector('img'); if (img.complete && img.naturalWidth) layer(x.target); else img.addEventListener('load', () => layer(x.target), { once: true }); } }), { root: box, rootMargin: '300px' });
            $$('.spg', box).forEach(f => tio.observe(f));
            $$('[data-goto]', box).forEach(x => x.onclick = () => go(Number(x.dataset.goto)));
            $('#pcite', box).onclick = () => insert(`\\cite[p.~${cur}]{${key}}`);
            $('#ptxt', box).onclick = () => { const pre = $('#ptext', box); pre.hidden = !pre.hidden; if (!pre.hidden) { pre.textContent = v.text + (v.chars > v.text.length ? '\n\n[…]' : ''); } };
        } else if (v.transcript) {
            let hit = -1; if (w.sec != null) v.transcript.forEach((l, i) => { if (l.t <= w.sec) hit = i; });
            const link = m.url && w.sec != null ? m.url + (m.url.includes('?') ? '&' : '?') + 't=' + w.sec + 's' : '';
            box.innerHTML = head + (link ? `<div class="nav"><a class="pill" target="_blank" rel="noopener" href="${esc(link)}">Open the video at ${fmt(w.sec)}</a></div>` : '') + v.transcript.map((l, i) => `<div class="tr ${i === hit ? 'hit' : ''}"><time><button class="tcite" data-t="${fmt(l.t)}" title="Cite this moment">${fmt(l.t)}</button></time><span>${esc(l.text)}</span></div>`).join('') + '</div>';
            $$('.tcite', box).forEach(b => b.onclick = () => insert(`\\cite[${b.dataset.t}]{${key}}`));
            $('.tr.hit', box)?.scrollIntoView({ block: 'center' });
        } else {
            box.innerHTML = head + `<pre>${esc(v.text.replace(/^(#[^\n]*\n+)+/, ''))}${v.chars > v.text.length ? '\n\n[…]' : ''}</pre></div>`;
        }
    }

    // ----- go -----
    (async () => {
        if (!slug) { $('#title').textContent = 'No topic'; return; }
        try { watch(); if (localStorage.getItem('editor.pane') === 'both' && innerWidth > 900) pane('both'); await loadAll(); await openFile('main.tex').catch(() => {}); loadCred(); view(innerWidth > 900 ? 'edit' : 'edit'); await refreshPreview(); } catch (e) { toast(e.message, true); }
    })();
})();
