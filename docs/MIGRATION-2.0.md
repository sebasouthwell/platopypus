# 2.0: the full rename, as a plan

**Status:** phase 1 shipped in 2.0.0 (`PLATO_` prefix; `ps-<project>` unchanged; hostname untouched). Phase 2 and 3 pending.

Everything the user sees already says PlatOpypus (1.27.0). This is the rest: every name on the box that still says
`porthole`. It is split into three phases because they carry different risks, and the first phase is designed so
that **the previous release still runs if the update is rolled back**: every old path keeps working through a
symlink, and every old name is still read.

Nothing here touches project folders, Vault contents, services' data, Docker containers, hostnames on your domain
(the ones you have set up) or your passkeys. Those are user data and stay exactly where they are.

## What changes, and how

| Today | 2.0 | How it moves | Old name after 2.0 |
|---|---|---|---|
| `~/.porthole` (state) | `~/.platopypus` | `mv -T` (same disk, instant) | symlink → new; kept for good |
| `/opt/porthole` (app), `/opt/porthole-src` | `/opt/platopypus`, `/opt/platopypus-src` | `mv -T` | symlinks, kept for good |
| `/etc/porthole.env` | `/etc/platopypus.env` | copy | kept one major, then removed |
| `porthole.service` | `platopypus.service` | new unit written, old disabled, new enabled, one restart (`KillMode=process`: tmux and services survive as they do on every update) | removed |
| drop-ins `system.slice.d/porthole.conf`, `nginx.service.d/porthole.conf` | `…/platopypus.conf` | rename | removed |
| nginx `sites-available/porthole`, `conf.d/porthole-snippets.conf`, `porthole-proxy.inc`, `porthole-zoned-<slug>` | `platopypus`, `platopypus-snippets.conf`, `platopypus-proxy.inc`, `platopypus-zoned-<slug>` | rename + `nginx -s reload` | removed |
| `PORTHOLE_*` environment (service unit, shells, services, `.portholerun`, `needs:`) | `PLATO_*` | code reads `PLATO_X`, then `PORTHOLE_X`; new shells and services get **both** for all of 2.x | read and set until 3.0 |
| `X-Porthole` (CSRF header), `X-Porthole-Version`, cookie `porthole_session` | `X-Plato`, `X-Plato-Version`, `plato_session` | server accepts both headers; the old cookie is accepted and replaced by the new one on the next request, so nobody is signed out | accepted until 3.0 |
| tmux socket `-L porthole` | `-L plato` | **needs the planned restart** (a tmux server cannot change socket): stop live services, end the old server, start under the new name, start the services again | gone after the restart |
| iptables chain `PORTHOLE-EGRESS`, log prefix `PH-EGRESS` | `PLATO-EGRESS`, `PLATO-EGRESS ` | new chain added, old flushed and removed | gone |
| `bin/porthole`, `bin/porthole-update`, `/usr/local/bin/porthole` | `plato`, `plato-update` | both names installed | `porthole` kept as an alias for good |
| `<!-- porthole:begin/end -->` in agents' instruction files | `<!-- platopypus:begin/end -->` | install.sh already replaces a legacy block; it learns the old marker too | replaced on the next update |
| `.portholerun` | `.platorun` | read both; docs and the Files UI say `.platorun`; the Run card offers to rename a project's file | read for good |
| `PORTHOLE.md` | `PLATOPYPUS.md` | already both (1.27.0) | read for good |
| `journalctl -u porthole` | `journalctl -u platopypus` | — | old logs stay under the old unit name |
| Telegram alert text, audit `via` strings, service page copy | PlatOpypus | text only | — |

Not changed in 2.0, on purpose:

| Name | Why it stays |
|---|---|
| `porthole-dev`, `porthole-svcs`, `porthole-svc`, `ps-<project>` (accounts and groups) | A rename is instant (`groupmod -n`, GIDs unchanged, ACLs unaffected), but an old release rolled back after it would look for the old names and agent shells would fail. Done in **2.1** once 2.0 has run for a while, with a reverse step the updater runs on rollback. |
| `porthole.example.com` | Passkeys are bound to the domain (WebAuthn rpId). A new hostname means re-enrolling the passkey on the new address, and a mistake there locks the phone out. **Phase 3**, manual, with the password sign-in as the safety net. |
| Service registry slugs (`live-<project>-<key>`, `svc-*`, `run-*`), container names (`app-*`, `code-*`), Vault env prefixes | They are user data and API contract (UPDATE.md rules 3 and 8). |

## Phase 1: 2.0.0 (one update, one planned restart)

Shipped as a normal release with a migration step `2.0.0-rename`:

1. **Archive** the state folder (the migration framework does this: `~/.porthole/migrate/pre-2.0.0-<stamp>.tar.gz`).
2. **Move** `~/.porthole` → `~/.platopypus`, `/opt/porthole` → `/opt/platopypus`, `/opt/porthole-src` → `/opt/platopypus-src`; leave symlinks at the old paths. Running processes keep their open files (logs, sockets) because inodes do not move.
3. **Write** `/etc/platopypus.env` from `/etc/porthole.env`, the `platopypus.service` unit, the drop-ins, and the renamed nginx files; `nginx -t && nginx -s reload`.
4. **Switch units**: `systemctl daemon-reload`, `systemctl enable platopypus`, `systemctl disable porthole`, then `systemctl restart platopypus`. The health check in the updater is unchanged: page, assets, `node --check`.
5. **Firewall**: add `PLATO-EGRESS`, remove `PORTHOLE-EGRESS` and the old `DOCKER-USER` rules.
6. **The planned restart** (this is the part you schedule): stop every live service, end the `porthole` tmux server, start the `plato` one, start the services again (`live.autostart` does this), re-create the shells scope. Open shells end. Claude sessions resume with "resume" in a new shell. About two minutes.

   This is also the moment the tmux server finally lands in its own systemd scope (1.25.0's priority change, pending since the box last rebooted).

Rollback: the updater's health check fails → previous release's code is put back → it finds its state through the `~/.porthole` symlink, its app through `/opt/porthole`, reads `PORTHOLE_*` which 2.0 still sets, and the old unit name is re-created by its own install.sh. The one thing it cannot undo is the tmux socket, which is why step 6 happens last and only after the health check passed.

## Phase 2: 2.1.0 (accounts and groups)

`porthole-dev` → `plato-dev`, `porthole-svcs` → `plato-svcs`, `porthole-svc` → `plato-svc`. `groupmod -n` / `usermod -l` keep GIDs and UIDs, so nothing on disk changes meaning. Ships with a `down()` the updater runs if it has to roll back 2.1.0.

## Phase 3: the hostname (2.0.1, step by step)

A passkey is tied to the address it was made on, so the new address needs its own. Everything else is automatic.

1. **DNS:** an A record for the new name (for example `plato.example.com`) with the same address and proxy setting as
   the current one.
2. **Alias:** add `PLATO_ALIAS_DOMAINS=plato.example.com` to `/etc/platopypus.env` and update. The app now answers on
   both names; the old address and its passkey keep working.
3. **Passkey on the new address:** run `plato reset-auth` on the box (it prints a setup token), open the new address,
   enter the token and create a passkey there. (A password set on the old address first lets you skip the reset:
   sign in on the new address with it and add the passkey from More → Security.)
4. **Switch:** set `PLATO_DOMAIN=plato.example.com` and `PLATO_REDIRECT_DOMAINS=porthole.example.com`, update. The
   old address now redirects to the new one.
5. A month later, drop the redirect.

## Order and timing

1. Review this plan.
2. 2.0.0: code + migration + tests (the upgrade test in CI runs it against a 1.x image, including rollback).
3. Deploy to the box at a quiet moment: the update itself is like any other; the planned restart (step 6) is the
   two minutes to pick.
4. 2.1.0 a few days later.
5. The hostname whenever you like, or never.
