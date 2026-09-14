# Combo Maker

Local browser tool for turning individual product photos into 2 / 3 / 4-product combo
images. It has two sections:

- **Canvas combos** — arranges the real photos side by side. Nothing is uploaded
  anywhere; every file is decoded and composed inside the browser tab via canvas.
- **AI angle combos** — sends the products to [Higgsfield](https://higgsfield.ai) and
  gets each combo back *re-photographed* from several camera angles, saved straight into
  folders on disk. This one does upload your photos, and it spends Higgsfield credits.

## Invite-only hosted dashboard

The managed Sites deployment uses invite-only sharing and sign-in through ChatGPT.
There is no public signup. Address: https://sahil-combo-maker.sahilajmani00.chatgpt.site
See [hosting and invitations](HOSTING.md) for access management and self-hosted alternatives.

The hosted version supports browser-based photo composition and downloads. Photos stay
in each user's browser. The existing AI, Drive, Cloudinary, and disk-template integrations
remain local-only because they currently share the owner's credentials and filesystem.

## Run it

**Double-click `Combo Maker.bat`.** That's the whole thing — it builds the app if needed,
starts a local server, and opens your browser. A small console window stays open while it
runs; close it to stop.

Double-click `Create Desktop Shortcut.bat` once and you get a *Combo Maker* icon on your
desktop that does the same thing.

The only requirement is [Node.js](https://nodejs.org) (LTS). If it isn't installed the
launcher says so and points you at the download instead of failing silently.

### From a terminal

```bash
npm start       # same as the launcher: build if stale, serve, open browser
npm run dev     # vite dev server with hot reload, for editing the tool itself
npm run build   # typecheck + emit static bundle to dist/
```

`dist/` is self-contained and uses relative paths, so it can also be hosted from any
static file server or copied to another machine.

## How it works

1. **Add products** — drag and drop or browse. Up to 60 images, reorderable with the
   arrow buttons; order decides which products land in which set.
2. **Choose your combo** — set size (2, 3 or 4), layout, canvas ratio, background,
   margins and alignment.
3. **Generate** — pick which combos to build:
   - **Every combination** (default) — every unique set of N *different* products, i.e.
     C(n, k). 6 photos with sets of 4 gives 15 combos.
   - **Allow repeats** — a product may appear more than once in a combo, so `A+A+B+C` is
     built and `A+A+A+A` is valid. Order still doesn't matter, so `A+A+B+C` and `C+B+A+A`
     are one combo, not two. That's C(n+k-1, k) — 6 photos with sets of 4 gives 126
     combos. Works from as little as one uploaded image.
   - **In upload order** — consecutive chunks instead. 6 photos with sets of 4 gives 1
     combo, and the 2 leftover photos are marked *Spare* and skipped.

   Any mode is capped at 150 combos per run; when there are more, the panel shows
   `150 of 715` and says so rather than silently truncating.
4. **Export** — download combos individually or all at once as a ZIP.

## AI angle combos

The canvas section can only ever show each product from the angle it was photographed at.
The AI section re-shoots the combo instead: the products go to Higgsfield as reference
images, and come back as a fresh studio photograph for every camera angle you tick.

### Connecting Higgsfield

Create an API key pair at [cloud.higgsfield.ai](https://cloud.higgsfield.ai) and paste the
key ID and secret into the panel.

The platform API bills its **own** credit balance — a subscription on the higgsfield.ai
app does not fund it, and neither do the credits the Claude connector spends. Top the API
account up at cloud.higgsfield.ai or every generation comes back
`Your Higgsfield account is out of credits.` They are written to a local `.env` file (gitignored) and
used only by the launcher process — the browser tab never receives them, because anyone
who can open devtools on a page could otherwise spend the account's credits.

If you would rather not type them into the app, export them before starting instead; the
environment always wins over the file:

```bash
export HF_API_KEY_ID="your-key-id"
export HF_API_KEY_SECRET="your-key-secret"
npm start
```

Because credentials and disk writes both live in the launcher, this section only works
when the app is served by `npm start` (or the `.bat`). Under `npm run dev` the Vite server
proxies `/api` to `localhost:4173`, so run both together while editing.

### What a run produces

Pick a set size and how many angles you want, and the run is *combos × angles* images.
Ten photos in sets of three is 120 combos; four angles makes that 480 generations, so the
count and destination are spelled out and confirmed before anything is submitted. One run
is capped at 600 images.

Results are written as they finish — a master folder, one subfolder per combo, one file
per angle:

```
AI combos 3-up 2026-08-21 1405/
├── manifest.json
├── earring1&earring2&earring3/
│   ├── earring1&earring2&earring3 - front.jpg
│   ├── earring1&earring2&earring3 - 34-left.jpg
│   ├── earring1&earring2&earring3 - top.jpg
│   └── earring1&earring2&earring3 - macro.jpg
├── earring1&earring2&earring4/
│   └── ...
```

Combo folders use exactly the same names as the canvas section's files, so a set is
recognisable across both. `manifest.json` records every combo, its source photos, the
prompt used for each angle and the Higgsfield request id — written as the run goes, not
only at the end, so an interrupted run still leaves a usable record.

Re-running into a master folder that already exists tops it up rather than regenerating:
any angle already sitting on disk is skipped and costs nothing. That is the way to resume
a run that was stopped or that failed partway.

Closing the browser tab does not stop a run — the launcher window does the work. Stopping
it needs either the **Stop run** button or closing the launcher.

### Angles and prompting

Eight angles are available: straight on, 3/4 left, 3/4 right, side profile, top-down flat
lay, macro detail, low hero angle, and angled from above. Each contributes a camera clause
to the prompt and a short tag to the filename.

The prompt is built around keeping the products *unchanged* — the failure worth guarding
against is the model inventing a fourth earring or restyling one of the three it was
given, since a pretty picture of the wrong products is worthless. Telling it what the
products actually are ("earrings", "pendant necklaces") and picking a backdrop does most
of the rest; the free-text box is appended for anything else.

### Models

Model access is per account: a valid key still gets `model_not_found` for a model the
account does not carry and `model_blocked` for one its plan excludes. The panel probes all
four on connect and strikes through the ones you cannot use, so a run fails in the form
rather than 200 generations in.

| Model | References | Notes |
| ----- | ---------- | ----- |
| **Higgsfield Soul** | one | On every account. Default. |
| **Nano Banana** | up to 8 | Best fidelity; not on every account. |
| **Reve Remix** / **(fast)** | 2–4 | Plan-gated. |

Soul takes a single reference image, so for it the app **composites the combo on canvas
first** — using the Canvas tab's own layout, background and trim settings, so that tab is a
live preview of what Higgsfield is handed — and asks Soul to re-photograph that layout as
real objects from the chosen angle. The multi-reference models instead get each product as
its own reference and assemble the frame themselves.

### Describing the products (optional)

The image models are told to keep the products unchanged, but a prompt that never says
*what* they are gives them nothing to hold on to — which is how a brushed-gold hoop comes
back as a silver stud. Paste an [OpenRouter](https://openrouter.ai) key and **Describe my
products** sends each uploaded photo to a vision model once, producing a line like:

```
gold-plated teardrop hoop earring with a freshwater pearl drop and brushed finish
```

Those lines are listed under the button and are **editable** — fix anything the model got
wrong before it reaches hundreds of images. Each combo's prompt then names its own
products:

```
The 3 products are: (1) gold-plated teardrop hoop…; (2) oxidised silver chandelier…; (3) …
```

It is a handful of vision calls per session against hundreds of image generations, so the
cost is negligible. Skip it entirely and the prompts fall back to the generic wording —
nothing else changes. Choose between Claude Haiku 4.5, Claude Sonnet 4.6 and Gemini 3.5
Flash; the key is stored in the same local `.env` as the Higgsfield one.

### Cost

Every generation is billed, and a run is combos × angles, so the panel prices it up front
from Higgsfield's own estimate endpoint and repeats the number in the confirmation.

Soul is 3 credits (~$0.19) per image at 1080p and half that at 720p, so ten photos in sets
of three across four angles — 480 images — is about 1,440 credits (~$90) at 1080p, or 720
credits (~$45) at 720p. Start small: three photos, sets of two, one angle is 3 images.

Failed and moderated generations are not charged, and neither are skipped ones, so a
resumed run only pays for what is actually missing.

## Doing it by hand — the browser extension

Generating through the API needs credits. If you would rather run the batch yourself on
higgsfield.ai, **Send to extension** builds exactly the same thing as a run and stops at
the folder: one composited reference per combo, one prompt per combo per angle, and a
queue the browser extension walks you through. It submits nothing and costs nothing.

The extension is a viewer — it shows the reference image and the prompt for one entry at a
time, with copy and save buttons, and remembers what you have finished. It does not touch
the Higgsfield page, fill fields, or automate generation; the uploading and downloading
are yours. Setup and usage: [`extension/README.md`](extension/README.md).

```
<output folder>/<master folder>/
├── _references/          the composited reference for each combo
├── prompts.txt           every prompt, grouped by combo — usable without the extension
└── queue.json            the queue and your progress
```

Progress lives in `queue.json`, so closing the browser or the launcher does not lose it.

## Combo filenames

Each combo is named after the products inside it, joined with `&`. So
`earring1.jpg` + `earring2.jpg` + `earring3.jpg` saves as:

```
earring1&earring2&earring3.png
```

Extensions are dropped from the source names and the export extension is appended, so a
JPG export of the same set gives `earring1&earring2&earring3.jpg`. Spaces, hyphens and
non-English characters are preserved; only characters the filesystem rejects (`\ / : * ?
" < > |`) are removed. If one run would produce the same name twice, later files get a
`-2`, `-3` suffix. When a product repeats inside a combo the name collapses to a count,
so four copies of `earring1` save as `earring1x4.png` and `A+A+B+C` as
`earring1x2&earring2&earring3.png`.

Very long names are capped at 150 characters by shortening *every* part equally, so all
the products in a combo still appear rather than the last ones falling off the end. A
trailing CDN resize suffix (`_720x720q50`) and stray mid-name extensions are stripped,
which is what supplier downloads tend to carry.

## Alignment

Getting a combo to look deliberate is mostly about neutralising differences between
source photos, so three controls do the real work:

- **Trim empty space** — each photo is scanned and cropped to its product before layout.
  The background colour is sampled from the four corners, so a product on white and a
  product on light grey both reduce to just the product. Combos then align on the
  products themselves rather than on whatever padding each photo happened to carry.
- **Match product sizes** — instead of letting each product fill its own cell (which
  makes a wide product dwarf a narrow one), every product is scaled by the same factor,
  derived from whichever one is most constrained.
- **Sit on a shared baseline** — bottom-aligns products, which reads better for items
  that stand on a surface. Centred is the default.

## Layouts

| Set size | Options                          |
| -------- | -------------------------------- |
| 2        | Side by side · Stacked           |
| 3        | 3 across · 1 big + 2 · Stacked   |
| 4        | 2 × 2 grid · 4 across · 1 big + 3 |

Canvas presets are 1:1 (1200 × 1200), 4:5 (1200 × 1500) and 3:4 (1200 × 1600) — all
comfortably above the minimum resolution marketplaces ask for.

## Source layout

| File                | Role                                                    |
| ------------------- | ------------------------------------------------------- |
| `Combo Maker.bat`   | Double-click entry point                                |
| `tools/serve.mjs`   | Launcher: rebuild-if-stale, static server, opens browser |
| `src/main.ts`       | UI, state, event wiring, batch generation               |
| `src/grouping.ts`   | Which products end up in which combo                    |
| `src/naming.ts`     | Combo filenames built from the source names             |
| `src/imageprep.ts`  | Decoding and background-trim detection                  |
| `src/compose.ts`    | Layout rectangles, scaling, canvas rendering            |
| `src/zip.ts`        | Dependency-free store-only ZIP writer for bulk export   |
| `src/angles.ts`     | Camera angle presets and the prompt they build          |
| `src/ai.ts`         | Browser client for the launcher's `/api/ai` routes      |
| `tools/higgsfield.mjs` | Higgsfield REST client: upload, submit, poll, download |
| `tools/airun.mjs`   | Batches a run and writes the master folder to disk      |
| `tools/openrouter.mjs` | Vision captions for the uploaded products            |
| `tools/env.mjs`     | Shared reader/writer for the local `.env` keys          |
| `tools/queue.mjs`   | Builds and persists the queue the extension reads       |
| `extension/`        | The side-panel extension (load unpacked)                |

`tools/serve.mjs` uses no packages at all — nor do the two modules it pulls in — so the
launcher still works even if `node_modules` is missing; it reinstalls and rebuilds on its
own. It serves over
`http://localhost` rather than opening the file directly, which keeps canvas exports and
module loading identical to development.

Transparent backgrounds are PNG-only; picking JPG with a transparent background falls
back to white, since JPEG carries no alpha channel.
