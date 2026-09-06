"""Intrinsic evidence validation, deterministic dedupe, and sort order."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from ..contracts.comps import CompCandidateV4
from ..contracts.filters import TransactionRuleV4
from .evidence import norm_lower, norm_text, parse_iso_date


class ValidatedComp:
    __slots__ = ("comp", "reasons", "duplicate_of", "survivor")

    def __init__(self, comp: CompCandidateV4) -> None:
        self.comp = comp
        self.reasons: list[str] = []
        self.duplicate_of = norm_text(comp.duplicate_of)
        self.survivor = True


def _norm_code(value: str) -> str:
    return norm_lower(value).replace("-", "_").replace(" ", "_")


def check_transaction_rule(comp: CompCandidateV4, rule: TransactionRuleV4 | None) -> str | None:
    if rule is None or not rule.enabled:
        return None
    code = _norm_code(comp.transaction_code)
    tx_type = _norm_code(comp.transaction_type)
    if rule.denied_codes and code and _norm_code_list(rule.denied_codes).__contains__(code):
        return f"transaction code denied by {rule.rule_id}: {comp.transaction_code}"
    if rule.allowed_codes and code and code not in _norm_code_list(rule.allowed_codes):
        return f"transaction code not allowed by {rule.rule_id}: {comp.transaction_code}"
    if rule.denied_types and tx_type and tx_type in _norm_code_list(rule.denied_types):
        return f"transaction type denied by {rule.rule_id}: {comp.transaction_type}"
    if rule.allowed_types and tx_type and tx_type not in _norm_code_list(rule.allowed_types):
        return f"transaction type not allowed by {rule.rule_id}: {comp.transaction_type}"
    if rule.require_sale_flag and comp.is_sale is False:
        return "non-sale transaction (sale flag required)"
    return None


def _norm_code_list(values: list[str]) -> set[str]:
    return {_norm_code(v) for v in values if norm_text(v)}


def _physical_key(comp: CompCandidateV4) -> str:
    provider = norm_lower(comp.provider_property_id)
    address = norm_lower(comp.address)
    if provider:
        return f"provider:{provider}"
    if address:
        return f"address:{address}"
    return ""


def _tx_key(comp: CompCandidateV4) -> str:
    ref = norm_lower(comp.evidence_ref)
    if ref:
        return f"evidence:{ref}"
    return f"comp:{norm_lower(comp.comp_id)}"


def validate_intrinsic(
    comps: list[CompCandidateV4],
    transaction_rule: TransactionRuleV4 | None = None,
) -> tuple[list[ValidatedComp], list[ValidatedComp]]:
    items = [ValidatedComp(comp) for comp in comps]
    for item in items:
        comp = item.comp
        price = comp.verified_sale_price
        if price is None or not isinstance(price, Decimal) or price <= 0:
            item.reasons.append("missing or non-positive verified sale price")
        if comp.is_sale is False:
            item.reasons.append("non-sale transaction (is_sale=false)")
        configured = check_transaction_rule(comp, transaction_rule)
        if configured:
            item.reasons.append(configured)
        if isinstance(comp.sqft, Decimal) and comp.sqft <= 0:
            item.reasons.append("non-positive comp sqft")
    by_tx: dict[str, ValidatedComp] = {}
    for item in sorted(items, key=lambda i: norm_text(i.comp.comp_id).lower()):
        key = _tx_key(item.comp)
        prior = by_tx.get(key)
        if prior is None:
            by_tx[key] = item
            continue
        item.reasons.append(f"duplicate transaction evidence of {prior.comp.comp_id}")
        item.duplicate_of = item.duplicate_of or prior.comp.comp_id
        item.survivor = False
    by_physical: dict[str, ValidatedComp] = {}
    for item in sorted(items, key=lambda i: norm_text(i.comp.comp_id).lower()):
        if not item.survivor:
            continue
        key = _physical_key(item.comp)
        if not key:
            continue
        prior = by_physical.get(key)
        if prior is None:
            by_physical[key] = item
            continue
        if norm_text(item.comp.duplicate_of) == prior.comp.comp_id or norm_text(
            prior.comp.duplicate_of
        ) == item.comp.comp_id:
            item.duplicate_of = item.duplicate_of or prior.comp.comp_id
        else:
            item.reasons.append(f"duplicate property evidence of {prior.comp.comp_id}")
            item.duplicate_of = item.duplicate_of or prior.comp.comp_id
        item.survivor = False
    valid = [i for i in items if not i.reasons and i.survivor]
    invalid = [i for i in items if i.reasons or not i.survivor]
    for item in invalid:
        if not item.reasons:
            item.reasons.append(f"duplicate evidence of {item.duplicate_of or 'prior record'}")
            item.survivor = False
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
