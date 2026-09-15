import './style.css'
import { prepareImage, type PreparedImage } from './imageprep.ts'
import {
  DEFAULT_FRAMING,
  LAYOUTS,
  RATIOS,
  canvasToBlob,
  composeCombo,
  isFilled,
  isFramed,
  layoutLabel,
  normalizeLayout,
  type AlignId,
  type ComboSize,
  type ComposeImage,
  type ComposeOptions,
  type Framing,
  type LayoutId,
  type RatioId,
} from './compose.ts'
import { createZip, type ZipEntry } from './zip.ts'
import { comboFolder, comboName } from './naming.ts'
import { buildGroups, minimumImages, type GroupMode } from './grouping.ts'
import {
  AI_BACKGROUNDS,
  ANGLES,
  DEFAULT_ANGLES,
  MIXED_BACKGROUND,
  WHITE_BACKDROP,
  angleById,
  fillShot,
  backdropFor,
  backdropMenu,
  backdropTemplates,
  buildPrompt,
  fillProducts,
  type AngleId,
} from './angles.ts'
import {
  canvasToReference,
  cancelRun,
  describeProducts,
  estimateRun,
  comboPrompts,
  reversePrompts,
  writePrompts,
  defaultFolderName,
  fetchConfig,
  fetchRun,
  revealFolder,
  cancelDriveUpload,
  disconnectDrive,
  cloudinaryStatus,
  disconnectCloudinary,
  driveStatus,
  saveCloudinary,
  reconnectDrive,
  saveDriveClient,
  scanDriveFolder,
  startDriveUpload,
  startDriveImages,
  sendDriveImages,
  finishDriveImages,
  LISTING_SHEET_URL,
  type DriveGroup,
  deleteTemplate,
  fileToBase64,
  listTemplates,
  loadTemplate,
  saveCredentials,
  saveTemplate,
  uploadProductImages,
  appendQueue,
  beginQueue,
  sendWording,
  finishQueue,
  saveDescribeKey,
  startRun,
  toReference,
  type AiConfig,
  type CloudinaryStatus,
  type DriveStatus,
  type Estimate,
  type QueueSummary,
  type RunRequest,
  type RunItem,
  type RunSnapshot,
  type TemplateSummary,
} from './ai.ts'

type Product = { id: number; file: File; url: string; hostedUrl?: string; framing: Framing }
type Result = {
  name: string
  blob: Blob
  url: string
  index: number
  /** The product photos this combo was composed from, in frame order. */
  sources: File[]
}
type Tab = 'canvas' | 'ai'

const MANAGED_ACCESS = import.meta.env.VITE_MANAGED_ACCESS === 'true'
const INVITE_PORTAL = import.meta.env.VITE_INVITE_PORTAL === 'true'
const STATIC_HOST = import.meta.env.VITE_STATIC_HOST === 'true'
if (STATIC_HOST) document.documentElement.classList.add('static-host')

const MAX_PRODUCTS = 60

const BACKGROUNDS = [
  { id: '#ffffff', label: 'White' },
  { id: '#f7f5ef', label: 'Cream' },
  { id: '#f2f2f2', label: 'Light grey' },
  { id: 'transparent', label: 'Transparent (PNG only)' },
]

/** How often the AI run panel asks the launcher how far along it is. */
const RUN_POLL_MS = 1500

const state = {
  products: [] as Product[],
  comboSize: 2 as ComboSize,
  mode: 'combinations' as GroupMode,
  layout: 'filled' as LayoutId,
  ratio: 'square' as RatioId,
  background: '#ffffff',
  padding: 6,
  gap: 3,
  uniformScale: true,
  align: 'center' as AlignId,
  trim: true,
  format: 'png' as 'png' | 'jpeg',
}

/** Everything the AI section owns. Combo size and mode stay shared with above. */
const ai = {
  config: null as AiConfig | null,
  angles: [...DEFAULT_ANGLES] as AngleId[],
  subject: 'earrings',
  background: AI_BACKGROUNDS[0].id,
  /** Marketplaces want the first listing image on plain white; the rest sell. */
  whiteFirst: false,
  ratio: '1:1',
  model: 'soul-reference',
  resolution: '1080p',
  estimate: null as Estimate | null,
  format: 'jpeg' as 'jpeg' | 'png',
  concurrency: 3,
  outputRoot: '',
  folderName: '',
  extra: '',
  run: null as RunSnapshot | null,
  starting: false,
  /** Forces the credentials form open again once a key is already saved. */
  showConnect: false,
  /** Product id -> one-line description, from the vision model or hand-edited. */
  captions: {} as Record<number, string>,
  describeModel: '',
  describing: false,
  reverseFolder: '',
  reverseModel: '',
  reversing: false,
  reversed: [] as { file: string; prompt: string; error: string | null }[],
  drive: null as DriveStatus | null,
  cloudinary: null as CloudinaryStatus | null,
  driveFolder: '',
  driveBusy: false,
  driveFlipkart: true,
  canvasLayout: 'combo+sources' as 'combo' | 'combo+sources' | 'flat',
  queueing: false,
  queue: null as QueueSummary | null,
  templates: [] as TemplateSummary[],
  templateBusy: false,
  /** Angle id -> a prompt a top model wrote, with a {{PRODUCTS}} slot. */
  writtenPrompts: {} as Record<string, string>,
  promptModel: '',
  writing: false,
  /** Have a vision model write each combo's prompt from its own composite. */
  perCombo: false,
}

let tab: Tab = 'canvas'
/** Product id whose framing panel is open, if any. */
let framingOpen: number | null = null
let results: Result[] = []
let nextId = 1
let busy = false
let pollTimer: ReturnType<typeof setTimeout> | null = null

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

/**
 * The surface for one shot.
 *
 * A listing's first image usually has to be plain white to be accepted, while
 * the images after it are what actually sell — so the hero angle can opt out of
 * the chosen backdrop while everything else keeps it.
 */
function backdropForShot(comboIndex: number, angleIndex: number): string {
  if (ai.whiteFirst && angleIndex === 0) return WHITE_BACKDROP
  return backdropFor(ai.background, comboIndex)
}

function selectedModel() {
  return ai.config?.models.find((model) => model.id === ai.model) ?? null
}

/** Combos x angles — what one AI run will actually cost. */
function aiJobCount(): number {
  return comboGroups().length * ai.angles.length
}

const sizeOptionsHtml = () =>
  ([2, 3, 4] as ComboSize[])
    .map((size) => `<button class="size-option ${size === state.comboSize ? 'selected' : ''}" data-size="${size}" role="radio" aria-checked="${size === state.comboSize}"><b>${size}</b><span>products</span></button>`)
    .join('')

const MODE_OPTIONS: { id: GroupMode; label: string }[] = [
  { id: 'combinations', label: 'Every combination' },
  { id: 'repeats', label: 'Allow repeats' },
  { id: 'sequential', label: 'In upload order' },
]

const modeOptionsHtml = () =>
  MODE_OPTIONS
    .map((option) => `<button class="chip ${option.id === state.mode ? 'selected' : ''}" data-mode="${option.id}">${option.label}</button>`)
    .join('')

app.innerHTML = `
  <header class="topbar">
    <a class="brand" href="."><span class="brand-mark">CM</span><span>Combo Maker</span></a>
    <div class="account-actions">${INVITE_PORTAL ? '<form method="post" action="/auth/logout"><button class="link-button" type="submit">Sign out</button></form>' : ''}<span class="local-pill"><span class="status-dot"></span>${MANAGED_ACCESS ? 'Invite-only access' : STATIC_HOST ? 'Runs in your browser' : 'Runs locally'}</span></div>
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

    ${STATIC_HOST ? '<p class="hosting-note">Create and download combos on your phone, tablet, or computer. Photos stay in this browser and are not saved after you close or refresh the page. AI, saved templates, Google Drive, and image hosting require the local app. <a href="https://github.com/sahilajmani00-hub/combo-maker#run-it">Local app setup</a> · <a href="./privacy.html">Privacy policy</a></p>' : ''}
    <div class="mode-switch" role="tablist" aria-label="Combo builder">
      <button class="mode-tab selected" data-tab="canvas" role="tab" aria-selected="true"><b>Canvas combos</b><span>Arrange the real photos side by side. Offline and free.</span></button>
      <button class="mode-tab" data-tab="ai" role="tab" aria-selected="false"><b>AI angle combos</b><span>Higgsfield re-shoots each set from several camera angles.</span></button>
    </div>

    <div class="workspace">
      <section class="panel setup-panel">
        <div class="panel-heading">
          <div><span class="step">01</span><h2>Add products</h2></div>
          <div class="heading-actions">
            <button id="get-product-urls" class="link-button" disabled>Get image URLs</button>
            <button id="copy-all-urls" class="link-button hidden">Copy all URLs</button>
            <button id="download-products-zip" class="link-button" disabled>Download all</button>
            <span id="count-label" class="count-label">0 images</span>
          </div>
        </div>
        <p id="product-urls-status" class="hint hidden"></p>
        <label class="dropzone" id="dropzone" for="file-input">
          <input id="file-input" type="file" accept="image/*" multiple>
          <span class="upload-icon">+</span><strong>Drop product images here</strong><span>or <u>browse your files</u></span>
          <small>JPG, PNG or WEBP · up to ${MAX_PRODUCTS} images · or paste with &#8984;V</small>
        </label>
        <div id="product-list" class="product-list"></div>

        <div class="rule server-feature"></div>
        <div class="field server-feature">
          <span class="field-label">Templates</span>
          <div class="template-row">
            <input id="template-name" class="text-input" type="text" placeholder="Name this setup" spellcheck="false">
            <button id="template-save" class="ghost-button">Save</button>
          </div>
          <div id="template-list" class="template-list"></div>
          <p class="mode-copy">Saves your photos and every setting to disk, so a refresh — or a new browser — picks up exactly where you left off. Saving over a name replaces it.</p>
        </div>

        <div class="rule server-feature"></div>
        <div class="field server-feature">
          <span class="field-label">Google Drive</span>
          <div id="drive-connect" class="connect-box">
            <div id="drive-reconnect-row" class="hidden">
              <button id="drive-reconnect" class="ghost-button">Reconnect Google Drive</button>
              <p class="mode-copy">Your OAuth client is still saved — this just asks Google for access again.</p>
            </div>
            <div class="connect-fields">
              <input id="drive-client-id" type="text" placeholder="OAuth client ID" autocomplete="off" spellcheck="false">
              <input id="drive-client-secret" type="password" placeholder="Client secret" autocomplete="off">
            </div>
            <button id="drive-save" class="ghost-button">Connect Google Drive</button>
            <p class="mode-copy">Create a <b>Desktop app</b> OAuth client at <b>console.cloud.google.com</b> with the Drive API enabled, and paste its ID and secret. Access is limited to files this app creates — it cannot see the rest of your Drive. Works from either tab once connected.</p>
          </div>
          <div id="drive-connected-row" class="hidden">
            <span class="count-label connected">Google Drive connected</span>
            <button id="drive-disconnect" class="link-button">Disconnect</button>
          </div>
        </div>

        <div class="rule server-feature"></div>
        <div class="field server-feature">
          <span class="field-label">Durable image URLs</span>
          <div id="cloudinary-connect" class="connect-box">
            <div class="connect-fields">
              <input id="cloudinary-cloud" type="text" placeholder="Cloud name" autocomplete="off" spellcheck="false">
              <input id="cloudinary-key" type="text" placeholder="API key" autocomplete="off" spellcheck="false">
              <input id="cloudinary-secret" type="password" placeholder="API secret" autocomplete="off">
            </div>
            <button id="cloudinary-save" class="ghost-button">Connect Cloudinary</button>
            <p id="cloudinary-status" class="hint hidden"></p>
            <p class="mode-copy">Optional, but worth it before a listing run. Drive serves images through a Google address that is undocumented and has broken before; Cloudinary URLs are permanent and on a real CDN, so the links in your sheet still work days later. Sign up free at <b>cloudinary.com</b>, then either fill the three boxes or just paste the dashboard's <b>API environment variable</b> (<code>cloudinary://key:secret@cloud</code>) into any one of them. Without this the sheet falls back to Drive URLs.</p>
          </div>
          <div id="cloudinary-connected-row" class="hidden">
            <span id="cloudinary-name" class="count-label connected">Cloudinary connected</span>
            <a id="cloudinary-proof" class="link-button hidden" target="_blank" rel="noopener">View test image</a>
            <button id="cloudinary-disconnect" class="link-button">Disconnect</button>
          </div>
          <p id="cloudinary-saved-copy" class="mode-copy">Saved to the launcher's settings file and reused on every run — entered once, not per session.</p>
        </div>
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
          <p id="layout-copy" class="mode-copy"></p>
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
        <div class="recipe-meta"><span>Example name</span><strong id="combo-example">—</strong></div>

        <button id="generate-button" class="primary-button" disabled><span id="generate-text">Generate combos</span><span>&rarr;</span></button>
        <p id="hint" class="hint"></p>
      </section>

      <section class="panel ai-panel hidden">
        <div class="panel-heading">
          <div><span class="step">02</span><h2>Shoot with Higgsfield</h2></div>
          <button id="ai-connection" class="count-label link-button"></button>
        </div>
        <p class="section-copy">Every combo is re-photographed by Higgsfield once per camera angle you tick, and saved straight into a folder of its own.</p>

        <div id="ai-connect" class="connect-box">
          <span class="field-label">Higgsfield API credentials</span>
          <div class="connect-fields">
            <input id="ai-key-id" type="text" placeholder="Key ID" autocomplete="off" spellcheck="false">
            <input id="ai-key-secret" type="password" placeholder="Key secret" autocomplete="off">
          </div>
          <button id="ai-connect-button" class="ghost-button">Connect</button>
          <p class="mode-copy">Create a key pair at <b>cloud.higgsfield.ai</b>. It is saved to a local <code>.env</code> file and used only by the launcher window — the browser tab never receives it.</p>
        </div>

        <div class="rule"></div>
        <p class="section-copy">How many products should sit in one image?</p>
        <div id="ai-size-options" class="size-options" role="radiogroup" aria-label="Combo size"></div>

        <div class="field" style="margin-top:18px">
          <span class="field-label">Which combos to build</span>
          <div id="ai-mode-options" class="chip-row"></div>
          <p id="ai-mode-copy" class="mode-copy"></p>
        </div>

        <div class="field">
          <span class="field-label">Camera angles</span>
          <div id="ai-angle-options" class="chip-row"></div>
          <p class="mode-copy">Each angle is a separate generation, so four angles cost four times one.</p>
        </div>

        <div class="field">
          <span class="field-label">What are these products?</span>
          <input id="ai-subject" class="text-input" type="text" value="${escapeHtml(ai.subject)}" placeholder="earrings" spellcheck="false">
        </div>
        <div class="field">
          <span class="field-label">Describe the products <em>(optional)</em></span>
          <div id="ai-describe-connect" class="connect-box">
            <input id="ai-or-key" type="password" placeholder="OpenRouter API key" autocomplete="off">
            <button id="ai-or-connect" class="ghost-button">Connect</button>
            <p class="mode-copy">A vision model names each product so the prompt can hold it steady — the difference between "keep the products unchanged" and "keep the brushed-gold hoop with a pearl drop". Key from <b>openrouter.ai</b>, stored in the same local <code>.env</code>.</p>
          </div>
          <div id="ai-describe-run">
            <div id="ai-describe-models" class="chip-row"></div>
            <button id="ai-describe-button" class="ghost-button">Describe my products</button>
          </div>
          <div id="ai-caption-list" class="caption-list"></div>
        </div>
        <div class="field">
          <span class="field-label">Backdrop</span>
          <div id="ai-background-options" class="chip-row"></div>
        </div>
        <label class="toggle"><input id="ai-white-first" type="checkbox"><span><b>First angle on plain white</b>The hero shot every marketplace wants, with the remaining angles on the backdrop above.</span></label>
        <div class="field">
          <span class="field-label">Frame</span>
          <div id="ai-ratio-options" class="chip-row"></div>
        </div>
        <div class="field">
          <span class="field-label">Model</span>
          <div id="ai-model-options" class="chip-row"></div>
          <p id="ai-model-copy" class="mode-copy"></p>
        </div>
        <div class="field" id="ai-resolution-field">
          <span class="field-label">Resolution</span>
          <div id="ai-resolution-options" class="chip-row"></div>
        </div>
        <div class="field">
          <span class="field-label">Save as</span>
          <div id="ai-format-options" class="chip-row"></div>
        </div>
        <div class="field">
          <span class="field-label">Prompt quality</span>
          <div id="ai-prompt-models" class="chip-row"></div>
          <div id="ai-write-row">
            <button id="ai-write-button" class="ghost-button">Write prompts with AI</button>
            <button id="ai-write-clear" class="link-button hidden">Use the built-in prompt</button>
          </div>
          <p id="ai-write-copy" class="mode-copy"></p>
          <label class="toggle"><input id="ai-per-combo" type="checkbox"><span><b>Read each combo image</b><span id="ai-per-combo-copy"></span></span></label>
        </div>
        <div class="field">
          <span class="field-label">Learn from finished images</span>
          <div id="ai-reverse-models" class="chip-row"></div>
          <input id="ai-reverse-folder" class="text-input" type="text" placeholder="Folder holding the images you generated" spellcheck="false">
          <div id="ai-write-row">
            <button id="ai-reverse-button" class="ghost-button">Write prompts from my images</button>
            <button id="ai-reverse-open" class="link-button hidden">Open folder</button>
          </div>
          <p id="ai-reverse-copy" class="mode-copy"></p>
          <div id="ai-reverse-list" class="caption-list"></div>
        </div>
        <div class="field">
          <span class="field-label">Anything else to tell the model</span>
          <textarea id="ai-extra" class="text-input" rows="2" placeholder="e.g. shot on a dark walnut tray, warm gold light"></textarea>
        </div>

        <div class="rule"></div>

        <div class="field">
          <span class="field-label">Save into</span>
          <input id="ai-output-root" class="text-input" type="text" placeholder="/Users/you/Pictures/combos" spellcheck="false">
        </div>
        <div class="field">
          <span class="field-label">Master folder name</span>
          <input id="ai-folder-name" class="text-input" type="text" spellcheck="false">
        </div>
        <div class="field">
          <span class="field-label">Generate at once</span>
          <div class="slider-row">
            <input id="ai-concurrency" type="range" min="1" max="8" step="1" value="${ai.concurrency}">
            <span id="ai-concurrency-value" class="slider-value">${ai.concurrency}</span>
          </div>
        </div>

        <div class="rule"></div>
        <div class="field">
          <span class="field-label">Upload a finished folder to Drive</span>
          <div id="drive-ready" class="hidden">
            <input id="drive-folder" class="text-input" type="text" placeholder="Folder of images to upload" spellcheck="false">
            <label class="toggle"><input id="drive-flipkart" type="checkbox" checked><span><b>Flipkart bulk-listing layout</b>One public master folder, a sub-folder per SKU, images renamed 1, 2, 3 — the structure Flipkart's AI auto-fill reads. Off uploads the folder as-is.</span></label>
            <div id="ai-write-row">
              <button id="drive-upload" class="ghost-button">Create folder &amp; upload</button>
              <button id="drive-open" class="link-button hidden">Open in Drive</button>
              <button id="drive-sheet" class="link-button" disabled>Listing sheet (XLSX)</button>
              <button id="drive-stop" class="link-button hidden">Stop</button>
            </div>
          </div>
          <p id="drive-copy" class="mode-copy"></p>
          <p id="drive-locked-copy" class="mode-copy">Connect Google Drive above (Add products panel) to enable this.</p>
        </div>

        <div class="rule"></div>
        <div class="recipe-meta"><span>Combos</span><strong id="ai-combo-count">—</strong></div>
        <div class="recipe-meta"><span>Angles each</span><strong id="ai-angle-count">—</strong></div>
        <div class="recipe-meta"><span>Images to generate</span><strong id="ai-job-count">—</strong></div>
        <div class="recipe-meta"><span>Example folder</span><strong id="ai-combo-example">—</strong></div>
        <div class="recipe-meta"><span>Estimated cost</span><strong id="ai-cost">—</strong></div>

        <button id="ai-generate-button" class="primary-button" disabled><span id="ai-generate-text">Generate with Higgsfield</span><span>&rarr;</span></button>
        <button id="ai-queue-button" class="ghost-button wide-button" disabled><span id="ai-queue-text">Send to extension</span></button>
        <button id="ai-queue-stop" class="link-button hidden">Stop</button>
        <p class="mode-copy">Writes the reference images and prompts to a folder and hands them to the Combo Maker browser extension, so you can upload and download them yourself on higgsfield.ai. Costs nothing.</p>
        <p id="ai-hint" class="hint"></p>
      </section>
    </div>

    <section id="result-section" class="result-section hidden">
      <div class="result-heading">
        <div><p class="eyebrow">03 / READY TO EXPORT</p><h2 id="result-title">Your combo images</h2></div>
        <div class="result-actions">
          <div id="canvas-layout-options" class="chip-row result-chips"></div>
          <button id="canvas-sheet" class="download-button ghost" disabled>Listing sheet (XLSX)</button>
          <button id="canvas-drive-upload" class="download-button ghost">Save to Drive</button>
          <button id="canvas-drive-stop" class="download-button ghost hidden">Stop</button>
          <button id="download-zip" class="download-button">Download all (ZIP) <span>&darr;</span></button>
        </div>
      </div>
      <p id="canvas-drive-copy" class="hint"></p>
      <div id="result-grid" class="result-grid"></div>
    </section>

    <section id="ai-result-section" class="result-section hidden">
      <div class="result-heading">
        <div>
          <p class="eyebrow">03 / HIGGSFIELD</p>
          <h2 id="ai-result-title">Shooting your combos</h2>
          <p id="ai-result-path" class="mode-copy"></p>
        </div>
        <div class="result-actions">
          <button id="ai-open-folder" class="download-button ghost">Open folder</button>
          <button id="ai-cancel" class="download-button">Stop run</button>
        </div>
      </div>
      <div class="progress"><div id="ai-progress-bar" class="progress-bar"></div></div>
      <p id="ai-progress-copy" class="hint"></p>
      <div id="ai-run-grid" class="combo-grid"></div>
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

const aiPanel = el<HTMLElement>('.ai-panel')
const recipePanel = el<HTMLElement>('.recipe-panel')
const aiGenerateButton = el<HTMLButtonElement>('#ai-generate-button')
const aiGenerateText = el<HTMLSpanElement>('#ai-generate-text')
const aiHint = el<HTMLParagraphElement>('#ai-hint')
const aiResultSection = el<HTMLElement>('#ai-result-section')
const aiRunGrid = el<HTMLDivElement>('#ai-run-grid')

/* ---------------- control rendering ---------------- */

function renderControls() {
  el('#size-options').innerHTML = sizeOptionsHtml()
  el('#mode-options').innerHTML = modeOptionsHtml()

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

  const filled = isFilled(state.layout)
  el('#layout-copy').textContent = filled
    ? 'Every photo fills its cell edge to edge and is cropped to fit — no margins, no gaps. Outer margin, gap, trimming and size-matching do not apply.'
    : 'Products are fitted inside their cells, so the margin, gap and alignment settings below shape the result.'
  // The settings a filled grid ignores are switched off rather than left to
  // look as though they still do something.
  for (const selector of ['#padding-input', '#gap-input', '#trim-input', '#uniform-input', '#baseline-input']) {
    el<HTMLInputElement>(selector).disabled = filled
  }

  el('#layout-label').textContent = layoutLabel(state.comboSize, state.layout)
  el('#size-label').textContent = `${RATIOS[state.ratio].width} × ${RATIOS[state.ratio].height}`

  const groups = comboGroups()
  const leftover = state.mode === 'sequential'
    ? state.products.length - groups.length * state.comboSize
    : 0

  el('#combo-count').textContent = groups.length
    ? `${groups.length}${leftover ? ` (+${leftover} spare)` : ''}`
    : '—'
  // Seeing the first one is the quickest way to tell whether the names are worth
  // fixing before a run of several hundred folders is written.
  el('#combo-example').textContent = groups.length
    ? comboName(groups[0].map((product) => product.file.name), state.format === 'png' ? 'png' : 'jpg', new Set())
    : '—'

  generateButton.disabled = busy || groups.length === 0
  if (busy) return

  const needed = minimumImages(state.comboSize, state.mode)
  hint.className = 'hint'
  if (!state.products.length) {
    hint.textContent = `Add at least ${plural(needed, 'product image')} to continue.`
  } else if (!groups.length) {
    hint.textContent = `Add ${plural(needed - state.products.length, 'more image')} to complete a set of ${state.comboSize}.`
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

/** The part of a filename a combo name is actually built from. */
const nameStem = (fileName: string) => fileName.replace(/\.[a-z0-9]+$/i, '')

/**
 * Renames a product.
 *
 * Combo names — the export filename and the folder the extension writes into —
 * are built by joining these with "&", so "pasted-01&pasted-06" is what an
 * unnamed paste turns into. Being able to fix that here is the difference
 * between a readable output folder and 378 unreadable ones.
 */
function renameProduct(id: number, stem: string) {
  const product = state.products.find((item) => item.id === id)
  if (!product) return
  const extension = /\.[a-z0-9]+$/i.exec(product.file.name)?.[0] ?? ''
  // The File itself is renamed rather than kept alongside a label, so every
  // path that already reads file.name — naming, templates, queue — follows.
  product.file = new File([product.file], `${stem.trim() || 'image'}${extension}`, { type: product.file.type })
}

function renderProducts() {
  el('#count-label').textContent = plural(state.products.length, 'image')
  el<HTMLButtonElement>('#download-products-zip').disabled = state.products.length === 0
  const urlsButton = el<HTMLButtonElement>('#get-product-urls')
  const hosting = Boolean(ai.cloudinary?.configured)
  urlsButton.disabled = state.products.length === 0 || !hosting
  urlsButton.title = hosting ? '' : 'Connect Cloudinary in this panel first.'
  el('#copy-all-urls').classList.toggle('hidden', !state.products.some((product) => product.hostedUrl))
  // Rewriting the list while a name is being typed would steal the caret. Only
  // that one field is protected: every other control in the list expects the
  // rows to redraw underneath it.
  if ((document.activeElement as HTMLElement | null)?.dataset.rename) return
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
          const open = framingOpen === product.id
          return `<div class="product-row">
            <img src="${product.url}" alt="Product ${index + 1}">
            <span class="product-number">${String(index + 1).padStart(2, '0')}</span>
            <input class="product-name" type="text" data-rename="${product.id}" value="${escapeHtml(nameStem(product.file.name))}" spellcheck="false" aria-label="Name for product ${index + 1}">
            <span class="product-set">${badge}</span>
            <span class="row-actions">
              ${product.hostedUrl
                ? `<button class="icon-button" data-copy-url="${product.id}" title="Copy image URL" aria-label="Copy image URL for ${escapeHtml(product.file.name)}">&#128279;</button>`
                : ''}
              <button class="icon-button framing-button${isFramed(product.framing) ? ' framed' : ''}${open ? ' open' : ''}" data-framing="${product.id}" aria-expanded="${open}" title="Adjust how this photo sits in every combo" aria-label="Adjust framing for ${escapeHtml(product.file.name)}">&#10530;</button>
              <a class="icon-button" href="${product.url}" download="${escapeHtml(product.file.name)}" title="Download" aria-label="Download ${escapeHtml(product.file.name)}">&dArr;</a>
              <button class="icon-button" data-move="up" data-id="${product.id}" ${index === 0 ? 'disabled' : ''} aria-label="Move up">&uarr;</button>
              <button class="icon-button" data-move="down" data-id="${product.id}" ${index === state.products.length - 1 ? 'disabled' : ''} aria-label="Move down">&darr;</button>
              <button class="icon-button remove-button" data-remove="${product.id}" aria-label="Remove ${escapeHtml(product.file.name)}">&times;</button>
            </span>
          </div>${open ? framingPanel(product) : ''}`
        })
        .join('')
    : '<div class="empty-state">Your selected products will appear here.</div>'

  if (framingOpen === null) return
  const product = state.products.find((item) => item.id === framingOpen)
  if (product) void renderFramingPreview(product)
  else framingOpen = null
}

/** `per` is what one slider step is worth, so degrees stay degrees. */
const FRAMING_SLIDERS = [
  { key: 'zoom', label: 'Zoom', min: 50, max: 250, per: 100, unit: '%' },
  { key: 'rotate', label: 'Rotate', min: -180, max: 180, per: 1, unit: '°' },
  { key: 'x', label: 'Left / right', min: -100, max: 100, per: 100, unit: '%' },
  { key: 'y', label: 'Up / down', min: -100, max: 100, per: 100, unit: '%' },
] as const

function framingPanel(product: Product): string {
  const sliders = FRAMING_SLIDERS.map((slider) => {
    const value = Math.round(product.framing[slider.key] * slider.per)
    return `<label class="framing-slider">
      <span class="framing-label">${slider.label}</span>
      <input type="range" min="${slider.min}" max="${slider.max}" step="1" value="${value}" data-framing-input="${slider.key}" data-id="${product.id}">
      <span class="slider-value" data-framing-value="${slider.key}">${value}${slider.unit}</span>
    </label>`
  }).join('')
  return `<div class="framing-panel">
    <div class="framing-preview" data-framing-preview="${product.id}"></div>
    <div class="framing-controls">
      ${sliders}
      <div class="framing-foot">
        <p class="mode-copy">Every combo using this photo gets the same framing. Generate again to rebuild them.</p>
        <button class="chip" data-framing-reset="${product.id}">Reset</button>
      </div>
    </div>
  </div>`
}

/**
 * The first combo this photo lands in, composed exactly as the real run would.
 *
 * Framing is a property of the photo rather than of one combo, so showing it
 * inside a genuine combo is the only preview that answers the question being
 * asked — what this change does to all of them.
 */
let framingPreviewToken = 0
async function renderFramingPreview(product: Product) {
  const token = ++framingPreviewToken
  const box = productList.querySelector<HTMLDivElement>(`[data-framing-preview="${product.id}"]`)
  if (!box) return
  const group = comboGroups().find((items) => items.some((item) => item.id === product.id)) ?? [product]
  const canvas = composeCombo(await framedImages(group), canvasOptions())
  // Decoding is async, so the panel may have closed or been overtaken by a
  // later drag by the time the photos are ready.
  if (token !== framingPreviewToken || !box.isConnected) return
  canvas.className = 'framing-canvas'
  box.replaceChildren(canvas)
}

function renderResults() {
  resultSection.classList.toggle('hidden', tab !== 'canvas' || results.length === 0)
  el('#result-title').textContent = `Your combo ${results.length === 1 ? 'image' : 'images'}`
  resultGrid.innerHTML = results
    .map((result) => `<div class="result-card">
      <div class="result-frame"><img src="${result.url}" alt="Combo ${result.index}"></div>
      <div class="result-foot"><span>${escapeHtml(result.name)}</span><a href="${result.url}" download="${escapeHtml(result.name)}">Download</a></div>
    </div>`)
    .join('')
  // Keeps the canvas tab's "Save to Drive" button in sync even when results
  // change outside a full refresh() — generate() renders incrementally.
  renderDrive()
}

/**
 * Everything a template carries besides the photos.
 *
 * Both halves of the app are included on purpose: the canvas settings decide
 * what the AI reference composite looks like, so restoring one without the
 * other would give a different result from the one that was saved.
 */
function currentSettings(): Record<string, unknown> {
  return {
    canvas: { ...state, products: undefined },
    // Framing belongs to the photo, and ids are reassigned on load, so it
    // travels by position just like the captions below.
    framing: state.products.map((product) => product.framing),
    ai: {
      angles: ai.angles,
      subject: ai.subject,
      background: ai.background,
      ratio: ai.ratio,
      model: ai.model,
      resolution: ai.resolution,
      format: ai.format,
      concurrency: ai.concurrency,
      extra: ai.extra,
      outputRoot: ai.outputRoot,
      folderName: ai.folderName,
      describeModel: ai.describeModel,
      promptModel: ai.promptModel,
      whiteFirst: ai.whiteFirst,
      perCombo: ai.perCombo,
      writtenPrompts: ai.writtenPrompts,
      // Captions are keyed by product id, which is reassigned on load, so they
      // travel by position instead.
      captions: state.products.map((product) => ai.captions[product.id] ?? ''),
    },
  }
}

function applySettings(settings: Record<string, unknown>) {
  const canvas = (settings.canvas ?? {}) as Partial<typeof state>
  Object.assign(state, canvas, { products: state.products })
  state.layout = normalizeLayout(state.comboSize, state.layout)

  const saved = (settings.ai ?? {}) as Record<string, unknown>
  const captions = Array.isArray(saved.captions) ? (saved.captions as string[]) : []
  ai.angles = (saved.angles as AngleId[]) ?? ai.angles
  ai.subject = (saved.subject as string) ?? ai.subject
  ai.background = (saved.background as string) ?? ai.background
  ai.ratio = (saved.ratio as string) ?? ai.ratio
  ai.model = (saved.model as string) ?? ai.model
  ai.resolution = (saved.resolution as string) ?? ai.resolution
  ai.format = (saved.format as 'jpeg' | 'png') ?? ai.format
  ai.concurrency = (saved.concurrency as number) ?? ai.concurrency
  ai.extra = (saved.extra as string) ?? ai.extra
  ai.outputRoot = (saved.outputRoot as string) ?? ai.outputRoot
  ai.folderName = (saved.folderName as string) ?? ai.folderName
  ai.describeModel = (saved.describeModel as string) ?? ai.describeModel
  ai.promptModel = (saved.promptModel as string) ?? ai.promptModel
  ai.whiteFirst = Boolean(saved.whiteFirst)
  ai.perCombo = Boolean(saved.perCombo)
  ai.writtenPrompts = (saved.writtenPrompts as Record<string, string>) ?? {}
  ai.captions = {}
  const framing = Array.isArray(settings.framing) ? (settings.framing as Partial<Framing>[]) : []
  state.products.forEach((product, index) => {
    if (captions[index]) ai.captions[product.id] = captions[index]
    product.framing = { ...DEFAULT_FRAMING, ...framing[index] }
  })

  // The controls read their values from state on render, except the free-text
  // boxes and sliders, which hold their own.
  el<HTMLInputElement>('#ai-subject').value = ai.subject
  el<HTMLTextAreaElement>('#ai-extra').value = ai.extra
  el<HTMLInputElement>('#padding-input').value = String(state.padding)
  el('#padding-value').textContent = `${state.padding}%`
  el<HTMLInputElement>('#gap-input').value = String(state.gap)
  el('#gap-value').textContent = `${state.gap}%`
  el<HTMLInputElement>('#trim-input').checked = state.trim
  el<HTMLInputElement>('#uniform-input').checked = state.uniformScale
  el<HTMLInputElement>('#baseline-input').checked = state.align === 'bottom'
  el<HTMLInputElement>('#ai-white-first').checked = ai.whiteFirst
  el<HTMLInputElement>('#ai-concurrency').value = String(ai.concurrency)
  el('#ai-concurrency-value').textContent = String(ai.concurrency)
}

function renderTemplates() {
  const list = el('#template-list')
  list.innerHTML = ai.templates.length
    ? ai.templates
        .map((template) => `<div class="template-item">
          <span class="template-meta"><b>${escapeHtml(template.name)}</b>${plural(template.productCount, 'image')}${template.savedAt ? ` · ${new Date(template.savedAt).toLocaleDateString()}` : ''}</span>
          <span class="template-actions">
            <button class="chip" data-template-load="${template.id}">Load</button>
            <button class="icon-button remove-button" data-template-delete="${template.id}" aria-label="Delete ${escapeHtml(template.name)}">&times;</button>
          </span>
        </div>`)
        .join('')
    : '<div class="empty-state">No saved templates yet.</div>'
}

function renderTabs() {
  document.querySelectorAll<HTMLButtonElement>('.mode-tab').forEach((button) => {
    const selected = button.dataset.tab === tab
    button.classList.toggle('selected', selected)
    button.setAttribute('aria-selected', String(selected))
  })
  recipePanel.classList.toggle('hidden', tab !== 'canvas')
  aiPanel.classList.toggle('hidden', tab !== 'ai')
}

function refresh() {
  renderTabs()
  renderTemplates()
  renderProducts()
  renderControls()
  renderAiControls()
  renderResults()
  renderAiRun()
}

/* ---------------- product input ---------------- */

function addFiles(files: FileList | File[]) {
  const room = MAX_PRODUCTS - state.products.length
  const incoming = Array.from(files).filter((file) => file.type.startsWith('image/'))
  const accepted = incoming.slice(0, Math.max(0, room))
  state.products = [
    ...state.products,
    ...accepted.map((file) => ({ id: nextId++, file, url: URL.createObjectURL(file), framing: { ...DEFAULT_FRAMING } })),
  ]
  refresh()
  if (incoming.length > accepted.length) {
    const message = `Only ${MAX_PRODUCTS} images fit at once — ${incoming.length - accepted.length} were skipped.`
    const target = tab === 'ai' ? aiHint : hint
    target.className = 'hint error'
    target.textContent = message
  }
}

function dropProduct(id: number) {
  const product = state.products.find((item) => item.id === id)
  if (!product) return
  URL.revokeObjectURL(product.url)
  prepCache.delete(`${id}:true`)
  prepCache.delete(`${id}:false`)
  delete ai.captions[id]
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

/**
 * Pasted images arrive without a useful filename — a screenshot is "image.png"
 * every time — and combo names are built from filenames, so every combo would
 * end up called "image". Anything generic gets numbered instead.
 */
let pastedCount = 0
const GENERIC_NAME = /^(image|screenshot|photo|unknown|pasted)\b|^$/i

function namePasted(file: File): File {
  const base = file.name.replace(/\.[a-z0-9]+$/i, '')
  if (!GENERIC_NAME.test(base)) return file
  pastedCount += 1
  const extension = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
  return new File([file], `pasted-${String(pastedCount).padStart(2, '0')}.${extension}`, { type: file.type })
}

/**
 * Paste anywhere on the page to add products.
 *
 * Skipped while a text field has focus, so pasting into the subject or extra
 * notes boxes still does what it should.
 */
document.addEventListener('paste', (event) => {
  const active = document.activeElement as HTMLElement | null
  const tag = active?.tagName
  if (tag === 'TEXTAREA' || (tag === 'INPUT' && (active as HTMLInputElement).type !== 'file')) return

  const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'))
  if (!images.length) return
  event.preventDefault()

  const before = state.products.length
  addFiles(images.map(namePasted))
  const added = state.products.length - before
  if (!added) return
  const target = tab === 'ai' ? aiHint : hint
  target.className = 'hint'
  target.textContent = `Pasted ${plural(added, 'image')}.`
})

fileInput.addEventListener('change', () => {
  if (fileInput.files) addFiles(fileInput.files)
  fileInput.value = ''
})

productList.addEventListener('input', (event) => {
  const input = event.target as HTMLInputElement
  if (input.dataset.rename) {
    renameProduct(Number(input.dataset.rename), input.value)
    renderControls()
    renderAiControls()
    return
  }
  const slider = FRAMING_SLIDERS.find((entry) => entry.key === input.dataset.framingInput)
  if (!slider) return
  const product = state.products.find((item) => item.id === Number(input.dataset.id))
  if (!product) return
  product.framing = { ...product.framing, [slider.key]: Number(input.value) / slider.per }
  // Redrawing the whole list mid-drag would tear the slider out from under the
  // pointer, so the pieces that changed are updated in place.
  const readout = input.parentElement?.querySelector(`[data-framing-value="${slider.key}"]`)
  if (readout) readout.textContent = `${input.value}${slider.unit}`
  productList.querySelector(`[data-framing="${product.id}"]`)?.classList.toggle('framed', isFramed(product.framing))
  void renderFramingPreview(product)
})

productList.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const remove = target.closest<HTMLButtonElement>('[data-remove]')
  if (remove) return dropProduct(Number(remove.dataset.remove))
  const move = target.closest<HTMLButtonElement>('[data-move]')
  if (move) return moveProduct(Number(move.dataset.id), move.dataset.move as 'up' | 'down')
  const copy = target.closest<HTMLButtonElement>('[data-copy-url]')
  if (copy) {
    const product = state.products.find((item) => item.id === Number(copy.dataset.copyUrl))
    if (product?.hostedUrl) void copyText(product.hostedUrl, 'Image URL copied.')
    return
  }
  const adjust = target.closest<HTMLButtonElement>('[data-framing]')
  if (adjust) {
    const id = Number(adjust.dataset.framing)
    framingOpen = framingOpen === id ? null : id
    renderProducts()
    if (framingOpen !== null) {
      productList.querySelector(`[data-framing-preview="${framingOpen}"]`)
        ?.closest('.framing-panel')
        ?.scrollIntoView({ block: 'nearest' })
    }
    return
  }
  const reset = target.closest<HTMLButtonElement>('[data-framing-reset]')
  if (reset) {
    const product = state.products.find((item) => item.id === Number(reset.dataset.framingReset))
    if (!product) return
    product.framing = { ...DEFAULT_FRAMING }
    renderProducts()
  }
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

/* ---------------- templates ---------------- */

async function refreshTemplates() {
  try {
    ai.templates = (await listTemplates()).templates
  } catch {
    // No launcher (opened off disk, or vite dev alone) — the rest still works.
    ai.templates = []
  }
  renderTemplates()
}

el('#template-save').addEventListener('click', async () => {
  const field = el<HTMLInputElement>('#template-name')
  const name = field.value.trim()
  if (!name) {
    hint.className = 'hint error'
    hint.textContent = 'Give the template a name first.'
    return
  }
  const button = el<HTMLButtonElement>('#template-save')
  button.disabled = true
  button.textContent = 'Saving...'
  try {
    const products = await Promise.all(
      state.products.map(async (product) => ({
        name: product.file.name,
        type: product.file.type,
        data: await fileToBase64(product.file),
      })),
    )
    ai.templates = (await saveTemplate({ name, products, settings: currentSettings() })).templates
    hint.className = 'hint'
    hint.textContent = `Saved "${name}" — ${plural(products.length, 'image')} and every setting.`
  } catch (error) {
    hint.className = 'hint error'
    hint.textContent = error instanceof Error ? error.message : 'Could not save that template.'
  } finally {
    button.disabled = false
    button.textContent = 'Save'
    renderTemplates()
  }
})

el('#template-list').addEventListener('click', async (event) => {
  const target = event.target as HTMLElement
  const load = target.closest<HTMLButtonElement>('[data-template-load]')
  const remove = target.closest<HTMLButtonElement>('[data-template-delete]')
  if (!load && !remove) return

  if (remove) {
    const id = remove.dataset.templateDelete!
    if (!window.confirm('Delete this template? The photos saved inside it go too.')) return
    try {
      ai.templates = (await deleteTemplate(id)).templates
    } catch (error) {
      hint.className = 'hint error'
      hint.textContent = error instanceof Error ? error.message : 'Could not delete that template.'
    }
    renderTemplates()
    return
  }

  const id = load!.dataset.templateLoad!
  if (state.products.length && !window.confirm('Load this template? It replaces the products and settings on screen.')) return
  try {
    const template = await loadTemplate(id)
    // Out with the old object URLs first, or they leak for the tab's lifetime.
    state.products.forEach((product) => URL.revokeObjectURL(product.url))
    prepCache.clear()
    state.products = template.products.map((product) => {
      const bytes = Uint8Array.from(atob(product.data), (char) => char.charCodeAt(0))
      const file = new File([bytes], product.name, { type: product.type })
      return { id: nextId++, file, url: URL.createObjectURL(file), framing: { ...DEFAULT_FRAMING } }
    })
    applySettings(template.settings)
    el<HTMLInputElement>('#template-name').value = template.name
    refresh()
    hint.className = 'hint'
    hint.textContent = `Loaded "${template.name}" — ${plural(state.products.length, 'image')}.`
  } catch (error) {
    hint.className = 'hint error'
    hint.textContent = error instanceof Error ? error.message : 'Could not load that template.'
  }
})

el('.mode-switch').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]')
  if (!button) return
  tab = button.dataset.tab as Tab
  refresh()
})

/* ---------------- settings ---------------- */

recipePanel.addEventListener('click', (event) => {
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

async function preparedFor(product: Product, forceTrim?: boolean): Promise<PreparedImage> {
  // A filled grid shows the photographs themselves, so trimming to the product
  // would cut away the very background it is meant to display.
  const trim = forceTrim ?? (isFilled(state.layout) ? false : state.trim)
  const key = `${product.id}:${trim}`
  const cached = prepCache.get(key)
  if (cached) return cached
  const prepared = await prepareImage(product.file, trim)
  prepCache.set(key, prepared)
  return prepared
}

/** The Canvas tab's settings as one compose call, shared with the framing preview. */
function canvasOptions(): ComposeOptions {
  return {
    size: state.comboSize,
    layout: state.layout,
    ratio: state.ratio,
    // JPEG has no alpha channel, so a transparent request has to land on white.
    background: state.format === 'jpeg' && state.background === 'transparent' ? '#ffffff' : state.background,
    padding: state.padding / 100,
    gap: state.gap / 100,
    uniformScale: state.uniformScale,
    align: state.align,
  }
}

/** Each photo in a combo, carrying the framing it keeps across every combo. */
function framedImages(group: Product[]): Promise<ComposeImage[]> {
  return Promise.all(group.map(async (product) => ({ ...(await preparedFor(product)), framing: product.framing })))
}

/**
 * Flattens one combo onto a canvas, for models that take a single reference.
 *
 * It uses the Canvas tab's own settings, so what that tab previews is literally
 * what Higgsfield is handed — and a transparent background has to land on white,
 * since a JPEG reference carries no alpha.
 */
async function compositeReference(group: Product[]): Promise<HTMLCanvasElement> {
  // The AI reference is a different job from a canvas export. Every prompt
  // tells the model the reference is "a flat working layout on a plain
  // background", so it has to stay exactly that: trimmed products, spaced, on
  // a plain ground. A filled grid would hand it cropped photographs of other
  // people's backdrops and quietly make the prompt a lie.
  const images = await Promise.all(group.map((product) => preparedFor(product, true)))
  const layout = isFilled(state.layout)
    ? (state.comboSize === 4 ? 'grid' : 'row')
    : normalizeLayout(state.comboSize, state.layout)
  const spaced = isFilled(state.layout)
  return composeCombo(images, {
    size: state.comboSize,
    layout,
    ratio: state.ratio,
    background: state.background === 'transparent' ? '#ffffff' : state.background,
    padding: spaced ? 0.06 : state.padding / 100,
    gap: spaced ? 0.03 : state.gap / 100,
    uniformScale: spaced ? true : state.uniformScale,
    align: spaced ? 'center' : state.align,
  })
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

      const canvas = composeCombo(await framedImages(group), canvasOptions())
      const blob = await canvasToBlob(canvas, mime, state.format === 'jpeg' ? 0.92 : undefined)
      results.push({
        name: comboName(group.map((product) => product.file.name), extension, usedNames),
        blob,
        url: URL.createObjectURL(blob),
        index: index + 1,
        sources: group.map((product) => product.file),
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

/**
 * A status line dedicated to this action, inside the Add products panel.
 *
 * The panel is shared between both tabs, so this is visible regardless of
 * which one the person is on — say() alone would risk writing into the AI
 * tab's hint line while the person is looking at Canvas, or the reverse.
 */
function sayProductUrls(text: string, error = false) {
  const line = el('#product-urls-status')
  line.classList.remove('hidden')
  line.className = error ? 'hint error' : 'hint'
  line.textContent = text
}

async function copyText(text: string, confirmMessage: string) {
  try {
    await navigator.clipboard.writeText(text)
    sayProductUrls(confirmMessage)
  } catch {
    // A blocked clipboard (an insecure context, a denied permission) should
    // not leave the person with nothing — the value is still shown for a
    // manual copy instead of just failing silently.
    sayProductUrls(`Could not copy automatically — here it is: ${text}`, true)
  }
}

el('#get-product-urls').addEventListener('click', async () => {
  if (!state.products.length) return
  if (!ai.cloudinary?.configured) {
    sayProductUrls('Connect Cloudinary first — the panel is right below this one.', true)
    return
  }
  const button = el<HTMLButtonElement>('#get-product-urls')
  button.disabled = true
  button.textContent = 'Uploading...'
  // Snapshotted so a product added or removed mid-upload cannot be matched to
  // the wrong result when the response comes back.
  const batch = state.products.map((product) => ({ id: product.id, file: product.file }))
  const folder = `Product photos ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
  sayProductUrls(`Uploading ${plural(batch.length, 'image')} to Cloudinary...`)
  try {
    const { results } = await uploadProductImages(
      folder,
      await Promise.all(batch.map(async ({ file }) => ({ name: file.name, type: file.type, data: await fileToBase64(file) }))),
    )
    let done = 0
    let failed = 0
    results.forEach((result, index) => {
      const id = batch[index]?.id
      const product = state.products.find((item) => item.id === id)
      if (!product) return
      if (result.url) {
        product.hostedUrl = result.url
        done += 1
      } else {
        failed += 1
      }
    })
    renderProducts()
    sayProductUrls(
      failed
        ? `${done} of ${results.length} uploaded — ${failed} failed. Click the link icon on a row to copy its URL.`
        : `${done} image${done === 1 ? '' : 's'} uploaded. Click the link icon on a row, or "Copy all URLs", to grab the links.`,
      Boolean(failed && !done),
    )
  } catch (error) {
    sayProductUrls(error instanceof Error ? error.message : 'Could not upload those images.', true)
  } finally {
    button.disabled = state.products.length === 0 || !ai.cloudinary?.configured
    button.textContent = 'Get image URLs'
  }
})

el('#copy-all-urls').addEventListener('click', async () => {
  const urls = state.products.map((product) => product.hostedUrl).filter((url): url is string => Boolean(url))
  if (!urls.length) return
  await copyText(urls.join('\n'), `Copied ${plural(urls.length, 'URL')}.`)
})

el('#download-products-zip').addEventListener('click', async () => {
  if (!state.products.length) return
  // Two products can end up with the same name after a manual rename; a
  // silent overwrite inside the zip would lose one of them, so a collision
  // gets a numbered suffix the same way a filesystem would handle it.
  const used = new Set<string>()
  const entries: ZipEntry[] = []
  for (const product of state.products) {
    const dot = product.file.name.lastIndexOf('.')
    const stem = dot > 0 ? product.file.name.slice(0, dot) : product.file.name
    const extension = dot > 0 ? product.file.name.slice(dot) : ''
    let name = product.file.name
    for (let n = 2; used.has(name); n++) name = `${stem} (${n})${extension}`
    used.add(name)
    entries.push({ name, data: new Uint8Array(await product.file.arrayBuffer()) })
  }
  const url = URL.createObjectURL(createZip(entries))
  const link = document.createElement('a')
  link.href = url
  link.download = 'product-photos.zip'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})

el('#download-zip').addEventListener('click', async () => {
  if (!results.length) return
  // A path with a slash becomes a real folder when the zip is unpacked, so the
  // archive arrives in the shape Flipkart wants rather than needing rearranging.
  const flat = ai.canvasLayout === 'flat'
  const entries: ZipEntry[] = []
  for (const result of results) {
    const { sku, files } = comboFiles(result)
    for (const file of files) {
      entries.push({
        name: flat ? file.name : `${sku}/${file.name}`,
        data: new Uint8Array(await file.source.arrayBuffer()),
      })
    }
  }
  const url = URL.createObjectURL(createZip(entries))
  const link = document.createElement('a')
  link.href = url
  link.download = `combos-${state.comboSize}up.zip`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})

const LAYOUTS_OUT = [
  { id: 'combo', label: 'Combo only', hint: 'One folder per SKU holding the combo image as 1. The listing sheet gets a hero URL and nothing else.' },
  { id: 'combo+sources', label: 'Combo + source photos', hint: 'The combo as 1, then each product photo it was made from as 2, 3, 4 — and a listing sheet with a URL column for every one of them.' },
  { id: 'flat', label: 'Flat files', hint: 'No folders — every combo as a single file, original name.' },
] as const

const extensionOf = (name: string) => /\.[a-z0-9]+$/i.exec(name)?.[0]?.toLowerCase() ?? '.png'
const skuOf = (name: string) => name.slice(0, name.length - extensionOf(name).length)

/**
 * The files one combo contributes, already named the way they must land.
 *
 * Flipkart reads a folder per SKU with the pictures numbered 1, 2, 3 inside
 * and ignores anything named otherwise — so the numbering is the point, and
 * the hero (the combo itself) has to be 1. "Combo + source photos" adds the
 * individual product shots after it, which is what fills the extra image slots
 * on a listing.
 */
function comboFiles(result: Result): { sku: string; files: { name: string; source: Blob }[] } {
  const sku = skuOf(result.name)
  if (ai.canvasLayout === 'flat') {
    return { sku, files: [{ name: result.name, source: result.blob }] }
  }
  const files = [{ name: `1${extensionOf(result.name)}`, source: result.blob as Blob }]
  if (ai.canvasLayout === 'combo+sources') {
    result.sources.forEach((file, index) => {
      files.push({ name: `${index + 2}${extensionOf(file.name)}`, source: file })
    })
  }
  return { sku, files }
}

/** A canvas result's blob as base64, for the Drive upload route. */
function resultToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.onerror = () => reject(new Error('Could not read a generated combo image.'))
    reader.readAsDataURL(blob)
  })
}

/** Combos per request when uploading to Drive, to keep each body modest. */
const DRIVE_BATCH = 25

el('#canvas-drive-upload').addEventListener('click', async () => {
  if (!results.length) return
  const toDrive = Boolean(ai.drive?.connected)
  const toCloud = Boolean(ai.cloudinary?.configured)
  if (!toDrive && !toCloud) {
    say('Connect Google Drive or Cloudinary first — both panels are under Add products.')
    return
  }
  const folderName = `Canvas combos ${state.comboSize}-up ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
  const perCombo = comboFiles(results[0]).files.length
  const total = results.reduce((sum, result) => sum + comboFiles(result).files.length, 0)
  const shape = ai.canvasLayout === 'flat'
    ? 'as loose files'
    : `as ${results.length} SKU folders (${perCombo} image${perCombo === 1 ? '' : 's'} each)`
  // Naming the destination in the prompt, because with Drive disconnected the
  // images go somewhere else entirely and that should not be a surprise.
  const where = toDrive && toCloud
    ? 'Google Drive (shared publicly so Flipkart can read them) and Cloudinary'
    : toDrive
      ? 'Google Drive, shared publicly so Flipkart can read them'
      : `Cloudinary (${ai.cloudinary?.cloudName})`
  const thin = ai.canvasLayout === 'combo'
    ? '\n\nNote: "Combo only" uploads just the combo image, so the listing sheet will have a hero URL and no Image 2/3/4 columns. Pick "Combo + source photos" if you want those.'
    : ''
  if (!window.confirm(`Upload ${total} images to ${where}?\n\nFolder: "${folderName}"\nThey go up ${shape}.${thin}`)) return

  ai.driveBusy = true
  renderDrive()
  try {
    await startDriveImages(folderName, ai.canvasLayout)
    // Sent in batches: a few hundred combos with their source photos is far
    // more than one request can carry.
    for (let start = 0; start < results.length; start += DRIVE_BATCH) {
      if (ai.drive?.run?.status === 'cancelled') break
      const groups: DriveGroup[] = []
      for (const result of results.slice(start, start + DRIVE_BATCH)) {
        const { sku, files } = comboFiles(result)
        groups.push({
          sku,
          files: await Promise.all(
            files.map(async (file) => ({
              name: file.name,
              type: file.source.type || 'image/png',
              data: await resultToBase64(file.source),
            })),
          ),
        })
      }
      await sendDriveImages(groups)
      await refreshDrive()
    }
    await finishDriveImages()
    await refreshDrive()
    say(`Uploaded to ${toDrive ? 'Drive' : 'Cloudinary'}. The listing sheet is ready to download.`)
  } catch (error) {
    say(error instanceof Error ? error.message : 'Could not finish that upload.', true)
  } finally {
    ai.driveBusy = false
    renderDrive()
  }
})

/** Served by the launcher, built from the ids Drive returned on upload. */
const openListingSheet = () => window.open(LISTING_SHEET_URL, '_blank', 'noopener')
el('#canvas-sheet').addEventListener('click', openListingSheet)
el('#drive-sheet').addEventListener('click', openListingSheet)

/* ---------------- AI section ---------------- */

/**
 * Asks the API what one image costs under the current settings.
 *
 * Only the model, frame and resolution move the price, so this runs on those
 * changes rather than on every render.
 */
async function refreshEstimate() {
  const model = selectedModel()
  if (!model?.available) {
    ai.estimate = null
    return
  }
  try {
    ai.estimate = await estimateRun(ai.model, ai.ratio, ai.resolution)
  } catch {
    // A missing estimate is not worth blocking on; the count still shows.
    ai.estimate = null
  }
  renderAiControls()
}

/**
 * A message from something the user just did.
 *
 * `renderAiControls` rewrites the hint from scratch every time it runs, so an
 * action that sets the hint and then re-renders would erase its own result.
 * Actions park the message here instead and the renderer gives it priority.
 */
let notice: { text: string; error: boolean } | null = null

function say(text: string, error = false) {
  notice = { text, error }
  renderAiControls()
}

const runActive = () => ai.run !== null && (ai.run.status === 'preparing' || ai.run.status === 'running')

function renderAiControls() {
  const connected = Boolean(ai.config?.configured)
  const connection = el<HTMLButtonElement>('#ai-connection')
  connection.textContent = connected ? `Connected · ${ai.config?.keyId}` : 'Not connected'
  connection.classList.toggle('connected', connected)
  // A key exported into the environment wins over the .env file, so replacing
  // it from here would silently do nothing. Say so rather than offering a form
  // that cannot take effect.
  connection.title = ai.config?.fromEnvironment
    ? 'Set from HF_API_KEY_ID in the environment'
    : connected ? 'Use a different key' : 'Add your Higgsfield key'
  el('#ai-connect').classList.toggle('hidden', connected && !ai.showConnect)

  el('#ai-size-options').innerHTML = sizeOptionsHtml()
  el('#ai-mode-options').innerHTML = modeOptionsHtml()
  el('#ai-mode-copy').textContent = {
    combinations: `Every unique set of ${state.comboSize} different products — 10 images in sets of 3 is 120 combos.`,
    repeats: `Same, but a product can repeat inside a combo. Works from a single image.`,
    sequential: `Takes your images ${state.comboSize} at a time in order; anything left over is skipped.`,
  }[state.mode]

  el('#ai-angle-options').innerHTML = ANGLES
    .map((angle) => `<button class="chip ${ai.angles.includes(angle.id) ? 'selected' : ''}" data-angle="${angle.id}" aria-pressed="${ai.angles.includes(angle.id)}">${angle.label}</button>`)
    .join('')

  el('#ai-background-options').innerHTML = AI_BACKGROUNDS
    .map((option) => `<button class="chip ${option.id === ai.background ? 'selected' : ''}" data-ai-background="${escapeHtml(option.id)}">${option.label}</button>`)
    .join('')

  const models = ai.config?.models ?? []
  const model = selectedModel()

  el('#ai-model-options').innerHTML = models
    .map((entry) => `<button class="chip ${entry.id === ai.model ? 'selected' : ''} ${entry.available ? '' : 'unavailable'}" data-ai-model="${entry.id}" ${entry.available ? '' : 'disabled'} title="${escapeHtml(entry.unavailableReason ?? entry.note)}">${escapeHtml(entry.label)}</button>`)
    .join('')
  el('#ai-model-copy').textContent = model
    ? model.available ? model.note : `${model.label}: ${model.unavailableReason}`
    : ''

  const resolutions = model?.resolutions ?? null
  el('#ai-resolution-field').classList.toggle('hidden', !resolutions)
  if (resolutions) {
    if (!resolutions.includes(ai.resolution)) ai.resolution = resolutions[0]
    el('#ai-resolution-options').innerHTML = resolutions
      .map((id) => `<button class="chip ${id === ai.resolution ? 'selected' : ''}" data-ai-resolution="${id}">${id}</button>`)
      .join('')
  }

  // Each model publishes the ratios its API accepts, and rejects any other.
  const ratios = model?.aspectRatios ?? ['1:1']
  if (!ratios.includes(ai.ratio)) ai.ratio = ratios[0]
  el('#ai-ratio-options').innerHTML = ratios
    .map((id) => `<button class="chip ${id === ai.ratio ? 'selected' : ''}" data-ai-ratio="${id}">${id}</button>`)
    .join('')

  el('#ai-format-options').innerHTML = (['jpeg', 'png'] as const)
    .map((format) => `<button class="chip ${format === ai.format ? 'selected' : ''}" data-ai-format="${format}">${format === 'png' ? 'PNG' : 'JPG'}</button>`)
    .join('')

  renderDescribe()

  renderPromptWriter()
  renderReverse()
  renderDrive()

  const groups = comboGroups()
  const jobs = aiJobCount()
  const maxJobs = ai.config?.maxJobs ?? 600
  el('#ai-combo-count').textContent = groups.length ? String(groups.length) : '—'
  el('#ai-angle-count').textContent = ai.angles.length ? String(ai.angles.length) : '—'
  el('#ai-job-count').textContent = jobs ? String(jobs) : '—'
  el('#ai-combo-example').textContent = groups.length
    ? comboFolder(groups[0].map((product) => product.file.name), new Set())
    : '—'
  // Priced per generation by the API, so the run total is just a multiplication.
  el('#ai-cost').textContent = ai.estimate && jobs
    ? `${(ai.estimate.credits * jobs).toLocaleString(undefined, { maximumFractionDigits: 0 })} credits · $${(ai.estimate.usd * jobs).toFixed(2)}`
    : '—'

  const outputRoot = el<HTMLInputElement>('#ai-output-root')
  if (document.activeElement !== outputRoot) {
    outputRoot.placeholder = ai.config?.defaultOutputRoot ?? 'ai-combos'
    outputRoot.value = ai.outputRoot
  }
  const folderName = el<HTMLInputElement>('#ai-folder-name')
  if (document.activeElement !== folderName) folderName.value = ai.folderName || defaultFolderName(state.comboSize)

  const blocked = !connected || !groups.length || !ai.angles.length || jobs > maxJobs || !model?.available
  aiGenerateButton.disabled = ai.starting || runActive() || blocked
  // The queue needs no credentials and spends nothing, so it only wants combos.
  el<HTMLButtonElement>('#ai-queue-button').disabled =
    ai.starting || ai.queueing || !groups.length || !ai.angles.length
  el('#ai-queue-stop').classList.toggle('hidden', !ai.queueing)

  if (notice) {
    aiHint.className = notice.error ? 'hint error' : 'hint'
    aiHint.textContent = notice.text
    notice = null
    return
  }

  aiHint.className = 'hint'
  if (ai.starting) {
    aiHint.textContent = 'Preparing your reference photos...'
  } else if (runActive()) {
    aiHint.textContent = 'A run is already going. Watch it below, or stop it to start another.'
  } else if (!connected) {
    aiHint.textContent = 'Connect a Higgsfield key above to start generating.'
  } else if (model && !model.available) {
    aiHint.className = 'hint error'
    aiHint.textContent = `${model.label} is not available on your account — pick another model.`
  } else if (!state.products.length) {
    aiHint.textContent = `Add at least ${plural(minimumImages(state.comboSize, state.mode), 'product image')} to continue.`
  } else if (!groups.length) {
    aiHint.textContent = `Add more images to complete a set of ${state.comboSize}.`
  } else if (!ai.angles.length) {
    aiHint.textContent = 'Tick at least one camera angle.'
  } else if (jobs > maxJobs) {
    aiHint.className = 'hint error'
    aiHint.textContent = `${jobs} images is over the ${maxJobs} limit for a paid run — pick fewer angles, or use Send to extension, which has no cap.`
  } else {
    const via = model?.references === 'one'
      ? ' Each combo is composited on canvas first, exactly as the Canvas tab shows it, then re-shot.'
      : ''
    aiHint.textContent = `${plural(groups.length, 'combo')} × ${plural(ai.angles.length, 'angle')} = ${jobs} images, each one billed to your Higgsfield account.${via}`
  }
}

function renderDescribe() {
  const describe = ai.config?.describe
  const ready = Boolean(describe?.configured)
  el('#ai-describe-connect').classList.toggle('hidden', ready)
  el('#ai-describe-run').classList.toggle('hidden', !ready)

  if (describe && !ai.describeModel) ai.describeModel = describe.defaultModel
  el('#ai-describe-models').innerHTML = (describe?.models ?? [])
    .map((model) => `<button class="chip ${model.id === ai.describeModel ? 'selected' : ''}" data-describe-model="${model.id}">${escapeHtml(model.label)}</button>`)
    .join('')

  const button = el<HTMLButtonElement>('#ai-describe-button')
  button.disabled = ai.describing || !state.products.length
  button.textContent = ai.describing
    ? 'Looking at your photos...'
    : `Describe ${state.products.length ? plural(state.products.length, 'product') : 'my products'}`

  // Rewriting the list while someone is typing in it would steal the caret.
  const list = el('#ai-caption-list')
  if (list.contains(document.activeElement)) return
  const described = state.products.filter((product) => ai.captions[product.id] !== undefined)
  list.innerHTML = described
    .map((product) => `<label class="caption-row">
      <img src="${product.url}" alt="">
      <input type="text" data-caption="${product.id}" value="${escapeHtml(ai.captions[product.id] ?? '')}" placeholder="Not described" spellcheck="false">
    </label>`)
    .join('')
}

function renderDrive() {
  const status = ai.drive
  const connected = Boolean(status?.connected)

  // Connecting lives in the shared Add-products panel, so both tabs see it.
  el('#drive-connect').classList.toggle('hidden', connected)
  // A saved client means disconnecting is recoverable without the console.
  el('#drive-reconnect-row').classList.toggle('hidden', connected || !status?.hasClient)
  el('#drive-connected-row').classList.toggle('hidden', !connected)

  // The AI tab's folder-upload controls only make sense once connected.
  el('#drive-ready').classList.toggle('hidden', !connected)
  el('#drive-locked-copy').classList.toggle('hidden', connected)

  const folder = el<HTMLInputElement>('#drive-folder')
  if (document.activeElement !== folder) {
    folder.value = ai.driveFolder
    folder.placeholder = ai.queue?.directory ?? 'Folder of images to upload'
  }
  el<HTMLInputElement>('#drive-flipkart').checked = ai.driveFlipkart

  const run = status?.run
  const running = run?.status === 'running'
  const button = el<HTMLButtonElement>('#drive-upload')
  button.disabled = ai.driveBusy || running
  button.textContent = running ? 'Uploading...' : 'Create folder & upload'
  el('#drive-open').classList.toggle('hidden', !run?.link)
  el('#drive-stop').classList.toggle('hidden', !running)

  // A Cloudinary failure is not fatal to the upload, so it would otherwise pass
  // unnoticed — but it decides whether the sheet carries durable URLs or falls
  // back to Drive ones, which is exactly what the user needs to know before
  // pasting several hundred links into a listing.
  const mirrorNote = () => {
    if (!run || !ai.cloudinary?.configured) return ''
    const uploaded = run.done + run.skipped
    if (run.hostError) return ` Durable URLs: ${run.hosted ?? 0} of ${uploaded} — ${run.hostError}`
    return run.hosted ? ` ${run.hosted} durable URLs.` : ''
  }

  const runLine = (label: string) =>
    run
      ? `${run.folder}: ${run.done} uploaded${run.skipped ? `, ${run.skipped} already there` : ''}${run.failed ? `, ${run.failed} failed` : ''} of ${run.total}.${run.error ? ` ${run.error}` : ''}${mirrorNote()}`
      : label

  el('#drive-copy').textContent = !connected
    ? ''
    : runLine('Creates a Drive folder named after this folder and mirrors every image into it, keeping the combo subfolders.')

  // The canvas tab's own controls and status line, driven by the same run state.
  const canvasButton = el<HTMLButtonElement>('#canvas-drive-upload')
  const hosting = Boolean(ai.cloudinary?.configured)
  canvasButton.disabled = ai.driveBusy || running || !results.length || (!connected && !hosting)
  canvasButton.textContent = connected ? 'Save to Drive' : hosting ? 'Upload to Cloudinary' : 'Save to Drive'
  canvasButton.title = connected || hosting
    ? ''
    : 'Connect Google Drive or Cloudinary in the Add products panel first.'
  canvasButton.classList.toggle('hidden', running)
  el('#canvas-drive-stop').classList.toggle('hidden', !running)
  el('#canvas-layout-options').innerHTML = LAYOUTS_OUT
    .map((option) => `<button class="chip ${option.id === ai.canvasLayout ? 'selected' : ''}" data-canvas-layout="${option.id}" title="${escapeHtml(option.hint)}">${option.label}</button>`)
    .join('')
  // The sheet is built from a finished upload's manifest, so it cannot exist
  // before one has run. Shown disabled rather than hidden: a button that
  // silently is not there reads as a missing feature, and the reason for the
  // wait — upload first — is exactly what the person needs told to them.
  const sheetReady = Boolean(run && run.status !== 'running' && (run.done > 0 || run.skipped > 0))
  const sheetWhy = running
    ? 'Available when this upload finishes.'
    : 'Upload your combos first — the sheet is built from what was uploaded.'
  for (const id of ['#canvas-sheet', '#drive-sheet']) {
    const button = el<HTMLButtonElement>(id)
    button.disabled = !sheetReady
    button.title = sheetReady ? 'Download the listing sheet' : sheetWhy
  }
  el('#canvas-drive-copy').textContent = results.length ? runLine('') : ''
}

function renderReverse() {
  const describe = ai.config?.describe
  if (describe && !ai.reverseModel) ai.reverseModel = describe.defaultModel
  el('#ai-reverse-models').innerHTML = (describe?.models ?? [])
    .map((model) => `<button class="chip ${model.id === ai.reverseModel ? 'selected' : ''}" data-reverse-model="${model.id}">${escapeHtml(model.label)}</button>`)
    .join('')

  const folder = el<HTMLInputElement>('#ai-reverse-folder')
  if (document.activeElement !== folder) {
    folder.value = ai.reverseFolder
    folder.placeholder = ai.queue?.directory ?? 'Folder holding the images you generated'
  }

  const button = el<HTMLButtonElement>('#ai-reverse-button')
  button.disabled = ai.reversing || !describe?.configured
  button.textContent = ai.reversing ? 'Reading your images...' : 'Write prompts from my images'
  el('#ai-reverse-open').classList.toggle('hidden', !ai.reversed.length)

  el('#ai-reverse-copy').textContent = !describe?.configured
    ? 'Needs the OpenRouter key above.'
    : ai.reversed.length
      ? `${plural(ai.reversed.filter((entry) => entry.prompt).length, 'prompt')} written, saved as prompts-from-images.txt next to the images.`
      : 'Reads the images you already generated and writes the prompt that would recreate each one — the backdrop and detail that actually worked, with the products left as a slot so it can be reused.'

  // A derived prompt is only useful if it can be adopted, so each one can be
  // assigned to a camera angle and used for every combo from then on.
  const options = ai.angles
    .map((id) => angleById(id))
    .map((angle) => `<option value="${angle.id}">Use for ${escapeHtml(angle.label)}</option>`)
    .join('')
  const list = el('#ai-reverse-list')
  list.innerHTML = ai.reversed
    .slice(0, 8)
    .map((entry, index) => `<div class="reverse-row">
      <b>${escapeHtml(entry.file)}</b>
      ${entry.error
        ? `<span>failed: ${escapeHtml(entry.error)}</span>`
        : `<select data-adopt="${index}"><option value="">${entry.prompt.split(' ').length} words</option>${options}</select>`}
    </div>`)
    .join('')
}

function renderPromptWriter() {
  const describe = ai.config?.describe
  if (describe && !ai.promptModel) ai.promptModel = describe.defaultPromptModel
  el('#ai-prompt-models').innerHTML = (describe?.promptModels ?? [])
    .map((model) => `<button class="chip ${model.id === ai.promptModel ? 'selected' : ''}" data-prompt-model="${model.id}">${escapeHtml(model.label)}</button>`)
    .join('')

  const written = Object.keys(ai.writtenPrompts).length
  const button = el<HTMLButtonElement>('#ai-write-button')
  button.disabled = ai.writing || !ai.angles.length || !describe?.configured
  button.textContent = ai.writing ? 'Writing...' : written ? 'Rewrite prompts' : 'Write prompts with AI'
  el('#ai-write-clear').classList.toggle('hidden', !written)

  el<HTMLInputElement>('#ai-per-combo').checked = ai.perCombo
  el<HTMLInputElement>('#ai-per-combo').disabled = !describe?.configured
  // Priced from the describe model, since that is what does the looking.
  const combos = comboGroups().length
  const each = { 'qwen/qwen3-vl-235b-a22b-instruct': 0.00055, 'qwen/qwen3-vl-32b-instruct': 0.00029 }[ai.describeModel] ?? 0.011
  el('#ai-per-combo-copy').textContent = combos
    ? `A vision model writes each combo's prompt from its own composite, so the wording fits the actual products. One call per combo — ${combos} of them, about $${(each * combos).toFixed(2)} with ${ai.describeModel.split('/').pop()}.`
    : 'A vision model writes each combo\u2019s prompt from its own composite, so the wording fits the actual products.'

  el('#ai-write-copy').textContent = !describe?.configured
    ? 'Needs the OpenRouter key above.'
    : written
      ? `Using AI-written prompts for ${plural(written, 'angle')}. Your product descriptions are slotted into each one.`
      : 'One call per angle, not per image, so a top model stays cheap. Without this the built-in prompt template is used.'
}

const STATUS_LABEL: Record<RunItem['status'], string> = {
  pending: 'Queued',
  running: 'Shooting',
  done: 'Saved',
  failed: 'Failed',
  skipped: 'Already there',
}

function renderAiRun() {
  const run = ai.run
  aiResultSection.classList.toggle('hidden', tab !== 'ai' || !run)
  if (!run) return

  const settled = run.done + run.failed + run.skipped
  const percent = run.total ? Math.round((settled / run.total) * 100) : 0
  el<HTMLDivElement>('#ai-progress-bar').style.width = `${percent}%`
  el('#ai-result-path').textContent = run.directory
  el('#ai-result-title').textContent = {
    preparing: 'Uploading your product photos',
    running: 'Shooting your combos',
    finished: 'Your combo shoot is done',
    cancelled: 'Run stopped',
    failed: 'Run failed',
  }[run.status]

  const parts = [`${settled} of ${run.total}`]
  if (run.failed) parts.push(`${run.failed} failed`)
  if (run.skipped) parts.push(`${run.skipped} already on disk`)
  const copy = el('#ai-progress-copy')
  copy.className = run.status === 'failed' || run.failed ? 'hint error' : 'hint'
  copy.textContent = run.error ?? run.warning ?? `${parts.join(' · ')}. Closing this tab will not stop the run.`

  el<HTMLButtonElement>('#ai-cancel').classList.toggle('hidden', !runActive())

  // Grouped by combo, because that is exactly how the folders come out.
  const byCombo = new Map<string, RunItem[]>()
  for (const item of run.items) {
    const list = byCombo.get(item.combo) ?? []
    list.push(item)
    byCombo.set(item.combo, list)
  }

  aiRunGrid.innerHTML = [...byCombo]
    .map(([combo, items]) => {
      const finished = items.filter((item) => item.status === 'done' || item.status === 'skipped').length
      const tiles = items
        .map((item) => `<div class="angle-tile ${item.status}" title="${escapeHtml(item.error ?? STATUS_LABEL[item.status])}">
          ${item.previewUrl ? `<img src="${escapeHtml(item.previewUrl)}" alt="${escapeHtml(`${combo}, ${item.angle}`)}" loading="lazy">` : '<span class="angle-tile-blank"></span>'}
          <b>${escapeHtml(item.angle)}</b><span>${STATUS_LABEL[item.status]}</span>
        </div>`)
        .join('')
      return `<div class="combo-card">
        <div class="combo-card-head"><strong>${escapeHtml(combo)}</strong><span>${finished}/${items.length}</span></div>
        <div class="angle-tiles">${tiles}</div>
      </div>`
    })
    .join('')
}

aiPanel.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-size], button[data-mode], button[data-angle], button[data-ai-background], button[data-ai-ratio], button[data-ai-resolution], button[data-ai-model], button[data-ai-format], button[data-describe-model], button[data-prompt-model], button[data-reverse-model]')
  if (!button) return
  const { size, mode, angle } = button.dataset
  if (size) state.comboSize = Number(size) as ComboSize
  if (mode) state.mode = mode as GroupMode
  if (angle) {
    // Angles are a multi-select: ticking is what multiplies the run.
    const id = angle as AngleId
    ai.angles = ai.angles.includes(id) ? ai.angles.filter((entry) => entry !== id) : [...ai.angles, id]
  }
  if (button.dataset.aiBackground) ai.background = button.dataset.aiBackground
  if (button.dataset.aiRatio) ai.ratio = button.dataset.aiRatio
  if (button.dataset.aiResolution) ai.resolution = button.dataset.aiResolution
  if (button.dataset.aiModel) ai.model = button.dataset.aiModel
  if (button.dataset.aiFormat) ai.format = button.dataset.aiFormat as 'jpeg' | 'png'
  if (button.dataset.describeModel) ai.describeModel = button.dataset.describeModel
  if (button.dataset.promptModel) ai.promptModel = button.dataset.promptModel
  if (button.dataset.reverseModel) ai.reverseModel = button.dataset.reverseModel
  if (button.dataset.aiModel || button.dataset.aiRatio || button.dataset.aiResolution) refreshEstimate()
  refresh()
})

el('#ai-caption-list').addEventListener('input', (event) => {
  const input = event.target as HTMLInputElement
  if (input.dataset.caption) ai.captions[Number(input.dataset.caption)] = input.value
})

el('#ai-or-connect').addEventListener('click', async () => {
  const field = el<HTMLInputElement>('#ai-or-key')
  const button = el<HTMLButtonElement>('#ai-or-connect')
  button.disabled = true
  button.textContent = 'Checking...'
  try {
    ai.config = await saveDescribeKey(field.value.trim())
    field.value = ''
  } catch (error) {
    aiHint.className = 'hint error'
    aiHint.textContent = error instanceof Error ? error.message : 'Could not save that key.'
  } finally {
    button.disabled = false
    button.textContent = 'Connect'
    renderAiControls()
  }
})

el<HTMLInputElement>('#ai-per-combo').addEventListener('change', (event) => {
  ai.perCombo = (event.target as HTMLInputElement).checked
  refresh()
})

/* ---------------- Google Drive ---------------- */

let drivePoll: ReturnType<typeof setTimeout> | null = null

/**
 * Keeps the page's idea of the Drive connection from going stale.
 *
 * The connection itself is finished server-side the moment the OAuth popup
 * redirects back to the launcher — the refresh token lands in .env whether or
 * not this tab is even still open. But this tab only *knows* that once it asks
 * again, and the one place that used to ask was the 60-attempt loop under the
 * Connect button, which gives up after two minutes. Consenting slower than
 * that, or in a different tab/window, left the page showing "not connected"
 * forever with no way to notice short of a manual reload — so it keeps
 * checking quietly in the background until it is connected, and checks again
 * whenever the tab regains focus (the moment someone comes back from the
 * Google consent tab).
 */
async function refreshDrive() {
  if (STATIC_HOST) return
  try {
    ai.drive = await driveStatus()
  } catch {
    ai.drive = null
  }
  renderDrive()
  if (drivePoll) clearTimeout(drivePoll)
  if (ai.drive?.run?.status === 'running') {
    drivePoll = setTimeout(refreshDrive, 1500)
  } else if (!ai.drive?.connected) {
    drivePoll = setTimeout(refreshDrive, 6000)
  }
}

/**
 * Cloudinary's state is its own: it is configured once from a settings file
 * and never goes through a consent round-trip, so it needs no polling.
 */
async function refreshCloudinary() {
  try {
    ai.cloudinary = await cloudinaryStatus()
  } catch {
    ai.cloudinary = null
  }
  renderCloudinary()
  // The upload button names its destination, and the "Get image URLs" button
  // is gated on this — both depend on it.
  renderDrive()
  renderProducts()
}

function renderCloudinary() {
  const status = ai.cloudinary
  const configured = Boolean(status?.configured)
  el('#cloudinary-connect').classList.toggle('hidden', configured)
  el('#cloudinary-connected-row').classList.toggle('hidden', !configured)
  if (configured) {
    // Naming the account, not just the fact of a connection: with the secret
    // write-only there is otherwise no way to tell which one is saved.
    el('#cloudinary-name').textContent =
      `Cloudinary connected — ${status?.cloudName}${status?.apiKeyHint ? ` (key ${status.apiKeyHint})` : ''}`
    el('#cloudinary-proof').classList.toggle('hidden', !status?.checkUrl)
    if (status?.checkUrl) el<HTMLAnchorElement>('#cloudinary-proof').href = status.checkUrl
    return
  }
  // Coming back to a half-filled form, the cloud name is the one value worth
  // restoring — the secret is deliberately never sent back to the page.
  const cloud = el<HTMLInputElement>('#cloudinary-cloud')
  if (status?.cloudName && !cloud.value) cloud.value = status.cloudName
}

/**
 * Reports next to the button that was pressed.
 *
 * say() renders into the AI tab's hint line, which is a different panel
 * entirely — press Connect from the canvas tab and the answer, success or
 * failure, appears somewhere off screen. A box that can fail needs to say so
 * where the person is looking.
 */
function sayCloudinary(text: string, error = false) {
  const line = el('#cloudinary-status')
  line.className = error ? 'hint error' : 'hint'
  line.textContent = text
}

el('#cloudinary-save').addEventListener('click', async () => {
  const cloudName = el<HTMLInputElement>('#cloudinary-cloud').value.trim()
  const apiKey = el<HTMLInputElement>('#cloudinary-key').value.trim()
  const apiSecret = el<HTMLInputElement>('#cloudinary-secret').value.trim()
  const button = el<HTMLButtonElement>('#cloudinary-save')
  const pastedUrl = [cloudName, apiKey, apiSecret].some((value) => /cloudinary:\/\/\S+:\S+@\S+/i.test(value))
  if (!pastedUrl && (!cloudName || !apiKey || !apiSecret)) {
    sayCloudinary('Fill in all three boxes, or paste the API environment variable into any one of them.', true)
    return
  }
  button.disabled = true
  sayCloudinary('Checking those details by uploading a test image...')
  try {
    const status = await saveCloudinary(cloudName, apiKey, apiSecret)
    // The secret is in the settings file now; no reason to leave it on screen.
    el<HTMLInputElement>('#cloudinary-secret').value = ''
    ai.cloudinary = status
    renderCloudinary()
    renderDrive()
    renderProducts()
    const message = `Cloudinary connected to "${status.cloudName}" and saved — a test image uploaded successfully. You will not need to enter this again.`
    sayCloudinary(message)
    say(message)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not save those credentials.'
    sayCloudinary(message, true)
    say(message, true)
  } finally {
    button.disabled = false
  }
})

el('#cloudinary-disconnect').addEventListener('click', async () => {
  try {
    ai.cloudinary = await disconnectCloudinary()
  } catch {
    ai.cloudinary = null
  }
  renderCloudinary()
  renderDrive()
  renderProducts()
  say('Cloudinary disconnected — sheets will fall back to Drive URLs.')
})

const recheckDriveOnReturn = () => {
  if (document.visibilityState === 'visible' && !ai.drive?.connected) refreshDrive()
}
window.addEventListener('focus', recheckDriveOnReturn)
document.addEventListener('visibilitychange', recheckDriveOnReturn)

el<HTMLInputElement>('#drive-folder').addEventListener('input', (event) => {
  ai.driveFolder = (event.target as HTMLInputElement).value
})

el<HTMLInputElement>('#drive-flipkart').addEventListener('change', (event) => {
  ai.driveFlipkart = (event.target as HTMLInputElement).checked
})

el('#drive-reconnect').addEventListener('click', async () => {
  const button = el<HTMLButtonElement>('#drive-reconnect')
  button.disabled = true
  try {
    const { authUrl } = await reconnectDrive()
    window.open(authUrl, '_blank', 'noopener')
    say('Approve access in the tab that opened, then come back.')
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      await refreshDrive()
      if (ai.drive?.connected) {
        say('Google Drive reconnected.')
        break
      }
    }
  } catch (error) {
    say(error instanceof Error ? error.message : 'Could not reconnect.', true)
  } finally {
    button.disabled = false
    renderDrive()
  }
})

el('#drive-save').addEventListener('click', async () => {
  const id = el<HTMLInputElement>('#drive-client-id').value.trim()
  const secret = el<HTMLInputElement>('#drive-client-secret').value.trim()
  const button = el<HTMLButtonElement>('#drive-save')
  button.disabled = true
  try {
    const { authUrl } = await saveDriveClient(id, secret)
    el<HTMLInputElement>('#drive-client-secret').value = ''
    // Consent happens on Google, then Google redirects back to the launcher.
    window.open(authUrl, '_blank', 'noopener')
    say('Approve access in the tab that opened, then come back.')
    // The callback lands on the launcher, not here, so poll for the result.
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      await refreshDrive()
      if (ai.drive?.connected) {
        say('Google Drive connected.')
        break
      }
    }
  } catch (error) {
    say(error instanceof Error ? error.message : 'Could not save that client.', true)
  } finally {
    button.disabled = false
    renderDrive()
  }
})

el('#drive-disconnect').addEventListener('click', async () => {
  if (!window.confirm('Disconnect Google Drive? Files already uploaded stay where they are.')) return
  try {
    await disconnectDrive()
    await refreshDrive()
    say('Google Drive disconnected.')
  } catch (error) {
    say(error instanceof Error ? error.message : 'Could not disconnect.', true)
  }
})

el('#drive-stop').addEventListener('click', async () => {
  try {
    await cancelDriveUpload()
    await refreshDrive()
    say('Upload stopped. What was already uploaded stays in Drive.')
  } catch (error) {
    say(error instanceof Error ? error.message : 'Could not stop the upload.', true)
  }
})

el('#canvas-layout-options').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-canvas-layout]')
  if (!button) return
  ai.canvasLayout = button.dataset.canvasLayout as typeof ai.canvasLayout
  renderDrive()
})

el('#canvas-drive-stop').addEventListener('click', async () => {
  try {
    await cancelDriveUpload()
    await refreshDrive()
    say('Upload stopped. What was already uploaded stays in Drive.')
  } catch (error) {
    say(error instanceof Error ? error.message : 'Could not stop the upload.', true)
  }
})

el('#drive-open').addEventListener('click', () => {
  const link = ai.drive?.run?.link
  if (link) window.open(link, '_blank', 'noopener')
})

el('#drive-upload').addEventListener('click', async () => {
  const folder = ai.driveFolder.trim() || ai.queue?.directory || ''
  if (!folder) {
    say('Point it at a folder of images first.', true)
    return
  }
  ai.driveBusy = true
  renderDrive()
  try {
    const scan = await scanDriveFolder(folder)
    if (!scan.images) {
      say(`No images under ${folder}.`, true)
      return
    }
    const shape = ai.driveFlipkart
      ? `\n\nThey will be laid out for Flipkart: a sub-folder per SKU, images renamed 1, 2, 3, and the master folder shared publicly so Flipkart can read it.`
      : ''
    if (!window.confirm(`Upload ${scan.images} images into a Drive folder called "${scan.name}"?${shape}`)) return
    await startDriveUpload(folder, ai.driveFlipkart)
    say(`Uploading ${scan.images} images to Drive...`)
    await refreshDrive()
  } catch (error) {
    say(error instanceof Error ? error.message : 'Could not start that upload.', true)
  } finally {
    ai.driveBusy = false
    renderDrive()
  }
})

el<HTMLInputElement>('#ai-reverse-folder').addEventListener('input', (event) => {
  ai.reverseFolder = (event.target as HTMLInputElement).value
})

el('#ai-reverse-list').addEventListener('change', (event) => {
  const select = event.target as HTMLSelectElement
  const index = select.dataset.adopt
  if (index === undefined || !select.value) return
  const entry = ai.reversed[Number(index)]
  if (!entry?.prompt) return
  ai.writtenPrompts[select.value] = entry.prompt
  say(`Using the prompt from ${entry.file} for ${angleById(select.value as AngleId).label}.`)
})

el('#ai-reverse-open').addEventListener('click', async () => {
  const folder = ai.reverseFolder.trim() || ai.queue?.directory
  if (folder) await revealFolder(folder).catch(() => {})
})

el('#ai-reverse-button').addEventListener('click', async () => {
  ai.reversing = true
  renderReverse()
  try {
    const result = await reversePrompts({
      model: ai.reverseModel,
      folder: ai.reverseFolder.trim() || ai.queue?.directory || '',
    })
    ai.reversed = result.results
    say(`Read ${plural(result.total, 'image')} — ${result.written} prompts saved into ${result.directory}.`)
  } catch (error) {
    ai.reversed = []
    say(error instanceof Error ? error.message : 'Could not read those images.', true)
  } finally {
    ai.reversing = false
    renderAiControls()
  }
})

el('#ai-write-clear').addEventListener('click', () => {
  ai.writtenPrompts = {}
  renderAiControls()
})

el('#ai-write-button').addEventListener('click', async () => {
  if (!ai.angles.length) return
  ai.writing = true
  renderPromptWriter()
  try {
    const { written } = await writePrompts({
      model: ai.promptModel,
      subject: ai.subject,
      count: state.comboSize,
      backdrop: ai.background,
      aspectRatio: ai.ratio,
      extra: ai.extra,
      // Each angle carries its own surface, so the hero shot can be plain white
      // while the rest use the chosen backdrop.
      angles: ai.angles.map((id, angleIndex) => {
        const angle = angleById(id)
        const white = ai.whiteFirst && angleIndex === 0
        return {
          id: angle.id,
          label: angle.label,
          camera: angle.camera,
          backdrop: white
            ? 'plain clean seamless white — a marketplace hero image, bright and uncluttered'
            : ai.background === 'auto'
              ? 'your choice — one simple, real surface that suits these particular pieces, nothing else in the scene'
              : ai.background === MIXED_BACKGROUND
                ? 'varies per image — describe one simple, real, textured coloured studio surface generically (never a white sweep, no props) and let each shot differ'
                : ai.background,
        }
      }),
    })
    ai.writtenPrompts = {}
    for (const entry of written) if (entry.prompt) ai.writtenPrompts[entry.id] = entry.prompt
    const failed = written.filter((entry) => entry.error)
    aiHint.className = failed.length ? 'hint error' : 'hint'
    aiHint.textContent = failed.length
      ? `${failed.length} of ${written.length} angles failed: ${failed[0].error}`
      : `Wrote prompts for ${plural(written.length, 'angle')}.`
  } catch (error) {
    aiHint.className = 'hint error'
    aiHint.textContent = error instanceof Error ? error.message : 'Could not write those prompts.'
  } finally {
    ai.writing = false
    renderAiControls()
  }
})

el('#ai-describe-button').addEventListener('click', async () => {
  if (!state.products.length) return
  ai.describing = true
  renderDescribe()
  try {
    const images = await Promise.all(
      state.products.map(async (product) => ({ id: product.id, ...(await toReference(product.file)) })),
    )
    const { described } = await describeProducts(ai.describeModel, ai.subject, images)
    for (const entry of described) ai.captions[entry.id] = entry.text
    const failed = described.filter((entry) => entry.error)
    aiHint.className = failed.length ? 'hint error' : 'hint'
    aiHint.textContent = failed.length
      ? `${failed.length} of ${described.length} could not be described: ${failed[0].error}`
      : `Described ${plural(described.length, 'product')}. Edit anything that looks wrong.`
  } catch (error) {
    aiHint.className = 'hint error'
    aiHint.textContent = error instanceof Error ? error.message : 'Could not describe those photos.'
  } finally {
    ai.describing = false
    renderAiControls()
  }
})

el('#ai-connection').addEventListener('click', () => {
  if (ai.config?.fromEnvironment) return
  ai.showConnect = !ai.showConnect
  renderAiControls()
})

el<HTMLInputElement>('#ai-white-first').addEventListener('change', (event) => {
  ai.whiteFirst = (event.target as HTMLInputElement).checked
  // Written prompts bake the backdrop in, so they no longer match.
  if (Object.keys(ai.writtenPrompts).length) ai.writtenPrompts = {}
  refresh()
})

el<HTMLInputElement>('#ai-subject').addEventListener('input', (event) => {
  ai.subject = (event.target as HTMLInputElement).value
})
el<HTMLTextAreaElement>('#ai-extra').addEventListener('input', (event) => {
  ai.extra = (event.target as HTMLTextAreaElement).value
})
el<HTMLInputElement>('#ai-output-root').addEventListener('input', (event) => {
  ai.outputRoot = (event.target as HTMLInputElement).value
})
el<HTMLInputElement>('#ai-folder-name').addEventListener('input', (event) => {
  ai.folderName = (event.target as HTMLInputElement).value
})
el<HTMLInputElement>('#ai-concurrency').addEventListener('input', (event) => {
  ai.concurrency = Number((event.target as HTMLInputElement).value)
  el('#ai-concurrency-value').textContent = String(ai.concurrency)
})

el('#ai-connect-button').addEventListener('click', async () => {
  const keyId = el<HTMLInputElement>('#ai-key-id').value.trim()
  const keySecret = el<HTMLInputElement>('#ai-key-secret').value.trim()
  const button = el<HTMLButtonElement>('#ai-connect-button')
  button.disabled = true
  button.textContent = 'Checking...'
  try {
    ai.config = await saveCredentials(keyId, keySecret)
    ai.showConnect = false
    el<HTMLInputElement>('#ai-key-secret').value = ''
    aiHint.className = 'hint'
  } catch (error) {
    aiHint.className = 'hint error'
    aiHint.textContent = error instanceof Error ? error.message : 'Could not save those credentials.'
  } finally {
    button.disabled = false
    button.textContent = 'Connect'
    renderAiControls()
  }
})

el('#ai-open-folder').addEventListener('click', async () => {
  if (!ai.run) return
  try {
    await revealFolder(ai.run.directory)
  } catch (error) {
    aiHint.className = 'hint error'
    aiHint.textContent = error instanceof Error ? error.message : 'Could not open that folder.'
  }
})

el('#ai-cancel').addEventListener('click', async () => {
  if (!ai.run) return
  try {
    await cancelRun(ai.run.id)
  } catch {
    /* the poll below will show whatever actually happened */
  }
})

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(pollRun, RUN_POLL_MS)
}

async function pollRun() {
  if (!ai.run) return
  try {
    ai.run = await fetchRun(ai.run.id)
  } catch (error) {
    // A restarted launcher forgets its runs; the files it already wrote stay.
    aiHint.className = 'hint error'
    aiHint.textContent = error instanceof Error ? error.message : 'Lost track of that run.'
    renderAiControls()
    return
  }
  renderAiRun()
  if (runActive()) schedulePoll()
  else renderAiControls()
}

/**
 * Everything a batch needs, whichever way it is going to be produced.
 *
 * The run and the extension queue want exactly the same thing — composited or
 * per-product references, a combo list, and the prompts — so this is shared
 * rather than written twice and drifting.
 */
async function buildPayload(groups: Product[][], report: (text: string) => void) {
  const single = selectedModel()?.references === 'one'
  const usedFolders = new Set<string>()
  const names = groups.map((group) => comboFolder(group.map((product) => product.file.name), usedFolders))

  let images: { id: number; type: string; data: string }[]
  let combos: RunRequest['combos']

  if (single) {
    // One composited picture per combo. Ids are positional here rather than
    // product ids, because every combo now has a reference of its own.
    images = []
    combos = []
    for (const [index, group] of groups.entries()) {
      report(`Compositing ${index + 1} of ${groups.length}...`)
      // Yield so that label actually paints on a long batch.
      await new Promise((resolve) => setTimeout(resolve, 0))
      const canvas = await compositeReference(group)
      images.push({ id: index + 1, ...(await canvasToReference(canvas, names[index])) })
      combos.push({
        folder: names[index],
        imageIds: [index + 1],
        sourceNames: group.map((product) => product.file.name),
      })
    }
  } else {
    combos = groups.map((group, index) => ({
      folder: names[index],
      imageIds: group.map((product) => product.id),
      sourceNames: group.map((product) => product.file.name),
    }))
    // Only the products that actually appear in a combo are worth uploading —
    // "in upload order" can leave spares behind.
    const usedIds = new Set(combos.flatMap((combo) => combo.imageIds))
    images = await Promise.all(
      state.products
        .filter((product) => usedIds.has(product.id))
        .map(async (product) => ({ id: product.id, ...(await toReference(product.file)) })),
    )
  }

  // An AI-written prompt is a template with a slot; the built-in one is
  // assembled outright. Either way the products for this combo go in.
  const promptFor = (angle: ReturnType<typeof angleById>, products: string[], comboIndex: number, angleIndex: number) => {
    const written = ai.writtenPrompts[angle.id]
    if (written) return fillProducts(written, products, state.comboSize, ai.subject)
    return buildPrompt({
      subject: ai.subject,
      count: state.comboSize,
      angle,
      // "Mixed" gives each combo its own surface, so the set does not come back
      // as forty variations of the same shot.
      background: backdropForShot(comboIndex, angleIndex),
      extra: ai.extra,
      composite: single,
      products,
    })
  }

  const chosen = ai.angles.map(angleById)
  // Without descriptions one prompt per angle covers every combo; with them
  // the prompt names this combo's own products, so it is per combo as well.
  const angles = chosen.map((angle, index) => ({
    id: angle.id,
    label: angle.label,
    tag: angle.tag,
    prompt: promptFor(angle, [], 0, index),
  }))

  const captionsFor = (group: Product[]) => group.map((product) => ai.captions[product.id] ?? '')
  const comboPrompts: Record<string, Record<string, string>> = {}
  const described = groups.some((group) => captionsFor(group).some((text) => text.trim()))
  // A mixed backdrop varies per combo too, so it needs per-combo prompts even
  // when nothing has been described.
  if (described || ai.background === MIXED_BACKGROUND || Object.keys(ai.writtenPrompts).length) {
    combos.forEach((combo, index) => {
      const products = captionsFor(groups[index])
      combo.prompts = Object.fromEntries(
        chosen.map((angle, angleIndex) => [angle.id, promptFor(angle, products, index, angleIndex)]),
      )
      comboPrompts[combo.folder] = combo.prompts
    })
  }

  return { single, images, combos, angles, comboPrompts }
}

async function startAiRun() {
  const groups = comboGroups()
  const jobs = aiJobCount()
  if (!groups.length || !ai.angles.length) return

  const folderName = ai.folderName.trim() || defaultFolderName(state.comboSize)
  // Real money leaves the account here, so the count and destination get said
  // out loud one last time before anything is submitted.
  const cost = ai.estimate
    ? `About ${Math.round(ai.estimate.credits * jobs).toLocaleString()} credits (~$${(ai.estimate.usd * jobs).toFixed(2)})\n`
    : ''
  const confirmed = window.confirm(
    `Generate ${jobs} images with Higgsfield?\n\n` +
      `${groups.length} combos × ${ai.angles.length} angles\n` +
      cost +
      `Saved into "${folderName}"\n\n` +
      'This spends credits on your Higgsfield account.',
  )
  if (!confirmed) return

  ai.starting = true
  renderAiControls()
  aiGenerateText.textContent = 'Preparing...'

  try {
    const { images, combos, angles } = await buildPayload(groups, (text) => {
      aiGenerateText.textContent = text
    })

    ai.run = await startRun({
      model: ai.model,
      aspectRatio: ai.ratio,
      resolution: ai.resolution,
      format: ai.format,
      concurrency: ai.concurrency,
      outputRoot: ai.outputRoot.trim(),
      folderName,
      images,
      combos,
      angles,
    })
    renderAiRun()
    aiResultSection.scrollIntoView({ behavior: 'smooth', block: 'start' })
    schedulePoll()
  } catch (error) {
    aiHint.className = 'hint error'
    aiHint.textContent = error instanceof Error ? error.message : 'Could not start that run.'
  } finally {
    ai.starting = false
    aiGenerateText.textContent = 'Generate with Higgsfield'
    renderAiControls()
  }
}

/**
 * Builds the same batch as a run, but stops at the folder.
 *
 * Nothing is submitted anywhere — the reference images and prompts land on disk
 * and the extension reads them from the launcher while you work.
 */
/** Combos per request when sending a queue. */
const QUEUE_BATCH = 150

/** Set by the Stop button; checked between combos so a long build can be interrupted. */
let queueCancelled = false

/**
 * Builds the same batch as a run, but stops at the folder.
 *
 * Nothing is submitted anywhere — the reference images and prompts land on disk
 * and the extension reads them from the launcher while you work.
 *
 * Sent in batches because there is no cap on combos any more: 20 photos in
 * fours is 4,845 of them, and compositing all of those before sending anything
 * would exhaust the tab's memory and blow past any request size limit.
 */
async function sendToExtension() {
  const groups = comboGroups()
  if (!groups.length || !ai.angles.length) return

  ai.queueing = true
  queueCancelled = false
  renderAiControls()
  const label = el('#ai-queue-text')
  let message: { text: string; error: boolean } | null = null
  try {
    const single = selectedModel()?.references === 'one'
    const usedFolders = new Set<string>()
    const names = groups.map((group) => comboFolder(group.map((product) => product.file.name), usedFolders))
    const chosen = ai.angles.map(angleById)
    const captionsFor = (group: Product[]) => group.map((product) => ai.captions[product.id] ?? '')

    const promptFor = (angle: ReturnType<typeof angleById>, products: string[], comboIndex: number, angleIndex: number) => {
      const written = ai.writtenPrompts[angle.id]
      if (written) return fillProducts(written, products, state.comboSize, ai.subject)
      return buildPrompt({
        subject: ai.subject,
        count: state.comboSize,
        angle,
        background: backdropForShot(comboIndex, angleIndex),
        extra: ai.extra,
        composite: single,
        products,
      })
    }

    let read = 0
    label.textContent = 'Starting...'
    await beginQueue({
      outputRoot: ai.outputRoot.trim(),
      folderName: ai.folderName.trim() || defaultFolderName(state.comboSize),
      subject: ai.subject,
      comboSize: state.comboSize,
      model: ai.model,
      aspectRatio: ai.ratio,
      resolution: ai.resolution,
      single,
      angles: chosen.map((angle, angleIndex) => ({
        id: angle.id,
        label: angle.label,
        tag: angle.tag,
        prompt: promptFor(angle, [], 0, angleIndex),
      })),
    })

    let stopped = false
    for (let start = 0; start < groups.length && !stopped; start += QUEUE_BATCH) {
      const slice = groups.slice(start, start + QUEUE_BATCH)
      const images: { id: number; type: string; data: string }[] = []
      const combos: (RunRequest['combos'][number] & { prompts?: Record<string, string> })[] = []

      for (const [offset, group] of slice.entries()) {
        if (queueCancelled) {
          stopped = true
          break
        }
        const index = start + offset
        label.textContent = `Compositing ${index + 1} of ${groups.length}...`
        // Yield so the label paints between combos on a long run, and so the
        // Stop button's click actually gets a turn to run.
        await new Promise((resolve) => setTimeout(resolve, 0))

        const products = captionsFor(group)
        const prompts = Object.fromEntries(
          chosen.map((angle, angleIndex) => [angle.id, promptFor(angle, products, index, angleIndex)]),
        )

        if (single) {
          const canvas = await compositeReference(group)
          images.push({ id: index + 1, ...(await canvasToReference(canvas, names[index])) })
          combos.push({ folder: names[index], imageIds: [index + 1], sourceNames: group.map((p) => p.file.name), prompts })
        } else {
          combos.push({
            folder: names[index],
            imageIds: group.map((product) => product.id),
            sourceNames: group.map((product) => product.file.name),
            prompts,
          })
        }
      }

      // Multi-reference mode shares the product photos across every combo, so
      // they go up once with the first batch and are reused after that.
      if (!single && start === 0) {
        const used = new Set(groups.flat().map((product) => product.id))
        images.push(
          ...(await Promise.all(
            state.products
              .filter((product) => used.has(product.id))
              .map(async (product) => ({ id: product.id, ...(await toReference(product.file)) })),
          )),
        )
      }

      // Reading the composites is only possible once they exist, so it happens
      // per batch — the prompt then describes the products actually in frame.
      if (ai.perCombo && single && images.length) {
        label.textContent = `Reading ${images.length} combo images...`
        const { written } = await comboPrompts({
          model: ai.describeModel,
          subject: ai.subject,
          count: state.comboSize,
          images,
        })
        const templates = new Map(written.filter((entry) => entry.prompt).map((entry) => [entry.id, entry.prompt]))
        combos.forEach((combo, offset) => {
          const template = templates.get(combo.imageIds[0])
          if (!template) return
          const comboIndex = start + offset
          combo.prompts = Object.fromEntries(
            chosen.map((angle, angleIndex) => [
              angle.id,
              fillShot(template, angle.camera, backdropForShot(comboIndex, angleIndex)),
            ]),
          )
        })
        read += templates.size
      }

      if (stopped) break

      label.textContent = `Sending ${Math.min(start + QUEUE_BATCH, groups.length)} of ${groups.length}...`
      await appendQueue({ images, combos })
    }

    if (stopped) {
      message = { text: 'Stopped — nothing was queued for the extension.', error: false }
    } else {
      label.textContent = 'Finishing...'
      ai.queue = await finishQueue()
      const readNote = read ? ` ${read} prompts written from the combo images.` : ''
      message = { text: `${plural(ai.queue.items.length, 'image')} queued in ${ai.queue.directory}.${readNote} Open the extension on higgsfield.ai.`, error: false }
    }
  } catch (error) {
    message = { text: error instanceof Error ? error.message : 'Could not build that queue.', error: true }
  } finally {
    ai.queueing = false
    label.textContent = 'Send to extension'
    if (message) say(message.text, message.error)
    else renderAiControls()
  }
}

aiGenerateButton.addEventListener('click', startAiRun)
el('#ai-queue-button').addEventListener('click', sendToExtension)
el('#ai-queue-stop').addEventListener('click', () => {
  queueCancelled = true
  el('#ai-queue-text').textContent = 'Stopping...'
})

if (!STATIC_HOST) fetchConfig()
  .then((config) => {
    ai.config = config
    // Fall to whatever this account can actually reach rather than leaving the
    // panel pointed at a model every run would fail on.
    const usable = config.models.find((model) => model.id === ai.model && model.available)
      ?? config.models.find((model) => model.available)
      ?? config.models[0]
    if (usable) ai.model = usable.id
    void refreshEstimate()
  })
  .catch(() => {
    // Opened straight off disk or under `vite dev` with no launcher behind it:
    // the canvas half still works, so this is a note rather than a failure.
    ai.config = null
  })
  .finally(renderAiControls)

refresh()

if (!STATIC_HOST) {
  void refreshTemplates()
  void refreshDrive()
  void refreshCloudinary()
}

// The extension can put one image on a different surface, and can have a model
// rewrite one prompt from its reference. Both need wording that lives here
// rather than in the launcher, so it is offered on each load — which also
// upgrades a queue that was built before either feature existed.
if (!STATIC_HOST) void sendWording({
  backdrops: backdropMenu(),
  angles: ANGLES.map((angle) => ({ id: angle.id, camera: angle.camera })),
  templates: backdropTemplates(),
}).catch(() => {
  /* no launcher, or nothing queued — the rest of the page is unaffected */
})
