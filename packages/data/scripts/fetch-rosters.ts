/**
 * Downloads the BB2025 rosters from FUMBBL into
 * src/generated/rosters.json. Star players are inducements, not roster positions: they go to a separate list, and each
 * roster names those it may hire.
 *
 * Run with: pnpm fetch-rosters
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { RosterSchema, StarPlayerSchema, type Artwork, type Roster, type StarPlayer } from "../src/schemas";

/** FUMBBL ruleset holding the BB2025 rosters. */
const RULESET_ID = 2014;
const FUMBBL = "https://fumbbl.com";
const OUT = join(import.meta.dirname, "../src/generated/rosters.json");
/** Pause between roster requests, to be gentle with FUMBBL. */
const DELAY_MS = 300;

/** Entry of the ruleset's roster list (api/ruleset/get). */
interface RulesetRoster {
  id: string;
  value: string;
  tier: string;
  enabled: boolean;
}

/** A parsed XML element: a plain text value, or an object with attributes and an optional `#text`. */
type Xml = string | number | boolean | XmlElement | undefined;
interface XmlElement {
  [key: string]: Xml | Xml[];
}

/** Subset of FUMBBL's `xml:roster` document that we read (attributes have no prefix). */
interface RosterXml {
  id: Xml;
  name: Xml;
  reRollCost: Xml;
  maxReRolls: Xml;
  apothecary: Xml;
  undead: Xml;
  necromancer: Xml;
  maxBigGuys?: Xml;
  keywords?: { keyword?: Xml[] };
  logo?: Xml;
  /** The image server the artwork paths are relative to. */
  baseIconPath?: Xml;
  position?: PositionXml[];
}

interface PositionXml {
  id: Xml;
  name: Xml;
  type: Xml;
  quantity: Xml;
  cost: Xml;
  movement: Xml;
  strength: Xml;
  agility: Xml;
  passing?: Xml;
  armour: Xml;
  /** Star players hired together: the other one's position id. */
  teamWithPositionId?: Xml;
  skillList?: { skill?: Xml[] };
  skillCategoryList?: { normal?: Xml[]; double?: Xml[] };
  keywords?: { keyword?: Xml[] };
  portrait?: Xml;
  /** The sprite sheet: its path as text, the number of rows in `size`. */
  iconSet?: Xml;
}

/** Paths of FUMBBL's artwork for a position or star player (only the paths: the images stay on FUMBBL). */
function artwork(p: PositionXml): Artwork | undefined {
  const sprites = text(p.iconSet);
  const size = typeof p.iconSet === "object" && !Array.isArray(p.iconSet) ? Number(text(p.iconSet.size)) || 1 : 1;
  const portrait = text(p.portrait);
  if (!sprites && !portrait) return undefined;
  return { ...(sprites ? { sprites: { path: sprites, size } } : {}), ...(portrait ? { portrait } : {}) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Text content of an element (its `#text` when it has attributes), "" when missing. */
const text = (v: Xml | Xml[]): string =>
  v === undefined ? "" : typeof v === "object" ? (Array.isArray(v) ? "" : text(v["#text"])) : String(v);
/** Target number or characteristic; null when empty (e.g. no PA). */
const stat = (v: Xml) => (text(v) === "" ? null : Number(text(v)));
const requiredStat = (v: Xml, what: string) => {
  const value = stat(v);
  if (value === null) throw new Error(`Missing ${what}`);
  return value;
};

async function get(path: string) {
  const res = await fetch(`${FUMBBL}/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.text();
}

/** FUMBBL skill category names -> the one-letter codes stored in Roster.positions[].normal/double. */
const CATEGORIES: Record<string, string> = {
  General: "G",
  Agility: "A",
  Strength: "S",
  Passing: "P",
  Mutation: "M",
  Devious: "D",
};
const category = (c: Xml) => CATEGORIES[text(c)] ?? text(c);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => ["position", "skill", "keyword", "normal", "double"].includes(name),
});

/** Skills with a value (e.g. Loner) become "Loner(4)". */
const skillList = (p: PositionXml) =>
  (p.skillList?.skill ?? []).map((s) => {
    const value = typeof s === "object" && !Array.isArray(s) ? text(s.value) : "";
    return value ? `${text(s)}(${value})` : text(s);
  });

/** Star players seen in any roster, by position id. */
const starPlayers = new Map<number, StarPlayer>();

/** A star player's characteristics and skills; their partner, if they are hired together, by name. */
function convertStar(p: PositionXml, positions: PositionXml[]): StarPlayer {
  const name = text(p.name);
  const partner = positions.find((q) => text(q.id) === text(p.teamWithPositionId));
  return {
    id: Number(p.id),
    name,
    cost: Number(text(p.cost)),
    ma: requiredStat(p.movement, `MA of ${name}`),
    st: requiredStat(p.strength, `ST of ${name}`),
    ag: requiredStat(p.agility, `AG of ${name}`),
    pa: stat(p.passing),
    av: requiredStat(p.armour, `AV of ${name}`),
    skills: skillList(p),
    keywords: (p.keywords?.keyword ?? []).map(text),
    ...(partner ? { partner: text(partner.name) } : {}),
    ...(artwork(p) ? { artwork: artwork(p) } : {}),
  };
}

/** The image server of FUMBBL's artwork, from the roster documents. */
let artworkBase = "";

function convertRoster(xml: string, tier: number): Roster {
  const r = (parser.parse(xml) as { roster: RosterXml }).roster;
  artworkBase ||= text(r.baseIconPath);
  const name = text(r.name);
  const stars = (r.position ?? []).filter((p) => text(p.type) === "Star");
  for (const star of stars) starPlayers.set(Number(star.id), convertStar(star, r.position ?? []));
  return {
    id: Number(r.id),
    name,
    tier,
    rerollCost: Number(text(r.reRollCost)),
    maxRerolls: Number(text(r.maxReRolls)),
    apothecary: text(r.apothecary) === "true",
    undead: text(r.undead) === "true",
    necromancer: text(r.necromancer) === "true",
    maxBigGuys: Number(text(r.maxBigGuys) || 0),
    keywords: (r.keywords?.keyword ?? []).map(text),
    stars: stars.map((p) => text(p.name)).sort(),
    ...(text(r.logo) ? { logo: text(r.logo) } : {}),
    positions: (r.position ?? [])
      .filter((p) => text(p.type) !== "Star")
      .map((p) => {
        const title = text(p.name);
        return {
          id: Number(p.id),
          title,
          type: text(p.type),
          quantity: Number(text(p.quantity)),
          cost: Number(text(p.cost)),
          ma: requiredStat(p.movement, `MA of ${name} ${title}`),
          st: requiredStat(p.strength, `ST of ${name} ${title}`),
          ag: requiredStat(p.agility, `AG of ${name} ${title}`),
          pa: stat(p.passing),
          av: requiredStat(p.armour, `AV of ${name} ${title}`),
          skills: skillList(p),
          normal: (p.skillCategoryList?.normal ?? []).map(category),
          double: (p.skillCategoryList?.double ?? []).map(category),
          keywords: (p.keywords?.keyword ?? []).map(text),
          ...(artwork(p) ? { artwork: artwork(p) } : {}),
        };
      }),
  };
}

const ruleset = JSON.parse(await get(`api/ruleset/get/${RULESET_ID}`)) as { rosters: RulesetRoster[] };
const entries = ruleset.rosters.filter((r) => r.enabled && r.value !== "Test roster");
const rosters: Roster[] = [];
for (const entry of entries) {
  rosters.push(convertRoster(await get(`xml:roster?id=${entry.id}`), Number(entry.tier)));
  await sleep(DELAY_MS);
}
rosters.sort((a, b) => a.name.localeCompare(b.name));
// Fail here rather than when the package loads.
RosterSchema.array().parse(rosters);
const stars = [...starPlayers.values()].sort((a, b) => a.name.localeCompare(b.name));
StarPlayerSchema.array().parse(stars);
writeFileSync(OUT, `${JSON.stringify({ source: `${FUMBBL}/api/ruleset/get/${RULESET_ID}`, artworkBase, rosters, starPlayers: stars }, null, 2)}\n`);
console.log(`Wrote ${rosters.length} rosters to ${OUT}`);
