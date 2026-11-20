// Hand-offs shown at the top of an app (Research, Conspiracy, Job Hunt, Security Lab): work an agent elsewhere proposed
// for this app. Approve & start creates it and starts the app's agent; the result goes back to the asking project.
let C = null;
export function setup(ctx) { C = ctx; }
const APP_OF = { research: 'research', cases: 'case', jobs: 'jobs', lab: 'lab' };
const TITLE = { research: 'Research', case: 'Conspiracy', jobs: 'Job Hunt', lab: 'Security Lab' };
const when = t => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const size = n => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export async function render(page) {
    const app = APP_OF[page]; const box = document.getElementById(`ho-${page}`); if (!app || !box) return;
    let items = []; try { items = (await C.api(`/api/handoffs?app=${app}`)).items; } catch { box.innerHTML = ''; return; }
    items = items.filter(h => h.status !== 'declined' && (h.status !== 'done' || Date.now() - (h.finished || 0) < 7 * 86400_000));
    if (!items.length) { box.innerHTML = ''; box.hidden = true; return; }
    box.hidden = false; box.innerHTML = items.map(card).join(''); wire(box, items, page);
}
function card(h) {
    const { esc, icon } = C; const from = h.from.project ? `/Projects/${h.from.project}` : h.from.cwd;
    const head = h.status === 'proposed' ? 'Proposed by an agent' : h.status === 'scope' ? 'Approved: verify the targets first' : h.status === 'running' ? 'Agent working on it' : h.status === 'done' ? 'Done: result sent back' : h.status;
    return `<div class="ho-card ${esc(h.status)}"><div class="ho-h"><span class="ho-tag">${icon('claude')}${esc(head)}</span><span class="muted">from ${esc(from)} · ${esc(when(h.created))}</span></div>
        <b class="ho-t">${esc(h.title)}</b>
        <details class="ho-brief" ${h.status === 'proposed' ? 'open' : ''}><summary>Brief</summary><p>${esc(h.brief)}</p>${h.why ? `<p class="muted">Why: ${esc(h.why)}</p>` : ''}</details>
        ${h.files.length ? `<div class="ho-files">${h.files.map(f => `<span>${icon('file')}${esc(f.name)} <i>${size(f.size)}</i></span>`).join('')}</div>` : ''}
        ${h.targets?.length ? `<div class="ho-files">${h.targets.map(t => `<span>${icon('shield')}${esc(t)}</span>`).join('')}</div>` : ''}
        ${h.status === 'scope' ? '<p class="ho-note">Nothing runs until each target is verified (DNS record) or you declare you are authorised, in the engagement\'s Scope. IP addresses and ranges are not added for you: add them there yourself.</p>' : ''}
        ${h.status === 'done' && h.result ? `<details class="ho-brief"><summary>Result</summary><pre class="ho-res">${esc(h.result)}</pre></details>` : ''}
        <div class="r-actions">${h.status === 'proposed' ? `<button class="btn pri" data-ho-ok="${h.id}">${icon('check')}Approve &amp; start</button><button class="btn" data-ho-edit="${h.id}">${icon('pencil')}Edit</button><button class="btn" data-ho-no="${h.id}">${icon('x')}Decline</button>` : ''}
        ${h.status === 'scope' ? `<button class="btn pri" data-ho-start="${h.id}">${icon('claude')}Start the agent</button>${h.ref?.url ? `<a class="btn" href="${esc(h.ref.url)}">${icon('shield')}Open the engagement</a>` : ''}` : ''}
        ${h.status === 'running' && h.shell ? `<button class="btn" data-ho-watch="${esc(h.shell)}">${icon('eye')}Watch</button>` : ''}
        ${(h.status === 'running' || h.status === 'done') && h.ref?.url && h.app !== 'jobs' ? `<a class="btn" href="${esc(h.ref.url)}">${icon('folder-open')}Open it</a>` : ''}</div></div>`;
}
function wire(box, items, page) {
    const { esc, icon } = C; const $$ = s => [...box.querySelectorAll(s)]; const find = id => items.find(h => h.id === id);
    const approve = async (id, edits = {}) => { try { await C.api(`/api/handoffs/${id}/approve`, { method: 'POST', body: edits }); C.toast(find(id).app === 'lab' ? 'Engagement made: verify its targets, then start the agent' : 'Started: the result goes back to the project that asked'); } catch (e) { C.toast(e.message, true); } render(page); };
    $$('[data-ho-ok]').forEach(b => b.onclick = async () => { const h = find(b.dataset.hoOk); if (!await C.confirmDialog({ title: `Approve "${h.title}"?`, text: h.app === 'lab' ? 'A Security Lab engagement is made with these targets to verify. Nothing is tested until you verify or declare them and start the agent.' : `A ${TITLE[h.app]} ${h.app === 'jobs' ? 'search' : h.app === 'case' ? 'case' : 'topic'} is made and its agent starts now, unattended, as the agent user. The result goes back to ${h.from.project || 'the asking folder'}.`, action: 'Approve' })) return; approve(h.id); });
    $$('[data-ho-no]').forEach(b => b.onclick = async () => { try { await C.api(`/api/handoffs/${b.dataset.hoNo}/decline`, { method: 'POST', body: {} }); C.toast('Declined; the asking project is told'); } catch (e) { C.toast(e.message, true); } render(page); });
    $$('[data-ho-watch]').forEach(b => b.onclick = () => C.openTerminal(b.dataset.hoWatch, TITLE[items[0].app]));
    $$('[data-ho-start]').forEach(b => b.onclick = async () => { const h = find(b.dataset.hoStart); if (!await C.confirmDialog({ title: 'Start the Security Lab agent?', text: 'It runs unattended against the verified targets in scope only. If the agent is Claude, this also confirms you have read the Security Lab warning about using Claude for autonomous testing.', action: 'Start' })) return; try { await C.api(`/api/handoffs/${h.id}/start`, { method: 'POST', body: { ack: true } }); C.toast('Started'); } catch (e) { C.toast(e.message, true); } render(page); });
    $$('[data-ho-edit]').forEach(b => b.onclick = () => {
        const h = find(b.dataset.hoEdit);
        const { panel, close } = C.openDialog(`<h2>${icon('pencil')}Edit before approving</h2>
            <div class="field"><label for="ho-t">Title</label><input id="ho-t" maxlength="120" value="${esc(h.title)}"></div>
            <div class="field"><label for="ho-b">Brief</label><textarea id="ho-b" rows="8" maxlength="6000">${esc(h.brief)}</textarea></div>
            ${h.app === 'lab' ? `<div class="field"><label for="ho-g">Targets (one per line)</label><textarea id="ho-g" rows="3">${esc((h.targets || []).join('\n'))}</textarea></div>` : ''}
            <div class="buttons"><button data-close>Cancel</button><button class="primary" data-go>Approve &amp; start</button></div>`);
        panel.querySelector('[data-go]').onclick = () => { const body = { title: panel.querySelector('#ho-t').value, brief: panel.querySelector('#ho-b').value }; const g = panel.querySelector('#ho-g'); if (g) body.targets = g.value.split(/\s+/).filter(Boolean); close(); approve(h.id, body); };
    });
}
