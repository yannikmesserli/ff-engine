import type { PlayerState } from "./types";

/** Skill name without its value: rosters write "Loner(4)", "Hatred(undead)". */
export const skillName = (skill: string) => skill.replace(/\(.*\)$/, "").trim();

/** The player has the skill, whatever its value: `hasSkill(p, "Loner")` matches "Loner(4)". */
export const hasSkill = (player: PlayerState, name: string) => player.skills.some((s) => skillName(s) === name);

/** The number in a skill's value ("Mighty Blow(+2)" gives 2), `fallback` without one, null without the skill. */
export function skillValue(player: PlayerState, name: string, fallback: number): number | null {
  const skill = player.skills.find((s) => skillName(s) === name);
  if (skill === undefined) return null;
  return Number(/\(\+?(\d+)\+?\)$/.exec(skill)?.[1] ?? fallback);
}
