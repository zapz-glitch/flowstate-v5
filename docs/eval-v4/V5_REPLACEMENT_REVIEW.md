# V4 replacement review for Flowstate v5

Date: 2026-09-08. Candidate branch: `v4-python`.

## Decision

Local testing update, 2026-09-08: the candidate now uses an authenticated
loopback Python bridge after existing CoreLogic evidence retrieval. The browser
preserves tagged Python results, and the saved report retains the full Python
result and settings snapshot. Owner-approved minimum-one-comp behavior is active.
Live browser and saved-report verification passed with two qualifying comps.
See `.opencode/ENGINEERING_STATE.md` for evidence and local startup details.
The findings below describe the earlier production replacement review; they
do not describe the current local bridge. Production cutover remains unapproved.

Keep the existing evaluator active until the application integration passes.
The Python foundation passes its tests, but it cannot yet replace the current
application evaluation path. SOL returned CHANGES_REQUIRED for replacement.

Production main remains at `16f879a`. Merge `2b7a1e6` brings that baseline into
the V4 branch. The merge resolved lockfile license metadata conflicts without
changing application behavior.

## Replacement blockers

1. `api/providers.py` has no live evidence implementation. The worker entrypoint
   supplies no provider. Enabling external calls now fails startup explicitly.
2. `apps/api/src/durable-objects/analysis-job.ts` and
   `apps/api/src/routes/webhooks/ghl.ts` still call TypeScript `performAnalysis`.
   The candidate needs authenticated submit/poll and response translation that
   preserves existing job, SSE, report, and batch contracts.
3. `apps/dashboard/src/hooks/use-analysis-evaluation.ts` overwrites backend
   values with browser recalculation and handles manual comparable selection in
   TypeScript. Permission for nonvisual data handling changes is pending.
4. Legacy settings contain the ambiguous 501000 tier boundary. The V4
   methodology requires exact 500000 boundaries and rejects silent conversion.
   A settings migration must preserve saved economics and record provenance.
5. CoreLogic normalization can synthesize sale price from PPSF times area.
   The evidence adapter must preserve actual sale provenance and reject
   unsupported prices instead of presenting them as verified transactions.
6. No service credentials have been rotated. Provider administration access
   and a secure replacement-secret source are pending.
7. Investor-cohort statistical policy still requires the approval described in
   `EVALUATION_V4.md` before production cutover.

## Verification

- Final independent QA and SOL review verified the preparatory code at
  `77a6e9a498c511381de40206fa32134c36e4fe35`: 210 tests passed with 27 warnings
  in 58.86 seconds. This does not approve the evaluator replacement.
- Existing Python suite: 207 passed, 27 deprecation warnings.
- New worker configuration tests: 3 passed.
- Tests used isolated PostgreSQL 16.15 at loopback port 55440, including
  authenticated batch sizes 1, 5, 10, 20, and 50, migrations, tenant isolation,
  worker recovery, and limiter coordination.
- Initial failures were environment setup errors: sandbox sockets and an
  unusable WSL Docker shim. A task-local wrapper for Docker Desktop resolved
  them without changing system configuration.
- Python dependency consistency: `pip check` passed using the existing locked
  V4 environment. This is not a Python vulnerability audit or a fresh image
  build.
- Both workspace typechecks and the dashboard production build passed before
  and after the initial compatible dependency updates. Final verification is
  recorded in `.opencode/ENGINEERING_STATE.md`.
- Production npm audit fell from 24 affected packages (2 critical, 15 high,
  4 moderate, 3 low) to zero after compatible updates and targeted Vite/esbuild
  overrides. The complete development tree retains four moderate findings
  involving the old Drizzle tooling and esbuild chain.
- `npm test` in the API is a disabled placeholder. It is not test evidence.
- No live provider calls, application end-to-end evaluation, browser regression,
  secret rotation, production deployment, or replacement cutover was verified.
- Final typechecks, production build, API Wrangler dry-run bundle, and existing
  secret scan passed. The dedicated test container and volume were removed
  after independent QA; no production storage was used.

## Runtime findings

`compose.dev.yaml` references an API-worker build directory without a
Dockerfile, shares `V4_API_PORT` between two services, and sets an API URL to
container-local loopback. It also uses the older `flowstate-v4-dev` project
name. The full application runtime needs repair and a distinct candidate
project before launch. The isolated Python test database does not establish
that Compose can run the product.

## Credential inventory

Names only; no values belong in this report or Git.

| Service | Configuration names | Required rotation access |
|---|---|---|
| Cotality/CoreLogic | CORELOGIC_CLIENT_ID, CORELOGIC_CLIENT_SECRET | Provider application administration |
| BatchData | BATCH_DATA_API_KEY | Provider key administration |
| ATTOM | ATTOM_API_KEY | Provider key administration if enabled |
| OpenRouter | OPENROUTER_API_KEY | Account key administration |
| Gemini | GEMINI_API_KEY | Google project key administration |
| Maps | NEXT_PUBLIC_GOOGLE_MAP_KEY | Google project restrictions and key administration |
| Firecrawl | FIRECRAWL_API_KEY | Provider key administration |
| SMTP | SMTP_USER, SMTP_PASS | Mail provider credential administration |
| Application authentication | BETTER_AUTH_SECRET, DASHBOARD_INTERNAL_SECRET | Deployment secret manager |
| Python API | V4_API_CREDENTIALS or V4_INTERNAL_API_TOKEN | Candidate server secret configuration |

Existing global state records a historical BatchData credential exposure.
Do not recover that credential from Git history. Maps browser keys require
origin and API restrictions; they are not confidential server credentials.

For each enabled service, issue the replacement, update its intended consumers,
verify authentication, and only then revoke the previous credential. Record
provider key IDs, target environment, and verification time without values.
The existing Python auth contract supports a previous token hash with explicit
expiry during rotation. Candidate testing needs separate credentials where
the provider supports them; changing a local environment value alone is not
provider-side rotation.

## Antislop

Applied during work to comments and documentation. New documentation states
observed results and limitations; the guard adds no narrative comments. UI
design checks do not apply to this package because no UI was changed.
