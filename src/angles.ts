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

/** The slot an AI-written prompt leaves for this combo's own products. */
export const PRODUCTS_TOKEN = '{{PRODUCTS}}'

/**
 * Drops one combo's products into a prompt the model wrote for this angle.
 *
 * The prompt is written once per angle and reused across every combo, so this
 * is the only part that varies — and when nothing has been described it still
 * has to read as a sentence, hence the fallback wording.
 */
export function fillProducts(template: string, products: string[], count: number, subject: string): string {
  const described = products.map((text) => text.trim()).filter(Boolean)
  const item = subject.trim() || 'products'
  const filled = described.length
    ? `Shapes only, for identification — colours come from the image: ${described.map((text, index) => `(${index + 1}) ${text}`).join('; ')}.`
    : `The frame holds ${count} separate ${item}, exactly as shown in the reference image.`
  return template.split(PRODUCTS_TOKEN).join(filled)
}

export function angleById(id: AngleId): Angle {
  return ANGLES.find((angle) => angle.id === id) ?? ANGLES[0]
}

/**
 * The backdrop is picked by the model rather than named, so it can suit the
 * piece in front of it — a fringed chandelier earring and a plain stud want
 * very different surfaces, and only the model can see which it has.
 */
export const AUTO_BACKGROUND = 'auto'

/** Plain white — what most marketplaces require of a listing's first image. */
export const WHITE_BACKDROP = 'clean seamless white'

/** Every combo gets a different surface from SCENE_BACKDROPS. */
export const MIXED_BACKGROUND = 'mixed'

/**
 * Real surfaces a product would actually be photographed on.
 *
 * Deliberately coloured and textured: a flat white sweep is what makes a set
 * look like clip-art, and the whole point of re-shooting is that the result
 * should read as a photograph of an object sitting somewhere.
 */
export const SCENE_BACKDROPS = [
  'a warm sand-toned plaster surface with soft natural texture',
  'a deep charcoal slate slab with a matte, faintly uneven finish',
  'a muted sage-green painted wood surface with fine grain',
  'a dusty terracotta clay surface with a chalky matte bloom',
  'a soft dove-grey polished concrete slab with fine aggregate speckle',
  'a warm oatmeal linen cloth falling in gentle folds',
  'a deep burgundy velvet surface with soft directional pile',
  'a pale champagne satin drape with shallow rippling highlights',
  'a smoky blue-grey stone slab with subtle mineral veining',
  'a warm walnut wood surface with open visible grain',
]

/**
 * Which surface this combo sits on.
 *
 * Cycling by index rather than at random keeps a run reproducible — rebuild the
 * same queue and combo 7 lands on the same surface it had before.
 */
export function backdropFor(background: string, comboIndex: number): string {
  if (background === MIXED_BACKGROUND) return SCENE_BACKDROPS[comboIndex % SCENE_BACKDROPS.length]
  return background
}

/** Backdrops phrased the way the model reads them, not as hex colours. */
export const AI_BACKGROUNDS = [
  { id: 'clean seamless white', label: 'White' },
  { id: MIXED_BACKGROUND, label: 'Mixed (varied)' },
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
  /**
   * The distinct-designs wording is the whole ballgame for jewellery.
   *
   * "2 earrings" reads to an image model as a pair — the left and right of one
   * design — which is exactly what it returns: one product photographed twice.
   * A combo is the opposite: several different designs sharing a frame, one
   * piece from each. It has to be stated outright and repeated as a negative,
   * or the pair reading wins every time.
   */
  const source = composite
    ? `The reference image is a flat working layout holding all ${count} products side by side. Re-photograph every one of them together in a single frame as real objects.`
    : `The ${count} reference images are ${count} different products, one per image. Photograph all ${count} of them together in a single frame.`
  const described = products.map((text) => text.trim()).filter(Boolean)
  const white = background === 'clean seamless white'

  /**
   * Without this the model copies the reference's flat white ground straight
   * into the result — it has no way to know that background was a layout aid
   * rather than part of the scene.
   */
  const ignoreReferenceGround = composite
    ? 'Its plain background is NOT the scene — it is a working layout only. Ignore that background completely and build the environment described below around the products.'
    : 'Their plain backgrounds are NOT the scene. Ignore them completely and build the environment described below around the products.'

  const realism = white
    ? 'Shoot it as a real photograph on a full-frame camera with an 85mm macro lens at f/5.6: true optics, natural depth-of-field falloff, believable specular highlights on metal and stones, soft-edged contact shadows grounding each piece. Clean and bright, but never a flat cut-out — it must read as something photographed, not rendered.'
    : 'Shoot it as a real photograph on a full-frame camera with an 85mm macro lens at f/4: true optics, natural depth-of-field falloff, shallow but honest focus. Physically plausible studio lighting — a large softbox key slightly off-axis, gentle bounce fill, and soft-edged contact shadows that sit the pieces convincingly on the surface. Render the surface with its real texture and micro-detail, faint ambient colour bounce onto the metal, believable reflections. It must look like an actual photograph, not a 3D render, not a cut-out pasted onto a colour.'
  // "Classy (auto)" hands the choice over instead of naming a surface, with
  // enough of a brief that it stays a product shot rather than a still life.
  const backdrop = background === AUTO_BACKGROUND
    ? 'Set the pieces on one simple, real surface chosen to suit them — draped silk, velvet, brushed stone, fine linen or polished wood — in a colour that flatters the jewellery and keeps it the clear subject. Nothing else in the scene: no props, no scattering, no decoration. Arrange them with even spacing and consistent scale.'
    : `Set the pieces on ${background}. Keep the setting simple and uncluttered — the surface alone, filling the frame behind and beneath them as a real physical environment, with nothing else placed in the scene. Arrange the products with even spacing and consistent scale.`
  const lines = [
    `Professional studio product photograph of exactly ${count} DIFFERENT ${item}, shown together in one frame as ${count} separate products.`,
    // A reference is one product — one thing a shopper buys — and that may be a
    // single piece, a matching pair, or a multi-piece set. Splitting a set into
    // its parts is as wrong as duplicating a design into a fake pair, so both
    // are ruled out explicitly and separately.
    `Each reference is ONE product. Reproduce every product exactly as its reference shows it and keep it whole: if a product is itself a matching pair or a multi-piece set, show all of its pieces together as that single unit — never split a product apart and never show only part of one.`,
    `The ${count} products must be visibly different from one another. Never duplicate a product to pad the frame, never invent a matching partner for a product that is shown singly, never merge two products into one, and never drop one — exactly ${count} distinct products, no more and no fewer.`,
    source,
  ]
  if (described.length) {
    lines.push(`The ${described.length} products, shapes only — colours come from the image: ${described.map((text, index) => `(${index + 1}) ${text}`).join('; ')}. Each appears exactly once, whole, and clearly distinguishable from the others.`)
  }
  lines.push(
    ignoreReferenceGround,
    `Camera: ${angle.camera}.`,
    `Take the exact colour, metal tone, plating, stone colour and finish of every product from the reference image — match what you see there precisely, and never infer them from this text. Shape, texture and proportions must match the reference too. Do not redesign, recolour, merge or duplicate any product, and do not add a product that is not in the reference.`,
    backdrop,
    `Give each product enough space and separation that its silhouette is unmistakable — no overlapping and no crowding between products — while the pieces belonging to one product stay grouped together as an obvious unit. Keep all products at true relative scale to one another.`,
    `Resolve fine detail: individual stones and their settings, metal grain and polish, engraving, joins and clasps, fabric or thread where present. Every design must be identifiable at a glance and hold up when zoomed in.`,
    realism,
    `No text, no logos, no watermarks, no hands, no people. Nothing added to the scene beyond the surface described.`,
  )
  if (extra.trim()) lines.push(extra.trim())
  return lines.join('\n')
}
