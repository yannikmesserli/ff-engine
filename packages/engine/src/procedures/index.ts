import type { HandlerMap } from "../context";
import { Bounce, Catch, DivingCatch, SafeHands, ThrowIn, Touchback } from "./ball";
import { BombLanding, Explosion } from "./bomb";
import { Block, Crowd, MultipleBlock, Trickster, Vomit } from "./block";
import { DumpOff, HandOff, Pass, Punt } from "./pass";
import { Foul, PileDriver, SecretWeapon } from "./foul";
import { Feed } from "./bloodlust";
import { Check, KnockDown } from "./checks";
import { Injury } from "./injury";
import { Prayers, Trapdoor } from "./prayers";
import { Stalling } from "./stalling";
import { CoinToss, Game, Half, KoRecovery, MasterChef, ThrowRock } from "./game";
import { Charge, HighKick, Kickoff, KickoffEvent, Pregame, QuickSnap, SolidDefence, SwelteringHeat } from "./kickoff";
import { Setup } from "./setup";
import { Carried } from "./carry";
import { Shop } from "./shop";
import { EndGame } from "./endgame";
import { ThrowTeamMate } from "./ttm";
import { Wizard } from "./wizard";
import { Gaze, HitAndRun, MoveAction, MoveStep, OnTheBall, PickMeUp, Shadow, Tentacles, Turn, WeatherMage } from "./turn";

/** Every procedure type's handler; `HandlerMap` makes a missing one a type error. */
export const handlers: HandlerMap = {
  Game,
  Pregame,
  Shop,
  Prayers,
  Trapdoor,
  CoinToss,
  SwelteringHeat,
  Half,
  KoRecovery,
  MasterChef,
  ThrowRock,
  Wizard,
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
  MultipleBlock,
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
  PileDriver,
  SecretWeapon,
  Feed,
  Check,
  KnockDown,
  Injury,
  Stalling,
  Carried,
  EndGame,
};
