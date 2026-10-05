import type { PlayerState } from "./types";

/** Skill name without its value: rosters write "Loner(4)", "Hatred(undead)". */
export const skillName = (skill: string) => skill.replace(/\(.*\)$/, "").trim();

/** The player has the skill, whatever its value: `hasSkill(p, "Loner")` matches "Loner(4)". */
export const hasSkill = (player: PlayerState, name: string) => player.skills.some((s) => skillName(s) === name);
