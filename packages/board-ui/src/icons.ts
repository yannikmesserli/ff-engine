import type { PlayerState } from "@bb/engine";

/** Sprite base names (in `iconssmall/`) per BB2025 roster and position. */
const PLAYER_ICONS: Record<string, Record<string, string>> = {
  "Amazon": { "Eagle Warrior": "amlineman", "Python Warrior": "amthrower", "Piranha Warrior": "amcatcher", "Jaguar Warrior Blocker": "amblitzer" },
  "Black Orc": { "Goblin Bruiser": "goblin", "Black Orc": "oblackorc" },
  "Chaos Chosen": { "Beastman Runner Lineman": "cbeastman", "Chaos Chosen": "cwarrior" },
  "Chaos Dwarf": { "Hobgoblin Lineman": "cdhobgoblin", "Chaos Dwarf Blocker": "cddwarf", "Bull Centaur Blitzer": "centaur" },
  "Dark Elf": { "Dark Elf Lineman": "delineman", "Dark Elf Runner": "dethrower", "Dark Elf Blitzer": "deblitzer", "Dark Elf Assassin": "dehorkon", "Witch Elf": "dewitchelf" },
  "Dwarf": { "Dwarf Blocker Lineman": "dlongbeard", "Dwarf Runner": "drunner", "Dwarf Blitzer": "dblitzer", "Troll Slayer": "dslayer", "Deathroller": "ddeathroller" },
  "Elven Union": { "Elf Lineman": "eplineman", "Elf Thrower": "epthrower", "Elf Catcher": "epcatcher", "Elf Blitzer": "epblitzer" },
  "Goblin": { "Bomma": "gobomber", "Fanatic": "gofungus" },
  "High Elf": { "High Elf Lineman": "helineman", "Phoenix Warrior": "hethrower", "White Lion": "heblitzer", "Dragon Prince": "hecatcher" },
  "Human": { "Human Lineman": "hlineman", "Human Thrower": "hthrower", "Human Catcher": "hcatcher", "Human Blitzer": "hblitzer" },
  "Lizardmen": { "Skink Lineman": "lmskink", "Chameleon Skink": "lmskink", "Saurus Blocker": "lmsaurus" },
  "Necromantic Horror": { "Zombie Lineman": "nzombie", "Ghoul Runner": "nghoul", "Flesh Golem": "ngolem", "Werewolf": "nwerewolf" },
  "Norse": { "Norse Raider": "nlineman", "Norse Berserker": "nblitzer", "Valkyrie": "nthrower", "Ulfwerener": "nwerewolf" },
  "Nurgle": { "Rotter Lineman": "rtrotter", "Rotspawn": "rtbeast" },
  "Old World Alliance": {
    "Human Lineman": "hlineman", "Human Thrower": "hthrower", "Human Catcher": "hcatcher", "Human Blitzer": "hblitzer",
    "Dwarf Lineman": "dlongbeard", "Dwarf Runner": "drunner", "Dwarf Blitzer": "dblitzer", "Troll Slayer": "dslayer",
  },
  "Orc": { "Orc Lineman": "olineman", "Orc Thrower": "othrower", "Orc Blitzer": "oblitzer", "Big Un Blocker": "oblackorc" },
  "Shambling Undead": { "Skeleton Lineman": "uskeleton", "Zombie Lineman": "uzombie", "Ghoul Runner": "ughoul", "Wight Blitzer": "uwight" },
  "Skaven": { "Skaven Clanrat": "sklineman", "Skaven Thrower": "skthrower", "Gutter Runner": "skrunner", "Blitzer": "skstorm" },
  "Snotling": { "Snotling Lineman": "snot", "Pump Wagon": "snpump" },
  "Tomb Kings": { "Skeleton Lineman": "kmskeleton", "Tomb Kings Thrower": "kmthrower", "Tomb Kings Blitzer": "kmblitzer", "Tomb Guardian": "kmmummy" },
  "Underworld Denizens": { "Skaven Clanrat": "sklineman", "Skaven Thrower": "skthrower", "Gutter Runner": "skrunner", "Skaven Blitzer": "skstorm", "Snotling Lineman": "snot" },
  "Vampire": { "Thrall Lineman": "vthrall", "Vampire Runner": "vampire", "Vampire Thrower": "vampire", "Vampire Blitzer": "vampire" },
  "Wood Elf": { "Wood Elf Lineman": "welineman", "Wood Elf Thrower": "wethrower", "Wood Elf Catcher": "wecatcher", "Wardancer": "weblitzer" },
};

/** Positions sharing a sprite whatever the roster (big guys, goblins, halflings...). */
const SHARED_ICONS: Record<string, string> = {
  "Ogre": "ogre",
  "Troll": "troll",
  "Trained Troll": "troll",
  "Chaos Troll": "troll",
  "Minotaur": "minotaur",
  "Rat Ogre": "ratogre",
  "Kroxigor": "kroxigor",
  "Mummy": "umummy",
  "Loren Forest Treeman": "treeman",
  "Altern Forest Treeman": "treeman",
  "Goblin Lineman": "goblin",
  "Halfling Hopeful": "halfling",
};

/** Sprite URL of a player, or null if unknown. Home players use the "b" (blue) variant, active players the "an" (animated) one. */
export function playerIcon(assets: string, roster: string, player: PlayerState, active: boolean): string | null {
  const base = PLAYER_ICONS[roster]?.[player.position] ?? SHARED_ICONS[player.position];
  if (!base) return null;
  return `${assets}/iconssmall/${base}1${player.side === "home" ? "b" : ""}${active ? "an" : ""}.gif`;
}

/** Logo files (in `teamlogos/`) whose name differs from the BB2025 roster name. */
const LOGOS: Record<string, string> = {
  "Black Orc": "orc",
  "Chaos Chosen": "chaos",
  "Chaos Renegade": "chaos renegades",
  "Goblin": "goblins",
  "Halfling": "haflings",
  "Lizardmen": "lizardman",
  "Necromantic Horror": "necromantic",
  "Old World Alliance": "human",
  "Shambling Undead": "undead",
  "Tomb Kings": "khemri",
  "Underworld Denizens": "underworld",
};

/** Team logo URL for a roster name. */
export const teamLogo = (assets: string, roster: string) =>
  `${assets}/teamlogos/${encodeURIComponent(LOGOS[roster] ?? roster.toLowerCase())}.png`;
