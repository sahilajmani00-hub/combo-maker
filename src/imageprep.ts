/**
 * Decodes uploaded files and (optionally) trims the dead border around a
 * product so combos align on the product itself, not on whatever padding the
 * photographer happened to leave in the frame.
 */

export type PreparedImage = {
  canvas: HTMLCanvasElement
  width: number
  height: number
}

/** Long edge of the working canvas. Output tops out at 1600px, so anything
 *  larger is wasted memory during trim detection. */
const MAX_WORKING_EDGE = 1600

/** Colour distance from the sampled background before a pixel counts as product. */
const TRIM_TOLERANCE = 18

/** Alpha below this is treated as empty. */
const ALPHA_FLOOR = 8

/** Keep a hair of breathing room so trimming never shaves an antialiased edge. */
const TRIM_MARGIN = 2

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.')
  return ctx
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      /* fall through to the <img> path for formats the bitmap decoder refuses */
    }
  }
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error(`Could not read ${file.name}.`))
      image.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Average the four corners; product shots almost always sit on a flat ground. */
function sampleBackground(data: Uint8ClampedArray, width: number, height: number) {
  const patch = 4
  let r = 0, g = 0, b = 0, a = 0, count = 0
  const corners = [[0, 0], [width - patch, 0], [0, height - patch], [width - patch, height - patch]]
  for (const [cx, cy] of corners) {
    for (let y = Math.max(0, cy); y < Math.min(height, cy + patch); y++) {
      for (let x = Math.max(0, cx); x < Math.min(width, cx + patch); x++) {
        const i = (y * width + x) * 4
        r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3]
        count++
      }
    }
  }
  return count ? { r: r / count, g: g / count, b: b / count, a: a / count } : { r: 255, g: 255, b: 255, a: 255 }
}

/** Bounding box of everything that is not background. Null when the scan finds nothing. */
function contentBounds(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const { data } = ctx.getImageData(0, 0, width, height)
  const bg = sampleBackground(data, width, height)
  const transparentBg = bg.a < ALPHA_FLOOR

  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const alpha = data[i + 3]
      if (alpha < ALPHA_FLOOR) continue
      if (!transparentBg) {
        const delta = Math.abs(data[i] - bg.r) + Math.abs(data[i + 1] - bg.g) + Math.abs(data[i + 2] - bg.b)
        if (delta <= TRIM_TOLERANCE) continue
      }
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < minX || maxY < minY) return null

  minX = Math.max(0, minX - TRIM_MARGIN)
  minY = Math.max(0, minY - TRIM_MARGIN)
  maxX = Math.min(width - 1, maxX + TRIM_MARGIN)
  maxY = Math.min(height - 1, maxY + TRIM_MARGIN)

  const box = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
  // A near-empty box means the scan misread the background; keep the original.
  if (box.width * box.height < width * height * 0.02) return null
  return box
}

export async function prepareImage(file: File, trim: boolean): Promise<PreparedImage> {
  const source = await decode(file)
  const sourceWidth = 'naturalWidth' in source ? source.naturalWidth : source.width
  const sourceHeight = 'naturalHeight' in source ? source.naturalHeight : source.height
  if (!sourceWidth || !sourceHeight) throw new Error(`${file.name} has no readable dimensions.`)

  const scale = Math.min(1, MAX_WORKING_EDGE / Math.max(sourceWidth, sourceHeight))
  const working = makeCanvas(sourceWidth * scale, sourceHeight * scale)
  const ctx = context2d(working)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, working.width, working.height)
  if ('close' in source) source.close()

  if (!trim) return { canvas: working, width: working.width, height: working.height }

  const box = contentBounds(ctx, working.width, working.height)
  if (!box) return { canvas: working, width: working.width, height: working.height }

  const cropped = makeCanvas(box.width, box.height)
  context2d(cropped).drawImage(working, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height)
  return { canvas: cropped, width: cropped.width, height: cropped.height }
}
