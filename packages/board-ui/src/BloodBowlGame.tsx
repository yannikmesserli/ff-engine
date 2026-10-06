import { useEffect, useMemo, useRef, useState } from "react";
import {
  IMPLEMENTED_SKILLS,
  IllegalActionError,
  applyActions,
  createGame,
  getAvailableActions,
  skillName,
  step,
  type Action,
  type ActionTemplate,
  type GameEvent,
  type GameState,
  type PlayerState,
  type Side,
} from "@bb/engine";
import { resolveTeam, skillDescription } from "@bb/data";
import { ActionPanel } from "./ActionPanel";
import { Board, type ActionMenuState } from "./Board";
import { DiceRolls } from "./Dice";
import { WEATHER_NAMES, casualtyName, describeEvent } from "./describe";
import { teamLogo } from "./icons";
import "./styles.css";

/** Props of {@link BloodBowlGame}. */
export interface BloodBowlGameProps {
  /** Team files in @bb/data's format (see packages/data/README.md), validated by resolveTeam(). */
  home: unknown;
  away: unknown;
  /** Base URL of the image folder (layout in packages/board-ui/README.md). */
  assetsUrl?: string;
  /** RNG seed, to replay the same dice. Random when omitted. */
  seed?: number;
  /** Actions applied right after the game is created, to start from a prepared position; undo stops there. */
  actions?: readonly Action[];
  /** Called with the new state after every successful action. */
  onChange?(state: GameState): void;
  /** Play online against another browser instead of hot-seat (see {@link OnlineControl}). */
  online?: OnlineControl;
}

/**
 * Online play: this browser only takes `side`'s decisions. Actions are not applied locally but sent with `send`;
 * the game is the replay of `actions`, every batch both players sent, in one order shared by both browsers. With the
 * same teams, seed and actions, both browsers compute the same game. There is no undo.
 */
export interface OnlineControl {
  side: Side;
  actions: Action[][];
  send(actions: Action[]): void;
}

/** Who takes a decision: its side, or for rolls anyone could make, the team whose turn it is (home before kick-off). */
export const decider = (state: GameState, template: ActionTemplate): Side => template.side ?? state.activeSide ?? "home";

const AUTO_ROLL_DELAY_MS = 350;

/** Default for `actions`: a stable empty list, so the game is not recreated on every render. */
const NO_ACTIONS: readonly Action[] = [];

/** A complete hot-seat Blood Bowl game between two teams; restarts when `home`, `away`, `seed` or `actions` change. */
export function BloodBowlGame({ home, away, assetsUrl = "/img", seed, actions = NO_ACTIONS, onChange, online }: BloodBowlGameProps) {
  const initial = useMemo(() => {
    try {
      return { state: applyActions(createGame(resolveTeam(home), resolveTeam(away), { seed }), actions) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [home, away, seed, actions]);
  if ("error" in initial) return <div className="bb-game bb-error">{initial.error}</div>;
  return <Game key={JSON.stringify([home, away, seed, actions])} initial={initial.state} assets={assetsUrl} onChange={onChange} online={online} />;
}

/** The state after applying the batches of actions in order; a batch that is not legal is skipped as a whole. */
function replay(from: GameState, batches: Action[][]): GameState {
  return batches.reduce((state, batch) => {
    try {
      return batch.reduce((s, a) => step(s, a).state, state);
    } catch (e) {
      if (e instanceof IllegalActionError) return state;
      throw e;
    }
  }, from);
}

/** The online game state, replaying only the batches received since the last render. */
function useReplay(initial: GameState, batches: Action[][] | undefined): GameState {
  const cache = useRef({ applied: 0, state: initial });
  if (!batches) return initial;
  if (batches.length < cache.current.applied) cache.current = { applied: 0, state: initial };
  if (batches.length > cache.current.applied) {
    cache.current = { applied: batches.length, state: replay(cache.current.state, batches.slice(cache.current.applied)) };
  }
  return cache.current.state;
}

/** The game screen: owns the state history (for undo) and the board's interaction state. */
function Game(props: { initial: GameState; assets: string; onChange?(s: GameState): void; online?: OnlineControl }) {
  const { initial, assets, onChange, online } = props;
  const [history, setHistory] = useState<GameState[]>([initial]);
  const [error, setError] = useState<string | null>(null);
  const [autoRoll, setAutoRoll] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  /** Clicked player: their card stays until another player is clicked or it is closed. */
  const [pinned, setPinned] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [menu, setMenu] = useState<ActionMenuState | null>(null);
  const [aiming, setAiming] = useState(false);
  const onlineState = useReplay(initial, online?.actions);
  const state = online ? onlineState : history.at(-1)!;
  // Online, the board only offers this browser's decisions.
  const templates = useMemo(() => {
    const all = getAvailableActions(state);
    return online ? all.filter((t) => decider(state, t) === online.side) : all;
  }, [state, online?.side]);
  const waitingFor = online && templates.length === 0 && !state.finished ? state.teams[online.side === "home" ? "away" : "home"].name : null;

  useEffect(() => {
    if (online) onChange?.(state);
  }, [state]);

  /**
   * Applies the actions in order as one undo step; an illegal action is shown instead of applied.
   * Online, legal actions are sent instead, and applied when they come back.
   */
  const dispatch = (...actions: Action[]) => {
    try {
      const next = actions.reduce((s, a) => step(s, a).state, state);
      setError(null);
      setAiming(false);
      if (online) {
        online.send(actions);
        return;
      }
      setHistory((h) => [...h, next]);
      onChange?.(next);
    } catch (e) {
      if (!(e instanceof IllegalActionError)) throw e;
      setError(e.message);
    }
  };

  /** Back to the previous state, dropping any half-made choice on the board. */
  const undo = () => {
    const previous = history.at(-2);
    if (!previous) return;
    setHistory(history.slice(0, -1));
    setPicked([]);
    setMenu(null);
    setAiming(false);
    setError(null);
    onChange?.(previous);
  };

  const onlyRoll = templates.length === 1 && templates[0]!.type === "ROLL";
  // `dispatch` only depends on `state` (and `onChange`), so the timer restarts on new states, not on every render.
  useEffect(() => {
    if (!autoRoll || !onlyRoll) return;
    const timer = setTimeout(() => dispatch({ type: "ROLL" }), AUTO_ROLL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autoRoll, onlyRoll, state]);

  // The hovered player's card, else the pinned one.
  const shown = hovered ?? pinned;
  const player = shown ? state.players[shown] : undefined;

  return (
    <div className="bb-game">
      <Scoreboard state={state} assets={assets} />
      <Board
        state={state}
        templates={templates}
        assets={assets}
        dispatch={dispatch}
        onHover={setHovered}
        onInspect={setPinned}
        picked={picked}
        setPicked={setPicked}
        menu={menu}
        setMenu={setMenu}
        aiming={aiming}
      />
      <div className="bb-bottom">
        <div className="bb-left">
          <ActionPanel
            state={state}
            assets={assets}
            blitzFor={menu?.mode === "blitz-target" ? menu.playerId : null}
            cancelBlitz={() => setMenu(null)}
            templates={templates}
            dispatch={dispatch}
            autoRoll={autoRoll}
            setAutoRoll={setAutoRoll}
            picked={picked}
            setPicked={setPicked}
            aiming={aiming}
            setAiming={setAiming}
            waitingFor={waitingFor}
          />
          {error && <div className="bb-panel bb-error">{error}</div>}
          <LastRoll state={state} assets={assets} canUndo={!online && history.length > 1} onUndo={undo} />
          {player && <PlayerCard player={player} pinned={player.id === pinned} onClose={() => setPinned(null)} />}
        </div>
        <GameLog state={state} />
      </div>
    </div>
  );
}

/** Both teams (logo, turn, re-rolls) around the score, half and weather. */
function Scoreboard({ state, assets }: { state: GameState; assets: string }) {
  return (
    <div className="bb-scoreboard">
      <TeamBanner state={state} side="home" assets={assets} />
      <div className="bb-score">
        <div>
          {state.teams.home.score} – {state.teams.away.score}
        </div>
        <div className="bb-half">
          Half {state.half} · {WEATHER_NAMES[state.weather]}
        </div>
      </div>
      <TeamBanner state={state} side="away" assets={assets} />
    </div>
  );
}

function TeamBanner({ state, side, assets }: { state: GameState; side: Side; assets: string }) {
  const t = state.teams[side];
  return (
    <div className={`bb-team bb-side-${side}${state.activeSide === side ? " bb-acting" : ""}`}>
      <img src={teamLogo(assets, t.roster)} alt="" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
      <div>
        <div className="bb-team-name">{t.name}</div>
        <div className="bb-team-info">
          Turn {t.turn}/8 · Re-rolls {t.rerolls}
          {t.driveRerolls > 0 ? ` +${t.driveRerolls}` : ""}
        </div>
      </div>
    </div>
  );
}

/** The latest dice roll, with the undo button. */
function LastRoll(props: { state: GameState; assets: string; canUndo: boolean; onUndo(): void }) {
  const lastRoll = props.state.log.findLast((e): e is Extract<GameEvent, { type: "DiceRolled" }> => e.type === "DiceRolled");
  return (
    <div className="bb-panel bb-last-roll">
      {lastRoll ? (
        <>
          <span>{lastRoll.reason}</span>
          <DiceRolls rolls={lastRoll.rolls} assets={props.assets} />
        </>
      ) : (
        <span>No dice rolled yet.</span>
      )}
      <button className="bb-link" disabled={!props.canUndo} onClick={props.onUndo}>
        ↶ Undo
      </button>
    </div>
  );
}

/** A skill name with its description as a tooltip, flagged when the engine does not apply it yet. */
function Skill({ skill }: { skill: string }) {
  const description = skillDescription(skill) ?? "No description yet.";
  const missing = !IMPLEMENTED_SKILLS.includes(skillName(skill));
  return (
    <span className={`bb-skill${missing ? " bb-skill-missing" : ""}`} tabIndex={0}>
      {skill}
      <span className="bb-tip" role="tooltip">
        {description}
        {missing && <em> Not applied by this engine yet.</em>}
      </span>
    </span>
  );
}

/** Stats and skills of the hovered player, or of the clicked one (pinned until closed). */
function PlayerCard({ player, pinned, onClose }: { player: PlayerState; pinned: boolean; onClose(): void }) {
  return (
    <div className={`bb-panel bb-player-card bb-side-${player.side}`}>
      {pinned && (
        <button className="bb-link bb-unpin" title="Unpin this player" onClick={onClose}>
          ×
        </button>
      )}
      <strong>
        #{player.nr} {player.name}
      </strong>{" "}
      — {player.position}
      <div className="bb-stats">
        MA {player.ma} · ST {player.st} · AG {player.ag}+ · PA {player.pa === null ? "–" : `${player.pa}+`} · AV {player.av}+
      </div>
      <div className="bb-skills">
        {player.skills.length === 0
          ? "No skills"
          : player.skills.map((s, i) => (
              <span key={s}>
                {i > 0 && ", "}
                <Skill skill={s} />
              </span>
            ))}
      </div>
      {player.casualty && <div className="bb-casualty">{casualtyName(player.casualty)}</div>}
    </div>
  );
}

/** Readable log lines, newest first. */
function GameLog({ state }: { state: GameState }) {
  const lines = state.log
    .map((e, i) => ({ i, text: describeEvent(state, e) }))
    .filter((l): l is { i: number; text: string } => l.text !== null)
    .reverse();
  return (
    <div className="bb-panel bb-log">
      {lines.map((l) => (
        <div key={l.i}>{l.text}</div>
      ))}
    </div>
  );
}
