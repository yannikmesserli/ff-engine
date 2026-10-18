/**
 * Downloads FUMBBL's player sprites and team logos into apps/playground/public/fumbbl/, for testing the engine in the
 * playground and the scenarios app.
 *
 * THESE IMAGES ARE NOT PART OF THIS PROJECT AND DO NOT BELONG TO ITS AUTHORS. They are FUMBBL's (https://fumbbl.com)
 * and its artists'. This script exists only so that people testing the engine can see who is who on the pitch. Use the
 * copies for your own testing only, and ask FUMBBL before doing anything else with them (publishing them, shipping
 * them in a build, hosting a game). Never commit them: the repository ignores the folder and every image file.
 *
 * Without them, players are numbered discs and teams have no logo.
 *
 * Run with: pnpm fetch-artwork (files already downloaded are skipped; --refresh downloads them again)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artworkBase, rosters, starPlayers } from "@ff-engine/data";

const OUT = join(import.meta.dirname, "../public/fumbbl");
/** Pause between downloads, to be gentle with FUMBBL. */
const DELAY_MS = 200;
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/gif": "gif", "image/jpeg": "jpg", "image/webp": "webp" };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

console.warn(`
  FUMBBL's artwork is not part of this project and does not belong to its authors.
  It is downloaded for testing the engine only, into ${OUT} (ignored by git).
  Do not commit, publish or ship it; ask FUMBBL (https://fumbbl.com) for any other use.
`);

// Every sprite sheet and logo, by path on FUMBBL's image server (positions shared by rosters appear once).
const paths = new Set<string>();
for (const roster of rosters) {
  if (roster.logo) paths.add(roster.logo);
  for (const position of roster.positions) if (position.artwork?.sprites) paths.add(position.artwork.sprites.path);
}
for (const star of starPlayers) if (star.artwork?.sprites) paths.add(star.artwork.sprites.path);

mkdirSync(OUT, { recursive: true });
const manifestFile = join(OUT, "manifest.json");
const refresh = process.argv.includes("--refresh");
/** FUMBBL path to the file name of its copy (with the extension of its type: some paths have none). */
const manifest: Record<string, string> = !refresh && existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : {};

let downloaded = 0;
for (const path of paths) {
  if (manifest[path] && existsSync(join(OUT, manifest[path]))) continue;
  const response = await fetch(new URL(path, artworkBase));
  if (!response.ok) {
    console.error(`Skipped ${path}: HTTP ${response.status}`);
    continue;
  }
  const type = response.headers.get("content-type")?.split(";")[0] ?? "";
  const extension = /\.\w+$/.test(path) ? "" : `.${EXTENSIONS[type] ?? "png"}`;
  const file = path.replaceAll("/", "-") + extension;
  writeFileSync(join(OUT, file), Buffer.from(await response.arrayBuffer()));
  manifest[path] = file;
  downloaded += 1;
  await sleep(DELAY_MS);
}
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
console.log(`${downloaded} downloaded, ${paths.size - downloaded} already there, in ${OUT}`);
