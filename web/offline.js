// The "box is off" page. It runs on the phone (kept there by the service worker) and talks only to the control Lambda.
(() => {
    'use strict';
    const $ = s => document.querySelector(s);
    const KEY = 'plato.control';
    const load = () => { try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); return c && c.url && c.key ? c : null; } catch { return null; } };
    let ctl = load(), poll = null;

    const show = (el, on) => { $(el).hidden = !on; };
    const say = (head, sub) => { $('#head').textContent = head; $('#sub').textContent = sub; };
    const progress = text => { show('#progress', !!text); if (text) $('#progress-text').textContent = text; };

    async function call(action) {
        const u = ctl.url.replace(/\/?$/, '/') + `?action=${action}`;
        const r = await fetch(u, { headers: { 'X-Porthole-Key': ctl.key }, cache: 'no-store' });
        const d = await r.json().catch(() => ({}));
        if (r.status === 401) throw new Error('The key was not accepted. Check it under "Set up" below.');
        if (!r.ok) throw new Error(d.message || `The control answered ${r.status}.`);
        return d;
    }
    // Is the app itself back? (Only once the box is running.)
    async function appUp() { try { const r = await fetch('/api/login', { cache: 'no-store' }); return r.ok; } catch { return false; } }

    function render(d) {
        show('#state', true);
        $('#st-state').textContent = d.state || '–'; $('#st-since').textContent = d.since || '–';
        const off = d.state === 'stopped';
        show('#start', off);
        if (off) say('The box is switched off', 'Start it here. It takes a minute or two, then the app opens by itself.');
        else if (d.state === 'running' && d.porthole === 'up') say('The box is back', 'Opening the app…');
        else if (d.state === 'running') say('The box is running, the app is not answering yet', 'It may still be starting up. This page checks again on its own.');
        else say(`The box is ${d.state || 'busy'}`, 'Wait a moment; this page checks again on its own.');
    }
    async function check() {
        if (!ctl) { say('The box is not answering', 'Set up the Start button below to check on it and start it from here.'); show('#state', false); show('#start', false); $('#setup').open = true; return null; }
        try { const d = await call('status'); render(d); if (d.state === 'running' && d.porthole === 'up' && await appUp()) location.replace('/'); return d; }
        catch (e) { say('Could not reach the control', e.message.includes('fetch') ? 'This device may be offline, or the control does not allow this page yet.' : e.message); return null; }
    }
    function watch() {
        clearInterval(poll); let n = 0;
        poll = setInterval(async () => {
            n++; const d = await check();
            if (d) progress(d.state === 'running' ? (d.porthole === 'up' ? 'The app is answering. Opening…' : 'Running. Waiting for the app to come up…') : `${d.state[0].toUpperCase() + d.state.slice(1)}…`);
            if (n > 60) { clearInterval(poll); progress('Still not up after 5 minutes. Try again, or check the box from your PC.'); }
        }, 5000);
    }

    $('#start').onclick = async () => {
        $('#start').disabled = true; progress('Asking the box to start…');
        try { await call('start'); progress('Starting…'); watch(); }
        catch (e) { progress(''); say('Could not start the box', e.message); $('#start').disabled = false; }
    };
    $('#retry').onclick = () => location.reload();

    // setup: the URL and key, on this device only
    const fill = () => { $('#f-url').value = ctl?.url || ''; $('#f-key').value = ''; $('#f-key').placeholder = ctl ? 'saved (enter a new one to change it)' : '40 characters'; show('#forget', !!ctl); $('#setup-sum').textContent = ctl ? 'Start button: set up on this device' : 'Set up the Start button on this device'; };
    $('#save').onclick = () => {
        const url = $('#f-url').value.trim(), key = $('#f-key').value.trim() || ctl?.key || '';
        if (!/^https:\/\/[a-z0-9]+\.lambda-url\.[a-z0-9-]+\.on\.aws\/?$/.test(url)) return say('That is not the control URL', 'It looks like https://….lambda-url.eu-west-2.on.aws/');
        if (key.length < 20) return say('That key looks too short', 'Use Copy key in the Telegram message.');
        ctl = { url, key }; localStorage.setItem(KEY, JSON.stringify(ctl)); fill(); $('#setup').open = false; check();
    };
    $('#forget').onclick = () => { localStorage.removeItem(KEY); ctl = null; fill(); check(); };
    fill(); check();
    // the box may come back on its own (someone started it another way)
    setInterval(() => { if (!poll) check(); }, 20000);
})();
