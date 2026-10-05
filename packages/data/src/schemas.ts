import { z } from "zod";

/** Non-negative integer count (staff, re-rolls...). */
const count = z.number().int().min(0);

/** The five BB2025 characteristics. */
export const CHARACTERISTICS = ["ma", "st", "ag", "pa", "av"] as const;
export type Characteristic = (typeof CHARACTERISTICS)[number];

/** A BB2025 team can have at most 16 players. */
export const MAX_PLAYERS = 16;

/** One player of a team: a roster position plus what they gained or lost in a league. */
export const TeamPlayerSchema = z.strictObject({
  /** Shirt number, unique in the team. */
  number: z.number().int().positive(),
  name: z.string().min(1),
  /** Position title in the team's roster, e.g. "Human Blitzer". */
  position: z.string().min(1),
  /** Skills gained on top of the position's skills. */
  skills: z.array(z.string().min(1)).default([]),
  /**
   * Characteristic improvements, per characteristic: +1 MA, ST or AV each; for AG and PA each one lowers the target
   * number by 1 (3+ becomes 2+).
   */
  improvements: z.partialRecord(z.enum(CHARACTERISTICS), count).default({}),
  /**
   * Lasting injuries: one entry per -1 to a characteristic (AG and PA targets go up by 1), or "niggling" for a
   * Niggling Injury (+1 to casualty rolls).
   */
  injuries: z.array(z.enum([...CHARACTERISTICS, "niggling"])).default([]),
  /** Misses the next game: left out of the team when it is resolved. */
  missNextGame: z.boolean().default(false),
});

/** A BB2025 team: its roster, staff and players. */
export const TeamFileSchema = z.strictObject({
  name: z.string().min(1),
  /** Roster name, e.g. "Human", "Shambling Undead". */
  roster: z.string().min(1),
  /** Team re-rolls. */
  rerolls: count,
  apothecary: z.boolean().default(false),
  assistantCoaches: count.default(0),
  cheerleaders: count.default(0),
  dedicatedFans: z.number().int().min(1).max(7).default(1),
  players: z
    .array(TeamPlayerSchema)
    .min(1)
    .max(MAX_PLAYERS)
    .refine((ps) => new Set(ps.map((p) => p.number)).size === ps.length, "Player numbers must be unique"),
});

/** Parsed team file, with defaults applied. */
export type TeamFile = z.infer<typeof TeamFileSchema>;
/** Team file as written, before defaults. */
export type TeamFileInput = z.input<typeof TeamFileSchema>;
/** One player of a parsed team file. */
export type TeamPlayer = z.infer<typeof TeamPlayerSchema>;

/** BB2025 roster as published by FUMBBL (see scripts/fetch-rosters.ts). */
export const RosterSchema = z.object({
  id: z.number(),
  name: z.string(),
  tier: z.number(),
  rerollCost: z.number(),
  maxRerolls: z.number(),
  apothecary: z.boolean(),
  undead: z.boolean(),
  necromancer: z.boolean(),
  maxBigGuys: z.number(),
  keywords: z.array(z.string()),
  positions: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      type: z.string(),
      quantity: z.number(),
      cost: z.number(),
      ma: z.number(),
      st: z.number(),
      /** Target numbers: 3 means 3+. */
      ag: z.number(),
      /** null when the position cannot pass. */
      pa: z.number().nullable(),
      av: z.number(),
      skills: z.array(z.string()),
      /** Skill categories: G(eneral), A(gility), S(trength), P(assing), M(utation), D(evious). */
      normal: z.array(z.string()),
      double: z.array(z.string()),
      keywords: z.array(z.string()),
    }),
  ),
});

/** A BB2025 roster with its positions. */
export type Roster = z.infer<typeof RosterSchema>;
