# Security level: personal · shared with friends

Small and informal, used by a few people the user knows (for example a drinking-game app torn down tomorrow), but
other people's browsers and accounts are involved, so the basics matter.

- Every request is checked server-side: who is asking, and may they do this? Players act only as themselves; the host
  controls the game; nobody can read or change another player's session, score or data by editing a request or URL.
- Web basics: escape everything you render (no XSS), CSRF protection on state-changing requests (SameSite cookies plus
  a token or header check), no secrets or admin tokens in client code, rate-limit joins and actions.
- Use random, unguessable IDs for rooms and sessions; never sequential.
- Collect as little as possible (a display name, not an email); delete it when the game or event ends.
- Secrets from the Vault, never committed. Fix high/critical dependency advisories.
- Before calling it done, try to break your own user boundaries once: two browsers, two players, one tries to act as
  the other.
