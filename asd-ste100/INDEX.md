# asd-ste100 — markdown inventory

Snapshot of every `.md` file in the repo (excluding `.agents/skills/` vendored
skill boilerplate), taken from `main` on 2026-10-06 for the SWE-10-5-2026
harness rebuild. Rewrite the files that belong in the new eval spec; the rest
are reference/context.

## Core eval contract (the spec layer)

| File | What it is |
|---|---|
| `SWE2_FLOWSTATE_FINISHING_GUIDE.md` | Operating contract: appraiser gate, read-only address runs, server/dashboard symmetry, end-to-end approval rubric |
| `docs/APPRAISER-RULESET.md` | Active product ruleset — the 11 current Set-B rules; changes need product-engineer sign-off |
| `docs/EVAL-PLAYBOOK.md` | Product rules in plain words — filter ladder, same-area, ARV comp definition, noise, Set-B, checked-box meaning |
| `docs/APPRAISAL_HARNESS.md` | Harness definition doc |
| `docs/FILTER-LADDER.md` | Full text of the rule-loosening ladder (sqft/year/sale-age) |
| `docs/EVALUATION-SYSTEM-SPEC.md` | Evaluation system specification |

## Harness history & audit evidence

| File | What it is |
|---|---|
| `docs/OFFICIAL-HARNESS.md` | Historical A/B winner (ship-time Set-B) — reference only |
| `docs/B-HARNESS-PLUS-TRICKS-OF-THE-TRADE.md` | B-harness tricks-of-the-trade writeup |
| `docs/HARNESS-STATUS-V2.md` | V2 harness status — evidence layers, compliance machinery |
| `docs/HARNESS_FINDINGS_LOG.md` | Findings log incl. pocket-equivalence decisions |
| `docs/HARNESS_KEEP_DROP_AUDIT.md` | The 14 dropped / 19 kept post-Georgia layers audit |
| `docs/CALIBRATION-FINDINGS.md` | Calibration findings |
| `docs/HARDENING-PLAN.md` | Hardening plan |
| `docs/EVALUATION_V4.md` | V4 evaluation doc (older generation) |
| `docs/EVALUATION_V4_IMPLEMENTATION_PLAN.md` | V4 implementation plan |

## eval-v4 subfolder (legacy pipeline docs)

| File | What it is |
|---|---|
| `docs/eval-v4/API.md` | eval-v4 API surface |
| `docs/eval-v4/RUNTIME.md` | eval-v4 runtime |
| `docs/eval-v4/WORKER_LANES.md` | Worker lane split |
| `docs/eval-v4/WORKER_RUNTIME.md` | Worker runtime notes |
| `docs/eval-v4/TS_PYTHON_CONTRACT.md` | TS/Python contract |
| `docs/eval-v4/REVIEW_POLICY.md` | Review policy |
| `docs/eval-v4/STAGING_SETUP.md` | Staging setup |
| `docs/eval-v4/PR_READINESS_REVIEW_2026-09-09.md` | PR readiness review |
| `docs/eval-v4/REMEDIATION_STATUS_2026-09-09.md` | Remediation status |
| `docs/eval-v4/V5_REPLACEMENT_REVIEW.md` | V5 replacement review |

## Provider / data-source docs

| File | What it is |
|---|---|
| `docs/attom-migration/ATTOM-MCP-ENDPOINTS.md` | ATTOM MCP endpoint reference |
| `docs/attom-migration/CLOUDFLARE-LEVERAGE-PLAN.md` | Cloudflare leverage plan |
| `docs/attom-migration/PROVIDER_SWAP.md` | Provider swap notes |
| `docs/jev-comp-classifier-v2.md` | JEV comp classifier spec |
| `docs/comp-photo-verification.md` | Comp photo verification |
| `docs/cdarv/DESIGN.md` | CDARV design |

## Feature / ops docs

| File | What it is |
|---|---|
| `docs/POCKET-PRESENCE-SPEC.md` | Pocket presence spec (metro-grouped queue, pocket scores) |
| `docs/dashboard/property-map.md` | Dashboard property map |
| `docs/dev-environment.md` | Local dev environment setup |
| `AB-TEST-2.md` | A/B test notes |

## Repo-level guides

| File | What it is |
|---|---|
| `AGENTS.md` | Git workflow hard rules + test-based workflow + testing rules |
| `CLAUDE.md` | Full repo guide: architecture, routes, DOs, auth, deploy |
| `README.md` | Repo readme |
| `apps/api/README.md` | API app readme |
| `apps/dashboard/AGENTS.md` | Dashboard agent rules |
| `apps/dashboard/CLAUDE.md` | Dashboard guide |
| `apps/extension/README.md` | Extension readme |
| `services/eval-engine/README.md` | Eval engine service readme |
| `services/ml/README.md` | ML service readme |

## Meta / tooling docs

| File | What it is |
|---|---|
| `.opencode/V4_PROVIDER_AUTHORITY_QA.md` | Provider authority QA |
| `.tern/standards.md` | Tern standards |
| `.21st/DESIGN.md` | 21st design context |

## Not included

- `.agents/skills/**/*.md` — vendored agent skill packages (21st, e2e, ship-pr, babysit, verify, writing-pr). Tooling boilerplate, not harness documentation. Say the word and I'll copy them in too.
