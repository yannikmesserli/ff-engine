import { BLOCK_FACES, type DiceRoll } from "@bb/engine";

/** One die: an image for d6, d8 and block dice, a text chip for coins, d3 and d16. */
export function DieFace({ kind, value, assets }: { kind: DiceRoll["kind"]; value: number; assets: string }) {
  switch (kind) {
    case "coin":
      return <span className="bb-die bb-coin">{value === 1 ? "Heads" : "Tails"}</span>;
    case "d3":
    case "d16":
      return <span className="bb-die bb-d3">{value}</span>;
    case "d6":
      return <img className="bb-die" src={`${assets}/dice/${value}.png`} alt={`d6: ${value}`} />;
    case "d8":
      return <img className="bb-die" src={`${assets}/dice/d8-${value}.png`} alt={`d8: ${value}`} />;
    case "block":
      return <img className="bb-die" src={`${assets}/dice/${BLOCK_FACES[value - 1]}.png`} alt={BLOCK_FACES[value - 1]} />;
  }
}

/** All dice of a roll, in order. */
export function DiceRolls({ rolls, assets }: { rolls: DiceRoll[]; assets: string }) {
  return (
    <span className="bb-dice">
      {rolls.flatMap((r, i) => r.values.map((v, k) => <DieFace key={`${i}-${k}`} kind={r.kind} value={v} assets={assets} />))}
    </span>
  );
}
