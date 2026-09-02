/**
 * Decides which products end up in which combo.
 *
 * Three modes, because "make combos of 4 from these photos" has several
 * sensible readings and sellers want different ones at different times.
 */

export type GroupMode = 'combinations' | 'repeats' | 'sequential'

/** C(poolSize, choose) — exact for any pool this tool accepts. */
export function countCombinations(poolSize: number, choose: number): number {
  if (choose <= 0 || poolSize < choose) return 0
  let result = 1
  for (let step = 0; step < choose; step++) {
    result = (result * (poolSize - step)) / (step + 1)
  }
  return Math.round(result)
}

/**
 * Every non-decreasing run of `choose` indices — i.e. combinations *with*
 * repetition, so A+A+B+C is offered and counts as the same combo as C+B+A+A.
 * Yields C(poolSize + choose - 1, choose) sets.
 */
function* multisetIndices(poolSize: number, choose: number) {
  const indices = new Array<number>(choose).fill(0)
  while (true) {
    yield indices
    let cursor = choose - 1
    while (cursor >= 0 && indices[cursor] === poolSize - 1) cursor -= 1
    if (cursor < 0) return
    const next = indices[cursor] + 1
    for (let position = cursor; position < choose; position++) indices[position] = next
  }
}

/** Every unique set of `choose` indices, in lexicographic order. */
function* combinationIndices(poolSize: number, choose: number) {
  const indices = Array.from({ length: choose }, (_, position) => position)
  while (true) {
    yield indices
    let cursor = choose - 1
    while (cursor >= 0 && indices[cursor] === poolSize - choose + cursor) cursor -= 1
    if (cursor < 0) return
    indices[cursor] += 1
    for (let next = cursor + 1; next < choose; next++) indices[next] = indices[next - 1] + 1
  }
}

/** Fewest images this mode needs before it can build anything. */
export function minimumImages(size: number, mode: GroupMode): number {
  // With repetition one product is enough: A+A+A+A is a valid combo.
  return mode === 'repeats' ? 1 : size
}

/** Total combos this mode would produce, ignoring the cap. */
export function countGroups(poolSize: number, size: number, mode: GroupMode): number {
  if (poolSize < minimumImages(size, mode)) return 0
  if (mode === 'combinations') return countCombinations(poolSize, size)
  if (mode === 'repeats') return countCombinations(poolSize + size - 1, size)
  return Math.floor(poolSize / size)
}

/**
 * `combinations` — every unique set of `size` products (5 photos, sets of 4 -> 5 combos).
 * `repeats`      — same, but a product may appear more than once in a combo
 *                  (6 photos, sets of 4 -> 126 combos).
 * `sequential`   — consecutive chunks; a remainder too small to fill a set is left out.
 *
 * There is no cap: 20 photos in fours is 4,845 combos and that is the caller's
 * business, not this function's. `limit` is still there for anyone who wants
 * one — the browser passes none.
 */
export function buildGroups<T>(items: T[], size: number, mode: GroupMode, limit = Infinity): T[][] {
  if (size <= 0 || items.length < minimumImages(size, mode)) return []

  if (mode === 'sequential') {
    const groups: T[][] = []
    for (let index = 0; index + size <= items.length; index += size) {
      groups.push(items.slice(index, index + size))
    }
    return groups
  }

  const groups: T[][] = []
  const sets = mode === 'repeats'
    ? multisetIndices(items.length, size)
    : combinationIndices(items.length, size)
  for (const indices of sets) {
    // The generator reuses its index array, so copy before mapping out.
    groups.push(indices.map((index) => items[index]))
    if (groups.length >= limit) break
  }
  return groups
}
