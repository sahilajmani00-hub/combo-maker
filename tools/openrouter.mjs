/**
 * Product descriptions, via a vision model on OpenRouter.
 *
 * The image models are told to keep the products unchanged, but a prompt that
 * never says *what* the products are gives them nothing to hold on to - which
 * is how a brushed-gold hoop comes back as a silver stud. Captioning each
 * uploaded photo once and naming the products in the prompt is the cheapest
 * defence: a handful of calls per session against hundreds of generations.
 *
 * OpenRouter speaks the OpenAI chat-completions shape, so this is one POST.
 */

import { readSetting, writeSettings } from './env.mjs'

const BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'

/**
 * Vision models, best first. All verified present on OpenRouter's vision list.
 *
 * Qwen3-VL 235B leads on measurement, not reputation: on real product shots it
 * was the only one that kept colour out of the description entirely - the
 * Claude models both reached for "pearl", which is a colour hint in all but
 * name - and it costs about a tenth of Sonnet. Sonnet still writes the richest
 * description when the piece is unusual, so it stays as the step up.
 *
 * Reasoning models are a trap for this job: they bill several hundred tokens of
 * thinking to produce a twelve-word phrase. Gemini is last for that reason, and
 * qwen3.7-flash is deliberately absent - it spent a 700-token ceiling reasoning
 * and returned an empty string.
 */
export const DESCRIBE_MODELS = [
  { id: 'qwen/qwen3-vl-235b-a22b-instruct', label: 'Qwen3-VL 235B' },
  { id: 'qwen/qwen3.8-max', label: 'Qwen3.8 Max' },
  { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
  { id: 'qwen/qwen3-vl-32b-instruct', label: 'Qwen3-VL 32B' },
  { id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
]

export const DEFAULT_DESCRIBE_MODEL = DESCRIBE_MODELS[0].id

/**
 * Generous, because reasoning models bill their thinking against this ceiling.
 *
 * At 120 this quietly produced "rose gold-" and "gold-": Gemini burnt 111 of
 * 116 completion tokens on reasoning and got cut off mid-word. Models that do
 * not reason stop on their own long before this, so a high cap costs nothing.
 */
const MAX_TOKENS = 700

/**
 * Deliberately colour-blind.
 *
 * The reference image already carries the exact colour, metal tone and finish,
 * and it carries them more accurately than any sentence could. Naming them in
 * the prompt only gives the image model a second, worse opinion to follow - so
 * the description covers the things a picture states less clearly (silhouette,
 * construction, motif, scale) and stays silent on the rest.
 *
 * Kept short on purpose: this text is pasted into every prompt it appears in.
 */
const SYSTEM = [
  'You describe ONE catalogue product from its photo. The product may be a single piece, a matching pair, or a multi-piece set — describe it as one product, and if it is a pair or set say so and say how many pieces it has.',
  'Reply with ONE noun phrase of at most 20 words describing its shape, silhouette, construction, components, motif and style.',
  'Never mention colour, metal tone, plating or finish, and avoid material names that imply a colour - no gold, silver, rose gold, pearl, jet, ivory, diamond.',
  'Say "sphere", "bead", "cabochon" or "faceted stone" instead of naming the material.',
  'Examples: "long tiered chandelier earring with a teardrop centre stone and fringed lower row"; "matching pair of wide hinged huggie hoops with paved stones"; "set of six graduated stud pairs in ascending size".',
  'No sentences, no preamble, no punctuation at the end, no marketing language.',
].join(' ')

/**
 * Models for writing the prompt itself, best first.
 *
 * This runs once per camera angle rather than once per image - the prompt it
 * writes carries a {{PRODUCTS}} slot that each combo fills in - so a run costs
 * a handful of calls, not hundreds. That is what makes a top-tier model
 * affordable here: eight Opus calls is pennies, eight hundred would not be.
 */
export const PROMPT_MODELS = [
  { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8' },
  { id: 'anthropic/claude-opus-4.7', label: 'Claude Opus 4.7' },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'x-ai/grok-4.6', label: 'Grok 4.6' },
  { id: 'deepseek/deepseek-v3.2', label: 'DeepSeek v3.2' },
]

export const DEFAULT_PROMPT_MODEL = PROMPT_MODELS[0].id

/** The slot each combo's own product descriptions are dropped into. */
export const PRODUCTS_TOKEN = '{{PRODUCTS}}'

const PROMPT_SYSTEM = [
  'You write prompts for an AI product photographer. The output is a marketplace listing image — Amazon, Flipkart, Meesho — where the job is to stop a shopper scrolling and read clearly at thumbnail size.',
  'You are given the product type, how many products share the frame, a camera angle, a backdrop and an aspect ratio. Write ONE prompt for that shot.',
  '',
  'CRITICAL, and there are two opposite mistakes to rule out. (1) With jewellery an image model reads "2 earrings" as the left and right of one design, and returns a single product photographed twice. (2) Over-correcting for that, it splits a product that is genuinely sold as a pair or a set into separate items. Each reference is ONE product — possibly a single piece, possibly a matching pair, possibly a multi-piece set. Your prompt must say that the frame holds several DIFFERENT products, that each is reproduced whole and exactly once, that a product which is a pair or set stays together as one unit, and that no product may be duplicated, split, merged or given an invented matching partner.',
  '',
  'The prompt you write MUST:',
  `- contain the literal token ${PRODUCTS_TOKEN} exactly once, on its own line, where the list of products in the frame will be inserted;`,
  '- instruct that colour, metal tone, plating, stone colour and finish are taken from the reference image and never invented from the text;',
  '- instruct that no product may be redesigned, recoloured, merged, duplicated, or added;',
  '- forbid text, logos, watermarks, hands and people;',
  '- describe lighting, composition, spacing, depth of field and surface treatment concretely enough to be reproducible;',
  '- require clear separation between the products — no overlapping or crowding — while the pieces of one product stay grouped as a unit, all at true relative scale;',
  '- call for fine detail to resolve: stones and settings, metal grain and polish, joins and clasps.',
  '',
  'Aim for a clean, bright, high-contrast commercial result that stays legible as a small thumbnail: the products fill the frame confidently, edges stay crisp, shadows stay soft and shallow.',
  'Write 90-160 words of plain declarative sentences. No headings, no bullet points, no markdown, no preamble, no commentary — output only the prompt itself.',
].join('\n')

/** Writes the prompt for one camera angle. */
export async function writeAnglePrompt(key, model, brief, signal) {
  const lines = [
    `Product type: ${brief.subject || 'products'}`,
    `Products in the frame: ${brief.count}`,
    `Camera angle: ${brief.angleLabel} — ${brief.camera}`,
    `Backdrop: ${brief.backdrop}`,
    `Aspect ratio: ${brief.aspectRatio}`,
  ]
  if (brief.extra?.trim()) lines.push(`Extra direction from the seller: ${brief.extra.trim()}`)

  const text = await chat(
    key,
    model,
    [
      { role: 'system', content: PROMPT_SYSTEM },
      { role: 'user', content: lines.join('\n') },
    ],
    signal,
    1500,
  )
  const cleaned = text.replace(/^```[a-z]*\n?|```$/g, '').trim()
  if (!cleaned.includes(PRODUCTS_TOKEN)) {
    throw new Error(`The model left out the ${PRODUCTS_TOKEN} slot, so the products could not be named.`)
  }
  if (cleaned.length < 120) throw new Error('The model returned too little to use as a prompt.')
  return cleaned
}

/**
 * Turns a finished photograph back into the prompt that would recreate it.
 *
 * Once a batch has produced images that actually work, the look in them is
 * worth more than the prompt that happened to produce it — the model saw the
 * result, the prompt only asked. Reading the winners back gives a description
 * of what actually landed, and leaving a {{PRODUCTS}} slot makes it reusable
 * for combos that have not been shot yet.
 *
 * One model does both halves on purpose: whatever reads the image is what
 * writes about it, so nothing is lost describing it to a second model.
 */
const REVERSE_SYSTEM = [
  'You are looking at a finished product photograph. Write the image-generation prompt that would recreate this exact look with a different set of products.',
  '',
  'Describe concretely what you can see: camera angle and height, how tight the framing is, apparent lens and depth of field, composition and spacing, the surface or backdrop and its material, texture and colour, the lighting setup and its direction, the character of the shadows and reflections, and the overall mood and finish.',
  '',
  `Your prompt MUST contain the literal token ${PRODUCTS_TOKEN} exactly once, on its own line, where the products belong. Do NOT describe the particular products in the photograph — the token stands in for them, so the prompt can be reused. Everything else about the scene should be described precisely enough to reproduce.`,
  '',
  '',
  'Two things carry most of the quality, so spend your words there. (1) The BACKDROP: name the material, colour, texture and finish exactly, and say how light falls across it and how the products sit on it — a vague surface is what makes these look fake. (2) DETAIL: require that the jewellery resolves fully — individual stones and their settings, metal grain and polish, engraving, joins and clasps, crisp edges — and that it holds up when zoomed in.',
  '',
  'Never mention that this is a reference, a recreation or an existing image. Write 110 to 180 words of plain declarative sentences. No headings, no bullet points, no markdown, no preamble — output only the prompt.',
].join('\n')

export async function promptFromImage(key, model, { data, type }, signal) {
  const text = await chat(
    key,
    model,
    [
      { role: 'system', content: REVERSE_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Write the prompt that would recreate this photograph.' },
          { type: 'image_url', image_url: { url: `data:${type};base64,${data}` } },
        ],
      },
    ],
    signal,
    1500,
  )
  const cleaned = text.replace(/^```[a-z]*\n?|```$/g, '').trim()
  if (!cleaned.includes(PRODUCTS_TOKEN)) {
    throw new Error(`The model left out the ${PRODUCTS_TOKEN} slot.`)
  }
  if (cleaned.length < 120) throw new Error('The model returned too little to use as a prompt.')
  return cleaned
}

/** Slots a per-combo prompt leaves for the things that vary shot to shot. */
export const ANGLE_TOKEN = '{{ANGLE}}'
export const BACKDROP_TOKEN = '{{BACKDROP}}'

/**
 * Writes the prompt for one combo by looking at that combo's own composite.
 *
 * The per-angle prompt is written blind — it knows there are three products but
 * not that one is a fringed chandelier and another a flat stud, so its framing
 * and spacing advice is generic. A model that can see the layout writes for the
 * products actually in it.
 *
 * One call per combo, not per image: the angle and the backdrop are left as
 * slots and filled per shot, so four angles still cost one call.
 */
const COMBO_SYSTEM = [
  'You are looking at a flat working layout that holds several different jewellery products side by side. They are about to be re-photographed together as one studio product shot for a marketplace listing. Write the image-generation prompt for that shot.',
  '',
  'What you see is a layout, not a scene: its plain background is a working aid and must not appear in your prompt as the setting.',
  '',
  'Your prompt MUST contain both of these literal tokens, each exactly once:',
  `- ${ANGLE_TOKEN} where the camera angle belongs;`,
  `- ${BACKDROP_TOKEN} where the surface the products sit on belongs.`,
  '',
  'Your prompt MUST also:',
  '- say how many products are in the frame and that they are DIFFERENT products, each appearing exactly once;',
  '- describe each product briefly by shape, silhouette and construction so it can be told apart — never by colour, metal tone, plating or finish, and never using colour-implying material names (no gold, silver, rose gold, pearl, ivory, diamond); say sphere, bead, cabochon or faceted stone instead;',
  '- state that a product which is itself a matching pair or a multi-piece set stays whole as one unit, and that no product may be split, duplicated, merged, dropped, or given an invented partner;',
  '- require that colour, metal tone, plating, stone colour and finish come only from the reference image and are never inferred from the text;',
  '- lay out the composition for the pieces you can actually see — their relative sizes, how much room each needs, how they should be spaced so nothing overlaps or crowds;',
  '- require fine detail to resolve: individual stones and settings, metal grain and polish, engraving, joins and clasps, crisp edges, holding up when zoomed in;',
  '- forbid text, logos, watermarks, hands and people.',
  '',
  'Write 120 to 200 words of plain declarative sentences. No headings, no bullet points, no markdown, no preamble — output only the prompt.',
].join('\n')

export async function promptForCombo(key, model, { data, type, subject, count }, signal) {
  const text = await chat(
    key,
    model,
    [
      { role: 'system', content: COMBO_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Write the prompt for this layout. It holds ${count} different ${subject || 'products'}.` },
          { type: 'image_url', image_url: { url: `data:${type};base64,${data}` } },
        ],
      },
    ],
    signal,
    2000,
  )
  const cleaned = text.replace(/^```[a-z]*\n?|```$/g, '').trim()
  for (const token of [ANGLE_TOKEN, BACKDROP_TOKEN]) {
    if (!cleaned.includes(token)) throw new Error(`The model left out the ${token} slot.`)
  }
  if (cleaned.length < 150) throw new Error('The model returned too little to use as a prompt.')
  return cleaned
}

export function readKey(root) {
  return readSetting(root, 'OPENROUTER_API_KEY')
}

export function writeKey(root, key) {
  writeSettings(root, { OPENROUTER_API_KEY: key })
}

async function chat(key, model, messages, signal, maxTokens = MAX_TOKENS) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      // OpenRouter attributes usage with these; both are optional.
      'HTTP-Referer': 'http://localhost/combo-maker',
      'X-Title': 'Combo Maker',
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.2 }),
    signal,
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(body?.error?.message || `OpenRouter returned ${response.status}.`)
  }
  // OpenRouter can answer 200 with an error object when a provider fails.
  if (body?.error) throw new Error(body.error.message || 'OpenRouter could not complete the request.')
  return body?.choices?.[0]?.message?.content?.trim() ?? ''
}

/**
 * Signs the model answered conversationally instead of describing.
 *
 * A photo it cannot read gets "I can only see colour swatches here, could you
 * share a clearer image?" — perfectly reasonable, and ruinous if it were pasted
 * into the prompt for every generation of that combo. Better to report nothing
 * and let the field stay empty.
 */
const NOT_A_DESCRIPTION = /\?|\b(i can|i'm|i am|sorry|unable to|cannot|can't|could you|please (share|provide)|appears to be a (screenshot|colour|color))\b/i

function asDescription(text) {
  const cleaned = text.replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').replace(/[.\s]+$/, '')
  if (!cleaned) throw new Error('The model returned nothing for this photo.')
  if (NOT_A_DESCRIPTION.test(cleaned) || cleaned.split(' ').length > 30) {
    throw new Error('The model could not make out a product in this photo.')
  }
  return cleaned.slice(0, 200)
}

/** A one-line description of a single product photo. */
export async function describeImage(key, model, { data, type, subject }, signal) {
  const hint = subject?.trim() ? ` The object is one of a set of ${subject.trim()}.` : ''
  const text = await chat(
    key,
    model,
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Describe this product.${hint}` },
          { type: 'image_url', image_url: { url: `data:${type};base64,${data}` } },
        ],
      },
    ],
    signal,
  )
  return asDescription(text)
}

/** Cheap key check, so a bad key is caught in the form rather than per photo. */
export async function verifyKey(key) {
  try {
    const response = await fetch(`${BASE_URL}/key`, { headers: { Authorization: `Bearer ${key}` } })
    if (response.ok) return { ok: true }
    return { ok: false, message: response.status === 401 ? 'OpenRouter rejected that key.' : `OpenRouter returned ${response.status}.` }
  } catch (error) {
    return { ok: false, message: `Could not reach OpenRouter: ${error.message}` }
  }
}
