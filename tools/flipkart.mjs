/**
 * Reading and filling a Flipkart bulk-listing template.
 *
 * The template is a 139-column workbook with four header rows: the attribute
 * name, its data type, an example, and a description. Sellers start typing at
 * row five. Whether an attribute is compulsory is not written anywhere as text
 * — it is the colour of the header cell — so that gets decoded here rather
 * than left for someone to eyeball against the legend on the summary sheet.
 *
 * Rows are filled into the original workbook and written back out, so the
 * other twelve sheets, the header rows and the examples all survive intact.
 * A rebuilt-from-scratch file would upload just as well until the day Flipkart
 * checks for something we did not know to copy.
 */

/** Header-cell fills, from the legend on the Summary Sheet. */
const REQUIREMENT_BY_COLOUR = {
  '8DB4E2': 'mandatory',
  CC99FF: 'conditional',
  '94D050': 'optional',
  C0C0C0: 'flipkart',
}

/** Row indices, zero-based: name, type, example, description, then data. */
const ROW_NAME = 0
const ROW_TYPE = 1
const ROW_SAMPLE = 2
const ROW_HELP = 3
export const DATA_START_ROW = 4

/** Flipkart separates repeated values in one cell with a double colon. */
export const MULTI_SEPARATOR = '::'

/**
 * xlsx is a real dependency, unlike everything else the launcher imports, so
 * it is loaded on demand — a missing node_modules should not stop the app
 * serving or the queue working.
 */
let cached = null
async function xlsx() {
  if (!cached) {
    try {
      cached = (await import('xlsx')).default
    } catch {
      const error = new Error('The xlsx package is missing — run "npm install" and restart.')
      error.expected = true
      throw error
    }
  }
  return cached
}

function fail(message) {
  const error = new Error(message)
  error.expected = true
  throw error
}

const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

/** The listing sheet is the one with the attribute columns, not a helper. */
function listingSheetName(workbook) {
  const helpers = /^(Summary|Index|DropDownValues|Listing FAQ|Image GuideLines|MatchingAttributes|VariantAttributes|Parent Variant|template_version)/i
  return workbook.SheetNames.find((name) => !helpers.test(name)) ?? workbook.SheetNames[0]
}

/**
 * Everything about the template a caller needs: what the columns are, which
 * ones must be filled, and which ones only accept a fixed set of values.
 */
export async function readTemplate(file) {
  const XLSX = await xlsx()
  let workbook
  try {
    workbook = XLSX.readFile(file, { cellStyles: true })
  } catch (error) {
    fail(`Could not read ${file}: ${error.message}`)
  }

  const sheetName = listingSheetName(workbook)
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) fail(`${file} has no listing sheet.`)
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })
  if (rows.length < 4) fail('That does not look like a Flipkart template — it has no header rows.')

  const columns = []
  for (let index = 0; index < rows[ROW_NAME].length; index++) {
    const name = text(rows[ROW_NAME][index])
    if (!name) continue
    const header = sheet[XLSX.utils.encode_cell({ r: ROW_NAME, c: index })]
    const rgb = (header?.s?.fgColor?.rgb ?? header?.s?.bgColor?.rgb ?? '').toUpperCase().slice(-6)
    columns.push({
      index,
      name,
      type: text(rows[ROW_TYPE][index]),
      sample: text(rows[ROW_SAMPLE][index]),
      help: text(rows[ROW_HELP][index]),
      requirement: REQUIREMENT_BY_COLOUR[rgb] ?? 'optional',
      multi: /multi/i.test(text(rows[ROW_TYPE][index])),
    })
  }

  // Allowed values live on their own sheets, named after the column index.
  const dropdowns = {}
  for (const name of workbook.SheetNames) {
    const match = /^DropDownValuesForColumn(\d+)$/i.exec(name)
    if (!match) continue
    const values = XLSX.utils
      .sheet_to_json(workbook.Sheets[name], { header: 1, blankrows: false, defval: '' })
      .flat()
      .map(text)
      .filter(Boolean)
    if (values.length) dropdowns[Number(match[1])] = values
  }

  return { file, sheetName, columns, dropdowns, rowCount: rows.length }
}

/** Snaps a generated value onto the allowed list, so QC does not reject it. */
export function snapToAllowed(value, allowed) {
  const wanted = text(value).toLowerCase()
  if (!wanted || !allowed?.length) return null
  const exact = allowed.find((entry) => entry.toLowerCase() === wanted)
  if (exact) return exact
  // "Stud" should find "Basic Stud" rather than being thrown away.
  const contains = allowed.find(
    (entry) => entry.toLowerCase().includes(wanted) || wanted.includes(entry.toLowerCase()),
  )
  return contains ?? null
}

/**
 * Writes listing rows into a copy of the template.
 *
 * `rows` are keyed by column name rather than position, because a template for
 * a different category has the same names in different places and a run built
 * against one should not silently write into the wrong columns of another.
 */
export async function fillTemplate({ file, rows, outFile }) {
  const XLSX = await xlsx()
  const workbook = XLSX.readFile(file, { cellStyles: true })
  const sheetName = listingSheetName(workbook)
  const sheet = workbook.Sheets[sheetName]

  const header = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })[ROW_NAME]
  const columnByName = new Map()
  header.forEach((name, index) => {
    const clean = text(name)
    if (clean && !columnByName.has(clean)) columnByName.set(clean, index)
  })

  const unknown = new Set()
  rows.forEach((row, offset) => {
    const r = DATA_START_ROW + offset
    for (const [name, raw] of Object.entries(row)) {
      const c = columnByName.get(name)
      if (c === undefined) {
        unknown.add(name)
        continue
      }
      const value = Array.isArray(raw) ? raw.filter(Boolean).join(MULTI_SEPARATOR) : raw
      if (value === null || value === undefined || value === '') continue
      // Prices and counts are written as numbers so Excel does not flag them.
      const numeric = typeof value === 'number' || (/^\d+(\.\d+)?$/.test(String(value)) && String(value).length < 12)
      sheet[XLSX.utils.encode_cell({ r, c })] = numeric
        ? { t: 'n', v: Number(value) }
        : { t: 's', v: String(value) }
    }
  })

  // The sheet only renders rows inside its declared range.
  const range = XLSX.utils.decode_range(sheet['!ref'])
  range.e.r = Math.max(range.e.r, DATA_START_ROW + rows.length - 1)
  sheet['!ref'] = XLSX.utils.encode_range(range)

  const bookType = outFile.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'xls'
  XLSX.writeFile(workbook, outFile, { bookType })
  return { outFile, rows: rows.length, unknownColumns: [...unknown] }
}
