import { assessRenovationFromPhotos } from '../apps/api/src/services/vision/renovation'
import { createPhotoService } from '../apps/api/src/services/photo-provider'
import { readFileSync } from 'fs'

const vars = Object.fromEntries(readFileSync('apps/api/.dev.vars', 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')] }))

const env = { ...vars, OPENROUTER_MODEL: 'openai/gpt-6-luna' } as any
const photoSvc = createPhotoService(env as any, { provider: 'zillow' })
const res = await photoSvc.fetchPhotos({ address: '8952 Sterling Ln', city: 'Port Richey', state: 'FL', zipCode: '34668' })
const photos = res?.success ? res.data : null
console.log('photos:', photos?.photos?.length, 'source:', photos?.source)
const urls = (photos?.photos ?? []).slice(0, 8)
console.log('using', urls.length, 'photos')
const out = await assessRenovationFromPhotos(env, urls, { address: '8952 Sterling Ln, Port Richey FL', squareFeet: 1340, yearBuilt: 1975 })
console.log(JSON.stringify({
  status: out.status, level: out.renovationLevel, idx: out.renovationLevelIndex,
  confidence: out.confidence, kitchen: out.kitchenCondition, bath: out.bathroomCondition,
  exterior: out.exteriorCondition, provider: out.provider, model: out.model,
  curbAppeal: out.curbAppeal, rationale: out.rationale,
}, null, 1))
