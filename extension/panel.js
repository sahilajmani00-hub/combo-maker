/**
 * Side panel: shows one queue entry at a time while you work on higgsfield.ai.
 *
 * It reads the queue from the Combo Maker launcher on localhost and writes the
 * done/skipped flags back, so progress survives closing the browser. It does
 * not touch the page you are on — the uploading and the clicking are yours.
 */

/** The launcher walks upward from 4173 when the port is busy, so try a few. */
const PORTS = [4173, 4174, 4175, 4176, 4177]

const el = (id) => document.getElementById(id)

const state = {
  base: null,
  queue: null,
  index: 0,
  onlyPending: false,
}

const say = (text, isError = false) => {
  el('status').textContent = text
  el('status').className = isError ? 'status error' : 'status'
}

/* ---------------- launcher ---------------- */

async function callApi(path, options) {
  const response = await fetch(`${state.base}${path}`, options)
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status}).`)
  return body
}

/**
 * Finds the launcher and loads the queue.
 *
 * A saved port is tried first so the common case is one request, not five.
 */
async function connect() {
  const saved = await chrome.storage.local.get('port')
  const ports = saved.port ? [saved.port, ...PORTS.filter((port) => port !== saved.port)] : PORTS

  for (const port of ports) {
    const base = `http://localhost:${port}`
    try {
      const response = await fetch(`${base}/api/queue`, { cache: 'no-store' })
      // A 404 still proves the launcher is there — it just has no queue yet.
      if (!response.ok && response.status !== 404) continue
      state.base = base
      chrome.storage.local.set({ port })
      state.queue = response.ok ? await response.json() : null
      render()
      return
    } catch {
      /* try the next port */
    }
  }
  state.base = null
  render()
}

/* ---------------- queue navigation ---------------- */

/** The entries currently on screen — everything, or only what is left to do. */
function visible() {
  if (!state.queue) return []
  return state.onlyPending
    ? state.queue.items.filter((item) => item.status === 'pending')
    : state.queue.items
}

function current() {
  const items = visible()
  if (!items.length) return null
  state.index = Math.max(0, Math.min(state.index, items.length - 1))
  return items[state.index]
}

function step(delta) {
  state.index += delta
  render()
}

async function mark(status, advance = true) {
  const item = current()
  if (!item) return
  try {
    await callApi('/api/queue/item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, status }),
    })
    item.status = status
    // Filtering to pending renumbers the list under us, so staying put is what
    // actually advances; otherwise move on by hand.
    if (advance && !state.onlyPending) state.index += 1
    render()
    say({ done: 'Marked done.', skipped: 'Skipped.', pending: 'Put back — not done.' }[status])
  } catch (error) {
    say(error.message, true)
  }
}

/* ---------------- the two things you actually need ---------------- */

/**
 * The async clipboard API rejects when the panel does not have focus, and in
 * some states never settles at all — so it gets a deadline, and a fallback that
 * works without the permission.
 */
const withDeadline = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))])

async function writeText(text) {
  try {
    await withDeadline(navigator.clipboard.writeText(text), 1500)
    return true
  } catch {
    /* fall through to the legacy path */
  }
  const holder = document.createElement('textarea')
  holder.value = text
  holder.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
  document.body.appendChild(holder)
  holder.select()
  const copied = document.execCommand('copy')
  holder.remove()
  return copied
}

async function copyPrompt() {
  const item = current()
  if (!item) return
  if (await writeText(item.prompt)) {
    say('Prompt copied — paste it into Higgsfield.')
    return
  }
  // Nothing worked, so at least put it where it can be copied by hand.
  el('prompt').select()
  say('Could not reach the clipboard — the prompt is selected, press Cmd/Ctrl+C.', true)
}

function referenceUrl(relative) {
  return `${state.base}/api/queue/file?path=${encodeURIComponent(relative)}`
}

/**
 * Puts the reference on the clipboard so it can be pasted straight into an
 * upload field. Clipboard image writes are PNG-only in Chrome, so the JPEG
 * gets re-encoded through a canvas first.
 */
async function copyImage() {
  const item = current()
  if (!item?.references?.length) return
  try {
    const blob = await (await fetch(referenceUrl(item.references[0]))).blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    const png = await canvas.convertToBlob({ type: 'image/png' })
    await withDeadline(navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]), 3000)
    say('Reference copied — paste it into the upload box.')
  } catch (error) {
    // There is no legacy fallback for images, so point at the button that works.
    say(`Could not copy the image (${error.message}). Use Save image instead.`, true)
  }
}

/** Saves the reference next to wherever the browser puts downloads. */
function saveImage() {
  const item = current()
  if (!item?.references?.length) return
  for (const reference of item.references) {
    chrome.downloads.download({
      url: referenceUrl(reference),
      filename: `combo-maker/${reference.split('/').pop()}`,
    })
  }
  say('Reference saved to your downloads.')
}

/* ---------------- rendering ---------------- */

function render() {
  const offline = !state.base
  const empty = Boolean(state.base) && !state.queue
  el('offline').classList.toggle('hidden', !offline)
  el('empty').classList.toggle('hidden', !empty)
  el('work').classList.toggle('hidden', offline || empty)
  if (offline || empty) return

  const items = state.queue.items
  const done = items.filter((item) => item.status === 'done').length
  const skipped = items.filter((item) => item.status === 'skipped').length
  el('bar').style.width = `${items.length ? ((done + skipped) / items.length) * 100 : 0}%`
  el('counts').textContent = `${done} done${skipped ? ` · ${skipped} skipped` : ''} of ${items.length}`
  el('only-pending').textContent = state.onlyPending ? 'Showing what is left' : 'Showing all'

  const list = visible()
  const item = current()
  if (!item) {
    el('combo').textContent = state.onlyPending ? 'Everything is done.' : 'Nothing to show.'
    el('position').textContent = ''
    el('references').innerHTML = ''
    el('prompt').value = ''
    el('angle').textContent = ''
    el('saveas').textContent = ''
    return
  }

  el('combo').textContent = item.combo
  el('position').textContent = `${state.index + 1} / ${list.length}`
  el('angle').textContent = item.angle
  el('prompt').value = item.prompt
  el('saveas').textContent = item.saveAs
  el('references').innerHTML = (item.references ?? [])
    .map((reference) => `<img src="${referenceUrl(reference)}" alt="" loading="lazy">`)
    .join('')

  const STATE_TEXT = { pending: 'Not done yet', done: 'Done ✓', skipped: 'Skipped' }
  el('state').textContent = STATE_TEXT[item.status]
  el('state').className = `state ${item.status}`
  // Undo only means something once the item has actually been marked.
  el('undo').classList.toggle('hidden', item.status === 'pending')

  el('done').textContent = item.status === 'done' ? 'Done ✓' : 'Done →'
  el('prev').disabled = state.index === 0
}

/* ---------------- wiring ---------------- */

el('refresh').addEventListener('click', () => {
  say('Reloading...')
  connect()
})
el('copy-prompt').addEventListener('click', copyPrompt)
el('copy-image').addEventListener('click', copyImage)
el('save-image').addEventListener('click', saveImage)
el('done').addEventListener('click', () => mark('done'))
el('skip').addEventListener('click', () => mark('skipped'))
el('undo').addEventListener('click', () => mark('pending', false))
el('prev').addEventListener('click', () => step(-1))
el('only-pending').addEventListener('click', () => {
  state.onlyPending = !state.onlyPending
  state.index = 0
  render()
})
el('open-folder').addEventListener('click', async () => {
  try {
    await callApi('/api/ai/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.queue.directory }),
    })
  } catch (error) {
    say(error.message, true)
  }
})
el('reset').addEventListener('click', async () => {
  if (!confirm(`Put all ${state.queue.items.length} items back to not-done?`)) return
  try {
    state.queue = await callApi('/api/queue/reset', { method: 'POST' })
    state.index = 0
    render()
    say('Progress reset.')
  } catch (error) {
    say(error.message, true)
  }
})
el('clear').addEventListener('click', async () => {
  const total = state.queue.items.length
  if (!confirm(`Clear this queue of ${total} items from the extension?\n\nThe folder on disk — reference images and prompts.txt — is kept.`)) return
  try {
    await callApi('/api/queue/clear', { method: 'POST' })
    state.queue = null
    state.index = 0
    render()
    say('Queue cleared. The folder on disk was kept.')
  } catch (error) {
    say(error.message, true)
  }
})

el('port').addEventListener('change', async (event) => {
  await chrome.storage.local.set({ port: Number(event.target.value) })
  connect()
})

chrome.storage.local.get('port').then(({ port }) => {
  if (port) el('port').value = port
})
connect()
