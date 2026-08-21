/** Layout maths + canvas rendering for one combo image. */

import type { PreparedImage } from './imageprep.ts'

export type ComboSize = 2 | 3 | 4
export type LayoutId = 'row' | 'stack' | 'grid' | 'feature'
export type RatioId = 'square' | 'portrait45' | 'portrait34'
export type AlignId = 'center' | 'bottom'

export type Rect = { x: number; y: number; width: number; height: number }

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
    { id: 'row', label: 'Side by side' },
    { id: 'stack', label: 'Stacked' },
  ],
  3: [
    { id: 'row', label: '3 across' },
    { id: 'feature', label: '1 big + 2' },
    { id: 'stack', label: 'Stacked' },
  ],
  4: [
    { id: 'grid', label: '2 × 2 grid' },
    { id: 'row', label: '4 across' },
    { id: 'feature', label: '1 big + 3' },
  ],
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

export function composeCombo(images: PreparedImage[], options: ComposeOptions): HTMLCanvasElement {
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

  const padding = width * options.padding
  const gap = width * options.gap
  const area: Rect = {
    x: padding,
    y: padding,
    width: width - padding * 2,
    height: height - padding * 2,
  }
  const cells = cellRects(options.size, options.layout, area, gap)

  // Fit scale per cell, then optionally flatten to the smallest so every
  // product is reduced by the same amount and reads at a consistent size.
  const fitScales = images.map((image, index) => {
    const cell = cells[index]
    return Math.min(cell.width / image.width, cell.height / image.height)
  })
  const uniform = Math.min(...fitScales)

  images.forEach((image, index) => {
    const cell = cells[index]
    const scale = options.uniformScale ? uniform : fitScales[index]
    const drawWidth = image.width * scale
    const drawHeight = image.height * scale
    const drawX = cell.x + (cell.width - drawWidth) / 2
    const drawY = options.align === 'bottom'
      ? cell.y + cell.height - drawHeight
      : cell.y + (cell.height - drawHeight) / 2
    ctx.drawImage(image.canvas, drawX, drawY, drawWidth, drawHeight)
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
