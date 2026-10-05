import { BLOCK_FACES, type Casualty, type GameEvent, type GameState, type PassRange, type PlayerActionType, type Side } from "@bb/engine";

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
  dauntless: "Dauntless roll",
} as const;

/** What a skill did, for the log line of a SkillUsed event. */
const SKILL_USES: Record<string, string> = {
  Dodge: "to re-roll the dodge",
  "Sure Hands": "to re-roll the pick-up",
  Catch: "to re-roll the catch",
  Pass: "to re-roll the pass",
  "Mighty Blow": "",
  Frenzy: "and blocks again",
  "Stand Firm": "and is not pushed back",
  Sidestep: "to choose where to be pushed",
  "Jump Up": "to stand up for free",
  Dauntless: "and matches the defender's strength",
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
      return `Half ${e.half} starts.`;
    case "SetupDone":
      return `${sideName(state, e.side)} is set up.`;
    case "BallPlaced":
      return `Ball kicked towards (${e.square.x}, ${e.square.y}).`;
    case "DiceRolled":
      return `${e.reason}: ${e.rolls.map((r) => r.values.join("+")).join(" / ")}`;
    case "BallScattered":
      return `The ball scatters to (${e.to.x}, ${e.to.y}).`;
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
      return `${who(state, e.playerId)} throws a ${PASS_RANGE_NAMES[e.range].toLowerCase()}.`;
    case "PassResult":
      return `The pass is ${e.result === "fumble" ? "fumbled!" : e.result}.`;
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
    case "BallCaught":
      return `${who(state, e.playerId)} catches the ball.`;
    case "BallPickedUp":
      return `${who(state, e.playerId)} picks up the ball.`;
    case "PlayerKnockedDown":
      return `${who(state, e.playerId)} goes down!`;
    case "ArmourBroken":
      return `${who(state, e.playerId)}'s armour is broken (${e.roll}).`;
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
      return `End of half ${e.half}.`;
    case "GameEnded":
      return e.winner ? `Game over: ${sideName(state, e.winner)} wins!` : "Game over: it's a draw.";
  }
}
