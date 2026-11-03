# Porthole Live — the standard for a project that runs as a live service

A project tells Porthole how to run, expose, update and back it up through one file in its root: **`PORTHOLE.md`**.
The file is Markdown with a YAML front matter block. The front matter is the contract Porthole reads; the body is
free text for people and agents (what the project is, how it works, gotchas). Agents are expected to write and keep
this file current; the user approves what Porthole does with it from the phone.

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
    patch: npm run build && svc restart parle-web   # only for update: patch
    actions:                      # become buttons on the service page; run in cwd, output shown on the phone
      - label: Run migrations
        run: npm run migrate
      - label: Seed demo data
        run: npm run seed
        confirm: true             # ask before running
      - label: Tail app log
        run: tail -n 200 logs/app.log
    links:                        # relative paths become https://hostname/<path> when live
      - label: Admin
        path: /admin
    credentials:                  # shown on the service page; secrets referenced by env name, never inline
      - label: Admin login
        username: admin
        password: $ADMIN_PASSWORD
data:
  - engine: postgres              # postgres | redis | mysql | mongo | sqlite
    version: "16"
    env: DATABASE_URL             # Vault entry Porthole creates (project scope) with the connection URL
  - engine: sqlite
    path: data/app.db
backup:
  paths: [uploads/, config/]      # copied alongside the data dumps
---

## About
Free text. What the service does, where things live, what an operator should know.
```

Everything under `services`, `data` and `backup` is optional; a project with only `name` is still a project.

## What Porthole does with it

| Feature | Behaviour |
|---|---|
| **Live services section** | Every service in every project's `PORTHOLE.md` is listed, with running/stopped, the live address, the pinned git commit and whether dev is ahead. |
| **Start / Stop** | `start` runs in its own logged session (the `svc` registry) with the service's `env` and the Vault entries named in `needs` for the project's scope. Stop kills the whole process group. |
| **Hostname** | Setting `hostname` (or tapping Share on your domain) provisions it **before** the app exists: DNS record to the box, nginx block, Let's Encrypt certificate, with Porthole's own placeholder page answering on https. Once the service is running and healthy, nginx is switched to its port. Removing the service removes the nginx block, the certificate and the DNS record. |
| **Actions** | Each action is a button on the service page. It runs in the service's folder, the output is shown on the phone and kept in the service log. `confirm: true` asks first. |
| **Credentials** | Shown with reveal/copy. Values come from the Vault by env name. Cards handed over by agents with `credshare` for the same port appear beside them, tagged *from agent*; Porthole-generated ones (database passwords) are tagged *generated*. |
| **Data** | Each `data` engine runs as a managed container with its own volume under `~/data/<project>/<engine>`, bound to loopback, never shareable. Porthole creates the project-scoped Vault entry named in `env` with the connection URL. |
| **Backup** | Manual, from the phone: engine-aware dumps (pg_dump, redis snapshot, mysqldump, mongodump, sqlite copy) plus `backup.paths`, as one archive, to a private S3 bucket configured in the Vault (service *Backup storage*: bucket, region, access key, secret). Restore lists the archives in that bucket. Nothing is scheduled unless you ask. |
| **Dev and live** | Live runs from its own checkout under `~/live/<project>` pinned to a commit; development continues in `~/Projects/<project>`. When dev is ahead, the service page says so and offers Update. A second agent can be started in the live checkout for hot fixes. |
| **Update strategy** | Per service, asked on the phone the first time: **full** (stop, replace the checkout, reset data, start, for stateless apps), **preserve-data** (stop, update code, keep data, run the migration action if there is one, start), **patch** (run the service's `patch` command, no reset). A backup before updating is offered when the project has data. |

## Rules for agents

- Create or update `PORTHOLE.md` whenever you add a service, change how it starts, or add a command an operator will
  want again. Keep `actions` small and useful; they become buttons.
- Never write secret values into the file. Reference Vault env names (`$ADMIN_PASSWORD`, `needs:`).
- `live check` validates the file; `live status` shows what Porthole sees; `live deploy <service>` asks Porthole to
  start or update it (the user confirms on the phone for updates that touch data).
- Do not create DNS records, certificates, nginx blocks or tunnels yourself. Set `hostname` and let Porthole do it.

## Decisions

1. **Where the file lives:** `PORTHOLE.md` in the project root or `docs/PORTHOLE.md`; the root one wins if both exist.
2. **Services with no port** (workers, bots, game servers on raw UDP) are allowed. Porthole suggests running them on
   their own host; there they are controlled only through Porthole (Terraform lifecycle + the admin API), with no
   hostname. On this box they run like any other service, just without Share.
3. **Before a service is up** its hostname shows a Porthole "coming up" page, served by nginx over https. The same
   page shows whenever the service is stopped or restarting, so the address never errors.
4. **Raw ports:** a service may declare `expose: [{ port: 27015, proto: udp }]` for clients that do not speak http
   (game servers). On its own host these become security-group rules; on this box they are refused (the box only
   admits Cloudflare's edge on 80/443).

## Hosting modes

A live service runs in one of two places, chosen per service on the phone. Both read the same `PORTHOLE.md`, so a
service can move between them.

| | **On this box** | **On its own host** (roadmap) |
|---|---|---|
| Where | the Porthole box, next to your shells and agents | a separate cloud machine created by Terraform for this service |
| Cost | nothing extra | the host's hourly price, bounded by its lifetime |
| Isolation | shares the box, its disk and the agents' access | separate machine; a compromise of the service cannot reach the box, the Vault or your shells |
| Lifetime | until you stop it | until you stop it, or self-destructs at a set expiry |
| Control | directly, as with any registered server | through a small admin API on the host, authenticated with a per-host key that Porthole holds |
| Good for | dev previews, small always-on tools, anything cheap | public game nights, anything strangers will hit, anything you want gone afterwards |

The service page shows the same controls in both modes (start, stop, actions, logs, backup, update); only the
transport differs. For an external host, Porthole talks to its admin API over https with that host's credential,
which can do nothing except operate that one service and is destroyed with the host.

## Later: ephemeral hosts (roadmap, not built)

Run a live service on its own short-lived cloud machine instead of the Porthole box, e.g. a game server for one night.

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
- Porthole renders a Terraform stack per host from a template, applies it with its own state under
  `~/.porthole/ephemeral/<id>/`, boots the instance with cloud-init that clones the project at the pinned commit and
  starts the service from `PORTHOLE.md`, then points the chosen hostname at it with nginx + Let's Encrypt on that host.
- **Admin API** on each host: a tiny agent (start, stop, status, logs, actions, backup) bound behind nginx on the
  host's hostname under a random path, requiring a per-host key generated at creation. **Porthole holds the key**
  (encrypted in its own state, like a tunnel run token) and uses it whenever you operate the service from the
  phone; it is never exported to shells or agents, and it is revoked with the host. The host never has the cloud
  access key either; only Porthole does.
- **Expiry is enforced three ways**, so it holds even if Porthole is off: the instance's shutdown behaviour is
  `terminate` and cloud-init schedules `shutdown -h` at expiry; an EventBridge one-shot terminates it at expiry plus a
  margin; Porthole runs `terraform destroy` at expiry and removes the DNS record. EBS volumes delete on termination.
- **"Leaves nothing behind"** means no running resources, disks, addresses, DNS records or Porthole state remain.
  It cannot mean no record at all: the provider keeps billing lines and, if enabled, CloudTrail events.
- Data from the host is only kept if you press Backup before expiry (same private S3 bucket as above).
