import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
  base: "./",
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },
});
