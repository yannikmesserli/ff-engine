/** Home defends the left end zone (x = 0), away the right one. */
export type Side = "home" | "away";

/** Pitch coordinates: x in 0..25 from the home end zone, y in 0..14 from the top sideline. */
export interface Square {
  x: number;
  y: number;
}

/** "banned": sent off by the referee for the rest of the game. */
export type DugoutBox = "reserves" | "ko" | "cas" | "banned";

/** BB2025 weather table results (see weatherFor). */
export type Weather = "sweltering-heat" | "very-sunny" | "nice" | "pouring-rain" | "blizzard";

/** BB2025 kick-off events, in table order (2-12). */
export type KickoffResult =
  | "get-the-ref"
  | "time-out"
  | "solid-defence"
  | "high-kick"
  | "cheering-fans"
  | "brilliant-coaching"
  | "weather-change"
  | "quick-snap"
  | "charge"
  | "dodgy-snack"
  | "pitch-invasion";

/** Only meaningful for players on the pitch. */
export type PlayerStatus = "standing" | "prone" | "stunned";

/** The five BB2025 characteristics. */
export type Characteristic = "ma" | "st" | "ag" | "pa" | "av";

/** Injury table result (2D6): a Stunty player can go straight to Badly Hurt on a 9. */
export type InjuryOutcome = "stunned" | "ko" | "badly-hurt" | "casualty";

/**
 * BB2025 casualty table (D16): Badly Hurt (no lasting effect), Seriously Hurt (misses the next game), Serious Injury
 * (Niggling Injury, misses the next game), Lasting Injury (-1 to a characteristic, misses the next game), Dead.
 */
export type CasualtyResult = "badly-hurt" | "seriously-hurt" | "serious-injury" | "lasting-injury" | "dead";

/** A casualty suffered this game. */
export interface Casualty {
  result: CasualtyResult;
  /** The characteristic a Lasting Injury lowers. */
  lasting?: Characteristic;
}

/** A player during the game, with its current (possibly modified) characteristics. */
export interface PlayerState {
  /** "<side>-<nr>", e.g. "home-7". */
  id: string;
  side: Side;
  nr: number;
  name: string;
  position: string;
  ma: number;
  st: number;
  /** BB2025 target numbers: AG 3 means 3+. PA is null when the player cannot pass. */
  ag: number;
  pa: number | null;
  av: number;
  /** Skill names as in the rosters, with an optional value: "Block", "Loner(4)". */
  skills: string[];
  /** Position keywords from the roster: "lineman", "big guy"... */
  keywords: string[];
  /** Primary skill categories ("G", "A"...), for Intensive Training. */
  primary: string[];
  /** A square on the pitch, or a dugout box. */
  at: Square | DugoutBox;
  status: PlayerStatus;
  /** Has taken its action this turn. */
  activated: boolean;
  /** Squares moved during the current action (standing up counts as min(3, MA)). */
  movesUsed: number;
  /** Sweltering Heat: cannot be set up for the next drive. */
  exhausted: boolean;
  /** Dodgy Snack: -1 MA and -1 AV for the drive (restored from these values at the end of the drive). */
  snack: { ma: number; av: number } | null;
  /** Niggling Injuries from earlier games: +1 each to casualty rolls. */
  nigglingInjuries: number;
  /** The casualty suffered this game, if any (the player is then in the "cas" box). */
  casualty: Casualty | null;
  /** Once-per-turn skills used this team turn, e.g. "Dodge". */
  usedSkills: string[];
  /**
   * Failed a Bone Head or Really Stupid roll: no tackle zone, cannot catch, intercept or assist, until the player's
   * next activation or the end of the drive.
   */
  distracted: boolean;
  /**
   * Failed a Take Root roll: cannot move, rush or be pushed until knocked down or placed prone (cleared at the next
   * activation once down) or the end of the drive. See `isRooted`.
   */
  rooted: boolean;
  /** Pushed back by a player with Eye Gouge: cannot assist blocks until the player's next activation. */
  gouged: boolean;
  /** Was on the pitch for the current drive's kick-off (Secret Weapon players are sent off when the drive ends). */
  played: boolean;
}

/** A team's game-long and drive-long resources. */
export interface TeamState {
  side: Side;
  name: string;
  /** BB2025 roster name, e.g. "Human". */
  roster: string;
  score: number;
  /** Turn counter for the current half (0 before the first turn). */
  turn: number;
  rerolls: number;
  rerollsPerHalf: number;
  /** Extra re-rolls for the current drive only (Brilliant Coaching). Used before the normal ones. */
  driveRerolls: number;
  /**
   * Leader: the players with the skill on the pitch at the half's first kick-off. While one of them is on the pitch,
   * the team has one more team re-roll for the half (`leaderUsed` once spent), kept into overtime.
   */
  leaders: string[];
  leaderUsed: boolean;
  dedicatedFans: number;
  /** Dedicated fans + D3, rolled before the game. */
  fanFactor: number;
  cheerleaders: number;
  assistantCoaches: number;
  /** Bribes left (bought as inducements, plus Get the Ref). */
  bribes: number;
  /** Team special rules, e.g. "Bribery and Corruption". */
  specialRules: string[];
  /** The lineman position Riotous Rookies come from, if any. */
  journeymanPosition: PositionStats | null;
  /** Inducements bought for this game; what is left of them is tracked where they are used. */
  inducements: Inducements;
  /** Bribery and Corruption (a team special rule): its once-per-game re-roll of an Argue the Call 1 was used. */
  briberyRerollUsed?: boolean;
  /** Prayers to Nuffle granted to the team for the game. */
  prayers: Prayer[];
  /** How many of each inducement were used up (the once-per-game ones: Plague Doctor, Mortuary Assistant...). */
  inducementsUsed: Inducements;
  /** Team Mascot: tried this half (once per half); `mascotRolling`: its 4+ roll is due before the die is re-rolled. */
  mascotUsed: boolean;
  mascotRolling: boolean;
  /** Argued the call and rolled a 1: cannot argue again this game. */
  coachBanned: boolean;
  /** Cheering Fans: one extra offensive block assist this drive. */
  extraAssist: boolean;
  /** Apothecaries left for this game (one use each). */
  apothecaries: number;
  /** The position an opponent killed by a Plague Ridden player joins the team as, if any. */
  raisePosition: PositionStats | null;
  /** Opponents who joined the team this game (Plague Ridden: once per game). */
  raisedDead: number;
}

/** Where the ball is; `square` is null while it is off the pitch (before the kick-off, during a throw-in or touchback). */
export interface BallState {
  square: Square | null;
  /** Held by the player on `square`, as opposed to lying on the ground. */
  carried: boolean;
}

/** A position's characteristics, skills and keywords, as given to a new player. */
export interface PositionStats {
  position: string;
  ma: number;
  st: number;
  ag: number;
  pa: number | null;
  av: number;
  skills: string[];
  keywords?: string[];
  /** Primary skill categories, as the rosters write them ("G", "A", "S", "P", "D", "Mutations"). */
  primary?: string[];
}

/** BB2025 inducements a team can buy before a game (star players and Infamous Coaching Staff aside). */
export const INDUCEMENTS = [
  "bribes",
  "teamMascot",
  "partTimeCoaches",
  "tempCheerleaders",
  "blitzersBestKegs",
  "halflingMasterChef",
  "riotousRookies",
  "plagueDoctor",
  "mortuaryAssistant",
  "weatherMage",
  "biasedReferee",
  "prayers",
] as const;
export type InducementId = (typeof INDUCEMENTS)[number];

/** The 16 BB2025 Prayers to Nuffle, in table order (D16: 1 is Treacherous Trapdoor). */
export const PRAYERS = [
  "treacherous-trapdoor",
  "friends-with-the-ref",
  "stiletto",
  "iron-man",
  "knuckle-dusters",
  "bad-habits",
  "greasy-cleats",
  "blessing-of-nuffle",
  "moles-under-the-pitch",
  "perfect-passing",
  "dazzling-catching",
  "fan-interaction",
  "fouling-frenzy",
  "throw-a-rock",
  "under-scrutiny",
  "intensive-training",
] as const;
export type Prayer = (typeof PRAYERS)[number];

/** Inducements bought for the game, by id (missing: none). */
export type Inducements = Partial<Record<InducementId, number>>;

/** Input shape used to create a game: a fully resolved team (stats already merged from the roster). */
export interface TeamSetup {
  name: string;
  /** BB2025 roster name, e.g. "Human". */
  roster: string;
  rerolls: number;
  apothecary: boolean;
  dedicatedFans: number;
  cheerleaders: number;
  assistantCoaches: number;
  /** The lineman position an opponent killed by one of the team's Plague Ridden players joins the team as. */
  raisePosition?: PositionStats;
  /** Team special rules, e.g. "Bribery and Corruption", "Favoured of Nurgle". */
  specialRules?: string[];
  /** The lineman position journeymen and Riotous Rookies come from. */
  journeymanPosition?: PositionStats;
  /** Inducements bought for this game. */
  inducements?: Inducements;
  players: Array<
    PositionStats & {
      nr: number;
      name: string;
      /** Niggling Injuries from earlier games. */
      nigglingInjuries?: number;
    }
  >;
}

/** "coin": 1 heads, 2 tails. "block": 1..6, see BLOCK_FACES. */
export type DiceKind = "coin" | "d3" | "d6" | "d8" | "d16" | "block";

/** Dice requested by a ROLL template. */
export interface DiceSpec {
  kind: DiceKind;
  count: number;
}

/** Dice rolled, as reported in a DiceRolled event. */
export interface DiceRoll {
  kind: DiceKind;
  values: number[];
}

/** Actions a player can declare when activated. */
export type PlayerActionType = "move" | "block" | "blitz" | "pass" | "handoff" | "foul" | "secure" | "ttm" | "ktm" | "gaze" | "bomb" | "punt";

/** BB2025 range bands: Quick, Short, Long, Long Bomb. */
export type PassRange = "quick" | "short" | "long" | "bomb";
export type PassResult = "accurate" | "inaccurate" | "fumble";

/** Single-D6 rolls run by the Check procedure; "loner" is the Loner(X) roll to use a team re-roll. */
export type CheckKind =
  | "dodge"
  | "rush"
  | "jump"
  | "pickup"
  | "catch"
  | "standup"
  | "regeneration"
  | "loner"
  | "jumpup"
  | "bonehead"
  | "reallystupid"
  | "fury"
  | "takeroot"
  | "bloodlust"
  | "steadyfooting"
  | "dauntless"
  | "vomit"
  | "breathefire"
  | "tentacles"
  | "trapdoor"
  | "mascot"
  | "chainsaw"
  | "animosity"
  | "landing"
  | "hunger"
  | "escape"
  | "shadowing"
  | "savagery"
  | "appearance"
  | "gaze"
  | "bombcatch"
  | "pro"
  | "pickmeup";

/**
 * Procedures are plain, serializable objects kept on a stack in the game state.
 * Their behaviour lives in `procedures/*` handlers keyed by `type`.
 */
export type Procedure =
  | { type: "Game"; stage: "pregame" | "half1" | "half2" | "overtime" | "end" }
  /** "rookies": Riotous Rookies, rolled by the teams in `rookies` (in order). */
  | { type: "Pregame"; stage: "fans" | "weather" | "rookies"; rookies?: Side[] }
  /**
   * Prayers to Nuffle, before the coin toss: `draws` lists the team of each prayer still to draw (a D16, re-rolled when
   * the team already has the result); "choose": the coach picks the player (Iron Man, Knuckle Dusters); "badHabits":
   * the D3 of Bad Habits.
   */
  | {
      type: "Prayers";
      draws: Side[];
      stage: "draw" | "choose" | "badHabits" | "skill";
      prayer?: Prayer;
      playerId?: string;
      /** The last draw was a prayer the team already has: it is rolled again. */
      repeated?: Prayer;
    }
  | { type: "CoinToss"; stage: "call" | "flip" | "choose"; call?: "heads" | "tails"; winner?: Side }
  /** `drives`: kick-offs so far in this half; `turnPlayed`: a team turn just ended (time for Throw a Rock). */
  | { type: "Half"; half: HalfNumber; stage: "driveEnd" | "kickoff" | "turns"; kicking: Side; nextSide: Side; drives?: number; turnPlayed?: boolean }
  /** Treacherous Trapdoor (a prayer): the player entered a trapdoor and falls through on a 1. */
  | { type: "Trapdoor"; playerId: string; stage: "roll" | "result" | "injury" }
  /** Throw a Rock (a prayer): between turns, the team may have a random standing opponent hit on 4+, once per game. */
  | { type: "ThrowRock"; side: Side; stage: "ask" | "roll" }
  /** Halfling Master Chef: each team with one rolls 3D6 (`sides` still to roll); every 4+ steals a team re-roll. */
  | { type: "MasterChef"; sides: Side[]; stolen: Partial<Record<Side, number>> }
  | { type: "SwelteringHeat" }
  | { type: "Setup"; side: Side }
  | {
      type: "Kickoff";
      kicking: Side;
      /** "kick": the kicking player may use Kick before the deviation roll. */
      stage: "place" | "kick" | "scatter" | "event" | "weather" | "gusts" | "land";
      /** The first kick-off of the first or second half: Leader players on the pitch grant the Leader re-roll. */
      firstOfHalf?: boolean;
      /** Kick: the deviation distance is a D3. */
      kick?: boolean;
      target?: Square;
      /** Where the ball will come down; may be off the pitch. */
      landing?: Square;
      touchback?: boolean;
    }
  /** "mascot": Cheering Fans, a team with a Team Mascot re-rolls its natural 1 (`rolls`: the first rolls). */
  | {
      type: "KickoffEvent";
      result: "cheering-fans" | "brilliant-coaching" | "dodgy-snack" | "pitch-invasion";
      stage: "roll" | "snack" | "mascot";
      snackers?: string[];
      rolls?: Record<Side, number>;
    }
  | { type: "SolidDefence"; side: Side; stage: "roll" | "select" | "setup"; allowed?: number; selected?: string[] }
  | { type: "HighKick"; side: Side; square: Square }
  | { type: "QuickSnap"; side: Side; stage: "roll" | "move"; allowed?: number; moved: string[] }
  | { type: "Charge"; side: Side; stage: "roll" | "select"; allowed?: number }
  | { type: "Touchback"; side: Side }
  | { type: "Bounce"; from: Square; kickoff: boolean; receiving: Side | null }
  | { type: "ThrowIn"; from: Square }
  /**
   * Diving Catch: a kicked, thrown or thrown-in ball comes down on `square`, next to players with the skill. The moving
   * team (the kicking team at the kick-off) may pick one of them, or its player in the square, to catch it; then the
   * other team ("second"); otherwise it lands as usual.
   */
  | { type: "DivingCatch"; square: Square; landing: { kickoff: boolean; receiving: Side | null; scattered: boolean; accurate: boolean }; stage: "first" | "second" }
  /**
   * Safe Pair of Hands: the player was knocked down or placed prone holding the ball, which lies on `square`; their coach
   * may place it on a free adjacent square instead of letting it bounce.
   */
  | { type: "SafeHands"; playerId: string; square: Square; stage: "ask" | "place" }
  | {
      type: "Catch";
      playerId: string;
      kickoff: boolean;
      /** Catching a bouncing or scattered ball is harder (+1 to the target); not a thrown-in one. */
      scattered: boolean;
      /** An accurate pass to the catcher's square, or the one next to them for Diving Catch (+1 with Diving Catch). */
      accurate?: boolean;
      stage: "check" | "resolve";
    }
  | { type: "KoRecovery"; playerIds: string[] }
  /** A team turn, or a Charge (kick-off event) when `charge` lists the players allowed to act. */
  | {
      type: "Turn";
      side: Side;
      stage: "start" | "main";
      charge?: string[];
      used: PlayerActionType[];
      /** END_TURN was chosen; the turn ends once the forgone stalling rock is resolved. */
      ending?: boolean;
      /** A player was activated: too late for the Weather Mage. */
      acted?: boolean;
    }
  /** Weather Mage: 2D6 on the weather table (`roll`), then the coach applies a modifier of -2 to +2, or none. */
  | { type: "WeatherMage"; side: Side; stage: "roll" | "choose"; roll?: number }
  | {
      type: "MoveAction";
      playerId: string;
      /**
       * "confusion": after the Animal Savagery / Bone Head / Really Stupid / Unchannelled Fury / Bloodlust roll;
       * "savagery": a failed Animal Savagery roll, lashing out at a team-mate; "thirst": a thirsty player may take a Move
       * action instead; "root": after the Take Root roll.
       */
      stage: "start" | "confusion" | "savagery" | "thirst" | "root" | "standup" | "main";
      /** "block" only allows a single block; "blitz" a move with one block of `targetId` on the way. */
      action: PlayerActionType;
      targetId?: string;
      blocked?: boolean;
      /** The ball was thrown, handed off or secured: the action is over. */
      finished?: boolean;
      /** The player was stalling when activated (see isStalling): the crowd may throw a rock at the end. */
      stalling?: boolean;
      /** Failed the Bloodlust roll: must bite a Thrall before the action ends (or before passing or scoring). */
      thirsty?: boolean;
      /** The Bloodlust feeding has been resolved (or is under way). */
      fed?: boolean;
      /** Fumblerooski: the player drops the ball in the square they leave on their next step. */
      fumblerooski?: boolean;
      /** Give and Go: the ball was passed or handed off, and the player moves on (no second throw). */
      released?: boolean;
    }
  | {
      type: "Pass";
      throwerId: string;
      target: Square;
      range: PassRange;
      /** A bomb (Throw Bomb action) rather than the ball: no Animosity or On the Ball, and it explodes where it stops. */
      bomb?: boolean;
      /** Dump-off: a Quick pass by the player about to be blocked; no On the Ball, and nobody's turn ends. */
      dumpOff?: boolean;
      /** Hail Mary Pass: to any square, rolled as a Long Bomb, never accurate and never intercepted. */
      hailMary?: boolean;
      /** "animosity": the thrower may first have to roll for Animosity towards the receiver. */
      /** "safePass": a natural 1 may be saved by Safe Pass. */
      /** "aim": a player who caught a bomb picks where to throw it again, or a Dump-off thrower picks the target. */
      stage: "aim" | "animosity" | "animosityResult" | "roll" | "reroll" | "loner" | "pro" | "proTeam" | "proLoner" | "outcome" | "safePass" | "scatter" | "intercept" | "interceptRoll" | "land" | "end";
      rerolled: boolean;
      /** The Team Mascot failed: only a team re-roll may be offered now. */
      mascotFailed?: boolean;
      result?: PassResult;
      /** A team re-roll was spent on a failed Pro roll. */
      proRetried?: boolean;
      /** The natural D6 of the pass roll. */
      roll?: number;
      /** Where the ball comes down (after an inaccurate scatter). */
      landing?: Square;
      /** The scatter left the pitch: throw-in from this square. */
      throwInFrom?: Square;
      interceptorId?: string;
    }
  /** Throw Team-mate: a team-mate with Right Stuff is thrown to a square in Quick or Short range. */
  | {
      type: "ThrowTeamMate";
      throwerId: string;
      thrownId: string;
      target: Square;
      range: PassRange;
      /** "hunger": Always Hungry, rolled before the throw. */
      /** "fumbled": a fumbled kick, the kicked player rolls for injury; "swoop*": Swoop instead of the scatters. */
      /** "bullseye": the thrower may land a superb throw in the target square. */
      stage:
        | "hunger" | "hungerResult" | "escapeResult" | "roll" | "reroll" | "loner" | "pro" | "proTeam" | "proLoner" | "scatter"
        | "bullseye" | "swoop" | "swoopDirection" | "swoopDistance" | "swoopReroll" | "swoopLoner" | "fumbled" | "land" | "bounce" | "landed";
      /**
       * Swoop: false when declined; otherwise the side chosen, the roll being made (each with its own team re-roll), the
       * direction and the distance rolled.
       */
      swoop?:
        | false
        | { facing: Square; rolling: "direction" | "distance"; rerolled: boolean; mascotFailed?: boolean; direction?: Square; distance?: number };
      /** Kick Team-mate: the same as a throw, but a fumble injures the kicked player. */
      kicked?: boolean;
      /** Bullseye was offered after a superb throw: used or not. */
      bullseye?: boolean;
      rerolled: boolean;
      /** The Team Mascot failed: only a team re-roll may be offered now. */
      mascotFailed?: boolean;
      /** A team re-roll was spent on a failed Pro roll. */
      proRetried?: boolean;
      /** "accurate" is a superb throw, "inaccurate" a subpar one. */
      result?: PassResult;
      /** Where the thrown player comes down. */
      at?: Square;
      /** The thrown player left the pitch from this square: the crowd gets them. */
      crowdFrom?: Square;
      /** The landing fails without a roll: the player landed on someone, or was down or distracted before the throw. */
      autoFail?: boolean;
    }
  | { type: "HandOff"; throwerId: string; catcherId: string; stage: "animosity" | "animosityResult" | "catch" | "end" }
  | {
      type: "Foul";
      foulerId: string;
      victimId: string;
      /** Offensive minus defensive foul assists, added to the armour roll. */
      assists: number;
      /** "chainsaw": the fouler may use their Chainsaw (a kick-back roll first, then +3 to the armour roll). */
      /** "biasedReferee": the victim's team's Biased Referee may spot a foul the referee missed. */
      stage: "chainsaw" | "kickback" | "armour" | "injury" | "referee" | "biasedReferee" | "argue" | "argueRoll" | "bribe" | "bribeRoll" | "sendOff" | "end";
      /** The Chainsaw is used for this foul. */
      chainsaw?: boolean;
      armour?: number[];
      injury?: number[];
      /** Dirty Player's +1 went to the armour roll, so it does not apply to the injury roll. */
      dirtyPlayerOnArmour?: boolean;
    }
  | {
      type: "Block";
      attackerId: string;
      defenderId: string;
      blitz: boolean;
      /** Frenzy's second block against the same defender: there is no third one. */
      second?: boolean;
      /** Fend: the defender's coach chose whether to stop the follow-up. */
      fended?: boolean;
      /** Taunt: the defender's coach chose whether to force the follow-up. */
      taunted?: boolean;
      /** Pro: the index of the block die to re-roll. */
      proDie?: number;
      /** A team re-roll was spent on a failed Pro roll. */
      proRetried?: boolean;
      /** The skill re-rolling a single die (Brawler: a Both Down, Hatred: a Skull). */
      singleDie?: "Brawler" | "Hatred";
      /** Dauntless worked: the attacker's ST matches the defender's for this block. */
      dauntless?: boolean;
      /** Cheering Fans: the extra assist counted for this block (kept when the dice are worked out again). */
      extraAssist?: boolean;
      /** A Ball & Chain player ran into the defender: forced follow-up, and a prone defender is hit on the ground. */
      ballAndChain?: boolean;
      /** Ball & Chain against a prone or stunned player: no dice, pushed back and an armour roll, no turnover. */
      hitOnGround?: boolean;
      /** Both Down: the player whose coach is asked whether to use Wrestle. */
      wrestlerId?: string;
      /** "appearance": the defender's Foul Appearance, rolled first. */
      stage: "appearance" | "appearanceResult" | "rush" | "rushResult" | "dauntless" | "dauntlessResult" | "trickster" | "roll" | "reroll" | "loner" | "singleDie" | "proDie" | "pro" | "proTeam" | "proLoner" | "proReroll" | "choose" | "resolve" | "juggernaut" | "wrestle" | "standFirm" | "rooted" | "push" | "fend" | "taunt" | "followup" | "end";
      /** Number of block dice; negative when the defender chooses. */
      dice: number;
      results?: number[];
      rerolled: boolean;
      /** The Team Mascot failed: only a team re-roll may be offered now. */
      mascotFailed?: boolean;
      face?: number;
      /** Square the defender was pushed from, available for the follow-up (none after Stand Firm). */
      vacated?: Square;
      /** Pushback chain being resolved: the player being pushed now and the push direction. */
      pushing?: { playerId: string; from: Square; dir: Square };
      chain: Array<{ playerId: string; to: Square | null }>;
      knockDefender?: boolean;
      /** The last pushed player landed on the loose ball, which bounces from there. */
      bounceFrom?: Square;
    }
  | { type: "Crowd"; playerId: string; from: Square; hadBall: boolean }
  /** Projectile Vomit, Stab, Breathe Fire or Chainsaw on an adjacent opponent, instead of a block. */
  | {
      type: "Vomit";
      skill: "Projectile Vomit" | "Stab" | "Breathe Fire" | "Chainsaw";
      attackerId: string;
      defenderId: string;
      blitz: boolean;
      stage: "appearance" | "appearanceResult" | "rush" | "rushResult" | "trickster" | "roll" | "result" | "armour" | "injury";
      /** Who the vomit hits: the defender, or the attacker after a failed roll. */
      victimId?: string;
      /** The victim held the ball when placed prone. */
      dropped?: boolean;
    }
  /**
   * End of a drive: the referee sends off the Secret Weapon players who played in it, one at a time (the first id);
   * the coach may argue the call, then use bribes.
   */
  | { type: "SecretWeapon"; playerIds: string[]; stage: "argue" | "argueRoll" | "bribe" | "bribeRoll" }
  /** Bloodlust: the thirsty player bites an adjacent Thrall team-mate, or fails to feed. */
  | { type: "Feed"; playerId: string; stage: "select" | "injury"; victimId?: string; dropped?: boolean }
  /**
   * On the Ball: players of `side` move up to three squares each, one at a time (`playerId` is moving), when the
   * opponent passes; at the kick-off only one unmarked player, in their own half.
   */
  | { type: "OnTheBall"; side: Side; kickoff: boolean; stage: "select" | "move"; playerId?: string; moved: string[] }
  /**
   * A thrown bomb comes down on `square`: a standing player there may catch it (and must throw it again), otherwise it
   * explodes; on an empty square it first bounces once.
   */
  | { type: "BombLanding"; square: Square; scattered: boolean; bounced: boolean; stage: "land" | "catch"; catcherId?: string }
  /** A bomb explodes: the player on `square` is hit, each player next to it on a 4+; `targets` are still to resolve. */
  | { type: "Explosion"; square: Square; targets: string[]; stage: "explode" | "next" | "roll" }
  /**
   * Pick-me-up: at the end of the opponent's turn, prone players of `side` within 3 squares of a standing team-mate
   * with the skill (`playerIds`, still to choose from) may try to stand up; `selected` are rolling now.
   */
  | { type: "PickMeUp"; side: Side; playerIds: string[]; selected: string[]; stage: "select" | "roll" }
  /** Hit and Run: after their block (or Stab), the player may step to a free square away from any opponent. */
  | { type: "HitAndRun"; playerId: string; stage: "ask" | "move" }
  /** Hypnotic Gaze on an adjacent standing opponent, after the defender's Foul Appearance. */
  | { type: "Gaze"; playerId: string; victimId: string; stage: "appearance" | "appearanceResult" | "gaze" | "result" }
  /** Trickster: the defender may move next to the attacker before the block or attack; "pickup": onto the loose ball. */
  | { type: "Trickster"; attackerId: string; defenderId: string; stage: "choose" | "pickup"; square?: Square }
  /** Punt: the ball is kicked from the punter's square, on the throw-in template facing `facing`, D6 squares away. */
  | {
      type: "Punt";
      playerId: string;
      /** The orthogonal direction chosen by the coach. */
      facing: Square;
      /** "reroll" / "loner" / "pro*": a team or Pro re-roll of the `rolling` roll; "land": the ball comes down. */
      stage: "direction" | "distance" | "reroll" | "loner" | "pro" | "proTeam" | "proLoner" | "land" | "end";
      rolling: "direction" | "distance";
      rerolled: boolean;
      /** The Team Mascot failed: only a team re-roll may be offered now. */
      mascotFailed?: boolean;
      /** A team re-roll was spent on a failed Pro roll. */
      proRetried?: boolean;
      direction?: Square;
      distance?: number;
      /** The player standing where the ball came down. */
      catcherId?: string;
    }
  /** Dump-off: the ball carrier about to be blocked (or targeted by a special action) may first make a Quick pass. */
  | {
      type: "DumpOff";
      attackerId: string;
      defenderId: string;
      /** Named as the target of a Blitz being declared: the blitzer may not be standing yet. */
      declared?: boolean;
    }
  /** Tentacles: an opponent may try to hold the player dodging or jumping away from `from`. */
  | { type: "Tentacles"; playerId: string; from: Square; stage: "select" | "result"; tentaclerId?: string }
  /** Shadowing: an opponent may follow the player who just left `from`, out of their tackle zone. */
  | { type: "Shadow"; playerId: string; from: Square; stage: "select" | "result"; shadowerId?: string }
  /** The crowd throws a rock at a stalling ball carrier. */
  | { type: "Stalling"; playerId: string }
  | {
      /** What happens after an injury roll: casualty roll, apothecary, then the player is placed. */
      type: "Injury";
      playerId: string;
      outcome: InjuryOutcome;
      /** Pushed into the crowd: the player leaves the pitch even when only stunned. */
      crowd: boolean;
      /** The opponent whose block caused the injury (Plague Ridden). */
      attackerId?: string;
      /** "regenerationReroll": a Mortuary Assistant or Plague Doctor may re-roll a failed Regeneration roll. */
      stage: "casualty" | "regeneration" | "regenerated" | "regenerationReroll" | "apothecary" | "apothecaryRoll" | "apothecaryChoice" | "place";
      /** The inducement re-rolling Regeneration was offered. */
      regenerationRerolled?: boolean;
      casualty?: Casualty;
      /** The apothecary's casualty re-roll, to choose from. */
      reroll?: Casualty;
      /** The team's apothecary treated the player. */
      treated?: boolean;
      /** The apothecary sent the player to the reserves (KO'd in the crowd, or a healed casualty). */
      healed?: boolean;
    }
  | {
      type: "MoveStep";
      playerId: string;
      to: Square;
      /** Jumping over a prone or stunned player: two squares, a Jump roll instead of a Dodge. */
      jump?: boolean;
      /** An On the Ball move out of the team's turn (when the opponent passes, or at the kick-off): no Rush, no turnover. */
      onTheBall?: "pass" | "kickoff";
      /** Hit and Run: a free step, without any roll (but a pick-up) and without spending movement. */
      hitAndRun?: boolean;
      /** "fell": after the knock-down of a failed roll, which Steady Footing may have avoided. */
      /** "arrive": after the step (and any Shadowing), pick up the ball or score. */
      /** "chain*": a Ball & Chain step (direction on the throw-in template, a block or a move, then any Rush). */
      stage: "rush" | "rush2" | "dodge" | "move" | "arrive" | "fell" | "pickup" | "chain" | "chainBlock" | "chainArrive";
      /** The failed roll left the player in the starting square. */
      fellInPlace?: boolean;
      /** Tentacles: the opponents were asked; `held`: a Tentacles player kept the mover in the starting square. */
      tentacles?: boolean;
      held?: boolean;
    }
  | {
      type: "Check";
      kind: CheckKind;
      playerId: string;
      /** Value the d6 (after modifiers) must reach. */
      target: number;
      modifier: number;
      /**
       * "loner": a Loner player rolls to use the team re-roll; "pro" / "proTeam" / "proLoner": the Pro roll to re-roll
       * (see `stepPro`); "divingTackle": an opponent may use Diving Tackle.
       */
      stage: "roll" | "reroll" | "loner" | "pro" | "proTeam" | "proLoner" | "divingTackle";
      rerolled: boolean;
      /** The Team Mascot failed: only a team re-roll may be offered now. */
      mascotFailed?: boolean;
      /** The natural roll, kept when the re-roll is declined or lost. */
      roll?: number;
      /** A team re-roll was spent on a failed Pro roll. */
      proRetried?: boolean;
      /** A dodge or jump from `from` to `to`: opponents with Diving Tackle may make it harder. */
      leaving?: { from: Square; to: Square };
      /** The opponent who used Diving Tackle on this roll (-2 from then on, re-roll included). */
      divingTacklerId?: string;
      /** A re-roll is also offered after a success below this natural roll (Breathe Fire short of a 6). */
      rerollBelow?: number;
      /** A skill that may re-roll this failed roll (Swoop for the landing of a player who swooped). */
      skillReroll?: string;
    }
  | {
      type: "KnockDown";
      playerId: string;
      turnover: boolean;
      /**
       * Mighty Blow of the blocker who knocked the player down: added to the armour or the injury roll (only to the
       * armour roll when `armourOnly`: Animal Savagery). `skill` names it when it is another skill (Arm Bar).
       */
      mightyBlow?: { playerId: string; bonus: number; armourOnly?: boolean; skill?: string };
      /** The opponent whose block knocked the player down (Claws, Plague Ridden). */
      blockerId?: string;
      /** Mighty Blow broke the armour, so it does not apply to the injury roll. */
      mightyBlowOnArmour?: boolean;
      /** Steady Footing was offered (and failed or declined). */
      steadied?: boolean;
      /** The player fell over (a failed dodge, jump, Rush or landing), as opposed to being knocked down: no Safe Pair of Hands. */
      fallsOver?: boolean;
      stage: "fall" | "steady" | "steadyResult" | "armour" | "injury" | "bounce";
      square?: Square;
      hadBall?: boolean;
    };

export type ProcedureType = Procedure["type"];

/** The two halves, and 3 for overtime. */
export type HalfNumber = 1 | 2 | 3;

/** The whole game, plain serializable data (no classes): save it, replay it or keep old copies for undo. */
export interface GameState {
  /** Schema version, for saved games. */
  version: 1;
  /** mulberry32 state, advanced by every random roll. */
  rng: number;
  half: HalfNumber;
  /** Chosen after the coin toss; the other team kicks in the second half, and this one again in overtime. */
  kickingFirstHalf: Side | null;
  /** A draw after the second half goes to overtime (a game option, for cup games). */
  overtime: boolean;
  teams: Record<Side, TeamState>;
  players: Record<string, PlayerState>;
  ball: BallState;
  /** Team whose turn it is, null outside of turns (setup, kick-off...). */
  activeSide: Side | null;
  /** Player taking an action, if any. */
  activePlayerId: string | null;
  weather: Weather;
  /** Number of kick-offs so far; drives after the first one end with KO recovery and heat. */
  drive: number;
  /** Set during a turn when it must end (failed roll, knocked-down active player...). */
  turnover: boolean;
  /** Team that scored in the current drive; ends the drive. */
  touchdown: Side | null;
  /** Result of the last finished Check, read by the procedure that pushed it. */
  /** `divingTacklerId`: the opponent whose Diving Tackle made a dodge or jump harder. */
  lastCheck: { kind: CheckKind; success: boolean; roll?: number; divingTacklerId?: string } | null;
  /** Procedure stack; the last element runs. */
  stack: Procedure[];
  /** Every event since the start of the game. */
  log: GameEvent[];
  finished: boolean;
}

/** Input to `step`: must match one of the templates from `getAvailableActions`. */
export type Action =
  | { type: "CALL_COIN"; call: "heads" | "tails" }
  | { type: "CHOOSE_KICK"; kick: boolean }
  /** Roll the requested dice. `values` lets a user enter physical dice results. */
  | { type: "ROLL"; values?: number[] }
  /** `mascot`: try the Team Mascot (4+) instead of spending a team re-roll. */
  | { type: "USE_REROLL"; mascot?: boolean }
  | { type: "DECLINE_REROLL" }
  | { type: "PLACE_PLAYER"; playerId: string; square: Square | null }
  | { type: "END_SETUP" }
  | { type: "PLACE_BALL"; square: Square }
  | { type: "GIVE_BALL"; playerId: string }
  /** Activate a player and declare an action; a Blitz names its target up front (BB2025). */
  | { type: "START_ACTION"; playerId: string; action: PlayerActionType; targetId?: string }
  | { type: "BLOCK"; targetId: string }
  /** Projectile Vomit on an adjacent opponent instead of blocking them. */
  | { type: "VOMIT"; targetId: string }
  /** Stab an adjacent opponent instead of blocking them. */
  | { type: "STAB"; targetId: string }
  /** Breathe Fire on an adjacent opponent instead of blocking them. */
  | { type: "BREATHE_FIRE"; targetId: string }
  /** A Chainsaw attack on an adjacent opponent instead of blocking them. */
  | { type: "CHAINSAW"; targetId: string }
  /** Pick one of the rolled block dice (index into the results). */
  | { type: "CHOOSE_BLOCK_DIE"; index: number }
  | { type: "PUSH"; square: Square }
  | { type: "FOLLOW_UP"; follow: boolean }
  | { type: "THROW"; square: Square }
  /** Hail Mary Pass: throw the ball to any square of the pitch. */
  | { type: "HAIL_MARY_PASS"; square: Square }
  | { type: "HAND_OFF"; targetId: string }
  /** Throw Team-mate: throw the adjacent team-mate `targetId` to `square`. */
  | { type: "THROW_TEAM_MATE"; targetId: string; square: Square }
  | { type: "FOUL"; targetId: string }
  /** Hypnotic Gaze: distract the adjacent opponent `targetId`. */
  | { type: "GAZE"; targetId: string }
  /** Swoop: travel from the target towards the side of `square` instead of scattering (null: scatter as usual). */
  | { type: "SWOOP"; square: Square | null }
  /** Trickster: move to `square` before being hit (null: stay); `pickUp`: try to pick up a loose ball there. */
  | { type: "TRICKSTER"; square: Square | null; pickUp?: boolean }
  /** Intensive Training (a prayer): the skill the player gains. */
  | { type: "CHOOSE_SKILL"; skill: string }
  /** Throw a Rock (a prayer): throw it now or keep it. */
  | { type: "THROW_A_ROCK"; use: boolean }
  /** Use the Weather Mage at the start of the team's turn. */
  | { type: "WEATHER_MAGE" }
  /** Weather Mage: the modifier applied to the roll (-2 to +2, 0 for none). */
  | { type: "CHOOSE_WEATHER"; modifier: number }
  /** Punt towards the orthogonally adjacent `square`, or into the crowd (null) from a sideline or an end zone. */
  | { type: "PUNT"; square: Square | null }
  /** The referee spotted the foul: argue the call (6: the fouler stays, but it is still a turnover)? */
  | { type: "ARGUE_THE_CALL"; argue: boolean }
  /** Use a bribe (2+: the fouler stays and no turnover)? */
  | { type: "BRIBE"; use: boolean }
  /** Use the team's apothecary on a KO'd or injured player? */
  | { type: "USE_APOTHECARY"; use: boolean }
  /** After the apothecary's casualty re-roll: keep the first or the second result. */
  | { type: "APOTHECARY_CHOICE"; keep: "first" | "second" }
  | { type: "MOVE"; square: Square }
  /** Bloodlust: take a Move action instead of the declared Block or Secure the Ball? */
  | { type: "MOVE_INSTEAD"; move: boolean }
  /** Use an optional skill offered by a USE_SKILL template (Stand Firm)? `skill` picks one when several are offered. */
  | { type: "USE_SKILL"; use: boolean; skill?: string }
  /** Pro: the block die to re-roll (index into the results). */
  | { type: "REROLL_BLOCK_DIE"; index: number }
  | { type: "END_PLAYER_ACTION" }
  | { type: "END_TURN" }
  /** Choose players for a kick-off event (Solid Defence, High Kick, Charge). May be empty. */
  | { type: "SELECT_PLAYERS"; playerIds: string[] }
  /** Quick Snap: move one open player a single square. */
  | { type: "SNAP"; playerId: string; square: Square }
  /** Finish an optional kick-off phase (Quick Snap). */
  | { type: "DONE" };

export type ActionType = Action["type"];

/** What the current decision maker may do. The UI renders only from these. */
export type ActionTemplate =
  | { type: "CALL_COIN"; side: Side }
  | { type: "CHOOSE_KICK"; side: Side }
  | { type: "ROLL"; side: Side | null; dice: DiceSpec[]; reason: string }
  /** `skill`: the re-roll comes from this skill of the player (Pass), not from the team. */
  /** `mascot`: the Team Mascot may be tried instead (it works even without team re-rolls left). */
  | { type: "USE_REROLL"; side: Side; available: number; skill?: string; mascot?: boolean }
  | { type: "DECLINE_REROLL"; side: Side }
  | { type: "PLACE_PLAYER"; side: Side; playerIds: string[]; squares: Square[] }
  | { type: "END_SETUP"; side: Side; errors: string[] }
  | { type: "PLACE_BALL"; side: Side; squares: Square[] }
  | { type: "GIVE_BALL"; side: Side; playerIds: string[] }
  | { type: "START_ACTION"; side: Side; choices: Array<{ playerId: string; actions: PlayerActionType[] }>; blitzTargets: string[] }
  /** Block targets with the number of block dice (negative: the defender chooses). */
  | { type: "BLOCK"; side: Side; playerId: string; targets: Array<{ playerId: string; dice: number }> }
  | { type: "VOMIT"; side: Side; playerId: string; targetIds: string[] }
  | { type: "STAB"; side: Side; playerId: string; targetIds: string[] }
  | { type: "BREATHE_FIRE"; side: Side; playerId: string; targetIds: string[] }
  | { type: "CHAINSAW"; side: Side; playerId: string; targetIds: string[] }
  | { type: "WEATHER_MAGE"; side: Side }
  | { type: "THROW_A_ROCK"; side: Side }
  /** Intensive Training: the skills `playerId` may gain. */
  | { type: "CHOOSE_SKILL"; side: Side; playerId: string; skills: string[] }
  /** Weather Mage: the 2D6 rolled, and the weather each modifier gives. */
  | { type: "CHOOSE_WEATHER"; side: Side; roll: number; options: Array<{ modifier: number; total: number; weather: Weather }> }
  /** Swoop: the squares next to the target square (not diagonally) that give the side the template faces. */
  | { type: "SWOOP"; side: Side; playerId: string; squares: Square[] }
  /** Trickster: free squares next to the attacker; `ball`: the one with a loose ball, if any. */
  | { type: "TRICKSTER"; side: Side; playerId: string; squares: Square[]; ball: Square | null }
  /** Hail Mary Pass to any square of the pitch but the thrower's; `needed`: the roll that avoids a fumble. */
  | { type: "HAIL_MARY_PASS"; side: Side; playerId: string; needed: number }
  /** `crowd`: the punter stands on a sideline or in an end zone and may punt into the crowd. */
  | { type: "PUNT"; side: Side; playerId: string; squares: Square[]; crowd: boolean }
  | { type: "CHOOSE_BLOCK_DIE"; side: Side; results: number[] }
  | { type: "REROLL_BLOCK_DIE"; side: Side; results: number[]; skill: string }
  | { type: "PUSH"; side: Side; playerId: string; squares: Square[] }
  | { type: "FOLLOW_UP"; side: Side; playerId: string; square: Square }
  /** Squares in range, with the range band and the D6 roll needed for an accurate pass. */
  | { type: "THROW"; side: Side; playerId: string; squares: Array<Square & { range: PassRange; needed: number }> }
  | { type: "HAND_OFF"; side: Side; playerId: string; playerIds: string[] }
  /** Team-mates that can be thrown, and the target squares with their range and the roll needed for a superb throw. */
  | { type: "THROW_TEAM_MATE"; side: Side; playerId: string; playerIds: string[]; squares: Array<Square & { range: PassRange; needed: number }> }
  /** Prone or stunned opponents next to the fouler, with the armour roll modifier from foul assists. */
  | { type: "FOUL"; side: Side; playerId: string; targets: Array<{ playerId: string; assists: number }> }
  | { type: "GAZE"; side: Side; playerId: string; targetIds: string[] }
  | { type: "ARGUE_THE_CALL"; side: Side; playerId: string }
  | { type: "BRIBE"; side: Side; playerId: string; bribes: number }
  | { type: "USE_APOTHECARY"; side: Side; playerId: string; outcome: InjuryOutcome; casualty: Casualty | null }
  | { type: "APOTHECARY_CHOICE"; side: Side; playerId: string; first: Casualty; second: Casualty }
  | { type: "MOVE"; side: Side; playerId: string; squares: Array<Square & { rolls: CheckKind[] }> }
  | { type: "USE_SKILL"; side: Side; playerId: string; skill: string }
  | { type: "MOVE_INSTEAD"; side: Side; playerId: string }
  | { type: "END_PLAYER_ACTION"; side: Side }
  | { type: "END_TURN"; side: Side }
  /** `min`: players that must be chosen (none by default). */
  | { type: "SELECT_PLAYERS"; side: Side; playerIds: string[]; max: number; min?: number; reason: string }
  | { type: "SNAP"; side: Side; moves: Array<{ playerId: string; squares: Square[] }>; remaining: number }
  | { type: "DONE"; side: Side };

/** What happened during a step, for logs and animations; also kept in `state.log`. */
export type GameEvent =
  | { type: "GameStarted" }
  | { type: "FanFactor"; side: Side; fanFactor: number }
  | { type: "WeatherChanged"; weather: Weather }
  | { type: "KickoffResult"; result: KickoffResult }
  | { type: "BribeGained"; side: Side }
  | { type: "TurnCountersChanged"; delta: number }
  | { type: "ExtraAssist"; side: Side }
  | { type: "RerollGained"; side: Side }
  | { type: "DodgySnack"; playerId: string; sentOff: boolean }
  | { type: "PlayerExhausted"; playerId: string }
  | { type: "ChargeStarted"; side: Side; playerIds: string[] }
  | { type: "ChargeEnded"; side: Side }
  | { type: "CoinFlipped"; call: "heads" | "tails"; result: "heads" | "tails"; winner: Side }
  | { type: "KickChosen"; kicking: Side }
  | { type: "HalfStarted"; half: HalfNumber }
  | { type: "SetupDone"; side: Side }
  | { type: "BallPlaced"; square: Square }
  | { type: "DiceRolled"; rolls: DiceRoll[]; reason: string }
  | { type: "BallScattered"; to: Square }
  /** A punt came down on `to`, or left the pitch there (`out`: a throw-in from `to`). */
  | { type: "Punted"; playerId: string; to: Square; out: boolean }
  | { type: "BallBounced"; to: Square }
  | { type: "BallThrownIn"; to: Square }
  | { type: "Touchback"; playerId: string }
  | { type: "TurnStarted"; side: Side; turn: number }
  | { type: "TurnEnded"; side: Side; turnover: boolean }
  | { type: "PlayerMoved"; playerId: string; from: Square; to: Square }
  | { type: "PlayerStoodUp"; playerId: string }
  | { type: "ActionDeclared"; playerId: string; action: PlayerActionType; targetId?: string }
  /** An unmarked ball carrier who could reach the end zone was activated (or the turn was ended without them). */
  | { type: "StallingDetected"; playerId: string }
  /** The crowd throws a rock: `roll` is null from turn 7 on, when it always misses. */
  | { type: "RockThrown"; playerId: string; roll: number | null; hit: boolean }
  | { type: "BlockDeclared"; attackerId: string; defenderId: string; dice: number }
  | { type: "BlockResult"; attackerId: string; defenderId: string; face: number }
  | { type: "PlayerPushed"; playerId: string; from: Square; to: Square | null }
  | { type: "FollowedUp"; playerId: string; to: Square }
  | { type: "PassThrown"; playerId: string; target: Square; range: PassRange; bomb?: boolean; hailMary?: boolean }
  | { type: "BombCaught"; playerId: string }
  | { type: "BombExploded"; square: Square }
  /** The bomb left the pitch, or Safe Pass kept it: it does not explode. */
  | { type: "BombLost" }
  | { type: "BombHit"; playerId: string }
  | { type: "PassResult"; playerId: string; result: PassResult }
  /** `result`: "accurate" is a superb throw, "inaccurate" a subpar one. */
  | { type: "TeamMateThrown"; playerId: string; thrownId: string; result: PassResult; kicked?: boolean }
  | { type: "Intercepted"; playerId: string }
  | { type: "InterceptionFailed"; playerId: string }
  | { type: "HandedOff"; playerId: string; targetId: string }
  | { type: "BallSecured"; playerId: string }
  | { type: "Fouled"; foulerId: string; victimId: string; assists: number }
  | { type: "RefereeCall"; foulerId: string; spotted: boolean }
  /** `foulerId`: the player the referee wants to send off (a fouler or a Secret Weapon). */
  | { type: "ArgueTheCall"; foulerId: string; result: "success" | "failed" | "coach-banned" }
  | { type: "BribeUsed"; side: Side; success: boolean }
  | { type: "PlayerSentOff"; playerId: string }
  /** The drive is over: the referee wants to send off this Secret Weapon player. */
  | { type: "SecretWeaponSpotted"; playerId: string }
  | { type: "KoRecovery"; playerId: string; recovered: boolean }
  | { type: "CheckResult"; kind: CheckKind; playerId: string; success: boolean; roll: number; target: number }
  | { type: "RerollUsed"; side: Side }
  /** Halfling Master Chef: `side` stole `count` team re-rolls from the opponents for the half. */
  | { type: "RerollsStolen"; side: Side; count: number }
  /** Treacherous Trapdoor: the player fell through the trapdoor (off the pitch, an injury roll follows). */
  | { type: "FellThroughTrapdoor"; playerId: string }
  /** `side` drew a Prayer to Nuffle it already has: the D16 is rolled again. */
  | { type: "PrayerRepeated"; side: Side; prayer: Prayer }
  /** A Prayer to Nuffle was granted to `side`; `playerIds`: the players it changed, if any. */
  | { type: "PrayerGranted"; side: Side; prayer: Prayer; playerIds: string[] }
  /** Riotous Rookies: `playerIds` joined `side`'s reserves for the game. */
  | { type: "RookiesJoined"; side: Side; playerIds: string[] }
  /** A team special rule was used (Bribery and Corruption's re-roll...). */
  | { type: "SpecialRuleUsed"; side: Side; rule: string }
  /** An inducement bought for the game was used (the Team Mascot was tried...). */
  | { type: "InducementUsed"; side: Side; inducement: InducementId }
  | { type: "BallCaught"; playerId: string }
  | { type: "BallPickedUp"; playerId: string }
  | { type: "PlayerKnockedDown"; playerId: string }
  /** Placed prone without an armour roll (Wrestle). */
  | { type: "PlayerPlacedProne"; playerId: string }
  /** `roll` is missing when the armour breaks without a roll (Ball & Chain). */
  | { type: "ArmourBroken"; playerId: string; roll?: number }
  | { type: "ArmourHeld"; playerId: string; roll: number }
  | { type: "PlayerInjured"; playerId: string; result: "stunned" | "ko" | "cas" }
  /** `roll` is the D16 plus Niggling Injuries. */
  | { type: "CasualtyRolled"; playerId: string; roll: number; casualty: Casualty }
  | { type: "ApothecaryUsed"; playerId: string }
  /** A skill was used, e.g. Dodge to re-roll a failed Dodge roll. */
  | { type: "SkillUsed"; playerId: string; skill: string }
  /** Failed a Bone Head or Really Stupid roll: the action is lost and the player is distracted. */
  | { type: "PlayerDistracted"; playerId: string; skill: string }
  /** Failed a Bloodlust roll: the player must feed on a Thrall before the action ends. */
  | { type: "PlayerThirsty"; playerId: string }
  /** Bloodlust: `playerId` bites the Thrall `victimId`. */
  | { type: "PlayerBitten"; playerId: string; victimId: string }
  /** Bloodlust: no Thrall was bitten; a turnover, and the player loses their tackle zone. */
  | { type: "FeedingFailed"; playerId: string }
  /** Failed a Take Root roll: the player cannot move until knocked down or the drive ends. */
  | { type: "PlayerRooted"; playerId: string }
  /** Hypnotic Gaze worked: `victimId` is distracted until their next activation. */
  | { type: "PlayerHypnotised"; playerId: string; victimId: string }
  /** Failed an Animal Savagery roll: `playerId` knocks down the team-mate `victimId`, and the action ends. */
  | { type: "LashedOut"; playerId: string; victimId: string }
  /** Failed an Unchannelled Fury roll: the action is lost, but the player keeps their tackle zone. */
  | { type: "ActionLost"; playerId: string; skill: string }
  /** Regeneration worked: the casualty heals and the player goes to the reserves. */
  | { type: "Regenerated"; playerId: string }
  /** Plague Ridden: the killed player `fromId` joins the other team in the reserves as `playerId`. */
  | { type: "PlayerRaised"; playerId: string; fromId: string }
  /** Always Hungry: the thrown player did not escape and is eaten (dead). */
  | { type: "PlayerEaten"; playerId: string; byId: string }
  /** The apothecary's work is done: the player is stunned, back in the reserves, or keeps `casualty`. */
  | { type: "ApothecaryResult"; playerId: string; result: "stunned" | "reserves" | "casualty"; casualty: Casualty | null }
  | { type: "Touchdown"; side: Side; playerId: string }
  | { type: "HalfEnded"; half: HalfNumber }
  | { type: "GameEnded"; winner: Side | null };
