// Sessions and sign-in hardening. Credentials themselves (passkeys, password, setup gate) live in
// credentials.js; TOTP in totp.js. This module owns: the session cookie, per-address lockout, the
// setup/CLI token check, and the two-step hand-off (ticket → code → session).
//
// Session cookie: HttpOnly, Secure (unless PORTHOLE_INSECURE_COOKIE=1 for plain-http testing), SameSite=Strict,
// 7-day rolling expiry, random 256-bit id, persisted so a restart doesn't sign the phone out.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';
import * as totp from './totp.js';
import { issueTicket, consumeTicket } from './credentials.js';

const COOKIE = 'porthole_session';
const file = path.join(config.state, 'auth-sessions.json');

let sessions = new Map(); // sid -> { created, lastSeen, ua, how }
try { sessions = new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))); } catch { /* first run */ }

function persist() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

const maxAgeMs = config.sessionDays * 86400_000;          // rolling idle expiry
const absoluteMaxMs = (parseInt(process.env.PORTHOLE_SESSION_ABSOLUTE_DAYS || '30', 10) || 30) * 86400_000; // hard cap regardless of use

// ---------- lockout: 5 failures per client address → 15 minutes ----------

const failures = new Map(); // addr -> { count, until }
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

export function clientAddr(req) {
    // X-Real-IP is only meaningful when set by our own reverse proxy on this machine; from anywhere else it is
    // attacker-controlled and would let a client rotate addresses to dodge the lockout.
    const sock = req.socket.remoteAddress || 'unknown';
    const fromProxy = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
    return (fromProxy && req.headers['x-real-ip'] ? req.headers['x-real-ip'] : sock).toString();
}

export function lockedOut(req) {
    const f = failures.get(clientAddr(req));
    if (f && f.until > Date.now()) { log('auth', `locked-out attempt from ${clientAddr(req)}`); return true; }
    return false;
}

export function recordFailure(req, what) {
    const addr = clientAddr(req);
    const f = failures.get(addr) || { count: 0, until: 0 };
    const next = { count: f.count + 1, until: 0 };
    if (next.count >= MAX_FAILS) { next.until = Date.now() + LOCK_MS; next.count = 0; log('auth', `LOCKOUT ${addr} for 15 min`); }
    failures.set(addr, next);
    log('auth', `failed ${what} from ${addr}`);
}

function clearFailures(req) { failures.delete(clientAddr(req)); }

// Constant-time compare of the setup / CLI token. Counts as a failure when wrong.
export function checkToken(req, given, expected) {
    if (lockedOut(req)) return false;
    const a = Buffer.from(String(given || '')), b = Buffer.from(String(expected || ''));
    const ok = a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
    if (!ok) recordFailure(req, 'token');
    return ok;
}

// ---------- sessions ----------

function setCookie(value, maxAgeSeconds = Math.floor(maxAgeMs / 1000)) {
    const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
    if (!config.insecureCookie) parts.push('Secure');
    return parts.join('; ');
}

function newSession(req, how, extra = {}) {
    const sid = crypto.randomBytes(32).toString('base64url');
    sessions.set(sid, { created: Date.now(), lastSeen: Date.now(), ua: (req.headers['user-agent'] || '').slice(0, 200), how, ...extra });
    persist();
    clearFailures(req);
    log('auth', `signed in via ${how} from ${clientAddr(req)}`);
    return setCookie(sid);
}

// A credential was verified. Either hand back a session, or (two-step on) a short-lived ticket for the code step.
// A box CLI signing in with an agent-user shell's token: restricted to the CLI routes (see server.js AGENT_ROUTES).
export function agentLogin(req, shell) { return { cookie: newSession(req, `shell token (${shell})`, { agent: shell }) }; }

export function finishLogin(req, how, { skipTotp = false } = {}) {
    if (totp.enabled() && !skipTotp) {
        log('auth', `${how} ok from ${clientAddr(req)}; awaiting two-step code`);
        return { needCode: true, ticket: issueTicket(clientAddr(req)) };
    }
    return { needCode: false, cookie: newSession(req, how) };
}

export function finishTotp(req, ticket, code) {
    if (!consumeTicket(String(ticket || ''), clientAddr(req))) {
        recordFailure(req, 'two-step (bad or expired ticket)');
        return { ok: false, status: 400, error: 'Sign-in expired. Start again.' };
    }
    if (!totp.verify(code)) {
        recordFailure(req, 'two-step code');
        return { ok: false, status: 401, error: 'That code is not right. Start again.' };
    }
    return { ok: true, cookie: newSession(req, 'two-step') };
}

export function logout(req) {
    const sid = parseCookies(req)[COOKIE];
    if (sid && sessions.delete(sid)) persist();
    log('auth', `logout from ${clientAddr(req)}`);
    return setCookie('', 0);
}

export function parseCookies(req) {
    const out = {};
    const header = req.headers.cookie;
    if (!header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

// Returns the session record if the request is authenticated, else null.
export function authenticate(req) {
    const sid = parseCookies(req)[COOKIE];
    if (!sid) return null;
    const s = sessions.get(sid);
    if (!s) return null;
    if (Date.now() - s.lastSeen > maxAgeMs || Date.now() - s.created > absoluteMaxMs) { sessions.delete(sid); persist(); return null; }
    if (Date.now() - s.lastSeen > 60_000) { s.lastSeen = Date.now(); persist(); }
    return s;
}

// Origin check for anything that mutates state or opens a socket. Same host as the request is always fine.
export function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // same-origin GETs and non-browser clients send none
    try {
        const o = new URL(origin);
        const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        if (o.host === host) return true;
        return config.allowedOrigins.includes(origin);
    } catch {
        return false;
    }
}

// Custom header required on state-changing requests (defence in depth next to SameSite=Strict).
export function hasCsrfHeader(req) {
    return req.headers['x-porthole'] === '1';
}

export function sessionCount() {
    return sessions.size;
}

export function revokeOtherSessions(req) {
    const keep = parseCookies(req)[COOKIE];
    let n = 0;
    for (const sid of [...sessions.keys()]) if (sid !== keep) { sessions.delete(sid); n++; }
    persist();
    log('auth', `revoked ${n} other session(s) from ${clientAddr(req)}`);
    return n;
}
