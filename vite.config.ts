import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths so dist/ runs from any folder — served over http by
  // the launcher, or opened straight off disk as a fallback.
  base: './',
  build: {
    // The whole tool is ~19 kB; one file keeps the launcher's payload simple.
    assetsInlineLimit: 0,
  },
})
