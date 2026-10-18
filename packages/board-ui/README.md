# @ff-engine/board-ui

React component that plays a complete hot-seat BB2025 Blood Bowl game in the browser: scoreboard, pitch with both
dugouts, decision panel, last roll with undo, player card (hovered, or pinned by clicking a player; skills have
description tooltips) and game log. All rules come from `@ff-engine/engine`; this
package only renders the engine's state and turns clicks into engine actions.

It comes without artwork: bring your own player sprites and team logos (`artwork`, see "Artwork") and image folder
(`assetsUrl`, see "Assets"). Online play (`online`) runs the engine in each browser and trusts both players: fine for
testing, not for games that must be fair (see "What this project is" in the main README).

## Usage

```tsx
import { BloodBowlGame } from "@ff-engine/board-ui";

<BloodBowlGame home={teamJson} away={teamJson} />;
```

| Prop | Type | |
|---|---|---|
| `home`, `away` | `unknown` | Team files in `@ff-engine/data`'s format (see `packages/data/README.md`), validated by `resolveTeam()`. Invalid teams render the error message. |
| `assetsUrl` | `string` | Base URL of the image folder (pitch, dice, ball, status overlays). Default `"/img"`. |
| `artwork` | `BoardArtwork` | Player sprites and team logos (see "Artwork"). None by default: numbered discs, no logos. |
| `seed` | `number` | RNG seed, to replay the same dice. Random when omitted. |
| `actions` | `Action[]` | Applied right after the game is created (`applyActions`), to start from a prepared position (`apps/scenarios`). Undo stops there; an illegal action renders the error message. |
| `onChange` | `(state: GameState) => void` | Called with the new state after every successful action. |
| `online` | `OnlineControl` | Online play: `{ side, actions, send }`. The component only offers `side`'s decisions (`decider()`), sends actions with `send` instead of applying them, and plays the batches in `actions` (both players', in the relay's order). No undo. |

Changing `home`, `away`, `seed` or `actions` starts a new game. The stylesheet (`styles.css`, all classes prefixed `bb-`) is
imported by the component.

## How it drives the engine

```
state ──getAvailableActions──▶ templates ──Board / ActionPanel──▶ dispatch(action) ──step──▶ next state
```

1. `Game` (in `BloodBowlGame.tsx`) keeps the history of `GameState`s; the current state is the last one, and Undo pops
   it.
2. `getAvailableActions(state)` returns the **action templates**: what the current decision maker may do (`MOVE` with
   its squares and rolls, `BLOCK` with targets and dice, `ROLL` with the dice to roll...). The UI renders only from
   these and never re-implements rules.
3. `Board` turns square and player clicks (and setup drags) into actions; `ActionPanel` shows the prompt and the
   buttons for everything else. The board also draws `flightMarkers(state)`: a kicked or thrown ball or bomb where it
   was aimed (dashed ring, it may still deviate or scatter) and where it comes down (solid ring), a bomb held by a
   player who must throw it again, and an exploding bomb. While a d8 roll is due (a bounce, the kick-off deviation, a
   scatter), the squares around `scatterOrigin(state)` show the d8 number that moves the ball (or player) there.
   Several scatters (an inaccurate pass, a team-mate throw, a gust of wind) are rolled one die at a time: the ball is
   drawn where each die left it, and the next die's numbers around that square. A loose
   ball that is not settled yet (`ballUnsettled`: a catch, Diving Catch, bounce or Safe Pair of Hands is pending) is
   drawn half transparent.
4. `dispatch(...actions)` applies them with `step` as a single undo entry. An `IllegalActionError` is shown in the
   error panel instead of crashing. With "Auto-roll dice", a lone `ROLL` template is dispatched after a short delay.

## Files

| File | What |
|---|---|
| `src/index.ts` | Public exports: `BloodBowlGame`, `decider`, `BloodBowlGameProps` and `OnlineControl`. |
| `src/BloodBowlGame.tsx` | Game creation, state history, `dispatch`, auto-roll; scoreboard, last roll, player card, log. |
| `src/Board.tsx` | Pitch, dugouts, player tokens, square highlights, setup drag and drop (dnd-kit), player action menu. |
| `src/ActionPanel.tsx` | Prompt and buttons per template: coin, kick/receive, dice (or physical dice entry), re-rolls, block dice, setup formations, end turn... |
| `src/describe.ts` | Display names and the game log text of every engine event. |
| `src/Dice.tsx` | Dice faces and rolls. |
| `src/artwork.ts` | `BoardArtwork`, FUMBBL's artwork (`fumbblArtwork`, `loadDownloadedArtwork`, `useDownloadedArtwork`), sprite CSS. |
| `src/templates.ts` | `findTemplate`: the available template of a type, narrowed. |
| `src/styles.css` | All styles; `--bb-square` must match `SQUARE_SIZE` in `Board.tsx`. |

## Assets

Graphics are not included. Images are loaded from `assetsUrl` with this layout:

| Path | What |
|---|---|
| `arenas/pitch/nice-26x15.jpg` | Pitch background (26 x 15 squares). |
| `dice/<1-6>.png`, `dice/d8-<1-8>.png`, `dice/<block face>.png` | Dice faces (block faces as in `BLOCK_FACES`). |
| `ball/sball_30x30.png`, `ball/sbomb_30x30.png` | The ball, and a bomb. |
| `player_status/<prone\|stunned>.gif` | Status overlays. |

## Artwork

Player sprites and team logos come from the `artwork` prop, a `BoardArtwork`: `sprites(roster, player)` returns a
sprite sheet (four columns: red, red moving, blue, blue moving; `size` rows, one look each) and `logo(roster)` a logo
URL. Home players are drawn in blue and away players in red, the moving square when active, in the row picked by
their number. Without artwork (or for a position it does not know), players are numbered discs and logos are left out.

`fumbblArtwork(url)` reads FUMBBL's sheets and logos from the paths in the roster data (`@ff-engine/data`, `artwork` and
`logo`): `fumbblArtwork((path) => artworkBase + path)` loads them from FUMBBL's image server, and
`useDownloadedArtwork(base)` from copies downloaded for testing with `pnpm fetch-artwork` (see
`apps/playground/README.md`). FUMBBL's artwork is not part of this project and does not belong to its authors: the download is for testing the
engine only. Do not commit, publish or ship it, and ask FUMBBL (https://fumbbl.com) for any other use.

## Adding UI for a new action template

1. Find the template and action shapes in `packages/engine/src/types.ts` (`ActionTemplate`, `Action`).
2. Board interaction (clicking a player or square): read it with `findTemplate(templates, "TYPE")` in `Board`, add
   its players to `selectable` or its squares to `targets`, and dispatch from `clickPlayer` / `clickSquare`. Mind the
   order of those `if` chains when several templates are offered at once.
3. Buttons: add the case to the `.bb-buttons` block in `ActionPanel`.
4. Add a prompt to `PROMPTS` in `ActionPanel.tsx` (that also makes it a candidate main template), and a log line for
   any new event in `describeEvent` (`describe.ts`; the `switch` is exhaustive, so typecheck tells you).
5. Check it in the playground (`pnpm dev`).
