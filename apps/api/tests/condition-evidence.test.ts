import assert from 'node:assert/strict'
import { parseConditionObservation, safeConditionImages } from '../src/services/evaluation/condition-evidence'

const photo = { url: 'https://photos.zillowstatic.com/fp/fixture.jpg', kind: 'photo' as const }
const observed = { status: 'unfinished_or_distressed', confidence: 'high', reason: 'Open walls visible', relevant_property_visible: true, interior_visible: true, image_indices: [0], observations: ['Open walls'] }
const undated = parseConditionObservation({ ...observed, sale_relevant: true }, [photo], '2026-08-01')
assert.equal(undated.condition.sale_relevant, false)
assert.match(undated.condition.reason, /not tied/)
const dated = parseConditionObservation(observed, [{ ...photo, verifiedSaleDate: '2026-08-01' }], '2026-08-01')
assert.equal(dated.condition.sale_relevant, true)
assert.equal(dated.condition.status, 'unfinished_or_distressed')
assert.equal(parseConditionObservation({ ...observed, status: 'renovated', interior_visible: false }, [photo], null).condition.status, 'unknown')
assert.equal(parseConditionObservation({ ...observed, relevant_property_visible: false }, [photo], null).condition.status, 'unknown')
assert.equal(parseConditionObservation({ ...observed, image_indices: [99] }, [photo], null).condition.status, 'unknown')
assert.equal(parseConditionObservation({ ...observed, image_indices: [] }, [photo], null).condition.status, 'unknown')
assert.equal(safeConditionImages([{ ...photo, url: 'http://127.0.0.1/a' }, { ...photo, url: 'https://photos.zillowstatic.com.evil.test/a' }, photo]).length, 1)
assert(!('garage_spaces' in dated.condition))
console.log('Condition evidence preserves source dates, rejects unusable images and does not infer characteristics')
