import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Local development only: the API and HLS files live on 4100. In production
    // nginx serves both, so nothing here ships.
    proxy: {
      "/api": "http://127.0.0.1:4100",
      "/hls": "http://127.0.0.1:4100",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
