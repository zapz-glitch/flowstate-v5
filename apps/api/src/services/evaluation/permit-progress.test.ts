import { describe, it, expect } from 'vitest'
import { permitsAssessed, permitsReceived, permitsRequested } from './permit-progress'

describe('permit progress messages', () => {
  it('names the request stage', () => {
    expect(permitsRequested()).toEqual({ message: 'Requesting permit records', data: { stage: 'requesting' } })
  })

  it('says how many permits were found, singular and plural', () => {
    expect(permitsReceived({ success: true, data: { permits: [{}], count: 1 } }).message).toBe('1 permit found')
    expect(permitsReceived({ success: true, data: { permits: [{}, {}, {}], count: 3 } })).toEqual({
      message: '3 permits found', data: { stage: 'received', state: 'ok', count: 3 },
    })
  })

  it('counts the list when the provider sends no count', () => {
    expect(permitsReceived({ success: true, data: { permits: [{}, {}] } }).data.count).toBe(2)
  })

  it('says none are on file when the lookup worked and found nothing', () => {
    expect(permitsReceived({ success: true, data: { permits: [], count: 0 } })).toEqual({
      message: 'No permits on file', data: { stage: 'received', state: 'empty', count: 0 },
    })
    expect(permitsReceived({ success: true, data: null }).data.state).toBe('empty')
  })

  it('says unavailable, never "none", when the lookup failed or was skipped', () => {
    for (const result of [{ success: false as const, error: 'timeout' }, null, undefined]) {
      expect(permitsReceived(result)).toEqual({ message: 'Permit lookup unavailable', data: { stage: 'received', state: 'unavailable' } })
    }
  })

  it('reports the major items charged, and stays silent when there were no permits', () => {
    expect(permitsAssessed(4, 2)).toEqual({ message: 'Major items assessed from permits · 2 charged', data: { stage: 'assessed', count: 2 } })
    expect(permitsAssessed(4, 0)?.message).toBe('Major items assessed from permits · none charged')
    expect(permitsAssessed(0, 0)).toBeNull()
  })
})
