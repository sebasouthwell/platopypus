// Cline, the fourth agent, runs on an Ollama server you choose. Cline's own "ollama" provider only knows this machine,
// so it is pointed at that server's OpenAI-compatible API (<address>/v1), which every Ollama serves.
// PlatOpypus keeps the address, the model and an optional Ollama API key (sent as a bearer token; encrypted),
// and writes Cline's provider settings for whichever user runs it, just before it starts.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { record } from './audit.js';
import * as vault from './vault.js';

const file = path.join(config.state, 'cline.json');
const MODEL_OK = /^[A-Za-z0-9][A-Za-z0-9._:\/\[\]-]{0,99}$/;
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const base = s => String(s || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');

export function settings() { const c = load(); return { endpoint: c.endpoint || '', model: c.model || '', hasKey: !!c.key, ready: !!(c.endpoint && c.model) }; }
export function configure(body = {}) {
    const c = load();
    if (body.endpoint !== undefined) {
        const e = base(body.endpoint);
        if (e) { let u; try { u = new URL(e); } catch { throw httpError(400, 'The server address should look like http://10.0.0.20:11434'); } if (!/^https?:$/.test(u.protocol)) throw httpError(400, 'The server address starts with http:// or https://'); }
        c.endpoint = e;
    }
    if (body.model !== undefined) { const m = String(body.model || '').trim(); if (m && !MODEL_OK.test(m)) throw httpError(400, 'That model name is not valid.'); c.model = m; }
    if (body.key !== undefined) { const k = String(body.key || '').trim(); if (k) c.key = vault.encrypt(k); else delete c.key; }
    fs.writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
    record('activity', 'cline-settings', { actor: 'phone', what: `Cline: ${c.endpoint || 'no server'}${c.model ? ` · ${c.model}` : ''}` });
    return settings();
}
// The models the server has (Ollama's own list, else the OpenAI-style one), to choose from.
export async function models(endpoint) {
    const e = base(endpoint || load().endpoint); if (!e) throw httpError(400, 'Set the Ollama server address first.');
    const c = load(); const headers = c.key ? { Authorization: `Bearer ${vault.decrypt(c.key)}` } : {};
    try {
        const r = await fetch(`${e}/api/tags`, { headers, signal: AbortSignal.timeout(8000) });
        if (r.ok) { const d = await r.json(); return { endpoint: e, models: (d.models || []).map(m => ({ name: m.name, size: m.size || null, family: m.details?.family || '' })) }; }
    } catch { /* try the other one */ }
    try {
        const r = await fetch(`${e}/v1/models`, { headers, signal: AbortSignal.timeout(8000) });
        if (r.ok) { const d = await r.json(); return { endpoint: e, models: (d.data || []).map(m => ({ name: m.id })) }; }
        throw httpError(502, `The server answered ${r.status}.`);
    } catch (err) { if (err.status) throw err; throw httpError(502, `Could not reach ${e} from the box (${err.cause?.code || err.message}).`); }
}
// Write Cline's provider settings into <home>/.cline for the user who will run it (keeps any other providers there).
export function prepare(home, owner = null) {
    const c = load(); if (!c.endpoint || !c.model) throw httpError(412, 'Cline needs an Ollama server: set it on More → AI agents.');
    const dir = path.join(home, '.cline', 'data', 'settings'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = path.join(dir, 'providers.json'); let cur = {}; try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* new */ }
    const next = { version: 1, modes: {}, ...cur, lastUsedProvider: 'openai-compatible', providers: { ...(cur.providers || {}), 'openai-compatible': { settings: { provider: 'openai-compatible', apiKey: c.key ? vault.decrypt(c.key) : 'ollama', model: c.model, baseUrl: `${c.endpoint}/v1` }, updatedAt: new Date().toISOString(), tokenSource: 'manual' } } };
    fs.writeFileSync(f, JSON.stringify(next, null, 2), { mode: 0o600 });
    if (owner) { for (const p of [path.join(home, '.cline'), path.join(home, '.cline', 'data'), dir, f]) { try { fs.chownSync(p, owner.uid, owner.gid); } catch { /* best effort */ } } }
    return { model: c.model };
}
