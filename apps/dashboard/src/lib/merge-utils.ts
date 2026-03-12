/**
 * Deep-merge utilities for accumulating step data on the dashboard.
 *
 * When merging arrays of objects that have an `id` field (e.g., comps.items),
 * items are merged by matching on `id` rather than by array index.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mergeArrayById(target: any[], source: any[]): any[] {
  if (target.length === 0) return [...source]

  const result = [...target]
  for (const sourceItem of source) {
    if (isPlainObject(sourceItem) && 'id' in sourceItem) {
      const idx = result.findIndex(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (t: any) => isPlainObject(t) && 'id' in t && t.id === sourceItem.id
      )
      if (idx >= 0) {
        result[idx] = deepMergePartial(result[idx], sourceItem)
      } else {
        result.push(sourceItem)
      }
    } else {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  source: Record<string, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  const result = { ...target }

  for (const key of Object.keys(source)) {
    const sourceVal = source[key]
    const targetVal = result[key]

    if (key === 'items' && Array.isArray(sourceVal) && Array.isArray(targetVal)) {
      result[key] = mergeArrayById(targetVal, sourceVal)
    } else if (isPlainObject(sourceVal) && isPlainObject(targetVal)) {
      result[key] = deepMergePartial(targetVal, sourceVal)
    } else {
      result[key] = sourceVal
    }
  }

  return result
}
