# Spec — Realtor notes in Give Offer + renovation classification

Handoff spec for the Cloud Agent implementing this feature. Verified
against live data 2026-09-28 — endpoints and shapes below are confirmed.

## Goal

Surface the conversational-AI realtor notes (property condition, known
problems) on the Give Offer property view, and feed them into the
renovation model: additions are automatic, removals are advisory-only.

## Data source — verified

Close CRM **Note activities** on the lead:

```
GET https://api.close.com/api/v1/activity/note/?lead_id=<leadId>
Auth: basic auth, CLOSE_API_KEY as username
```

Response: `data[]` of note objects; `note` field carries the body.
Notes are tagged — look for `FLOWSTATE CONVERSATION LOG` and the
`[flowstate-conversation-log:v1]` marker. Example content observed on
`lead_G6OC4UJ9LRS0KuI8NuSj7nYRczvRtwavUi2LXoR1Gl6` (104 Moselle Ln):

```
FLOWSTATE CONVERSATION LOG
[flowstate-conversation-log:v1]
 -2026-09-25 underwriting complete (eval job_…); ARV 600,000; MAO 363,950;
 wholesale 348,950; rehab 128,050; rec: hold; condition: NA;
 flags: Major Permits (>$50K); confidence medium; stage -> PRESENTING OFFER
 -2026-09-25 price already lowered to account for renovation
```

The conversational notes carry: `condition`, `flags`, rehab-relevant
facts ("price already lowered to account for renovation"), and free-text
problem descriptions. Parse loosely — the format is note-style, not
strict schema; treat lines after the marker as entries.

## Join keys (no address matching needed)

- Queue item → `PipelineItem.leadId`
- Saved report → `full_response_json.leadId` (also `opportunityId`)

## What to build

1. **API service** — `apps/api/src/services/close/` (new):
   `listLeadNotes(leadId, env)` → `{ text, createdAt }[]` sorted desc,
   filtered to the conversation-log marker (also return untagged notes
   flagged differently if useful). Timeout ~5s, failure → `[]` —
   advisory only, never blocks a pipeline stage.
   Env: `CLOSE_API_KEY` exists in `apps/api/.dev.vars`; verify it is a
   prod wrangler secret (`npx wrangler secret list`) — add if missing.

2. **API route** — e.g. `GET /internal/leads/:leadId/notes` under the
   existing dashboard-internal auth (`X-Dashboard-User-Id` +
   `X-Dashboard-Secret`, see `middleware/auth.ts` + `internalFetch`).

3. **Dashboard** — server action + a "Realtor notes" card on the
   give-offer item view (`give-offer/[jobId]` passes through
   `reports/[jobId]` — add the card where the evaluation renders;
   `current.leadId` is available there). Live fetch per item — do NOT
   bake into saved_reports for display (notes added post-eval must show).
   Match existing card styling (see `SubjectGridCard`/`MarketContextCard`).

4. **Renovation integration** — eval-time (or Refresh): run the parsed
   notes through a classifier producing:
   - `rehabAdditions[]` — `{ item, estimatedCost, evidence: quote }` —
     **additive only** into the rehab model (`rehabLevelEstimates` /
     `majorItemCosts` path).
   - `rehabAdvisories[]` — e.g. "notes say roof replaced 2023 — consider
     removing roof line" — surfaced as UI callouts, **never auto-applied**.
   Persist both into `full_response_json` (e.g. `analysis.sellerNotes`
   / `analysis.rehabAdvisories`) so the record is complete and reruns
   refresh it.

## Hard rules from the product owner

- Additions to renovation cost: automatic.
- Removals: advisory callout ONLY — never applied without a human.
- Notes card lives in Give Offer; reports may share it if trivial.

## Interface contract — build against these shapes

Work is split so neither side guesses: **cloud agent owns `apps/api`
(the data layer); the local session owns `apps/dashboard` (the
presentation layer).** Land exactly these shapes.

### Notes route

```
GET /internal/leads/:leadId/notes
→ 200 { "success": true, "data": { "leadId": string, "notes": LeadNote[] } }
→ 4xx/5xx { "success": false, "error": string }
```

```ts
interface LeadNote {
  id: string
  createdAt: string   // ISO
  /** Plain text, HTML stripped */
  text: string
  /** Carries the FLOWSTATE CONVERSATION LOG / [flowstate-conversation-log:v1] marker */
  tagged: boolean
}
```

### Eval-time capture (into `full_response_json` / `analysis`)

```ts
analysis.sellerNotes?: {
  fetchedAt: string
  notes: LeadNote[]
}
analysis.rehabAdditions?: Array<{
  item: string            // rehab line item name
  estimatedCost: number
  evidence: string        // the note quote it came from
}>
analysis.rehabAdvisories?: Array<{
  target: string          // the rehab line it questions
  note: string            // human-readable advisory
  evidence: string        // the note quote
}>
```

`rehabAdditions` merge additively only; `rehabAdvisories` are display
callouts — never applied without a human.

## Verification

- Close note fetch verified live for Moselle's leadId (3+ notes,
  marker present).
- `tsc --noEmit` both apps; eslint clean.
- Follow the repo workflow: feature branch → PR to main on
  `zapz-glitch/flowstate-v5` — do not push to main.
