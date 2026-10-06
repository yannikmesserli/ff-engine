# @bb/data

Static data for the engine: BB2025 rosters, example teams, setup formations, the zod schemas that validate them, and
`resolveTeam()` which turns a team file into the engine's `TeamSetup`.

```ts
import { exampleTeams, formationActions, formations, resolveTeam, rosters } from "@bb/data";

const home = resolveTeam(exampleTeams["human"]); // throws TeamError on an invalid team
const actions = formationActions(state, "home", formations["def_spread"]!); // PLACE_PLAYER actions
```

## Contents

| Export | What |
|---|---|
| `rosters` | The 30 BB2025 rosters from FUMBBL ruleset 2014 (`src/generated/rosters.json`), star players excluded. |
| `exampleTeams` | 13 example teams (`src/teams.json`), keyed by name (`"human"`, `"wood-elf"`...). |
| `formations` | Setups in a text format (`src/formations.json`: `def_boat`, `def_spread`, `def_zone`, `off_line`, `off_wedge`). |
| `formationActions(state, side, formation)` | `PLACE_PLAYER` actions that clear a side's half and set up a formation. |
| `resolveTeam(json, rosters?)` | Validates a team file against its roster and merges in position stats. Throws `TeamError`. |
| `TeamFileSchema`, `RosterSchema` | zod schemas (and the `TeamFile`, `Roster` types). |
| `SKILL_DESCRIPTIONS`, `skillDescription(skill)` | Short BB2025 descriptions of every skill and trait (our own wording), for tooltips; `skillDescription("Loner(4)")` fills in the value. |

`src/generated/rosters.json` is written by `pnpm fetch-rosters`; do not edit it by hand. `src/teams.json` and
`src/formations.json` are plain data files: edit them directly (the tests validate every team against its roster).

## Team file format

A BB2025 team: its roster, staff and players. `roster` is a roster name and `position` a position title from that
roster (see `rosters`). Only `name`, `roster`, `rerolls` and the players' `number`, `name` and `position` are required.

```json
{
  "name": "Reikland Reavers",
  "roster": "Human",
  "rerolls": 3,
  "apothecary": true,
  "assistantCoaches": 1,
  "cheerleaders": 0,
  "dedicatedFans": 2,
  "players": [
    {
      "number": 1,
      "name": "Griff",
      "position": "Human Blitzer",
      "skills": ["Sprint"],
      "improvements": { "ma": 1, "ag": 1 },
      "injuries": ["av", "niggling"],
      "missNextGame": false
    },
    { "number": 2, "name": "Bob", "position": "Human Lineman" }
  ]
}
```

- Team: `apothecary` (default `false`), `assistantCoaches` and `cheerleaders` (default 0), `dedicatedFans` 1-7
  (default 1), 1 to 16 players with unique positive `number`s.
- `skills`: skills gained on top of the position's skills.
- `improvements`: characteristic improvements per characteristic (`ma`, `st`, `ag`, `pa`, `av`). Each one is +1 to MA,
  ST or AV; for AG and PA, which are target numbers, each one lowers the target by 1 (AG 3+ becomes 2+).
- `injuries`: lasting injuries, one entry per -1 to a characteristic (AG and PA targets go up by 1), or `"niggling"`
  for a Niggling Injury (+1 to the player's casualty rolls).
- `missNextGame`: the player is left out when the team is resolved.
- Unknown fields are rejected, so typos don't pass silently.
- `resolveTeam` also checks the roster exists, re-rolls are within `maxRerolls`, the roster may hire an apothecary,
  position quantities, the Big Guy limit and Insignificant (no more such players than others) are respected, and
  clamps characteristics to the BB2025 limits (MA 1-9, ST 1-8, AG/PA 1-6, AV 3-11). A team with a Plague Ridden player
  gets its roster's lineman position as `raisePosition`, the position a killed opponent joins the team as.

## Formations

A text format: 15 rows by 13 columns describing the home (left) half, the last column being the line of
scrimmage. `-` is empty; a letter asks for a kind of player, picked in this order:
`S` strongest (Block counts, Sure Hands against), `s` Sure Hands, `p` Pass, `b` Block, `c` Catch, `m` most MA,
`a` best AG, `v` best AV, `d` Dodge, `0` fewest skills, `x` Block, otherwise not a Pass/Catch player. The line of
scrimmage is filled first. The away side is mirrored.

## Regenerating the rosters

Run from `frontend/`.

- `pnpm fetch-rosters` (`scripts/fetch-rosters.ts`, needs network): reads the roster list of
  <https://fumbbl.com/api/ruleset/get/2014>, keeps the enabled rosters except "Test roster", downloads each one from
  `https://fumbbl.com/xml:roster?id=<id>` (300 ms apart), drops star players, converts skill categories to
  letters (G, A, S, P, M, D) and valued skills to `"Loner(4)"`, validates the result with `RosterSchema` and writes
  `src/generated/rosters.json` sorted by name.

## Licensing

The roster data comes from FUMBBL. Check FUMBBL's terms before redistributing it.
