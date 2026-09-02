import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/snapshot": {
        target: "http://127.0.0.1:5199",
        changeOrigin: true,
      },
      "/events": {
        target: "http://127.0.0.1:5199",
        changeOrigin: true,
        ws: false,
      },
    },
  },
});
