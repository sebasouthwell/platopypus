// Credential vault, modelled on n8n's credentials: each entry is a service + auth style with typed fields,
// stored AES-256-GCM encrypted in state/vault.json (key in state/vault.key, 0600). Fields are exported to
// shells as <PREFIX>_<FIELD> environment variables; OAuth2 entries hold client details plus the tokens
// obtained through Porthole's own redirect endpoint and are refreshed automatically when they expire.
//
// Scope: "general" entries reach every shell Porthole starts; a project-scoped entry (relative folder path)
// only reaches shells started inside that folder. The `vault` CLI reads the same files, so agents can fetch
// a token without the user pasting it into a prompt. Values are never listed; reveal is explicit and logged.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';
import { record } from './audit.js';
import { byKey, fieldsFor, AUTH_STYLES, OAUTH2_GENERIC } from './catalog.js';

const keyFile = path.join(config.state, 'vault.key');
const dataFile = path.join(config.state, 'vault.json');

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

function loadKey() {
    try {
        const k = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
        if (k.length === 32) return k;
    } catch { /* create */ }
    const k = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, k.toString('base64') + '\n', { mode: 0o600 });
    log('vault', `created new vault key at ${keyFile}`);
    return k;
}
const key = loadKey();

export function encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}
export function decrypt(blob) {
    const [iv, tag, ct] = String(blob).split('.').map(s => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

function load() { try { return JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch { return { items: [] }; } }
function save(db) { const tmp = dataFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 }); fs.renameSync(tmp, dataFile); }

const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED = new Set(['PATH', 'HOME', 'SHELL', 'USER', 'TERM', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PORTHOLE_TOKEN', 'NODE_OPTIONS']);
const toEnv = s => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1').slice(0, 64);
const hintOf = v => { const s = String(v || '').trim(); return s.length <= 6 ? '••••' : `••••${s.slice(-4)}`; };

// ---------- normalisation (v1 single-value items → v2 shape) ----------

function normalise(it) {
    if (it.fields) return it;
    // v1: { envName, value, kind }
    return {
        ...it,
        provider: it.provider || 'custom',
        style: 'custom',
        prefix: null,
        fields: { value: it.value },
        envMap: { value: it.envName },
        labels: { value: it.name },
        secretFields: ['value'],
    };
}

// Environment variable name for a field of an item.
function envNameFor(it, fieldName) {
    if (it.envMap && it.envMap[fieldName]) return it.envMap[fieldName];
    const def = (it.style && AUTH_STYLES[it.style]) ? AUTH_STYLES[it.style].fields.find(f => f.name === fieldName) : null;
    return `${it.prefix}_${def ? def.env : toEnv(fieldName)}`;
}

function publicView(raw) {
    const it = normalise(raw);
    const fieldNames = Object.keys(it.fields || {});
    let missing = [];
    try { missing = (fieldsFor(it.style) || []).filter(d => !d.derived && !d.optional && !(d.name in (it.fields || {}))); } catch { /* legacy style */ }
    return {
        id: it.id, name: it.name, provider: it.provider, title: it.title || it.name, style: it.style, prefix: it.prefix,
        scope: it.scope, notes: it.notes || '', inShells: it.scope === 'general' && !!it.inShells, created: it.created, updated: it.updated, lastUsed: it.lastUsed || null,
        fields: [
            ...fieldNames.map(f => ({ name: f, env: envNameFor(it, f), label: it.labels?.[f] || f, secret: (it.secretFields || []).includes(f), hint: (it.secretFields || []).includes(f) ? hintOf(safeDecrypt(it.fields[f])) : safeDecrypt(it.fields[f]) })),
            ...missing.map(d => ({ name: d.name, env: envNameFor(it, d.name), label: d.label, secret: !!d.secret, hint: '', missing: true })),
        ],
        incomplete: missing.map(d => d.label),
        oauth: it.oauth ? { connected: !!it.fields.accessToken, expiresAt: it.oauth.expiresAt || null, scopes: it.oauth.scopes || '', authUrl: it.oauth.authUrl, tokenUrl: it.oauth.tokenUrl, pkce: !!it.oauth.pkce, clientAuth: it.oauth.clientAuth } : null,
        // legacy convenience for older UI code
        envName: fieldNames.length === 1 ? envNameFor(it, fieldNames[0]) : null,
        hint: fieldNames.length ? hintOf(safeDecrypt(it.fields[fieldNames[0]])) : '••••',
        kind: it.style === 'oauth2' ? 'oauth' : it.style === 'basic' ? 'password' : 'api_key',
    };
}
function safeDecrypt(blob) { try { return decrypt(blob); } catch { return ''; } }

export function list() {
    return load().items.map(publicView).sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}

// ---------- create / update ----------

function validateScope(scope) {
    let s = String(scope ?? 'general').trim();
    if (s !== 'general') {
        s = s.replace(/^\/+|\/+$/g, '');
        if (!s || s.split('/').some(seg => seg === '..' || seg === '')) throw httpError(400, 'Scope: "general" or a project folder path.');
    }
    return s;
}

// body: { provider, style, name, prefix, scope, notes, fields: { fieldName: value }, oauth?: { authUrl, tokenUrl, scopes, clientAuth, pkce }, envMap? (custom) }
export function create(body) {
    // Legacy single-value form (still used by the CLI tests and old clients).
    if (body.value !== undefined && !body.fields) return createLegacy(body);

    const svc = byKey[body.provider || 'custom'];
    if (!svc) throw httpError(400, 'Unknown service.');
    const style = body.style;
    if (!svc.auth[style]) throw httpError(400, `${svc.title} does not support "${style}" here.`);
    const defs = fieldsFor(style);
    const name = String(body.name || svc.title).trim().slice(0, 80);
    const prefix = toEnv(body.prefix || svc.env);
    if (!ENV_RE.test(prefix) || RESERVED.has(prefix)) throw httpError(400, 'Environment prefix: UPPER_SNAKE_CASE.');
    const scope = validateScope(body.scope);
    const fields = {}, secretFields = [], labels = {};
    for (const d of defs) {
        const v = body.fields?.[d.name];
        if (d.derived) continue; // tokens come from the OAuth flow
        // Missing required fields are allowed: the item is saved as incomplete and finished later from the Vault.
        if (v !== undefined && v !== '') { if (String(v).length > 64 * 1024) throw httpError(413, `${d.label} is too large.`); fields[d.name] = encrypt(v); }
        if (d.secret) secretFields.push(d.name);
        labels[d.name] = d.label;
    }
    if (!Object.keys(fields).length && style !== 'oauth2') throw httpError(400, 'Enter at least one value; the rest can be filled in later from the Vault.');
    // Custom env mapping (custom service): { fieldName: ENV_NAME }
    const envMap = {};
    if (body.envMap && typeof body.envMap === 'object') {
        for (const [f, e] of Object.entries(body.envMap)) {
            if (!(f in fields) && !defs.some(d => d.name === f)) continue;
            if (!ENV_RE.test(String(e)) || RESERVED.has(String(e))) throw httpError(400, `Bad environment name for ${f}.`);
            envMap[f] = String(e);
        }
    }
    let oauth = null;
    if (style === 'oauth2') {
        const preset = svc.auth.oauth2 === true ? OAUTH2_GENERIC : svc.auth.oauth2;
        oauth = {
            authUrl: String(body.oauth?.authUrl || preset.authUrl || '').trim(),
            tokenUrl: String(body.oauth?.tokenUrl || preset.tokenUrl || '').trim(),
            scopes: String(body.fields?.scopes ?? preset.scopes ?? '').trim(),
            clientAuth: ['header', 'body'].includes(body.oauth?.clientAuth) ? body.oauth.clientAuth : (preset.clientAuth || 'body'),
            pkce: body.oauth?.pkce !== undefined ? !!body.oauth.pkce : !!preset.pkce,
            authParams: preset.authParams || {},
            scopeSeparator: preset.scopeSeparator || ' ',
        };
        if (!/^https:\/\//.test(oauth.authUrl) || !/^https:\/\//.test(oauth.tokenUrl)) throw httpError(400, 'OAuth2 needs https authorize and token URLs.');
        fields.scopes = encrypt(oauth.scopes); labels.scopes = 'Scopes';
    }
    const db = load();
    const item = { id: crypto.randomBytes(8).toString('hex'), provider: svc.key, title: svc.title, style, name, prefix, scope, inShells: scope === 'general' && !!body.inShells, notes: String(body.notes || '').slice(0, 500), fields, secretFields, labels, envMap, oauth, created: Date.now(), updated: Date.now() };
    // Avoid two entries exporting the same variable into the same scope.
    for (const existing of db.items.map(normalise)) {
        if (existing.scope !== scope) continue;
        for (const f of Object.keys(fields)) if (Object.keys(existing.fields).some(ef => envNameFor(existing, ef) === envNameFor(item, f))) throw httpError(409, `${envNameFor(item, f)} already exists in that scope.`);
    }
    db.items.push(item); save(db);
    log('vault', `added ${svc.key}/${style} "${name}" (${prefix}_*, scope ${scope})`);
    return publicView(item);
}

function createLegacy(body) {
    const name = String(body.name || '').trim().slice(0, 80);
    const provider = String(body.provider || 'custom').trim().toLowerCase().slice(0, 40) || 'custom';
    const envName = String(body.envName || toEnv(`${provider}_${name}`)).trim();
    if (!name) throw httpError(400, 'Give the token a name.');
    if (!ENV_RE.test(envName) || RESERVED.has(envName)) throw httpError(400, 'Environment name: UPPER_SNAKE_CASE, letters, digits and underscores.');
    const value = String(body.value ?? '');
    if (!value.trim()) throw httpError(400, 'Paste the token value.');
    const scope = validateScope(body.scope);
    const db = load();
    if (db.items.map(normalise).some(i => i.scope === scope && Object.keys(i.fields).some(f => envNameFor(i, f) === envName))) throw httpError(409, `${envName} already exists in that scope.`);
    const item = { id: crypto.randomBytes(8).toString('hex'), provider, title: name, style: 'custom', name, prefix: null, scope, notes: String(body.notes || '').slice(0, 500), fields: { value: encrypt(value) }, secretFields: ['value'], labels: { value: name }, envMap: { value: envName }, oauth: null, created: Date.now(), updated: Date.now(), kind: body.kind || 'api_key' };
    db.items.push(item); save(db);
    log('vault', `added ${provider}/${envName} (legacy form, scope ${scope})`);
    return publicView(item);
}

export function update(id, body) {
    const db = load();
    const idx = db.items.findIndex(i => i.id === id);
    if (idx < 0) throw httpError(404, 'No such credential.');
    const it = normalise(db.items[idx]);
    if (body.name) it.name = String(body.name).trim().slice(0, 80);
    if (body.notes !== undefined) it.notes = String(body.notes).slice(0, 500);
    if (body.scope !== undefined) it.scope = validateScope(body.scope);
    if (body.inShells !== undefined) it.inShells = !!body.inShells && it.scope === 'general';
    if (body.prefix && it.prefix) { const p = toEnv(body.prefix); if (!ENV_RE.test(p) || RESERVED.has(p)) throw httpError(400, 'Bad prefix.'); it.prefix = p; }
    if (body.envName && it.envMap?.value) { if (!ENV_RE.test(body.envName) || RESERVED.has(body.envName)) throw httpError(400, 'Bad environment name.'); it.envMap.value = body.envName; }
    if (body.fields && typeof body.fields === 'object') {
        for (const [f, v] of Object.entries(body.fields)) {
            if (v === undefined || v === null || v === '') continue;
            if (String(v).length > 64 * 1024) throw httpError(413, 'Value too large.');
            it.fields[f] = encrypt(v);
            if (!it.labels[f]) it.labels[f] = f;
        }
    }
    if (typeof body.value === 'string' && body.value.trim() && it.fields.value !== undefined) it.fields.value = encrypt(body.value);
    if (it.oauth && body.oauth) {
        for (const k of ['authUrl', 'tokenUrl', 'clientAuth']) if (body.oauth[k]) it.oauth[k] = String(body.oauth[k]);
        if (body.oauth.pkce !== undefined) it.oauth.pkce = !!body.oauth.pkce;
        if (body.fields?.scopes !== undefined) it.oauth.scopes = String(body.fields.scopes);
    }
    it.updated = Date.now();
    db.items[idx] = it; save(db);
    log('vault', `updated ${it.provider} "${it.name}"`);
    return publicView(it);
}

export function remove(id) {
    const db = load();
    const idx = db.items.findIndex(i => i.id === id);
    if (idx < 0) throw httpError(404, 'No such credential.');
    const [it] = db.items.splice(idx, 1); save(db);
    log('vault', `removed ${it.provider} "${it.name}"`);
}

export async function reveal(id, who = '', field = null) {
    const db = load();
    const raw = db.items.find(i => i.id === id);
    if (!raw) throw httpError(404, 'No such credential.');
    const it = normalise(raw);
    await refreshIfNeeded(it, db);
    it.lastUsed = Date.now(); save(db);
    const out = {};
    for (const f of Object.keys(it.fields)) if (!field || field === f) out[envNameFor(it, f)] = decrypt(it.fields[f]);
    log('vault', `REVEALED ${it.provider} "${it.name}"${field ? ` (${field})` : ''} to ${who}`);
    record('credential', 'vault-revealed', { actor: 'phone', via: who, what: it.name, names: Object.keys(out), project: it.scope && it.scope !== 'general' ? it.scope : null });
    const first = Object.keys(out)[0];
    return { id: it.id, values: out, envName: first, value: first ? out[first] : undefined };
}

// Decrypted fields of one entry, by field name, for Porthole's own use (alerts send with the Telegram bot token).
// Never returned by an API route.
export function valuesOf(id) {
    const raw = load().items.find(i => i.id === id);
    if (!raw) return null;
    const it = normalise(raw);
    const fields = {};
    for (const f of Object.keys(it.fields || {})) fields[f] = safeDecrypt(it.fields[f]);
    return { id: it.id, name: it.name, provider: it.provider, style: it.style, scope: it.scope, fields };
}

// Environment variables for a shell starting in `cwd` (absolute): general + matching project scope.
// project: 'exact' → general + the project whose folder is exactly `cwd` (vault get, live services);
//          'none'  → general only.
// shells: only the general items marked "put into new shells" (1.21.0). Everything else is fetched per use with
// `vault get` / `vault run`, so each use is in the audit log; a value sitting in a shell's environment is not.
// A sub-folder of a project never qualifies: project credentials are read deliberately from the project's main folder.
export async function envFor(cwd, { project = 'exact', shells = false } = {}) {
    const rel = path.relative(config.root, cwd).split(path.sep).join('/');
    const db = load();
    const env = {};
    let dirty = false;
    for (const raw of db.items) {
        const it = normalise(raw);
        const applies = it.scope === 'general' || (project === 'exact' && rel === it.scope);
        if (!applies || (shells && !(it.scope === 'general' && it.inShells))) continue;
        try { if (await refreshIfNeeded(it, db, false)) dirty = true; } catch (e) { log('vault', `refresh failed for ${it.provider} "${it.name}": ${e.message}`); }
        for (const f of Object.keys(it.fields)) { try { env[envNameFor(it, f)] = decrypt(it.fields[f]); } catch { /* corrupt entry */ } }
    }
    if (dirty) save(db);
    return env;
}
// Synchronous variant for callers that cannot await (no refresh).
export function envForSync(cwd, { project = 'exact' } = {}) {
    const rel = path.relative(config.root, cwd).split(path.sep).join('/');
    const env = {};
    for (const raw of load().items) {
        const it = normalise(raw);
        if (!(it.scope === 'general' || (project === 'exact' && rel === it.scope))) continue;
        for (const f of Object.keys(it.fields)) { try { env[envNameFor(it, f)] = decrypt(it.fields[f]); } catch { /* skip */ } }
    }
    return env;
}

// ---------- OAuth2 ----------

const pending = new Map(); // state -> { id, verifier, created }

export function redirectUri(origin) { return `${origin.replace(/\/$/, '')}/oauth/callback`; }

export function authorizeUrl(id, origin) {
    const it = normalise(load().items.find(i => i.id === id) || {});
    if (!it.id || !it.oauth) throw httpError(400, 'Not an OAuth2 credential.');
    const clientId = it.fields.clientId ? decrypt(it.fields.clientId) : '';
    if (!clientId) throw httpError(400, 'Set the client ID first.');
    for (const [k, v] of pending) if (Date.now() - v.created > 10 * 60_000) pending.delete(k);
    const state = crypto.randomBytes(16).toString('base64url');
    const verifier = it.oauth.pkce || !it.fields.clientSecret ? crypto.randomBytes(32).toString('base64url') : null;
    pending.set(state, { id, verifier, created: Date.now(), origin });
    const u = new URL(it.oauth.authUrl);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri(origin));
    if (it.oauth.scopes) u.searchParams.set('scope', it.oauth.scopes.split(/[\s,]+/).filter(Boolean).join(it.oauth.scopeSeparator || ' '));
    u.searchParams.set('state', state);
    for (const [k, v] of Object.entries(it.oauth.authParams || {})) u.searchParams.set(k, v);
    if (verifier) { u.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url')); u.searchParams.set('code_challenge_method', 'S256'); }
    log('vault', `oauth start for ${it.provider} "${it.name}"`);
    return { url: u.toString(), redirectUri: redirectUri(origin) };
}

export async function handleCallback(query) {
    const { code, state, error, error_description: desc } = query;
    const p = state && pending.get(state);
    if (!p) throw httpError(400, 'This sign-in link has expired or was already used. Start again from the Vault.');
    pending.delete(state);
    if (error) throw httpError(400, `${error}: ${desc || 'the provider refused'}`);
    const db = load();
    const idx = db.items.findIndex(i => i.id === p.id);
    if (idx < 0) throw httpError(404, 'Credential was removed.');
    const it = normalise(db.items[idx]);
    const tokens = await tokenRequest(it, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(p.origin), ...(p.verifier ? { code_verifier: p.verifier } : {}) });
    storeTokens(it, tokens);
    db.items[idx] = it; save(db);
    log('vault', `oauth connected ${it.provider} "${it.name}"${tokens.refresh_token ? ' (with refresh token)' : ''}`);
    return { id: it.id, name: it.name, provider: it.provider };
}

function storeTokens(it, t) {
    if (!t.access_token) throw httpError(502, 'Provider returned no access token.');
    it.fields.accessToken = encrypt(t.access_token); it.labels.accessToken = 'Access token'; if (!it.secretFields.includes('accessToken')) it.secretFields.push('accessToken');
    if (t.refresh_token) { it.fields.refreshToken = encrypt(t.refresh_token); it.labels.refreshToken = 'Refresh token'; if (!it.secretFields.includes('refreshToken')) it.secretFields.push('refreshToken'); }
    it.oauth.expiresAt = t.expires_in ? Date.now() + Number(t.expires_in) * 1000 : null;
    it.oauth.tokenType = t.token_type || 'Bearer';
    it.oauth.obtainedAt = Date.now();
    if (t.scope) it.oauth.grantedScopes = t.scope;
    it.updated = Date.now();
}

async function tokenRequest(it, params) {
    const clientId = decrypt(it.fields.clientId);
    const clientSecret = it.fields.clientSecret ? decrypt(it.fields.clientSecret) : '';
    const body = new URLSearchParams(params);
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (it.oauth.clientAuth === 'header' && clientSecret) headers.Authorization = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    else { body.set('client_id', clientId); if (clientSecret) body.set('client_secret', clientSecret); }
    const res = await fetch(it.oauth.tokenUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = Object.fromEntries(new URLSearchParams(text)); }
    if (!res.ok || json.error) throw httpError(502, `Token endpoint: ${json.error_description || json.error || res.status}`);
    return json;
}

// Refresh when the access token expires within 2 minutes and a refresh token exists. Returns true if changed.
export async function refreshIfNeeded(it, db = null, persistNow = true) {
    if (!it.oauth || !it.fields.refreshToken || !it.oauth.expiresAt) return false;
    if (it.oauth.expiresAt - Date.now() > 120_000) return false;
    const tokens = await tokenRequest(it, { grant_type: 'refresh_token', refresh_token: decrypt(it.fields.refreshToken) });
    if (!tokens.refresh_token) delete tokens.refresh_token; // keep the old one when the provider doesn't rotate
    storeTokens(it, tokens);
    log('vault', `refreshed ${it.provider} "${it.name}"`);
    if (persistNow) { const d = db || load(); const i = d.items.findIndex(x => x.id === it.id); if (i >= 0) { d.items[i] = it; save(d); } }
    return true;
}

export async function refresh(id) {
    const db = load();
    const idx = db.items.findIndex(i => i.id === id);
    if (idx < 0) throw httpError(404, 'No such credential.');
    const it = normalise(db.items[idx]);
    if (!it.oauth) throw httpError(400, 'Not an OAuth2 credential.');
    if (!it.fields.refreshToken) throw httpError(400, 'No refresh token; connect again.');
    it.oauth.expiresAt = 0;
    await refreshIfNeeded(it, db, false);
    db.items[idx] = it; save(db);
    return publicView(it);
}
