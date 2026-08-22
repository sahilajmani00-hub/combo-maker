/**
 * Camera angles for the AI section.
 *
 * The local canvas section arranges the *actual* photos, so it can only ever
 * show each product from the angle it was shot at. The AI section re-shoots the
 * combo instead: one generation per angle, which is where the variety comes
 * from. Each angle contributes a camera description to the prompt and a short
 * tag used in the saved filename.
 */

export type AngleId =
  | 'front'
  | 'three-quarter'
  | 'three-quarter-right'
  | 'side'
  | 'top-down'
  | 'macro'
  | 'low-hero'
  | 'tilted-tray'

export type Angle = {
  id: AngleId
  label: string
  /** Filename suffix — kept short so long combo names stay under the path limit. */
  tag: string
  /** The camera clause dropped into the prompt. */
  camera: string
}

export const ANGLES: Angle[] = [
  {
    id: 'front',
    label: 'Straight on',
    tag: 'front',
    camera: 'a straight-on eye-level front view, products facing the camera square to the lens',
  },
  {
    id: 'three-quarter',
    label: '3/4 left',
    tag: '34-left',
    camera: 'a three-quarter view with the camera rotated roughly 45 degrees to the left and raised slightly above the products',
  },
  {
    id: 'three-quarter-right',
    label: '3/4 right',
    tag: '34-right',
    camera: 'a three-quarter view with the camera rotated roughly 45 degrees to the right and raised slightly above the products',
  },
  {
    id: 'side',
    label: 'Side profile',
    tag: 'side',
    camera: 'a side profile view at eye level, products seen edge-on so their depth and thickness read clearly',
  },
  {
    id: 'top-down',
    label: 'Top-down flat lay',
    tag: 'top',
    camera: 'a top-down flat-lay directly overhead at 90 degrees, products laid flat on the surface',
  },
  {
    id: 'macro',
    label: 'Macro detail',
    tag: 'macro',
    camera: 'a tight macro close-up filling the frame, shallow depth of field, fine texture and craftsmanship detail in sharp focus',
  },
  {
    id: 'low-hero',
    label: 'Low hero angle',
    tag: 'low',
    camera: 'a low hero angle just beneath the products looking slightly upward, so they stand tall in frame',
  },
  {
    id: 'tilted-tray',
    label: 'Angled from above',
    tag: 'angled',
    camera: 'an elevated 30 degree angle looking down onto the products resting on a soft matte surface',
  },
]

export const DEFAULT_ANGLES: AngleId[] = ['front', 'three-quarter', 'top-down', 'macro']

export function angleById(id: AngleId): Angle {
  return ANGLES.find((angle) => angle.id === id) ?? ANGLES[0]
}

/**
 * The backdrop is picked by the model rather than named, so it can suit the
 * piece in front of it — a fringed chandelier earring and a plain stud want
 * very different surfaces, and only the model can see which it has.
 */
export const AUTO_BACKGROUND = 'auto'

/** Backdrops phrased the way the model reads them, not as hex colours. */
export const AI_BACKGROUNDS = [
  { id: 'clean seamless white', label: 'White' },
  { id: AUTO_BACKGROUND, label: 'Classy (auto)' },
  { id: 'soft ivory paper', label: 'Ivory' },
  { id: 'warm beige studio', label: 'Beige' },
  { id: 'light grey seamless', label: 'Grey' },
  { id: 'matte black', label: 'Black' },
  { id: 'natural linen fabric', label: 'Linen' },
  { id: 'polished marble', label: 'Marble' },
  { id: 'softly draped silk', label: 'Silk' },
  { id: 'deep velvet cushion', label: 'Velvet' },
  { id: 'brushed travertine stone slab', label: 'Stone' },
  { id: 'polished dark walnut tray', label: 'Walnut' },
]

export type PromptOptions = {
  /** What the products are, e.g. "earrings". Drives how the model treats them. */
  subject: string
  /** How many products are in this combo. */
  count: number
  angle: Angle
  background: string
  /** Anything the user typed to add on the end. */
  extra: string
  /**
   * One short description per product in this combo, when they have been
   * described. Naming the products is what stops the model quietly swapping a
   * brushed-gold hoop for a silver stud.
   */
  products: string[]
  /**
   * True when the model gets one composited picture of the whole combo rather
   * than the products as separate references — it has to be told that the one
   * image it can see holds several products, or it treats them as one object.
   */
  composite: boolean
}

/**
 * The prompt leans hard on "do not redesign" language because the failure mode
 * that matters here is the model inventing a fourth earring or restyling one of
 * the three it was given — a pretty picture of the wrong products is worthless
 * to a seller.
 */
export function buildPrompt({ subject, count, angle, background, extra, composite, products }: PromptOptions): string {
  const item = subject.trim() || 'products'
  const source = composite
    ? `The reference image is a flat layout of ${count} separate ${item}. Re-photograph all ${count} of them together in one frame as real objects.`
    : `The ${count} reference images are ${count} separate ${item}. Photograph all ${count} of them together in one frame.`
  const described = products.map((text) => text.trim()).filter(Boolean)
  // "Classy (auto)" hands the choice over instead of naming a surface, with
  // enough of a brief that it stays a product shot rather than a still life.
  const backdrop = background === AUTO_BACKGROUND
    ? `Style the set on an elegant editorial backdrop chosen to suit these particular pieces — a refined surface such as draped silk, velvet, brushed stone, fine linen or polished wood, in a tone that flatters the jewellery and keeps it the clear subject. Arrange them with even spacing and consistent scale, soft diffused studio lighting, subtle contact shadows, sharp focus across the whole frame, high detail, luxury commercial quality.`
    : `Arrange them with even spacing and consistent scale on a ${background} backdrop, soft diffused studio lighting, subtle contact shadows, sharp focus across the whole frame, high detail, commercial e-commerce quality.`
  const lines = [
    `Professional studio product photograph showing exactly ${count} ${item} together in one frame.`,
    source,
  ]
  if (described.length) {
    lines.push(`Shapes only, for identification — colours come from the image: ${described.map((text, index) => `(${index + 1}) ${text}`).join('; ')}.`)
  }
  lines.push(
    `Camera: ${angle.camera}.`,
    `Take the exact colour, metal tone, plating, stone colour and finish of every product from the reference image — match what you see there precisely, and never infer them from this text. Shape, texture and proportions must match the reference too. Do not redesign, recolour, merge or duplicate any product, and do not add a product that is not in the reference.`,
    backdrop,
    `No text, no logos, no watermarks, no hands, no people.`,
  )
  if (extra.trim()) lines.push(extra.trim())
  return lines.join('\n')
}
