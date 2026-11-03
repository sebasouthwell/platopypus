# Security level: personal · private

Only the user will use this (for example a personal bus tracker with their own live location). No one else's data.

- Protect access: anything reachable from the internet requires a login (or sits behind Porthole) so nobody else can
  use it as the user or see their data. Prefer one strong secret or passkey over a home-made password scheme.
- Secrets come from the Vault (`vault get`), never in code or committed files. `.env` stays out of git.
- Keep the user's own data (location, accounts, history) out of logs and error messages, and out of public URLs.
- Keep dependencies current; fix anything `npm audit` / `pip-audit` reports as high or critical.
- Reasonable, not heavy: no need for formal threat models or exhaustive tests.
