import { useId, useMemo, useState } from "react";
import { SPECIAL_RULES, TEAM_CREATION, TeamFileSchema, creationCost, creationErrors, draftTeam, rosters, skillDescription, teamFile, type TeamFileInput } from "@ff-engine/data";
import "./team-builder.css";

export interface TeamBuilderProps {
  /** A team file to start from (its roster, staff and players; advancements are dropped). A new team when omitted. */
  initial?: unknown;
  /** Gold to draft the team with. Default 1,000,000 (`TEAM_CREATION.budget`). */
  budget?: number;
  /** Called with the new team file, the gold left over as its treasury, when the coach clicks "Use this team". */
  onDone(team: TeamFileInput): void;
  /** Shows a Cancel button. */
  onCancel?(): void;
}

/** The team being drafted: what a new team file holds. */
type Draft = TeamFileInput & { players: Array<{ number: number; name: string; position: string }> };

const LEAGUES = 8; // the first SPECIAL_RULES are the leagues

/** A team file, converted from FUMBBL team JSON; null when that JSON is broken (a new draft then). */
function converted(initial: unknown): unknown {
  try {
    return teamFile(initial);
  } catch {
    return null;
  }
}

/** The fields of a team file a new team has: no advancements, injuries, hired players or inducements. */
function startingDraft(initial: unknown): Draft {
  const parsed = TeamFileSchema.safeParse(converted(initial));
  if (parsed.success && rosters.some((r) => r.name === parsed.data.roster)) {
    const t = parsed.data;
    return {
      name: t.name,
      ...(t.coach ? { coach: t.coach } : {}),
      roster: t.roster,
      rerolls: t.rerolls,
      apothecary: t.apothecary,
      assistantCoaches: t.assistantCoaches,
      cheerleaders: t.cheerleaders,
      dedicatedFans: Math.min(t.dedicatedFans, TEAM_CREATION.dedicatedFans.max),
      specialRules: t.specialRules,
      ...(t.captain !== undefined ? { captain: t.captain } : {}),
      players: t.players.map(({ number, name, position }) => ({ number, name, position })),
    };
  }
  return { name: "New Team", roster: rosters[0]!.name, rerolls: 0, apothecary: false, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1, specialRules: [], players: [] };
}

const k = (gp: number) => `${gp / 1000}k`;
const target = (n: number | null) => (n === null ? "-" : `${n}+`);

/** The smallest shirt number no player has. */
function freeNumber(players: Draft["players"]) {
  let nr = 1;
  while (players.some((p) => p.number === nr)) nr++;
  return nr;
}

/** A number with − and + buttons, between `min` and `max`; `label` names what it counts, for screen readers. */
function Stepper(props: { label: string; value: number; min: number; max: number; onChange(value: number): void }) {
  return (
    <span className="bb-tb-stepper">
      <button aria-label={`Fewer ${props.label.toLowerCase()}`} disabled={props.value <= props.min} onClick={() => props.onChange(props.value - 1)}>
        −
      </button>
      <span aria-live="polite">{props.value}</span>
      <button aria-label={`More ${props.label.toLowerCase()}`} disabled={props.value >= props.max} onClick={() => props.onChange(props.value + 1)}>
        +
      </button>
    </span>
  );
}

/** A position's skills, each with its description as a tooltip. */
const Skills = (props: { skills: string[] }) => (
  <>
    {props.skills.map((s, i) => (
      <span key={s} title={skillDescription(s) ?? undefined}>
        {s}
        {i < props.skills.length - 1 ? ", " : ""}
      </span>
    ))}
  </>
);

/**
 * Draft a new BB2025 team: pick a roster, buy players from its positions, re-rolls and sideline staff within the budget,
 * name the players and choose a Team Captain. Produces a team file in `@ff-engine/data`'s format, checked with
 * `creationErrors`.
 */
export function TeamBuilder(props: TeamBuilderProps) {
  const [draft, setDraft] = useState(() => startingDraft(props.initial));
  const [budget, setBudget] = useState(props.budget ?? TEAM_CREATION.budget);
  const [copied, setCopied] = useState(false);
  const captainGroup = useId();
  const roster = rosters.find((r) => r.name === draft.roster)!;
  const cost = creationCost(draft, roster);
  const errors = useMemo(() => creationErrors(draft, budget), [draft, budget]);
  const team = errors.length === 0 ? draftTeam(draft, budget) : undefined;
  const json = JSON.stringify(team ?? draft, null, 2);
  const update = (change: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...change }));
    setCopied(false);
  };
  const setPlayers = (players: Draft["players"]) => update({ players, ...(players.some((p) => p.number === draft.captain) ? {} : { captain: undefined }) });
  const bigGuys = draft.players.filter((p) => roster.positions.find((pos) => pos.title === p.position)?.type === "Big Guy").length;
  const { apothecary, assistantCoaches, cheerleaders, dedicatedFans } = TEAM_CREATION;

  const download = () => {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${draft.name.trim().replace(/[^\w-]+/g, "-") || "team"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="bb-tb">
      <div className="bb-tb-head">
        <label>
          Team name <input value={draft.name} onChange={(e) => update({ name: e.target.value })} />
        </label>
        <label>
          Coach <input value={draft.coach ?? ""} placeholder="optional" onChange={(e) => update({ coach: e.target.value || undefined })} />
        </label>
        <label>
          Roster{" "}
          <select
            value={draft.roster}
            onChange={(e) => {
              const next = rosters.find((r) => r.name === e.target.value)!;
              update({ roster: next.name, players: [], captain: undefined, rerolls: Math.min(draft.rerolls, next.maxRerolls), apothecary: draft.apothecary && next.apothecary });
            }}
          >
            {rosters.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name} (tier {r.tier})
              </option>
            ))}
          </select>
        </label>
        <label>
          Budget{" "}
          <input type="number" step={10} min={0} value={budget / 1000} onChange={(e) => setBudget(Math.max(0, Math.round(Number(e.target.value) || 0)) * 1000)} />k
        </label>
      </div>

      <h3>Positions</h3>
      <table className="bb-tb-table">
        <thead>
          <tr>
            <th>Qty</th>
            <th className="bb-tb-left">Position</th>
            <th>MA</th>
            <th>ST</th>
            <th>AG</th>
            <th>PA</th>
            <th>AV</th>
            <th className="bb-tb-left">Skills</th>
            <th>Cost</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {roster.positions.map((pos) => {
            const count = draft.players.filter((p) => p.position === pos.title).length;
            const full = count >= pos.quantity || draft.players.length >= TEAM_CREATION.maxPlayers || (pos.type === "Big Guy" && bigGuys >= roster.maxBigGuys);
            return (
              <tr key={pos.title}>
                <td>
                  {count}/{pos.quantity}
                </td>
                <td className="bb-tb-left">
                  {pos.title}
                  {pos.type === "Big Guy" && <span className="bb-tb-tag">Big Guy</span>}
                </td>
                <td>{pos.ma}</td>
                <td>{pos.st}</td>
                <td>{target(pos.ag)}</td>
                <td>{target(pos.pa)}</td>
                <td>{target(pos.av)}</td>
                <td className="bb-tb-left bb-tb-skills">
                  <Skills skills={pos.skills} />
                </td>
                <td>{k(pos.cost)}</td>
                <td>
                  <button
                    disabled={full}
                    onClick={() => {
                      const number = freeNumber(draft.players);
                      setPlayers([...draft.players, { number, name: `${pos.title} #${number}`, position: pos.title }].sort((a, b) => a.number - b.number));
                    }}
                  >
                    Add
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="bb-tb-note">
        Big Guys: {bigGuys}/{roster.maxBigGuys}
      </div>

      <h3>
        Players ({draft.players.length}/{TEAM_CREATION.maxPlayers}, at least {TEAM_CREATION.minPlayers})
      </h3>
      {draft.players.length === 0 ? (
        <p className="bb-tb-note">Add players from the positions above.</p>
      ) : (
        <table className="bb-tb-table">
          <thead>
            <tr>
              <th>#</th>
              <th className="bb-tb-left">Name</th>
              <th className="bb-tb-left">Position</th>
              <th>Cost</th>
              <th title="Team Captain: gains Pro and the Team Captain trait">Captain</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.players.map((p, i) => (
              <tr key={i}>
                <td>
                  <input
                    className="bb-tb-number"
                    aria-label={`Number of ${p.name}`}
                    type="number"
                    min={1}
                    value={p.number}
                    onChange={(e) => {
                      const number = Math.max(1, Math.round(Number(e.target.value) || 1));
                      setPlayers(draft.players.map((q, j) => (j === i ? { ...q, number } : q)));
                      if (draft.captain === p.number) update({ captain: number });
                    }}
                  />
                </td>
                <td className="bb-tb-left">
                  <input aria-label={`Name of player #${p.number}`} value={p.name} onChange={(e) => setPlayers(draft.players.map((q, j) => (j === i ? { ...q, name: e.target.value } : q)))} />
                </td>
                <td className="bb-tb-left">{p.position}</td>
                <td>{k(roster.positions.find((pos) => pos.title === p.position)?.cost ?? 0)}</td>
                <td>
                  <input type="radio" name={captainGroup} aria-label={`${p.name} is Team Captain`} checked={draft.captain === p.number} onChange={() => update({ captain: p.number })} />
                </td>
                <td>
                  <button className="bb-tb-remove" title="Remove" aria-label={`Remove ${p.name}`} onClick={() => setPlayers(draft.players.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {draft.captain !== undefined && (
        <button className="bb-link" onClick={() => update({ captain: undefined })}>
          No captain
        </button>
      )}

      <h3>Sideline staff</h3>
      <table className="bb-tb-table bb-tb-staff">
        <tbody>
          <tr>
            <td className="bb-tb-left">Team re-rolls</td>
            <td>
              <Stepper label="Team re-rolls" value={draft.rerolls} min={0} max={roster.maxRerolls} onChange={(rerolls) => update({ rerolls })} />
            </td>
            <td>{k(roster.rerollCost)} each</td>
          </tr>
          <tr>
            <td className="bb-tb-left">Apothecary</td>
            <td>
              {roster.apothecary ? (
                <input type="checkbox" aria-label="Apothecary" checked={draft.apothecary ?? false} onChange={(e) => update({ apothecary: e.target.checked })} />
              ) : (
                <span className="bb-tb-note">not for {roster.name}</span>
              )}
            </td>
            <td>{k(apothecary.cost)}</td>
          </tr>
          <tr>
            <td className="bb-tb-left">Assistant coaches</td>
            <td>
              <Stepper label="Assistant coaches" value={draft.assistantCoaches ?? 0} min={0} max={assistantCoaches.max} onChange={(n) => update({ assistantCoaches: n })} />
            </td>
            <td>{k(assistantCoaches.cost)} each</td>
          </tr>
          <tr>
            <td className="bb-tb-left">Cheerleaders</td>
            <td>
              <Stepper label="Cheerleaders" value={draft.cheerleaders ?? 0} min={0} max={cheerleaders.max} onChange={(n) => update({ cheerleaders: n })} />
            </td>
            <td>{k(cheerleaders.cost)} each</td>
          </tr>
          <tr>
            <td className="bb-tb-left">Dedicated Fans</td>
            <td>
              <Stepper label="Dedicated Fans" value={draft.dedicatedFans ?? 1} min={dedicatedFans.start} max={dedicatedFans.max} onChange={(n) => update({ dedicatedFans: n })} />
            </td>
            <td>first free, then {k(dedicatedFans.cost)} each</td>
          </tr>
        </tbody>
      </table>

      <details className="bb-tb-rules">
        <summary>Special rules ({draft.specialRules?.length ?? 0})</summary>
        <p className="bb-tb-note">Tick the league and special rules of your roster (some inducements depend on them).</p>
        {[SPECIAL_RULES.slice(0, LEAGUES), SPECIAL_RULES.slice(LEAGUES)].map((group, g) => (
          <div key={g} className="bb-tb-rule-group">
            {group.map((rule) => (
              <label key={rule}>
                <input
                  type="checkbox"
                  checked={draft.specialRules?.includes(rule) ?? false}
                  onChange={(e) => update({ specialRules: e.target.checked ? [...(draft.specialRules ?? []), rule] : (draft.specialRules ?? []).filter((r) => r !== rule) })}
                />{" "}
                {rule}
              </label>
            ))}
          </div>
        ))}
      </details>

      <div className="bb-tb-totals">
        <span>Players {k(cost.players)}</span>
        <span>Re-rolls {k(cost.rerolls)}</span>
        <span>Staff {k(cost.staff)}</span>
        <span>Fans {k(cost.dedicatedFans)}</span>
        <strong className={cost.total > budget ? "bb-tb-over" : undefined}>
          Total {k(cost.total)} / {k(budget)}
        </strong>
        <span>Treasury left {k(budget - cost.total)}</span>
      </div>

      {errors.length > 0 && (
        <ul className="bb-tb-errors">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <div className="bb-tb-actions">
        <button className="bb-confirm" disabled={!team} onClick={() => team && props.onDone(team)}>
          Use this team
        </button>
        <button disabled={!team} onClick={download}>
          Download JSON
        </button>
        <button
          disabled={!team}
          onClick={async () => {
            await navigator.clipboard.writeText(json);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy JSON"}
        </button>
        {props.onCancel && <button onClick={props.onCancel}>Cancel</button>}
      </div>
      <details>
        <summary>Team file</summary>
        <pre className="bb-tb-json">{json}</pre>
      </details>
    </div>
  );
}
