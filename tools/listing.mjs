/**
 * Listing copy and attributes, written by looking at the product photo.
 *
 * Flipkart never asks for a title. It builds one from Brand, Model Name, Type
 * and Colour, so the job here is to fill those attributes accurately rather
 * than to write a headline — a wrong attribute is worse than a dull one,
 * because it fails QC instead of merely ranking badly.
 *
 * Everything comes back as JSON so it can be snapped to the template's allowed
 * values before it is written; free text the model invents for a dropdown
 * column is dropped rather than sent to Flipkart to be rejected.
 */

import { MULTI_SEPARATOR, snapToAllowed } from './flipkart.mjs'

/**
 * The attributes worth asking a vision model for.
 *
 * Deliberately not "every optional column": asking for forty fields produces
 * forty confident guesses, and the ones it cannot see — diamond clarity, metal
 * purity, carat weights — are exactly the ones QC checks hardest.
 */
export const GENERATED_FIELDS = [
  { column: 'Model Name', hint: 'A short product name, 3-6 words, no brand, no colour words. Drives the Flipkart title.' },
  { column: 'Type', hint: 'The kind of earring, e.g. Stud, Drop, Hoop, Jhumka, Dangler.', multi: true },
  { column: 'Sub Type', hint: 'A more specific style.', multi: false },
  { column: 'Earring Shape', hint: 'The overall silhouette, e.g. Round, Heart, Teardrop, Floral.' },
  { column: 'Base Material', hint: 'What the body is made of, e.g. Alloy, Brass, Sterling Silver.', multi: true },
  { column: 'Plating', hint: 'Surface plating, e.g. Gold-plated, Rhodium-plated, Silver-plated.', multi: true },
  { column: 'Gemstone', hint: 'Stones visibly set in the piece, e.g. Cubic Zirconia, Pearl. Omit if none.', multi: true },
  { column: 'Color', hint: 'The dominant colours of the piece.', multi: true },
  { column: 'Design', hint: 'Motif or design theme, e.g. Floral, Geometric, Bow.', multi: true },
  { column: 'Occasion', hint: 'When it would be worn, e.g. Casual, Party, Wedding, Office.', multi: true },
  { column: 'Ideal For', hint: 'Who it is for. Usually Women or Girls.', multi: true },
  { column: 'Earring Back Type', hint: 'The fastening, e.g. Push Back, Screw Back, Hook, Clip On.' },
  { column: 'Finish', hint: 'Surface finish, e.g. Polished, Matte, Antique.', multi: true },
  { column: 'Setting', hint: 'How stones are held, e.g. Prong, Pave, Bezel. Omit if no stones.', multi: true },
  { column: 'Number of Pairs', hint: 'How many pairs the listing includes, as a whole number.' },
  { column: 'Key Features', hint: '3-5 short defining features, each a few words.', multi: true },
  { column: 'Other Features', hint: '2-3 extra useful details, each a few words.', multi: true },
  { column: 'Search Keywords', hint: '8-12 phrases a shopper would actually type. Include material, style, occasion and colour variants.', multi: true },
  { column: 'Description', hint: 'Four to six plain sentences describing the piece, its material, finish and when to wear it. No hype, no offers, no links, no HTML.' },
]

const SYSTEM = [
  'You write product catalogue data for an Indian marketplace by looking at a product photograph.',
  'You will be given a list of attributes with a short hint, and for some of them an explicit list of allowed values.',
  '',
  'Rules:',
  '- Reply with a single JSON object and nothing else. No markdown, no code fence, no commentary.',
  '- One key per requested attribute, spelled exactly as given.',
  '- Where a list of allowed values is supplied, the value MUST be chosen from that list, copied exactly.',
  '- Attributes marked multi take an array of strings; everything else takes a single string.',
  '- Describe only what is actually visible. If you cannot tell, omit the key entirely rather than guessing — a wrong attribute fails quality check, a missing one does not.',
  '- Never state a carat weight, metal purity, gemstone authenticity or certification: those cannot be seen in a photograph.',
  '- Never mention price, offers, delivery, competitors, or any brand name.',
].join('\n')

/**
 * Asks a vision model to fill the listing fields for one product photo.
 *
 * `allowedByColumn` carries the template's dropdown lists; anything it covers
 * is both requested and enforced, so the reply cannot drift off the list.
 */
export async function writeListing(chat, { model, data, type, subject, allowedByColumn, extra }) {
  const wanted = GENERATED_FIELDS.map((field) => {
    const allowed = allowedByColumn?.[field.column]
    const parts = [`- ${field.column}${field.multi ? ' (multi)' : ''}: ${field.hint}`]
    if (allowed?.length) {
      // A 247-entry country list would swamp the prompt; the long ones are
      // snapped after the fact instead.
      if (allowed.length <= 60) parts.push(`  Allowed values: ${allowed.join(' | ')}`)
    }
    return parts.join('\n')
  }).join('\n')

  const instruction = [
    `This is a photograph of ${subject || 'a product'} sold as one listing.`,
    extra?.trim() ? `Seller notes: ${extra.trim()}` : '',
    '',
    'Fill these attributes:',
    wanted,
  ]
    .filter(Boolean)
    .join('\n')

  const reply = await chat(
    model,
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          { type: 'image_url', image_url: { url: `data:${type};base64,${data}` } },
        ],
      },
    ],
    2500,
  )
  return parseListing(reply)
}

/** Models sometimes wrap JSON in prose or a fence; take the object either way. */
export function parseListing(reply) {
  const cleaned = String(reply ?? '').replace(/^```[a-z]*\n?|```$/gm, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('The model did not return JSON.')
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch (error) {
    throw new Error(`The model returned JSON that will not parse: ${error.message}`)
  }
}

/**
 * Turns a model's reply into cells the template will accept.
 *
 * Dropdown columns are snapped and, failing that, dropped — an invented value
 * is the difference between a listing that goes live and one that comes back
 * marked QC Failed.
 */
export function toCells(generated, { columns, dropdowns }) {
  const byName = new Map(columns.map((column) => [column.name, column]))
  const cells = {}
  const dropped = []

  for (const field of GENERATED_FIELDS) {
    const column = byName.get(field.column)
    const raw = generated?.[field.column]
    if (!column || raw === undefined || raw === null || raw === '') continue

    const allowed = dropdowns[column.index]
    const values = (Array.isArray(raw) ? raw : [raw]).map((entry) => String(entry).trim()).filter(Boolean)
    const kept = []
    for (const value of values) {
      if (!allowed?.length) {
        kept.push(value)
        continue
      }
      const snapped = snapToAllowed(value, allowed)
      if (snapped) kept.push(snapped)
      else dropped.push(`${field.column}: "${value}"`)
    }
    if (!kept.length) continue

    cells[field.column] = field.multi ? [...new Set(kept)].join(MULTI_SEPARATOR) : kept[0]
  }

  return { cells, dropped }
}
