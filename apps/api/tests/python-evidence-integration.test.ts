import assert from 'node:assert/strict'
import { evaluateConfigured, type PythonResult } from '../src/services/evaluation/python'
import { verifyConfiguredPythonSnapshot } from '../src/services/evaluation/python-snapshot'
import type { EvaluationParams } from '../src/services/evaluation'
import type { Env } from '../src/types'

const subject = { id: 'subject', provider: 'corelogic', address: '100 Fixture Ct', city: 'Orlando', state: 'FL', zipCode: '32811', squareFeet: 2000, yearBuilt: 2000, subdivision: 'Fixture', lastSalePrice: 200000, lastSaleDate: '2025-01-01' }
const comparables = ['101', '102'].map((number, index) => ({
  ...subject, id: `comp-${number}`, address: `${number} Fixture Ct`, salePrice: 300000 + index * 10000,
  saleDate: '2026-01-01', distanceMiles: 0.1,
  raw: { saleAmount: 300000 + index * 10000, saleDate: '20260101', transactionType: 'old-transaction-type', transactionCode: 'old-code', isSale: true },
}))
const params = { jobId: 'synthetic-evidence-integration', bundle: { property: subject, comparables, enrichment: {}, metadata: { fetchedAt: '2026-09-08T12:00:00Z' } } } as unknown as EvaluationParams
const secret = 'synthetic-integration-secret-not-production-123456'
const env = { EVALUATION_ENGINE: 'python-v4', ENVIRONMENT: 'development', V4_LOCAL_BRIDGE_TOKEN: secret,
  V4_LOCAL_BRIDGE_URL: 'http://127.0.0.1:8788', FIRECRAWL_API_KEY: 'synthetic-provider-key',
  API_CACHE: { get: async () => null, put: async () => undefined },
} as unknown as Env
env.V4_SNAPSHOT_ACTIVE_KEY_ID = 'test'
env.V4_SNAPSHOT_KEYS = JSON.stringify({ test: 'synthetic-independent-signing-key-000001' })
const requests: any[] = []
let firecrawlCalls = 0
let withPhotos = false
let visionCalls = 0
const storedImages = new Map<string, Uint8Array>()
Object.assign(env, { OPENAI_API_KEY: 'synthetic-vision-key', REPORT_ASSETS: {
  put: async (key: string, bytes: Uint8Array) => { storedImages.set(key, bytes.slice()) },
  get: async (key: string) => { const bytes = storedImages.get(key); return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null },
} })
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  if (String(input).startsWith('https://photos.zillowstatic.com/')) return new Response(new Uint8Array([255, 216, 255, 224, 1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } })
  const body = JSON.parse(String(init?.body))
  if (String(input) === 'https://api.openai.com/v1/chat/completions') {
    visionCalls++
    assert(storedImages.size > 0)
    const images = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).filter((item: any) => item.type === 'image_url')
    assert(images.length > 0)
    for (const image of images) {
      assert.match(image.image_url.url, /^data:image\/jpeg;base64,/)
      assert([...storedImages.values()].some(bytes => image.image_url.url === `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`))
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ status: 'renovated', confidence: 'high', reason: 'Fixture updated interior', relevant_property_visible: true, interior_visible: true, image_indices: [0], observations: ['Updated cabinets'] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  }
  if (String(input) === 'http://127.0.0.1:8788/evaluate') {
    requests.push(body)
    const result: PythonResult = {
      methodology_version: 'evaluation-v4', status: 'REVIEW_REQUIRED', settings_snapshot_id: body.settings.snapshot_id, settings_content_hash: 'synthetic-result-hash',
      decisions: body.comps.map((comp: any) => ({ comp_id: comp.comp_id, arv_status: comp.comp_id === 'comp-101' ? 'ACCEPTED' : 'REJECTED', condition_classification: 'B', priority_rank: comp.comp_id === 'comp-101' ? 1 : 2,
        rejection_reasons: [], limitations: [], rule_outcomes: [{ rule_id: 'subdivision', kind: 'subdivision_match', passed: true, reason: 'Fixture match' }] })),
      ledger: [], errors: [], incomplete_sections: [],
      arv: { final_arv: '450000', average_adjusted_ppsf: '225', accepted_comp_ids: ['comp-101'], limitations: [], selection_policy: 'provider_authoritative_upper_half_v2', qualified_comp_count: 2, upper_half_cutoff_price: '450000', comp_weights: { 'comp-101': '1' } },
      renovation: { total_rehab: '70000', base_rehab: '70000', renovation_level: 'full_cosmetic', limitations: [] },
      deal: { investor_purchase_ceiling_exact: '295000', seller_contract_ceiling_exact: '285000', closing_costs: '36000', carrying_costs: '9000', flip_profit: '40000', displayed_mao: '285000' },
      investor: null,
    }
    return Response.json({ engine: 'python-v4', result })
  }
  firecrawlCalls++
  if (String(input) === 'https://api.firecrawl.dev/v2/search') return Response.json({ success: true, data: { web: [] } })
  assert.equal(String(input), 'https://api.firecrawl.dev/v2/scrape')
  const property = [subject, ...comparables].find(p => decodeURIComponent(body.url).toLowerCase().includes(p.address.replaceAll(' ', '-').toLowerCase()))
  assert(property, `Unexpected fixture URL ${body.url}`)
  const askingOnly = property.id === 'comp-102'
  const photo = `https://photos.zillowstatic.com/fp/${property.id}.jpg`
  return Response.json({ success: true, data: { markdown: `# ${property.address}, ${property.city}, ${property.state} ${property.zipCode}\n${withPhotos ? `![Property interior](${photo})` : ''}\n\n## Price history\n| Date | Event | Price |\n| 8/1/2026 | ${askingOnly ? 'Listed for sale' : 'Sold'} | $${askingOnly ? '999,999' : '450,000'} |\n`, json: {
    identity: { address: property.address, city: property.city, state: property.state, zipCode: property.zipCode },
    status: 'for_sale', askingPrice: 999999, photos: withPhotos ? [photo] : [], garageSpaces: 2,
    priceHistory: [{ event: askingOnly ? 'Listed for sale' : 'Sold', date: '2026-08-01', price: askingOnly ? 999999 : 450000 }],
  } } })
}
try {
  const { response } = await evaluateConfigured(params, env)
  const report = response as any
  assert.equal(firecrawlCalls, 8)
  assert.equal(report.evidenceRefresh.providerCalls, firecrawlCalls)
  assert.equal(requests.length, 3)
  const finalRequest = requests.at(-1)
  assert.equal(requests[0].comps[0].verified_sale_price, '300000')
  const resolved = finalRequest.comps.find((c: any) => c.comp_id === 'comp-101')
  assert.equal(resolved.verified_sale_price, '450000')
  assert.equal(resolved.sale_date, '2026-08-01')
  assert.equal(resolved.transaction_code, '')
  assert.equal(resolved.transaction_type, '')
  assert.match(resolved.evidence_ref, /^zillow:comp-101:/)
  assert.equal(finalRequest.settings.arv_selection_policy, 'provider_authoritative_upper_half_v2')
  assert.equal(resolved.garage_spaces, undefined)
  assert.equal(resolved.physical_similarity, undefined)
  assert.equal(resolved.condition_evidence.status, 'unknown')
  assert.equal(resolved.condition_evidence.sale_relevant, false)
  const askingOnly = finalRequest.comps.find((c: any) => c.comp_id === 'comp-102')
  assert.equal(askingOnly.verified_sale_price, '310000')
  assert.equal(askingOnly.sale_date, '2026-01-01')
  assert(!JSON.stringify(finalRequest).includes('999999'))
  assert.equal(report.subject.askingPrice, undefined)
  const uiComp = report.comps.items.find((c: any) => c.id === 'comp-101')
  assert.equal(uiComp.salePrice, 450000)
  assert.equal(uiComp.saleDate, '2026-08-01')
  const audit = report.evidenceRefresh.comps.find((c: any) => c.propertyId === 'comp-101')
  assert.deepEqual(audit.originalRaw, comparables[0].raw)
  assert.deepEqual(audit.originalSale, { price: 300000, date: '2026-01-01' })
  assert.deepEqual(audit.resolvedSale, { price: 450000, date: '2026-08-01' })
  assert.equal(audit.askingPrice, null)
  assert.deepEqual(audit.attributes, {})
  assert.equal(uiComp.conditionClassification, 'B')
  assert.match(audit.saleEvidence, /8\/1\/2026.*Sold.*450,000/)
  assert.deepEqual(report.pythonRequest, finalRequest)
  assert(await verifyConfiguredPythonSnapshot(params.jobId, report.pythonRequest, report.pythonRequestSignature, env))
  const tampered = structuredClone(report.pythonRequest)
  tampered.comps[0].verified_sale_price = '999999'
  assert(!await verifyConfiguredPythonSnapshot(params.jobId, tampered, report.pythonRequestSignature, env))
  assert.equal(params.bundle.comparables[0].salePrice, 300000)
  assert.equal(report.evaluationEngine, 'python-v4')
  assert.equal(report.apiCallStats.firecrawl.calls, firecrawlCalls)
  assert.equal(report.apiCallStats.vision.calls, 0)
  assert.equal(report.apiCallStats.totalExternalCalls, (params.apiCallStats?.totalExternalCalls ?? 0) + firecrawlCalls)
  withPhotos = true
  const captured = (await evaluateConfigured(params, env)).response as any
  assert.equal(requests.length, 6)
  assert.equal(visionCalls, 3)
  assert.equal(storedImages.size, 3)
  assert.equal(captured.reportAssets.length, 3)
  assert.equal(captured.apiCallStats.vision.calls, 3)
  assert(captured.subject.photos.every((url: string) => url.startsWith('/user/reports/')))
  assert.equal(requests.at(-1).comps[0].condition_evidence.status, 'renovated')
  assert.equal(requests.at(-1).comps[0].condition_evidence.sale_relevant, false)
  assert(await verifyConfiguredPythonSnapshot(params.jobId, captured.pythonRequest, captured.pythonRequestSignature, env))
  console.log('Python resolved-evidence integration, asking-price isolation, audit and snapshot signing passed')
} finally {
  globalThis.fetch = originalFetch
}
