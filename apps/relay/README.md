# relay

The backend of the playground's online games: a Node WebSocket relay (`ws`), with no database and nothing stored.

**For testing the engine only, and it cannot be trusted.** The relay knows no rules and checks nothing: it forwards
whatever a player sends. Either player can cheat: the home browser picks the dice seed (and can work out every roll),
any player can send any dice values, and team files are not checked against how the team was built. See "What this
project is" in the main README for what a trustworthy server would need.

```
pnpm dev               # from frontend/: the relay (watch mode) and the playground together
pnpm relay             # from frontend/: the relay alone, on PORT (default 8787)
```

- A browser connects to `ws://<host>/relay?game=<id>` (id: 4-32 lowercase letters and digits). The first one in a
  game plays home, the second away; a third is refused (HTTP 409). `&side=home` or `&side=away` asks for that side,
  to come back to it after a reload; it is refused (409) while that side is taken.
- Watchers: once home connected with `&watchers=1` (the creator's "Allow watchers"; away's is ignored), anyone else who connects
  while both sides are taken watches instead of being refused, and `&side=watcher` comes back as a watcher. Watchers
  get every player message and are told when a player comes or goes; the players are told how many watch. A watcher
  sends nothing but `{ type: "sync-request" }`, passed on to the players (at most once a second per watcher), who
  answer with a snapshot, since the relay has none.
- Every `{ type: "relay", data }` a player sends is forwarded, as is, to both players of the game, the sender
  included (and to its watchers). Both browsers therefore see the same messages in the same order, which keeps their games identical.
- Players are told when their opponent connects or leaves. A game is forgotten once everyone is gone: players
  who come back catch up from each other (see "Reloads and dropped connections" in `apps/playground/README.md`).
- The relay does not know the rules: `data` is whatever the playground sends (teams, then batches of actions).
- Message types are in `src/protocol.ts` (exported as `relay/protocol`).

## Running it on a server (for testing)

Only to let testers play each other, never as a public game service. `node src/main.ts` (Node 23.6+ runs the TypeScript directly). It also serves a built playground
(`apps/playground/dist`, or `STATIC_DIR`), so one process serves the app and the relay on one port. Behind HTTPS,
browsers connect with `wss://` automatically.
