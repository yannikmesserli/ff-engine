/**
 * Downloads the BB2025 rosters from FUMBBL into
 * src/generated/rosters.json. Star players are dropped: they are inducements, not roster positions.
 *
 * Run with: pnpm fetch-rosters
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { RosterSchema, type Roster } from "../src/schemas";

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
  skillList?: { skill?: Xml[] };
  skillCategoryList?: { normal?: Xml[]; double?: Xml[] };
  keywords?: { keyword?: Xml[] };
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

function convertRoster(xml: string, tier: number): Roster {
  const r = (parser.parse(xml) as { roster: RosterXml }).roster;
  const name = text(r.name);
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
          // Skills with a value (e.g. Loner) become "Loner(4)".
          skills: (p.skillList?.skill ?? []).map((s) => {
            const value = typeof s === "object" && !Array.isArray(s) ? text(s.value) : "";
            return value ? `${text(s)}(${value})` : text(s);
          }),
          normal: (p.skillCategoryList?.normal ?? []).map(category),
          double: (p.skillCategoryList?.double ?? []).map(category),
          keywords: (p.keywords?.keyword ?? []).map(text),
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
writeFileSync(OUT, JSON.stringify({ source: `${FUMBBL}/api/ruleset/get/${RULESET_ID}`, rosters }, null, 2) + "\n");
console.log(`Wrote ${rosters.length} rosters to ${OUT}`);
