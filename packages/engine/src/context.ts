import type { Action, ActionTemplate, DiceKind, DiceRoll, DiceSpec, GameEvent, GameState, Procedure } from "./types";
import { DIE_FACES, nextRandom } from "./dice";

/** Thrown for any action the rules do not allow; the state is left untouched. */
export class IllegalActionError extends Error {
  override name = "IllegalActionError";
}

/**
 * What a handler tells the runner after a step:
 * - "wait": the procedure needs player input (the action, if any, was consumed).
 * - "continue": step the top of the stack again (this procedure or newly pushed children).
 * - "done": remove this procedure; children it pushed stay on the stack and run next.
 */
export type StepResult = "wait" | "continue" | "done";

/** What a handler can do to the game while it steps. */
export interface Ctx {
  /** Immer draft: mutate freely. */
  state: GameState;
  /** Push procedures so that the first argument runs first. */
  push(...procedures: Procedure[]): void;
  /** Report an event to the caller of `step` and append it to `state.log`. */
  emit(event: GameEvent): void;
  /** Consume a ROLL action: uses the values provided by the user or rolls with the game RNG. */
  roll(action: Action | null, dice: DiceSpec[], reason: string): number[];
  /** Random integer in [0, n) from the game RNG, for random player picks (not shown as dice). */
  random(n: number): number;
  /** Narrow `action` to one of `types`, or reject it. */
  expect<T extends Action["type"]>(action: Action | null, ...types: T[]): Extract<Action, { type: T }>;
  /** Abort the whole step with an IllegalActionError. */
  reject(message: string): never;
}

/** Behaviour of one procedure type. */
export interface Handler<P extends Procedure = Procedure> {
  /** `action` is null when the procedure is entered or resumed without player input. */
  step(ctx: Ctx, proc: P, action: Action | null): StepResult;
  /** Actions available while this procedure is waiting on top of the stack. */
  actions(state: GameState, proc: P): ActionTemplate[];
}

/** One handler per procedure type. */
export type HandlerMap = { [K in Procedure["type"]]: Handler<Extract<Procedure, { type: K }>> };

/** Build the context handlers use; `events` collects what is emitted during this step. */
export function createContext(state: GameState, events: GameEvent[]): Ctx {
  const ctx: Ctx = {
    state,
    push(...procedures) {
      state.stack.push(...procedures.reverse());
    },
    emit(event) {
      events.push(event);
      state.log.push(event);
    },
    roll(action, dice, reason) {
      const { values } = ctx.expect(action, "ROLL");
      const kinds = dice.flatMap((d) => Array<DiceKind>(d.count).fill(d.kind));
      if (values !== undefined && values.length !== kinds.length) {
        ctx.reject(`Expected ${kinds.length} dice values, got ${values.length}.`);
      }
      const result = kinds.map((kind, i) => {
        const v = values?.[i];
        if (v === undefined) return 1 + ctx.random(DIE_FACES[kind]);
        if (!Number.isInteger(v) || v < 1 || v > DIE_FACES[kind]) ctx.reject(`Invalid ${kind} value: ${v}.`);
        return v;
      });
      let next = 0;
      const rolls: DiceRoll[] = dice.map((d) => ({ kind: d.kind, values: result.slice(next, (next += d.count)) }));
      ctx.emit({ type: "DiceRolled", rolls, reason });
      return result;
    },
    random(n) {
      const [r, next] = nextRandom(state.rng);
      state.rng = next;
      return Math.floor(r * n);
    },
    expect(action, ...types) {
      if (action === null || !types.includes(action.type as never)) {
        ctx.reject(`Expected ${types.join(" or ")}, got ${action?.type ?? "nothing"}.`);
      }
      return action as never;
    },
    reject(message) {
      throw new IllegalActionError(message);
    },
  };
  return ctx;
}

/** Safety net against handlers that keep returning "continue". */
const MAX_STEPS = 10_000;

/** Run the procedure stack until a procedure waits for input or the stack is empty. */
export function run(ctx: Ctx, handlers: HandlerMap, action: Action | null) {
  let pending = action;
  for (let i = 0; ctx.state.stack.length > 0; i++) {
    if (i > MAX_STEPS) throw new Error("Procedure stack did not settle (infinite loop?)");
    const index = ctx.state.stack.length - 1;
    const proc = ctx.state.stack[index]!;
    const handler = handlers[proc.type] as Handler;
    // The action goes to the first step only; later steps run without input.
    const input = pending;
    pending = null;
    const result = handler.step(ctx, proc, input);
    if (result === "wait") break;
    if (result === "done") ctx.state.stack.splice(index, 1);
  }
}
