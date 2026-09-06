"""Intrinsic evidence validation, transitive dedupe, and sort order.

Dedupe unions explicit ``duplicate_of`` links, shared transaction refs,
provider-qualified property IDs, and nonempty normalized addresses. Denial
is structural: an intrinsically invalid record (missing/non-positive
price, ``is_sale=False``, bad self/missing duplicate link) never survives
as a separate valid transaction. Within each class the eligible
representative wins; a same-transaction conflict where explicit links
disagree is recorded.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from ..contracts.comps import CompCandidateV4
from ..contracts.deal import RuleOutcomeV4
from ..contracts.filters import TransactionRuleV4
from .evidence import norm_lower, norm_text, parse_iso_date


class ValidatedComp:
    __slots__ = ("comp", "reasons", "duplicate_of", "survivor", "tx_outcome")

    def __init__(self, comp: CompCandidateV4) -> None:
        self.comp = comp
        self.reasons: list[str] = []
        self.duplicate_of = norm_text(comp.duplicate_of)
        self.survivor = True
        self.tx_outcome: RuleOutcomeV4 | None = None


def _norm_code(value: str) -> str:
    return norm_lower(value).replace("-", "_").replace(" ", "_")


def _norm_code_list(values: list[str]) -> set[str]:
    return {_norm_code(v) for v in values if norm_text(v)}


def check_transaction_rule(comp: CompCandidateV4, rule: TransactionRuleV4 | None) -> RuleOutcomeV4 | None:
    if rule is None:
        return None
    if not rule.enabled:
        return RuleOutcomeV4(rule_id=rule.rule_id, kind="transaction", passed=True, reason="disabled")
    code = _norm_code(comp.transaction_code)
    tx_type = _norm_code(comp.transaction_type)
    if rule.require_sale_flag and comp.is_sale is not True:
        return RuleOutcomeV4(rule_id=rule.rule_id, kind="transaction", passed=False, reason="sale flag required (is_sale=true)")
    if code and code in _norm_code_list(rule.denied_codes):
        return RuleOutcomeV4(rule_id=rule.rule_id, kind="transaction", passed=False, reason=f"transaction code denied by {rule.rule_id}: {comp.transaction_code}")
    if tx_type and tx_type in _norm_code_list(rule.denied_types):
        return RuleOutcomeV4(rule_id=rule.rule_id, kind="transaction", passed=False, reason=f"transaction type denied by {rule.rule_id}: {comp.transaction_type}")
    if rule.allowed_codes and code and code not in _norm_code_list(rule.allowed_codes):
        return RuleOutcomeV4(rule_id=rule.rule_id, kind="transaction", passed=False, reason=f"transaction code not allowed by {rule.rule_id}: {comp.transaction_code}")
    if rule.allowed_types and tx_type and tx_type not in _norm_code_list(rule.allowed_types):
        return RuleOutcomeV4(rule_id=rule.rule_id, kind="transaction", passed=False, reason=f"transaction type not allowed by {rule.rule_id}: {comp.transaction_type}")
    if rule.require_known_code and code and code not in _norm_code_list(rule.allowed_codes):
        return RuleOutcomeV4(rule_id=rule.rule_id, kind="transaction", passed=False, reason=f"{rule.rule_id}: unknown transaction code {comp.transaction_code!r}", limitation="unknown transaction evidence")
    if rule.require_known_type and tx_type and tx_type not in _norm_code_list(rule.allowed_types):
        return RuleOutcomeV4(rule_id=rule.rule_id, kind="transaction", passed=False, reason=f"{rule.rule_id}: unknown transaction type {comp.transaction_type!r}", limitation="unknown transaction evidence")
    limitations: list[str] = []
    if code and not (rule.allowed_codes or rule.denied_codes) and rule.unknown_code_limitation:
        limitations.append(rule.unknown_code_limitation)
    if tx_type and not (rule.allowed_types or rule.denied_types) and rule.unknown_type_limitation:
        limitations.append(rule.unknown_type_limitation)
    return RuleOutcomeV4(
        rule_id=rule.rule_id, kind="transaction", passed=True,
        reason="transaction evidence accepted",
        limitation="; ".join(limitations),
    )


def _norm_address(value: str) -> str:
    return " ".join(norm_lower(value).split())


def _provider_key(comp: CompCandidateV4) -> str:
    provider = norm_lower(comp.provider_property_id)
    return f"provider:{provider}" if provider else ""


def _address_key(comp: CompCandidateV4) -> str:
    address = _norm_address(comp.address)
    if not address:
        return ""
    provider = norm_lower(comp.provider_property_id)
    if provider:
        return f"provider:{provider}|address:{address}"
    return f"address:{address}"


def _tx_key(comp: CompCandidateV4) -> str:
    ref = norm_lower(comp.evidence_ref)
    if ref:
        return f"evidence:{ref}"
    return ""


def _find(parents: dict[str, str], key: str) -> str:
    while parents[key] != key:
        parents[key] = parents[parents[key]]
        key = parents[key]
    return key


def _union(parents: dict[str, str], left: str, right: str) -> None:
    left_root = _find(parents, left)
    right_root = _find(parents, right)
    if left_root == right_root:
        return
    first, second = sorted([left_root, right_root])
    parents[second] = first


def _survivor_key(item: ValidatedComp) -> tuple:
    price = item.comp.verified_sale_price
    amount = price if isinstance(price, Decimal) else Decimal(0)
    sale = parse_iso_date(item.comp.sale_date)
    sale_rank = sale.toordinal() if isinstance(sale, date) else -1
    return (
        -amount,
        -sale_rank,
        norm_text(item.comp.provider_property_id).lower(),
        norm_text(item.comp.address).lower(),
        norm_text(item.comp.comp_id).lower(),
    )


def _intrinsically_eligible(item: ValidatedComp) -> bool:
    price = item.comp.verified_sale_price
    if price is None or not isinstance(price, Decimal) or price <= 0:
        return False
    if item.comp.is_sale is False:
        return False
    return True


def validate_intrinsic(
    comps: list[CompCandidateV4],
    transaction_rule: TransactionRuleV4 | None = None,
) -> tuple[list[ValidatedComp], list[ValidatedComp]]:
    items = [ValidatedComp(comp) for comp in comps]
    by_id = {norm_text(item.comp.comp_id): item for item in items}
    parents = {norm_text(item.comp.comp_id): norm_text(item.comp.comp_id) for item in items}
    for item in items:
        comp = item.comp
        price = comp.verified_sale_price
        if price is None or not isinstance(price, Decimal) or price <= 0:
            item.reasons.append("missing or non-positive verified sale price")
        if comp.is_sale is False:
            item.reasons.append("non-sale transaction (is_sale=false)")
        outcome = check_transaction_rule(comp, transaction_rule)
        item.tx_outcome = outcome
        if outcome is not None and not outcome.passed:
            item.reasons.append(outcome.reason)
        if isinstance(comp.sqft, Decimal) and comp.sqft <= 0:
            item.reasons.append("non-positive comp sqft")
        target = norm_text(comp.duplicate_of)
        if target:
            if target == norm_text(comp.comp_id):
                item.reasons.append("invalid duplicate_of self link")
            elif target not in by_id:
                item.reasons.append(f"invalid duplicate_of missing target {comp.duplicate_of}")
            else:
                _union(parents, norm_text(comp.comp_id), target)
    for key_name, key_fn in (("tx", _tx_key), ("provider", _provider_key), ("address", _address_key)):
        _ = key_name
        seen: dict[str, str] = {}
        for item in sorted(items, key=lambda i: norm_text(i.comp.comp_id).lower()):
            key = key_fn(item.comp)
            if not key:
                continue
            prior = seen.get(key)
            if prior is None:
                seen[key] = norm_text(item.comp.comp_id)
            else:
                _union(parents, prior, norm_text(item.comp.comp_id))
    groups: dict[str, list[ValidatedComp]] = {}
    for item in items:
        root = _find(parents, norm_text(item.comp.comp_id))
        groups.setdefault(root, []).append(item)
    for root, members in groups.items():
        _ = root
        if len(members) == 1:
            continue
        tx_refs = {_tx_key(m.comp) for m in members if _tx_key(m.comp)}
        if len(tx_refs) > 1:
            explicit = [m for m in members if norm_text(m.comp.duplicate_of)]
            if explicit:
                for member in members:
                    member.reasons.append(
                        f"same-transaction conflict: {len(tx_refs)} distinct evidence refs with explicit duplicate links"
                    )
                    member.survivor = False
                continue
        eligible = [m for m in members if _intrinsically_eligible(m) and not m.reasons]
        pool = eligible or [m for m in members if _intrinsically_eligible(m)] or members
        ordered = sorted(pool, key=_survivor_key)
        survivor = ordered[0]
        for loser in members:
            if loser is survivor:
                continue
            loser.survivor = False
            loser.duplicate_of = loser.duplicate_of or survivor.comp.comp_id
            loser.reasons.append(f"duplicate evidence of {survivor.comp.comp_id}")
    valid = [i for i in items if not i.reasons and i.survivor]
    invalid = [i for i in items if i.reasons or not i.survivor]
    for item in invalid:
        item.survivor = False
        if not item.reasons:
            item.reasons.append(f"duplicate evidence of {item.duplicate_of or 'prior record'}")
    return valid, invalid


def sort_key(comp: CompCandidateV4) -> tuple:
    price = comp.verified_sale_price
    amount = price if isinstance(price, Decimal) else Decimal(0)
    sale = parse_iso_date(comp.sale_date)
    sale_rank = sale.toordinal() if isinstance(sale, date) else -1
    return (
        -amount,
        -sale_rank,
        norm_text(comp.provider_property_id).lower(),
        norm_text(comp.address).lower(),
        norm_text(comp.comp_id).lower(),
    )


def sort_for_arv(valid: list[ValidatedComp]) -> list[ValidatedComp]:
    return sorted(valid, key=lambda item: sort_key(item.comp))


__all__ = ["ValidatedComp", "check_transaction_rule", "sort_for_arv", "sort_key", "validate_intrinsic"]
