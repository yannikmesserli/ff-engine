---
name: add-rule
description: Implement a BB2025 Blood Bowl rule, action, kick-off event or player skill (Dirty Player, Mighty Blow...) in the frontend engine (packages/engine), with tests and UI. Use when asked to add or fix a rule.
---

# Add a BB2025 rule to the engine

## 1. Pin down the rule

Write down the decision points before coding: who chooses what, which dice are rolled and with which modifiers, which
re-rolls apply, and when it is a turnover. BB2025 only; older editions differ.

## 2. Implement in `packages/engine`

Read `packages/engine/README.md`. Typically:

1. `src/types.ts`: add the procedure to the `Procedure` union (with a `stage` field for multi-step flows), the
   player `Action`s, the `ActionTemplate`s offered while waiting, and the `GameEvent`s.
2. `src/procedures/<area>.ts`: the `Handler` with `step` and `actions`. One die roll = one `ctx.roll(action, dice, reason)`
   while the stage waits for a `ROLL`. The JSDoc states the rule in game terms.
3. Register the handler in `src/procedures/index.ts`; export any helper the UI needs from `src/index.ts`.
4. Skills: `hasSkill(player, "Exact Roster Name")` from `src/skills.ts`. Check the spelling in
   `packages/data/src/generated/rosters.json`.

## 3. Test

- Add a `describe` block in `src/engine.test.ts` with fixed dice (`roll(...)`). Cover each decision point from step 1.
- If you added an action template, handle it in `randomAction` in `packages/data/src/data.test.ts`, so the 40 random
  games keep finishing.
- `pnpm typecheck && pnpm test` from `frontend/`.

## 4. UI and docs

- `packages/board-ui`: prompt text in `ActionPanel.tsx` `PROMPTS`, buttons or board clicks for the new templates, and
  the log message for new events in `describe.ts`.
- Update the "Implemented so far" / "Not yet" lists in `frontend/README.md`.
