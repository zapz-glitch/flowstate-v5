#!/usr/bin/env python3
"""A/B eval harness — Set A (live pipeline ARV) vs Set B (trade-tricks spec).
Reads the API result and re-derives ARV under the appraiser-trade-tricks rules.
NOT committed — calibration tooling only."""
import json, sys, time, urllib.request
from datetime import datetime, timezone

API = 'http://localhost:8787'
KEY = 'fs_35fd82dfcc3849c37a4e42347ee79bf0350503117d46cc8d'

# ATTOM MCP — harness-local land lookups (rescued comps are unenriched, so
# land data comes straight from the provider: tax-history → landValue)
def _dev_vars():
    env = {}
    try:
        for line in open('apps/api/.dev.vars'):
            if '=' in line and not line.strip().startswith('#'):
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip()
    except FileNotFoundError: pass
    return env

_MCP = 'https://mcp.intelligence.attomdata.com'
def mcp_tool(name, args):
    token = _dev_vars().get('ATTOM_MCP_ACCESS_TOKEN')
    if not token: return None
    r = urllib.request.Request(_MCP, method='POST',
        headers={'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
                 'Authorization': f'Bearer {token}'},
        data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                         'params': {'name': name, 'arguments': args}}).encode())
    try:
        text = urllib.request.urlopen(r, timeout=30).read().decode()
        line = [l for l in text.split('\n') if l.startswith('data:')]
        return json.loads((line[-1][5:] if line else text))['result']
    except Exception: return None

def land_value_of(attom_id):
    """Latest assessed landValue for a comp via tax-history."""
    res = mcp_tool('get_property_data', {
        'property': {'lookupMode': 'attomId', 'attomId': str(attom_id)},
        'datasets': ['tax-history']})
    try:
        rows = res['structuredContent']['results'][0]['data']
        return max(rows, key=lambda r: r.get('taxYear', 0)).get('landValue')
    except Exception:
        return None

def req(method, path, body=None):
    r = urllib.request.Request(API + path, method=method,
        headers={'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'},
        data=json.dumps(body).encode() if body else None)
    return json.load(urllib.request.urlopen(r))

def fmt(n): return f"${n:,.0f}" if isinstance(n, (int, float)) else '-'

MARGINAL_FACTOR = 0.5      # trade trick 1 — sqft delta priced at marginal rate
ADJ_CAP_PCT = 0.25         # trade trick 3 — >25% net adj → downweight + flag
OUTLIER_SUPPORT = 2        # trade trick 5 — ARV above pool top needs ≥2 supporters

def tier_of(c):
    t = ((c.get('classification') or {}).get('type') or '').lower()
    if t in ('after_renovation', 'arv', 'renovated'): return 'arv'
    if t in ('as_is', 'investor', 'distressed'): return 'as_is'
    return 'unidentified'

# Clef condition tier — what the comp's condition says its price MEANS:
# renovated → can drive/anchor ARV · dated/maintained → median evidence:
# bounds the range floor, never anchors ARV. Confidence-gated — a weak
# stamp neither upgrades nor downgrades.
COND_MIN_CONF = 30
def cond_tier(c):
    ca = c.get('curbAppeal') or {}
    summary = (ca.get('summary') or '').lower()
    # Clef's tier label is authoritative — tier:median = the pocket's typical
    # level regardless of the condition guess.
    if 'tier:median' in summary: return 'median'
    if 'tier:premium' in summary or 'tier:luxury' in summary: return 'premium'
    cond = (ca.get('condition') or '').lower()
    if (ca.get('confidence') or 0) < COND_MIN_CONF: return 'unknown'
    if cond in ('renovated', 'updated', 'turnkey', 'move-in ready'): return 'renovated'
    if cond in ('dated', 'maintained', 'median', 'as_is', 'as-is', 'distressed', 'needs_work'): return 'median'
    return 'unknown'

def age_days(d):
    if not d: return None
    try: return (datetime.now(timezone.utc) - datetime.fromisoformat(d.replace('Z','+00:00'))).days
    except Exception: return None

def sub_avm(s):
    """Subject AVM — serialized as nested avm.value, avmValue on some paths."""
    return s.get('avmValue') or (s.get('avm') or {}).get('value')

def set_b(subject, items, valuation=None):
    """Recompute ARV under trade-tricks over the same enabled pool as A.
    Conclusion cascade — B never refuses outright:
      T0 verified ARV anchor (enabled comps)
      T1 delta-adjusted comps (rescue comps whose ONLY kill is an adjustable
         delta — lot size — verified same pocket/street; delta flagged, not modeled)
      T2 pocket-implied (pool-derived same-tract median ppsf × subject sqft)
      T3 subject AVM floor  →  T4 assessed  →  T5 report-only
    """
    sub_sqft = subject.get('squareFeet')
    pool = [c for c in items if c['isEnabled'] and c.get('salePrice') and c.get('squareFeet')]
    source = 'T0 anchor'
    flags0 = []

    # T1 — adjustable-delta rescue (lot size). Comps killed ONLY on an
    # adjustable delta get rescued when they verify same pocket: close,
    # same side of barriers, same tract/BG when tract data exists.
    if not pool:
        for c in items:
            reasons = c.get('disableReasons') or []
            if not (len(reasons) == 1 and 'lot size' in reasons[0].lower()): continue
            if not c.get('salePrice') or not c.get('squareFeet'): continue
            if (c.get('distanceMiles') or 99) > 0.5: continue
            if c.get('crossesMajorRoad'): continue
            if (c.get('sameBlockGroup') is False and subject.get('censusTract')
                    and c.get('censusTract') and c.get('censusTract') != subject.get('censusTract')):
                continue
            pool.append(c)
        if pool:
            source = 'T1 land-adjusted (lot-delta flagged, not modeled)'
            flags0.append(f'{len(pool)} comp(s) rescued — only lot-size failed; land delta NOT adjusted')

    # T2 — pocket-implied: same-tract median ppsf × subject sqft
    if not pool:
        tract_ppsfs = sorted(
            (c.get('pricePerSqft') or (c['salePrice']/c['squareFeet']))
            for c in items
            if c.get('salePrice') and c.get('squareFeet')
            and c.get('censusTract') and c.get('censusTract') == subject.get('censusTract'))
        if sub_sqft and len(tract_ppsfs) >= 3:
            med = tract_ppsfs[len(tract_ppsfs)//2]
            return {'arv': med * sub_sqft, 'flags': [f'T2 pocket-implied — {len(tract_ppsfs)} same-tract sales, median ${med:.0f}/sf'],
                    'contribs': [], 'conf': 'low', 'source': 'T2 pocket-implied'}

    # T3 / T4 — AVM floor → assessed
    if not pool:
        if sub_avm(subject):
            return {'arv': sub_avm(subject), 'flags': ['T3 as-is AVM floor — ARV ≥ AVM, uplift unverified'],
                    'contribs': [], 'conf': 'low', 'source': 'T3 AVM floor'}
        if subject.get('assessedValue') or subject.get('assessed'):
            v = subject.get('assessedValue') or subject.get('assessed')
            return {'arv': v, 'flags': ['T4 assessed fallback — county estimate'],
                    'contribs': [], 'conf': 'none', 'source': 'T4 assessed'}
        return {'arv': None, 'flags': ['T5 report-only — no comp evidence, no anchor'], 'contribs': [], 'conf': 'none', 'source': 'T5 report-only'}

    contribs, flags = [], list(flags0)

    # ── Marginal land rate — honest ladder ───────────────────────────────
    # T1 vacant-land sales in the tract (market-context/pool land records)
    #    → median sale $/lot sqft — the market's own marginal land price
    # T2 assessed-land curve fit (≥5 same-tract parcels) → fitted slope
    # T3 per-parcel delta × LAND_FACTOR + cap — conservative default
    # T4 flag-only — no land data at all
    _sub_land = subject.get('landAssessedValue')
    _mkt_ratio = (sub_avm(subject) / subject.get('taxAssessment')
                  if sub_avm(subject) and subject.get('taxAssessment') else 1.4)
    for c in pool:
        if c.get('landAssessedValue') is None and c.get('id'):
            lv = land_value_of(c['id'])
            if lv is not None: c['landAssessedValue'] = lv

    def lot_sf(x):
        return x.get('lotSizeSquareFeet') or ((x.get('lotSizeAcres') or 0) * 43560) or None
    _sl = lot_sf(subject)

    # T1 — vacant land sales in the same tract
    vacant = [
        (c['salePrice'] / lot_sf(c)) for c in items
        if 'land' in (c.get('propertyType') or '').lower()
        and c.get('salePrice') and lot_sf(c)
        and c.get('censusTract') and c.get('censusTract') == subject.get('censusTract')
    ]
    vacant.sort()
    land_rate, land_source = None, None
    if len(vacant) >= 2:
        land_rate = vacant[len(vacant)//2]
        land_source = f'T1 vacant-land median ${land_rate:.2f}/sf ({len(vacant)} sales)'
    else:
        # T2 — assessed-land regression over same-tract parcels
        pts = [(lot_sf(c), c['landAssessedValue'])
               for c in items
               if lot_sf(c) and c.get('landAssessedValue')
               and c.get('censusTract') and c.get('censusTract') == subject.get('censusTract')]
        if _sl and _sub_land: pts.append((_sl, _sub_land))
        if len(pts) >= 5:
            mx = sum(p[0] for p in pts)/len(pts); my = sum(p[1] for p in pts)/len(pts)
            cov = sum((x-mx)*(y-my) for x, y in pts); var = sum((x-mx)**2 for x, y in pts)
            if var > 0:
                land_rate = max(0.0, cov/var)
                land_source = f'T2 assessed-curve slope ${land_rate:.2f}/sf ({len(pts)} parcels)'
    if land_source: flags.append(f'land rate: {land_source}')

    # ── Marginal sqft rate — appraiser ladder ────────────────────────────
    # T1 pool-derived: price~sqft slope across verified same-tract comps
    #    (verification-flagged sales excluded — junk distorts the fit)
    # T2 standard taper on the comp's avg $/sf — 0.50/0.40/0.30 by gap
    #    band, inside the appraiser 25–50% marginal range
    def ppsf_of_c(c): return c.get('pricePerSqft') or c['salePrice']/c['squareFeet']
    _unfit_c = [c for c in pool
                if (c.get('evidenceVerification') or {}).get('staleness') == 'stale'
                or (c.get('evidenceVerification') or {}).get('priceCheck') == 'divergent']
    _fit = [c for c in pool if c not in _unfit_c and c.get('salePrice') and c.get('squareFeet')]
    _fit_tract = [c for c in _fit
                  if c.get('censusTract') and c.get('censusTract') == subject.get('censusTract')]
    sqft_rate, sqft_rate_source = None, None
    for pts_src in (_fit_tract, _fit):
        if len(pts_src) >= 5:
            mx = sum(c['squareFeet'] for c in pts_src)/len(pts_src)
            my = sum(c['salePrice'] for c in pts_src)/len(pts_src)
            cov = sum((c['squareFeet']-mx)*(c['salePrice']-my) for c in pts_src)
            var = sum((c['squareFeet']-mx)**2 for c in pts_src)
            avg_ppsf = sum(ppsf_of_c(c) for c in pts_src)/len(pts_src)
            if var > 0:
                slope = cov/var
                if 0 < slope < avg_ppsf:
                    sqft_rate = slope
                    sqft_rate_source = f'T1 pool slope ${slope:.0f}/sf ({len(pts_src)} comps)'
                    break
    if sqft_rate_source: flags.append(f'size rate: {sqft_rate_source}')

    for c in pool:
        comp_sqft = c['squareFeet']; ppsf = ppsf_of_c(c)
        base = c.get('adjustedPrice') or c['salePrice']
        # 1 — marginal sqft scaling: T1 fitted rate when derivable, else
        # the taper — the marginal foot prices below the average and
        # declines as the size gap grows
        delta = sub_sqft - comp_sqft
        if sqft_rate is not None:
            contrib = base + delta * sqft_rate
        else:
            gap = abs(delta)/comp_sqft
            mf = 0.50 if gap <= 0.10 else 0.40 if gap <= 0.25 else 0.30
            contrib = base + delta * ppsf * mf
        # land premium — marginal-rate method when a rate was derived
        # (T1 market-priced / T2 assessed-scaled); else per-parcel delta
        # at the conservative factor. Always capped at ±20% of sale.
        LAND_CAP_PCT = 0.20
        c_lot = lot_sf(c)
        land_adj = 0.0
        if land_rate is not None and c_lot and _sl:
            land_adj = land_rate * (_sl - c_lot)
            if land_source.startswith('T2'):
                land_adj *= _mkt_ratio  # assessed rate → market
        elif _sub_land and c.get('landAssessedValue'):
            assessed_delta = _sub_land - c['landAssessedValue']
            land_adj = assessed_delta * _mkt_ratio * 0.35
        if abs(land_adj) >= 1000:
            land_adj = max(-LAND_CAP_PCT * c['salePrice'], min(LAND_CAP_PCT * c['salePrice'], land_adj))
            contrib += land_adj
            flags.append(f"{c['address']}: land adj {'+' if land_adj >= 0 else '−'}${abs(land_adj):,.0f} [{land_source or 'T3 per-parcel'}] (cap ±${LAND_CAP_PCT * c['salePrice']:,.0f})")
        # 2 — market-conditions time adj: needs 90d vs 365d ppsf trend; skip when absent
        # 3 — adjustment cap: >25% net adj → halve weight + flag
        adj_pct = abs((c.get('appraisalRules') or {}).get('totalAdjustment') or 0) / c['salePrice']
        capped = adj_pct > ADJ_CAP_PCT
        if capped: flags.append(f"{c['address']}: {adj_pct*100:.0f}% adj > cap — downweighted")
        weight = (1 / (1 + adj_pct)) * (0.5 if capped else 1)   # 6 — least-adj weighting
        contribs.append({'c': c, 'contrib': contrib, 'weight': weight, 'tier': tier_of(c)})

    # Within-tier: ARV-tier evidence drives ARV. As-is/distressed-tier sales
    # are floor evidence only — they NEVER contribute to after-repair value,
    # label or no label: an as-is sale can't say what a renovated house
    # sells for. When no comp carries the ARV label, best-evidence selection
    # drives off the retail-marked comp(s) — the sale price itself is the
    # evidence (ppsf within RETAIL_BAND of the pool top = retail-tier sale).
    RETAIL_BAND = 0.70
    ppsf_of = lambda x: x['c'].get('pricePerSqft') or (x['c']['salePrice'] / x['c']['squareFeet'])
    # Evidence verification (A-side stamps): stale/divergent comps never
    # drive ARV — they're context, not evidence of today's renovated value.
    unfit = [x for x in contribs
             if (x['c'].get('evidenceVerification') or {}).get('staleness') == 'stale'
             or (x['c'].get('evidenceVerification') or {}).get('priceCheck') == 'divergent']
    for x in unfit:
        flags.append(f"{x['c']['address']}: verification — {'; '.join((x['c'].get('evidenceVerification') or {}).get('flags') or [])[:90]}")
    # Similarity scoring — distance + same-pocket (BG/tract/subdivision) +
    # era proximity + size proximity. Used for the driver gate, anchoring,
    # and the median-ceiling bound.
    def similarity(x):
        c = x['c']; s = 0.0
        d = c.get('distanceMiles')
        if d is not None: s += max(0, 1 - d) * 3.0
        if c.get('sameBlockGroup'): s += 3.0
        elif subject.get('censusTract') and c.get('censusTract') == subject.get('censusTract'): s += 2.0
        if c.get('subdivision') and c.get('subdivision') == subject.get('subdivision'): s += 2.0
        yd = abs((c.get('yearBuilt') or 0) - (subject.get('yearBuilt') or 0)) if c.get('yearBuilt') and subject.get('yearBuilt') else None
        if yd is not None: s += 1.5 if yd <= 10 else 0.75 if yd <= 20 else 0.0
        sd = abs((c.get('squareFeet') or 0) - (subject.get('squareFeet') or 0)) if c.get('squareFeet') and subject.get('squareFeet') else None
        if sd is not None: s += 1.5 if sd <= 150 else 0.75 if sd <= 300 else 0.0
        return s

    verified_pool = [x for x in contribs if x not in unfit]
    # Condition-tier discipline — renovated-preferred, median as fallback:
    # non-median comps need a similarity floor to drive (a lone dissimilar
    # comp is weaker than the median set — the Marie St case). No high-sim
    # renovated → median comps become the driver set, flagged.
    MIN_SIM = 3.0
    median_comps = [x for x in verified_pool if cond_tier(x['c']) == 'median']
    preferred = [x for x in verified_pool
                 if x['tier'] == 'arv' and cond_tier(x['c']) != 'median' and similarity(x) >= MIN_SIM]
    if preferred:
        drivers = preferred
    elif median_comps:
        drivers = median_comps
        for x in median_comps:
            flags.append(f"{x['c']['address']}: median-tier driver — no high-similarity renovated evidence")
    elif [x for x in verified_pool if x['tier'] == 'arv' and cond_tier(x['c']) != 'median']:
        # non-median comps exist but all below the similarity floor
        weak = [x for x in verified_pool if x['tier'] == 'arv' and cond_tier(x['c']) != 'median']
        flags.append(f'non-median comps below similarity floor ({MIN_SIM}) — falling to median')
        drivers = median_comps if median_comps else weak
        if not drivers: drivers = weak
    else:
        top_ppsf = max(ppsf_of(x) for x in verified_pool) if verified_pool else None
        retail = [x for x in verified_pool
                  if x['tier'] != 'as_is' and cond_tier(x['c']) != 'median'
                  and top_ppsf and ppsf_of(x) >= RETAIL_BAND * top_ppsf]
        excluded = len(contribs) - len(retail)
        if not retail:
            # Median-only evidence — ARV = median ceiling of the
            # SIMILARITY-GATED set only (a far premium comp stamped
            # 'tier:median' is still dissimilar evidence). Subject AVM
            # corroborates uplift above the ceiling when higher.
            if median_comps:
                _top_sim = max(similarity(x) for x in median_comps)
                gated_median = [x for x in median_comps if similarity(x) >= 0.6 * _top_sim]
                median_ceiling = max(x['contrib'] for x in gated_median)
                avm = sub_avm(subject)
                if avm and avm > median_ceiling:
                    flags.append(f'median-tier evidence only (ceiling {fmt(median_ceiling)}) — ARV set at subject AVM {fmt(avm)} (corroborated uplift)')
                    return {'arv': round(avm), 'flags': flags, 'contribs': contribs, 'conf': 'low',
                            'drivers': median_comps, 'bracket': 'ok', 'source': 'median+AVM uplift'}
                flags.append(f'median-tier evidence only — ARV at median ceiling {fmt(median_ceiling)} (uplift unverified)')
                return {'arv': round(median_ceiling), 'flags': flags, 'contribs': contribs, 'conf': 'low',
                        'drivers': median_comps, 'bracket': 'ok', 'source': 'median ceiling'}
            flags.append('no retail-priced evidence — ARV withheld (as-is sales are floor evidence only)')
            return {'arv': None, 'flags': flags, 'contribs': contribs, 'conf': 'none',
                    'drivers': [], 'bracket': 'ok', 'source': source}
        drivers = retail
        flags.append(f'no ARV-tier labels — ARV driven on {len(drivers)} retail-marked comp(s); {excluded} as-is-priced sale(s) excluded from ARV')

    # ── Reconciliation anchoring ──────────────────────────────────────────
    # Appraiser pattern: ARV anchors on the MOST-SIMILAR verified comp; the
    # rest of the driver set bounds the range — it never blends across the
    # evidence classes. The weighted blend only applies when no single comp
    # dominates similarity (anchor-of-last-resort).
    ranked = sorted(drivers, key=lambda x: (similarity(x), x['weight']), reverse=True)
    anchor = ranked[0] if ranked else None
    anchor_score = similarity(anchor) if anchor else -1.0

    # Similarity gate — drivers must score ≥60% of the anchor's similarity or
    # they drop out entirely: a far/cross-pocket comp with a clean adjustment
    # is still weak evidence (the 109th Ave case: w=0.93 purely on adj size).
    SIM_GATE = 0.60
    if anchor and len(drivers) > 1:
        gated = [x for x in drivers if similarity(x) >= SIM_GATE * anchor_score]
        dropped = [x for x in drivers if x not in gated]
        for x in dropped:
            flags.append(f"{x['c']['address']}: dropped from drivers — similarity {similarity(x):.1f} below gate ({SIM_GATE * anchor_score:.1f})")
        if gated:
            drivers = gated

    # Pure anchoring — investor ARV semantics, not appraiser median:
    # the strongest verified comp sets ARV. The rest of the gated set is
    # RANGE evidence — it bounds and validates, it never averages in.
    # Blending down prices conservatism into the pipeline and costs deals.
    arv = anchor['contrib']
    support = [x for x in ranked if x in drivers and x is not anchor]
    flags.append(f"anchored to {anchor['c']['address']} (similarity {anchor_score:.1f})")
    if support:
        lo, hi = min(x['contrib'] for x in support), max(x['contrib'] for x in support)
        flags.append(f"supporting range ${lo:,.0f}–${hi:,.0f} ({len(support)} comp(s) — bound, not blended)")
        if anchor['contrib'] > hi:
            flags.append('anchor above supporting range — top of evidence')
        elif anchor['contrib'] < lo:
            flags.append('anchor below supporting range — check whether a better comp should drive')

    # ── Self-verification & heal ──────────────────────────────────────────
    # Don't just flag a suspect conclusion — fix it. The invariants:
    # the anchor should be REPRESENTATIVE of its own driver set, not the
    # floor. Most-similar ≠ most-representative when the nearest comp is
    # also the cheapest product. Heal: re-anchor to the median-contribution
    # driver (bounded — one heal, then the verdict stands with the trail).
    if len(drivers) > 1:
        driver_median = sorted(x['contrib'] for x in drivers)[len(drivers)//2]
        suspect = anchor['contrib'] < 0.8 * driver_median or (support and anchor['contrib'] < lo)
        if suspect:
            healed = min(drivers, key=lambda x: abs(x['contrib'] - driver_median))
            if healed is not anchor:
                flags.append(
                    f"self-heal: anchor {anchor['c']['address'][:30]} was the evidence floor "
                    f"({fmt(anchor['contrib'])} vs driver median {fmt(driver_median)}) — "
                    f"re-anchored to {healed['c']['address'][:30]}")
                anchor, arv = healed, healed['contrib']

    # ── Condition adjustment — the URAR Condition line item ──────────────
    # An all-median driver set prices MEDIAN condition; the subject's
    # as-repaired condition earns the market's renovation premium:
    #   T1 pool tier spread (≥2 premium-tier comps) scaled by rehab level
    #   T2 contributory value — subject's rehab cost × 80%
    #   T3 flag-only. The premium band is the upper bound — the outlier
    #   ceiling still applies below.
    REHAB_FRACTION = {'Full Gut': 0.95, 'Heavy Rehab': 0.85, 'Full Cosmetic': 0.75,
                      'Light Cosmetic': 0.45, 'Lipstick': 0.30}
    if drivers and all(cond_tier(x['c']) == 'median' for x in drivers):
        premium = [x for x in contribs if cond_tier(x['c']) == 'premium']
        cond_adj, cond_src = 0.0, None
        if len(premium) >= 2 and median_comps:
            prem_med = sorted(x['contrib'] for x in premium)[len(premium)//2]
            med_med = sorted(x['contrib'] for x in median_comps)[len(median_comps)//2]
            spread = prem_med/med_med - 1 if med_med else 0
            if spread > 0:
                frac = REHAB_FRACTION.get(subject.get('condition'), 0.5)
                cond_adj = arv * spread * frac
                cond_src = f'T1 tier spread {spread:.0%} × {frac:.2f} ({subject.get("condition")})'
        else:
            rehab = (valuation or {}).get('rehabCost')
            if rehab:
                cond_adj = rehab * 0.8
                cond_src = f'T2 contributory — {fmt(rehab)} rehab cost × 80%'
        if cond_adj >= 1000:
            arv += cond_adj
            flags.append(f'condition adj +{fmt(cond_adj)} [{cond_src}] — median-priced anchor → as-repaired value')
        else:
            flags.append('condition uplift unverified — ARV at median-tier anchor')

    # 5 — outlier ceiling: ARV above the pool's top sale needs ≥OUTLIER_SUPPORT
    # drivers above it — measured against the SIZE-ADJUSTED ceiling, not the
    # raw sale. A comp's raw price is the evidence for ITS size; size-scaled
    # to the subject it's the right denominator. Size uplift is arithmetic,
    # not speculation — the cap still catches non-size stretch.
    def _marg_rate(c):
        if sqft_rate is not None: return sqft_rate
        gap = abs(sub_sqft - c['squareFeet'])/c['squareFeet']
        return (c.get('pricePerSqft') or c['salePrice']/c['squareFeet']) * (0.50 if gap <= 0.10 else 0.40 if gap <= 0.25 else 0.30)
    # Ceiling = the pool's top CONTRIBUTION — evidence priced in subject
    # units, symmetric both directions. A bigger comp's raw sale is the
    # price of MORE product; at subject units it's worth less, not more.
    verified_contribs = [x for x in contribs if x not in unfit]
    size_adj_ceiling = max(
        c['salePrice'] + max(0.0, (sub_sqft - c['squareFeet'])) * _marg_rate(c)
        for c in pool)
    top_contrib = max(x['contrib'] for x in verified_contribs)
    size_adj_ceiling = min(size_adj_ceiling, top_contrib) if top_contrib < size_adj_ceiling else size_adj_ceiling
    top_sale = max(c['salePrice'] for c in pool)
    supporters = sum(1 for x in drivers if x['contrib'] >= size_adj_ceiling)
    capped_outlier = arv > size_adj_ceiling and supporters < OUTLIER_SUPPORT
    if capped_outlier:
        flags.append(f'ARV {fmt(arv)} exceeds size-adjusted ceiling {fmt(size_adj_ceiling)} with {supporters} supporter(s) — capped')
        arv = size_adj_ceiling

    # 4 — bracketing: all-smaller or all-bigger driver set → confidence flag
    sizes = [x['c']['squareFeet'] for x in drivers]
    bracket_flag = 'ok'
    if sub_sqft and all(s < sub_sqft for s in sizes): bracket_flag = 'all-smaller'
    if sub_sqft and all(s > sub_sqft for s in sizes): bracket_flag = 'all-bigger'
    if bracket_flag != 'ok': flags.append(f'bracketing: driver set is {bracket_flag} — no size bracket')

    conf = 'high' if len(drivers) >= 3 and not flags else ('medium' if len(drivers) >= 3 else 'low')
    if bracket_flag != 'ok' or capped_outlier: conf = 'low'
    return {'arv': round(arv), 'flags': flags, 'contribs': contribs, 'conf': conf,
            'drivers': drivers, 'bracket': bracket_flag, 'source': source}

def verify_b(b, subject):
    """Verdict check — is the conclusion defensible against its own evidence?
    Invariants, not outcomes — symmetric: heals low AND high anchors.
    Retry triggers: no ARV produced, or ARV below the as-is AVM (a
    renovation can't be worth less than the un-renovated property)."""
    fails = []
    drivers = b.get('drivers') or []
    if b.get('arv') is None:
        return ['no ARV — evidence pool produced no defensible answer']
    if len(drivers) < 2:
        fails.append('thin evidence (<2 drivers)')
    avm = sub_avm(subject)
    if avm and b['arv'] < avm:
        fails.append('below as-is AVM')
    for f in b.get('flags') or []:
        if 'uncorroborated' in f: fails.append('uncorroborated')
    # anchor-floor — test the condition, not the flag text: the flag prints
    # before self-heal runs, so reading it would fail healed attempts forever
    contribs = sorted(x['contrib'] for x in drivers)
    if contribs and b['arv'] < 0.8 * contribs[len(contribs)//2]:
        fails.append('below evidence median')
    if contribs and b['arv'] > 1.25 * contribs[-1]:
        fails.append('above evidence top')
    return fails

def widen_evidence(subject, items):
    """A2 — expanded search: pull the subject's market-context recent sales
    and merge any the comp fetch missed (dedupe by normalized address)."""
    res = mcp_tool('get_property_data', {
        'property': {'lookupMode': 'attomId', 'attomId': str(subject.get('id'))},
        'datasets': ['market-context']})
    try:
        sales = (res['structuredContent']['results'][0]['data'].get('nearbySales')
                 or res['structuredContent']['results'][0]['data'].get('recentSales') or [])
    except Exception: return 0
    have = {(c.get('address') or '').split(',')[0].strip().lower() for c in items}
    added = 0
    for s_ in sales:
        addr = (s_.get('address') or s_.get('oneLine') or '').split(',')[0].strip().lower()
        if not addr or addr in have: continue
        if not (s_.get('salePrice') or s_.get('price')) or not s_.get('squareFootage'): continue
        items.append({
            'id': str(s_.get('attomId') or addr), 'address': s_.get('address') or addr,
            'salePrice': s_.get('salePrice') or s_.get('price'),
            'saleDate': s_.get('saleDate') or s_.get('recordingDate'),
            'squareFeet': s_.get('squareFootage'),
            'yearBuilt': s_.get('yearBuilt'), 'distanceMiles': s_.get('distanceMiles'),
            'latitude': s_.get('latitude'), 'longitude': s_.get('longitude'),
            'isEnabled': True, 'disableReasons': [], 'supplement': 'market-context retry',
        })
        have.add(addr); added += 1
    return added

def deepen_evidence(subject, items):
    """A3 — verify transaction data: fill missing comp AVMs + land values."""
    filled = 0
    for c in items:
        if not c.get('id'): continue
        if c.get('avmValue') is None:
            res = mcp_tool('get_property_data', {
                'property': {'lookupMode': 'attomId', 'attomId': str(c['id'])},
                'datasets': ['valuation']})
            try:
                rows = res['structuredContent']['results'][0]['data']
                avm = (rows[0] if isinstance(rows, list) else rows).get('avm', {}).get('value') \
                      or (rows[0] if isinstance(rows, list) else rows).get('avmValue')
                if avm: c['avmValue'] = avm; filled += 1
            except Exception: pass
        if c.get('landAssessedValue') is None:
            lv = land_value_of(c['id'])
            if lv is not None: c['landAssessedValue'] = lv; filled += 1
        if filled >= 12: break  # cap call volume per attempt
    return filled

def run_address(addr):
    t0 = time.time()
    job = req('POST', '/v1/analyze', {'address': addr, 'skipCache': True})['data']['jobId']
    status = 'processing'
    while status not in ('complete', 'error'):
        time.sleep(5)
        status = req('GET', f'/v1/analyze/jobs/{job}')['data']['status']
    elapsed = time.time() - t0
    if status == 'error': return {'addr': addr, 'error': True, 'elapsed': elapsed}
    # Clef stamps arrive via async writeback after the response — poll until
    # curbAppeal lands (or ~40s) so condition tiering reads real signals.
    d = req('GET', f'/v1/analyze/jobs/{job}')['data']['result']
    for _ in range(8):
        items = ((d.get('comps') or {}).get('items') or [])
        if any(c.get('curbAppeal') for c in items): break
        time.sleep(5)
        d = req('GET', f'/v1/analyze/jobs/{job}')['data']['result'] or d

    s, val, comps = d['subject'], d.get('valuation') or {}, d['comps']
    items = list(comps['items'])

    # ── Verify-and-retry loop — max 3 attempts, ship best-verified ──────
    b, trail = None, []
    for attempt in (1, 2, 3):
        b = set_b(s, items, val)
        fails = verify_b(b, s)
        if not fails:
            if attempt > 1: b['flags'].append(f'attempt {attempt} verified clean')
            break
        trail.append(f'attempt {attempt} fails: {", ".join(fails)}')
        if attempt == 1:
            n = widen_evidence(s, items)
            trail.append(f'attempt 2 prep: widened evidence +{n} comps')
        elif attempt == 2:
            n = deepen_evidence(s, items)
            trail.append(f'attempt 3 prep: deepened enrichment +{n} fields')
    else:
        pass
    # Fallback after the ladder: a withheld ARV cascades to the labeled
    # AVM floor — never silent, never a bare refusal.
    if b.get('arv') is None and sub_avm(s):
        b['arv'] = round(sub_avm(s))
        b['source'] = 'T3 AVM floor (post-retry)'
        trail.append('all attempts failed — ARV set at as-is AVM floor (unverified, not ARV-tier)')
    b['flags'] = trail + b['flags']
    comps['items'] = items
    sel = [c for c in comps['items'] if c.get('arvStatus') == 'selected' or (c['isEnabled'] and c.get('salePrice'))]

    return {'addr': addr, 'elapsed': elapsed, 'subject': s,
        'a': {'arv': val.get('arv'), 'source': val.get('arvSource'), 'buy': val.get('buyPrice'),
              'insufficient': comps.get('insufficientComps'), 'enabled': comps.get('enabledCount'), 'total': comps.get('total'),
              'condition': s.get('condition'), 'conf': (d.get('report') or {}).get('confidence'),
              'drivers': sel},
        'b': b, 'items': comps['items']}

def card(r):
    print(f"\n{'='*70}\n{r['addr'].upper()} — {r['elapsed']:.0f}s\n{'='*70}")
    if r.get('error'): print('ERROR'); return
    s, a, b = r['subject'], r['a'], r['b']
    print(f"subject: {s['squareFeet']}sf {s.get('yearBuilt')} | AVM {fmt((s.get('avm') or {}).get('value'))} | assessed {fmt(s.get('taxAssessment'))} | Luna: {a['condition']}")
    if s.get('zoning'):
        print(f"zoning:  {s['zoning']} — {s.get('zoningDescription') or ''}")
    if s.get('developmentSignal'):
        print(f"HBU:     {s['developmentSignal']}")
    print(f"SET A    ARV {fmt(a['arv'])} ({a['source']}) | buy {fmt(a['buy'])} | {a['enabled']}/{a['total']} enabled | insufficient={a['insufficient']}")
    if a['drivers']:
        print('  A comps:')
        for c in a['drivers'][:8]:
            print(f"    {c['address'][:42]:44} {fmt(c.get('salePrice')):>10} {c.get('distanceMiles',0):.2f}mi avm={fmt(c.get('avmValue'))}  {c.get('zillowUrl') or '-'}")
    print(f"SET B    ARV {fmt(b['arv'])} | conf {b['conf']} | bracket {b.get('bracket')} | {b.get('source','')}")
    for x in b.get('drivers') or b.get('contribs', [])[:8]:
        c = x['c']
        print(f"    {c['address'][:42]:44} {fmt(c.get('salePrice')):>10} contrib {fmt(x['contrib'])} w={x['weight']:.2f} tier={x['tier']} avm={fmt(c.get('avmValue'))}  {c.get('zillowUrl') or '-'}")
    for f in b['flags']: print(f"    ! {f}")
    if a['arv'] and b['arv']:
        d = b['arv'] - a['arv']; pct = d / a['arv'] * 100
        print(f"DELTA    B − A = {fmt(d)} ({pct:+.1f}%)")

if __name__ == '__main__':
    results = [run_address(a.strip()) for a in sys.argv[1:] if a.strip()]
    for r in results: card(r)
    print(f"\n{'='*70}\nSUMMARY\n{'='*70}")
    agree = sum(1 for r in results if not r.get('error') and r['a']['arv'] and r['b']['arv'] and abs(r['b']['arv']-r['a']['arv'])/r['a']['arv'] < 0.1)
    n = sum(1 for r in results if not r.get('error') and r['a']['arv'] and r['b']['arv'])
    print(f"addresses: {len(results)} | both-ARV: {n} | agree within 10%: {agree}")
