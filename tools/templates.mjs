/**
 * Saved setups: the product photos plus every setting that produced them.
 *
 * Uploaded files live in the browser tab and nowhere else, so a refresh throws
 * away an afternoon of arranging, describing and tuning. A template is that
 * whole state written to disk — originals, not re-encodings, so loading one and
 * saving it again does not slowly degrade the photos.
 *
 * They live in the launcher rather than in browser storage because the launcher
 * is the only side that can hand them back after the browser has been closed,
 * reinstalled, or swapped for a different one.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FOLDER = 'templates'
const MANIFEST = 'template.json'

/** Filenames are derived from the name, so it has to survive being one. */
function slug(name) {
  const cleaned = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return cleaned || 'untitled'
}

function fail(message) {
  const error = new Error(message)
  error.expected = true
  throw error
}

function root_(root) {
  return join(root, FOLDER)
}

function directoryFor(root, id) {
  // `slug` strips separators and dots, so an id from the client cannot climb
  // out of the templates folder.
  return join(root_(root), slug(id))
}

const EXTENSION_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
}

/* ---------------- reading ---------------- */

export function listTemplates(root) {
  const base = root_(root)
  if (!existsSync(base)) return []
  return readdirSync(base)
    .flatMap((entry) => {
      const file = join(base, entry, MANIFEST)
      if (!existsSync(file)) return []
      try {
        const manifest = JSON.parse(readFileSync(file, 'utf8'))
        return [{
          id: entry,
          name: manifest.name ?? entry,
          savedAt: manifest.savedAt ?? null,
          productCount: (manifest.products ?? []).length,
        }]
      } catch {
        return []
      }
    })
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
}

/** The full template, with the photos read back as base64. */
export function loadTemplate(root, id) {
  const directory = directoryFor(root, id)
  const file = join(directory, MANIFEST)
  if (!existsSync(file)) fail('That template is not there any more.')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))

  const products = (manifest.products ?? []).flatMap((product) => {
    const source = join(directory, 'products', product.file)
    if (!existsSync(source)) return []
    return [{
      name: product.name,
      type: product.type,
      data: readFileSync(source).toString('base64'),
    }]
  })

  return { id, name: manifest.name, savedAt: manifest.savedAt, settings: manifest.settings ?? {}, products }
}

/* ---------------- writing ---------------- */

export function saveTemplate(root, { name, products, settings }) {
  const label = String(name ?? '').trim()
  if (!label) fail('Give the template a name first.')
  if (!Array.isArray(products) || !products.length) fail('Add some product images before saving a template.')

  const id = slug(label)
  const directory = join(root_(root), id)
  const productDirectory = join(directory, 'products')

  // Replace wholesale rather than merging: saving over a template should leave
  // exactly what is on screen, not that plus whatever used to be there.
  try {
    rmSync(productDirectory, { recursive: true, force: true })
    mkdirSync(productDirectory, { recursive: true })
  } catch (error) {
    fail(`Could not write ${directory}: ${error.message}`)
  }

  const written = products.map((product, index) => {
    const extension = EXTENSION_BY_TYPE[product.type] ?? 'jpg'
    const file = `${String(index + 1).padStart(2, '0')}.${extension}`
    writeFileSync(join(productDirectory, file), Buffer.from(String(product.data ?? ''), 'base64'))
    return { file, name: String(product.name ?? `product-${index + 1}`), type: product.type }
  })

  const manifest = {
    name: label,
    savedAt: new Date().toISOString(),
    settings: settings ?? {},
    products: written,
  }
  writeFileSync(join(directory, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { id, name: label, savedAt: manifest.savedAt, productCount: written.length }
}

export function deleteTemplate(root, id) {
  const directory = directoryFor(root, id)
  if (!existsSync(directory)) return false
  // Guard: only ever remove something that actually looks like a template.
  if (!existsSync(join(directory, MANIFEST))) fail('That folder is not a template.')
  if (!statSync(directory).isDirectory()) return false
  rmSync(directory, { recursive: true, force: true })
  return true
}
