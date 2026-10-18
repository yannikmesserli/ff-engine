# ff-engine

A browser-only fantasy football engine and game component, following the **BB2025** rules. MIT licensed (`LICENSE`).

## What this project is

An open-source rules engine, plus what it takes to try it. It is not a ready-to-host game: it comes without artwork,
and its apps are for testing.

- **The engine** (`@ff-engine/engine`): the product. The BB2025 rules as a pure TypeScript library, with no UI: a
  serializable `GameState`, every decision and die an explicit action, the legal actions offered at every step. A
  server or a client can run it.
- **The data** (`@ff-engine/data`): rosters, star players and the team file format the engine plays with (`resolveTeam`).
- **The board** (`@ff-engine/board-ui`): a React component that plays a game with the engine. It renders the engine's state
  and turns clicks into actions; it holds no rules.
- **The artwork, which you bring yourself**: no image is included or ever committed. The board draws player sprites
  and team logos from a `BoardArtwork` you pass in (numbered discs without one), and the pitch, dice and ball from an
  image folder (`assetsUrl`). For testing, `pnpm fetch-artwork` downloads FUMBBL's sprites and logos (see "Assets").
- **For testing only**: the playground (hot-seat and online games), the relay that links two browsers, and the
  scenarios app (prepared positions to try a rule). They exist to try the engine, not to host games for others.

**Online games cannot be trusted: cheating is easy.** Both browsers run the engine and the relay only forwards
their actions, so nothing checks a player. The home browser picks the dice seed, so it can work out every roll in
advance; either player can send any dice values (physical dice entry is a legal action); and team files are only
checked for format, not for how the team was built (any player can be given any skill). A trustworthy game needs a
server that runs the engine itself, keeps the RNG and the teams, and accepts only its players' own decisions.

```
pnpm install
pnpm dev          # playground at http://localhost:5173, with the relay for online games on :8787
pnpm scenarios    # prepared positions to try a rule in the browser, on http://localhost:5174
pnpm test         # engine + data tests (incl. full random games)
pnpm typecheck
pnpm fetch-rosters    # download the BB2025 rosters from FUMBBL (ruleset 2014) into packages/data/src/generated
pnpm fetch-artwork    # for testing only: FUMBBL's player sprites and team logos (not ours: never commit them)
```

## Packages

| Package                                     | What                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/engine` (`@ff-engine/engine`)     | Pure TypeScript rules engine, no UI. Serializable `GameState`, seeded RNG.                                          |
| `packages/data` (`@ff-engine/data`)         | BB2025 rosters (from FUMBBL), example teams and formations, zod schemas, `resolveTeam()`.                           |
| `packages/board-ui` (`@ff-engine/board-ui`) | React `<FantasyFootballGame home={teamJson} away={teamJson} />` component.                                          |
| `apps/playground`                           | For testing: Vite app hosting the component, online games through the relay, or hot-seat.                           |
| `apps/relay`                                | For testing: Node WebSocket relay for online games, forwarding each player's actions, storing nothing.              |
| `apps/scenarios`                            | For testing: Vite app starting games from prepared positions (teams plus the actions leading there), to try a rule. |

Each package has its own README (engine model and how to add a rule, data formats and scripts, UI file map).
`AGENTS.md` holds the conventions for coding agents, and `.claude/skills/` has the workflows for adding a rule and running
the playground.

## Engine model

```ts
const state = createGame(resolveTeam(homeJson), resolveTeam(awayJson), {
  seed: 42,
});
getAvailableActions(state); // [{ type: "ROLL", dice: [{ kind: "d3", count: 2 }], reason: "Fan factor (home, away)", ... }]
const { state: next, events } = step(state, { type: "ROLL" });
```

- Rules run as a **procedure stack** . Each procedure (`Turn`, `MoveStep`,
  `Check`, `KnockDown`, `Bounce`...) is plain data on `state.stack`; its behaviour lives in a handler in
  `engine/src/procedures/`. A handler either finishes, pushes sub-procedures, or waits for an action.
- Every die is an explicit `ROLL` action. `{ type: "ROLL" }` uses the seeded RNG; `{ type: "ROLL", values: [4] }` lets a
  coach enter physical dice (and makes tests deterministic).
- `step` is pure (Immer), so undo, replays and saves are just keeping old states.

The playground accepts `?seed=42` to replay the same dice.

Conventions: home on the left (scores at x=25), d8 directions clockwise from north (1 = N).

## Data sources

- Rosters: FUMBBL's BB2025 ruleset (`https://fumbbl.com/api/ruleset/get/2014`, `xml:roster?id=...`). Check FUMBBL's
  terms before redistributing. The roster data also holds the paths of FUMBBL's artwork, not the images.

## Assets

Board graphics are not included, and no image may be committed (`.gitignore` refuses image files). The playground
serves `apps/playground/public/` (git-ignored), which must contain an `img/` folder for the pitch, dice, ball and
status overlays; see `packages/board-ui/README.md` for the expected layout. To test with player sprites and team
logos, `pnpm fetch-artwork` downloads FUMBBL's into `apps/playground/public/fumbbl/`. FUMBBL's artwork is not part of this project and does not belong to its authors: the download is for testing the
engine only. Do not commit, publish or ship it, and ask FUMBBL (https://fumbbl.com) for any other use.

## Licence

MIT (`LICENSE`), for the code and documentation of this repository. It does not cover FUMBBL's data or artwork (see
"Data sources" and "Assets"). Blood Bowl is a trademark of Games Workshop; this is an unofficial project, not
endorsed by Games Workshop or FUMBBL.
