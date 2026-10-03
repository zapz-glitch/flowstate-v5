#!/usr/bin/env python3
"""Run an address through the local API and print a verification scorecard."""
import json, sys, time, urllib.request

API = 'http://localhost:8787'
KEY = 'fs_35fd82dfcc3849c37a4e42347ee79bf0350503117d46cc8d'

def req(method, path, body=None):
    r = urllib.request.Request(API + path, method=method,
        headers={'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'},
        data=json.dumps(body).encode() if body else None)
    return json.load(urllib.request.urlopen(r))

def fmt(n): return f"${n:,}" if isinstance(n, (int, float)) else '-'

def scorecard(addr):
    t0 = time.time()
    job = req('POST', '/v1/analyze', {'address': addr})['data']['jobId']
    status = 'processing'
    while status not in ('complete', 'error'):
        time.sleep(5)
        status = req('GET', f'/v1/analyze/jobs/{job}')['data']['status']
    elapsed = time.time() - t0
    if status == 'error':
        print(f'ERROR after {elapsed:.0f}s'); return

    d = req('GET', f'/v1/analyze/jobs/{job}')['data']['result']
    s, val, comps = d['subject'], d.get('valuation') or {}, d['comps']
    items = comps['items']

    print(f"\n{'='*64}\n{addr.upper()} — {elapsed:.0f}s\n{'='*64}")
    print(f"SUBJECT  {s['squareFeet']}sf | {s.get('bedrooms')}bd/{s.get('bathrooms')}ba | built {s.get('yearBuilt')} | lot {s.get('lotSizeAcres')}ac")
    avm = (s.get('avm') or {}).get('value')
    print(f"         AVM {fmt(avm)} | assessed {fmt(s.get('taxAssessment'))} | last sale {fmt(s.get('lastSalePrice'))}")
    print(f"         Luna: {s.get('condition','-')} | {(s.get('conditionSummary') or '')[:75]}")

    nom = [c for c in items if any('Non-market' in (r or '') for r in (c.get('disableReasons') or []))]
    rural = [c for c in items if any('category mismatch' in (r or '') for r in (c.get('disableReasons') or []))]
    road = [c for c in items if any('major road' in (r or '') for r in (c.get('disableReasons') or []))]
    bg = sum(1 for c in items if c.get('sameBlockGroup'))
    tract = sum(1 for c in items if c.get('censusTract'))
    clef = sum(1 for c in items if (c.get('curbAppeal') or {}).get('condition') not in (None, 'unknown'))
    n4 = sum(1 for c in items if c.get('neighborhoodName'))

    print(f"\nCOMPS    {comps['total']} fetched | {comps['enabledCount']} enabled | insufficient={comps.get('insufficientComps')}")
    print(f"         gates: {len(nom)} nominal-sale kills | {len(rural)} lot-category | {len(road)} road barrier")
    print(f"         geo: {bg} same-BG | {tract} tract-stamped | {n4} N4-named | clef: {clef} stamped")
    flex = (comps.get('retrieval') or {}).get('paramFlex') or {}
    if flex.get('factor', 1) > 1:
        print(f"         flex: x{flex['factor']} ({flex.get('extensions')} stretches) — thin pool")

    print(f"\nENABLED:")
    for c in items:
        if c['isEnabled']:
            curb = (c.get('curbAppeal') or {}).get('condition') or '-'
            print(f"   {c['address'][:44]:46} {fmt(c.get('salePrice')):>10} | {c.get('distanceMiles',0):.2f}mi | {curb}")

    print(f"\nVALUATION  ARV {fmt(val.get('arv'))} ({val.get('arvSource')}) | rehab {fmt(val.get('rehabCost'))} | buy {fmt(val.get('buyPrice'))} | wholesale {fmt(val.get('wholesalePrice'))}")
    if val.get('arvMethodology'): print(f"           {val['arvMethodology'][:90]}")

if __name__ == '__main__':
    scorecard(sys.argv[1])
