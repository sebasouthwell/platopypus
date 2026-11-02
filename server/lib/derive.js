// Lookups that turn one credential value into another, for the Vault form helpers. Only the calls that need the
// network live here (pure parsing happens on the phone). Values are used for the one request and never stored.

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const TG_TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

async function tg(token, method) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { signal: AbortSignal.timeout(10_000) });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw httpError(400, `Telegram: ${data.description || `HTTP ${res.status}`}`);
    return data.result;
}

export async function run(body) {
    const kind = String(body?.kind || '');
    if (kind === 'telegram-getme') {
        const token = String(body.botToken || '').trim();
        if (!TG_TOKEN.test(token)) throw httpError(400, 'That does not look like a bot token (123456:ABC…).');
        const me = await tg(token, 'getMe');
        return { botId: String(me.id), username: me.username, name: me.first_name };
    }
    if (kind === 'telegram-chats') {
        const token = String(body.botToken || '').trim();
        if (!TG_TOKEN.test(token)) throw httpError(400, 'That does not look like a bot token (123456:ABC…).');
        const updates = await tg(token, 'getUpdates?limit=100');
        const seen = new Map();
        for (const u of updates) {
            const msg = u.message || u.edited_message || u.channel_post || u.my_chat_member?.chat && { chat: u.my_chat_member.chat } || null;
            const c = msg?.chat; if (!c) continue;
            seen.set(String(c.id), { id: String(c.id), type: c.type, title: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id), username: c.username || null });
        }
        const chats = [...seen.values()].reverse();
        return { chats, hint: chats.length ? null : 'No messages seen yet. Send the bot a message (or add it to the group) and try again. If a webhook is set, getUpdates returns nothing until it is removed.' };
    }
    throw httpError(400, 'Unknown helper.');
}
