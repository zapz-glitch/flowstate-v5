# Banding & Decision Verification — Implementation Spec

> Companion to `appraisal_banding_spec.md` (v2, unit-rate + GLA-scaled) and
> `docs/EVAL-AGENT-RULESET.md`. This doc is the build contract for the
> "grade" stage of `produce → verify → grade → preserve → improve`.
>
> Status: SPEC ONLY — no code changes yet.

## 0. Confirmed decisions

| Decision | Locked value | Rationale |
|---|---|---|
| Grade mode | **Fail-open (grade as record)** | Telemetry integrity (retries mask true capability), deterministic harness latency, eval/prod separation. A retry loop belongs to a production guardrail, not the benchmark. |
| GLA elasticity | **β = 0.40** with **band-local** median unit rate `p̄` | Kills smaller-driver inflation (Madison Ave, Bartholf) without under-scaling ARV comps. Per-market knob later, same pattern as `asIsThresholdPercent`. |
| Linear projection | Only inside **±15% GLA** of subject | `P_scaled = p_i · A_sub` where band comps are near-twins. |
| Condition mapping | C1/C2 → `renovated`, C3 → `maintained`, C4 → `dated`, C5/C6 → `distressed` + distress flags | Bridges Fannie UAD vocabulary onto our Clef/verification fields. |

## 1. What the verifier grades

Seven decision checks + the band-geometry check from `appraisal_banding_spec.md` §4. Every check is pure recomputation over the evidence bundle the agent saw — no model in the loop.

| # | Decision | Deterministic check | Data source |
|---|---|---|---|
| 1 | Right neighborhood | Picks' `sameBlockGroup`/`geoFit` vs available pool — fraction of picks in BG/same_pocket; fail if a pick is `distant` while BG-matched candidates went unpicked | comp census stamps, `clefDigest.B.geoFit` |
| 2 | Right pool | Picks ⊆ enabled pool AND zero picks flagged `priceSanity = data_error` or `nominal_sale` | contract + `clefDigest.{A,B}.priceSanity`, `evidenceVerification.transactionCheck` |
| 3 | Correct bands | Agent's stated as_is/median/arv band edges vs deterministic evidence edges — the spec's Check 8 (below) | §4 of banding spec |
| 4 | Right ARV evidence | Every driver pick carries ARV evidence (`arvEvidence` non-null, or vision `renovated`/`maintained`); no `as_is`-classified comp in drivers | `arvEvidence()`, `curbAppeal`, classifications |
| 5 | Right rejections | Deterministically-flagged outliers ($0/sf, nominal, IQR-trimmed, `data_error`) absent from picks; no false-positive rejection of a verified anchor that was pickable | verification flags, IQR trim set |
| 6 | Missing-evidence handling | Un-priceable comps (no sqft or no salePrice) never selected; gaps surfaced in `flags`, not papered over | pick list + `flags` field |
| 7 | Final value | `arv` within 0.75–1.25× pick prices (existing contract) AND inside `[E_low·0.9, E_high·1.1]` of the ARV evidence band | contract + §3 edges |
| 8 | Band geometry | Per band: `ε_edge = |A_edge − E_edge| / E_edge ≤ 0.10` for both edges AND `IoU ≥ 0.70`, computed on **subject-scaled** edges | §3–4 of banding spec |

## 2. Deterministic band module

New pure function (home: `packages/shared/src/appraisal/banding.ts` so dashboard + API share it):

```
computeEvidenceBands(comps, subject, opts) →
  { as_is: Band|null, median: Band|null, arv: Band|null, meta }
Band = { low, high, mid, n, trimmedIds, method: 'scaled' | 'linear' | 'disregard' }
```

Pipeline per band:

1. **Classify** each enabled comp into a band using the C-mapping + §2 disqualifiers:
   - `distressed` or distress flags (code violations, nominal sale, distress transaction) → **as_is**
   - `dated` → as_is or median edge member (C4 → median band lower half)
   - `maintained` → **median**
   - `renovated` (vision ≥ conf floor, or verified flip resale) → **ARV**
   - `transitional` (no condition read) → excluded from band membership but kept in trimming pool? — see open question §6.1.
2. **Trim** on unit rate `p_i = P_adj / A_i` with the 1.5×IQR rule (spec §3.1).
3. **Scale** each survivor to subject GLA:
   - `|A_i − A_sub| / A_sub ≤ 0.15` → `P_scaled = p_i · A_sub` (linear)
   - otherwise → `P_scaled = P_adj + β · p̄_B · (A_sub − A_i)`, `p̄_B` = that band's median unit rate, `β = 0.40`
4. **Edges**: `E_low = min`, `E_high = max`, `E_mid = median` of `P_scaled`.
5. **Disregard ladder** (spec §6): `N < 2` → `INSUFFICIENT_DATA`; `CV > 0.25` → flag; all comps > 180d → skip ARV band; bimodal clusters > 20% apart → split sub-tiers. A `disregard` band skips its edge checks — the verdict grades on `A_mid` vs the cost-adjusted grid only.

## 3. Agent contract change

The `AgentSelection` schema gains a required structured bands object:

```jsonc
"bands": {
  "as_is":  { "low": 110000, "high": 145000, "mid": 130000, "compIds": ["..."] },
  "median": { "low": 160000, "high": 195000, "mid": 178000, "compIds": ["..."] },
  "arv":    { "low": 240000, "high": 285000, "mid": 265000, "compIds": ["..."] }
}
```

Rules on the agent side (ruleset §5, verbatim into EVAL-AGENT-RULESET):
- Every selected comp assigned to exactly one band (`compIds` per band).
- Self-check before submit: `A_low ≤ A_mid ≤ A_high` per band.
- Missing band → that band graded `INSUFFICIENT_DATA`, not an error — scarce pockets legitimately lack an ARV band (Red Cloud had zero verified-renovated comps).

## 4. Where the grade runs

`gradeVerdict(evidence, selection)` — a pure function called inside the DO **after** the selection is accepted and the result is built:

- Reads the **frozen evidence bundle** (`ctx` → `buildHarnessEvidence`) — the exact inputs the agent saw, so grading is reproducible.
- Emits `VerdictGrade` and persists it on the eval record (see §5). Never blocks, never retries — fail-open by contract.
- Deterministic-fallback verdicts get graded the same way — the grade applies to whoever posted the selection.

```jsonc
VerdictGrade = {
  checks: { d1: 'pass'|'fail'|'warn', ..., d8: 'pass'|'fail'|'warn'|'skipped' },
  bandGrades: {
    as_is:  { ε_low, ε_high, iou, verdict, method },
    median: {...},
    arv:    {...}
  },
  score: number,          // 0–1 weighted pass fraction
  failures: string[],     // machine-readable failure classes for 'improve'
  gradedAt: ISO8601
}
```

## 5. preserve + improve loop

- `VerdictGrade` persists beside the verdict on the run record (analysis_runs / saved_reports row — the DO already owns that write path).
- **Golden set** = addresses with human-verified ground truth (seed: the A/B series — Littlejohn, Marsh Lake, Oakman, Red Cloud, Madison ×2, Bartholf). Re-running the pipeline on a ruleset/code change re-grades decisions → regression diff on `checks` + `score`, not just ARV distance.
- Failure classes (`failures[]`) are the improve input: recurring `d4` failures mean ruleset language is weak on ARV-evidence; recurring `d3` IoU misses mean band mapping needs tuning, not the agent.

## 6. Open questions for review

1. **Transitional comps** — comps with no condition read (no listing found, Luna/Clef absent). Include them in bands as unclassified members (risk: an unknown-condition comp silently fills the ARV band) or exclude from band membership entirely (risk: thin pockets produce INSUFFICIENT_DATA when data exists)? Recommendation: exclude from ARV band (evidence must prove renovated), allow into as_is/median bands.
2. **β per-band or global** — spec locks band-local `p̄` but β itself stays global 0.40; making β band-local too (ARV comps in renovated pockets may justify 0.50) is a calibration knob for the golden set, not launch.
3. **Disregard grading weight** — on `INSUFFICIENT_DATA` bands the spec grades `A_mid` only. Weight in the composite score: suggest a `disregard` band scores `skipped`, not `pass` — a thin market shouldn't inflate the grade.

## 7. Build order (when approved)

1. `packages/shared/src/appraisal/banding.ts` — band classify + IQR + scale + edges + DISREGARD ladder (pure, unit-testable against evidence JSONs already on disk).
2. `gradeVerdict()` in the evaluation service — checks 1–8, emits `VerdictGrade`.
3. Persist `VerdictGrade` on the run record + include in harness evidence payload.
4. Selection-schema change (`bands` object) + ruleset §5 language.
5. Golden-set harness script — re-run recorded evidence bundles through `gradeVerdict`, diff scores across changes.
