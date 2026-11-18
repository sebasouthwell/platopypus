// Agent tools, declared once per app. An app registers its tools here (name, description, typed input, handler) and
// a context function that works out what a shell may act on (for example the Job Hunt folder). From that one list:
//   GET  /api/agent/tools/<app>          the tools (for bin/plato-mcp and bin/plato-tool)
//   POST /api/agent/tools/<app>/<name>   call one, as the calling agent shell (checked like every agent route)
// bin/plato-mcp <app> serves them over MCP; bin/plato-tool <app> <tool> runs one from a shell. No per-app CLI or MCP code.
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const APPS = new Map();
// app: { context(shell) → ctx (throw 403 if this shell may not use the app), tools: [{ name, description, inputSchema, run(ctx, args, by) → string|object }] }
export function registerApp(name, app) { APPS.set(name, app); }
export const apps = () => [...APPS.keys()];
export function list(name, shell) {
    const app = APPS.get(name); if (!app) throw httpError(404, 'No such app.'); app.context(shell);
    return app.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema || { type: 'object', properties: {} } }));
}
export async function call(name, tool, shell, args = {}, by = 'agent') {
    const app = APPS.get(name); if (!app) throw httpError(404, 'No such app.');
    const t = app.tools.find(x => x.name === tool); if (!t) throw httpError(404, `No tool ${tool}. Tools: ${app.tools.map(x => x.name).join(', ')}.`);
    const ctx = app.context(shell);
    for (const req of t.inputSchema?.required || []) if (args[req] === undefined || args[req] === null || args[req] === '') throw httpError(400, `${tool} needs ${req}.`);
    const out = await t.run(ctx, args, by);
    return typeof out === 'string' ? { text: out } : { text: JSON.stringify(out, null, 1), data: out };
}
// Small helpers for writing tool schemas.
export const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
export const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
export const bool = description => ({ type: 'boolean', description });
export const arr = (description, items = { type: 'string' }) => ({ type: 'array', description, items });
export const obj = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
