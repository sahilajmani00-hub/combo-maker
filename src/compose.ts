/** Layout maths + canvas rendering for one combo image. */

import type { PreparedImage } from './imageprep.ts'

export type ComboSize = 2 | 3 | 4
export type LayoutId = 'row' | 'stack' | 'grid' | 'feature' | 'filled'
export type RatioId = 'square' | 'portrait45' | 'portrait34'
export type AlignId = 'center' | 'bottom'

export type Rect = { x: number; y: number; width: number; height: number }

/**
 * How one product photo sits inside its cell, on top of the shared layout.
 *
 * A photo keeps the same framing in every combo it appears in, so a model shot
 * that lands badly cropped is corrected once rather than per combo.
 *
 * `zoom` multiplies whatever scale the layout already chose and `rotate` turns
 * the photo in degrees. `x` and `y` run from -1 to 1 as a fraction of the slack
 * — the gap between the photo's footprint and its cell, whichever is larger —
 * so the ends of the sliders are always the furthest the photo can move and
 * still have something to show.
 */
export type Framing = { zoom: number; rotate: number; x: number; y: number }

export const DEFAULT_FRAMING: Framing = { zoom: 1, rotate: 0, x: 0, y: 0 }

export const isFramed = (framing: Framing) =>
  framing.zoom !== 1 || framing.rotate !== 0 || framing.x !== 0 || framing.y !== 0

export type ComposeImage = PreparedImage & { framing?: Framing }

/**
 * A turned photo is measured by the upright box it sweeps out, not by its own
 * edges, so every fit and every limit below is written in terms of `cos`/`sin`.
 * At zero degrees they are 1 and 0, which collapses each formula back to the
 * plain one it generalises.
 */
function turn(framing: Framing) {
  const radians = framing.rotate * Math.PI / 180
  return { radians, cos: Math.abs(Math.cos(radians)), sin: Math.abs(Math.sin(radians)) }
}

const spread = (width: number, height: number, cos: number, sin: number) => width * cos + height * sin

/** Largest the photo can be drawn with its turned footprint still inside the cell. */
function containScale(shape: { width: number; height: number }, cell: Rect, cos: number, sin: number) {
  return Math.min(
    cell.width / spread(shape.width, shape.height, cos, sin),
    cell.height / spread(shape.height, shape.width, cos, sin),
  )
}

/** Smallest the photo can be drawn while still covering every corner of the cell. */
function coverScale(image: { width: number; height: number }, cell: Rect, cos: number, sin: number) {
  return Math.max(
    spread(cell.width, cell.height, cos, sin) / image.width,
    spread(cell.height, cell.width, cos, sin) / image.height,
  )
}

/** The cell's centre, slid by the share of the slack the framing asks for. */
function centre(start: number, cellSize: number, footprint: number, offset: number) {
  return start + cellSize / 2 + offset * Math.abs(cellSize - footprint) / 2
}

export type ComposeOptions = {
  size: ComboSize
  layout: LayoutId
  ratio: RatioId
  background: string
  /** Outer margin, as a fraction of the canvas width. */
  padding: number
  /** Space between cells, as a fraction of the canvas width. */
  gap: number
  /** Scale every product by the same factor so none looks oversized. */
  uniformScale: boolean
  align: AlignId
}

export const RATIOS: Record<RatioId, { width: number; height: number; label: string }> = {
  square: { width: 1200, height: 1200, label: '1:1 · 1200 × 1200' },
  portrait45: { width: 1200, height: 1500, label: '4:5 · 1200 × 1500' },
  portrait34: { width: 1200, height: 1600, label: '3:4 · 1200 × 1600' },
}

export const LAYOUTS: Record<ComboSize, { id: LayoutId; label: string }[]> = {
  2: [
    { id: 'filled', label: 'Filled grid' },
    { id: 'row', label: 'Side by side' },
    { id: 'stack', label: 'Stacked' },
  ],
  3: [
    { id: 'filled', label: 'Filled grid' },
    { id: 'row', label: '3 across' },
    { id: 'feature', label: '1 big + 2' },
    { id: 'stack', label: 'Stacked' },
  ],
  4: [
    { id: 'filled', label: 'Filled grid' },
    { id: 'grid', label: '2 × 2 grid' },
    { id: 'row', label: '4 across' },
    { id: 'feature', label: '1 big + 3' },
  ],
}

/**
 * The filled grid ignores margin, gap, trim and size-matching.
 *
 * Those exist to stop cut-out products floating at odd sizes, which is the
 * wrong problem here: every cell is covered edge to edge by its photo, so
 * there is no empty space left for them to act on.
 */
export const isFilled = (layout: LayoutId) => layout === 'filled'

/**
 * Equal cells covering the whole canvas, no gaps.
 *
 * Two sits side by side, four is the obvious 2x2, and three takes the classic
 * collage shape — one tall cell with two stacked beside it — because three
 * equal columns on a square canvas crops each photo to a sliver.
 */
function filledCells(size: ComboSize, area: Rect): Rect[] {
  const { x, y, width, height } = area
  if (size === 2) {
    const half = width / 2
    return [
      { x, y, width: half, height },
      { x: x + half, y, width: half, height },
    ]
  }
  if (size === 3) {
    const half = width / 2
    const quarter = height / 2
    return [
      { x, y, width: half, height },
      { x: x + half, y, width: half, height: quarter },
      { x: x + half, y: y + quarter, width: half, height: quarter },
    ]
  }
  const half = width / 2
  const middle = height / 2
  return [
    { x, y, width: half, height: middle },
    { x: x + half, y, width: half, height: middle },
    { x, y: y + middle, width: half, height: middle },
    { x: x + half, y: y + middle, width: half, height: middle },
  ]
}

export function layoutLabel(size: ComboSize, layout: LayoutId): string {
  return LAYOUTS[size].find((option) => option.id === layout)?.label ?? 'Custom'
}

/** Falls back to the first valid layout when a size change orphans the choice. */
export function normalizeLayout(size: ComboSize, layout: LayoutId): LayoutId {
  return LAYOUTS[size].some((option) => option.id === layout) ? layout : LAYOUTS[size][0].id
}

/**
 * Cell rectangles inside the padded content area, in pixels.
 * `feature` gives the first product the hero slot and stacks the rest beside
 * or beneath it.
 */
export function cellRects(size: ComboSize, layout: LayoutId, area: Rect, gap: number): Rect[] {
  const { x, y, width, height } = area

  const gridCells = (columns: number, rows: number, count: number): Rect[] => {
    const cellWidth = (width - gap * (columns - 1)) / columns
    const cellHeight = (height - gap * (rows - 1)) / rows
    const rects: Rect[] = []
    for (let index = 0; index < count; index++) {
      const column = index % columns
      const row = Math.floor(index / columns)
      rects.push({
        x: x + column * (cellWidth + gap),
        y: y + row * (cellHeight + gap),
        width: cellWidth,
        height: cellHeight,
      })
    }
    return rects
  }

  if (layout === 'filled') return filledCells(size, area)
  if (layout === 'row') return gridCells(size, 1, size)
  if (layout === 'stack') return gridCells(1, size, size)
  if (layout === 'grid') return gridCells(2, 2, size)

  // feature: hero + remainder
  const rest = size - 1
  if (size === 3) {
    // Hero on the left at 58% width, two stacked on the right.
    const heroWidth = (width - gap) * 0.58
    const sideWidth = width - gap - heroWidth
    const sideHeight = (height - gap) / 2
    return [
      { x, y, width: heroWidth, height },
      { x: x + heroWidth + gap, y, width: sideWidth, height: sideHeight },
      { x: x + heroWidth + gap, y: y + sideHeight + gap, width: sideWidth, height: sideHeight },
    ]
  }
  // size 4 — hero across the top at 58% height, three beneath it.
  const heroHeight = (height - gap) * 0.58
  const stripHeight = height - gap - heroHeight
  const stripWidth = (width - gap * (rest - 1)) / rest
  const rects: Rect[] = [{ x, y, width, height: heroHeight }]
  for (let index = 0; index < rest; index++) {
    rects.push({
      x: x + index * (stripWidth + gap),
      y: y + heroHeight + gap,
      width: stripWidth,
      height: stripHeight,
    })
  }
  return rects
}

export function composeCombo(images: ComposeImage[], options: ComposeOptions): HTMLCanvasElement {
  const { width, height } = RATIOS[options.ratio]
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  if (options.background !== 'transparent') {
    ctx.fillStyle = options.background
    ctx.fillRect(0, 0, width, height)
  }

  const filled = isFilled(options.layout)
  const padding = filled ? 0 : width * options.padding
  const gap = filled ? 0 : width * options.gap
  const area: Rect = {
    x: padding,
    y: padding,
    width: width - padding * 2,
    height: height - padding * 2,
  }
  const cells = cellRects(options.size, options.layout, area, gap)

  if (filled) {
    // Cover, not contain: scale by the larger ratio so the cell is completely
    // covered, then centre and let the overflow crop.
    images.forEach((image, index) => {
      const cell = cells[index]
      if (!cell) return
      const framing = image.framing ?? DEFAULT_FRAMING
      const { radians, cos, sin } = turn(framing)
      const scale = coverScale(image, cell, cos, sin) * framing.zoom
      const drawWidth = image.width * scale
      const drawHeight = image.height * scale
      ctx.save()
      ctx.beginPath()
      ctx.rect(cell.x, cell.y, cell.width, cell.height)
      ctx.clip()
      ctx.translate(
        centre(cell.x, cell.width, spread(drawWidth, drawHeight, cos, sin), framing.x),
        centre(cell.y, cell.height, spread(drawHeight, drawWidth, cos, sin), framing.y),
      )
      ctx.rotate(radians)
      ctx.drawImage(image.canvas, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
      ctx.restore()
    })
    return canvas
  }

  /**
   * Normalised shapes, so "match sizes" compares products and not megapixels.
   *
   * Scaling every image by one factor derived from raw pixels means a 2048px
   * photo and a 700px photo of the same earring are treated as wildly
   * different sizes: the common factor collapses to the big file's, and the
   * small one renders at a third of its cell surrounded by empty space. Sizing
   * each image relative to its own longest edge removes the source resolution
   * from the comparison, leaving only the shape difference it was meant to fix.
   */
  const shapes = images.map((image) => {
    const longest = Math.max(image.width, image.height) || 1
    return { width: image.width / longest, height: image.height / longest }
  })

  // Fit scale per cell, then optionally flatten to the smallest so every
  // product is reduced by the same amount and reads at a consistent size.
  // Measured upright, so turning one product cannot resize all the others.
  const fitScales = shapes.map((shape, index) => containScale(shape, cells[index], 1, 0))
  const uniform = Math.min(...fitScales)

  images.forEach((image, index) => {
    const cell = cells[index]
    const shape = shapes[index]
    const framing = image.framing ?? DEFAULT_FRAMING
    const { radians, cos, sin } = turn(framing)
    // Turning a product widens its footprint, so it gives up whatever size it
    // needs to stay inside its own cell rather than spilling into its neighbour.
    const fit = Math.min(options.uniformScale ? uniform : fitScales[index], containScale(shape, cell, cos, sin))
    const drawWidth = shape.width * fit * framing.zoom
    const drawHeight = shape.height * fit * framing.zoom
    const footprintX = spread(drawWidth, drawHeight, cos, sin)
    const footprintY = spread(drawHeight, drawWidth, cos, sin)
    // A bottom-aligned product already sits on the baseline, so its vertical
    // slider only has room to lift it off.
    const centreY = options.align === 'bottom'
      ? cell.y + cell.height - footprintY / 2 + framing.y * Math.abs(cell.height - footprintY) / 2
      : centre(cell.y, cell.height, footprintY, framing.y)
    // Zooming past the fit scale is the only way a product can outgrow its
    // cell, and it must crop rather than crawl into the gap beside it.
    ctx.save()
    ctx.beginPath()
    ctx.rect(cell.x, cell.y, cell.width, cell.height)
    ctx.clip()
    ctx.translate(centre(cell.x, cell.width, footprintX, framing.x), centreY)
    ctx.rotate(radians)
    ctx.drawImage(image.canvas, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
    ctx.restore()
  })

  return canvas
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the combo image.'))),
      type,
      quality,
    )
  })
}
