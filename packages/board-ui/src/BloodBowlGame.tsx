import { useEffect, useMemo, useState } from "react";
import {
  IllegalActionError,
  createGame,
  getAvailableActions,
  step,
  type Action,
  type GameEvent,
  type GameState,
  type PlayerState,
  type Side,
} from "@bb/engine";
import { resolveTeam } from "@bb/data";
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
  /** Called with the new state after every successful action. */
  onChange?(state: GameState): void;
}

const AUTO_ROLL_DELAY_MS = 350;

/** A complete hot-seat Blood Bowl game between two teams; restarts when `home`, `away` or `seed` change. */
export function BloodBowlGame({ home, away, assetsUrl = "/img", seed, onChange }: BloodBowlGameProps) {
  const initial = useMemo(() => {
    try {
      return { state: createGame(resolveTeam(home), resolveTeam(away), { seed }) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [home, away, seed]);
  if ("error" in initial) return <div className="bb-game bb-error">{initial.error}</div>;
  return <Game key={JSON.stringify([home, away, seed])} initial={initial.state} assets={assetsUrl} onChange={onChange} />;
}

/** The game screen: owns the state history (for undo) and the board's interaction state. */
function Game({ initial, assets, onChange }: { initial: GameState; assets: string; onChange?(s: GameState): void }) {
  const [history, setHistory] = useState<GameState[]>([initial]);
  const [error, setError] = useState<string | null>(null);
  const [autoRoll, setAutoRoll] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [menu, setMenu] = useState<ActionMenuState | null>(null);
  const [aiming, setAiming] = useState(false);
  const state = history.at(-1)!;
  const templates = useMemo(() => getAvailableActions(state), [state]);

  /** Applies the actions in order as one undo step; an illegal action is shown instead of applied. */
  const dispatch = (...actions: Action[]) => {
    try {
      const next = actions.reduce((s, a) => step(s, a).state, state);
      setHistory((h) => [...h, next]);
      setError(null);
      setAiming(false);
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

  const player = hovered ? state.players[hovered] : undefined;

  return (
    <div className="bb-game">
      <Scoreboard state={state} assets={assets} />
      <Board
        state={state}
        templates={templates}
        assets={assets}
        dispatch={dispatch}
        onHover={setHovered}
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
          />
          {error && <div className="bb-panel bb-error">{error}</div>}
          <LastRoll state={state} assets={assets} canUndo={history.length > 1} onUndo={undo} />
          {player && <PlayerCard player={player} />}
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

/** Stats and skills of the hovered player. */
function PlayerCard({ player }: { player: PlayerState }) {
  return (
    <div className={`bb-panel bb-player-card bb-side-${player.side}`}>
      <strong>
        #{player.nr} {player.name}
      </strong>{" "}
      — {player.position}
      <div className="bb-stats">
        MA {player.ma} · ST {player.st} · AG {player.ag}+ · PA {player.pa === null ? "–" : `${player.pa}+`} · AV {player.av}+
      </div>
      <div className="bb-skills">{player.skills.join(", ") || "No skills"}</div>
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
