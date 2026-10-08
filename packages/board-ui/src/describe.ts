import { BLOCK_FACES, type Casualty, type GameEvent, type GameState, type PassRange, type PlayerActionType, type Side, PRAYER_NAMES, type InducementId } from "@bb/engine";

const CHECK_NAMES = {
  dodge: "dodge",
  rush: "rush",
  jump: "jump",
  pickup: "pick-up",
  catch: "catch",
  standup: "stand-up roll",
  regeneration: "regeneration roll",
  loner: "Loner roll (the team re-roll is lost on a failure)",
  jumpup: "Jump Up roll",
  bonehead: "Bone Head roll",
  reallystupid: "Really Stupid roll",
  fury: "Unchannelled Fury roll",
  takeroot: "Take Root roll",
  bloodlust: "Bloodlust roll (a failure means feeding on a Thrall)",
  steadyfooting: "Steady Footing roll",
  dauntless: "Dauntless roll",
  vomit: "Projectile Vomit roll (a failure hits the vomiting player)",
  chainsaw: "Chainsaw roll (a failure kicks back: the chainsaw player is knocked down)",
  mascot: "Team Mascot roll (a failure spends a team re-roll instead, if any is left)",
  trapdoor: "Trapdoor roll (a 1 falls through)",
  tentacles: "Tentacles roll (a success holds the moving player in place)",
  breathefire: "Breathe Fire roll (6 knocks the target down, 4+ places them prone, a failure knocks the fire-breather down)",
  animosity: "Animosity roll (a failure keeps the ball and ends the action)",
  landing: "landing",
  hunger: "Always Hungry roll",
  escape: "escape roll",
  shadowing: "Shadowing roll",
  savagery: "Animal Savagery roll (a failure means lashing out at a team-mate)",
  appearance: "Foul Appearance roll (a failure wastes the block and ends the action)",
  gaze: "Hypnotic Gaze roll",
  bombcatch: "catch of the bomb",
  pro: "Pro roll (a failure keeps the first result)",
  pickmeup: "Pick-me-up roll",
  chomp: "Chomp roll",
  saboteur: "Saboteur roll (4+ knocks the blocker down, and the saboteur out)",
} as const;

/** What a skill did, for the log line of a SkillUsed event. */
const SKILL_USES: Record<string, string> = {
  Dodge: "to re-roll the dodge",
  "Sure Hands": "to re-roll the pick-up",
  Catch: "to re-roll the catch",
  "Sure Feet": "to re-roll the rush",
  "Arm Bar": "",
  Grab: "to push the opponent where they want",
  "Safe Pair of Hands": "to place the ball",
  "Diving Catch": "to catch the ball next to them",
  Fumblerooski: "and leaves the ball behind",
  Pass: "to re-roll the pass",
  "Mighty Blow": "",
  Claws: "to break the armour",
  Frenzy: "and blocks again",
  "Stand Firm": "and is not pushed back",
  Sidestep: "to choose where to be pushed",
  "Jump Up": "to stand up for free",
  Dauntless: "and matches the defender's strength",
  Wrestle: "and takes both players down",
  Juggernaut: "to turn Both Down into a Push",
  "Projectile Vomit": "",
  Stab: "",
  "Breathe Fire": "",
  Chainsaw: "",
  "Monstrous Mouth": "",
  "Take Root": "and cannot be pushed",
  Brawler: "to re-roll a Both Down",
  Hatred: "to re-roll a Skull",
  "Break Tackle": "to dodge free",
  Taunt: "and makes the attacker follow up",
  Trickster: "and slips to another square",
  "Give and Go": "and keeps moving",
  Swoop: "and swoops instead of scattering",
  "Ball & Chain": "",
  Tentacles: "and holds the moving player in place",
  Fend: "and keeps the attacker away",
  Pro: "to try a re-roll",
  "Eye Gouge": "(no block assists until their next action)",
  "Steady Footing": "and stays on their feet",
  Shadowing: "and follows into the vacated square",
  "Strip Ball": "and knocks the ball loose",
  "Safe Pass": "and keeps the ball",
  "Dump-off": "to pass before being hit",
  "Hit and Run": "to step away",
  "Diving Tackle": "(-2 to the roll) and dives into the square left",
};

/** Display names of the inducements. */
export const INDUCEMENT_NAMES: Record<InducementId, string> = {
  bribes: "a bribe",
  teamMascot: "the Team Mascot",
  partTimeCoaches: "Part-time Assistant Coaches",
  tempCheerleaders: "Temp Agency Cheerleaders",
  blitzersBestKegs: "Blitzer's Best Kegs",
  halflingMasterChef: "the Halfling Master Chef",
  riotousRookies: "Riotous Rookies",
  plagueDoctor: "the Plague Doctor",
  mortuaryAssistant: "the Mortuary Assistant",
  weatherMage: "the Weather Mage",
  biasedReferee: "the Biased Referee",
  prayers: "a Prayer to Nuffle",
};

/** Display names of the weather conditions. */
export const WEATHER_NAMES = {
  "sweltering-heat": "Sweltering Heat",
  "very-sunny": "Very Sunny",
  nice: "Nice",
  "pouring-rain": "Pouring Rain",
  blizzard: "Blizzard",
} as const;

const KICKOFF_NAMES = {
  "get-the-ref": "Get the Ref",
  "time-out": "Time-out",
  "solid-defence": "Solid Defence",
  "high-kick": "High Kick",
  "cheering-fans": "Cheering Fans",
  "brilliant-coaching": "Brilliant Coaching",
  "weather-change": "Weather Change",
  "quick-snap": "Quick Snap",
  charge: "Charge",
  "dodgy-snack": "Dodgy Snack",
  "pitch-invasion": "Pitch Invasion",
} as const;

/** Display names of the player actions, in action menu order. */
export const ACTION_NAMES: Record<PlayerActionType, string> = {
  move: "Move",
  block: "Block",
  blitz: "Blitz",
  pass: "Pass",
  handoff: "Hand-off",
  foul: "Foul",
  secure: "Secure the Ball",
  ttm: "Throw Team-mate",
  ktm: "Kick Team-mate",
  gaze: "Hypnotic Gaze",
  bomb: "Throw Bomb",
  punt: "Punt",
};

/** Display names of the pass ranges, shortest first. */
export const PASS_RANGE_NAMES: Record<PassRange, string> = {
  quick: "Quick pass",
  short: "Short pass",
  long: "Long pass",
  bomb: "Long bomb",
};

const CHARACTERISTIC_NAMES = { ma: "MA", st: "ST", ag: "AG", pa: "PA", av: "AV" } as const;

const LASTING_INJURY_NAMES = {
  av: "Head Injury",
  ma: "Smashed Knee",
  pa: "Broken Arm",
  ag: "Dislocated Hip",
  st: "Dislocated Shoulder",
} as const;

/** Display name of a casualty, e.g. "Serious Injury (Niggling Injury)" or "Smashed Knee (-1 MA)". */
export function casualtyName(c: Casualty): string {
  switch (c.result) {
    case "badly-hurt":
      return "Badly Hurt";
    case "seriously-hurt":
      return "Seriously Hurt (misses the next game)";
    case "serious-injury":
      return "Serious Injury (Niggling Injury)";
    case "lasting-injury":
      return `${LASTING_INJURY_NAMES[c.lasting!]} (-1 ${CHARACTERISTIC_NAMES[c.lasting!]})`;
    case "dead":
      return "Dead";
  }
}

/** Display name of a block die face (1-6), e.g. "both down". */
export const blockFaceName = (face: number) => BLOCK_FACES[face - 1]!.replace(/_/g, " ");

const sideName = (state: GameState, side: Side) => state.teams[side].name;
const who = (state: GameState, id: string) => state.players[id]?.name ?? id;

/** Human-readable game log line, or null for events not worth showing. */
export function describeEvent(state: GameState, e: GameEvent): string | null {
  switch (e.type) {
    case "GameStarted":
      return "The game begins.";
    case "FanFactor":
      return `${sideName(state, e.side)} fan factor: ${e.fanFactor}.`;
    case "WeatherChanged":
      return `Weather: ${WEATHER_NAMES[e.weather]}.`;
    case "KickoffResult":
      return `Kick-off event: ${KICKOFF_NAMES[e.result]}!`;
    case "BribeGained":
      return `${sideName(state, e.side)} gets a bribe.`;
    case "TurnCountersChanged":
      return `Both turn counters move ${e.delta > 0 ? "forward" : "back"} one turn.`;
    case "ExtraAssist":
      return `${sideName(state, e.side)} gets an extra block assist this drive.`;
    case "RerollGained":
      return `${sideName(state, e.side)} gets an extra re-roll this drive.`;
    case "DodgySnack":
      return e.sentOff
        ? `${who(state, e.playerId)} ate a dodgy snack and goes to the reserves.`
        : `${who(state, e.playerId)} ate a dodgy snack: -1 MA and -1 AV this drive.`;
    case "PlayerExhausted":
      return `${who(state, e.playerId)} is exhausted by the heat and misses the next drive.`;
    case "ChargeStarted":
      return `${sideName(state, e.side)} charges with ${e.playerIds.length} players!`;
    case "ChargeEnded":
      return "The charge is over.";
    case "CoinFlipped":
      return `Home calls ${e.call}, the coin shows ${e.result}: ${sideName(state, e.winner)} wins the toss.`;
    case "KickChosen":
      return `${sideName(state, e.kicking)} will kick.`;
    case "HalfStarted":
      return e.half === 3 ? "Overtime starts." : `Half ${e.half} starts.`;
    case "SetupDone":
      return `${sideName(state, e.side)} is set up.`;
    case "BallPlaced":
      return `Ball kicked towards (${e.square.x}, ${e.square.y}).`;
    case "DiceRolled":
      return `${e.reason}: ${e.rolls.map((r) => r.values.join("+")).join(" / ")}`;
    case "BallScattered":
      return `The ball scatters to (${e.to.x}, ${e.to.y}).`;
    case "Punted":
      return e.out
        ? `${who(state, e.playerId)} punts the ball into the crowd, from (${e.to.x}, ${e.to.y}).`
        : `${who(state, e.playerId)} punts the ball to (${e.to.x}, ${e.to.y}).`;
    case "BallBounced":
      return `The ball bounces to (${e.to.x}, ${e.to.y}).`;
    case "BallThrownIn":
      return `The crowd throws the ball back in to (${e.to.x}, ${e.to.y}).`;
    case "Touchback":
      return `Touchback! ${who(state, e.playerId)} receives the ball.`;
    case "TurnStarted":
      return `— ${sideName(state, e.side)}, turn ${e.turn} —`;
    case "TurnEnded":
      return e.turnover ? `Turnover! ${sideName(state, e.side)}'s turn ends.` : null;
    case "PlayerMoved":
      return null;
    case "ActionDeclared":
      return `${who(state, e.playerId)} declares a ${ACTION_NAMES[e.action]}${e.targetId ? ` on ${who(state, e.targetId)}` : ""}.`;
    case "BlockDeclared":
      return `${who(state, e.attackerId)} blocks ${who(state, e.defenderId)} (${Math.abs(e.dice)} ${Math.abs(e.dice) > 1 ? "dice" : "die"}${e.dice < 0 ? ", defender chooses" : ""}).`;
    case "BlockResult":
      return `Block result: ${blockFaceName(e.face)}.`;
    case "PlayerPushed":
      return e.to ? null : `${who(state, e.playerId)} is pushed into the crowd!`;
    case "PassThrown":
      if (e.hailMary) return `${who(state, e.playerId)} throws a Hail Mary Pass!`;
      return e.bomb ? `${who(state, e.playerId)} throws a bomb!` : `${who(state, e.playerId)} throws a ${PASS_RANGE_NAMES[e.range].toLowerCase()}.`;
    case "BombCaught":
      return `${who(state, e.playerId)} catches the bomb and must throw it again!`;
    case "BombExploded":
      return `BOOM! The bomb explodes at (${e.square.x}, ${e.square.y}).`;
    case "BombLost":
      return "The bomb fizzles out harmlessly.";
    case "BombHit":
      return `${who(state, e.playerId)} is caught in the blast.`;
    case "PassResult":
      return `The pass is ${e.result === "fumble" ? "fumbled!" : e.result}.`;
    case "TeamMateThrown":
      return `${who(state, e.playerId)} ${e.kicked ? "kicks" : "throws"} ${who(state, e.thrownId)}: ${{ accurate: e.kicked ? "a superb kick" : "a superb throw", inaccurate: e.kicked ? "a subpar kick" : "a subpar throw", fumble: "fumbled!" }[e.result]}`;
    case "Intercepted":
      return `${who(state, e.playerId)} intercepts the ball!`;
    case "InterceptionFailed":
      return `${who(state, e.playerId)} fails to intercept.`;
    case "HandedOff":
      return `${who(state, e.playerId)} hands the ball to ${who(state, e.targetId)}.`;
    case "BallSecured":
      return `${who(state, e.playerId)} secures the ball.`;
    case "Fouled":
      return `${who(state, e.foulerId)} fouls ${who(state, e.victimId)}${e.assists ? ` (${e.assists > 0 ? "+" : ""}${e.assists} assists)` : ""}.`;
    case "RefereeCall":
      return e.spotted ? `The referee saw it! ${who(state, e.foulerId)} gets the whistle.` : "The referee didn't see a thing.";
    case "ArgueTheCall":
      return {
        success: "The coach argues the call: the referee changes their mind!",
        failed: "The coach argues the call, in vain.",
        "coach-banned": "The coach argues too much and is banned from arguing again!",
      }[e.result];
    case "BribeUsed":
      return `${sideName(state, e.side)} bribes the referee${e.success ? ": it works!" : "... who keeps the money."}`;
    case "PlayerSentOff":
      return `${who(state, e.playerId)} is sent off!`;
    case "SecretWeaponSpotted":
      return `The drive is over: the referee wants ${who(state, e.playerId)} and their secret weapon off the pitch.`;
    case "FollowedUp":
      return `${who(state, e.playerId)} follows up.`;
    case "PlayerStoodUp":
      return `${who(state, e.playerId)} stands up.`;
    case "KoRecovery":
      return `${who(state, e.playerId)} ${e.recovered ? "recovers from the KO" : "is still knocked out"}.`;
    case "CheckResult":
      return `${who(state, e.playerId)} ${e.success ? "succeeds" : "fails"} the ${CHECK_NAMES[e.kind]} (${e.roll} vs ${e.target}+).`;
    case "RerollUsed":
      return `${sideName(state, e.side)} uses a team re-roll.`;
    case "PrayerRepeated":
      return `${sideName(state, e.side)} drew ${PRAYER_NAMES[e.prayer]} again: a team never gets the same prayer twice, so the D16 is rolled again.`;
    case "PrayerGranted": {
      const players = e.playerIds.map((id) => who(state, id)).join(", ");
      return `${sideName(state, e.side)} prays to Nuffle: ${PRAYER_NAMES[e.prayer]}${players ? ` (${players})` : ""}.`;
    }
    case "FellThroughTrapdoor":
      return `${who(state, e.playerId)} falls through the trapdoor!`;
    case "RookiesJoined":
      return `${e.playerIds.length} Riotous Rookies join ${sideName(state, e.side)} for the game.`;
    case "RerollsStolen":
      return `${sideName(state, e.side)}'s Halfling Master Chef steals ${e.count} re-roll${e.count === 1 ? "" : "s"} for the half.`;
    case "SpecialRuleUsed":
      return `${sideName(state, e.side)} uses ${e.rule}.`;
    case "InducementUsed":
      return `${sideName(state, e.side)} uses ${INDUCEMENT_NAMES[e.inducement]}.`;
    case "BallCaught":
      return `${who(state, e.playerId)} catches the ball.`;
    case "BallPickedUp":
      return `${who(state, e.playerId)} picks up the ball.`;
    case "PlayerPlacedProne":
      return `${who(state, e.playerId)} is placed prone.`;
    case "PlayerKnockedDown":
      return `${who(state, e.playerId)} goes down!`;
    case "ArmourBroken":
      return e.roll === undefined ? `${who(state, e.playerId)}'s armour is broken (no roll for a Ball & Chain player).` : `${who(state, e.playerId)}'s armour is broken (${e.roll}).`;
    case "ArmourHeld":
      return `${who(state, e.playerId)}'s armour holds (${e.roll}).`;
    case "PlayerInjured":
      return `${who(state, e.playerId)} is ${{ stunned: "stunned", ko: "knocked out", cas: "a casualty" }[e.result]}.`;
    case "CasualtyRolled":
      return `Casualty roll ${e.roll}: ${casualtyName(e.casualty)}.`;
    case "StallingDetected":
      return `${who(state, e.playerId)} is stalling: the crowd is getting restless.`;
    case "RockThrown":
      return e.roll === null
        ? `The crowd throws a rock at ${who(state, e.playerId)}, but it is too late in the half: it misses.`
        : `The crowd throws a rock at ${who(state, e.playerId)} (${e.roll}): ${e.hit ? "hit!" : "missed."}`;
    case "SkillUsed":
      return `${who(state, e.playerId)} uses ${e.skill}${SKILL_USES[e.skill] ? ` ${SKILL_USES[e.skill]}` : ""}.`;
    case "PlayerDistracted":
      return `${who(state, e.playerId)} fails the ${e.skill} roll: the action is lost, and they are distracted (no tackle zone) until their next action.`;
    case "PlayerThirsty":
      return `${who(state, e.playerId)} is thirsty: they must bite a Thrall before the action ends, or before passing or scoring.`;
    case "PlayerBitten":
      return `${who(state, e.playerId)} bites ${who(state, e.victimId)}.`;
    case "FeedingFailed":
      return `${who(state, e.playerId)} finds nobody to bite: turnover, and they lose their tackle zone.`;
    case "PlayerChomped":
      return `${who(state, e.playerId)} chomps ${who(state, e.victimId)}: they cannot move or be pushed while ${who(state, e.playerId)} stays next to them.`;
    case "PlayerRooted":
      return `${who(state, e.playerId)} takes root: they cannot move until knocked down or the drive ends.`;
    case "PlayerHypnotised":
      return `${who(state, e.playerId)} hypnotises ${who(state, e.victimId)}: no tackle zone until their next action.`;
    case "LashedOut":
      return `${who(state, e.playerId)} lashes out at ${who(state, e.victimId)}, and the action ends.`;
    case "ActionLost":
      return `${who(state, e.playerId)} fails the ${e.skill} roll and roars in rage: the action is lost.`;
    case "PlayerRaised":
      return `${who(state, e.fromId)} rises again, infected, and joins ${sideName(state, state.players[e.playerId]!.side)} as ${state.players[e.playerId]!.position}!`;
    case "PlayerEaten":
      return `${who(state, e.byId)} eats ${who(state, e.playerId)}!`;
    case "Regenerated":
      return `${who(state, e.playerId)} regenerates and goes to the reserves.`;
    case "ApothecaryUsed":
      return `The apothecary rushes to ${who(state, e.playerId)}.`;
    case "ApothecaryResult":
      return {
        stunned: `${who(state, e.playerId)} is patched up and only stunned.`,
        reserves: `${who(state, e.playerId)} is patched up and goes to the reserves.`,
        casualty: `${who(state, e.playerId)} keeps: ${e.casualty ? casualtyName(e.casualty) : ""}.`,
      }[e.result];
    case "Touchdown":
      return `TOUCHDOWN! ${who(state, e.playerId)} scores for ${sideName(state, e.side)}.`;
    case "HalfEnded":
      return e.half === 3 ? "End of overtime." : `End of half ${e.half}.`;
    case "GameEnded":
      return e.winner ? `Game over: ${sideName(state, e.winner)} wins!` : "Game over: it's a draw.";
  }
}
