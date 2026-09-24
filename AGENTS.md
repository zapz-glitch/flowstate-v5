# AGENTS.md

## Test-based implementation workflow

1. **Summary** — state what is being built and why, in plain language.
2. **Plan** — the approach and the changes it touches.
3. **Define success first** — before any code changes, write down what a
   successful result is and get agreement on it. This is the contract the
   implementation must satisfy — not a guess after the fact.
4. **Test implementation** — build the E2E assertions/artifact that encode
   the agreed definition of success.
5. **Code changes** — implement against the test.
6. **E2E verify** — run the end-to-end test and produce the artifact;
   green means the agreed definition of success is met.

## Testing rules

- Never write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
- If you must test a system in isolation, first write down all the ways it could fail, then write the code.
