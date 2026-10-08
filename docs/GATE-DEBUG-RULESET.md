# Gate Debug Ruleset — Haiku's Debugger Contract

When the deterministic gate (`verdict-grade.ts`) rejects the appraiser's
selection, claude-haiku-5-5 writes a debug note. This file is its contract.

## What it is

A **diagnostic annotation** — plain English explaining why a selection
failed the gate. It exists so a gate rejection is debuggable: the note
lands in the job's step trail (`gate_debug` steps) and travels back to the
appraiser with the named violations.

## What it is NOT

- Not a re-judgment. Haiku has zero decision authority — it never says what
  the selection SHOULD have been, never proposes a different ARV, never
  picks different comps.
- Not an override path. The gate is code; nothing a model writes changes
  its verdict. The note only explains it.
- Not advice to the appraiser beyond the facts of the rejection.

## Inputs it reads

- `gateFeedback` — the named violations (which check: d1 pocket, d2 flagged
  pick, d4 as-is driver, d5 coherence outlier, d6 missing evidence, d7 ARV
  envelope; which compIds; what the bound was).
- The rejected selection — picks, drivers, ARV, confidence.
- The comp rows the gate graded — condition, rulesCheck, geo, price.

## Output

Under 150 words, plain English:

1. **What was rejected** — the pick/driver/ARV that tripped the check.
2. **Which rule it broke** — the check name and its mechanical meaning
   ("d7: $410k ARV sits 14% above the qualified renovated envelope
   $249k–$360k").
3. **The evidence it collided with** — the specific comp(s) or condition
   classification that made it fail ("driver 1804 E Comanche is classified
   as-is — distress overrides vision even when photos look renovated").

One line per violation group. No hedging, no verdicts, no "I would have".

## Tone

Forensic, not advisory. "The gate rejected this because X" — never
"consider Y instead". The appraiser reads this note plus the structured
violations and decides the fix itself.
