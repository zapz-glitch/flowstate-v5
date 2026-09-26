# AGENTS.md

## Git workflow (hard rules — established 2026-09-26)

- **Production main is the source of truth and is treated as untouchable.**
  `main` deploys automatically on every push. No force-push, no rebase, no
  amend of main history. Code changes never go directly onto main.
- **One active worktree.** All work happens in this checkout
  (`~/src/flowstate-v5`). Do not create additional `git worktree`s without
  explicit instruction. When a branch merges or is abandoned, its worktree
  is removed the same day.
- **Feature branch lifecycle — short-lived, one change each:**
  1. `git checkout main && git pull` — always branch from current main.
  2. `git checkout -b feat/x` or `fix/x` — one concern per branch.
  3. Commit as you go, push, open a PR (`gh pr create`).
  4. Merge via GitHub once verified (squash merge preferred).
  5. Delete the branch after merge; `git checkout main && git pull`.
- **Never merge main INTO a feature branch to "update" it.** That pattern
  produced the tangled ancestry this repo had before the 2026-09-26
  cleanup. If a branch goes stale, rebase onto `origin/main` or abandon it
  and re-branch. Merges flow one direction only: feature → main, via PR.
- **Never re-merge a reverted branch.** If merged work was reverted on
  main, the fix lands as a NEW commit/PR. Git treats the old commits as
  already merged and will silently bring in nothing.
- **ENGINEERING_STATE.md** is union-merged (see `.gitattributes`) so it
  cannot conflict. Update it on the active branch and commit it with the
  work — never leave it dirty across sessions or sessions end with
  uncommitted state.
- **Stale branches:** anything unmerged older than ~2 weeks needs
  justification or gets deleted. Branches are cheap; confusion is not.

## Local dev environment (lives only in this checkout)

The dev environment is provisioned exactly once, in
`~/src/flowstate-v5`, via untracked files that persist across branch
switches:

- `apps/api/.dev.vars` — all provider keys (CoreLogic, Firecrawl,
  OpenAI/OpenRouter, Close, CDARV) + `DASHBOARD_URL=http://localhost:3000`
  for CORS
- `apps/dashboard/.env.local` — `NEXT_PUBLIC_API_URL`, Google Maps key,
  auth secrets
- `apps/api/.wrangler/` — local D1 with your dev user/settings
- `node_modules/` — installed deps

These are gitignored — they survive `git checkout` but do NOT exist in a
fresh clone/worktree. This is why branches opened in separate worktrees
had no keys, no maps, no local DB. Under the one-worktree rule this
never happens again: branch in place, `npm run dev`, everything works.

If a new checkout is ever unavoidable, copy those four paths into it.

## Test-based implementation workflow

1. **Summary** — state what is being built and why, in plain language.
2. **Plan** — the approach and the changes it touches.
3. **Define success first** — before any code changes, write down what a
   successful result is and get agreement on it. This is the contract the
   implementation must satisfy — not a guess after the fact.
4. **Test implementation** — build the E2E assertions/artifact that encode
   the agreed definition of success.
5. **Code changes** — implement against the test.
6. **E2E verify** — run the end-to-end test and produce the artifact;
   green means the agreed definition of success is met.

## Testing rules

- Never write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
- If you must test a system in isolation, first write down all the ways it could fail, then write the code.
