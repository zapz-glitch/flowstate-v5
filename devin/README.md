# Devin Slack Pipeline — flowstate-v5

Devin-native automation: a message in the pipeline Slack channel runs a
Planner → Builder → Eval pipeline of Devin Cloud sessions that lands work on a
GitHub PR. CI, Devin Review, and a human gate sit between the PR and merge.

## Provisioned state (2026-09-15, org org-6c0122ecb67544ccb259ae9b1e9cc4dc)

**The pipeline is fully live.** All six automations enabled:

| Automation | ID | Trigger |
|---|---|---|
| `flowstate/plan` | `auto-625f17fff89c417088d4dc234a2f6b95` | `slack:message` (any top-level human message in `C0C1DRMK52T`) |
| `flowstate/build` | `auto-da479195ba094124b5d2b565dd029992` | `webhook:incoming` |
| `flowstate/eval` | `auto-6ffbc26fd3b8423a8b4a9ad02e741dac` | `github:pull_request` opened/sync/reopened on `devin/*` |
| `flowstate/repair` | `auto-07b6a0a9a44d4ef08fda86f68b8144a7` | review `changes_requested` + review comments on `devin/*` |
| `flowstate/ci-fix` | `auto-5829e59c07ba40109af9653d75842af7` | `github:check_run` failure on `devin/*` |
| `flowstate/main-verify` | `auto-776e11948866437b98df9335bb78c971` | `github:push` to `main` — full verify run |

Also live: playbooks `flowstate/{PLANNER,BUILDER,EVAL}` (`run_as: creator`),
org secrets `DEVIN_BUILD_WEBHOOK_URL`/`SECRET`, blueprint
`snapshot-blueprint-3773826372e144f9a872eaec89ee0faa` (build
`sbj-a10b70d88822449fb9fe4c42abf82994` success; verified in a Devin VM:
`npm install` + `npm run typecheck` green, api tests pass — note: 1 dashboard
regression file is red on `main`, pre-existing), Slack connected +
bot invited to `C0C1DRMK52T`. **Devin Review must be re-enrolled for
`zapz-glitch/flowstate-v5`** (Settings → Review → Add repo).

Org quirks encountered (definitions already adjusted): automation-level
`notifications.slack` unavailable; `session.notifications.slack` conflicts
with `attach_thread` replies; playbooks update via PUT not PATCH.

Reliability notes (v2 audit):
- Slack thread coordinates travel inside the spec file (`SLACK_CHANNEL` /
  `SLACK_THREAD_TS`) because GitHub/webhook payloads don't carry them.
- All mutating stages run `max_concurrent_runs: 1` — serializes spec numbering,
  same-branch pushes, and per-event fan-out (one review = N comment triggers;
  one CI run = N check_run triggers).
- `github:issue_comment` deliberately NOT used for repair — the automations'
  own `post_response` PR comments would re-trigger it (self-loop). Human
  feedback should come as a review or inline review comment.
- Eval counts only COMPLETED check failures (it fires on `opened`, before CI
  finishes); its PASS state-doc commit is idempotent so the `synchronize` it
  causes doesn't loop.
- Planner escalation: the session is thread-bound and waits for your reply; if
  it already ended, re-post the clarified request as a NEW top-level message.
- Optional upgrade idea: `slack:reaction_added` is available — e.g. a ✅ on the
  planner's packet could gate the build webhook (human plan-approval variant).

**Smoke test**: post a small, well-scoped request as a new top-level message in the channel and
watch the `flowstate/*` automation Activity tabs + the bound thread.

## Flow

```
Slack: new top-level message in the pipeline channel
  └─▶ flowstate/plan      (slack:message)   PLANNER session
        writes specs/NNN_<slug>.md on devin/NNN-<slug>, pushes, POSTs webhook
  └─▶ flowstate/build     (webhook)         BUILDER session
        implements the packet, pushes, opens PR → base branch
  └─▶ flowstate/eval      (github:pull_request: opened/synchronize/ready)
                                          EVAL session
        reproduces VERIFY, submits PR review verdict
        FAIL-BUILDER (request changes) ─┐
  ┌───────────────────────────────────┘
  └─▶ flowstate/repair    (github:pull_request_review/_comment)
                                          BUILDER session, repair mode
        applies findings, pushes → PR syncs → eval re-runs (max ~2 rounds)
  └─▶ flowstate/ci-fix    (github:check_run conclusion=failure)
                                          BUILDER session, ci-fix mode
  └─▶ Devin Review        auto-review on the PR (repo enrollment)
  └─▶ CI green + reviews clean → human tests → human merges
  └─▶ flowstate/main-verify (github:push to main)
                                          session runs install + typecheck +
                                          test + build on the new head, posts
                                          VERIFY PASS/FAIL to Slack (thread if
                                          the merge was a pipeline PR)
```

Handoffs travel through git (the spec file) and GitHub/webhook events — no
shared session state. Each stage is a fresh session: Eval never inherits the
Builder's context.

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

# 4. Apply: creates playbooks + automations, mints the build webhook,
#    uploads DEVIN_BUILD_WEBHOOK_URL / DEVIN_BUILD_WEBHOOK_SECRET org secrets
python3 devin/apply.py
```

Re-running is safe — resources match by name and update in place; the webhook
secret is preserved unless the webhook trigger is removed and re-added.

## Operating it

- **Request work**: post the request as a new top-level message in the
  pipeline channel, e.g. `add a market filter to the analysis endpoint`. The Planner binds to the thread and reports there.
- **Target a different base branch**: include `base: <branch>` anywhere in the
  message — e.g. `base: integration add the batch pause toggle back`. The
  Planner branches off it, records `BASE:` in the spec, and the Builder opens
  the PR to it. Default is `main`.
- **Post-merge verification**: every push to `main` (pipeline merge or your
  own) fires `flowstate/main-verify` — install, typecheck, test, build on the
  new head, result posted to Slack. It never deploys; deploys stay human.
- **Stages post to Slack**: every spawned session has `post_updates` to the
  pipeline channel, so each stage gets a live thread; the original request
  thread gets the Planner's packet and the final reports.
- **Watch runs**: Automations page → each `flowstate/*` automation → Activity
  tab; or Sessions filtered by the `flowstate-pipeline` tag.
- **Stop a runaway stage**: disable the automation (list page toggle) — queued
  invocations drain; running sessions can be stopped individually.
- **Tune spend**: `limits.max_acu_limit` per stage and
  `invocations.max_per_window` are set in each `devin/automations/*.json`;
  rebuild with `apply.py` after editing.

## Human gates

- Merge is always human. Eval `PASS` approves the PR; it never merges.
- `FAIL-PLANNER` and `ESCALATE` post to the Slack thread for a human.
- Optional plan approval: to require a human ACK between plan and build,
  don't run the webhook step automatically — disable `flowstate/build`,
  review the posted packet in the thread, then re-enable and let the Planner
  re-fire (or POST the webhook manually from `devin/.pipeline-secrets.json`).

## Security notes

- Slack messages are untrusted input. The playbooks instruct sessions to treat
  request text as data. For stronger isolation add a `net_policy` under
  `session_settings` in each automation JSON (allowlist github.com,
  api.devin.ai, slack.com, package registries).
- `devin/.pipeline-secrets.json` (webhook creds) is gitignored. Org secrets
  live in Devin Settings → Secrets; nothing secret is committed.
- Trigger condition field names are validated against the org's
  `automations/schemas` endpoint at apply time — if the API reports different
  field names, `apply.py` prints the valid set and aborts.

## Files

- `playbooks/{PLANNER,BUILDER,EVAL}.md` — org playbooks (applied via API)
- `automations/*.json` — declarative automation definitions
  (01_plan, 02_build, 03_eval, 04_repair, 05_ci_fix, 06_main_verify)
- `apply.py` — idempotent provisioner (playbooks → webhook → secrets → automations)
- `pipeline.config.json` — repo/branch/Slack coordinates
- `environment.yaml` — DRS blueprint for the repo's Devin VM environment
- `.pipeline-secrets.json` — minted webhook creds (gitignored)
