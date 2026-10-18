# playground

Vite app hosting `<BloodBowlGame>` from `@ff-engine/board-ui`: online games between two browsers, or hot-seat.

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
or home before the kick-off). Nothing is saved: if a player reloads the page or leaves, the game is over.

## Hot-seat

`?local` plays both teams on this computer. Pick the home and away teams; "New game" restarts with the current
teams. The team pickers and "New game" are disabled while a game is in progress (from the first roll until the game
ends; undoing back to the start enables them again).

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
