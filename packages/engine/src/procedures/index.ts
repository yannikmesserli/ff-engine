import type { HandlerMap } from "../context";
import { Bounce, Catch, ThrowIn, Touchback } from "./ball";
import { Block, Crowd, Vomit } from "./block";
import { HandOff, Pass } from "./pass";
import { Foul, SecretWeapon } from "./foul";
import { Feed } from "./bloodlust";
import { Check, KnockDown } from "./checks";
import { Injury } from "./injury";
import { Stalling } from "./stalling";
import { CoinToss, Game, Half, KoRecovery } from "./game";
import { Charge, HighKick, Kickoff, KickoffEvent, Pregame, QuickSnap, SolidDefence, SwelteringHeat } from "./kickoff";
import { Setup } from "./setup";
import { ThrowTeamMate } from "./ttm";
import { Gaze, HitAndRun, MoveAction, MoveStep, OnTheBall, Shadow, Turn } from "./turn";

/** Every procedure type's handler; `HandlerMap` makes a missing one a type error. */
export const handlers: HandlerMap = {
  Game,
  Pregame,
  CoinToss,
  SwelteringHeat,
  Half,
  KoRecovery,
  Setup,
  Kickoff,
  KickoffEvent,
  SolidDefence,
  HighKick,
  QuickSnap,
  Charge,
  Touchback,
  Bounce,
  ThrowIn,
  Catch,
  Turn,
  MoveAction,
  MoveStep,
  Shadow,
  Gaze,
  OnTheBall,
  HitAndRun,
  Block,
  Vomit,
  ThrowTeamMate,
  Crowd,
  Pass,
  HandOff,
  Foul,
  SecretWeapon,
  Feed,
  Check,
  KnockDown,
  Injury,
  Stalling,
};
