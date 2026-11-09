# PlatOpypus Live — the standard for a project that runs as a live service

A project tells PlatOpypus how to run, expose, update and back it up through one file in its root: **`PORTHOLE.md`**.
The file is Markdown with a YAML front matter block. The front matter is the contract PlatOpypus reads; the body is
free text for people and agents (what the project is, how it works, gotchas). Agents are expected to write and keep
this file current; the user approves what PlatOpypus does with it from the phone.

## The file

```markdown
---
porthole: 1                       # standard version
name: Parle
summary: French voice-echo app with a web admin
services:
  web:                            # key: letters, digits, dash
    title: Parle web
    start: npm run start          # run in the project root (or cwd:) in its own logged session
    cwd: .
    port: 3000                    # what the start command listens on
    health: /healthz              # optional: GET path that must answer 200
    hostname: parle.example.com   # optional: live address on your domain (nginx + Let's Encrypt)
    env:                          # non-secret defaults; secrets come from the Vault by env name
      NODE_ENV: production
    needs: [DATABASE_URL, OPENAI_API_KEY]   # Vault env names this service expects (project or general scope)
    update: preserve-data         # full | preserve-data | patch   (asked on the phone if missing)
    patch: npm run build          # only for update: patch (the service is restarted after it)
    actions:                      # become buttons on the service page; run in cwd, output shown on the phone
      - label: Run migrations
        run: npm run migrate
      - label: Seed demo data
        run: npm run seed
        confirm: true             # ask before running
        restart: true             # restart the service after the command succeeds
      - label: Reset counters
        run: echo '{"count":0}' > data/count.json
        stop_first: true          # stop the service, run the command, start it again (for state it holds in memory)
      - label: Set counter
        run: printf '{"count":%s}' "$INPUT_COUNT" > data/count.json
        stop_first: true
        inputs:                   # the phone shows a form; PlatOpypus checks every value before running
          - name: count           # reaches the command as $INPUT_COUNT (always quote it)
            label: New total
            type: integer         # string | integer | number | boolean | choice
            min: 0
            max: 1000000
            default: 0
          - name: note
            type: string
            pattern: '[A-Za-z0-9 ._-]{1,40}'   # whole value must match
            hint: letters, digits, spaces
            required: false
          - name: mode
            type: choice
            choices: [soft, hard]
      - label: Tail app log
        run: tail -n 200 logs/app.log
    links:                        # relative paths become https://hostname/<path> when live
      - label: Admin
        path: /admin
    credentials:                  # shown on the service page; secrets referenced by env name, never inline
      - label: Admin login
        username: admin
        password: $ADMIN_PASSWORD
  notes:                          # a container instead of a command: same page, log, account, hostname, actions
    title: Trilium
    image: triliumnext/notes:latest
    port: 8081                    # on the box, bound to 127.0.0.1 (the container's own port if different:)
    container_port: 8080
    volumes: [data:/home/node/trilium-data]   # <folder in the project>:<path in the container>[:ro]
    memory: 512m                  # optional cap
    env: { TRILIUM_DATA_DIR: /home/node/trilium-data }
    needs: []                     # Vault names reach the container as environment, never on the command line
    # user: image                 # only if the image must start as its own user (default: the project's account)
data:
  - engine: postgres              # postgres | redis | mysql | mongo | sqlite
    version: "16"
    env: DATABASE_URL             # Vault entry PlatOpypus creates (project scope) with the connection URL
  - engine: sqlite
    path: data/app.db
backup:
  paths: [uploads/, config/]      # copied alongside the data dumps
---

## About
Free text. What the service does, where things live, what an operator should know.
```

Everything under `services`, `data` and `backup` is optional; a project with only `name` is still a project.

## What PlatOpypus does with it

| Feature | Behaviour |
|---|---|
| **Live services section** | Every service in every project's `PORTHOLE.md` is listed, with running/stopped, the live address, the pinned git commit and whether dev is ahead. |
| **Start / Stop** | `start` runs in its own logged session (the `svc` registry) with the service's `env` and the Vault entries named in `needs` for the project's scope. Stop kills the whole process group. |
| **Containers** | A service with `image:` instead of `start:` runs as a Docker container through the same registry: Start/Stop, the log, the hostname, actions, pins and alerts all work the same. PlatOpypus composes the `docker run` from the checked fields (image, port, volumes, memory, command), so nothing written in the file runs as root. Inside, the app runs as the project's account with all capabilities dropped, sees only the folders under `volumes:` (inside the project), and is bound to loopback. **Update image** on the service page pulls the image again and restarts the service if it changed. Containers are logged in the Network tab by name and are kept off the metadata service. Live services that were running when the box went down are started again at boot. |
| **Hostname** | Setting `hostname` (or tapping Share on your domain) provisions it **before** the app exists: DNS record to the box, nginx block, Let's Encrypt certificate, with PlatOpypus's own placeholder page answering on https. Once the service is running and healthy, nginx is switched to its port. Removing the service removes the nginx block, the certificate and the DNS record. |
| **Actions** | Each action is a button on the service page. It runs in the service's folder, the output is shown on the phone and kept in the service log. `confirm: true` asks first. |
| **Groups** | `groups:` under a service lists things the service manages: rooms, sessions, users. Each group has a `label`, a `list` command that prints the current items (one id per line, `id<TAB>label` for a name, or JSON `[{"id","label","sub"}]`), and `actions` that run for one item with `$GROUP_ITEM` set to its id (and `$GROUP` to the label). On the service page each group is a dropdown, closed until opened, under the main actions; tapping an item opens its commands, and **All N** runs an action once per item (`all: false` keeps an action to single items; a `restart`/`stop_first` happens once at the end). Ids must come from the list: the phone cannot send one that is not in it, ids are limited to letters, digits and `._:@+-=/`, and inputs are checked as for actions. Example: `groups: [{ label: Rooms, item: room, list: node scripts/rooms.js, actions: [{ label: Close, run: node scripts/room.js close "$GROUP_ITEM", confirm: true }] }]` |
| **Pins and recents** | Any action, group or single item (a room) can be pinned to Home and the desktop sidebar (**Pin to Home…** on the service page, **Pin** on an item's sheet). A pinned action runs in one tap, after its confirmation or inputs; a pinned group or item opens its sheet. Home also lists the last commands run (**Recent**), which reopen their sheet without running. Running cards show the service's groups and first three actions as chips. Pins point by label and item id, are checked when opened (a closed room shows as gone), and go through the same routes and checks as the service page. |
| **Credentials** | Shown with reveal/copy. Values come from the Vault by env name. Cards handed over by agents with `credshare` for the same port appear beside them, tagged *from agent*; Porthole-generated ones (database passwords) are tagged *generated*. |
| **Data** | Each `data` engine runs as a managed container with its own volume under `~/data/<project>/<engine>`, bound to loopback, never shareable. PlatOpypus creates the project-scoped Vault entry named in `env` with the connection URL. |
| **Backup** | From the phone (More → Backups, or the service page): `backup.paths` plus every folder a container service mounts, as one `tar.zst` with owners kept, to a private S3 bucket configured in the Vault (service *Backup storage (S3)*: key, secret, bucket, region; a key limited to that bucket). The service is frozen (SIGSTOP / docker pause) for the seconds the files are read, never stopped. Restore stops the service, keeps the current folders in `.porthole/restore-undo-…`, puts the archive back and starts again. Retention keeps the last N per project (14); an optional daily run at a chosen hour per project. Engine dumps (pg_dump and friends) come with data engines. |
| **Dev and live** | Live runs from its own checkout under `~/live/<project>` pinned to a commit; development continues in `~/Projects/<project>`. When dev is ahead, the service page says so and offers Update. A second agent can be started in the live checkout for hot fixes. |
| **Update strategy** | Per service, asked on the phone the first time: **full** (stop, replace the checkout, reset data, start, for stateless apps), **preserve-data** (stop, update code, keep data, run the migration action if there is one, start), **patch** (run the service's `patch` command, no reset). A backup before updating is offered when the project has data. |

## Quick runs: `.platorun`

Lighter than PORTHOLE.md, for "start this the way it usually runs" without an agent. One file in a project folder:

```yaml
run: npm start              # required
port: 3000                  # what it listens on
before: npm ci              # optional, runs first in the same session
cwd: web                    # optional folder inside this one
env: { NODE_ENV: production }   # plain settings only
needs: [STRIPE_KEY]         # Vault names, project scope then general
share: quick                # quick (default with a port) | domain (with hostname) | none
hostname: app.example.com
open: /?k=abc               # added to the link the Open button uses
run_as: service             # service (project account, default) | agent | root
```

Files shows a **Run** card at the top of that folder (and the file itself is always listed, even with hidden files
off). Tapping it shows every command, the folder, the account, what gets shared and which Vault names are needed;
Run only proceeds with the hash of the plan you saw, so an edit in between is refused. It runs as the registered
server `run-<name>` (stop, restart, logs in Services), and `.platorun` is added to the project's `.gitignore`.

## Rules for agents

- Create or update `PORTHOLE.md` whenever you add a service, change how it starts, or add a command an operator will
  want again. Keep `actions` small and useful; they become buttons.
- **Who runs what.** Each project's services and actions run as that project's own account, `ps-<project>`: no
  login shell, no sudo, no AI logins, no PlatOpypus token. It reaches exactly one folder, its project, through an ACL;
  it is not in `porthole-dev`, and project folders give nothing to "other", so a compromised app cannot read another
  project, the agent's home or PlatOpypus's state. The firewall refuses these accounts the EC2 metadata service (the
  box's AWS role) and PlatOpypus's API. Its environment is only the manifest's `env` plus the Vault names listed under
  `needs:`, nothing else from the Vault. PlatOpypus stays root and is the controller: it starts the process, keeps the
  log, and stops or kills the whole process group.
- **Root.** `run_as: root` is for the rare app that needs it (low port, Docker socket). The phone must approve it, and
  the approval is pinned to the start, patch and action commands **and the project's code**: with git, every tracked
  and not-ignored file as it is on disk; without git, every file except `node_modules`, `.git` and `backup.paths`.
  Any change asks again, so keep data in ignored or backup folders.
- **What isolation does not cover.** An app still holds the secrets it needs (its `needs:`), its own data, and network
  access to the internet and to other local ports (other services, databases). Treat the box as a personal
  development host: hosting untrusted public code calls for a host of its own (see "own host" below).
- **Inputs.** An action may declare typed `inputs`; values arrive only as `INPUT_<NAME>` environment variables, never
  substituted into the command text, so quote them (`"$INPUT_COUNT"`) and they cannot inject shell. Types: string
  (one line, 500 characters unless `max_length`; `pattern` is a full-match regular expression), integer, number
  (`min`/`max`), boolean (`true`/`false`), choice (`choices`).
- Actions run in the service folder with the service's environment plus `PLATO_SERVICE` (its slug). Never
  restart the service from inside the command (`svc restart …`): use `restart: true`, or `stop_first: true` when the
  command edits data the running process keeps in memory and would write back (a counter, a cache, a SQLite file
  open in WAL mode). PlatOpypus stops, runs, then starts, and reports each step in the output.
- Starting a live service takes over its port from a plain server started in the same project folder (an agent's
  `svc run` while testing); any other process on that port is reported and the start is refused.
- Never write secret values into the file. Reference Vault env names (`$ADMIN_PASSWORD`, `needs:`).
- `live check` validates the file; `live status` shows what PlatOpypus sees; `live deploy <service>` asks PlatOpypus to
  start or update it (the user confirms on the phone for updates that touch data).
- Do not create DNS records, certificates, nginx blocks or tunnels yourself. Set `hostname` and let PlatOpypus do it.

## Decisions

1. **Where the file lives:** `PORTHOLE.md` in the project root or `docs/PORTHOLE.md`; the root one wins if both exist.
2. **Services with no port** (workers, bots, game servers on raw UDP) are allowed. PlatOpypus suggests running them on
   their own host; there they are controlled only through PlatOpypus (Terraform lifecycle + the admin API), with no
   hostname. On this box they run like any other service, just without Share.
3. **Before a service is up** its hostname shows a PlatOpypus "coming up" page, served by nginx over https. The same
   page shows whenever the service is stopped or restarting, so the address never errors.
4. **Raw ports:** a service may declare `expose: [{ port: 27015, proto: udp }]` for clients that do not speak http
   (game servers). On its own host these become security-group rules; on this box they are refused (the box only
   admits Cloudflare's edge on 80/443).

## Hosting modes

A live service runs in one of two places (static sites have a third option, below), chosen per service on the phone. Both read the same `PORTHOLE.md`, so a
service can move between them.

| | **On this box** | **On its own host** (roadmap) |
|---|---|---|
| Where | the PlatOpypus box, next to your shells and agents | a separate cloud machine created by Terraform for this service |
| Cost | nothing extra | the host's hourly price, bounded by its lifetime |
| Isolation | shares the box, its disk and the agents' access | separate machine; a compromise of the service cannot reach the box, the Vault or your shells |
| Lifetime | until you stop it | until you stop it, or self-destructs at a set expiry |
| Control | directly, as with any registered server | through a small admin API on the host, authenticated with a per-host key that PlatOpypus holds |
| Good for | dev previews, small always-on tools, anything cheap | public game nights, anything strangers will hit, anything you want gone afterwards |

The service page shows the same controls in both modes (start, stop, actions, logs, backup, update); only the
transport differs. For an external host, PlatOpypus talks to its admin API over https with that host's credential,
which can do nothing except operate that one service and is destroyed with the host.

### Static sites on a static host (roadmap)

A service declared `static: { build: npm run build, output: dist }` (no `start`, no port) can be published to a static
host instead of running anywhere. First integration: **Vercel** — a Vercel account sits under Cloud accounts like the
others (an access token in the Vault), Publish runs the build on the box, uploads the output with the Vercel API,
and attaches the service's hostname (PlatOpypus adds the DNS record in Cloudflare and Vercel issues the certificate).
The service page shows the deployment URL, the last deploy and its commit, with Publish and Remove. Rules:

- Static only: no server process, no data engines, no `actions` that need a running service.
- Vercel's free Hobby plan is for personal, non-commercial use; PlatOpypus says so when the account is added.
- **Cloudflare Pages** is the natural second integration: same flow, uses the Cloudflare token PlatOpypus already has.

## Later: ephemeral hosts (roadmap, not built)

Run a live service on its own short-lived cloud machine instead of the PlatOpypus box, e.g. a game server for one night.

- **Cloud accounts** work like the AI agent profiles: a page under More lists providers (AWS first), each with one
  or more named accounts ("personal", "work sandbox") you sign in to once and switch between. Each account shows
  its status, the regions it is allowed to use (multi-region; one default) and spend this month across all its
  hosts, with an optional monthly cap that blocks new hosts once reached. An account holds a narrowly scoped key that may only create and destroy
  resources tagged `porthole:ephemeral`. When you create a host you pick the account the way you pick a Claude
  profile for a shell.
- **Host on its own machine** on a live service: pick provider, region and size from a dropdown (t3.micro … t3.large,
  with the hourly price), and a lifetime (2 h, tonight until 06:00, 24 h, custom).
- **Security groups** are generated from the manifest and nothing else: 80/443 from Cloudflare's published edge
  ranges when the hostname is proxied (from anywhere when not), each `expose` port with its protocol, and no SSH at
  all (management goes through SSM and the admin API). Egress stays open for package installs and git.
- **Every host comes ready:** nginx, certbot and the coming-up page are installed by cloud-init before the project is
  cloned, so the hostname answers on https within minutes, then switches to the service once its health check passes.
- PlatOpypus renders a Terraform stack per host from a template, applies it with its own state under
  `~/.platopypus/ephemeral/<id>/`, boots the instance with cloud-init that clones the project at the pinned commit and
  starts the service from `PORTHOLE.md`, then points the chosen hostname at it with nginx + Let's Encrypt on that host.
- **Admin API** on each host: a tiny agent (start, stop, status, logs, actions, backup) bound behind nginx on the
  host's hostname under a random path, requiring a per-host key generated at creation. **PlatOpypus holds the key**
  (encrypted in its own state, like a tunnel run token) and uses it whenever you operate the service from the
  phone; it is never exported to shells or agents, and it is revoked with the host. The host never has the cloud
  access key either; only PlatOpypus does.
- **Expiry is enforced three ways**, so it holds even if PlatOpypus is off: the instance's shutdown behaviour is
  `terminate` and cloud-init schedules `shutdown -h` at expiry; an EventBridge one-shot terminates it at expiry plus a
  margin; PlatOpypus runs `terraform destroy` at expiry and removes the DNS record. EBS volumes delete on termination.
- **"Leaves nothing behind"** means no running resources, disks, addresses, DNS records or PlatOpypus state remain.
  It cannot mean no record at all: the provider keeps billing lines and, if enabled, CloudTrail events.
- Data from the host is only kept if you press Backup before expiry (same private S3 bucket as above).
