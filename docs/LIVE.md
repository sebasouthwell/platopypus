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

## Open points to decide

1. File name: `PORTHOLE.md` in the project root (proposed) or `docs/porthole.md`.
2. Whether `start` without `port` is allowed (worker processes with no listener): proposed yes.
3. Placeholder page: Porthole-branded "coming up" page, or a plain 503.
