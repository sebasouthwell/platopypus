// Headless browser probe, run by CI after the smoke suite (which leaves a password-only box behind).
// Catches what the API suite cannot: app.js failing to evaluate (the 1.1.x blank page), uncaught errors while
// rendering each tab, and stale asset stamping.
//   BASE=http://127.0.0.1:7332 PASSWORD=smoke-password-12345 node test/browser.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:7332';
const PASSWORD = process.env.PASSWORD || 'smoke-password-12345';
const problems = [];
let checks = 0;
const check = (name, ok, extra = '') => { checks++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); if (!ok) problems.push(name); };

const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of 401/.test(m.text())) errors.push(`console: ${m.text()}`); });

await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(1500);
const version = await page.getAttribute('meta[name="porthole-version"]', 'content');
check('page carries a version stamp', /^\d+\.\d+\.\d+$/.test(version || ''), version);
const stamped = await page.$$eval('script[src], link[rel=stylesheet]', els => els.map(e => e.getAttribute('src') || e.getAttribute('href')).filter(u => /app\.js|styles\.css/.test(u)));
check('app.js and styles.css are version-stamped', stamped.length >= 2 && stamped.every(u => u.includes(`v=${version}`)), stamped.join(' '));
const probe = await page.evaluate(async () => { try { await import(`/app.js?probe=${Date.now()}`); return null; } catch (e) { return String(e); } });
check('app.js evaluates as a module', probe === null, probe || '');

// Sign in with the smoke password, then render every tab.
const login = await page.evaluate(async (password) => {
    const r = await fetch('/api/login/password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Porthole': '1' }, body: JSON.stringify({ password }) });
    return r.status;
}, PASSWORD);
check('password sign-in works from the browser', login === 200, String(login));
await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(1500);
for (const tab of ['home', 'shells', 'services', 'files', 'more']) {
    const before = errors.length;
    await page.click(`.tabs [data-go="${tab}"]`);
    await page.waitForTimeout(1200);
    const visible = await page.isVisible(`#tab-${tab}`);
    const text = (await page.textContent(`#tab-${tab}`) || '').trim();
    check(`${tab} tab renders without errors`, visible && text.length > 10 && errors.length === before, errors.slice(before).join(' | ').slice(0, 300));
}
check('no uncaught errors overall', errors.length === 0, errors.join(' | ').slice(0, 500));
await page.screenshot({ path: process.env.SHOT || 'browser-probe.png', fullPage: false });
await browser.close();

if (problems.length) { console.log(`\n${problems.length} of ${checks} browser checks failed`); process.exit(1); }
console.log(`\nall ${checks} browser checks passed`);
