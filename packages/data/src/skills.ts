/**
 * Short BB2025 descriptions of the skills and traits, in our own words, for tooltips. `{X}` stands for the skill's
 * value ("Loner(4)": 4); see `skillDescription`.
 */
export const SKILL_DESCRIPTIONS: Record<string, string> = {
  // Agility
  Catch: "May re-roll a failed catch roll.",
  Defensive: "During the opponent's turn, opponents this player marks cannot use Guard or Put the Boot In.",
  "Diving Catch": "May try to catch a pass or kick that lands in an adjacent square; +1 to catch an accurate pass in its own square.",
  "Diving Tackle": "When an opponent dodges or leaps out of this player's tackle zone, -2 to their roll; this player is then placed prone in the square they left.",
  Dodge: "Once per turn, may re-roll a failed Dodge roll. When blocked, a Stumble is only a push (unless the blocker has Tackle).",
  "Hit and Run": "After a block, if still standing, may move one free square, as long as it is not into an opponent's tackle zone.",
  "Jump Up": "Stands up for free (no movement spent). May declare a Block while prone: an AG roll with +1 to stand up and block.",
  Leap: "May jump over any adjacent square, occupied or not; the Jump roll's penalty is reduced by 1, but not below -1.",
  "Safe Pair of Hands": "When knocked down or placed prone with the ball, places it in an adjacent free square instead of it bouncing.",
  Sidestep: "When pushed back, this player's coach chooses the square: any free adjacent square.",
  Sprint: "May Rush three times per action instead of two.",
  "Sure Feet": "Once per turn, may re-roll a failed Rush.",
  // General
  Block: "Not knocked down by a Both Down result.",
  Dauntless: "Blocking a stronger player: roll D6 + ST, and beating their ST makes this player's ST equal to theirs for the block.",
  Fend: "When pushed back by a block (even if knocked down), may stop the attacker from following up; not against a blitzing Juggernaut.",
  Frenzy: "Must follow up. After a Push or a dodged Stumble, must block the same player again if both still stand next to each other.",
  Kick: "When kicking off, may halve the kick deviation (D3 instead of D6).",
  Pro: "Once per turn, in their own action, may roll a D6 to re-roll one of their failed rolls: on 3+ the die is re-rolled. Not for armour, injury or casualty rolls.",
  "Steady Footing": "When knocked down or placed prone, roll a D6: on 6 the player stays standing.",
  "Strip Ball": "When this player pushes back the ball carrier with a block, the ball is dropped and bounces.",
  "Sure Hands": "May re-roll a failed pick-up. Strip Ball does not work against this player.",
  Tackle: "Opponents dodging out of this player's tackle zone cannot use Dodge, and Dodge does not save them on a Stumble.",
  Taunt: "When pushed back by a block, may force the attacker to follow up.",
  Wrestle: "On Both Down (as attacker or defender), may place both players prone instead: no armour rolls and no turnover.",
  // Strength
  "Arm Bar": "+1 to the armour or injury roll of an opponent who falls while dodging, jumping or leaping out of this player's tackle zone.",
  Brawler: "When blocking, may re-roll one Both Down result.",
  "Break Tackle": "Once per turn, adds to a failed Dodge roll: +1 with ST 3 or less, +2 with ST 4, +3 with ST 5 or more.",
  Bullseye: "When throwing a team-mate, a superb throw lands in the target square without scattering.",
  Grab: "When this player pushes an opponent back with a block, chooses any free adjacent square for them; cancels Sidestep.",
  Guard: "Assists blocks even when marked by other opponents.",
  Juggernaut: "During a Blitz, may treat Both Down as a Push, and the defender cannot use Fend, Stand Firm or Wrestle.",
  "Mighty Blow": "+{X} to the armour or the injury roll (not both) of an opponent this player knocks down with a block.",
  "Multiple Block": "May block two opponents at once, each block at -2 ST.",
  "Stand Firm": "May refuse to be pushed back by a block (a knock-down still happens in place). Cancelled by a blitzing Juggernaut.",
  "Strong Arm": "+1 to the roll when throwing a team-mate.",
  "Thick Skull": "Only knocked out on a 9 on the injury table (8 for Stunty): an 8 (7 for Stunty) is Stunned instead.",
  // Passing
  Accurate: "+1 to Quick and Short passes.",
  Cannoneer: "+1 to Long passes and Long Bombs.",
  "Cloud Burster": "This player's passes cannot be intercepted (except by a player with Very Long Legs).",
  "Dump-off": "When targeted by a block or a special action while holding the ball, may first make a Quick pass; nobody's turn ends because of it.",
  "Give and Go": "After a Quick pass that is not fumbled, or a hand-off, without a turnover, may move on with the squares left.",
  "Hail Mary Pass": "May throw to any square of the pitch; it is never accurate and cannot be intercepted.",
  Leader: "The team gets an extra re-roll each half while this player is on the pitch.",
  "Nerves of Steel": "Ignores tackle zones when passing, catching or intercepting.",
  "On the Ball": "When an opponent declares a pass (or at the kick-off), may move up to 3 squares.",
  Pass: "May re-roll an inaccurate or fumbled pass, instead of using a team re-roll.",
  Punt: "Special action, once per turn: kicks the ball D6 squares on a throw-in template facing a chosen side; out of bounds or caught by an opponent is a turnover.",
  "Safe Pass": "A pass fumbled on a natural 1 is not dropped: the thrower keeps the ball and the action ends, without a turnover.",
  // Devious
  "Dirty Player": "+{X} to the armour or the injury roll (not both) when fouling.",
  "Eye Gouge": "An opponent this player pushes back cannot assist until their next activation.",
  Fumblerooski: "May leave the ball in any square moved through, without a turnover.",
  "Lethal Flight": "When thrown onto an opponent, +1 to the armour or injury roll against them.",
  "Lone Fouler": "May re-roll a failed armour roll when fouling without assists.",
  "Pile Driver": "After knocking an opponent down with a block, may foul them for free, then is placed prone.",
  "Put the Boot In": "Gives foul assists even while marked.",
  "Quick Foul": "May keep moving after a foul.",
  Saboteur: "When knocked down, roll a D6: on 4+ the opponent is knocked down too, and this player is KO'd.",
  Shadowing: "When an opponent dodges out of this player's tackle zone, roll a D6: on 4+ may move into the square they left.",
  "Sneaky Git": "Not sent off for a double on the armour roll of a foul if the armour holds.",
  "Violent Innovator": "Earns casualty Star Player Points from special actions.",
  // Mutation
  "Big Hand": "Ignores tackle zones and Pouring Rain when picking up the ball.",
  Claws: "When this player knocks an opponent down, their armour breaks on 8+ whatever their AV.",
  "Disturbing Presence": "-1 to passes, catches and interceptions of opponents within 3 squares.",
  "Extra Arms": "+1 to catch, pick up or intercept the ball.",
  "Foul Appearance": "An opponent who wants to block this player (or use a special action on them) must roll 2+ on a D6, or the action is lost.",
  Horns: "+1 ST when blocking during a Blitz.",
  "Iron Hard Skin": "Opponents cannot modify armour rolls against this player, and Claws does not work against them.",
  "Monstrous Mouth": "May chomp an adjacent opponent: on 3+ they cannot leave their square while marked by this player.",
  "Prehensile Tail": "-1 more to the Dodge, Jump and Leap rolls of opponents leaving this player's tackle zone.",
  Tentacles: "When an opponent dodges or jumps away from this player, may roll D6 + own ST - their ST: on 6+ they are held in place and their action ends.",
  "Two Heads": "+1 to Dodge rolls.",
  "Very Long Legs": "+1 to Jump and Leap rolls, +2 to interceptions; ignores Cloud Burster.",
  // Extraordinary
  "Bloodlust": "After declaring an action, roll a D6 (+1 for a Block or Blitz): below {X} the vampire must bite an adjacent Thrall.",
  // Traits
  "Always Hungry": "Before throwing a team-mate, roll a D6: on a 1 the team-mate must escape (2+), or be eaten.",
  "Animal Savagery": "After declaring an action, roll a D6 (+2 for a Block or Blitz): on 1-3 the player lashes out at an adjacent team-mate, or loses the action.",
  Animosity: "Before passing or handing off to {X}, roll a D6: on a 1 the player refuses and the action ends.",
  "Ball & Chain": "Can only take a Ball & Chain move: moves randomly, blocking whoever is in the way.",
  Bombardier: "Once per turn, a Throw Bomb special action (no move first): thrown like a pass, the bomb explodes where it stops, hitting the player there and those around it on 4+.",
  "Bone Head": "After declaring an action, roll a D6: on a 1 the action is lost and the player is distracted (no tackle zone) until their next activation.",
  "Breathe Fire": "Instead of a block: roll a D6 (-1 against ST 5+), re-rollable: 6 knocks the opponent down, 4+ places them prone, a 1 knocks this player down (turnover).",
  Chainsaw: "Special action: a chainsaw attack on an adjacent opponent, +3 to the armour roll; a 1 hurts this player instead.",
  Decay: "Casualty rolls against this player are +1.",
  Drunkard: "-1 to Rush rolls.",
  Hatred: "When blocking an opponent with keyword {X}, may re-roll one Skull result.",
  "Hypnotic Gaze": "Special action: an adjacent opponent loses their tackle zone on 3+ until their next activation.",
  Insignificant: "Only matters when building the team: there cannot be more Insignificant players than the others.",
  "Kick Team-mate": "Special action, once per turn: kicks an adjacent team-mate with Right Stuff like a Throw Team-mate; a fumble hurts them (Stunned counts as KO'd).",
  Loner: "Using a team re-roll needs a {X}+ on a D6 first; otherwise the re-roll is lost.",
  "My Ball": "Cannot give the ball up voluntarily (no pass or hand-off).",
  "No Ball": "Cannot catch, pick up, intercept or hold the ball.",
  "Pick-me-up": "At the end of the opponent's turn, prone team-mates within 3 squares of this (standing) player may roll a D6: on 5+ they stand up.",
  "Plague Ridden": "Once per game, an opponent this player kills can join the team as a lineman.",
  Pogo: "May jump over any adjacent square, empty or not, ignoring tackle zones and Prehensile Tail; Diving Tackle does not work on its jumps.",
  "Projectile Vomit": "Instead of a block: on 2+, an adjacent opponent rolls armour with no modifier and is placed prone if it breaks; on a 1, this player does.",
  "Really Stupid": "After declaring an action, roll a D6 (2+ next to a team-mate without Really Stupid, 4+ otherwise) or the action is lost and the player is distracted.",
  Regeneration: "After a casualty roll, roll a D6: on 4+ the player heals and goes to the reserves.",
  "Right Stuff": "Can be thrown by a team-mate with Throw Team-mate, even when prone.",
  "Secret Weapon": "Sent off at the end of every drive this player plays in.",
  Stab: "Instead of a block: an adjacent opponent rolls armour with no modifier.",
  Stunty: "Ignores tackle zones on the square moved to when dodging; uses the Stunty injury table (7 KO'd, 9 Badly Hurt).",
  Swoop: "When thrown, may move in a straight line instead of scattering, and re-roll the landing.",
  "Take Root": "After declaring an action, roll a D6: on a 1 the player is rooted (cannot move or be pushed) for the rest of the drive.",
  "Throw Team-mate": "Once per turn, may throw an adjacent team-mate with Right Stuff to a Quick or Short square.",
  "Timmm-ber!": "Standing up with MA 2 or less: +1 to the roll per adjacent standing team-mate not marked by an opponent (a 1 still fails).",
  Titchy: "+1 to Dodge rolls, but opponents ignore this player's tackle zone when dodging into it.",
  Trickster: "When about to be blocked (or hit by an attack replacing a block), may first move to a free square next to the attacker, with the ball.",
  "Unchannelled Fury": "After declaring an action, roll a D6 (+2 for a Block or Blitz): on 1-3 the action is lost.",
  Unsteady: "Cannot declare Secure the Ball.",
};

/** The skill without its value, and the value: "Loner(4)" gives ["Loner", "4"]. */
function parseSkill(skill: string): [string, string | null] {
  const match = /^(.*?)\s*\((.*)\)$/.exec(skill);
  return match ? [match[1]!.trim(), match[2]!.trim()] : [skill.trim(), null];
}

/** The description of a skill as written on a roster ("Loner(4)", "Mighty Blow(+1)"), with its value filled in. */
export function skillDescription(skill: string): string | null {
  const [name, value] = parseSkill(skill);
  const text = SKILL_DESCRIPTIONS[name];
  if (!text) return null;
  // Plain Animosity dislikes every team-mate; "Animosity(goblin)" only those with that keyword.
  if (name === "Animosity") return text.replace("{X}", value && value !== "all" ? `a team-mate with keyword ${value}` : "any team-mate");
  const fallback = name === "Mighty Blow" || name === "Dirty Player" ? "1" : "X";
  return text.replace("{X}", (value ?? fallback).replace(/^\+/, ""));
}
