import './style.css'
import { prepareImage, type PreparedImage } from './imageprep.ts'
import {
  LAYOUTS,
  RATIOS,
  canvasToBlob,
  composeCombo,
  layoutLabel,
  normalizeLayout,
  type AlignId,
  type ComboSize,
  type LayoutId,
  type RatioId,
} from './compose.ts'
import { createZip, type ZipEntry } from './zip.ts'
import { comboName } from './naming.ts'
import { MAX_COMBOS, buildGroups, countGroups, minimumImages, type GroupMode } from './grouping.ts'

type Product = { id: number; file: File; url: string }
type Result = { name: string; blob: Blob; url: string; index: number }

const MAX_PRODUCTS = 60

const BACKGROUNDS = [
  { id: '#ffffff', label: 'White' },
  { id: '#f7f5ef', label: 'Cream' },
  { id: '#f2f2f2', label: 'Light grey' },
  { id: 'transparent', label: 'Transparent (PNG only)' },
]

const state = {
  products: [] as Product[],
  comboSize: 2 as ComboSize,
  mode: 'combinations' as GroupMode,
  layout: 'row' as LayoutId,
  ratio: 'square' as RatioId,
  background: '#ffffff',
  padding: 6,
  gap: 3,
  uniformScale: true,
  align: 'center' as AlignId,
  trim: true,
  format: 'png' as 'png' | 'jpeg',
}

let results: Result[] = []
let nextId = 1
let busy = false

/** Prepared canvases are expensive; keyed by product + trim setting. */
const prepCache = new Map<string, PreparedImage>()

const app = document.querySelector<HTMLDivElement>('#app')!

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function comboGroups(): Product[][] {
  return buildGroups(state.products, state.comboSize, state.mode)
}

app.innerHTML = `
  <header class="topbar">
    <a class="brand" href="."><span class="brand-mark">CM</span><span>Combo Maker</span></a>
    <span class="local-pill"><span class="status-dot"></span>Runs locally</span>
  </header>
  <main>
    <section class="intro">
      <div>
        <p class="eyebrow">PRODUCT IMAGE STUDIO / 01</p>
        <h1>Make every combo<br><em>look intentional.</em></h1>
        <p class="lede">Upload your product shots, pick a set size, and export clean marketplace-ready combos. Every product is trimmed and scaled to match, so nothing floats or towers over the rest.</p>
      </div>
      <div class="intro-note"><span>01</span><p>Your files stay in this browser.<br>No upload, no account, no fuss.</p></div>
    </section>

    <div class="workspace">
      <section class="panel setup-panel">
        <div class="panel-heading">
          <div><span class="step">01</span><h2>Add products</h2></div>
          <span id="count-label" class="count-label">0 images</span>
        </div>
        <label class="dropzone" id="dropzone" for="file-input">
          <input id="file-input" type="file" accept="image/*" multiple>
          <span class="upload-icon">+</span><strong>Drop product images here</strong><span>or <u>browse your files</u></span>
          <small>JPG, PNG or WEBP · up to ${MAX_PRODUCTS} images</small>
        </label>
        <div id="product-list" class="product-list"></div>
      </section>

      <section class="panel recipe-panel">
        <div class="panel-heading"><div><span class="step">02</span><h2>Choose your combo</h2></div></div>
        <p class="section-copy">How many products should sit in one image?</p>
        <div id="size-options" class="size-options" role="radiogroup" aria-label="Combo size"></div>

        <div class="rule"></div>

        <div class="field">
          <span class="field-label">Which combos to build</span>
          <div id="mode-options" class="chip-row"></div>
          <p id="mode-copy" class="mode-copy"></p>
        </div>
        <div class="field">
          <span class="field-label">Layout</span>
          <div id="layout-options" class="chip-row"></div>
        </div>
        <div class="field">
          <span class="field-label">Canvas</span>
          <div id="ratio-options" class="chip-row"></div>
        </div>
        <div class="field">
          <span class="field-label">Background</span>
          <div id="background-options" class="swatch-row"></div>
        </div>
        <div class="field">
          <span class="field-label">Outer margin</span>
          <div class="slider-row">
            <input id="padding-input" type="range" min="0" max="14" step="1" value="${state.padding}">
            <span id="padding-value" class="slider-value">${state.padding}%</span>
          </div>
        </div>
        <div class="field">
          <span class="field-label">Gap between products</span>
          <div class="slider-row">
            <input id="gap-input" type="range" min="0" max="10" step="1" value="${state.gap}">
            <span id="gap-value" class="slider-value">${state.gap}%</span>
          </div>
        </div>
        <div class="field">
          <span class="field-label">Alignment</span>
          <label class="toggle"><input id="trim-input" type="checkbox" ${state.trim ? 'checked' : ''}><span><b>Trim empty space</b>Crop each photo to the product so uneven borders stop throwing the layout off.</span></label>
          <label class="toggle"><input id="uniform-input" type="checkbox" ${state.uniformScale ? 'checked' : ''}><span><b>Match product sizes</b>Scale every product by the same factor instead of filling its own cell.</span></label>
          <label class="toggle"><input id="baseline-input" type="checkbox" ${state.align === 'bottom' ? 'checked' : ''}><span><b>Sit on a shared baseline</b>Bottom-align products instead of centring them.</span></label>
        </div>
        <div class="field">
          <span class="field-label">Export as</span>
          <div id="format-options" class="chip-row"></div>
        </div>

        <div class="rule"></div>
        <div class="recipe-meta"><span>Layout</span><strong id="layout-label"></strong></div>
        <div class="recipe-meta"><span>Output size</span><strong id="size-label"></strong></div>
        <div class="recipe-meta"><span>Combos to build</span><strong id="combo-count"></strong></div>

        <button id="generate-button" class="primary-button" disabled><span id="generate-text">Generate combos</span><span>&rarr;</span></button>
        <p id="hint" class="hint"></p>
      </section>
    </div>

    <section id="result-section" class="result-section hidden">
      <div class="result-heading">
        <div><p class="eyebrow">03 / READY TO EXPORT</p><h2 id="result-title">Your combo images</h2></div>
        <div class="result-actions">
          <button id="download-zip" class="download-button">Download all (ZIP) <span>&darr;</span></button>
        </div>
      </div>
      <div id="result-grid" class="result-grid"></div>
    </section>
  </main>
  <footer><span>Combo Maker</span><span>Local image composition tool</span></footer>
`

const el = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!

const fileInput = el<HTMLInputElement>('#file-input')
const dropzone = el<HTMLLabelElement>('#dropzone')
const productList = el<HTMLDivElement>('#product-list')
const generateButton = el<HTMLButtonElement>('#generate-button')
const generateText = el<HTMLSpanElement>('#generate-text')
const hint = el<HTMLParagraphElement>('#hint')
const resultSection = el<HTMLElement>('#result-section')
const resultGrid = el<HTMLDivElement>('#result-grid')

/* ---------------- control rendering ---------------- */

function renderControls() {
  el('#size-options').innerHTML = ([2, 3, 4] as ComboSize[])
    .map((size) => `<button class="size-option ${size === state.comboSize ? 'selected' : ''}" data-size="${size}" role="radio" aria-checked="${size === state.comboSize}"><b>${size}</b><span>products</span></button>`)
    .join('')

  el('#mode-options').innerHTML = ([
    { id: 'combinations', label: 'Every combination' },
    { id: 'repeats', label: 'Allow repeats' },
    { id: 'sequential', label: 'In upload order' },
  ] as { id: GroupMode; label: string }[])
    .map((option) => `<button class="chip ${option.id === state.mode ? 'selected' : ''}" data-mode="${option.id}">${option.label}</button>`)
    .join('')

  el('#mode-copy').textContent = {
    combinations: `Every unique set of ${state.comboSize} different products — each image appears in several combos.`,
    repeats: `Same, but a product can repeat inside a combo (A+A+B+C counts, and matches C+B+A+A). Works from a single image.`,
    sequential: `Takes your images ${state.comboSize} at a time in order; anything left over is skipped.`,
  }[state.mode]

  el('#layout-options').innerHTML = LAYOUTS[state.comboSize]
    .map((option) => `<button class="chip ${option.id === state.layout ? 'selected' : ''}" data-layout="${option.id}">${option.label}</button>`)
    .join('')

  el('#ratio-options').innerHTML = (Object.keys(RATIOS) as RatioId[])
    .map((id) => `<button class="chip ${id === state.ratio ? 'selected' : ''}" data-ratio="${id}">${RATIOS[id].label}</button>`)
    .join('')

  el('#background-options').innerHTML = BACKGROUNDS
    .map((option) => `<button class="swatch ${option.id === 'transparent' ? 'checker' : ''} ${option.id === state.background ? 'selected' : ''}" data-background="${option.id}" title="${option.label}" aria-label="${option.label}" style="${option.id === 'transparent' ? '' : `background:${option.id}`}"></button>`)
    .join('')

  el('#format-options').innerHTML = (['png', 'jpeg'] as const)
    .map((format) => `<button class="chip ${format === state.format ? 'selected' : ''}" data-format="${format}">${format === 'png' ? 'PNG' : 'JPG'}</button>`)
    .join('')

  el('#layout-label').textContent = layoutLabel(state.comboSize, state.layout)
  el('#size-label').textContent = `${RATIOS[state.ratio].width} × ${RATIOS[state.ratio].height}`

  const groups = comboGroups()
  const possible = countGroups(state.products.length, state.comboSize, state.mode)
  const capped = possible > groups.length
  const leftover = state.mode === 'sequential'
    ? state.products.length - groups.length * state.comboSize
    : 0

  el('#combo-count').textContent = groups.length
    ? capped
      ? `${groups.length} of ${possible}`
      : `${groups.length}${leftover ? ` (+${leftover} spare)` : ''}`
    : '—'

  generateButton.disabled = busy || groups.length === 0
  if (busy) return

  const needed = minimumImages(state.comboSize, state.mode)
  hint.className = 'hint'
  if (!state.products.length) {
    hint.textContent = `Add at least ${plural(needed, 'product image')} to continue.`
  } else if (!groups.length) {
    hint.textContent = `Add ${plural(needed - state.products.length, 'more image')} to complete a set of ${state.comboSize}.`
  } else if (capped) {
    hint.className = 'hint error'
    hint.textContent = `${possible} combinations possible — only the first ${MAX_COMBOS} will be built.`
  } else if (state.mode === 'combinations') {
    hint.textContent = `${plural(groups.length, 'combo')} — every set of ${state.comboSize} from your ${state.products.length} images.`
  } else if (state.mode === 'repeats') {
    hint.textContent = `${plural(groups.length, 'combo')} — every set of ${state.comboSize} from your ${state.products.length} images, repeats allowed.`
  } else {
    hint.textContent = leftover
      ? `${plural(groups.length, 'combo')} from ${groups.length * state.comboSize} images · ${leftover} left over.`
      : `${plural(groups.length, 'combo')} from all ${state.products.length} images.`
  }
}

function renderProducts() {
  el('#count-label').textContent = plural(state.products.length, 'image')
  const perSet = state.comboSize
  productList.innerHTML = state.products.length
    ? state.products
        .map((product, index) => {
          // Set numbers only mean something when combos follow upload order.
          const setIndex = Math.floor(index / perSet)
          const inFullSet = (setIndex + 1) * perSet <= state.products.length
          const badge = state.mode === 'sequential'
            ? (inFullSet ? `Set ${String(setIndex + 1).padStart(2, '0')}` : 'Spare')
            : ''
          return `<div class="product-row">
            <img src="${product.url}" alt="Product ${index + 1}">
            <span class="product-number">${String(index + 1).padStart(2, '0')}</span>
            <span class="product-name">${escapeHtml(product.file.name)}</span>
            <span class="product-set">${badge}</span>
            <span class="row-actions">
              <button class="icon-button" data-move="up" data-id="${product.id}" ${index === 0 ? 'disabled' : ''} aria-label="Move up">&uarr;</button>
              <button class="icon-button" data-move="down" data-id="${product.id}" ${index === state.products.length - 1 ? 'disabled' : ''} aria-label="Move down">&darr;</button>
              <button class="icon-button remove-button" data-remove="${product.id}" aria-label="Remove ${escapeHtml(product.file.name)}">&times;</button>
            </span>
          </div>`
        })
        .join('')
    : '<div class="empty-state">Your selected products will appear here.</div>'
}

function renderResults() {
  resultSection.classList.toggle('hidden', results.length === 0)
  el('#result-title').textContent = `Your combo ${results.length === 1 ? 'image' : 'images'}`
  resultGrid.innerHTML = results
    .map((result) => `<div class="result-card">
      <div class="result-frame"><img src="${result.url}" alt="Combo ${result.index}"></div>
      <div class="result-foot"><span>${escapeHtml(result.name)}</span><a href="${result.url}" download="${escapeHtml(result.name)}">Download</a></div>
    </div>`)
    .join('')
}

function refresh() {
  renderProducts()
  renderControls()
}

/* ---------------- product input ---------------- */

function addFiles(files: FileList | File[]) {
  const room = MAX_PRODUCTS - state.products.length
  const incoming = Array.from(files).filter((file) => file.type.startsWith('image/'))
  const accepted = incoming.slice(0, Math.max(0, room))
  state.products = [
    ...state.products,
    ...accepted.map((file) => ({ id: nextId++, file, url: URL.createObjectURL(file) })),
  ]
  refresh()
  if (incoming.length > accepted.length) {
    hint.className = 'hint error'
    hint.textContent = `Only ${MAX_PRODUCTS} images fit at once — ${incoming.length - accepted.length} were skipped.`
  }
}

function dropProduct(id: number) {
  const product = state.products.find((item) => item.id === id)
  if (!product) return
  URL.revokeObjectURL(product.url)
  prepCache.delete(`${id}:true`)
  prepCache.delete(`${id}:false`)
  state.products = state.products.filter((item) => item.id !== id)
  refresh()
}

function moveProduct(id: number, direction: 'up' | 'down') {
  const index = state.products.findIndex((item) => item.id === id)
  const target = direction === 'up' ? index - 1 : index + 1
  if (index < 0 || target < 0 || target >= state.products.length) return
  const next = [...state.products]
  ;[next[index], next[target]] = [next[target], next[index]]
  state.products = next
  refresh()
}

fileInput.addEventListener('change', () => {
  if (fileInput.files) addFiles(fileInput.files)
  fileInput.value = ''
})

productList.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const remove = target.closest<HTMLButtonElement>('[data-remove]')
  if (remove) return dropProduct(Number(remove.dataset.remove))
  const move = target.closest<HTMLButtonElement>('[data-move]')
  if (move) moveProduct(Number(move.dataset.id), move.dataset.move as 'up' | 'down')
})

dropzone.addEventListener('dragover', (event) => {
  event.preventDefault()
  dropzone.classList.add('dragging')
})
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'))
dropzone.addEventListener('drop', (event) => {
  event.preventDefault()
  dropzone.classList.remove('dragging')
  if (event.dataTransfer?.files.length) addFiles(event.dataTransfer.files)
})

/* ---------------- settings ---------------- */

el('.recipe-panel').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-size], button[data-mode], button[data-layout], button[data-ratio], button[data-background], button[data-format]')
  if (!button) return
  const { size, mode, layout, ratio, background, format } = button.dataset
  if (size) {
    state.comboSize = Number(size) as ComboSize
    state.layout = normalizeLayout(state.comboSize, state.layout)
  }
  if (mode) state.mode = mode as GroupMode
  if (layout) state.layout = layout as LayoutId
  if (ratio) state.ratio = ratio as RatioId
  if (background) state.background = background
  if (format) state.format = format as 'png' | 'jpeg'
  refresh()
})

function bindSlider(inputId: string, valueId: string, key: 'padding' | 'gap') {
  const input = el<HTMLInputElement>(inputId)
  input.addEventListener('input', () => {
    state[key] = Number(input.value)
    el(valueId).textContent = `${input.value}%`
    renderControls()
  })
}
bindSlider('#padding-input', '#padding-value', 'padding')
bindSlider('#gap-input', '#gap-value', 'gap')

el<HTMLInputElement>('#trim-input').addEventListener('change', (event) => {
  state.trim = (event.target as HTMLInputElement).checked
})
el<HTMLInputElement>('#uniform-input').addEventListener('change', (event) => {
  state.uniformScale = (event.target as HTMLInputElement).checked
})
el<HTMLInputElement>('#baseline-input').addEventListener('change', (event) => {
  state.align = (event.target as HTMLInputElement).checked ? 'bottom' : 'center'
})

/* ---------------- generation ---------------- */

async function preparedFor(product: Product): Promise<PreparedImage> {
  const key = `${product.id}:${state.trim}`
  const cached = prepCache.get(key)
  if (cached) return cached
  const prepared = await prepareImage(product.file, state.trim)
  prepCache.set(key, prepared)
  return prepared
}

function clearResults() {
  results.forEach((result) => URL.revokeObjectURL(result.url))
  results = []
}

async function generate() {
  const groups = comboGroups()
  if (!groups.length) return

  busy = true
  generateButton.disabled = true
  clearResults()

  // JPEG has no alpha channel, so a transparent request has to land on white.
  const background = state.format === 'jpeg' && state.background === 'transparent' ? '#ffffff' : state.background
  const extension = state.format === 'png' ? 'png' : 'jpg'
  const mime = state.format === 'png' ? 'image/png' : 'image/jpeg'
  const usedNames = new Set<string>()

  try {
    for (const [index, group] of groups.entries()) {
      generateText.textContent = `Composing ${index + 1} of ${groups.length}...`
      hint.className = 'hint'
      hint.textContent = `Trimming and aligning set ${index + 1}...`
      // Yield so the label above actually paints between sets.
      await new Promise((resolve) => setTimeout(resolve, 0))

      const images = await Promise.all(group.map(preparedFor))
      const canvas = composeCombo(images, {
        size: state.comboSize,
        layout: state.layout,
        ratio: state.ratio,
        background,
        padding: state.padding / 100,
        gap: state.gap / 100,
        uniformScale: state.uniformScale,
        align: state.align,
      })
      const blob = await canvasToBlob(canvas, mime, state.format === 'jpeg' ? 0.92 : undefined)
      results.push({
        name: comboName(group.map((product) => product.file.name), extension, usedNames),
        blob,
        url: URL.createObjectURL(blob),
        index: index + 1,
      })
      renderResults()
    }
    hint.className = 'hint'
    hint.textContent = `Done — ${plural(results.length, 'combo')} ready to download.`
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (error) {
    hint.className = 'hint error'
    hint.textContent = error instanceof Error ? error.message : 'Something went wrong while composing.'
  } finally {
    busy = false
    generateText.textContent = 'Generate combos'
    renderControls()
  }
}

generateButton.addEventListener('click', generate)

el('#download-zip').addEventListener('click', async () => {
  if (!results.length) return
  const entries: ZipEntry[] = await Promise.all(
    results.map(async (result) => ({
      name: result.name,
      data: new Uint8Array(await result.blob.arrayBuffer()),
    })),
  )
  const url = URL.createObjectURL(createZip(entries))
  const link = document.createElement('a')
  link.href = url
  link.download = `combos-${state.comboSize}up.zip`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})

refresh()
