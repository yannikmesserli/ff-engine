import type { ReactNode } from "react";
import { BLOCK_FACES, type DiceRoll } from "@ff-engine/engine";

// Dice are drawn here (24 x 24 SVG), so they need no image folder.
const INK = "#222";
const PAPER = "#f4f1ea";

/** Points of a star-shaped explosion around (12, 12): `n` spikes between radius `inner` and `outer`. */
function burst(outer: number, inner: number, n = 12): string {
  return Array.from({ length: 2 * n }, (_, i) => {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI * i) / n - Math.PI / 2;
    return `${(12 + r * Math.cos(a)).toFixed(2)},${(12 + r * Math.sin(a)).toFixed(2)}`;
  }).join(" ");
}

const Explosion = () => (
  <>
    <polygon points={burst(11, 6.5)} fill="#e65100" />
    <polygon points={burst(7, 4)} fill="#ffca28" />
  </>
);

const Skull = () => (
  <>
    <path d="M12 3C7.6 3 5 6 5 9.8c0 2.5 1.2 4.1 2.5 5v2.7c0 .8.7 1.5 1.5 1.5h6c.8 0 1.5-.7 1.5-1.5v-2.7c1.3-.9 2.5-2.5 2.5-5C19 6 16.4 3 12 3Z" fill={INK} />
    <circle cx="9.2" cy="10.5" r="1.9" fill={PAPER} />
    <circle cx="14.8" cy="10.5" r="1.9" fill={PAPER} />
    <path d="M12 12.6 11 14.6h2Z" fill={PAPER} />
    <path d="M10.5 16.6V19M12 16.6V19M13.5 16.6V19" stroke={PAPER} strokeWidth=".8" />
  </>
);

/** The push arrow, pointing right. */
const Arrow = () => <path d="M4 10h9V6l7 6-7 6v-4H4Z" fill={INK} />;

/** `children` shrunk around the centre of the die, to draw on top of an explosion. */
const Small = ({ children }: { children: ReactNode }) => <g transform="translate(12 12) scale(.6) translate(-12 -12)">{children}</g>;

/** Block die faces: skull for the attacker, explosion for the defender, both for Both Down. */
const BLOCK_ART: Record<(typeof BLOCK_FACES)[number], ReactNode> = {
  attacker_down: <Skull />,
  both_down: (
    <>
      <Explosion />
      <Small>
        <Skull />
      </Small>
    </>
  ),
  push: <Arrow />,
  defender_stumbles: (
    <>
      <Explosion />
      <Small>
        <Arrow />
      </Small>
    </>
  ),
  defender_down: <Explosion />,
};

/** Pip centres of each d6 face. */
const PIPS: Array<Array<[number, number]>> = [
  [[12, 12]],
  [[7, 7], [17, 17]],
  [[7, 7], [12, 12], [17, 17]],
  [[7, 7], [17, 7], [7, 17], [17, 17]],
  [[7, 7], [17, 7], [12, 12], [7, 17], [17, 17]],
  [[7, 6], [17, 6], [7, 12], [17, 12], [7, 18], [17, 18]],
];

const BLOCK_LABELS: Record<(typeof BLOCK_FACES)[number], string> = {
  attacker_down: "Attacker Down",
  both_down: "Both Down",
  push: "Push",
  defender_stumbles: "Defender Stumbles",
  defender_down: "Defender Down",
};

function Die({ label, children }: { label: string; children: ReactNode }) {
  return (
    <svg className="bb-die" viewBox="0 0 24 24" role="img" aria-label={label}>
      <title>{label}</title>
      {children}
    </svg>
  );
}

/** One die: drawn for d6, d8 (an arrow, 1 = north, clockwise) and block dice, a text chip for coins, d3 and d16. */
export function DieFace({ kind, value }: { kind: DiceRoll["kind"]; value: number }) {
  switch (kind) {
    case "coin":
      return <span className="bb-die bb-coin">{value === 1 ? "Heads" : "Tails"}</span>;
    case "d3":
    case "d16":
      return <span className="bb-die bb-d3">{value}</span>;
    case "d6":
      return (
        <Die label={`d6: ${value}`}>
          {PIPS[value - 1]?.map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2.2" fill={INK} />
          ))}
        </Die>
      );
    case "d8":
      return (
        <Die label={`d8: ${value}`}>
          <path d="M12 3l7 7.5h-4.5V21h-5V10.5H5Z" fill={INK} transform={`rotate(${(value - 1) * 45} 12 12)`} />
        </Die>
      );
    case "block": {
      const face = BLOCK_FACES[value - 1];
      return face ? <Die label={BLOCK_LABELS[face]}>{BLOCK_ART[face]}</Die> : null;
    }
  }
}

/** All dice of a roll, in order. */
export function DiceRolls({ rolls }: { rolls: DiceRoll[] }) {
  return (
    <span className="bb-dice">
      {rolls.flatMap((r, i) => r.values.map((v, k) => <DieFace key={`${i}-${k}`} kind={r.kind} value={v} />))}
    </span>
  );
}
