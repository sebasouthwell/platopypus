// Credentials: passkeys (WebAuthn via SimpleWebAuthn), optional password (scrypt), and the first-run setup
// gate. State lives in state/security.json alongside the TOTP settings.
//
// Rules (owner's decision):
//  - A fresh box shows a setup screen. Setup needs the one-time setup token (state/token) and creates a passkey
//    (a password may be added too). Once any credential exists the setup token no longer opens the site.
//  - Login = passkey or password, then the TOTP code when two-step is on.
//  - Reset = delete credentials from the box itself (box.ps1 reset-auth / rm security.json): no remote reset.
//  - Loopback-only token login remains for the box's own CLIs (vault, tunnel); nginx-proxied requests never qualify.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { config } from './config.js';
import { log } from './log.js';

const file = path.join(config.state, 'security.json');

function load() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function save(obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}
function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

export const allowPasswordOnly = process.env.PORTHOLE_ALLOW_PASSWORD_ONLY === '1'; // test/LAN-http convenience only

// ---------- relying party / origin ----------

export function rp(req) {
    const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
    const origin = process.env.PORTHOLE_ORIGIN || `${proto}://${host}`;
    return { rpID: process.env.PORTHOLE_RPID || hostname, rpName: 'PlatOpypus', origin };
}

export function isLoopbackDirect(req) {
    const addr = req.socket.remoteAddress || '';
    const loop = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    return loop && !req.headers['x-forwarded-for'] && !req.headers['x-real-ip'];
}

// ---------- state ----------

// full=false is what the sign-in screen (unauthenticated) may see: booleans only, no credential details.
export function summary(full = false) {
    const s = load();
    return {
        setup: !(s.passkeys?.length || s.password),       // true → show the setup screen
        hasPasskeys: (s.passkeys || []).length > 0,
        passkeys: full ? (s.passkeys || []).map(p => ({ id: p.id, name: p.name, created: p.created, lastUsed: p.lastUsed || null, transports: p.transports || [] })) : undefined,
        passwordSet: !!s.password,
        totp: !!s.totp?.enabled,
        passwordOnlyAllowed: allowPasswordOnly,
    };
}

export function hasCredentials() {
    const s = load();
    return !!(s.passkeys?.length || s.password);
}

// Called by box.ps1 reset-auth / local shell: forget every credential (TOTP too) so setup runs again.
export function resetAll() {
    save({});
    log('auth', 'ALL CREDENTIALS RESET from the box');
}

// ---------- password ----------

function scrypt(password, salt) {
    return crypto.scryptSync(String(password), salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function setPassword(password) {
    const pw = String(password || '');
    if (pw.length < 12) throw httpError(400, 'Password: at least 12 characters.');
    const salt = crypto.randomBytes(16);
    const s = load();
    s.password = { salt: salt.toString('base64'), hash: scrypt(pw, salt).toString('base64'), set: Date.now() };
    save(s);
    log('auth', 'password set');
}

export function clearPassword() {
    const s = load();
    if (!s.passkeys?.length) throw httpError(400, 'Add a passkey before removing the password, or there would be no way in.');
    delete s.password;
    save(s);
    log('auth', 'password removed');
}

export function verifyPassword(password) {
    const s = load();
    if (!s.password) return false;
    const salt = Buffer.from(s.password.salt, 'base64');
    const expected = Buffer.from(s.password.hash, 'base64');
    const got = scrypt(String(password || ''), salt);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

// ---------- passkeys ----------

const pendingReg = new Map();   // challenge -> { name, created }
const pendingAuth = new Map();  // challenge -> created
const TTL = 5 * 60_000;

function sweep(map) {
    const now = Date.now();
    for (const [k, v] of map) if (now - (v.created ?? v) > TTL) map.delete(k);
    // Unauthenticated callers can request challenges; keep the table bounded.
    while (map.size > 200) map.delete(map.keys().next().value);
}

export async function registrationOptions(req, name) {
    sweep(pendingReg);
    const s = load();
    const { rpID, rpName } = rp(req);
    const options = await generateRegistrationOptions({
        rpName, rpID,
        userName: 'owner',
        userDisplayName: 'PlatOpypus owner',
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
        excludeCredentials: (s.passkeys || []).map(p => ({ id: p.id, transports: p.transports })),
    });
    pendingReg.set(options.challenge, { name: String(name || 'This device').slice(0, 60), created: Date.now() });
    return options;
}

export async function registrationVerify(req, response) {
    sweep(pendingReg);
    const challenge = clientChallenge(response);
    const pending = challenge && pendingReg.get(challenge);
    if (!pending) throw httpError(400, 'Passkey setup expired. Try again.');
    pendingReg.delete(challenge);
    const { rpID, origin } = rp(req);
    let v;
    try {
        v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
    } catch (e) {
        throw httpError(400, `Passkey could not be verified: ${e.message}`);
    }
    if (!v.verified || !v.registrationInfo) throw httpError(400, 'Passkey could not be verified.');
    const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
    const s = load();
    s.passkeys = s.passkeys || [];
    s.passkeys.push({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports || response.response?.transports || [],
        deviceType: credentialDeviceType, backedUp: credentialBackedUp,
        name: pending.name, created: Date.now(),
    });
    save(s);
    log('auth', `passkey registered: "${pending.name}" (${credentialDeviceType}${credentialBackedUp ? ', synced' : ''})`);
    return { id: credential.id, name: pending.name };
}

export async function authenticationOptions(req) {
    sweep(pendingAuth);
    const s = load();
    if (!s.passkeys?.length) throw httpError(400, 'No passkeys registered.');
    const { rpID } = rp(req);
    const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'preferred',
        allowCredentials: s.passkeys.map(p => ({ id: p.id, transports: p.transports })),
    });
    pendingAuth.set(options.challenge, Date.now());
    return options;
}

export async function authenticationVerify(req, response) {
    sweep(pendingAuth);
    const challenge = clientChallenge(response);
    if (!challenge || !pendingAuth.has(challenge)) throw httpError(400, 'Sign-in expired. Try again.');
    pendingAuth.delete(challenge);
    const s = load();
    const pk = (s.passkeys || []).find(p => p.id === response.id || p.id === response.rawId);
    if (!pk) throw httpError(401, 'Unknown passkey.');
    const { rpID, origin } = rp(req);
    let v;
    try {
        v = await verifyAuthenticationResponse({
            response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false,
            credential: { id: pk.id, publicKey: Buffer.from(pk.publicKey, 'base64url'), counter: pk.counter, transports: pk.transports },
        });
    } catch (e) {
        throw httpError(401, `Passkey rejected: ${e.message}`);
    }
    if (!v.verified) throw httpError(401, 'Passkey rejected.');
    pk.counter = v.authenticationInfo.newCounter;
    pk.lastUsed = Date.now();
    save(s);
    log('auth', `passkey ok: "${pk.name}"`);
    return { id: pk.id, name: pk.name };
}

export function removePasskey(id) {
    const s = load();
    const list = s.passkeys || [];
    const idx = list.findIndex(p => p.id === id);
    if (idx < 0) throw httpError(404, 'No such passkey.');
    if (list.length === 1 && !s.password) throw httpError(400, 'This is the only way in. Add another passkey or a password first.');
    const [gone] = list.splice(idx, 1);
    save(s);
    log('auth', `passkey removed: "${gone.name}"`);
}

export function renamePasskey(id, name) {
    const s = load();
    const pk = (s.passkeys || []).find(p => p.id === id);
    if (!pk) throw httpError(404, 'No such passkey.');
    pk.name = String(name || '').slice(0, 60) || pk.name;
    save(s);
}

function clientChallenge(response) {
    try {
        const json = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'));
        return json.challenge;
    } catch {
        return null;
    }
}

// ---------- second step (TOTP) tickets ----------
// After a credential is verified, when two-step is on, the client gets a short-lived ticket and must present it
// with a code. The ticket is bound to the client address.

const tickets = new Map(); // ticket -> { addr, created }

export function issueTicket(addr) {
    for (const [k, v] of tickets) if (Date.now() - v.created > 2 * 60_000) tickets.delete(k);
    const t = crypto.randomBytes(24).toString('base64url');
    tickets.set(t, { addr, created: Date.now() });
    return t;
}

export function consumeTicket(ticket, addr) {
    const v = tickets.get(ticket);
    if (!v) return false;
    tickets.delete(ticket);
    return v.addr === addr && Date.now() - v.created <= 2 * 60_000;
}
