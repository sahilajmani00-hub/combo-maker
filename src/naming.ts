/**
 * Combo filenames are built from the source images that went into them, so a
 * combo of earring1 + earring2 + earring3 saves as "earring1&earring2&earring3".
 */

/** Punctuation Windows/macOS reject in a filename. `&`, spaces and `-` are fine. */
const ILLEGAL = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])

/** Leaves room for the download folder path inside the 260-char Windows limit. */
const MAX_BASE_LENGTH = 150

/** Never shorten a product's name below this, even in a crowded combo. */
const MIN_PART_LENGTH = 8

/**
 * Image extensions anywhere they trail a name segment.
 *
 * CDN downloads arrive as "H9cb...bbJ.jpg_720x720q50.jpg" — stripping only the
 * final extension would leave a stray ".jpg" sitting in the middle.
 */
const IMAGE_EXTENSION = /\.(jpe?g|png|webp|avif|gif|bmp|tiff?)(?=$|[^a-z0-9])/gi

/**
 * Trailing CDN resize suffix, e.g. "_720x720q50" on supplier downloads.
 * Both dimensions need two digits or more so a real "_2x2" name survives.
 */
const CDN_SIZE_SUFFIX = /_\d{2,}x\d{2,}(q\d+)?$/i

/** Drop the extension and anything the filesystem would refuse. */
function stem(fileName: string): string {
  const withoutExtension = fileName.replace(IMAGE_EXTENSION, '').replace(CDN_SIZE_SUFFIX, '')
  const cleaned = Array.from(withoutExtension)
    .filter((char) => !ILLEGAL.has(char) && char >= ' ')
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'image'
}

/**
 * Joins the source names with `&`.
 *
 * `used` carries the names already issued in this run so repeated uploads
 * can't produce two files fighting over one name.
 */
export function comboName(fileNames: string[], extension: string, used: Set<string>): string {
  // A combo may hold the same product more than once when repeats are allowed;
  // "earring1x3&earring2" beats spelling earring1 out three times.
  const parts: string[] = []
  const counts: number[] = []
  for (const part of fileNames.map(stem)) {
    if (parts.length && parts[parts.length - 1] === part) counts[counts.length - 1] += 1
    else {
      parts.push(part)
      counts.push(1)
    }
  }

  const label = (index: number) => (counts[index] > 1 ? `${parts[index]}x${counts[index]}` : parts[index])
  let base = parts.map((_, index) => label(index)).join('&')

  if (base.length > MAX_BASE_LENGTH) {
    // Shorten every part instead of truncating the whole string, which would
    // drop the last products out of the name entirely.
    const budget = Math.max(
      MIN_PART_LENGTH,
      Math.floor((MAX_BASE_LENGTH - (parts.length - 1)) / parts.length),
    )
    base = parts
      .map((part, index) => {
        const suffix = counts[index] > 1 ? `x${counts[index]}` : ''
        return part.slice(0, Math.max(MIN_PART_LENGTH, budget - suffix.length)) + suffix
      })
      .join('&')
    // MIN_PART_LENGTH can still overshoot on a very large combo.
    if (base.length > MAX_BASE_LENGTH) base = base.slice(0, MAX_BASE_LENGTH).replace(/&+$/, '')
  }
  // Windows silently strips a trailing dot or space, which would break the match.
  base = base.replace(/[. ]+$/, '') || 'combo'

  let candidate = `${base}.${extension}`
  let counter = 2
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}-${counter}.${extension}`
    counter += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}
