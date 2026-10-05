import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { attachRelay } from "./server.ts";

/** PORT (default 8787); STATIC_DIR: a built playground to serve too (default: ../playground/dist when built). */
const PORT = Number(process.env.PORT ?? 8787);
const DEFAULT_STATIC = resolve(import.meta.dirname, "../../playground/dist");
const STATIC_DIR = process.env.STATIC_DIR ?? (existsSync(DEFAULT_STATIC) ? DEFAULT_STATIC : null);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

/** A file of STATIC_DIR, or index.html for any unknown path (the app reads its own URL). */
async function staticFile(path: string): Promise<{ body: Buffer; type: string } | null> {
  if (!STATIC_DIR) return null;
  const file = normalize(join(STATIC_DIR, decodeURIComponent(path)));
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + sep)) return null;
  const target = (await stat(file).catch(() => null))?.isFile() ? file : join(STATIC_DIR, "index.html");
  const body = await readFile(target).catch(() => null);
  return body && { body, type: TYPES[extname(target)] ?? "application/octet-stream" };
}

const server = createServer(async (request, response) => {
  const found = await staticFile(new URL(request.url ?? "/", "http://relay").pathname);
  if (!found) {
    response.writeHead(404).end("Blood Bowl relay: connect a WebSocket to /relay?game=<id>\n");
    return;
  }
  response.writeHead(200, { "content-type": found.type }).end(found.body);
});
attachRelay(server);
server.listen(PORT, () => {
  console.log(`Relay on http://localhost:${PORT}/relay${STATIC_DIR ? `, serving ${STATIC_DIR}` : ""}`);
});
