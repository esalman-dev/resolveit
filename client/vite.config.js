import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Dev proxy: the browser calls /api/... on localhost:5173 (this dev server), and Vite forwards it
    // to Express on :5000. To the browser it's ONE site, so the refresh-token cookie is first-party.
    // In production, vercel.json does the same job (forwards /api/... to the Render server).
    proxy: {
      '/api': 'http://localhost:5000',
    },
  },
})
