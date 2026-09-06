# Flowstate Evaluation V4

Status: methodology source for the V4 candidate.

Sections that restate the owner's directive are product requirements. Items
explicitly labeled as engineering choices define deterministic implementation
details where the directive requires a choice but does not prescribe one.

Directive provenance: owner message in OpenCode session
`ses_f87b73cc2ffettALmXiiPS7sbc`, SHA-256
`57ac31c31f8a2534b589f04c6562d99fe4363081793fd9d93ca06409a6a1921c`.
The session export is the immutable source record; this document is the
maintainer-facing transcription.

V4 changes the evaluation technology without redesigning Flowstate. Python is
the only authoritative financial calculator. Markdown explains the policy,
Evaluation Settings supply configurable values, and versioned Python code
executes the policy. Production evaluation must not interpret this document or
call an LLM.

## Product boundaries

- Keep the current React, Next.js, TypeScript, Tailwind, and shadcn/ui product.
- Preserve page layouts, navigation, components, visual styling, settings
  screens, report sections, controls, and operator workflows.
- Keep legacy and V3 implementations available for reference and rollback.
- Do not deploy, change `main`, modify the primary integration worktree, or
  decommission an existing implementation during candidate development.
- Normal V4 evaluation makes no OpenAI or Firecrawl calls.
- Record methodology version `evaluation-v4` and the immutable settings
  snapshot version with every result.

## Evaluation settings

V4 consumes these existing settings sections:

1. Appraisal Rules
2. Renovation Levels
3. Deal Parameters
4. Major Items

The legacy Thresholds tab does not control V4 decisions. Major Items age
thresholds remain active. The UI may remain visible while V4 ignores its
legacy percentile and as-is threshold values.

Resolve one immutable settings snapshot before appraisal or financial work
starts. Store each value, unit, enabled state, source, scope, precedence,
snapshot version, and content hash. Current compatible precedence is:

1. Explicit request override
2. ZIP override
3. City and state override
4. State override
5. User default
6. System default

New evaluations use settings saved successfully before they start. In-flight
evaluations retain their original snapshot. Reevaluation creates a new result
version. Missing, disabled, zero, and null are distinct values.

## Evidence rules

CoreLogic or Cotality provides subject facts, comparable candidates, and
available subject permit evidence. Provider output is evidence, not proof that
a comp meets Flowstate rules.

- Use verified sale price only. Do not substitute AVM, assessed value, list
  price, or loan amount.
- Deduplicate transactions and properties deterministically.
- Unknown required fields fail the relevant rule. Unknown optional fields stay
  visible with their limitations.
- Exclude non-sales, zero or missing prices, prohibited transactions, wrong
  property types, and duplicate evidence.
- Keep source identifiers, report links, evidence limitations, and explicit
  rejection reasons.
- Price does not prove buyer identity or an off-market transaction.

`OWNER_REQUIREMENT`: apply configured property-type and transaction rules.
`UNRESOLVED`: current settings do not enumerate all prohibited transaction
codes. V4 may reject intrinsically invalid evidence, including a missing or
non-positive verified sale price and duplicate transactions, but it must not
invent additional prohibited code lists.

## ARV comparable selection

The normal ARV sequence is deterministic:

1. Resolve the subject.
2. Retrieve the candidate comparable universe.
3. Validate and deduplicate sale evidence.
4. Sort by verified sale price descending.
5. Apply the documented equal-price tie-breaker.
6. Starting with the highest price, apply every enabled Appraisal Rule.
7. Accept a passing distinct property or record its rejection reasons.
8. Stop ARV examination immediately after three valid properties are accepted.

Do not rank by PPSF, add a percentile gate, require clustering, ask an LLM to
select comps, or relax a rule to force three comps. Candidates below the early
stop are `NOT_EXAMINED_FOR_ARV`, not rejected. Fewer than three accepted comps
produces `INSUFFICIENT_COMPS` with the accepted evidence and reasons preserved.
Do not call these comps vision verified or assign unsupported accuracy claims.

Engineering choice: equal verified sale prices sort by normalized sale date
descending, stable provider property ID ascending, then normalized address
ascending. This choice is deterministic and does not alter the owner's
sale-price priority.

## ARV calculation

All authoritative financial values use Python `Decimal` created from validated
decimal strings. For each accepted comp `i`:

```text
adjusted_sale_price_i =
  verified_sale_price_i + approved_signed_comp_adjustments_i

adjusted_ppsf_i = adjusted_sale_price_i / comp_sqft_i

average_adjusted_ppsf =
  (adjusted_ppsf_1 + adjusted_ppsf_2 + adjusted_ppsf_3) / 3

base_arv = average_adjusted_ppsf * subject_sqft

final_arv = base_arv + approved_signed_subject_adjustments
```

Use the arithmetic mean. Do not use a weighted mean or pooled price-to-square-
foot ratio. Comparable adjustments normalize a comp toward the subject.
Subject adjustments cover remaining configured subject differences. Apply the
existing bedroom, bathroom, feature, and proximity rules with their configured
signs and units. Apply each influence once.

Every ledger entry records the affected subject or comp, rule ID, signed
amount, units, evidence, input, and calculation stage.

## Investor acquisition analysis

Investor analysis is separate from ARV and examines the complete eligible
comparable universe even after ARV reaches its early stop. It identifies a
defensible local lower-price or lower-PPSF cohort within comparable housing
stock.

The method must be deterministic and versioned. It must use a local
distribution, handle extreme outliers robustly, avoid national dollar bands,
avoid a fixed percentage of ARV, and decline to force a cohort when the sample
is weak or unimodal. Non-ARV comps are not automatically investor comps.

Label unsupported buyer identity as inferred investor or as-is pricing. Return
observed mean, median, range, sample count, adjusted investor PPSF,
subject-specific Investor Acquisition Value, status, exclusions, and
limitations.

For each qualified investor comp `j`:

```text
investor_adjusted_price_j =
  verified_sale_price_j + approved_signed_adjustments_j

investor_adjusted_ppsf_j =
  investor_adjusted_price_j / investor_comp_sqft_j

investor_mean_ppsf = arithmetic_mean(investor_adjusted_ppsf_j)

subject_investor_value =
  investor_mean_ppsf * subject_sqft
  + applicable_approved_subject_adjustments
```

If no defensible cohort exists, return `INSUFFICIENT_INVESTOR_DATA` without
failing a supported ARV. Investor pricing never replaces ARV or changes MAO.

`OWNER_REQUIREMENT`: the behavior and outputs in this section.
`UNRESOLVED`: the directive requires a deterministic robust local method but
does not specify its statistical thresholds or minimum sample. The
implementation package may propose and document a method as an
`ENGINEERING_PROPOSAL`. The owner must approve that method before production
cutover, and no production-accuracy claim may be made from candidate tests.

## Renovation and major items

The subject renovation level is a supplied or saved operator input:

- Lipstick
- Light Cosmetic
- Full Cosmetic
- Heavy Rehab
- Full Gut

Select the Renovation Levels row using the unrounded final ARV and subject
renovation level. Owner tier boundaries are:

- Under $500,000
- $500,000 to under $1,000,000
- $1,000,000 through $3,000,000
- Over $3,000,000

Stored boundaries must map explicitly to these tiers. Reject gaps, overlaps,
positional-array errors, and conflicting boundaries. Retrieve the configured
rehab cost per square foot and flip-profit requirement from the same cell.

`LEGACY_COMPATIBILITY`: existing stored keys and labels differ from V4. Import
and UI mapping is defined in the compatibility table below. Ambiguous legacy
ranges fail V4 snapshot creation instead of silently shifting a boundary.

```text
base_rehab = subject_sqft * configured_rehab_rate
```

Major Items apply after base rehab. Initial systems are Roof, HVAC, Water
Heater, Electrical Panel, Plumbing, and Rewiring. For each rule, preserve the
enabled state, age threshold, replacement cost, evidence, and override
provenance.

Use subject evidence only. A permit supports replacement only when its scope
and completion evidence establish the relevant installation or replacement.
No permit does not prove an original system. Property age is not automatically
system age. Apply cost only when supported age exceeds the configured
threshold. Equal age does not trigger replacement.

Avoid overlap with base rehab, panel versus rewiring, repeated permits, and
manual items. Unknown or conflicting evidence stays visible and can make rehab
and MAO preliminary without invalidating an otherwise supported ARV.

The other eleven legacy Major Items remain visible and preserve their saved
values. They may enter V4 only as explicit operator-supplied additional
renovation items with provenance. They are not automatically inferred by the
initial V4 system-age pathway.

```text
total_rehab =
  base_rehab
  + additional_nonduplicated_major_items
  + approved_additional_renovation_items
```

## Deal parameters and offer calculations

Use existing Deal Parameters for disposition or Realtor costs, closing costs,
carrying costs, wholesale fee, initial-offer behavior, and other approved
economics. Use the tier and renovation-specific flip profit from Renovation
Levels. Record what each percentage applies to and do not double-count combined
selling costs or the wholesale fee.

Preserve distinct values for the investor purchase ceiling, seller contract
ceiling, wholesale fee, Initial Offer, and displayed MAO according to existing
approved definitions. The current approved core formula is:

```text
closing_costs = final_arv * configured_closing_cost_percent
carrying_costs = final_arv * configured_carrying_cost_percent

investor_purchase_ceiling =
  final_arv
  - total_rehab
  - closing_costs
  - carrying_costs
  - configured_flip_profit

seller_contract_ceiling =
  investor_purchase_ceiling - configured_wholesale_fee
```

Until an existing Initial Offer rule is found and mapped, V4 returns that
field as incomplete rather than guessing a new financial assumption.

## Rounding

Keep exact Decimal calculations and a complete ledger. Display headline money
to the configured increment using the existing rounding mode. The current
owner standard is nearest $1,000 with no cents, while an explicitly configured
$500 increment remains supported. PPSF uses its own decimal precision.

Never feed display-rounded values back into formulas unless a versioned policy
requires it. Record each display-rounding difference. Preserve exact ceilings
for offer validation even when the displayed MAO rounds upward.

`OWNER_REQUIREMENT`: nearest $1,000 headline display with no cents and support
for an explicitly configured $500 increment. `LEGACY_COMPATIBILITY`: current
TypeScript formulas round many components to dollars and expose no persisted
rounding setting. V4 stores an explicit rounding policy in its snapshot.
Existing rows with no policy import the owner standard with an auditable source.

## API and durable execution

`POST /v1/evaluations` accepts 1 to 50 properties. Authenticate and validate
the complete request before durable acceptance. Persist the batch and property
jobs, then return HTTP 202 with the batch ID, each evaluation ID, and initial
status.

Provide:

- `GET /v1/evaluations/{evaluation_id}`
- `GET /v1/evaluation-batches/{batch_id}`

Execution requires tenant-scoped idempotency, same-key and different-payload
conflict detection, atomic claims, leases, heartbeats, stale-claim recovery,
bounded retries, restart-safe checkpoints, idempotent result commits, visible
terminal failures, per-property isolation, and reasonable batch fairness.
Client disconnects do not cancel accepted jobs.

Provider coordination starts with provisional global limits of 40 requests per
minute and four concurrent calls. Count every call and retry. Coordinate all V4
workers sharing credentials, honor `Retry-After`, use bounded exponential
backoff with jitter, and persist deferred retries. Do not claim global coverage
for legacy consumers outside the coordinator.

`ENGINEERING_PROPOSAL`: enforce the owner's provisional 40 RPM and four-call
operating caps in V4 until provider entitlement evidence establishes a lower
cap. Raising either cap requires a recorded operational decision. Legacy
consumers remain a documented limitation until they share the coordinator.

## Legacy settings compatibility

| Existing setting | V4 canonical meaning | Import behavior |
|---|---|---|
| `under501k`, max 501000 | `under500k`, ARV less than 500000 | Reject as ambiguous until saved with exact V4 boundaries |
| `501kTo999k`, min 501000, max 1000000 | `500k_to_under1m`, 500000 inclusive to 1000000 exclusive | Reject the old 501000 lower boundary |
| `1mTo3m`, min 1000000, max 3000000 | `1m_to_3m`, 1000000 through 3000000 inclusive | Convert only with explicit inclusive-upper V4 semantics |
| `over3m`, min 3000000 | `over3m`, greater than 3000000 | Reject overlap at exactly 3000000 |
| UI `Down to Stud`, index 4 | canonical `full_gut`, owner label `Full Gut` | Preserve UI label; map index 4 to canonical key |
| `roof`, `hvac`, `water_heater` | same canonical IDs | Initial automatic system-age pathway |
| `electric_panel` | `electrical_panel` | Canonical alias, initial automatic pathway |
| `replumb` | `plumbing` | Canonical alias, initial automatic pathway |
| `rewire` | `rewiring` | Canonical alias, initial automatic pathway |
| Remaining eleven Major Items | Additional operator items | Preserve and display; never auto-infer in initial V4 |
| Threshold percentile and as-is percent | no V4 decision field | Preserve UI and storage; exclude from V4 snapshot and calculations |

Boundary fixtures cover 499999.99, 500000, 999999.99, 1000000,
3000000, and 3000000.01. Snapshot creation fails on gaps, overlaps, duplicate
keys, missing levels, or arrays whose position conflicts with canonical keys.

## Result states

Evaluation and section statuses are explicit:

- `QUEUED`
- `RUNNING`
- `COMPLETED`
- `REVIEW_REQUIRED`
- `INSUFFICIENT_COMPS`
- `INSUFFICIENT_INVESTOR_DATA`
- `FAILED`

An evaluation can complete with a supported ARV and a preliminary renovation
or MAO section. Errors and limitations belong to the affected property or
section and do not erase valid independent work.

## Verification standard

Completion requires exact Decimal fixtures, contract tests, persistence and
recovery tests, isolated batch tests at 1, 5, 10, 20, and 50 properties,
security and tenant isolation tests, browser regression checks, and independent
review of the exact integrated commit. Stubbed throughput is not live capacity
evidence. A bounded real-provider run must separately prove one supported
stored evaluation and one correctly incomplete evaluation before production
cutover can be considered.
