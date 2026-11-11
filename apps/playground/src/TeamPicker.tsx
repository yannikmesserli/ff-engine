import { useEffect, useRef, useState } from "react";
import { TeamBuilder } from "@ff-engine/board-ui";
import { exampleTeams, resolveTeam } from "@ff-engine/data";

const TEAM_KEYS = Object.keys(exampleTeams);

/** Why a team file cannot be played, or null when it is valid. */
export function teamError(team: unknown): string | null {
  try {
    resolveTeam(team);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * `<TeamBuilder>` in a modal dialog: focus moves inside, the page behind is inert, Escape or a click outside closes it,
 * and focus goes back to the button that opened it.
 */
function BuilderDialog(props: { label: string; initial: unknown; onDone(team: unknown): void; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  // Closing goes through dialog.close() (which puts focus back) and its close event, never through an effect cleanup:
  // StrictMode runs cleanups once on mount, and the close event would then unmount the dialog right away.
  useEffect(() => {
    if (!ref.current!.open) ref.current!.showModal();
  }, []);
  const close = () => ref.current?.close();
  return (
    <dialog ref={ref} className="pg-modal" aria-label={props.label} onClose={props.onClose} onClick={(e) => e.target === e.currentTarget && close()}>
      <TeamBuilder
        initial={props.initial}
        onDone={(team) => {
          props.onDone(team);
          close();
        }}
        onCancel={close}
      />
    </dialog>
  );
}

/** Pick an example team, build a new one, load a team JSON file, or paste one (format in packages/data/README.md). */
export function TeamPicker(props: { label: string; value: unknown; disabled?: boolean; onChange(team: unknown): void }) {
  const key = TEAM_KEYS.find((k) => exampleTeams[k] === props.value) ?? "";
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const usePasted = () => {
    try {
      props.onChange(JSON.parse(text));
      setPasting(false);
      setError(null);
    } catch (e) {
      setError(`Not valid JSON: ${(e as Error).message}`);
    }
  };
  return (
    <div className="pg-picker">
      <label>
        {props.label}{" "}
        <select value={key} disabled={props.disabled} onChange={(e) => props.onChange(exampleTeams[e.target.value])}>
          {!key && <option value="">(custom team)</option>}
          {TEAM_KEYS.map((k) => (
            <option key={k} value={k}>
              {exampleTeams[k]!.name}
            </option>
          ))}
        </select>
      </label>
      <button className="pg-link" disabled={props.disabled} onClick={() => setBuilding(true)}>
        {key ? "Build a team" : "Edit team"}
      </button>
      <input
        type="file"
        accept="application/json"
        disabled={props.disabled}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) props.onChange(JSON.parse(await file.text()));
        }}
      />
      <button className="pg-link" disabled={props.disabled} onClick={() => setPasting(!pasting)}>
        {pasting ? "Cancel" : "Paste JSON"}
      </button>
      {building && (
        <BuilderDialog
          label={`${props.label} team builder`}
          initial={key ? undefined : props.value}
          onDone={props.onChange}
          onClose={() => setBuilding(false)}
        />
      )}
      {pasting && (
        <div className="pg-paste">
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "name": "...", "roster": "...", ... }' rows={8} />
          <button onClick={usePasted}>Use this team</button>
          {error && <div className="pg-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
