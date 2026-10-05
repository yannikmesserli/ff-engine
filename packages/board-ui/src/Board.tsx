import type { ReactNode } from "react";
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import {
  PITCH_HEIGHT,
  PITCH_WIDTH,
  isOnPitch,
  sameSquare,
  teamPlayers,
  type Action,
  type ActionTemplate,
  type CheckKind,
  type PassRange,
  type PlayerActionType,
  type DugoutBox,
  type GameState,
  type PlayerState,
  type Side,
  type Square,
} from "@bb/engine";
import { ACTION_NAMES, PASS_RANGE_NAMES } from "./describe";
import { playerIcon } from "./icons";
import { findTemplate } from "./templates";

/** Square size in pixels (keep in sync with --bb-square in styles.css). */
const SQUARE_SIZE = 30;
/** Width of a dugout column (see .bb-dugout in styles.css). */
const DUGOUT_WIDTH = 2 * SQUARE_SIZE + 4 + 3;
/** Approximate action menu size in squares, to keep it inside the pitch. */
const MENU_ROWS = 7;
const MENU_COLUMNS = 5;

const ROLL_BADGES: Partial<Record<CheckKind, string>> = { dodge: "D", rush: "R", jump: "J", pickup: "P" };

const ALL_SQUARES: Square[] = Array.from({ length: PITCH_WIDTH * PITCH_HEIGHT }, (_, i) => ({
  x: i % PITCH_WIDTH,
  y: Math.floor(i / PITCH_WIDTH),
}));

/** Action menu open on a player, or picking the target of the Blitz they declare. */
export type ActionMenuState = { playerId: string; mode: "actions" | "blitz-target" };

interface BoardProps {
  state: GameState;
  templates: ActionTemplate[];
  /** Base URL of the image folder. */
  assets: string;
  dispatch(action: Action): void;
  /** Called with the hovered player, or null when the pointer leaves it. */
  onHover(playerId: string | null): void;
  /** A player was clicked (anywhere: pitch or dugout), e.g. to pin their card. */
  onInspect(playerId: string): void;
  /** Players picked for a SELECT_PLAYERS decision, or the Quick Snap player about to move. */
  picked: string[];
  setPicked(ids: string[]): void;
  menu: ActionMenuState | null;
  setMenu(menu: ActionMenuState | null): void;
  /** Showing the pass range overlay: square clicks throw instead of moving. */
  aiming: boolean;
}

/** "2D" when the attacker picks, "2D!" when the defender picks. */
const diceLabel = (dice: number) => `${Math.abs(dice)}D${dice < 0 ? "!" : ""}`;

/** "+1", "-1" or "±0". */
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? String(n) : "±0");

const squareId = (s: Square) => `sq-${s.x}-${s.y}`;

/** Pixel position of a square's top-left corner on the pitch. */
const at = (s: Square) => ({ left: s.x * SQUARE_SIZE, top: s.y * SQUARE_SIZE });

/** The pitch between both dugouts: renders the board templates and turns clicks and drags into actions. */
export function Board({ state, templates, assets, dispatch, onHover, onInspect, picked, setPicked, menu, setMenu, aiming }: BoardProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const placement = findTemplate(templates, "PLACE_PLAYER");
  const ballTarget = findTemplate(templates, "PLACE_BALL");
  const move = findTemplate(templates, "MOVE");
  const startAction = findTemplate(templates, "START_ACTION");
  const block = findTemplate(templates, "BLOCK");
  const push = findTemplate(templates, "PUSH");
  const followUp = findTemplate(templates, "FOLLOW_UP");
  const throwTo = aiming ? findTemplate(templates, "THROW") : undefined;
  const handOff = findTemplate(templates, "HAND_OFF");
  const ttm = findTemplate(templates, "THROW_TEAM_MATE");
  // Throw Team-mate: once a team-mate is picked, the target squares replace the moves.
  const thrown = ttm?.playerIds.includes(picked[0] ?? "") ? picked[0] : undefined;
  const ttmSquares = thrown ? ttm!.squares : undefined;
  const foul = findTemplate(templates, "FOUL");
  const giveBall = findTemplate(templates, "GIVE_BALL");
  const select = findTemplate(templates, "SELECT_PLAYERS");
  const snap = findTemplate(templates, "SNAP");
  const snapMove = snap?.moves.find((m) => m.playerId === picked[0]);
  const choiceFor = (id: string) => startAction?.choices.find((c) => c.playerId === id);
  const pickingBlitzTarget = menu?.mode === "blitz-target" ? menu.playerId : null;
  const blitzTarget = state.stack.findLast(
    (p): p is Extract<typeof p, { type: "MoveAction" }> => p.type === "MoveAction" && p.action === "blitz",
  )?.targetId;

  const draggable = new Set(placement?.playerIds ?? []);
  const selectable = new Set([
    ...(pickingBlitzTarget ? (startAction?.blitzTargets ?? []) : (startAction?.choices.map((c) => c.playerId) ?? [])),
    ...(block?.targets.map((t) => t.playerId) ?? []),
    ...(handOff?.playerIds ?? []),
    ...(ttm?.playerIds ?? []),
    ...(foul?.targets.map((t) => t.playerId) ?? []),
    ...(giveBall?.playerIds ?? []),
    ...(select?.playerIds ?? []),
    ...(snap?.moves.map((m) => m.playerId) ?? []),
  ]);
  // Highlighted squares: at most one of these templates is offered at a time.
  const targets: Array<Square & { rolls?: CheckKind[] }> =
    ballTarget?.squares ?? push?.squares ?? (followUp ? [followUp.square] : undefined) ?? move?.squares ?? snapMove?.squares ?? [];
  const placementSquares = new Set((placement?.squares ?? []).map(squareId));

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || !placement) return;
    const playerId = String(active.id);
    const id = String(over.id);
    if (id.startsWith("dugout-")) dispatch({ type: "PLACE_PLAYER", playerId, square: null });
    else {
      const [, x, y] = id.split("-").map(Number);
      dispatch({ type: "PLACE_PLAYER", playerId, square: { x: x!, y: y! } });
    }
  };

  const clickSquare = (s: Square) => {
    if (snapMove?.squares.some((t) => sameSquare(t, s))) {
      dispatch({ type: "SNAP", playerId: snapMove.playerId, square: s });
      setPicked([]);
    } else if (thrown && ttmSquares?.some((t) => sameSquare(t, s))) {
      dispatch({ type: "THROW_TEAM_MATE", targetId: thrown, square: s });
      setPicked([]);
    } else if (push?.squares.some((t) => sameSquare(t, s))) dispatch({ type: "PUSH", square: s });
    else if (throwTo?.squares.some((t) => sameSquare(t, s))) dispatch({ type: "THROW", square: s });
    else if (followUp && sameSquare(followUp.square, s)) dispatch({ type: "FOLLOW_UP", follow: true });
    else if (ballTarget) dispatch({ type: "PLACE_BALL", square: s });
    else if (move?.squares.some((t) => sameSquare(t, s))) dispatch({ type: "MOVE", square: s });
  };

  const clickPlayer = (p: PlayerState) => {
    if (select?.playerIds.includes(p.id)) {
      if (picked.includes(p.id)) setPicked(picked.filter((id) => id !== p.id));
      else if (select.max === 1) setPicked([p.id]);
      else if (picked.length < select.max) setPicked([...picked, p.id]);
    } else if (snap?.moves.some((m) => m.playerId === p.id)) setPicked([p.id]);
    else if (giveBall?.playerIds.includes(p.id)) dispatch({ type: "GIVE_BALL", playerId: p.id });
    else if (pickingBlitzTarget) {
      if (startAction?.blitzTargets.includes(p.id)) {
        dispatch({ type: "START_ACTION", playerId: pickingBlitzTarget, action: "blitz", targetId: p.id });
        setMenu(null);
      }
    } else if (block?.targets.some((t) => t.playerId === p.id)) dispatch({ type: "BLOCK", targetId: p.id });
    else if (handOff?.playerIds.includes(p.id)) dispatch({ type: "HAND_OFF", targetId: p.id });
    else if (ttm?.playerIds.includes(p.id) && !thrown) setPicked([p.id]);
    else if (foul?.targets.some((t) => t.playerId === p.id)) dispatch({ type: "FOUL", targetId: p.id });
    else if (choiceFor(p.id)) setMenu(menu?.playerId === p.id ? null : { playerId: p.id, mode: "actions" });
    // Otherwise the click is about the square under the player (kick or pass target, push square...).
    else if (isOnPitch(p)) clickSquare(p.at);
  };

  const pickAction = (playerId: string, action: PlayerActionType) => {
    if (action === "blitz") setMenu({ playerId, mode: "blitz-target" });
    else {
      dispatch({ type: "START_ACTION", playerId, action });
      setMenu(null);
    }
  };

  const token = (p: PlayerState) => (
    <PlayerToken
      key={p.id}
      player={p}
      roster={state.teams[p.side].roster}
      assets={assets}
      active={state.activePlayerId === p.id || picked.includes(p.id)}
      draggable={draggable.has(p.id)}
      selectable={selectable.has(p.id)}
      hasBall={state.ball.carried && isOnPitch(p) && state.ball.square !== null && sameSquare(state.ball.square, p.at)}
      blockDice={block?.targets.find((t) => t.playerId === p.id)?.dice}
      foulAssists={foul?.targets.find((t) => t.playerId === p.id)?.assists}
      blitzTarget={p.id === blitzTarget}
      onClick={() => {
        onInspect(p.id);
        clickPlayer(p);
      }}
      onHover={onHover}
    />
  );

  const menuChoice = menu?.mode === "actions" ? choiceFor(menu.playerId) : undefined;

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="bb-board-wrap">
        <div className="bb-board">
          <Dugout side="home" state={state} droppable={placement?.side === "home"} render={token} />
          <div className="bb-pitch" style={{ backgroundImage: `url(${assets}/arenas/pitch/nice-26x15.jpg)` }}>
            {ALL_SQUARES.map((s) => {
              const target = targets.find((t) => sameSquare(t, s));
              const rolls = target?.rolls ?? [];
              const pass = (throwTo ?? (ttmSquares ? { squares: ttmSquares } : undefined))?.squares.find((t) => sameSquare(t, s));
              return (
                <PitchSquare
                  key={squareId(s)}
                  square={s}
                  droppable={placementSquares.has(squareId(s))}
                  target={pass ? `pass-${pass.range}` : target !== undefined ? (ballTarget ? "kick" : "move") : null}
                  risky={rolls.length > 0}
                  badge={pass ? "" : rolls.map((r) => ROLL_BADGES[r]).join("")}
                  title={pass ? `${PASS_RANGE_NAMES[pass.range]}: ${pass.needed}+ for an accurate pass` : undefined}
                  onClick={() => clickSquare(s)}
                />
              );
            })}
            {Object.values(state.players)
              .filter(isOnPitch)
              .map((p) => (
                <div key={p.id} className="bb-on-square" style={at(p.at)}>
                  {token(p)}
                </div>
              ))}
            {state.ball.square && !state.ball.carried && (
              <img className="bb-ball" src={`${assets}/ball/sball_30x30.png`} alt="ball" style={at(state.ball.square)} />
            )}
          </div>
          <Dugout side="away" state={state} droppable={placement?.side === "away"} render={token} />
        </div>
        {menu && menuChoice && (
          <ActionMenu
            player={state.players[menu.playerId]!}
            available={menuChoice.actions}
            onPick={(action) => pickAction(menu.playerId, action)}
            onClose={() => setMenu(null)}
          />
        )}
      </div>
    </DndContext>
  );
}

/** One pitch square: drop target during setup, click target otherwise. */
function PitchSquare(props: {
  square: Square;
  droppable: boolean;
  /** Highlight: kick target, move/push/follow-up target, or pass range band. */
  target: "kick" | "move" | `pass-${PassRange}` | null;
  /** The move needs a roll (dodge, rush, pick-up). */
  risky: boolean;
  badge: string;
  title?: string | undefined;
  onClick(): void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: squareId(props.square), disabled: !props.droppable });
  const classes = ["bb-square"];
  if (props.droppable) classes.push("bb-droppable");
  if (isOver) classes.push("bb-over");
  if (props.target === "kick") classes.push("bb-kick-target");
  if (props.target?.startsWith("pass-")) classes.push("bb-pass-target", `bb-${props.target}`);
  if (props.target === "move") classes.push(props.risky ? "bb-target-risky" : "bb-target");
  return (
    <div ref={setNodeRef} className={classes.join(" ")} style={at(props.square)} title={props.title} onClick={props.onClick}>
      {props.badge && <span className="bb-badge">{props.badge}</span>}
    </div>
  );
}

const BOXES: Array<{ box: DugoutBox; label: string }> = [
  { box: "reserves", label: "Reserves" },
  { box: "ko", label: "KO" },
  { box: "cas", label: "CAS" },
  { box: "banned", label: "Sent off" },
];

/** A team's dugout boxes; a drop target (back to the reserves) during setup. */
function Dugout(props: { side: Side; state: GameState; droppable: boolean; render(p: PlayerState): ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `dugout-${props.side}`, disabled: !props.droppable });
  const players = teamPlayers(props.state, props.side);
  return (
    <div
      ref={setNodeRef}
      className={`bb-dugout bb-dugout-${props.side}${props.droppable ? " bb-droppable" : ""}${isOver ? " bb-over" : ""}`}
    >
      {BOXES.map(({ box, label }) => (
        <div key={box} className="bb-dugout-box">
          <div className="bb-dugout-label">{label}</div>
          <div className="bb-dugout-players">{players.filter((p) => p.at === box).map(props.render)}</div>
        </div>
      ))}
    </div>
  );
}

/** A player sprite with status, ball and block/foul badges; draggable during setup. */
function PlayerToken(props: {
  player: PlayerState;
  roster: string;
  assets: string;
  /** Acting or picked: highlighted with the animated sprite. */
  active: boolean;
  draggable: boolean;
  selectable: boolean;
  hasBall: boolean;
  /** Block dice against this player, when it can be blocked. */
  blockDice?: number | undefined;
  /** Armour roll modifier from assists, when this player can be fouled. */
  foulAssists?: number | undefined;
  blitzTarget: boolean;
  onClick(): void;
  onHover(playerId: string | null): void;
}) {
  const { player, assets } = props;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: player.id,
    disabled: !props.draggable,
  });
  const icon = playerIcon(assets, props.roster, player, props.active);
  const classes = ["bb-player", `bb-${player.side}`, `bb-${player.status}`];
  if (props.active) classes.push("bb-active");
  if (props.selectable) classes.push("bb-selectable");
  if (props.draggable) classes.push("bb-draggable");
  if (player.activated && !props.active) classes.push("bb-used");
  if (player.distracted) classes.push("bb-distracted");
  if (isDragging) classes.push("bb-dragging");
  if (props.blitzTarget) classes.push("bb-blitz-target");
  return (
    <div
      ref={setNodeRef}
      className={classes.join(" ")}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined}
      title={`#${player.nr} ${player.name} (${player.position})${player.distracted ? ", distracted: no tackle zone" : ""}`}
      onClick={props.onClick}
      onMouseEnter={() => props.onHover(player.id)}
      onMouseLeave={() => props.onHover(null)}
      // dnd-kit marks disabled draggables aria-disabled, which would hide clickable tokens from assistive tech.
      {...(props.draggable ? { ...listeners, ...attributes } : props.selectable ? { role: "button", tabIndex: 0 } : {})}
    >
      {icon ? <img src={icon} alt="" draggable={false} /> : <span className="bb-player-fallback">{player.nr}</span>}
      {player.status !== "standing" && (
        <img className="bb-status" src={`${assets}/player_status/${player.status}.gif`} alt={player.status} draggable={false} />
      )}
      {props.hasBall && <img className="bb-held-ball" src={`${assets}/ball/sball_30x30.png`} alt="ball" draggable={false} />}
      {props.blockDice !== undefined && (
        <span className={`bb-dice-badge${props.blockDice < 0 ? " bb-defender-picks" : ""}`}>{diceLabel(props.blockDice)}</span>
      )}
      {props.foulAssists !== undefined && (
        <span className="bb-dice-badge bb-foul-badge" title="Armour roll modifier from foul assists">
          {signed(props.foulAssists)}
        </span>
      )}
    </div>
  );
}

/** Declare an action for a player, next to it on the pitch: actions not available now are disabled. */
function ActionMenu(props: {
  player: PlayerState;
  available: PlayerActionType[];
  onPick(action: PlayerActionType): void;
  onClose(): void;
}) {
  const { player } = props;
  if (!isOnPitch(player)) return null;
  // The board is a row: home dugout, pitch, away dugout.
  const left = Math.min(DUGOUT_WIDTH + (player.at.x + 1) * SQUARE_SIZE + 4, DUGOUT_WIDTH + (PITCH_WIDTH - MENU_COLUMNS) * SQUARE_SIZE);
  const top = Math.min(player.at.y, PITCH_HEIGHT - MENU_ROWS) * SQUARE_SIZE;
  return (
    <div className="bb-action-menu" style={{ left, top }}>
      <div className="bb-action-menu-title">
        #{player.nr} {player.name}
      </div>
      {(Object.keys(ACTION_NAMES) as PlayerActionType[]).map((action) => (
        <button key={action} disabled={!props.available.includes(action)} onClick={() => props.onPick(action)}>
          {ACTION_NAMES[action]}
        </button>
      ))}
      <button className="bb-link" onClick={props.onClose}>
        Cancel
      </button>
    </div>
  );
}
