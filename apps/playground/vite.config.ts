import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Graphics are not shipped: put them in public/img/ (git-ignored), see packages/board-ui/README.md.
export default defineConfig({
  plugins: [react()],
});
