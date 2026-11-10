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
        S.pane = p; const both = p === 'both'; localStorage.setItem('editor.pane', both ? 'both' : 'preview');
        $('#preview').hidden = !(p === 'preview' || both); $('#source').hidden = !(p === 'source' || both); $('#spelling').hidden = p !== 'spelling';
        $('#side').classList.toggle('both', both); $('#grid').classList.toggle('wide-side', both);
        if (both && !$('#source').innerHTML.trim()) $('#source').innerHTML = '<div class="empty">Open a source from References, or click a citation, and it stays here while you write.</div>';
        if (p === 'spelling') checkSpelling(); $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.pane === p));
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
        S.cur = p; S.mtime = r.mtime; S.dirty = false; S.conflict = false; $('#code').value = r.text; gutter(); state(); renderFiles(); cites(); view('edit');
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
        const pos = `<span id="pos">Line ${code.value.slice(0, code.selectionStart).split('\n').length}</span>`;
        if (!list.length) { box.innerHTML = '<span class="muted">Put the cursor in a \\cite{…} to see its source. Ctrl/Cmd-click a key to open it.</span>' + pos; return; }
        box.innerHTML = list.map((c, i) => { const e = S.bib.get(c.key); return `<span class="chip ${e ? '' : 'bad'}"><b>${esc(c.key)}</b>${e ? `<span>${esc(e.title.slice(0, 46))}${c.where ? ` · ${esc(c.where)}` : ''}</span><button class="pill" data-open="${i}">Open source</button>` : '<span>not in refs.bib</span>'}</span>`; }).join('') + pos;
        $$('#cites [data-open]', box).forEach(b => b.onclick = () => openSource(list[+b.dataset.open].key, list[+b.dataset.open].where));
    }
    ['keyup', 'click'].forEach(ev => code.addEventListener(ev, e => {
        cites();
        if (ev === 'click' && (e.ctrlKey || e.metaKey)) { const c = citesAt(code.selectionStart).find(c => code.selectionStart >= c.from && code.selectionStart <= c.to); if (c) openSource(c.key, c.where); }
    }));

    // ----- references -----
    function renderRefs() {
        const q = $('#refq').value.trim().toLowerCase(); const inBib = new Set(S.bib.keys());
        const rows = [...S.bib.values()].filter(e => !q || (e.key + ' ' + e.title + ' ' + e.author + ' ' + e.year).toLowerCase().includes(q));
        let html = rows.map(e => `<li data-k="${esc(e.key)}"><span class="k">${esc(e.key)}</span><span class="kind">${e.source ? esc(e.source.kind) : 'no source file'}</span><span class="t">${esc(e.title)}</span><span class="a">${esc([e.author, e.year].filter(Boolean).join(', '))}</span><div class="acts"><button class="pill" data-cite="${esc(e.key)}">Insert cite</button><button class="pill" data-view="${esc(e.key)}">Open source</button></div></li>`).join('');
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

    // ----- the preview, with clickable citations -----
    async function refreshPreview() {
        const box = $('#preview'); let d; try { d = await api(`/api/research/${enc}`); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
        S.detail = d; const b = d.build; let html = '';
        if (b) html += `<div class="build ${b.ok ? '' : 'bad'}">${b.ok ? `Built · ${b.pages} page${b.pages === 1 ? '' : 's'} · ${b.warnings} warning${b.warnings === 1 ? '' : 's'}` : `Build failed: ${esc((b.errors || []).join(' · ') || 'see paper/build/main.log')}`}</div>`;
        const pr = $('#problems'); const msgs = [...(b && !b.ok ? b.errors || [] : []), ...(b?.undefinedCites?.length ? [`Undefined citations: ${b.undefinedCites.join(', ')}`] : [])];
        pr.textContent = msgs.join('\n'); pr.classList.toggle('on', msgs.length > 0);
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
            const pages = m.pages || 1; const start = Math.min(Math.max(w.page || 1, 1), pages);
            box.innerHTML = head + `<div class="nav"><button class="btn" id="pp">‹</button><span id="pn"></span><button class="btn" id="pnx">›</button><button class="pill" id="pcite">Cite this page</button><a class="pill" href="/api/research/${enc}/source/${sid}/original" download>Download PDF</a><button class="pill" id="ptxt">Text</button></div><div class="pg"><img id="pimg" alt=""></div><pre id="ptext" hidden></pre></div>`;
            let cur = start; const show = () => { $('#pn', box).textContent = `Page ${cur} of ${pages}`; $('#pimg', box).src = `/api/research/${enc}/source/${sid}/page/${cur}`; $('#pp', box).disabled = cur <= 1; $('#pnx', box).disabled = cur >= pages; };
            $('#pp', box).onclick = () => { cur--; show(); }; $('#pnx', box).onclick = () => { cur++; show(); }; show();
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
        try { if (localStorage.getItem('editor.pane') === 'both' && innerWidth > 900) pane('both'); await loadAll(); await openFile('main.tex').catch(() => {}); view(innerWidth > 900 ? 'edit' : 'edit'); await refreshPreview(); } catch (e) { toast(e.message, true); }
    })();
})();
