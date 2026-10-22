/** One shared product scene from several reference photos via the OpenAI Image API. */

import { readSetting, writeSettings } from './env.mjs'

const KEY_NAME = 'OPENAI_API_KEY'
const MODELS = new Set(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])

export function readKey(root) {
  return readSetting(root, KEY_NAME)
}

export function writeKey(root, key) {
  writeSettings(root, { [KEY_NAME]: key })
}

export async function generateScene(key, input) {
  const images = Array.isArray(input.images) ? input.images : []
  if (images.length < 2 || images.length > 4) throw new Error('Choose a combo of 2–4 product photos.')
  const model = MODELS.has(input.model) ? input.model : 'gpt-image-2.5-flare'
  const background = String(input.background ?? '').trim().slice(0, 500)
  if (!background) throw new Error('Describe the shared background first.')
  const referenceImages = images.map((image) => {
    const type = String(image.type ?? '')
    const data = String(image.data ?? '')
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length > 20_000_000) {
      throw new Error('Each reference must be a PNG, JPG or WebP image under 15 MB.')
    }
    return { image_url: `data:${type};base64,${data}` }
  })

  const prompt = [
    `Create one photorealistic marketplace product photograph with exactly ${images.length} distinct products, one from each reference image.`,
    `Arrange all products together naturally in a single scene on this shared background: ${background}.`,
    'Preserve the identity, shape, material, colors, labels, patterns and important details of each referenced product as faithfully as possible.',
    'Use coherent lighting, scale, perspective and contact shadows. No grid, split screen, collage, frames, text, watermark, duplicate product, or extra product.',
    String(input.extra ?? '').trim().slice(0, 1000),
  ].filter(Boolean).join(' ')
  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, images: referenceImages, prompt, size: '1024x1024', quality: 'medium', output_format: 'jpeg', output_compression: 90, background: 'opaque' }),
    signal: AbortSignal.timeout(300_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = body?.error?.message || `OpenAI returned HTTP ${response.status}.`
    throw new Error(`${message}${response.headers.get('x-request-id') ? ` (request ${response.headers.get('x-request-id')})` : ''}`)
  }
  const data = body?.data?.[0]?.b64_json
  if (!data) throw new Error('OpenAI returned no image for this combo.')
  return { type: 'image/jpeg', data, model }
}
