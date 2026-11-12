import { useState, type CSSProperties } from "react";

// The ball and the bomb are drawn here (30 x 30 SVG), for when the image folder has none.

/** A brown football seen from the side, tilted, with its white stripes and laces. */
const Football = () => (
  <g transform="rotate(-35 15 15)">
    <ellipse cx="15" cy="15" rx="12.5" ry="7.5" fill="#7b3f1d" stroke="#3b1d0c" strokeWidth="1.2" />
    <path d="M6.2 9.8c.9 3.4.9 7 0 10.4M23.8 9.8c-.9 3.4-.9 7 0 10.4" stroke="#f4f1ea" strokeWidth="1.3" fill="none" />
    <path d="M10.5 15h9" stroke="#f4f1ea" strokeWidth="1.2" strokeLinecap="round" />
    <path d="M12 13.4v3.2M14 13.4v3.2M16 13.4v3.2M18 13.4v3.2" stroke="#f4f1ea" strokeWidth="1" strokeLinecap="round" />
  </g>
);

/** A round black bomb with a lit fuse. */
const Bomb = () => (
  <>
    <circle cx="13.5" cy="17" r="9" fill="#222" stroke="#000" strokeWidth="1" />
    <circle cx="10.5" cy="14" r="2.2" fill="#666" />
    <rect x="17.2" y="7.2" width="4" height="3.6" rx=".8" transform="rotate(45 19.2 9)" fill="#555" />
    <path d="M20.5 7.5c1.5-2 3-2.5 4.5-1.5" stroke="#a1887f" strokeWidth="1.2" fill="none" />
    <circle cx="25.3" cy="5.8" r="2" fill="#ffca28" />
    <circle cx="25.3" cy="5.8" r="1" fill="#e65100" />
  </>
);

/** The ball (or a bomb) drawn as an SVG. */
export function BallIcon({ kind = "ball", className, alt }: { kind?: "ball" | "bomb"; className?: string | undefined; alt: string }) {
  return (
    <svg className={className} viewBox="0 0 30 30" role="img" aria-label={alt}>
      {kind === "bomb" ? <Bomb /> : <Football />}
    </svg>
  );
}

/** Image URLs that failed to load: drawn straight away next time, without trying the image again. */
const missing = new Set<string>();

/** The ball (or bomb) image of the image folder, or the drawn one when the folder has none. */
export function BallImage(props: { assets: string; kind?: "ball" | "bomb"; className?: string | undefined; alt: string; style?: CSSProperties }) {
  const { assets, kind = "ball", className, alt, style } = props;
  const src = `${assets}/ball/${kind === "bomb" ? "sbomb_30x30.png" : "sball_30x30.png"}`;
  // The URL that failed here: a new `assets` folder is tried again.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src || missing.has(src)) {
    return (
      <span className={className} style={style}>
        <BallIcon kind={kind} alt={alt} className="bb-ball-svg" />
      </span>
    );
  }
  return (
    <img
      className={className}
      style={style}
      src={src}
      alt={alt}
      draggable={false}
      onError={() => {
        missing.add(src);
        setFailedSrc(src);
      }}
    />
  );
}
