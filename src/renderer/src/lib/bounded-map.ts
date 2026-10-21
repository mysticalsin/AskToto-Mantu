/** Deletes the oldest-inserted entries until `map` holds at most `max` (a Map iterates in insertion order). */
export function evictOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next()
    if (oldest.done) return
    map.delete(oldest.value)
  }
}
