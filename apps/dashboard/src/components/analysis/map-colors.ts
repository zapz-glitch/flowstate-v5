/**
 * Map marker colors · one definition for the legend, the flat map and the 3D map.
 * Included is the green of the comp card's ARV checkbox (emerald-600); Excluded is a light
 * silver with a dark number so it still reads on satellite imagery.
 */
export const MAP_COLORS = {
  subject: '#3b82f6',
  included: '#059669',
  excluded: '#cbd0d6',
  active: '#f59e0b',
} as const

/** The number inside a marker dot · dark on the light silver, white on everything else */
export const markerNumberColor = (type: string) => (type === 'comp-disabled' ? '#171717' : '#ffffff')
