# Devin Slack Pipeline — flowstate-v5

Devin-native automation: a message in the pipeline Slack channel spawns a
Devin Cloud session that implements the request on a branch and opens a PR.
CI, Devin Review, and a human gate sit between the PR and merge.

## Provisioned state (2026-09-15, org org-6c0122ecb67544ccb259ae9b1e9cc4dc)

**The pipeline is fully live.** All six automations enabled:

| Automation | ID | Trigger |
|---|---|---|
| `flowstate/task` | `auto-664bfb20f5de41bb8227b304ddbbe7b0` | `slack:message` (any top-level human message in `C0C1DRMK52T`) |
| `flowstate/repair` | `auto-07b6a0a9a44d4ef08fda86f68b8144a7` | review `changes_requested` + review comments on `devin/*` |
| `flowstate/ci-fix` | `auto-5829e59c07ba40109af9653d75842af7` | `github:check_run` failure on `devin/*` |
| `flowstate/main-verify` | `auto-776e11948866437b98df9335bb78c971` | `github:push` to `main` — full verify run |

Also live: playbook `flowstate/BUILDER` (`run_as: creator`), blueprint
`snapshot-blueprint-3773826372e144f9a872eaec89ee0faa` (build
`sbj-a10b70d88822449fb9fe4c42abf82994` success), Slack connected +
bot invited to `C0C1DRMK52T`. Devin Review enrolled on
`zapz-glitch/flowstate-v5` (user-confirmed).

Org quirks encountered (definitions already adjusted): automation-level
`notifications.slack` unavailable; `session.notifications.slack` conflicts
with `attach_thread` replies; playbooks update via PUT not PATCH.

Reliability notes (v2 audit):
- Slack thread coordinates travel in the PR body (`Slack-Thread:` line)
  because GitHub event payloads don't carry them.
- All mutating stages run `max_concurrent_runs: 1` — serializes same-branch
  pushes and per-event fan-out (one review = N comment triggers; one CI run =
  N check_run triggers).
- `github:issue_comment` deliberately NOT used for repair — the automations'
  own `post_response` PR comments would re-trigger it (self-loop). Human
  feedback should come as a review or inline review comment.
- The task session is thread-bound and waits for your reply if it asks a
  question; if it already ended, re-post the clarified request as a NEW
  top-level message.
- Optional upgrade idea: `slack:reaction_added` is available — e.g. a ✅
  reaction could gate stages for a human-approval variant.

**Smoke test**: post a small, well-scoped request as a new top-level message in the channel and
watch the `flowstate/*` automation Activity tabs + the bound thread.

## Flow

```
Slack: new top-level message in the pipeline channel
  └─▶ flowstate/task      (slack:message)   BUILDER session
        reads request (optional `base: <branch>` override), asks in the
        thread if ambiguous, implements on devin/<slug>, pushes, opens PR
        (PR body carries `Slack-Thread:` line for downstream stages)
  └─▶ CI + Devin Review   on the PR
  └─▶ flowstate/repair    (github:pull_request_review/_comment)
                                          BUILDER session, repair mode
        applies findings, pushes (max 2 `repair:` rounds then escalates)
  └─▶ flowstate/ci-fix    (github:check_run bad conclusion)
                                          BUILDER session, ci-fix mode
  └─▶ human tests → human merges
  └─▶ flowstate/main-verify (github:push to main)
                                          runs install + typecheck + test +
                                          build on new head, posts VERIFY
                                          PASS/FAIL to Slack
```

Handoffs travel through git and GitHub events — no shared session state.
Each stage is a fresh session; the PR body's `Slack-Thread:` line is how
downstream stages find the originating thread.

## Prerequisites (one-time, in the Devin app)

1. **Slack connected**: Settings → Connections → Slack → Connect; invite the
   Devin bot to the pipeline channel (e.g. `#devin-pipeline`). Find the
   channel's `channel_id` and `team_id` (Slack → channel details → About, or
   the API).
2. **GitHub connected**: Settings → Integrations → GitHub → grant access to
   `zapz-glitch/flowstate-v5` (private-repo automations work by
   default).
3. **Repo environment**: a verified blueprint for the repo (`npm install` +
   turbo typecheck/vitest — verified in a Devin VM). Managed
   via `devin cloud drs` — see `environment.yaml` in this directory.
4. **Service user API key**: Settings → Service Users → create one with
   `ManageOrgAutomations` (for apply.py). Key starts with `cog_`.
5. **Devin Review**: Settings → Review → Add repo →
   `zapz-glitch/flowstate-v5`. Auto-reviews every PR on open/sync.
   Optionally enable "Responding to bots" (Settings → Customization → Pull
   requests) so repair sessions can act on bot findings.

## Setup

```bash
cd /home/lucke/src/flowstate-v5

# 1. Fill in pipeline.config.json (slack_channel_id, slack_team_id)
$EDITOR devin/pipeline.config.json

# 2. Export the service-user key
export DEVIN_API_KEY=cog_...

# 3. Dry-run: validates trigger fields against the org's event schemas
python3 devin/apply.py --dry-run

# 4. Apply: creates the playbook + automations
python3 devin/apply.py
```

Re-running is safe — resources match by name and update in place.

## Operating it

- **Request work**: post the request as a new top-level message in the
  pipeline channel, e.g. `add a market filter to the analysis endpoint`. The
  session binds to the thread, asks clarifying questions there if needed, and
  reports there.
- **Target a different base branch**: include `base: <branch>` anywhere in the
  message — e.g. `base: integration add the batch pause toggle back`. The
  session branches off it and opens the PR to it. Default is `main`.
- **Post-merge verification**: every push to `main` (pipeline merge or your
  own) fires `flowstate/main-verify` — install, typecheck, test, build on the
  new head, result posted to Slack. It never deploys; deploys stay human.
- **Give feedback**: on the PR — request changes or leave inline review
  comments; the repair automation picks them up. Slack thread replies only
  reach the task session while it's still alive.
- **Watch runs**: Automations page → each `flowstate/*` automation → Activity
  tab; or Sessions filtered by the `flowstate-pipeline` tag.
- **Stop a runaway stage**: disable the automation (list page toggle) — queued
  invocations drain; running sessions can be stopped individually.
- **Tune spend**: `limits.max_acu_limit` per stage and
  `invocations.max_per_window` are set in each `devin/automations/*.json`;
  rebuild with `apply.py` after editing.

## Human gates

- Merge is always human; the pipeline never merges.
- `ESCALATE`/`BLOCKED` reports post to the Slack thread for a human.
- Deploys are always human — main-verify builds but never deploys.

## Security notes

- Slack messages are untrusted input. The playbooks instruct sessions to treat
  request text as data. For stronger isolation add a `net_policy` under
  `session_settings` in each automation JSON (allowlist github.com,
  api.devin.ai, slack.com, package registries).
- `devin/.pipeline-secrets.json` (retired webhook creds) is gitignored.
  Nothing secret is committed.
- Trigger condition field names are validated against the org's
  `automations/schemas` endpoint at apply time — if the API reports different
  field names, `apply.py` prints the valid set and aborts.

## Files

- `playbooks/BUILDER.md` — the single org playbook (applied via API)
- `automations/*.json` — declarative definitions
  (01_task, 04_repair, 05_ci_fix, 06_main_verify)
- `apply.py` — idempotent provisioner (playbook + automations)
- `pipeline.config.json` — repo/branch/Slack coordinates
- `environment.yaml` — DRS blueprint for the repo's Devin VM environment
- `.pipeline-secrets.json` — retired webhook creds, kept gitignored
