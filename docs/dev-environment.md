# Local Dev Environment

The dev environment is provisioned once, in the main checkout
(`~/src/flowstate-v5`). Untracked files carry everything:

| File | Purpose |
|------|---------|
| `apps/api/.dev.vars` | All provider keys + `DASHBOARD_URL=http://localhost:3000` (CORS) |
| `apps/dashboard/.env.local` | `NEXT_PUBLIC_API_URL`, Google Maps key, auth secrets |
| `apps/api/.wrangler/` | Local D1 — your dev user, settings, saved reports |
| `.data/local-candidate/login.json` | Recorded local test credential |

These are gitignored: they survive `git checkout` but do not exist in a
fresh clone or a new worktree.

## Verify

```bash
npm run dev          # start API (:8787) + dashboard (:3000)
npm run dev:check    # verify env files, servers, login, maps key, provider
```

`dev:check` exits non-zero and names the fix when anything is broken.
Run it before assuming a bug is in the code.

## Known failure modes (all caught by dev:check)

- **Login broken** — local account password drifted or the 15-min IP
  lockout (3 failures) tripped. Repair:
  `node scripts/dev-check.mjs --fix-login` resets `local@flowstate.test`
  to the recorded password and clears the lockout.
- **Google Maps blank** — the API key is HTTP-referrer restricted in GCP.
  `localhost:3000` must be in the key's allowed referrers. The check hits
  Street View metadata with a localhost `Referer` so it reports exactly
  this.
- **Provider data empty** — CoreLogic creds missing/rotated in
  `.dev.vars`. The check mints a free OAuth token (no data spend).
- **CORS errors** — `.dev.vars` `DASHBOARD_URL` must equal
  `http://localhost:3000`.
- **Shared-secret auth failures** — `BETTER_AUTH_SECRET` and
  `DASHBOARD_INTERNAL_SECRET` must match between `.dev.vars` and
  `.env.local`.

## If you ever need a fresh checkout

Copy these four paths from the main checkout, then `npm install`:

```
apps/api/.dev.vars
apps/dashboard/.env.local
apps/api/.wrangler/        (or re-run npm run db:migrate:local)
.data/local-candidate/login.json
```
