import { useState } from "react";
import { BloodBowlGame, useDownloadedArtwork } from "@ff-engine/board-ui";
import { SCENARIOS } from "./scenarios";

/** `?scenario=<id>` opens that scenario; the first one otherwise. */
const initialId = () => new URLSearchParams(location.search).get("scenario") ?? SCENARIOS[0]!.id;

/** A scenario picker, its instructions, and the game starting from the scenario's position. */
export function App() {
  // FUMBBL's artwork, if downloaded for testing (`pnpm fetch-artwork`, shared with the playground).
  const artwork = useDownloadedArtwork("/fumbbl");
  const [id, setId] = useState(initialId);
  // Bumped by "Restart" to start the scenario over.
  const [run, setRun] = useState(0);
  const scenario = SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0]!;
  const choose = (next: string) => {
    setId(next);
    history.replaceState(null, "", `?scenario=${next}`);
  };
  return (
    <main>
      <div className="sc-header">
        <select value={scenario.id} onChange={(e) => choose(e.target.value)}>
          {SCENARIOS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <button onClick={() => setRun(run + 1)}>Restart</button>
      </div>
      <ol className="sc-instructions">
        {scenario.instructions.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
      <BloodBowlGame key={`${scenario.id}-${run}`} artwork={artwork} home={scenario.home} away={scenario.away} seed={scenario.seed} shop={scenario.shop} actions={scenario.actions} />
    </main>
  );
}
