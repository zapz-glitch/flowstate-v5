"""Intrinsic evidence validation, deduplication, and sort order."""

from __future__ import annotations

from decimal import Decimal

from ..contracts.comps import CompCandidateV4
from .evidence import norm_lower, norm_text, parse_iso_date


class ValidatedComp:
    __slots__ = ("comp", "reasons", "duplicate_of")

    def __init__(self, comp: CompCandidateV4) -> None:
        self.comp = comp
        self.reasons: list[str] = []
        self.duplicate_of = norm_text(comp.duplicate_of)


def _is_non_sale(comp: CompCandidateV4) -> str | None:
    if comp.is_sale is False:
        return "non-sale transaction"
    tx_type = norm_lower(comp.transaction_type)
    if tx_type and tx_type not in {"sale", "sold", "arms_length_sale", "arm's_length_sale"}:
        if any(
            token in tx_type
            for token in ("list", "loan", "assess", "avm", "refin", "transfer_nominal")
        ):
            return f"non-sale transaction type: {comp.transaction_type}"
    return None


def validate_intrinsic(comps: list[CompCandidateV4]) -> tuple[list[ValidatedComp], list[ValidatedComp]]:
    valid: list[ValidatedComp] = []
    invalid: list[ValidatedComp] = []
    seen_tx: dict[str, ValidatedComp] = {}
    for comp in comps:
        item = ValidatedComp(comp)
        non_sale = _is_non_sale(comp)
        if non_sale:
            item.reasons.append(non_sale)
        price = comp.verified_sale_price
        if price is None or not isinstance(price, Decimal) or price <= 0:
            item.reasons.append("missing or non-positive verified sale price")
        tx_key = norm_lower(comp.evidence_ref or comp.comp_id)
        if tx_key:
            prior = seen_tx.get(tx_key)
            if prior is not None:
                item.reasons.append(f"duplicate transaction evidence: {comp.evidence_ref}")
                item.duplicate_of = prior.comp.comp_id
            else:
                seen_tx[tx_key] = item
        if item.reasons:
            invalid.append(item)
        else:
            valid.append(item)
    return valid, invalid


def sort_key(comp: CompCandidateV4) -> tuple:
    price = comp.verified_sale_price
    amount = price if isinstance(price, Decimal) else Decimal(0)
    sale = parse_iso_date(comp.sale_date)
    sale_rank = sale.toordinal() if sale is not None else -1
    return (
        -amount,
        -sale_rank,
        norm_text(comp.provider_property_id).lower(),
        norm_text(comp.address).lower(),
        norm_text(comp.comp_id).lower(),
    )


def sort_for_arv(valid: list[ValidatedComp]) -> list[ValidatedComp]:
    return sorted(valid, key=lambda item: sort_key(item.comp))


__all__ = ["ValidatedComp", "sort_for_arv", "sort_key", "validate_intrinsic"]
