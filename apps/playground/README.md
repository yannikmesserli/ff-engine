# playground

Vite app hosting `<FantasyFootballGame>` from `@ff-engine/board-ui`: online games between two browsers, or hot-seat.

**For testing the engine only**, not for hosting games for others. **Online games cannot be trusted: cheating is easy.** Both browsers run the engine and the relay only forwards
their actions, so nothing checks a player. The home browser picks the dice seed, so it can work out every roll in
advance; either player can send any dice values (physical dice entry is a legal action); and team files are only
checked for format, not for how the team was built (any player can be given any skill). A trustworthy game needs a
server that runs the engine itself, keeps the RNG and the teams, and accepts only its players' own decisions.

```
pnpm dev      # from frontend/: http://localhost:5173, plus the relay (apps/relay) on :8787
pnpm build    # typecheck + production build
```

## Online games

1. The first player opens the app and clicks "Create an online game": the URL becomes `?game=<id>`. They play home.
2. They send that link to the second player, who plays away.
3. Each picks an example team, loads a team JSON file or pastes one (format in `packages/data/README.md`), then
   clicks "Ready". The game starts when both are ready, with dice seeded by home.

Both browsers run the engine; only the actions travel, through the relay (`/relay`, proxied to `localhost:8787` in
dev). Each browser can only take its own side's decisions (rolls anyone could make go to the team whose turn it is,
or home before the kick-off).

### Reloads and dropped connections

Each tab saves its game in `sessionStorage` (`src/saved.ts`): its side, the teams, the seed and every batch of
actions. sessionStorage is per tab, so two tabs of one browser can play both sides. After a reload, or when the
connection drops (the relay restarts, the network blips), the page reconnects on its own and asks the relay for the
same side. While a player is away, the other sees a notice and can go on playing their decisions.

The relay stores nothing, so the browsers catch up with each other (`src/sync.ts`):

- Each batch of actions is sent with its position in the game. A browser appends a batch only if it is the next
  one. A lower position is a duplicate, or a batch sent at the same time as the one the relay passed first: both
  browsers drop it the same way. A higher position means batches were missed.
- When a player (re)connects, or sees a gap, both send a snapshot: the teams, home's seed and shop option, and every
  batch they have, in chunks small enough for the relay. Both settle on the same snapshot, taken whole: the longer
  list of batches of the same game; a started game over a lobby (a player who lost their tab and picked a team
  again); between two different started games, the one with more batches, then home's.
- After each (re)connection the board is paused (no decision, no auto-roll) until the opponent's snapshot has
  arrived, so a player never plays from a position the opponent has already left. A player who stays connected
  keeps playing; auto-roll picks up again when the pause ends.

A player who closed the tab (and lost its storage) can open the link again: they get the free side back and the
whole game from the opponent.

## Hot-seat

`?local` plays both teams on this computer. Pick the home and away teams; "New game" restarts with the current
teams. The team pickers and "New game" are disabled while a game is in progress (from the first roll until the game
ends; undoing back to the start enables them again). The game is saved in the tab, per URL (`?local` and each
`?seed=` keep their own): reloading resumes it, with its undo history.

## Query parameters

- `?game=<id>`: join an online game (4-32 lowercase letters and digits).
- `?local`: hot-seat game.
- `?seed=42`: hot-seat game whose first game uses these dice, to replay it (e.g. to reproduce a bug). Non-numeric
  values are ignored. Games started with "New game" use random seeds.

## Assets

Graphics are not included, and no image may be committed (`.gitignore` refuses image files). Vite serves `public/`
(git-ignored) at the site root, for this app and the scenarios app.

- Player sprites and team logos: `pnpm fetch-artwork` (`scripts/fetch-artwork.ts`) downloads FUMBBL's into
  `public/fumbbl/`, with a `manifest.json` the apps read (`useDownloadedArtwork("/fumbbl")`). Without them, players
  are numbered discs and teams have no logo. FUMBBL's artwork is not part of this project and does not belong to its authors: the download is for testing the engine only. Do not commit, publish or ship it, and ask FUMBBL (https://fumbbl.com) for any other use.
- The pitch, dice, ball and status overlays: loaded from `/img/...`, so put them in `public/img/` (layout in
  `packages/board-ui/README.md`). A symlink to an existing image folder works.
