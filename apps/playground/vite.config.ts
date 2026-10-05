import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Graphics are not shipped: put them in public/img/ (git-ignored), see packages/board-ui/README.md.
// Online games talk to the relay (apps/relay, `pnpm --filter relay dev`) through /relay.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/relay": { target: "ws://localhost:8787", ws: true } } },
});
