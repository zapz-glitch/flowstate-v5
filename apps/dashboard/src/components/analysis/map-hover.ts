/**
 * Tiny channel between the map markers and the page: which comp the pointer
 * is resting on, and where. The page shows that comp beside the subject.
 */
export interface MarkerHover { compKey: string; x: number; y: number }

type Listener = (hover: MarkerHover | null) => void
const listeners = new Set<Listener>()

export function emitMarkerHover(hover: MarkerHover | null) {
  listeners.forEach((listener) => listener(hover))
}

export function onMarkerHover(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
