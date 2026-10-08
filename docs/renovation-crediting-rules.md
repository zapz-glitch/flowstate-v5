# Renovation Scope Evidence Hierarchy & Crediting Ruleset

## Executive Summary
This spec defines the deterministic evidence hierarchy for crediting or penalizing property condition claims (MLS remarks, seller disclosures, permit logs) during automated renovation scope and CapEx generation. It prevents both **CapEx under-budgeting** (caused by relying on unverified listing puffery) and **CapEx over-budgeting** (caused by ignoring credible dated metadata).

---

## 1. The 4-Tier Evidence Hierarchy

| Tier | Source Type | Crediting Level | CapEx Scope Impact | Harness Check Rule |
| :--- | :--- | :--- | :--- | :--- |
| **Tier 1** | **Verified Municipal Permit or Inspection Report** | **Full Credit (100%)** | **$0 Replacement Scope** (Full Remaining Useful Life restored). | Agent *must* set CapEx line item to $0 replacement (minor $200–$500 certification/service check permitted). |
| **Tier 2** | **Explicit Dated Claim** *(e.g., "Roof 2019", "HVAC installed 2021")* | **Partial Credit (Soft Repair Tier)** | **Allocates Minor Service/Tune-Up Tier** instead of full replacement. Effective age calculated from claimed year. | Agent *must not* charge full replacement unless photo evidence reveals active failure (e.g., leak/sagging). |
| **Tier 3** | **Undated / Subjective Claim** *(e.g., "Newer roof", "Updated HVAC", "Remodeled bath")* | **Zero Credit (0% Financial Value)** | **Advisory Only.** Scope defaults to physical baseline / UAD condition tier derived from age and photos. | Agent *cannot* reduce CapEx replacement budget without Tier 1 or Tier 2 backing. |
| **Tier 4** | **Seller Disclosures & Defect Notes** *(e.g., "Roof leaks in heavy rain", "AC non-functional")* | **Addition-Only / Mandatory Scope** | **Mandatory Full Replacement or Structural Remediation.** | Agent *must* add full line-item replacement + contingency penalty. |

---

## 2. Mathematical Crediting Mechanics by System

When calculating Remaining Useful Life ($\text{RUL}$) and CapEx allocation ($C_{\text{alloc}}$) for major systems (Roof, HVAC, Plumbing, Water Heater, Electrical Panel):

$$\text{RUL} = \text{Total Design Life} - (\text{Current Year} - \text{Year Built or Upgraded})$$

### Major System Design Life Benchmarks (Appraiser Standard)
* **Architectural Shingle Roof:** 25 Years
* **HVAC / Heat Pump:** 15 Years
* **Water Heater:** 10 Years
* **Electrical Panel / Service:** 30 Years

---

### Matrix: How Claims Modify CapEx Line Items

#### Case A: Architectural Shingle Roof on a 1980 Home (Current Year: 2026)

| Input Claim | Evidence Tier | Assumed Effective Age | Applied RUL | CapEx Decision & Cost |
| :--- | :--- | :--- | :--- | :--- |
| **Permit Closed (2020)** | **Tier 1** | 6 Years | 19 Years | **$0 Replacement.** ($250 roof inspection/cert allowance). |
| **Listing Text: "Roof 2019"** | **Tier 2** | 7 Years | 18 Years | **Soft Repair Tier.** Allocate $750 tune-up/flashing/sealant allowance. Do NOT charge $9,000 full tear-off. |
| **Listing Text: "Newer Roof"** | **Tier 3** | 25+ Years (Default) | 0 Years | **Full Replacement.** Charge $9,000 full tear-off (defaulted by 1980 build age). |
| **Disclosure: "Roof leak in rear"**| **Tier 4** | Defective | 0 Years | **Full Replacement + $1,500 Interior Sheathing/Drywall Repair.** |

#### Case B: HVAC System on a 1995 Home

| Input Claim | Evidence Tier | Assumed Effective Age | Applied RUL | CapEx Decision & Cost |
| :--- | :--- | :--- | :--- | :--- |
| **Permit Closed (2022)** | **Tier 1** | 4 Years | 11 Years | **$0 Replacement.** ($150 AC service check allowance). |
| **Listing Text: "HVAC 2018"** | **Tier 2** | 8 Years | 7 Years | **Soft Repair Tier.** Allocate $450 HVAC tune-up/servicing. RUL > 5 yrs = Skip replacement. |
| **Listing Text: "Updated HVAC"**| **Tier 3** | 31 Years (Default) | 0 Years | **Full Replacement.** Charge $7,500 new split-system heat pump. |

---

## 3. Asymmetry Rules: Positive vs. Negative Claims

1. **Positive Claims Are Permissive (Require Verification):**
   * A claim asserting a system is *good* ("New Roof") **cannot** grant financial credit without a explicit year (Tier 2) or a recorded permit (Tier 1).
2. **Negative Claims Are Definitive (Addition-Only):**
   * A claim asserting a system is *bad* ("AC compressor shot", "Foundation settlement noted") **immediately forces** full replacement/repair scope regardless of whether a permit or photo exists. Seller notes are strictly **Addition-Only**.

---

## 4. Harness Evaluation & Audit Telemetry

The evaluation harness validates agent CapEx estimates against evidence tiers using the following rules:

```python
def validate_capex_credit(item_name: str, agent_cost: float, evidence_tier: int, full_replacement_cost: float) -> str:
    """
    Asserts whether the agent properly credited or penalized a renovation item.
    """
    if evidence_tier == 1: # Permit Verified
        if agent_cost > (full_replacement_cost * 0.10): # Max 10% allowed for inspection
            return "FAIL: Agent charged replacement cost on Tier 1 Permit-Verified item."
        return "PASS: Full Credit Applied."

    elif evidence_tier == 2: # Dated Claim
        soft_repair_max = full_replacement_cost * 0.20 # Max 20% for tune-up
        if agent_cost == full_replacement_cost:
            return "FAIL: Agent over-budgeted; charged full replacement on Tier 2 Dated Claim."
        elif agent_cost == 0:
            return "FAIL: Agent under-budgeted; gave Tier 1 ($0) credit to an unverified Tier 2 claim."
        elif agent_cost <= soft_repair_max:
            return "PASS: Soft Repair Tier Applied."
        else:
            return "WARN: Partial credit outside standard tune-up range."

    elif evidence_tier == 3: # Undated Claim / Fluff
        if agent_cost < full_replacement_cost:
            return "FAIL: Agent granted financial credit to unverified Tier 3 subjective text."
        return "PASS: Zero Credit Applied (Default Replacement Charged)."

    elif evidence_tier == 4: # Defect Disclosure
        if agent_cost < full_replacement_cost:
            return "FAIL: Agent ignored Tier 4 defect disclosure in scope."
        return "PASS: Mandatory Scope Added."

```

---

## 5. Summary Flowchart for Agent Logic

```
[System Claim / Disclosures Evaluated]
                 │
  ┌──────────────┼──────────────┬──────────────┐
  ▼              ▼              ▼              ▼
Tier 1          Tier 2         Tier 3         Tier 4
Permit Closed   Dated Text     Undated Text   Defect Note
  │              │              │              │
  ▼              ▼              ▼              ▼
$0 Replace      Soft Repair    0% Credit      Full Replace
Scope          Scope          (Default Scope) + Penalty Scope

```

```

---

### Summary of What Was Locked In

1. **Permits = $0 Replacement Credit (Tier 1):** Only closed/verified municipal permits or third-party inspection reports grant complete $0 replacement status.
2. **Dated Text Claims = Soft Repair Tier (Tier 2):** Claims like `"Roof 2019"` drop the scope from a full $9,000 replacement down to a $750 tune-up/inspection allowance, preventing over-budgeting without granting unearned $0 credit.
3. **Undated Text Claims = Zero Financial Credit (Tier 3):** Marketing fluff like `"newer roof"` or `"updated kitchen"` is strictly advisory and defaults to the home's physical/age baseline.
4. **Seller Notes = Addition-Only (Tier 4):** Negative disclosures automatically add mandatory replacement/repair line items to the scope.
