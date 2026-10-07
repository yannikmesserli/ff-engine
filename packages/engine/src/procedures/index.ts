import type { HandlerMap } from "../context";
import { Bounce, Catch, DivingCatch, SafeHands, ThrowIn, Touchback } from "./ball";
import { BombLanding, Explosion } from "./bomb";
import { Block, Crowd, Trickster, Vomit } from "./block";
import { DumpOff, HandOff, Pass, Punt } from "./pass";
import { Foul, SecretWeapon } from "./foul";
import { Feed } from "./bloodlust";
import { Check, KnockDown } from "./checks";
import { Injury } from "./injury";
import { Prayers } from "./prayers";
import { Stalling } from "./stalling";
import { CoinToss, Game, Half, KoRecovery, MasterChef } from "./game";
import { Charge, HighKick, Kickoff, KickoffEvent, Pregame, QuickSnap, SolidDefence, SwelteringHeat } from "./kickoff";
import { Setup } from "./setup";
import { ThrowTeamMate } from "./ttm";
import { Gaze, HitAndRun, MoveAction, MoveStep, OnTheBall, PickMeUp, Shadow, Tentacles, Turn, WeatherMage } from "./turn";

/** Every procedure type's handler; `HandlerMap` makes a missing one a type error. */
export const handlers: HandlerMap = {
  Game,
  Pregame,
  Prayers,
  CoinToss,
  SwelteringHeat,
  Half,
  KoRecovery,
  MasterChef,
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
  SafeHands,
  DivingCatch,
  Catch,
  Turn,
  WeatherMage,
  MoveAction,
  MoveStep,
  Shadow,
  Tentacles,
  Gaze,
  OnTheBall,
  HitAndRun,
  PickMeUp,
  Block,
  Vomit,
  Trickster,
  ThrowTeamMate,
  Crowd,
  Pass,
  DumpOff,
  Punt,
  BombLanding,
  Explosion,
  HandOff,
  Foul,
  SecretWeapon,
  Feed,
  Check,
  KnockDown,
  Injury,
  Stalling,
};
