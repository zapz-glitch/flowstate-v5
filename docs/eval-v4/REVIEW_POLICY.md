# V4 Review Policy

## Flow

```text
worker completes lane task
-> orchestrator receives the required handoff
-> orchestrator invokes sol-reviewer for pre-QA review
-> READY_FOR_QA: package QA tests the pinned package revision
-> orchestrator invokes sol-reviewer for post-QA review
-> VERIFIED: orchestrator may integrate the package
-> CHANGES_REQUIRED: return evidence to the owning worker
```

Package verification authorizes integration only. After every accepted package
is integrated, V4-301 tests the exact integrated candidate commit. SOL then
performs final verification on that same unchanged commit. Any repair creates a
new commit and invalidates affected integrated approval.

## Escalation

After two failed repair rounds, or for an unresolved architectural,
security-sensitive, or ambiguous problem, the orchestrator escalates to Astra
through `astra-reviewer`. Astra provides an independent root-cause opinion and
bounded repair direction. The owning worker implements the repair, then the
normal SOL review and QA path resumes.

## Reviewer checklist

1. Engine behavior traces to `docs/EVALUATION_V4.md` and versioned rule IDs.
2. Every response carries complete comparable decisions and adjustment ledgers.
3. No LLM or Firecrawl calls exist in the normal V4 valuation path.
4. Decimal financial fixtures pass exactly without weakened assertions.
5. The worker stayed inside its assigned lane.
6. No unapproved visual or workflow change was introduced.
7. Migrations are isolated from legacy and production stores.
8. QA evidence references the exact candidate commit.
