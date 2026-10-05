# playground

Vite app hosting `<BloodBowlGame>` from `@bb/board-ui`.

```
pnpm dev      # from frontend/: http://localhost:5173
pnpm build    # typecheck + production build
```

Pick the home and away teams from `@bb/data`'s example teams, or load any team JSON file (format in
`packages/data/README.md`). "New game" restarts with the current teams. The team pickers and "New game" are disabled
while a game is in progress (from the first roll until the game ends; undoing back to the start enables them again).

## Query parameters

- `?seed=42`: seeds the dice of the first game, to replay it (e.g. to reproduce a bug). Non-numeric values are ignored.
  Games started with "New game" use random seeds.

## Assets

Graphics are not included. Vite serves `public/` (git-ignored) at the site root, and the component loads its images
from `/img/...`, so put them in `public/img/` (layout in `packages/board-ui/README.md`). A symlink to an existing
image folder works.
