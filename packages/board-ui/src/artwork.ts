import { useEffect, useState } from "react";
import { rosters, starPlayers, type Artwork } from "@ff-engine/data";
import type { PlayerState, Weather } from "@ff-engine/engine";

/**
 * Where the board finds its artwork. No artwork is included: without it, players are numbered discs, teams have no
 * logo and the pitch comes from the image folder. `fumbblArtwork` reads FUMBBL's, from FUMBBL's image server or from
 * copies downloaded for testing.
 */
export interface BoardArtwork {
  /** The sprite sheet of the player's position: four columns (red, red moving, blue, blue moving), `size` rows. */
  sprites(roster: string, player: PlayerState): { url: string; size: number } | null;
  /** The team logo of a roster. */
  logo(roster: string): string | null;
  /** The pitch in this weather: 26 x 15 squares inside a 1 px border (782 x 452 px at 30 px a square). */
  pitch?(weather: Weather): string | null;
}

/** Manifest key of the downloaded pitch for a weather (`pnpm fetch-artwork` writes them). */
const pitchKey = (weather: Weather) => `pitch/${weather}`;

/** FUMBBL's artwork paths of a position (by roster and title) or a star player (by name). */
function artworkOf(roster: string, position: string): Artwork | undefined {
  const fromRoster = rosters.find((r) => r.name === roster)?.positions.find((p) => p.title === position)?.artwork;
  return fromRoster ?? starPlayers.find((s) => s.name === position)?.artwork;
}

/**
 * FUMBBL's artwork, from the paths in the roster data. `url` turns a path into an image URL, or null when it is not
 * available: `(path) => artworkBase + path` for FUMBBL's own server, or a lookup in the manifest of downloaded copies
 * (`loadDownloadedArtwork`).
 */
export function fumbblArtwork(url: (path: string) => string | null): BoardArtwork {
  return {
    sprites(roster, player) {
      const sprites = artworkOf(roster, player.position)?.sprites;
      const sheet = sprites && url(sprites.path);
      return sprites && sheet ? { url: sheet, size: sprites.size } : null;
    },
    logo(roster) {
      const path = rosters.find((r) => r.name === roster)?.logo;
      return path ? url(path) : null;
    },
  };
}

/**
 * FUMBBL's artwork downloaded for testing (`pnpm fetch-artwork`): `base` is the folder holding the copies and their
 * `manifest.json` (FUMBBL path, or `pitch/<weather>` for the pitches, to file name). Resolves to undefined when nothing
 * was downloaded.
 */
export async function loadDownloadedArtwork(base: string): Promise<BoardArtwork | undefined> {
  try {
    const response = await fetch(`${base}/manifest.json`);
    if (!response.ok) return undefined;
    const manifest = (await response.json()) as Record<string, string>;
    const url = (path: string) => (manifest[path] ? `${base}/${manifest[path]}` : null);
    return { ...fumbblArtwork(url), pitch: (weather) => url(pitchKey(weather)) };
  } catch {
    return undefined;
  }
}

/** `loadDownloadedArtwork` as a React hook: undefined until loaded, and when nothing was downloaded. */
export function useDownloadedArtwork(base: string): BoardArtwork | undefined {
  const [artwork, setArtwork] = useState<BoardArtwork>();
  useEffect(() => {
    let current = true;
    void loadDownloadedArtwork(base).then((a) => current && setArtwork(a));
    return () => {
      current = false;
    };
  }, [base]);
  return artwork;
}

/**
 * The CSS of a player's sprite: the sheet as a background, showing the square of their colour (blue for home, red
 * for away; the moving one when active) in a row picked by their number, so team-mates of a position vary.
 */
export function spriteStyle(sheet: { url: string; size: number }, player: PlayerState, active: boolean) {
  const column = (player.side === "home" ? 2 : 0) + (active ? 1 : 0);
  const row = (((player.nr - 1) % sheet.size) + sheet.size) % sheet.size;
  return {
    backgroundImage: `url("${sheet.url}")`,
    backgroundSize: `400% ${sheet.size * 100}%`,
    backgroundPosition: `${(column * 100) / 3}% ${sheet.size > 1 ? (row * 100) / (sheet.size - 1) : 0}%`,
  };
}
