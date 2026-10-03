#!/usr/bin/env python3
"""A/B eval harness — Set A (live pipeline ARV) vs Set B (trade-tricks spec).
Reads the API result and re-derives ARV under the appraiser-trade-tricks rules.
NOT committed — calibration tooling only."""
import json, sys, time, urllib.request
from datetime import datetime, timezone

API = 'http://localhost:8787'
KEY = 'fs_35fd82dfcc3849c37a4e42347ee79bf0350503117d46cc8d'

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

def age_days(d):
    if not d: return None
    try: return (datetime.now(timezone.utc) - datetime.fromisoformat(d.replace('Z','+00:00'))).days
    except Exception: return None

def set_b(subject, items):
    """Recompute ARV under trade-tricks over the same enabled pool as A."""
    sub_sqft = subject.get('squareFeet')
    pool = [c for c in items if c['isEnabled'] and c.get('salePrice') and c.get('squareFeet')]
    if not pool: return {'arv': None, 'flags': ['no enabled comps'], 'contribs': [], 'conf': 'none'}

    contribs, flags = [], []
    for c in pool:
        comp_sqft = c['squareFeet']; ppsf = c.get('pricePerSqft') or c['salePrice']/comp_sqft
        base = c.get('adjustedPrice') or c['salePrice']
        # 1 — marginal sqft scaling: size delta priced at MARGINAL_FACTOR×ppsf,
        # not full proportional — damps over-correction on big size gaps
        contrib = base + (sub_sqft - comp_sqft) * ppsf * MARGINAL_FACTOR
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
    verified_pool = [x for x in contribs if x not in unfit]
    arv_tier = [x for x in verified_pool if x['tier'] == 'arv']
    if arv_tier:
        drivers = arv_tier
    else:
        top_ppsf = max(ppsf_of(x) for x in verified_pool) if verified_pool else None
        retail = [x for x in verified_pool
                  if x['tier'] != 'as_is' and top_ppsf and ppsf_of(x) >= RETAIL_BAND * top_ppsf]
        excluded = len(contribs) - len(retail)
        if not retail:
            flags.append('no retail-priced evidence — ARV withheld (as-is sales are floor evidence only)')
            return {'arv': None, 'flags': flags, 'contribs': contribs, 'conf': 'none',
                    'drivers': [], 'bracket': 'ok'}
        drivers = retail
        flags.append(f'no ARV-tier labels — ARV driven on {len(drivers)} retail-marked comp(s); {excluded} as-is-priced sale(s) excluded from ARV')

    arv = sum(x['contrib']*x['weight'] for x in drivers) / max(1e-9, sum(x['weight'] for x in drivers))

    # 5 — outlier ceiling: ARV above pool's top actual sale needs ≥OUTLIER_SUPPORT drivers above it
    top_sale = max(c['salePrice'] for c in pool)
    supporters = sum(1 for x in drivers if x['contrib'] >= top_sale)
    capped_outlier = arv > top_sale and supporters < OUTLIER_SUPPORT
    if capped_outlier:
        flags.append(f'ARV {fmt(arv)} exceeds top sale {fmt(top_sale)} with {supporters} supporter(s) — capped')
        arv = top_sale

    # 4 — bracketing: all-smaller or all-bigger driver set → confidence flag
    sizes = [x['c']['squareFeet'] for x in drivers]
    bracket_flag = 'ok'
    if sub_sqft and all(s < sub_sqft for s in sizes): bracket_flag = 'all-smaller'
    if sub_sqft and all(s > sub_sqft for s in sizes): bracket_flag = 'all-bigger'
    if bracket_flag != 'ok': flags.append(f'bracketing: driver set is {bracket_flag} — no size bracket')

    conf = 'high' if len(drivers) >= 3 and not flags else ('medium' if len(drivers) >= 3 else 'low')
    if bracket_flag != 'ok' or capped_outlier: conf = 'low'
    return {'arv': round(arv), 'flags': flags, 'contribs': contribs, 'conf': conf,
            'drivers': drivers, 'bracket': bracket_flag}

def run_address(addr):
    t0 = time.time()
    job = req('POST', '/v1/analyze', {'address': addr, 'skipCache': True})['data']['jobId']
    status = 'processing'
    while status not in ('complete', 'error'):
        time.sleep(5)
        status = req('GET', f'/v1/analyze/jobs/{job}')['data']['status']
    elapsed = time.time() - t0
    if status == 'error': return {'addr': addr, 'error': True, 'elapsed': elapsed}
    d = req('GET', f'/v1/analyze/jobs/{job}')['data']['result']

    s, val, comps = d['subject'], d.get('valuation') or {}, d['comps']
    b = set_b(s, comps['items'])
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
    print(f"SET A    ARV {fmt(a['arv'])} ({a['source']}) | buy {fmt(a['buy'])} | {a['enabled']}/{a['total']} enabled | insufficient={a['insufficient']}")
    if a['drivers']:
        print('  A comps:')
        for c in a['drivers'][:8]:
            print(f"    {c['address'][:42]:44} {fmt(c.get('salePrice')):>10} {c.get('distanceMiles',0):.2f}mi avm={fmt(c.get('avmValue'))}  {c.get('zillowUrl') or '-'}")
    print(f"SET B    ARV {fmt(b['arv'])} | conf {b['conf']} | bracket {b.get('bracket')}")
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
