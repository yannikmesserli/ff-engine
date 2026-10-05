import { useState } from "react";
import { BloodBowlGame } from "@bb/board-ui";
import { exampleTeams } from "@bb/data";

const TEAM_KEYS = Object.keys(exampleTeams);

/** `?seed=42` replays the same dice for the first game (handy to reproduce a bug); anything non-numeric is ignored. */
const SEED = parseSeed(new URLSearchParams(location.search).get("seed"));

function parseSeed(param: string | null): number | undefined {
  const seed = param?.trim() ? Number(param) : NaN;
  return Number.isFinite(seed) ? seed : undefined;
}

/** Pick an example team, or load any team JSON file (format in packages/data/README.md). */
function TeamPicker(props: { label: string; value: unknown; onChange(team: unknown): void }) {
  const key = TEAM_KEYS.find((k) => exampleTeams[k] === props.value) ?? "";
  return (
    <label>
      {props.label}{" "}
      <select value={key} onChange={(e) => props.onChange(exampleTeams[e.target.value])}>
        {!key && <option value="">(custom file)</option>}
        {TEAM_KEYS.map((k) => (
          <option key={k} value={k}>
            {exampleTeams[k]!.name}
          </option>
        ))}
      </select>{" "}
      <input
        type="file"
        accept="application/json"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) props.onChange(JSON.parse(await file.text()));
        }}
      />
    </label>
  );
}

/** Two team pickers and a "New game" button above the game; each new game gets fresh random dice. */
export function App() {
  const [home, setHome] = useState<unknown>(exampleTeams["human"]);
  const [away, setAway] = useState<unknown>(exampleTeams["orc"]);
  const [gameId, setGameId] = useState(0);
  return (
    <main>
      <header>
        <TeamPicker label="Home" value={home} onChange={setHome} />
        <TeamPicker label="Away" value={away} onChange={setAway} />
        <button onClick={() => setGameId((n) => n + 1)}>New game</button>
      </header>
      <BloodBowlGame key={gameId} home={home} away={away} assetsUrl="/img" seed={gameId === 0 ? SEED : undefined} />
    </main>
  );
}
