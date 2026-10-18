# @bb/data

Static data for the engine: BB2025 rosters, example teams, setup formations, the zod schemas that validate them, and
`resolveTeam()` which turns a team file into the engine's `TeamSetup`.

The rosters and star players are downloaded from FUMBBL (`pnpm fetch-rosters`); they hold the paths of FUMBBL's
artwork, never the images. `resolveTeam` checks a team file's format and limits, not how the team was built over its
games: a server running league games should check advancements itself.

```ts
import { exampleTeams, formationActions, formations, resolveTeam, rosters } from "@bb/data";

const home = resolveTeam(exampleTeams["human"]); // throws TeamError on an invalid team
const actions = formationActions(state, "home", formations["def_spread"]!); // PLACE_PLAYER actions
```

## Contents

| Export | What |
|---|---|
| `rosters` | The 30 BB2025 rosters from FUMBBL ruleset 2014 (`src/generated/rosters.json`); `stars` names the star players each may hire. |
| `starPlayers` | The BB2025 star players from the same rosters: characteristics, skills and special rules, cost, and the partner a pair is hired with. |
| `artworkBase` | FUMBBL's image server. Rosters have a `logo` path, positions and star players an `artwork` (`sprites` sheet with its `size`, `portrait`): paths only, the images are not included. |
| `exampleTeams` | 13 example teams (`src/teams.json`), keyed by name (`"human"`, `"wood-elf"`...). |
| `formations` | Setups in a text format (`src/formations.json`: `def_boat`, `def_spread`, `def_zone`, `off_line`, `off_wedge`). |
| `formationActions(state, side, formation)` | `PLACE_PLAYER` actions that clear a side's half and set up a formation. |
| `INDUCEMENT_RULES` | BB2025 inducement limits, required special rules and costs, by inducement id. |
| `resolveTeam(json, rosters?)` | Validates a team file against its roster and merges in position stats, the Current Team Value, treasury and the shop's prices. Throws `TeamError`. |
| `teamValue(json, rosters?)` | The Current Team Value of a team file: players available and their advancements, journeymen, re-rolls and staff. |
| `teamAfterGame(json, state, side)` | The team file after a finished game: Star Player Points, casualties, Getting Even, raised players, winnings, Dedicated Fans. |
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
- `captain`: the number of the player who is Team Captain (gains Pro, unless they have it, and the Team Captain
  trait; neither counts as an advancement). `teamAfterGame` drops it when that player is gone.
- `specialRules`: the team's special rules as FUMBBL names them (`SPECIAL_RULES`: "Bribery and Corruption", "Favoured
  of Nurgle", "Low Cost Linemen", "Masters of Undeath"...). Some inducements depend on them.
- `inducements`: what the team bought for this game, by id (`{ "bribes": 2, "teamMascot": 1 }`). The ids, BB2025
  limits, special rules needed and costs are in `INDUCEMENT_RULES`: `bribes` (3, or 6 with Bribery and Corruption),
  `teamMascot` (1), `partTimeCoaches` (3, at most 9 coaches in all), `tempCheerleaders` (4, at most 16 cheerleaders),
  `blitzersBestKegs` (2), `halflingMasterChef` (1), `riotousRookies` (1, Low Cost Linemen), `plagueDoctor` (1,
  Favoured of Nurgle), `mortuaryAssistant` (1, Masters of Undeath), `weatherMage` (1), `biasedReferee` (1), `wizard`
  (1), `josefBugman` (1, the Infamous Coaching Staff), `wanderingApothecaries` (2, rosters that may have an
  apothecary), `prayers` (3). The team file says what was bought, not how it
  was paid for; with the engine's `shop` option the inducements are bought in the game instead (then the team file
  must not list any).
- `starPlayers`: the star players hired for this game, by name (from the roster's `stars`): at most 2, a pair hired
  together (Grak and Crumbleberry) counting as one. `mercenaries`: `{ "position": "Human Lineman", "skill": "Block" }`
  per mercenary, from any position of the roster with room left (Big Guys within the roster's limit), with Loner (4+)
  and an optional extra primary skill. Both count towards the 16 players; with the engine's `shop` option they are
  hired in the game instead. Neither comes back in `teamAfterGame`.
- `journeymen` (default `true`): a team with fewer than 11 players left for the game gets journeymen up to 11, from
  the roster's 0-12 or 0-16 lineman position, with Loner (4+), numbered with the smallest free numbers. `false` takes
  none; a position title picks the position when the roster has more than one (Shambling Undead: Skeleton or Zombie
  Lineman).
- `skills`: skills gained on top of the position's skills.
- `hatred`: keywords the player gained Hatred against by Getting Even (`["orc"]`, each one a `Hatred(orc)` skill);
  `teamAfterGame` adds those of the game. They are neither advancements nor counted in the team value.
- `improvements`: characteristic improvements per characteristic (`ma`, `st`, `ag`, `pa`, `av`). Each one is +1 to MA,
  ST or AV; for AG and PA, which are target numbers, each one lowers the target by 1 (AG 3+ becomes 2+).
- `injuries`: lasting injuries, one entry per -1 to a characteristic (AG and PA targets go up by 1), or `"niggling"`
  for a Niggling Injury (+1 to the player's casualty rolls).
- `missNextGame`: the player is left out when the team is resolved.
- `spp` (default 0): the player's unspent Star Player Points; `treasury` (default 0): the team's gold pieces, which the
  pre-game shop may spend. Both grow with `teamAfterGame` (less what the shop took from the treasury); spending them
  between games is not done yet.
- A player's advancements (for player loss after a concession) are their gained `skills` plus their `improvements`.
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
  `https://fumbbl.com/xml:roster?id=<id>` (300 ms apart), moves star players to their own list (each roster names those it may hire), converts skill categories to
  letters (G, A, S, P, M, D) and valued skills to `"Loner(4)"`, validates the result with `RosterSchema` and writes
  `src/generated/rosters.json` sorted by name.

## Licensing

The roster data comes from FUMBBL. Check FUMBBL's terms before redistributing it.
