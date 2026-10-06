import { useState } from "react";
import { DIE_FACES, type Action, type ActionTemplate, type GameState, type PassRange, type Side } from "@bb/engine";
import { formationActions, formations } from "@bb/data";
import { DieFace } from "./Dice";
import { blockFaceName, casualtyName } from "./describe";
import { findTemplate, type TemplateOf } from "./templates";

interface ActionPanelProps {
  state: GameState;
  /** Base URL of the image folder. */
  assets: string;
  /** Set while picking the target of a Blitz. */
  blitzFor: string | null;
  cancelBlitz(): void;
  templates: ActionTemplate[];
  dispatch(...actions: Action[]): void;
  /** Roll automatically whenever a ROLL is the only option. */
  autoRoll: boolean;
  setAutoRoll(value: boolean): void;
  /** Players picked on the board for a SELECT_PLAYERS decision. */
  picked: string[];
  setPicked(ids: string[]): void;
  /** Showing the pass range overlay. */
  aiming: boolean;
  setAiming(aiming: boolean): void;
  /** Online: the opponent's team name while it is their decision. */
  waitingFor?: string | null;
}

/** What the coach is asked to do, per main template. */
const PROMPTS: Partial<Record<ActionTemplate["type"], string>> = {
  CALL_COIN: "call the coin toss",
  CHOOSE_KICK: "choose to kick or receive",
  PLACE_PLAYER: "set up your players (drag them from the dugout)",
  PLACE_BALL: "click a square in the opposing half to kick the ball",
  GIVE_BALL: "touchback! Click the player who gets the ball",
  START_ACTION: "click a player to declare an action",
  BLOCK: "click a highlighted opponent to block (2D: you pick, 2D!: the defender picks)",
  PUSH: "click a square to push the player to",
  FOLLOW_UP: "follow up into the vacated square?",
  CHOOSE_BLOCK_DIE: "pick a block die",
  REROLL_BLOCK_DIE: "pick the block die to re-roll",
  THROW: "move, or aim a pass",
  HAND_OFF: "move, or click an adjacent team-mate to hand the ball to",
  THROW_TEAM_MATE: "move, or click an adjacent team-mate with Right Stuff, then a square to throw them to",
  FOUL: "move, or click a prone or stunned opponent next to you to foul (badge: armour modifier)",
  ARGUE_THE_CALL: "the referee saw the foul! Argue the call (6: the player stays, still a turnover; 1: coach banned)?",
  BRIBE: "use a bribe to keep the player (2+: no turnover)?",
  USE_APOTHECARY: "use the apothecary (once per game)?",
  APOTHECARY_CHOICE: "the apothecary re-rolled the casualty: keep which result?",
  MOVE: "click a highlighted square to move (D: dodge, R: rush, J: jump over a prone player, P: pick-up)",
  USE_REROLL: "use a team re-roll?",
  USE_SKILL: "use a skill?",
  MOVE_INSTEAD: "Bloodlust: take a Move action instead of the declared action?",
  SNAP: "Quick Snap: click an open player, then an adjacent square",
};

/** Buttons of the re-roll skills offered next to another decision (block dice, team re-roll). */
const REROLL_SKILLS: Record<string, string> = {
  Brawler: "Re-roll a Both Down (Brawler)",
  Hatred: "Re-roll a Skull (Hatred)",
  Pro: "Re-roll with Pro (3+)",
};

/** Short pass range names for the legend, shortest first. */
const RANGE_LEGEND: Record<PassRange, string> = { quick: "Quick", short: "Short", long: "Long", bomb: "Bomb" };

/** The THROW template is for a bomb: a Throw Bomb action, or a player who caught one and must throw it again. */
function throwingBomb(state: GameState) {
  const top = state.stack.at(-1);
  return (top?.type === "MoveAction" && top.action === "bomb") || (top?.type === "Pass" && top.bomb === true);
}

/** The prompt line, from the main template and the board's interaction mode. */
function promptText(state: GameState, templates: ActionTemplate[], main: ActionTemplate, blitzFor: string | null, aiming: boolean) {
  const roll = findTemplate(templates, "ROLL");
  const select = findTemplate(templates, "SELECT_PLAYERS");
  const snap = findTemplate(templates, "SNAP");
  if (blitzFor) return `click the opponent ${state.players[blitzFor]!.name} will blitz`;
  if (aiming && throwingBomb(state)) return "click a square (or a player) to throw the bomb to";
  if (aiming) return "click a square (or a team-mate) to throw to";
  if (main.type === "THROW" && throwingBomb(state)) {
    const top = state.stack.at(-1);
    return top?.type === "Pass" ? `${state.players[top.throwerId]!.name} caught the bomb and must throw it again: aim it` : "aim the bomb (no move before throwing it)";
  }
  if (roll) return `roll for ${roll.reason}`;
  if (select) return `${select.reason} (click players)`;
  if (snap) return `${PROMPTS.SNAP} (${snap.remaining} left)`;
  if (main.type === "USE_REROLL" && main.skill) return `use ${main.skill} to re-roll?`;
  if (main.type === "USE_SKILL") return `use ${main.skill} (${state.players[main.playerId]!.name})?`;
  if (state.stack.at(-1)?.type === "SecretWeapon" && (main.type === "ARGUE_THE_CALL" || main.type === "BRIBE")) {
    const name = state.players[main.playerId]!.name;
    return main.type === "ARGUE_THE_CALL"
      ? `${name}'s secret weapon gets them sent off! Argue the call (6: the player stays; 1: coach banned)?`
      : `use a bribe to keep ${name} (2+)?`;
  }
  return PROMPTS[main.type];
}

/** The decision panel: a prompt and one button per available non-board action. */
export function ActionPanel(props: ActionPanelProps) {
  const { state, assets, templates, dispatch, autoRoll, setAutoRoll, picked, setPicked } = props;
  // The block die choice may belong to the defending coach even if the attacker can still re-roll.
  const main = templates.find((t) => t.type === "CHOOSE_BLOCK_DIE") ?? templates.find((t) => t.type in PROMPTS) ?? templates[0];
  if (!main) {
    const waiting = props.waitingFor ? `Waiting for ${props.waitingFor}...` : "Waiting...";
    return <div className="bb-panel bb-actions">{state.finished ? "The game is over." : waiting}</div>;
  }
  const side: Side | null = "side" in main ? main.side : null;
  const has = (type: ActionTemplate["type"]) => templates.some((t) => t.type === type);
  const roll = findTemplate(templates, "ROLL");
  const select = findTemplate(templates, "SELECT_PLAYERS");
  const blockDie = findTemplate(templates, "CHOOSE_BLOCK_DIE");
  const throwTo = findTemplate(templates, "THROW");

  return (
    <div className={`bb-panel bb-actions${side ? ` bb-side-${side}` : ""}`}>
      <div className="bb-prompt">
        {side && <strong>{state.teams[side].name}: </strong>}
        {promptText(state, templates, main, props.blitzFor, props.aiming)}
      </div>
      <div className="bb-buttons">
        {throwTo && <ThrowControls template={throwTo} aiming={props.aiming} setAiming={props.setAiming} />}
        {props.blitzFor && (
          <button className="bb-link" onClick={props.cancelBlitz}>
            Cancel blitz
          </button>
        )}
        {has("CALL_COIN") && (
          <>
            <button onClick={() => dispatch({ type: "CALL_COIN", call: "heads" })}>Heads</button>
            <button onClick={() => dispatch({ type: "CALL_COIN", call: "tails" })}>Tails</button>
          </>
        )}
        {has("CHOOSE_KICK") && (
          <>
            <button onClick={() => dispatch({ type: "CHOOSE_KICK", kick: true })}>Kick</button>
            <button onClick={() => dispatch({ type: "CHOOSE_KICK", kick: false })}>Receive</button>
          </>
        )}
        {/* Keyed by the log length so that typed dice values do not carry over to the next roll. */}
        {roll && <RollControls key={state.log.length} template={roll} dispatch={dispatch} />}
        {select && (
          <button
            className="bb-confirm"
            disabled={picked.length < (select.min ?? 0)}
            onClick={() => {
              dispatch({ type: "SELECT_PLAYERS", playerIds: picked });
              setPicked([]);
            }}
          >
            {picked.length === 0 && !select.min ? "Skip" : `Confirm ${picked.length}/${select.max}`}
          </button>
        )}
        {has("DONE") && (
          <button
            onClick={() => {
              dispatch({ type: "DONE" });
              setPicked([]);
            }}
          >
            Done
          </button>
        )}
        {blockDie && (
          <span className="bb-block-dice">
            {blockDie.results.map((v, i) => (
              <button key={i} title={blockFaceName(v)} onClick={() => dispatch({ type: "CHOOSE_BLOCK_DIE", index: i })}>
                <DieFace kind="block" value={v} assets={assets} />
              </button>
            ))}
          </span>
        )}
        {has("ARGUE_THE_CALL") && (
          <>
            <button onClick={() => dispatch({ type: "ARGUE_THE_CALL", argue: true })}>Argue the call</button>
            <button onClick={() => dispatch({ type: "ARGUE_THE_CALL", argue: false })}>Accept</button>
          </>
        )}
        {main.type === "USE_APOTHECARY" && (
          <>
            <button onClick={() => dispatch({ type: "USE_APOTHECARY", use: true })}>
              Apothecary on {state.players[main.playerId]!.name} ({main.casualty ? casualtyName(main.casualty) : main.outcome === "ko" ? "KO'd" : "injured"})
            </button>
            <button onClick={() => dispatch({ type: "USE_APOTHECARY", use: false })}>No apothecary</button>
          </>
        )}
        {main.type === "APOTHECARY_CHOICE" && (
          <>
            <button onClick={() => dispatch({ type: "APOTHECARY_CHOICE", keep: "first" })}>{casualtyName(main.first)}</button>
            <button onClick={() => dispatch({ type: "APOTHECARY_CHOICE", keep: "second" })}>{casualtyName(main.second)}</button>
          </>
        )}
        {main.type === "BRIBE" && (
          <>
            <button onClick={() => dispatch({ type: "BRIBE", use: true })}>Use a bribe ({main.bribes} left)</button>
            <button onClick={() => dispatch({ type: "BRIBE", use: false })}>No bribe</button>
          </>
        )}
        {has("FOLLOW_UP") && (
          <>
            <button onClick={() => dispatch({ type: "FOLLOW_UP", follow: true })}>Follow up</button>
            <button onClick={() => dispatch({ type: "FOLLOW_UP", follow: false })}>Stay</button>
          </>
        )}
        {blockDie && has("USE_REROLL") && (
          <button onClick={() => dispatch({ type: "USE_REROLL" })}>Re-roll the dice</button>
        )}
        {templates.map((t) =>
          t.type === "USE_SKILL" && t !== main && REROLL_SKILLS[t.skill] ? (
            <button key={t.skill} onClick={() => dispatch({ type: "USE_SKILL", use: true, skill: t.skill })}>
              {REROLL_SKILLS[t.skill]}
            </button>
          ) : null,
        )}
        {main.type === "REROLL_BLOCK_DIE" && (
          <span className="bb-block-dice">
            {main.results.map((v, i) => (
              <button key={i} title={`Re-roll this ${blockFaceName(v)} (${main.skill})`} onClick={() => dispatch({ type: "REROLL_BLOCK_DIE", index: i })}>
                <DieFace kind="block" value={v} assets={assets} />
              </button>
            ))}
          </span>
        )}
        {main.type === "USE_REROLL" && (
          <>
            <button onClick={() => dispatch({ type: "USE_REROLL" })}>{main.skill ? `Re-roll (${main.skill})` : `Re-roll (${main.available} left)`}</button>
            <button onClick={() => dispatch({ type: "DECLINE_REROLL" })}>Accept failure</button>
          </>
        )}
        {main.type === "MOVE_INSTEAD" && (
          <>
            <button onClick={() => dispatch({ type: "MOVE_INSTEAD", move: true })}>Move instead</button>
            <button onClick={() => dispatch({ type: "MOVE_INSTEAD", move: false })}>Keep the action</button>
          </>
        )}
        {main.type === "USE_SKILL" && (
          <>
            <button onClick={() => dispatch({ type: "USE_SKILL", use: true, skill: main.skill })}>Use {main.skill}</button>
            <button onClick={() => dispatch({ type: "USE_SKILL", use: false, skill: main.skill })}>Don't use</button>
          </>
        )}
        {main.type === "PLACE_PLAYER" && (
          <SetupControls
            state={state}
            side={main.side}
            templates={templates}
            dispatch={dispatch}
            formations={state.stack.at(-1)?.type === "Setup"}
          />
        )}
        {findTemplate(templates, "VOMIT")?.targetIds.map((id) => (
          <button key={id} onClick={() => dispatch({ type: "VOMIT", targetId: id })}>
            Vomit on {state.players[id]!.name}
          </button>
        ))}
        {findTemplate(templates, "GAZE")?.targetIds.map((id) => (
          <button key={id} onClick={() => dispatch({ type: "GAZE", targetId: id })}>
            Gaze at {state.players[id]!.name}
          </button>
        ))}
        {findTemplate(templates, "STAB")?.targetIds.map((id) => (
          <button key={id} onClick={() => dispatch({ type: "STAB", targetId: id })}>
            Stab {state.players[id]!.name}
          </button>
        ))}
        {has("END_PLAYER_ACTION") && <button onClick={() => dispatch({ type: "END_PLAYER_ACTION" })}>End action</button>}
        {(has("END_TURN") || has("END_PLAYER_ACTION")) && (
          <button
            className="bb-end-turn"
            onClick={() =>
              dispatch(...(has("END_PLAYER_ACTION") ? [{ type: "END_PLAYER_ACTION" } as Action] : []), { type: "END_TURN" })
            }
          >
            End turn
          </button>
        )}
      </div>
      <label className="bb-auto-roll">
        <input type="checkbox" checked={autoRoll} onChange={(e) => setAutoRoll(e.target.checked)} /> Auto-roll dice
      </label>
    </div>
  );
}

/** Pass legend and cancel while aiming, or the button that starts aiming. */
function ThrowControls(props: { template: TemplateOf<"THROW">; aiming: boolean; setAiming(aiming: boolean): void }) {
  if (!props.aiming)
    return (
      <button className="bb-confirm" onClick={() => props.setAiming(true)}>
        Throw…
      </button>
    );
  return (
    <>
      <span className="bb-pass-legend">
        {(Object.keys(RANGE_LEGEND) as PassRange[]).map((range) => {
          const needed = props.template.squares.find((s) => s.range === range)?.needed;
          return (
            needed !== undefined && (
              <span key={range} className={`bb-legend-${range}`}>
                {RANGE_LEGEND[range]} {needed}+
              </span>
            )
          );
        })}
      </span>
      <button className="bb-link" onClick={() => props.setAiming(false)}>
        Cancel throw
      </button>
    </>
  );
}

/** Roll with the seeded RNG, or enter physical dice by hand. */
function RollControls({ template, dispatch }: { template: TemplateOf<"ROLL">; dispatch(a: Action): void }) {
  const dice = template.dice.flatMap((d) => Array.from({ length: d.count }, () => d.kind));
  const [manual, setManual] = useState(false);
  const [values, setValues] = useState<string[]>([]);
  const parsed = dice.map((_, i) => Number(values[i]));
  const valid = parsed.every((v, i) => Number.isInteger(v) && v >= 1 && v <= DIE_FACES[dice[i]!]);
  return (
    <>
      <button className="bb-roll" onClick={() => dispatch({ type: "ROLL" })}>
        🎲 Roll {template.dice.map((d) => `${d.count > 1 ? d.count : ""}${d.kind}`).join(" + ")}
      </button>
      <button className="bb-link" onClick={() => setManual(!manual)}>
        {manual ? "Hide" : "Physical dice"}
      </button>
      {manual && (
        <form
          className="bb-manual-dice"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) dispatch({ type: "ROLL", values: parsed });
            setValues([]);
          }}
        >
          {dice.map((kind, i) => (
            <input
              key={i}
              type="number"
              min={1}
              max={DIE_FACES[kind]}
              placeholder={kind}
              value={values[i] ?? ""}
              onChange={(e) => setValues((vs) => Object.assign([...vs], { [i]: e.target.value }))}
            />
          ))}
          <button type="submit" disabled={!valid}>
            Enter
          </button>
        </form>
      )}
    </>
  );
}

/** Formation buttons and the setup confirmation, with the reasons it is not legal yet. */
function SetupControls(props: {
  state: GameState;
  side: Side;
  templates: ActionTemplate[];
  dispatch(...a: Action[]): void;
  /** Formations only apply to a full setup, not to Solid Defence. */
  formations: boolean;
}) {
  const kicking = props.state.stack.some((p) => p.type === "Kickoff" && p.kicking === props.side);
  const names = props.formations ? Object.keys(formations).filter((n) => n.startsWith(kicking ? "def" : "off")) : [];
  const errors = findTemplate(props.templates, "END_SETUP")?.errors ?? [];
  return (
    <>
      {names.map((name) => (
        <button key={name} onClick={() => props.dispatch(...formationActions(props.state, props.side, formations[name]!))}>
          {name.replace(/^(off|def)_/, "").replace(/^\w/, (c) => c.toUpperCase())}
        </button>
      ))}
      <button className="bb-confirm" disabled={errors.length > 0} onClick={() => props.dispatch({ type: "END_SETUP" })}>
        Confirm setup
      </button>
      {errors.length > 0 && (
        <ul className="bb-errors">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </>
  );
}
