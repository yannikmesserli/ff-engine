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

/** Skills the engine applies (by name, without value); keep in step with the README's "Implemented so far". */
export const IMPLEMENTED_SKILLS: readonly string[] = [
  "Block", "Dodge", "Tackle", "Guard", "No Ball", "Dirty Player", "Sneaky Git", "Thick Skull", "Stunty", "Regeneration",
  "Loner", "Unsteady", "Mighty Blow", "Frenzy", "Pass", "Sure Hands", "Stand Firm", "Sidestep", "Catch", "Really Stupid",
  "Bone Head", "Jump Up", "Sprint", "Horns", "Dauntless", "Wrestle", "Juggernaut", "Projectile Vomit", "Animosity",
  "Throw Team-mate", "Right Stuff", "Always Hungry", "Unchannelled Fury",
  "Disturbing Presence", "Secret Weapon", "Claws", "Titchy", "Stab", "Prehensile Tail", "Strong Arm", "Take Root",
  "Plague Ridden", "Bloodlust", "Defensive", "Brawler", "Nerves of Steel", "Steady Footing",
  "Shadowing", "Animal Savagery", "Timmm-ber!", "Foul Appearance", "Strip Ball", "Hypnotic Gaze", "On the Ball", "Safe Pass", "Hit and Run", "Diving Tackle", "Hatred", "Break Tackle", "My Ball", "Bombardier", "Pogo", "Taunt", "Fend", "Pro", "Eye Gouge",
];
