import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.OUTPOST_API ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": api,
      "/frame": api,
      "/ws": { target: api.replace("http", "ws"), ws: true },
    },
  },
});
