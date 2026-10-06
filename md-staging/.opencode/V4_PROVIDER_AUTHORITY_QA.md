# V4 provider-authority verification

Candidate branch: v4-python. Main baseline remains
16f879adcd6b93a7daad815ea6efdde56c874b91. No production deployment or provider-key
rotation. This record describes local engineering verification, not owner approval.

## Policy and evidence

The active sequence is documented in docs/EVALUATION_V4.md under
Provider-authoritative local candidate. New snapshots use
provider_authoritative_upper_half_v2. Old snapshots retain their policy and hash.
Property characteristics remain primary-provider values. Listing evidence can
change only a corroborated completed-sale price/date pair and supply images.
Asking prices are ignored. Undated image observations do not promote or exclude ARV.

Condition review consumes the exact persisted R2 bytes, with a 10 MB image-input
budget. Report assets are private, job-bound and ownership-checked. The browser
uses a same-origin authenticated proxy. PDF embeds stored JPEG/PNG bytes; unsupported
or unavailable images produce an export warning. Missing imagery preserves math.

## Automated verification

- 176 focused Python core, contract, staged-selection and local bridge tests passed.
- Six Python API adapter/replay/cache suites passed, including stored-byte vision inputs.
- Listing-chain and Zillow suites passed: fallback order, identity, literal sale evidence,
  conflict retention, main-listing photo boundaries, regional state/suffix normalization.
- Condition parser, report-asset ownership/limits, provider evidence and rate-limit tests passed.
- API and dashboard TypeScript checks passed. Four dashboard regression files passed.
- Diff whitespace check passed. Independent math/selection/replay review found no blocker.
- Synthetic AZ/TX/OH/NC fixtures exercise the same rules. They are not live national appraisals.
- Exact subject identity tests pass for street/unit/locality, selected provider ID,
  Connecticut and multiword states. V4 checks identity before evaluation.
- Magnolia's later HTTP 422 was a 133-character evidence reference exceeding the
  128-character contract limit, not a rule-selection failure. Compact references
  preserve full URLs in the audit. Long-URL contract regression and 11 bridge tests pass.

## Live evidence and repairs

Artifacts are ignored under .data/local-candidate/authority-v2-*. Saved reports
retain their exact tested revision. Later tests do not rewrite historical reports.

- Heritage: stage 2, one same-subdivision reference, $374,000 ARV and $247,000 buy.
  Browser, independent weighted math, saved report, PDF and 390px layout passed.
- Piedmont: stage 1, both $275,000 cutoff-tied references, $317,000 ARV and $198,000 buy.
  Browser, independent weighted math, saved report, PDF and 390px layout passed.
- Repaired Magnolia: job_1788965434884_pk69jof6, stage 1 selects 16142 Magnolia
  Hill St at $380,000. Exact ARV 383694.9055523755, displayed $384,000, buy $246,000.
  Independent math, saved report, PDF (515,723 bytes), mobile and sampled private
  asset access passed. The 72-record combined pool restores the recent reference.
  Subject listing refresh reports $50,300 sold May 21, 2026. The factor-of-three
  change warning remains: verify transaction scope, do not equate it with market value.
- Initial Magnolia run: stage 2, Sand Pine selected. Three live paired queries found
  16142 Magnolia absent from both expanded queries, with and without size bounds,
  but present in the default nearby pool. Exact upstream cause is unproven. Fixed
  coverage by combining nearby and expanded pools, at most 50 each, then deduplicating
  and preserving original variants. The actual probe union has 72 records and restores
  the known recent reference. Same-date price conflicts are quarantined.
- North Lake Orlando: no qualified reference across three stages. Saved valuation:null
  report reopened; explicit insufficient-evidence explanation and PDF download passed.
- Sparling: live Zillow subject refresh and Redfin comparable fallback confirmed.
  Five assets persisted. Owner image access 200, anonymous 401, decoded card image
  and PDF with two embedded images passed. Final five-address rerun remains active.

The first three runs used provider-only evidence because Workerd rejected
redirect:error before listing network requests. Corrected both adapters to
redirect:manual with status checks. Autocomplete now returns a provider error
instead of a misleading empty result, with a visible retry message. Later Sparling
confirmed actual listing calls. No key change was needed.

Saved-report ownership must exist before private images render. Evaluation completion
now follows DB persistence in both durable-object paths; save failures are explicit.

## Antislop during-work gate

Scope: preserve existing Flowstate report/card design and wire real saved images;
no theme, palette, navigation or layout redesign. ENERGY 1 / RHYTHM 1 / MOTION 1
retains the existing data-first report. Images provide source evidence, not decoration.

- R-02 PASS: new explanatory copy uses sentences, not em-dash decoration.
- R-17/R-18/R-36/R-38 PASS: no invented property facts, testimonials, accuracy or capacity claims.
- R-23 PASS: only user-requested real property images; missing evidence stays missing.
- R-24/R-26 PASS: no new navigation or dead controls; asset route and PDF export are implemented.
- R-27 PASS: unavailable lookup and insufficient valuation are explicit; image failures do not fabricate evidence.
- R-33 PASS: all source edits use direct patches; no generated UI rewrite scripts.
- R-35 PASS for tested addresses: application, saved report, PDF and mobile checks ran.
- R-03/R-25/R-32/R-34: existing style/focus/theme unchanged; tested report widths do not overflow.
- Purpose/identity gates: existing styles retained to preserve the appraisal workflow; no decorative techniques added.
- Code-comment gate PASS: new comments describe source authority, image ownership or evidence limitations.

## Remaining approval and limitations

Final V2 report IDs: Heritage job_1788964833459_rinzyhwi; Piedmont
job_1788964889443_f7674o43; Magnolia job_1788965434884_pk69jof6; Northlake
job_1788965532465_ay4jwomw; Sparling job_1788965609394_u5v218y7.
Stored image totals are respectively 5, 2, 7, 4 and 5; authorization checks sampled
up to three per report. Northlake's insufficient-evidence PDF embeds one subject
image; Sparling's PDF embeds two images. Final Magnolia and Sparling reused cached
listing evidence. All five local report checks passed, not owner approval.

The owner subsequently requested older-sale and 1-mile/1.5-mile fallbacks when
no eligible comps remain. These results are the pre-expansion baseline. The maximum
sale age is pending owner choice; no new expansion is claimed implemented yet.

Owner must test and explicitly approve V4-P01 through P04 and existing N tasks
before their MD checkboxes close. No performance target of 50 evaluations/minute
is claimed. Full production Python orchestration, permit-to-system-age mapping,
comparable hazards and live national coverage remain unverified or unfinished.
