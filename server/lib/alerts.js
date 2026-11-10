// Push alerts to the phone through a Telegram bot from the Vault (a general "Telegram bot + chat" entry).
// PlatOpypus reads the bot token itself when it sends; it is never given to agents or put in a shell.
//
// What is sent: a one-line summary, the project, and for root requests the command as asked. Never secret values,
// command output or logs. Alerts only point at PlatOpypus: approving or denying is done in PlatOpypus after signing in,
// never from Telegram (a Telegram account must not become a way to grant root).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';
import * as vault from './vault.js';

const file = path.join(config.state, 'alerts.json');
// The Bot API address; the smoke suite points this at a stand-in.
const TG_API = (process.env.PORTHOLE_TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');

export const KINDS = [
    { key: 'root', title: 'Root requests waiting for you', sub: 'An agent asked to run something as root.', def: true },
    { key: 'signin', title: 'Sign-ins and lockouts', sub: 'Someone signed in to PlatOpypus, or an address was locked out after failed attempts.', def: true },
    { key: 'link', title: 'Agents opening public links', sub: 'A quick link or a hostname on your domain, started by an agent.', def: true },
    { key: 'research', title: 'Research needs you', sub: 'A research agent wants to download a video, take frames, or ask you something.', def: true },
    { key: 'autostop', title: 'Automatic power-off', sub: 'The box is about to power off automatically, or that was skipped because an agent is working or the box is kept on.', def: true },
    { key: 'limit', title: 'Limit reached', sub: 'The box was overloaded and PlatOpypus closed public links and stopped servers and containers that are not live services.', def: true },
    { key: 'backup', title: 'A backup fails', sub: 'A project backup to S3 did not complete.', def: true },
    { key: 'crash', title: 'A server stops by itself', sub: 'A registered server or live service was running and is not any more, without anyone stopping it.', def: true },
    { key: 'egress', title: 'Connections to somewhere new', sub: 'An agent or a service connected to a host it has not used before.', def: false },
    { key: 'credential', title: 'Agents using Vault values', sub: 'Every vault run and vault get by an agent. Can be busy.', def: false },
    { key: 'commit', title: 'Agent commits', sub: 'A commit by an agent in a project under /Projects.', def: false },
];
const ICON = { root: '🔐', signin: '🔑', link: '🌐', crash: '💥', limit: '🧯', autostop: '🌙', research: '📚', backup: '💾', egress: '📡', credential: '🗝', commit: '📝', test: '✅' };

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function save(c) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }

const isBot = i => i.scope === 'general' && (i.style === 'botChat' || i.provider === 'telegram-bot');
function bots() {
    return vault.list().filter(isBot).map(i => {
        const chat = i.fields.find(f => f.name === 'chatId' && !f.missing);
        return { id: i.id, name: i.name, chatId: chat ? chat.hint : null, incomplete: !i.fields.some(f => f.name === 'botToken' && !f.missing) };
    });
}
const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z]\w{4,31})$/;

export function settings() {
    const c = load();
    const on = Object.fromEntries(KINDS.map(k => [k.key, c.on && k.key in c.on ? !!c.on[k.key] : k.def]));
    const list = bots();
    const bot = list.find(b => b.id === c.itemId) || null;
    const chatId = c.chatId || bot?.chatId || null;
    return {
        itemId: bot ? bot.id : null, botName: bot?.name || null, chatId: c.chatId || null, botChatId: bot?.chatId || null,
        ready: !!(bot && !bot.incomplete && chatId), on, kinds: KINDS, bots: list,
        pausedUntil: c.pausedUntil > Date.now() ? c.pausedUntil : null, lastSent: c.lastSent || null, lastError: c.lastError || null,
    };
}

export function configure(body = {}, origin = null) {
    const c = load();
    if ('itemId' in body) {
        if (body.itemId === null) c.itemId = null;
        else {
            const b = bots().find(x => x.id === body.itemId);
            if (!b) throw httpError(400, 'Pick a general "Telegram bot + chat" entry from the Vault.');
            c.itemId = b.id;
        }
    }
    if ('chatId' in body) {
        const v = String(body.chatId ?? '').trim();
        if (v && !CHAT_RE.test(v)) throw httpError(400, 'A chat ID is a number (groups start with -) or @channelname.');
        c.chatId = v || null;
    }
    if (body.on && typeof body.on === 'object') {
        c.on = { ...(c.on || {}) };
        for (const k of KINDS) if (k.key in body.on) c.on[k.key] = !!body.on[k.key];
    }
    if ('pauseMinutes' in body) {
        const m = Math.max(0, Math.min(Number(body.pauseMinutes) || 0, 7 * 24 * 60));
        c.pausedUntil = m ? Date.now() + m * 60_000 : 0;
    }
    // Links in alerts open the address the phone used (https://… through Cloudflare).
    if (origin && /^https?:\/\/[\w.-]+(:\d+)?$/.test(origin)) c.origin = origin;
    save(c);
    return settings();
}

// ---------- sending ----------

async function tg(token, method, body) {
    const res = await fetch(`${TG_API}/bot${token}/${method}`, {
        method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw httpError(400, `Telegram: ${data.description || `HTTP ${res.status}`}`);
    return data.result;
}

function target() {
    const c = load();
    if (!c.itemId) return null;
    const v = vault.valuesOf(c.itemId);
    if (!v || v.scope !== 'general' || !v.fields.botToken) return null;
    const chat = c.chatId || v.fields.chatId;
    return chat ? { token: v.fields.botToken, chat, origin: c.origin || null } : null;
}

// Chats the bot has seen (after you message it), so the phone can pick one without copying an ID around.
export async function chats(itemId) {
    const v = vault.valuesOf(itemId);
    if (!v || v.scope !== 'general' || !v.fields.botToken) throw httpError(400, 'That Vault entry has no bot token.');
    const updates = await tg(v.fields.botToken, 'getUpdates?limit=100');
    const seen = new Map();
    for (const u of updates) {
        const c = (u.message || u.edited_message || u.channel_post || u.my_chat_member)?.chat; if (!c) continue;
        seen.set(String(c.id), { id: String(c.id), type: c.type, title: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id) });
    }
    const me = await tg(v.fields.botToken, 'getMe').catch(() => null);
    return { bot: me ? `@${me.username}` : null, chats: [...seen.values()].reverse() };
}

const queue = [];
const recent = new Map();          // dedupe key → time
const sent = [];                   // send times, for the rate cap
let dropped = 0, pumping = false;
const CAP = 20, CAP_MS = 10 * 60_000;

function format(kind, text) {
    const t = target();
    return `${ICON[kind] || '•'} ${text}${t?.origin ? `\n${t.origin}/` : ''}`.slice(0, 3500);
}

async function deliver(text) {
    const t = target();
    if (!t) throw httpError(409, 'Alerts are not set up: pick a Telegram bot and a chat.');
    await tg(t.token, 'sendMessage', { chat_id: t.chat, text, disable_web_page_preview: true });
    const c = load(); c.lastSent = Date.now(); c.lastError = null; save(c);
}

async function pump() {
    if (pumping) return;
    pumping = true;
    try {
        while (queue.length) {
            const now = Date.now();
            while (sent.length && now - sent[0] > CAP_MS) sent.shift();
            if (sent.length >= CAP) { dropped += queue.length; queue.length = 0; break; }
            const { kind, text } = queue.shift();
            if (dropped && sent.length < CAP - 1) { const n = dropped; dropped = 0; queue.unshift({ kind, text }); await deliver(format('test', `${n} more alert${n === 1 ? '' : 's'} were held back (more than ${CAP} in 10 minutes). Open PlatOpypus's audit log for the rest.`)).catch(() => {}); sent.push(Date.now()); continue; }
            try { await deliver(format(kind, text)); }
            catch (e) { const c = load(); c.lastError = { at: Date.now(), message: e.message.slice(0, 200) }; save(c); log('alerts', `send failed: ${e.message}`); }
            sent.push(Date.now());
            await new Promise(r => setTimeout(r, 1100));
        }
    } finally { pumping = false; }
}

// Queue an alert of a kind. key: alerts with the same key within `quietMs` are sent once.
export function notify(kind, text, { key = null, quietMs = 10 * 60_000 } = {}) {
    try {
        const s = settings();
        if (!s.ready || !s.on[kind] || s.pausedUntil) return false;
        if (key) { const k = `${kind}:${key}`; const t = recent.get(k); if (t && Date.now() - t < quietMs) return false; recent.set(k, Date.now()); if (recent.size > 500) recent.delete(recent.keys().next().value); }
        queue.push({ kind, text: String(text) });
        pump();
        return true;
    } catch { return false; }
}

// Send now and wait for it (the box may be stopped a moment later), instead of queueing.
export async function notifyNow(kind, text) {
    try {
        const s = settings();
        if (!s.ready || !s.on[kind] || s.pausedUntil) return false;
        await Promise.race([deliver(format(kind, text)), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 8000))]);
        return true;
    } catch { return false; }
}

export async function test() {
    await deliver(format('test', 'PlatOpypus alerts are on. This is a test message.'));
    return settings();
}

// ---------- sources ----------

const proj = l => l.project ? ` · ${l.project}` : '';
const short = (s, n = 300) => { const t = String(s || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// Called for every new audit line (audit.onRecord).
export function fromAudit(l) {
    if (l.type === 'elevate' && l.action === 'request' && !l.auto)
        notify('root', `Root request${proj(l)}\n${l.actor || 'an agent'} wants to run:\n${short(l.cmd)}${l.reason ? `\nReason: ${short(l.reason, 200)}` : ''}\nOpen PlatOpypus to allow or deny (expires in 10 min).`);
    else if (l.type === 'activity' && (l.action === 'tunnel-start' || l.action === 'hostname-add') && l.actor !== 'phone')
        notify('link', `${l.action === 'tunnel-start' ? 'Public link opened' : 'Hostname added'}${proj(l)}\n${l.actor}: ${short(l.what, 200)}`, { key: `${l.action}:${l.what}` });
    else if (l.type === 'credential' && (l.action === 'agent-run' || l.action === 'agent-read'))
        notify('credential', `Vault${proj(l)}\n${l.actor} ${l.action === 'agent-run' ? 'ran' : 'read'} ${(l.names || []).join(', ')}${l.cmd ? `\n${short(l.cmd, 200)}` : ''}`, { key: `${l.actor}:${(l.names || []).join(',')}:${l.cmd || ''}`, quietMs: 60_000 });
    else if (l.type === 'network' && l.action === 'egress-new')
        notify('egress', `New connection${proj(l)}\n${l.actor}: ${short(l.what, 200)}`, { key: `${l.actor}:${l.what}`, quietMs: 60 * 60_000 });
}

export function fromAuth(ev) {
    if (ev.type === 'signin') notify('signin', `Signed in to PlatOpypus with ${ev.how}\nfrom ${ev.addr}${ev.ua ? `\n${short(ev.ua, 120)}` : ''}\nNot you? Sign out other devices in More → Security.`);
    if (ev.type === 'lockout') notify('signin', `Sign-in locked for 15 minutes after 5 failed attempts\nfrom ${ev.addr}`, { key: ev.addr });
}

// Crashed servers: alive at the last check, not alive now, and not stopped by anyone in between.
const seenAlive = new Map();       // slug → last time seen alive
let firstTick = true;
export async function checkServers(services) {
    const list = await services.list();
    const now = Date.now();
    for (const s of list) {
        const prev = seenAlive.get(s.slug);
        if (s.alive) { seenAlive.set(s.slug, now); continue; }
        seenAlive.delete(s.slug);
        if (firstTick || !prev || (s.stoppedAt && s.stoppedAt >= prev)) continue;
        notify('crash', `${s.live ? 'Live service' : 'Server'} stopped by itself${s.project ? ` · ${s.project}` : ''}\n${s.live?.title || s.name}${s.port ? ` (port ${s.port})` : ''}\nIts log is in Services.`, { key: s.slug, quietMs: 30 * 60_000 });
    }
    for (const slug of [...seenAlive.keys()]) if (!list.some(s => s.slug === slug)) seenAlive.delete(slug);
    firstTick = false;
}

// New agent commits since the last check (the first check only learns what is there).
const seenCommits = new Set();
let commitsPrimed = false;
export async function checkCommits(audit) {
    if (!settings().on.commit) { commitsPrimed = false; seenCommits.clear(); return; }
    const list = await audit.commits({ days: 1 });
    for (const c of list) {
        if (!c.agent || seenCommits.has(c.hash)) continue;
        seenCommits.add(c.hash);
        if (commitsPrimed) notify('commit', `Commit by ${c.agent} · ${c.project}\n${short(c.what, 200)}`);
    }
    commitsPrimed = true;
}
