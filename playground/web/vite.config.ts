import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        // Equirect panos can take minutes on first stitch
        timeout: 600_000,
        proxyTimeout: 600_000,
      },
    },
  },
});
