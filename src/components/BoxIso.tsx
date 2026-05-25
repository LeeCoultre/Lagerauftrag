/* BoxIso — isometric SVG render of a single carton at relative scale.
   Ported from pallet-builder's CatalogView. Pure SVG + inline styles,
   no external dependencies. The largest dimension is normalised to 1
   so any carton shape renders at the same visual footprint, with
   correct relative proportions. */

const ISO_SX = Math.cos(Math.PI / 6); // 0.866
const ISO_SY = Math.sin(Math.PI / 6); // 0.5

interface BoxIsoProps {
  size: { l: number; w: number; h: number };
  color: string;
  px?: number;
  /* Edge visibility. 'subtle' (default, Focus mode) → strokeOpacity 0.2,
     a barely-there hint of level color. 'prominent' (LYNNE-Table) →
     stronger stroke + wider line so the level color reads at a glance
     while the faces stay neutral grayscale. */
  edgeMode?: 'subtle' | 'prominent';
}

export default function BoxIso({ size, color, px = 76, edgeMode = 'subtle' }: BoxIsoProps) {
  const prominent = edgeMode === 'prominent';
  const strokeOpacity = prominent ? 0.45 : 0.2;
  const strokeWidth = prominent ? 0.028 : 0.022;
  const max = Math.max(size.l, size.w, size.h, 1);
  const L = size.l / max;
  const W = size.w / max;
  const H = size.h / max;

  const proj = (i: number, j: number, k: number) => ({
    x: (i - j) * ISO_SX,
    y: -k + (i + j) * ISO_SY,
  });

  const v = {
    BFL: proj(0, 0, 0),
    BFR: proj(L, 0, 0),
    BBR: proj(L, W, 0),
    BBL: proj(0, W, 0),
    TFL: proj(0, 0, H),
    TFR: proj(L, 0, H),
    TBR: proj(L, W, H),
    TBL: proj(0, W, H),
  };

  const xs = Object.values(v).map((p) => p.x);
  const ys = Object.values(v).map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const pad = 0.06;

  /* Faces stay default neutral white/gray gradation in BOTH modes —
     only the edge stroke takes the `color`. */
  const top = "#FFFFFF";
  const right = "#ECECEF";
  const back = "#D9D9DD";

  /* Build a rounded-polygon path. At each vertex, trim a small amount
     of both incident edges and connect with a quadratic curve that
     passes through the original corner — gives a subtle radius without
     distorting the iso projection. */
  const r = 0.05;
  const roundedPath = (pts: { x: number; y: number }[]) => {
    const n = pts.length;
    const trim = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const f = Math.min(r, len / 2) / len;
      return { x: a.x + dx * f, y: a.y + dy * f };
    };
    const segs = pts.map((p, i) => ({
      vertex: p,
      enter: trim(p, pts[(i - 1 + n) % n]),
      exit:  trim(p, pts[(i + 1) % n]),
    }));
    const fmt = (p: { x: number; y: number }) =>
      `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
    let d = `M${fmt(segs[0].exit)}`;
    for (let i = 1; i < n; i++) {
      d += ` L${fmt(segs[i].enter)} Q${fmt(segs[i].vertex)} ${fmt(segs[i].exit)}`;
    }
    d += ` L${fmt(segs[0].enter)} Q${fmt(segs[0].vertex)} ${fmt(segs[0].exit)} Z`;
    return d;
  };

  return (
    <svg
      width={px}
      height={px}
      viewBox={`${minX - pad} ${minY - pad} ${w + pad * 2} ${h + pad * 2}`}
      style={{ display: "block" }}
    >
      <path
        d={roundedPath([v.TBL, v.TBR, v.BBR, v.BBL])}
        fill={back}
        stroke={color}
        strokeOpacity={strokeOpacity}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d={roundedPath([v.TFR, v.TBR, v.BBR, v.BFR])}
        fill={right}
        stroke={color}
        strokeOpacity={strokeOpacity}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d={roundedPath([v.TFL, v.TFR, v.TBR, v.TBL])}
        fill={top}
        stroke={color}
        strokeOpacity={strokeOpacity}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
