"""Deal math with exact values and configured display rounding."""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

from ..contracts.deal import DealResultV4
from ..contracts.settings import DealSettingsV4


def round_display(value: Decimal, increment: Decimal, mode: str) -> Decimal:
    if increment not in (Decimal(500), Decimal(1000)):
        raise ValueError("rounding increment must be 500 or 1000")
    if mode != "half_up":
        raise ValueError("only half_up rounding is supported")
    units = (value / increment).to_integral_value(rounding=ROUND_HALF_UP)
    return units * increment


def evaluate_deal(
    final_arv: Decimal,
    total_rehab: Decimal,
    deal: DealSettingsV4,
    flip_profit: Decimal,
    preliminary: bool = False,
    limitations: list[str] | None = None,
) -> DealResultV4:
    closing = final_arv * (deal.closing_cost_percent / Decimal(100))
    carrying = final_arv * (deal.carrying_cost_percent / Decimal(100))
    investor_ceiling = final_arv - total_rehab - closing - carrying - flip_profit
    seller_ceiling = investor_ceiling - deal.wholesale_fee
    displayed = round_display(seller_ceiling, deal.rounding_increment, deal.rounding_mode)
    displayed_buy = round_display(investor_ceiling, deal.rounding_increment, deal.rounding_mode)
    return DealResultV4(
        status="PRELIMINARY" if preliminary else "COMPLETED",
        closing_costs=closing,
        carrying_costs=carrying,
        flip_profit=flip_profit,
        investor_purchase_ceiling_exact=investor_ceiling,
        displayed_buy_price=displayed_buy,
        buy_price_rounding_difference=displayed_buy - investor_ceiling,
        seller_contract_ceiling_exact=seller_ceiling,
        wholesale_fee=deal.wholesale_fee,
        displayed_mao=displayed,
        display_rounding_difference=displayed - seller_ceiling,
        initial_offer_value=None,
        initial_offer_status="INCOMPLETE",
        initial_offer_reason="no Initial Offer rule mapped; field incomplete by policy",
        preliminary=preliminary,
        limitations=list(limitations or []),
    )


__all__ = ["evaluate_deal", "round_display"]
