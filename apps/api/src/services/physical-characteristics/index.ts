export type PhysicalCharacteristicSource = 'redfin' | 'zillow' | 'attom'
export type PhysicalCharacteristicStatus = 'verified' | 'conflict' | 'unverified'
export type PhysicalCharacteristicValue = string | number | boolean

export interface PhysicalCharacteristic<T extends PhysicalCharacteristicValue = PhysicalCharacteristicValue> {
  value: T | null
  status: PhysicalCharacteristicStatus
  sources: Array<{ source: PhysicalCharacteristicSource; value: PhysicalCharacteristicValue }>
}

export interface PhysicalCharacteristics {
  style: PhysicalCharacteristic<string>
  stories: PhysicalCharacteristic<number>
  constructionType: PhysicalCharacteristic<string>
  exterior: PhysicalCharacteristic<string>
  roof: PhysicalCharacteristic<string>
  foundation: PhysicalCharacteristic<string>
  garage: PhysicalCharacteristic<string>
  pool: PhysicalCharacteristic<boolean>
}

export interface PhysicalCharacteristicSourceData {
  style?: string | null
  stories?: string | number | null
  constructionType?: string | null
  exterior?: string | null
  roof?: string | null
  foundation?: string | null
  garage?: string | null
  pool?: boolean | null
}

export interface PhysicalCharacteristicInputs {
  redfin?: PhysicalCharacteristicSourceData | null
  zillow?: PhysicalCharacteristicSourceData | null
  attom?: PhysicalCharacteristicSourceData | null
}

const SOURCE_ORDER: PhysicalCharacteristicSource[] = ['attom', 'redfin', 'zillow']
const PROPERTY_TYPE_STYLES = new Set([
  'single family residential',
  'single family',
  'single family detached',
  'detached single family',
  'residential',
  'sfr',
  'detached',
  'single family home',
  'house',
])

function cleanText(value?: string | null): string | null {
  if (!value) return null
  const cleaned = value.trim().replace(/\s+/g, ' ')
  if (!cleaned || /^(null|none|n\/?a|unknown|not specified)$/i.test(cleaned)) return null
  return cleaned
}

function comparableText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function styleCategory(value?: string | null): string | null {
  const cleaned = cleanText(value)
  if (!cleaned) return null
  const text = comparableText(cleaned)
  if (PROPERTY_TYPE_STYLES.has(text)) return null
  const categories: Array<[RegExp, string]> = [
    [/\branch\b/, 'ranch'],
    [/\bcolonial\b/, 'colonial'],
    [/\bcraftsman\b/, 'craftsman'],
    [/\bcontemporary\b/, 'contemporary'],
    [/\btraditional\b/, 'traditional'],
    [/\bbungalow\b/, 'bungalow'],
    [/\bcape cod\b/, 'cape cod'],
    [/\bsplit level\b|\bsplit foyer\b/, 'split level'],
    [/\btudor\b/, 'tudor'],
    [/\bvictorian\b/, 'victorian'],
    [/\bcottage\b/, 'cottage'],
    [/\bmediterranean\b/, 'mediterranean'],
  ]
  return categories.find(([pattern]) => pattern.test(text))?.[1] ?? text
}

function storiesCategory(value?: string | number | null): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  const cleaned = cleanText(value)
  if (!cleaned) return null
  const text = comparableText(cleaned)
  if (/\bone\s+(?:and\s+)?one\s+half\b/.test(text)) return 1.5
  const numeric = text.match(/\b(\d+(?:\.\d+)?)\b/)?.[1]
  if (numeric) {
    const parsed = Number(numeric)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  const words: Array<[RegExp, number]> = [
    [/\bone\b/, 1],
    [/\btwo\b/, 2],
    [/\bthree\b/, 3],
    [/\bfour\b/, 4],
    [/\bfive\b/, 5],
  ]
  return words.find(([pattern]) => pattern.test(text))?.[1] ?? null
}

function roofCategory(value?: string | null): string | null {
  const cleaned = cleanText(value)
  if (!cleaned) return null
  const text = comparableText(cleaned)
  if (/\bwood\s*(?:shake|shingle)s?\b/.test(text)) return 'wood shake'
  if (/\bmetal\b|\bsteel\b|\baluminum\b/.test(text)) return 'metal'
  if (/\bslate\b/.test(text)) return 'slate'
  if (/\btile\b|\bclay\b|\bconcrete tile\b/.test(text)) return 'tile'
  if (/\bshingle\b|\basphalt\b|\barchitectural\b|\bcomposition\b|\b3 tab\b|\bthree tab\b/.test(text)) return 'composition'
  // Vague values ("Other") carry no category — they can't verify or conflict.
  return null
}

function constructionTypeCategory(value?: string | null): string | null {
  const cleaned = cleanText(value)
  if (!cleaned) return null
  const text = comparableText(cleaned)
  if (/\bconcrete block\b|\bcinder block\b|\bcmu\b/.test(text)) return 'concrete block'
  if (/\bwood frame\b|^frame$|\bframe construction\b/.test(text)) return 'frame'
  if (/\bmasonry\b|\bbearing walls?\b|\bbrick construction\b|\bblock construction\b/.test(text)) return 'masonry'
  return null
}

function exteriorCategory(value?: string | null): string | null {
  const cleaned = cleanText(value)
  if (!cleaned) return null
  const text = comparableText(cleaned)
  const categories = new Set<string>()
  if (/\bbrick\b/.test(text)) categories.add('brick')
  if (/\bvinyl(?: siding)?\b/.test(text)) categories.add('vinyl siding')
  if (/\bhardiplank\b|\bhardie\b|\bfiber cement\b|\bcement siding\b/.test(text)) categories.add('fiber cement')
  if (/\bwood siding\b|\bcedar siding\b|\bclapboard\b/.test(text)) categories.add('wood siding')
  if (/\bstucco\b/.test(text)) categories.add('stucco')
  if (/\bstone\b/.test(text)) categories.add('stone')
  if (categories.size >= 2) return 'mixed'
  return [...categories][0] ?? null
}

function foundationCategory(value?: string | null): string | null {
  const cleaned = cleanText(value)
  if (!cleaned) return null
  const text = comparableText(cleaned)
  if (/\bslab\b/.test(text)) return 'slab'
  if (/\bcrawl\s*space\b|\bcrawlspace\b/.test(text)) return 'crawl space'
  if (/\bbasement\b|\bdaylight\b/.test(text)) return 'basement'
  if (/\bpier\b|\bpost and beam\b/.test(text)) return 'pier'
  return null
}

function garageCategory(value?: string | null): string | null {
  const cleaned = cleanText(value)
  if (!cleaned) return null
  const text = comparableText(cleaned)
  const kind = /\bcarport\b/.test(text) ? 'carport' : /\bgarage\b/.test(text) ? 'garage' : null
  if (kind) {
    const numeric = text.match(/\b(\d+)\s*(?:car|space)s?\b/)?.[1]
      ?? text.match(/\b(\d+)\s+total\s+spaces?\b/)?.[1]
    const wordCount = /\b(?:one|single)\s*(?:car|space)\b/.test(text) ? 1
      : /\btwo\s*(?:car|space)\b/.test(text) ? 2
        : /\bthree\s*(?:car|space)\b/.test(text) ? 3
          : null
    const count = numeric ? Number(numeric) : wordCount
    return count != null ? `${count}-car ${kind}` : null
  }
  if (/\bdriveway\b|\bparking pad\b|\bon street\b|\bopen parking\b|\boff street\b/.test(text)) return 'none'
  return null
}

type Categorized<T extends PhysicalCharacteristicValue> = {
  source: PhysicalCharacteristicSource
  raw: PhysicalCharacteristicValue
  category: T
}

function collect<T extends PhysicalCharacteristicValue>(
  inputs: PhysicalCharacteristicInputs,
  field: keyof PhysicalCharacteristicSourceData,
  categorize: (value: never) => T | null,
): Categorized<T>[] {
  const values: Categorized<T>[] = []
  for (const source of SOURCE_ORDER) {
    const raw = inputs[source]?.[field]
    const category = categorize(raw as never)
    if (raw != null && category != null) values.push({ source, raw, category })
  }
  return values
}

function resolveField<T extends PhysicalCharacteristicValue>(
  values: Categorized<T>[],
  agrees: (a: T, b: T) => boolean = (a, b) => a === b,
): PhysicalCharacteristic<T> {
  const sources = values.map(({ source, raw }) => ({ source, value: raw }))
  if (values.length === 0) return { value: null, status: 'unverified', sources }
  const [first, ...rest] = values
  if (rest.every((candidate) => agrees(first.category, candidate.category))) {
    return { value: first.category, status: 'verified', sources }
  }
  return { value: null, status: 'conflict', sources }
}

export function resolvePhysicalCharacteristics(inputs: PhysicalCharacteristicInputs): PhysicalCharacteristics {
  return {
    style: resolveField(collect(inputs, 'style', styleCategory as (value: never) => string | null)),
    stories: resolveField(
      collect(inputs, 'stories', storiesCategory as (value: never) => number | null),
      (a, b) => Math.abs(a - b) <= 0.5,
    ),
    constructionType: resolveField(collect(inputs, 'constructionType', constructionTypeCategory as (value: never) => string | null)),
    exterior: resolveField(collect(inputs, 'exterior', exteriorCategory as (value: never) => string | null)),
    roof: resolveField(collect(inputs, 'roof', roofCategory as (value: never) => string | null)),
    foundation: resolveField(collect(inputs, 'foundation', foundationCategory as (value: never) => string | null)),
    garage: resolveField(collect(inputs, 'garage', garageCategory as (value: never) => string | null)),
    pool: resolveField(collect(
      inputs,
      'pool',
      ((value: boolean | null | undefined) => typeof value === 'boolean' ? value : null) as (value: never) => boolean | null,
    )),
  }
}
