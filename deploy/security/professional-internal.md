# Security level: professional · internal tool

Work-grade software used inside a team or company. Treat it as something others depend on.

## Every iteration (not just at the end)

- After each change, re-test every user boundary the change touches: authentication, authorisation for every role
  and object (no IDOR: change an ID in a request and confirm it is refused), session handling, input validation and
  output encoding. Write these as automated tests and keep them passing.
- Threat-model new features briefly before building them: who can reach this, with what, and what is the worst case.
- Secrets only from the Vault or the platform's secret store; never in code, logs, client bundles or error pages.
- Least privilege for every credential, service account, database user and cloud role you create.
- Security headers (CSP, HSTS, frame-ancestors), CSRF protection, rate limits and audit logs for sensitive actions.

## Vulnerabilities — daily routine

- At the start of every session, run `project security`. If it says the CVE check is due (more than a day old), do it
  before other work, even if nothing changed:
  - dependency audit for every ecosystem in the project (`npm audit --omit=dev`, `pip-audit`, `cargo audit`,
    `osv-scanner -r .` if installed; ask with `elevate` to install osv-scanner once if missing),
  - base images and system packages the project runs on (`docker scout cves` / `trivy` if available),
  - check new advisories for the frameworks and services the project uses.
- Report findings by severity with the fix; fix critical and high now, plan medium. Then run `project cve-checked`.

## Before anything ships

- Full test suite including the boundary tests, dependency audit clean of high/critical, no secrets in the diff
  (`git diff` review), and a short written summary of what changed security-wise.
