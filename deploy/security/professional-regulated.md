# Security level: professional · regulated data

Work-grade software that stores or processes personal, payment or health data. Mistakes have legal consequences.

Assume the relevant regimes apply until the user says otherwise: **UK GDPR / EU GDPR** for any personal data (and the
Data Protection Act 2018 in the UK), **PCI DSS** for card data, and health-data rules (special category data under
GDPR; HIPAA if US patients are involved).

- Lawful basis and purpose for every personal field you add; record it in `docs/data-inventory.md` (what, why, where
  stored, who can see it, how long it is kept, how it is deleted).
- Data subject rights must be possible: export and erase a person's data on request, including from backups' next
  rotation and from third parties.
- Card data: never store card numbers or CVV; use the payment provider's hosted fields or checkout so card data never
  touches the server (keeps PCI scope to SAQ A).
- Health and other special-category data: separate store or encrypted columns with their own key, stricter access,
  every read logged.
- Personal data stays in-region unless the user approves a transfer; list every processor (hosting, email, analytics).
- Breach readiness: know how you would tell which records were exposed; GDPR expects notification within 72 hours.

- Data minimisation: store only what is needed, encrypt sensitive fields at rest, never log them, set retention and
  deletion. Know where every copy lives (backups, logs, analytics, third parties).
- Access to personal data is logged and reviewable; admin actions need a second factor.
- Flag anything that may need a DPIA, a processor agreement or PCI/HIPAA-style scoping to the user rather than
  deciding it yourself.
- Everything in the public-facing level applies as well: hostile input, abuse controls, rate limits.

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
