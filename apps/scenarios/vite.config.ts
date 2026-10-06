import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Graphics are not shipped: this app reuses the playground's (apps/playground/public/img, see packages/board-ui/README.md).
export default defineConfig({
  plugins: [react()],
  publicDir: "../playground/public",
  server: { port: 5174 },
});
