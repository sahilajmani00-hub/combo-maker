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

## What lands on disk

```
<output folder>/<master folder>/
├── _references/          the composited reference for each combo
├── prompts.txt           every prompt, grouped by combo — usable on its own
└── queue.json            the queue and your progress
```

The panel shows a **Save the result as** line for each entry, matching the naming the
automated run would have used, so a hand-built folder comes out the same shape.

## Port

The launcher normally serves on 4173 and walks upward if that is taken. The panel tries
4173–4177 and remembers what worked; if it still cannot find it, set the port by hand in
the panel's offline notice.
