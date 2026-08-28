/**
 * Browser half of the AI angle-combos section.
 *
 * Everything here talks to the local launcher on /api/ai rather than to
 * Higgsfield directly: the API key has to stay on the machine, and the results
 * have to land in real folders on disk, neither of which a page can do.
 */

import { prepareImage } from './imageprep.ts'
import { canvasToBlob } from './compose.ts'

export type AiModel = {
  id: string
  label: string
  note: string
  /** `one` means the browser has to composite a combo before sending it. */
  references: 'one' | 'many'
  minImages: number
  maxImages: number
  aspectRatios: string[]
  /** Null when the model has no resolution choice. */
  resolutions: string[] | null
  available: boolean
  unavailableReason: string | null
}

export type DescribeModel = { id: string; label: string }

export type DescribeConfig = {
  configured: boolean
  fromEnvironment: boolean
  defaultModel: string
  models: DescribeModel[]
  promptModels: DescribeModel[]
  defaultPromptModel: string
  productsToken: string
}

export type WrittenPrompt = { id: string; prompt: string; error: string | null }

export type Described = { id: number; text: string; error: string | null }

export type AiConfig = {
  configured: boolean
  keyId: string | null
  fromEnvironment: boolean
  defaultOutputRoot: string
  maxJobs: number
  models: AiModel[]
  describe: DescribeConfig
}

export type RunItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export type RunItem = {
  combo: string
  angle: string
  status: RunItemStatus
  file: string | null
  previewUrl: string | null
  error: string | null
}

export type RunSnapshot = {
  id: string
  status: 'preparing' | 'running' | 'finished' | 'cancelled' | 'failed'
  folder: string
  directory: string
  total: number
  done: number
  failed: number
  skipped: number
  error: string | null
  warning: string | null
  items: RunItem[]
}

export type RunRequest = {
  model: string
  aspectRatio: string
  resolution: string
  format: 'jpeg' | 'png'
  concurrency: number
  outputRoot: string
  folderName: string
  images: { id: number; type: string; data: string }[]
  combos: { folder: string; imageIds: number[]; sourceNames: string[]; prompts?: Record<string, string> }[]
  angles: { id: string; label: string; tag: string; prompt: string }[]
}

/**
 * The launcher is the only thing serving /api, so a plain HTML response means
 * the page is running under `vite dev` without it. Say so instead of throwing a
 * JSON parse error at someone.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch {
    throw new Error('The Combo Maker launcher is not answering. Start it with "npm start".')
  }
  const body = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('The AI features need the launcher — run "npm start" instead of opening dist/ directly.')
  }
  if (!response.ok) {
    const message = (parsed as { error?: string }).error
    throw new Error(message || `Request failed (${response.status}).`)
  }
  return parsed as T
}

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const fetchConfig = () => request<AiConfig>('/api/ai/config')

export const saveCredentials = (keyId: string, keySecret: string) =>
  request<AiConfig>('/api/ai/config', postJson({ keyId, keySecret }))

export const startRun = (payload: RunRequest) => request<RunSnapshot>('/api/ai/runs', postJson(payload))

export const saveDescribeKey = (key: string) => request<AiConfig>('/api/ai/describe-key', postJson({ key }))

/** Captions every uploaded photo in one round trip; failures come back per image. */
export const describeProducts = (
  model: string,
  subject: string,
  images: { id: number; type: string; data: string }[],
) => request<{ model: string; described: Described[] }>('/api/ai/describe', postJson({ model, subject, images }))

export type QueueSummary = {
  folder: string
  directory: string
  comboCount: number
  items: { id: string; combo: string; angle: string; status: string }[]
}

export type QueueRequest = {
  outputRoot: string
  folderName: string
  subject: string
  comboSize: number
  model: string
  aspectRatio: string
  resolution: string
  single: boolean
  images: { id: number; type: string; data: string }[]
  combos: RunRequest['combos']
  angles: { id: string; label: string; tag: string; prompt: string }[]
  comboPrompts: Record<string, Record<string, string>>
}

/** Hands the batch to the launcher for the browser extension to work through. */
export const sendQueue = (payload: QueueRequest) => request<QueueSummary>('/api/queue', postJson(payload))

/** Has a top model write one prompt per camera angle, products left as a slot. */
export const writePrompts = (payload: {
  model: string
  subject: string
  count: number
  backdrop: string
  aspectRatio: string
  extra: string
  angles: { id: string; label: string; camera: string }[]
}) => request<{ model: string; written: WrittenPrompt[] }>('/api/ai/write-prompts', postJson(payload))

export type Estimate = { credits: number; usd: number }

/** Cost of a single generation with these settings, straight from the API. */
export const estimateRun = (model: string, aspectRatio: string, resolution: string) =>
  request<Estimate>('/api/ai/estimate', postJson({ model, aspectRatio, resolution }))

export const fetchRun = (id: string) => request<RunSnapshot>(`/api/ai/runs/${id}`)

export const cancelRun = (id: string) =>
  request<{ cancelled: boolean }>(`/api/ai/runs/${id}/cancel`, postJson({}))

export const revealFolder = (path: string) => request<{ opened: boolean }>('/api/ai/reveal', postJson({ path }))

function blobToBase64(blob: Blob, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      // FileReader hands back a data: URL; the payload wants only the base64.
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error(`Could not read ${label}.`))
    reader.readAsDataURL(blob)
  })
}

/**
 * Turns an uploaded file into the reference image Higgsfield gets.
 *
 * Re-encoding rather than forwarding the original is deliberate: a 12 MP phone
 * shot carries nothing the model can use past ~1600px, and sixty of them would
 * make the run request enormous. `prepareImage` already caps the long edge, so
 * this is mostly about getting predictable JPEG bytes out the other side.
 */
export async function toReference(file: File): Promise<{ type: string; data: string }> {
  const { canvas } = await prepareImage(file, false)
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.9)
  return { type: 'image/jpeg', data: await blobToBase64(blob, file.name) }
}

/**
 * The same, for a combo already composited on canvas — what single-reference
 * models get instead of the products one by one.
 */
export async function canvasToReference(canvas: HTMLCanvasElement, label: string) {
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92)
  return { type: 'image/jpeg', data: await blobToBase64(blob, label) }
}

/** A master folder name that sorts by date and says what is inside it. */
export function defaultFolderName(comboSize: number, now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`
  return `AI combos ${comboSize}-up ${stamp}`
}
