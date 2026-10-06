# Flowstate Evaluation V4

Status: methodology source for the V4 candidate.

## Experimental upper-half policy, September 8, 2026

Owner authorized implementation and three ordered address tests. This section
supersedes the earlier automatic single-reference policy for new local reports.
It does not constitute owner app approval or production readiness.

- New signed snapshots use `upper_half_rule_weighted_v1`. Existing snapshots
  without that setting retain legacy selection and arithmetic on recalculation.
- Validate sales and apply configured subdivision, year, size and distance gates
  before classifying prices. Unknown style stays preliminary; a known mismatch
  requires high-confidence visual physical similarity. Missing photos do not
  prevent numerical evaluation. Garage capacity, when known for the subject,
  adds a preference check rather than a hard exclusion.
- Sort qualified recorded sale prices descending. Retain `ceil(count / 2)` and
  all equal-price ties at the cutoff. Lower-half sales are inferred lower-market
  references, not proof of as-is condition. Do not force additional ARV comps.
- Each selected adjusted PPSF receives raw weight
  `max(rule_match_fraction, 0.01) * 180 / (180 + sale_age_days)`. Normalize these
  weights and multiply the weighted PPSF by subject sqft. Apply existing subject
  adjustments afterward. Recent upper-half sales rank before older ones; recency
  never rescues a physically disqualified sale. The 0.01 floor supports explicit
  manual selections with zero known rule matches and requires review.
- With at least four physically qualified sales, quarantine a sale PPSF above
  three times their median from automatic ARV pending price review. This is an
  experimental plausibility check, not proof that the transaction is invalid.
- Keep the configured180-day window pending owner choice on a sparse-market
  12-month fallback. No cross-subdivision or size relaxation is implied.
- Refresh available Zillow evidence before final price classification. Exact
  property identity, completed-sale date and price must be established together.
  Asking price never substitutes for sold price. Store original evidence and
  resolved provenance internally; UI/PDF use resolved values only. Conflicts
  remain explicit and must not be silently overwritten.
- All computations remain in Python. Vision contributes constrained physical
  observations only, not prices or independent comparable selection.

N03/N04: implementation under test, owner approval pending. N01/N05 historical
retrieval expansion remains pending. N07/N08 permit-system ages and hazards
remain incomplete. Keep the checklist below open until owner app approval.

Local acceptance evidence: Heritage Cove returned zero qualified sales under
the180-day limit. Piedmont report `job_1788912849879_0m36c2vk` selected two tied
upper-half sales with recency weights, displayed ARV317000 andBuy198000; Zillow
was unavailable before local credential reload. Final Magnolia report
`job_1788913320994_25fyexz6` selected one comp, displayed ARV384000 andBuy246000,
and persisted corroborated Zillow sales. PDF uses resolved50,300 subject sale,
not old345,000; the large price change is flagged for transaction-scope review.
Vision parsing is repaired, but available front-exterior evidence remains
unverified. Lot-size tolerance/weighting and historical fallback remain decisions,
not completed rules. No owner acceptance inferred from these tests.

## Next implementation tasks: awaiting owner app approval

Updated 2026-09-08. The owner resumed implementation after requesting that these
tasks remain in this Markdown file until they have been demonstrated in the
application and explicitly approved by the owner. Automated tests, agent QA,
and code completion alone do not close a task. Keep completed entries and
their approval evidence as history rather than deleting them.

The directives below supersede conflicting single-reference selection and
unweighted-average language later in this document as future requirements.
They are not a claim that the running application implements them. Before
resuming implementation, reconcile the executable policy and affected sections
below with the owner's decisions on the unresolved details.

Task states: Pending implementation -> In progress -> Ready for owner app test
-> Owner approved. Record the tested report/address, code revision, verification,
approval date, and the owner's explicit acceptance for each approved task.

- [ ] V4-N09: Simplify comparable diagnostics for users. Show whole match
  percentages, plain-language year/style/subdivision comparisons, and size/lot
  differences as whole percentages instead of raw ratios. Keep exact evidence in
  backend output; never round an incomplete match to100%. Unknown evidence stays
  explicit. Status: Ready for owner app test; owner approval: pending.
- [ ] V4-N10: Use the top-right comparable checkbox to add/remove it from ARV.
  Recalculate in Python from the signed saved evidence/settings, retaining hard
  verified-sale gates and mismatch warnings. Manual selection uses the current
  snapshot's policy: legacy arithmetic mean or experimental rule/recency-weighted
  adjusted PPSF. Manual choices remain explicit overrides requiring review.
  Reject empty selection, invalid evidence and stale edits; show pending/error
  feedback. Persist selection, valuation and audit history atomically; Reset
  restores automatic selection. Older unsigned reports require New Analysis.
  Status: Ready for owner app test; owner approval: pending.

- [ ] V4-N01: Prefer older sales within the subject subdivision before selecting
  sales from another subdivision. Expand the sale-date search first, retaining
  physical comparability and verified-sale gates. Show the search stages and
  sale-age limitations. Agree on maximum lookback before implementation.
  App acceptance: an older physically comparable same-subdivision sale is used
  ahead of a recent different-subdivision sale. Status: Pending implementation;
  owner approval: pending.
- [ ] V4-N02: Treat subdivision, year built, and square footage as jointly
  important comparability requirements. Do not let an exact year match override
  an unacceptable size difference. Retain lot size and physical-style evidence.
  Agree on tolerances and how joint importance affects ranking; do not invent
  numeric weights. App acceptance: inspect smaller, similar-size, and larger
  candidates and their adjusted PPSF contributions against the subject.
  Status: Pending implementation; owner approval: pending.
- [ ] V4-N03: Classify the highest recorded sales that match the appraisal rules
  as ARV pricing references, and the lower matched sales as inferred as-is pricing
  references. Rule adherence alone does not establish ARV eligibility or actual
  renovation condition. Price alone does not prove condition or buyer identity.
  Agree on upper/lower cohort cutoffs, ties, and sparse-sample behavior. App
  acceptance: report clearly separates ARV, inferred as-is, and unclassified
  references with the selection evidence. Status: Pending implementation;
  owner approval: pending.
- [ ] V4-N04: Consider all comparably qualified ARV references rather than
  automatically limiting the result to one. Resolve the owner's requested
  rule-match-weighted ARV average, including equal-score inclusion, weighting
  formula, cohort limits, and zero/unknown scores. Keep the minimum of one usable
  verified reference when evidence is sparse, with preliminary status. Never
  blend lower as-is references into ARV solely because they have the same score.
  App acceptance: selected comps, normalized weights, adjusted PPSF, and final
  calculation can be reconciled in the report. Status: Pending implementation;
  owner approval: pending.
- [ ] V4-N05: If no usable comps return, expand retrieval parameters in visible,
  bounded stages, starting with time within the subdivision. Preserve hard sale
  evidence gates and report exhausted searches honestly. Confirm provider support
  and search limits; ensure cache keys include all effective search parameters.
  App acceptance: an initially empty search retrieves actual additional evidence,
  and a truly exhausted search reports insufficient evidence without inventing a
  valuation. Status: Pending implementation; owner approval: pending.
- [ ] V4-N06: Display valuation and buy-price headlines rounded to nearest
  $1,000 with no cents, consistent with the existing rounding section; retain
  explicit $500 support. The latest phrase "nearest thousandth" was queried;
  nearest $1,000 is the documented baseline, pending owner confirmation in app.
  Keep exact Python financial values for formulas, tier selection, and ceiling
  validation. Use the investor ceiling for Buy, not seller/wholesale MAO.
  App acceptance: dashboard, saved report and PDF agree, including halfway cases.
  Status: Ready for owner app test. Python/API/dashboard tests, saved-report
  browser verification and PDF download passed; owner approval: pending.
- [ ] V4-N07: Retrieve and preserve actual subject permit evidence and wire
  supported system replacement scope/completion into Python major-item evidence.
  Correct the documented endpoint and nested response mapping. Distinguish no
  records from permission errors or unavailable data; never infer system age
  from property age or an absent permit. App acceptance: real permit records,
  provenance, and resulting included/skipped major items are inspectable; provider
  failure stays visible. Status: In progress, provider endpoint/error corrections;
  Python system-age mapping still pending; owner approval: pending.
- [ ] V4-N08: Retrieve API flood-zone and available hazard evidence for both
  subject and comps. Preserve source, timestamp, and unknown/error status; do not
  present failed retrieval as no flood risk. Agree on any hazard matching or price
  adjustment policy before applying it to valuation. App acceptance: subject and
  comp evidence is visible and unavailable data is clearly distinguished from a
  known negative result. Status: In progress, unknown/error handling corrections;
  comparable hazard retrieval still pending; owner approval: pending.

### Inspection findings for the next session

- N09/N10 integrated app check: report `job_1788906780962_obnjsk2b`, top-right
  add2 comps yields displayedARV613000/Buy434000. Reload, reset toautomatic,
  re-add and PDF pass; finalrevision4. Unknown IDs422,empty400,stale409,extra
  client money400,badOrigin403,anonymous401; competing requests200/409 with
  exactly1 history record. Python137 tests pass,1 skipped; adapter/signature,
  dashboard hooks/readability tests and workspace typechecks pass. Task remains
  unchecked until owner tests and approves it. Exact evidence/settings preserved.
- Resumed verification2026-09-08: V4-N06 report
  `job_1788905670125_a2ufpf92` shows ARV686000, Buy500000, Wholesale490000.
  Exact values remain685890.5165767155 and499701.46491904394 for ARV/Buy.
  Login/typeahead/new evaluation/reopen pass; PDF downloads25892 bytes;390px
  viewport has390px content width and no page exceptions. PDF content callsites
  tested; full extracted PDF text was not separately compared.
- Verification:128 Python tests pass,1 skipped;13 dashboard targeted tests,
  both workspace typechecks, TS request/response and provider fixture tests pass.
  Independent rounding QA/SOL found no scoped blocker. None is owner acceptance.
- V4-N07 partial delivery: corrected endpoint now returns5 real subject permits
  for4207 W EMPEDRADO ST. Status history, source and raw record are retained in
  provider data. Verified system-age mapping into Python still pending.
- V4-N08 partial delivery: failure/unknown handling fixed and old bad cache entries
  bypassed via versioned keys. This report has flood:null with visible unknown
  warning. Current spatial endpoint has no supporting local official schema;
  valid flood service/entitlement and subject/comp hazard retrieval remain pending.

Historical inspection findings before the above corrections:

- CoreLogic comparable retrieval currently sends only `maxComps`; date, distance,
  and area query parameters are commented out. Changing evaluation tolerances
  alone will not retrieve older evidence. Existing cache keys omit `maxComps`.
- The local official schema documents `/v2/properties/{clip}/building-permits`.
  The current client uses `/v2/properties/{id}/permits` and expects flat records,
  while the documented response uses `items[].permit`, `project`, and contractors.
- Permit entitlement errors currently become successful empty data. Flood lookup
  errors become a successful unknown zone with `isInFloodZone: false`. These
  results can be cached; correct error semantics and invalidate affected caches.
- Comparables currently receive property-detail enrichment, not flood/hazard
  enrichment. The documented climate-risk comprehensive endpoint has no client
  implementation. Python requests currently send no major-item permit evidence.
- No new live provider calls or entitlement verification were performed for this
  inspection. The findings are code/schema observations, not proof of coverage.
- At the previous pause, partial unverified rounding changes existed in Python contracts/math
  and dashboard formatting. Integration and bounded verification are now complete
  as recorded above; owner approval is still pending.

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

Owner clarifications on 2026-09-08 supersede the earlier highest-sale-price,
first-three, all-filters-required selection. Return the closest available
reference and a comparative report even when no candidate matches every rule.

1. Resolve the subject; retrieve and deduplicate the candidate sale evidence.
2. Keep verified positive price, positive area, a real nonfuture sale date,
   sale status and configured transaction eligibility as hard evidence gates.
3. Evaluate every enabled subject-matching rule for every candidate. Unknown
   evidence does not satisfy a rule; preserve every mismatch and unknown field.
4. Rank eligible candidates by subdivision match first, then smallest year-built
   difference, smallest relative square-footage difference, smallest relative
   lot-area difference, then physical-style match. Compare this ordered sequence
   directly rather than inventing numerical weights. Known evidence ranks ahead
   of unknown evidence within each criterion.
5. Select the single highest-ranked reference. Minimum one means a valid sale
   may support a preliminary evaluation despite matching-rule gaps. Do not select
   a fabricated, duplicate, non-sale or uncalculable record to satisfy the minimum.
6. Return rank, comparison details, rule-match percentage, selected/not-selected
   status, mismatches, valuation and limitations in the saved and exported report.

Rule-match percentage is enabled rules satisfied divided by enabled rules
evaluated, multiplied by100. Disabled rules are excluded; unknowns count as unmet.
Zero enabled rules means unscored, not100%. Display100% only when every enabled
rule is satisfied; never round a partial match up to100%. This score measures
configured rule adherence, not probability of valuation accuracy. It does not
override the owner's ordered ranking priorities. Lot area affects ranking;
no unapproved lot-size tolerance is invented for the rule denominator.

Building-style matching remains an enabled assessed rule. Normalize case and
whitespace only; Ranch does not become Conventional. A style mismatch reduces
rule adherence and is disclosed, but no longer prevents best-available selection.
The report must retain preliminary/REVIEW_REQUIRED status for limited evidence
and partial matches. Zero usable sales returns insufficient evidence; never
invent an ARV. Do not call references vision verified or infer renovation
condition from selection alone.

Engineering tie-breaker after all owner priorities: verified sale price
descending, sale date descending, stable provider ID, address, then comp ID.

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
comparable universe. It identifies a
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

## Provider-authoritative local candidate, September 8, 2026

This owner-approved implementation policy supersedes conflicting historical
candidate proposals in this file. It applies to new local V4 reports with
`provider_authoritative_upper_half_v2`. Old signed reports retain their original
inputs, settings, policy and hash. Engineering verification is not owner app approval.

### Repeatable evaluation sequence

1. Select the exact provider address and property ID, including unit, city, state
   and ZIP. Resolve ambiguity before requesting an evaluation.
2. Keep primary-provider property characteristics authoritative. Listing sites
   and vision cannot fill or replace square footage, year built, lot, subdivision,
   style, property type, beds, baths or garage details. Missing data stays unknown.
3. Retrieve the provider comparable pool with documented query parameters.
   The local job combines a provider-default nearby pool of up to 50 sales with
   a 12-month pool of up to 50 sales using configured distance and size bounds.
   Deduplicate by provider ID before enrichment, with at most 100 unique records.
   Prefer the newer valid sale pair on overlapping records; quarantine same-date
   price conflicts and retain both original records. Python applies all physical
   gates to both pools. Cache keys include every search parameter. Record
   requested coverage and returned count; this is not a claim of complete market coverage.
4. Validate completed-sale prices, dates, transaction flags and duplicate IDs.
   Reject invalid evidence. Quarantine the existing extreme PPSF anomaly case
   before dividing the qualified pool by price.
5. For physically relevant candidates, check Zillow, then Redfin, then Realtor.com.
   Stop at usable completed-sale evidence. Match exact identity and corroborate
   price/date against a literal sale-history row or block. Apply a newer sold price
   and date together. Same-date conflicts try the next source; unresolved conflicts
   keep provider evidence with a warning. If all listing sources fail, use provider
   evidence. Ignore asking prices, pending prices and estimates.
6. Capture property photos with source provenance. If photos are absent, request
   a screenshot of the identity-checked property page. A screenshot is not a verified
   front exterior; blocked pages, maps and unrelated images are not condition evidence.
   Preserve accepted bytes in private report storage, with source and capture time.
7. Try these eligibility stages in order, moving on only when zero usable automatic
   ARV references survive: 180 days with year built +/-10; 365 days with +/-10;
   365 days with +/-15. Preserve subdivision, square-footage, distance, property-type
   and known-style gates. Lot differences remain visible without a new lot threshold.
8. At each stage, sort qualified recorded sale prices high to low. Keep the upper
   `ceil(count / 2)` sales and all cutoff-price ties. The lower half cannot enter
   automatic ARV just because its physical rules match.
9. Classify supported sale-relevant renovation imagery as A, visible renovation
   evidence. Otherwise label eligible references B, price-inferred ARV. Clear,
   high-confidence unfinished/distressed evidence tied to that sale excludes the
   comp after the upper-half cutoff. Do not backfill from the lower half in that
   stage. Undated images cannot exclude a comp or establish renovation at sale.
   Current listing adapters do not establish image-to-sale dates, so their image
   observations remain informational and price inference remains available.
10. Use every surviving ARV reference without forcing a target count. One is valid
    but preliminary. Raw weight is `match_fraction * 180 / (180 + sale_age_days)`;
    normalize weights, average adjusted price per square foot, multiply by subject
    square footage and apply subject adjustments. Python uses Decimal arithmetic.
    Preserve exact values; round ARV, buy and wholesale headlines to the nearest
    $1,000. Existing rehab, cost and investor-policy limitations remain explicit.
11. Save the decision trace, attempted stages, source audit, resolved sold values,
    frozen signed request, weights, exact math and report assets. If all stages fail,
    save an `INSUFFICIENT_COMPS` report with `valuation: null`, not a zero-dollar
    estimate. Manual recalculation reuses the frozen snapshot without provider calls.
    It remains an explicit operator override and requires review.

### Bounded operation and known limits

Listing refresh has a 90-second budget and three concurrent properties. Condition
observation has a 45-second budget and three concurrent calls. Report assets have
a 30-second total capture budget, at most 20 images per report and four per property,
with selected comps prioritized. Each image is limited to 5 MB. Source failures
remain visible and do not silently invoke the old evaluator. Calls are recorded.
The owner discarded the 50-evaluations-per-minute target; no live throughput or
production-capacity claim is made by these changes. Production worker coordination,
permit-system-age mapping and comparable hazards remain separate unfinished work.

### Owner app approval checklist

- [ ] V4-P06: approve subject permit records / Permits - NA and whole-number
  valuation display in the app. Verified locally on Magnolia report
  job_1788967256552_z1q9ikuo: nine provider records persisted and rendered,
  no valuation decimals, exact Python math unchanged. NA distinguishes unavailable
  lookup from an empty response; old reports need a new evaluation for details.
- [ ] V4-P05: implement and approve zero-comp fallback to older sales and 1-mile,
  then 1.5-mile coverage. Maximum historical age pending owner choice (24 or
  36 months). Keep physical matching and upper-half ARV rules; stop expansion
  once eligible references exist. Preserve V2 snapshots with a new policy version.
- [ ] V4-P01: approve staged upper-half selection and recent-sale weighting in the app.
- [ ] V4-P02: approve provider characteristic authority and completed-sale refresh audit.
- [ ] V4-P03: approve private photos/screenshots and saved insufficient-evidence reports.
- [ ] V4-P04: approve the five requested address reports and their PDF outputs.

Do not remove these entries after automated tests. Record the owner's response,
date, report ID and revision before marking any entry approved. Earlier N01-N10
approval gates remain open unless the owner explicitly closes them.

## Verification standard

Completion requires exact Decimal fixtures, contract tests, persistence and
recovery tests, isolated batch tests at 1, 5, 10, 20, and 50 properties,
security and tenant isolation tests, browser regression checks, and independent
review of the exact integrated commit. Stubbed throughput is not live capacity
evidence. A bounded real-provider run must separately prove one supported
stored evaluation and one correctly incomplete evaluation before production
cutover can be considered.
