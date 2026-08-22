import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths so dist/ runs from any folder — served over http by
  // the launcher, or opened straight off disk as a fallback.
  base: './',
  build: {
    // The whole tool is ~19 kB; one file keeps the launcher's payload simple.
    assetsInlineLimit: 0,
  },
  server: {
    // The AI section's routes live in the launcher, which holds the Higgsfield
    // credentials. Proxying them keeps `npm run dev` usable for that half too,
    // as long as `npm start` is running in another terminal.
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.PORT || 4173}`,
        changeOrigin: false,
      },
    },
  },
})
