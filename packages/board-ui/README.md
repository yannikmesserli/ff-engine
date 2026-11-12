# @ff-engine/board-ui

React component that plays a complete hot-seat BB2025 fantasy football game in the browser: scoreboard, pitch with both
dugouts, decision panel, last roll with undo, player card (hovered, or pinned by clicking a player; skills have
description tooltips), team details (coach, team value, staff, re-rolls, inducements) on each logo and game log. Esc
steps back: it closes the action menu or stops aiming, then takes back a declared action that has not started yet
(clicking another player who can act does the same and opens their menu). All rules come from `@ff-engine/engine`; this
package only renders the engine's state and turns clicks into engine actions.

It comes without artwork: bring your own player sprites, team logos and pitches (`artwork`, see "Artwork") and image
folder (`assetsUrl`, see "Assets"). The dice are drawn in code (SVG) and need neither. Online play (`online`) runs the engine in each browser and trusts both players: fine for
testing, not for games that must be fair (see "What this project is" in the main README).

## Usage

```tsx
import { FantasyFootballGame } from "@ff-engine/board-ui";

<FantasyFootballGame home={teamJson} away={teamJson} />;
```

| Prop | Type | |
|---|---|---|
| `home`, `away` | `unknown` | Team files in `@ff-engine/data`'s format (see `packages/data/README.md`), validated by `resolveTeam()`. Invalid teams render the error message. |
| `assetsUrl` | `string` | Base URL of the image folder (ball, fallback pitch). Default `"/img"`. |
| `artwork` | `BoardArtwork` | Player sprites, team logos and pitches (see "Artwork"). None by default: numbered discs, no logos, the image folder's pitch. |
| `seed` | `number` | RNG seed, to replay the same dice. Random when omitted. |
| `actions` | `Action[]` | Applied right after the game is created (`applyActions`), to start from a prepared position (`apps/scenarios`). Undo stops there; an illegal action renders the error message. |
| `onChange` | `(state: GameState) => void` | Called with the new state after every successful action (and once at the start when resuming). |
| `onActions` | `(batches: Action[][]) => void` | Hot-seat: called with every batch of actions played since the start (one per undo step) after each action and undo, to save the game. |
| `resume` | `Action[][]` | Hot-seat: batches to replay when the game starts, as reported by `onActions`, to resume a saved game. Each stays an undo step. Read once, when the game starts. |
| `online` | `OnlineControl` | Online play: `{ side, actions, send }`. The component only offers `side`'s decisions (`decider()`), sends actions with `send` instead of applying them, and plays the batches in `actions` (both players', in the relay's order). No undo. |

Changing `home`, `away`, `seed` or `actions` starts a new game. The stylesheet (`styles.css`, all classes prefixed `bb-`) is
imported by the component.

## Team builder

`<TeamBuilder onDone={(team) => ...} />` drafts a new BB2025 team and hands back its team file, ready for `home` or
`away`. The coach picks a roster, adds players from its positions (within each position's quantity and the Big Guy
limit), names and numbers them, picks a Team Captain, and buys re-rolls, an apothecary, assistant coaches,
cheerleaders and Dedicated Fans. Running totals show what is left of the budget, and `creationErrors` from
`@ff-engine/data` lists what stops the team from being valid. The team can also be downloaded or copied as JSON.
The roster data does not say which special rules (league, "Favoured of...") each roster has, so the coach ticks them.

| Prop | Type | |
|---|---|---|
| `onDone` | `(team: TeamFileInput) => void` | Called by "Use this team" with the team file; the gold left over is its `treasury`. |
| `initial` | `unknown` | A team file to edit: its roster, staff and players' numbers, names and positions (advancements are dropped). |
| `budget` | `number` | Gold to draft with, editable in the form. Default 1,000,000. |
| `onCancel` | `() => void` | Shows a Cancel button. |

## How it drives the engine

```
state ──getAvailableActions──▶ templates ──Board / ActionPanel──▶ dispatch(action) ──step──▶ next state
```

1. `Game` (in `FantasyFootballGame.tsx`) keeps the history of `GameState`s; the current state is the last one, and Undo pops
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
| `src/index.ts` | Public exports: `FantasyFootballGame`, `decider`, `FantasyFootballGameProps`, `OnlineControl`, `TeamBuilder` and `TeamBuilderProps`. |
| `src/FantasyFootballGame.tsx` | Game creation, state history, `dispatch`, auto-roll; scoreboard, last roll, player card, log. |
| `src/Board.tsx` | Pitch, dugouts, player tokens, square highlights, setup drag and drop (dnd-kit), player action menu. |
| `src/ActionPanel.tsx` | Prompt and buttons per template: coin, kick/receive, dice (or physical dice entry), re-rolls, block dice, setup formations, end turn... |
| `src/describe.ts` | Display names and the game log text of every engine event. |
| `src/Dice.tsx` | Dice faces (drawn as SVG: d6 pips, d8 arrows, block dice with skulls and explosions) and rolls. |
| `src/artwork.ts` | `BoardArtwork`, FUMBBL's artwork (`fumbblArtwork`, `loadDownloadedArtwork`, `useDownloadedArtwork`), sprite CSS. |
| `src/templates.ts` | `findTemplate`: the available template of a type, narrowed. |
| `src/TeamBuilder.tsx` | `<TeamBuilder>`: drafts a new team file (see "Team builder"). |
| `src/styles.css` | All styles of the game; `--bb-square` must match `SQUARE_SIZE` in `Board.tsx`. |
| `src/team-builder.css` | Styles of `<TeamBuilder>` (classes prefixed `bb-tb-`). |

## Assets

Graphics are not included. Images are loaded from `assetsUrl` with this layout:

| Path | What |
|---|---|
| `arenas/pitch/<heat\|sunny\|nice\|rain\|blizzard>-26x15.jpg` | Pitch of each weather (26 x 15 squares), when the artwork has none. |
| `ball/sball_30x30.png`, `ball/sbomb_30x30.png` | The ball, and a bomb. Drawn in code (`BallIcon`) when missing. |

## Artwork

Player sprites and team logos come from the `artwork` prop, a `BoardArtwork`: `sprites(roster, player)` returns a
sprite sheet (four columns: red, red moving, blue, blue moving; `size` rows, one look each) and `logo(roster)` a logo
URL. Home players are drawn in blue and away players in red, the moving square when active, in the row picked by
their number. Without artwork (or for a position it does not know), players are numbered discs and logos are left out.
The optional `pitch(weather)` returns the pitch of the current weather: 26 x 15 squares inside a 1 px border (782 x 452
px), the border cropped. Without it, the pitch comes from the image folder.

`fumbblArtwork(url)` reads FUMBBL's sheets and logos from the paths in the roster data (`@ff-engine/data`, `artwork` and
`logo`): `fumbblArtwork((path) => artworkBase + path)` loads them from FUMBBL's image server, and
`useDownloadedArtwork(base)` from copies downloaded for testing with `pnpm fetch-artwork` (see
`apps/playground/README.md`), pitches included (FUMBBL serves those as a zip, so only the downloaded copies have them). FUMBBL's artwork is not part of this project and does not belong to its authors: the download is for testing the
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
