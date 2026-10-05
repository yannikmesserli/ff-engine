# relay

The backend of online games: a Node WebSocket relay (`ws`), with no database and nothing stored.

```
pnpm dev               # from frontend/: the relay (watch mode) and the playground together
pnpm relay             # from frontend/: the relay alone, on PORT (default 8787)
```

- A browser connects to `ws://<host>/relay?game=<id>` (id: 4-32 lowercase letters and digits). The first one in a
  game plays home, the second away; a third is refused (HTTP 409).
- Every `{ type: "relay", data }` a player sends is forwarded, as is, to both players of the game, the sender
  included. Both browsers therefore see the same messages in the same order, which keeps their games identical.
- Players are told when their opponent connects or leaves. A game is forgotten once both players are gone.
- The relay does not know the rules: `data` is whatever the playground sends (teams, then batches of actions).
- Message types are in `src/protocol.ts` (exported as `relay/protocol`).

## Deploying

`node src/main.ts` (Node 23.6+ runs the TypeScript directly). It also serves a built playground
(`apps/playground/dist`, or `STATIC_DIR`), so one process serves the app and the relay on one port. Behind HTTPS,
browsers connect with `wss://` automatically.
