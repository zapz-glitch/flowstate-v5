/**
 * Selection when no comp passes the filter rules.
 *
 * Way this can fail: every comp is switched off by the filter rules, the
 * appraiser picks the closest ones anyway (its job in that case), and the
 * validation rejects them only for being switched off.
 */

import { describe, expect, it } from 'vitest'
import { validateAgentSelection } from './index'

const comp = (id: string, isEnabled: boolean) =>
  ({ id, isEnabled, salePrice: 200000, squareFeet: 1200 }) as Parameters<typeof validateAgentSelection>[1][number]

describe('validateAgentSelection', () => {
  it('accepts rule-failing picks only when no comp in the pool passes the rules', () => {
    const selection = { arv: 205000, conf: 'low' as const, selectedCompIds: ['a', 'b'] }
    expect(validateAgentSelection(selection, [comp('a', false), comp('b', false)])).toEqual([])
    expect(validateAgentSelection(selection, [comp('a', false), comp('b', false), comp('c', true)]))
      .toContain('selected comp a is not an enabled pool member')
  })
})
