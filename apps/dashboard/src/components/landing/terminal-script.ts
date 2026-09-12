export type ScriptLine =
  | { kind: 'step'; label: string; ms: number }
  | { kind: 'kv'; key: string; value: string; highlight?: boolean }
  | { kind: 'done'; text: string }

export interface Scenario {
  command: string
  lines: ScriptLine[]
}

export const scenarios: Scenario[] = [
  {
    command: 'flowstate analyze "4120 Palm Ave, Tampa, FL 33603"',
    lines: [
      { kind: 'step', label: 'property record', ms: 600 },
      { kind: 'step', label: 'condition: original kitchen, roof 2004', ms: 900 },
      { kind: 'step', label: 'comparable sales: 14 within 0.5 mi', ms: 1200 },
      { kind: 'step', label: 'appraisal rules: 3 comps selected', ms: 500 },
      { kind: 'kv', key: 'arv', value: '$312,000' },
      { kind: 'kv', key: 'rehab', value: '$48,500' },
      { kind: 'kv', key: 'offer', value: '$209,400 cash', highlight: true },
      { kind: 'kv', key: 'close', value: '21 days' },
      { kind: 'done', text: 'underwritten in 3.2s / exit: fix and flip' },
    ],
  },
  {
    command: 'flowstate analyze "915 Lakeview Dr, Orlando, FL 32803"',
    lines: [
      { kind: 'step', label: 'property record', ms: 500 },
      { kind: 'step', label: 'condition: inherited estate, deferred maintenance', ms: 1000 },
      { kind: 'step', label: 'comparable sales: 11 within 0.75 mi', ms: 1100 },
      { kind: 'step', label: 'appraisal rules: 3 comps selected', ms: 500 },
      { kind: 'kv', key: 'arv', value: '$268,000' },
      { kind: 'kv', key: 'rehab', value: '$31,200' },
      { kind: 'kv', key: 'rent', value: '$2,150 / mo' },
      { kind: 'kv', key: 'offer', value: '$171,000 cash', highlight: true },
      { kind: 'done', text: 'underwritten in 3.1s / exit: buy and hold' },
    ],
  },
  {
    command: 'flowstate analyze "2207 Elm St, Clearwater, FL 33755"',
    lines: [
      { kind: 'step', label: 'property record', ms: 500 },
      { kind: 'step', label: 'condition: code violations, vacant, non-financeable', ms: 900 },
      { kind: 'step', label: 'comparable sales: 9 within 1.0 mi', ms: 1000 },
      { kind: 'step', label: 'appraisal rules: 3 comps selected', ms: 400 },
      { kind: 'kv', key: 'arv', value: '$241,000' },
      { kind: 'kv', key: 'rehab', value: '$62,000' },
      { kind: 'kv', key: 'offer', value: '$128,500 cash', highlight: true },
      { kind: 'kv', key: 'close', value: '14 days' },
      { kind: 'done', text: 'underwritten in 2.8s / exit: wholesale' },
    ],
  },
]
