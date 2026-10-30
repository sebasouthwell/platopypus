// Audit log. Goes to stdout, which systemd routes to journald (`journalctl -u porthole`).
export function log(area, message) {
    const ts = new Date().toISOString();
    console.log(`${ts} [${area}] ${message}`);
}
