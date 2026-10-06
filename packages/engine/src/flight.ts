import type { GameState, Square } from "./types";
import { inBounds, isOnPitch } from "./pitch";

/**
 * A ball or bomb that is not lying on the pitch or carried, for display:
 * - "aimed": the square it was kicked or thrown to, before the deviation or the pass roll (it may still move);
 * - "landing": where it comes down, once the deviation or scatter is known;
 * - "held": a bomb in the hands of the player who must throw it again;
 * - "exploding": a bomb going off.
 */
export interface FlightMarker {
  kind: "ball" | "bomb";
  square: Square;
  state: "aimed" | "landing" | "held" | "exploding";
}

/** Stages of a pass before the throw is resolved: the ball or bomb is still aimed at the target. */
const AIMING = ["animosity", "animosityResult", "roll", "reroll", "loner", "pro", "proTeam", "proLoner", "scatter"];
/** Stages of a pass after it is resolved: it is coming down on `landing`. */
const LANDING = ["intercept", "interceptRoll", "land"];

/** Every kicked, thrown or exploding ball and bomb, from the procedure stack. */
export function flightMarkers(state: GameState): FlightMarker[] {
  const markers: FlightMarker[] = [];
  for (const p of state.stack) {
    if (p.type === "Kickoff") {
      if (p.stage === "scatter" && p.target) markers.push({ kind: "ball", square: p.target, state: "aimed" });
      else if (p.stage !== "place" && p.landing && !p.touchback && inBounds(p.landing)) markers.push({ kind: "ball", square: p.landing, state: "landing" });
    } else if (p.type === "Pass") {
      const kind = p.bomb ? "bomb" : "ball";
      const thrower = state.players[p.throwerId];
      if (p.stage === "aim" && thrower && isOnPitch(thrower)) markers.push({ kind, square: thrower.at, state: "held" });
      else if (AIMING.includes(p.stage)) markers.push({ kind, square: p.target, state: "aimed" });
      else if (LANDING.includes(p.stage) && p.landing && !p.throwInFrom) markers.push({ kind, square: p.landing, state: "landing" });
    } else if (p.type === "BombLanding") {
      markers.push({ kind: "bomb", square: p.square, state: "landing" });
    } else if (p.type === "Explosion") {
      markers.push({ kind: "bomb", square: p.square, state: "exploding" });
    }
  }
  return markers;
}
