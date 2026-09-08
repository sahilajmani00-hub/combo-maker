# Combo Maker Queue — browser extension

A side panel that shows one queue entry at a time — the reference image and the prompt —
while you upload and download on higgsfield.ai yourself.

It is a **viewer**. It does not touch the page you are on, fill anything in, click
anything, or automate generation. It reads the queue from the Combo Maker launcher on
localhost and writes back which items you have finished.

## Install

1. Start Combo Maker (`npm start`, or the *Combo Maker* shortcut) and leave it running —
   the extension reads from it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `extension/` folder.
4. Pin *Combo Maker Queue* to the toolbar. Clicking it opens the side panel.

Works in Chrome and Edge (Manifest V3 side panel). Firefox is not supported — it has no
`sidePanel` API.

## Use

1. In Combo Maker, open **AI angle combos**, set up the batch as usual, then press
   **Send to extension** instead of *Generate with Higgsfield*. Nothing is submitted and
   nothing is charged — it composites the references and writes the folder.
2. Open higgsfield.ai, then open the side panel.
3. For each entry: **Copy image** (or **Save image**), **Copy prompt**, do the generation
   on the page, download the result, then **Done →**.

*Showing all / Showing what is left* toggles the filter. Progress is stored by the
launcher, so closing the browser — or the launcher — does not lose it. **Reset progress**
puts everything back to not-done.

## Changing one image's prompt

The prompt box is editable. Type in it and press **Save prompt** — or just **Copy
prompt**, which saves first so what you pasted and what is on disk stay the same thing.
**Revert** puts the queued prompt back.

The **Backdrop** menu above it puts that one image on a different surface, rewriting the
prompt to match. Choosing it repeatedly is fine — the prompt is rebuilt from the original
each time rather than layered — and *As queued* undoes it. A prompt you rewrote by hand is
swapped in place, so your wording survives changing the surface.

**Colour** tints the surface you picked: *Marble* in *Emerald* becomes "deep emerald green
polished marble", *Burgundy velvet* in *Dove grey* becomes "a soft dove grey velvet surface
with soft directional pile". Colours are named the way a photographer would say them, not
as hex — an image model reads "dusty rose" and gets it. Surfaces that are a colour and
nothing else (*Classy (auto)*) say so instead of offering the choice, and picking a new
backdrop starts from that surface's own colour rather than carrying the old tint over.

Four reflective surfaces are on the list — *Glass*, *Smoked glass*, *Mirror* and *Antique
mirror*. Each says what its reflection should do rather than leaving the model to invent
one, and each takes a colour like any other surface.

**Fog / smoke** is a tick rather than a surface, so it works with whatever backdrop you are
on. It adds a paragraph asking for thin haze pooling low around the pieces and catching the
light — kept behind and below them, with the products themselves sharp and unobscured.
Untick it and the paragraph goes away again cleanly; it survives changing the surface, and
deleting the paragraph by hand unticks the box.

## Letting a model write the prompt

**Rewrite from the picture** hands this item's reference to a vision model and takes the
prompt it writes back — useful when the queued prompt does not suit these particular
products. Pick which model reads it in the select above the button; the choice is
remembered. It needs the OpenRouter key Combo Maker already uses for *Describe*.

The model is shown the products and nothing else: this shot's camera angle and its current
surface are slotted into what comes back, so a rewrite is a rewrite of *this shot* and does
not quietly move it somewhere else. **Revert** undoes it, and the backdrop and colour menus
keep working on the new prompt.

The wording all this needs comes from Combo Maker itself, so the menus only appear once the
dashboard has been open with the launcher running (opening `http://localhost:4173/` once is
enough — it hands the wording over on load, including for a queue that was built before any
of this existed). Edits, backdrops and rewrites survive **Send to extension** being run
again, the same way the done flags do.

Keys: **E** jumps into the prompt box, **Esc** leaves it — the draft is kept either way.
**R** asks the model for a rewrite, **F** toggles the fog.

## What lands on disk

```
<output folder>/<master folder>/
├── _references/          the composited reference for each combo
├── prompts.txt           every prompt, grouped by combo — rewrites included
└── queue.json            the queue and your progress
```

The panel shows a **Save the result as** line for each entry, matching the naming the
automated run would have used, so a hand-built folder comes out the same shape.

## Port

The launcher normally serves on 4173 and walks upward if that is taken. The panel tries
4173–4177 and remembers what worked; if it still cannot find it, set the port by hand in
the panel's offline notice.
