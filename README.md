# Combo Maker

Local browser tool for turning individual product photos into aligned 2 / 3 / 4-product
combo images. Nothing is uploaded anywhere — every file is decoded and composed inside
the browser tab via canvas.

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

`tools/serve.mjs` uses no packages at all, so the launcher still works even if
`node_modules` is missing — it reinstalls and rebuilds on its own. It serves over
`http://localhost` rather than opening the file directly, which keeps canvas exports and
module loading identical to development.

Transparent backgrounds are PNG-only; picking JPG with a transparent background falls
back to white, since JPEG carries no alpha channel.
