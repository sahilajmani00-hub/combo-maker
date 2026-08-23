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
  'You describe a single piece of jewellery for a catalogue.',
  'Reply with ONE noun phrase of at most 20 words describing its shape, silhouette, construction, components, motif and style.',
  'Never mention colour, metal tone, plating or finish, and avoid material names that imply a colour - no gold, silver, rose gold, pearl, jet, ivory, diamond.',
  'Say "sphere", "bead", "cabochon" or "faceted stone" instead of naming the material.',
  'Example: "long tiered chandelier earring with a teardrop centre stone and fringed lower row".',
  'No sentences, no preamble, no punctuation at the end, no marketing language.',
].join(' ')

export function readKey(root) {
  return readSetting(root, 'OPENROUTER_API_KEY')
}

export function writeKey(root, key) {
  writeSettings(root, { OPENROUTER_API_KEY: key })
}

async function chat(key, model, messages, signal) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      // OpenRouter attributes usage with these; both are optional.
      'HTTP-Referer': 'http://localhost/combo-maker',
      'X-Title': 'Combo Maker',
    },
    body: JSON.stringify({ model, messages, max_tokens: MAX_TOKENS, temperature: 0.2 }),
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
