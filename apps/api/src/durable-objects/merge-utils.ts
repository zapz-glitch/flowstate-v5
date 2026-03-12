/**
 * Deep-merge utilities for accumulating step data in Durable Objects.
 *
 * When merging arrays of objects that have an `id` field (e.g., comps.items),
 * items are merged by matching on `id` rather than by array index.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeArrayById(target: unknown[], source: unknown[]): unknown[] {
  if (target.length === 0) return [...source]

  const result = [...target]
  for (const sourceItem of source) {
    if (isPlainObject(sourceItem) && 'id' in sourceItem) {
      const idx = result.findIndex(
        (t) => isPlainObject(t) && 'id' in t && (t as Record<string, unknown>).id === sourceItem.id
      )
      if (idx >= 0) {
        result[idx] = deepMergePartial(
          result[idx] as Record<string, unknown>,
          sourceItem as Record<string, unknown>
        )
      } else {
        result.push(sourceItem)
      }
    } else {
      // Non-object array items — just append if not already present
      if (!result.includes(sourceItem)) {
        result.push(sourceItem)
      }
    }
  }
  return result
}

/**
 * Deep-merges `source` into `target`, returning a new object.
 * - Plain objects are recursively merged
 * - Arrays named `items` with objects having `id` fields are merged by id
 * - All other values from source overwrite target
 */
export function deepMergePartial(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target }

  for (const key of Object.keys(source)) {
    const sourceVal = source[key]
    const targetVal = result[key]

    if (key === 'items' && Array.isArray(sourceVal) && Array.isArray(targetVal)) {
      result[key] = mergeArrayById(targetVal, sourceVal)
    } else if (isPlainObject(sourceVal) && isPlainObject(targetVal)) {
      result[key] = deepMergePartial(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      )
    } else {
      result[key] = sourceVal
    }
  }

  return result
}
