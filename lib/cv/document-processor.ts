/**
 * Document Processor Module
 *
 * - Detection: candidates from closed edge contours, the largest edge-free
 *   region and pairs of long Hough lines (edges from brightness and colour
 *   saturation), scored on edge support, a consistent brightness/saturation
 *   step along each side, uniform paper inside, and an edge-free interior;
 *   the best are refined by fitting each side to nearby edges.
 * - Corner ordering: angle around the centroid, starting at the top-left.
 * - Perspective transformation: cv.warpPerspective into a top-down Mat.
 * - Raw buffer extraction for zero-copy transfer from the worker.
 */

export interface Point {
  x: number;
  y: number;
}

export interface ProcessedBufferResult {
  /** Raw pixel bytes in RGBA format suitable for transfer as Transferable ArrayBuffer */
  buffer: ArrayBuffer;
  /** Width of the rectified top-down document */
  width: number;
  /** Height of the rectified top-down document */
  height: number;
  /** Channel count (4 for RGBA) */
  channels: number;
}

export interface DetectionOptions {
  /** Gaussian blur kernel size (default: 5) */
  blurKernelSize?: number;
  /** @deprecated Ignored: Canny thresholds are derived from the image median. */
  cannyThreshold1?: number;
  /** @deprecated Ignored: Canny thresholds are derived from the image median. */
  cannyThreshold2?: number;
  /** @deprecated Ignored: several fixed epsilons are tried per candidate. */
  epsilonFactor?: number;
  /** @deprecated Ignored. */
  dilationKernelSize?: number;
  /** Long side of the internal working copy (default: 500). Lower is faster, but tested less accurate. */
  maxSide?: number;
  /** Minimum area fraction relative to total image area (default: 0.08) */
  minAreaFraction?: number;
  /**
   * Quad tracked on the previous frame (source-image coordinates, any order).
   * It is always scored as a candidate, and candidates close to it get a bonus,
   * so near-tied competitors (keyboard, a second sheet) can't flip the pick on noise.
   */
  prior?: Point[];
}

/** Score multiplier for candidates that match the prior. */
const PRIOR_BONUS = 1.3;
/** Max corner distance (fraction of the working long side) that counts as matching the prior. */
const PRIOR_MATCH = 0.04;

/**
 * Sorts four corner points into canonical order: [Top-Left, Top-Right, Bottom-Right, Bottom-Left].
 *
 * Points are sorted clockwise by angle around their centroid, then rotated so
 * the point with the smallest x + y comes first. Unlike the classic sum/diff
 * trick this never assigns one point to two roles (which happens for pages
 * rotated ~45deg), and it untangles self-intersecting quads produced by
 * dragging crop handles past each other.
 *
 * @param pts Array of exactly 4 Points
 * @returns Tuple [TL, TR, BR, BL]
 */
export function orderCorners(pts: Point[]): [Point, Point, Point, Point] {
  if (pts.length !== 4) {
    throw new Error(`Expected exactly 4 points to order, received ${pts.length}`);
  }

  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;

  // Image coordinates have y pointing down, so ascending atan2 is clockwise on screen.
  const sorted = pts
    .map((p) => ({ p, a: Math.atan2(p.y - cy, p.x - cx) }))
    .sort((a, b) => a.a - b.a)
    .map((e) => e.p);

  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  }

  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]) as [Point, Point, Point, Point];
}

/** Longest image side used for detection. Keeps kernels/thresholds scale-invariant and fast. */
const DETECTION_MAX_SIDE = 500;
/** Line candidates kept after grouping (pairs of these form quads). */
const MAX_LINE_GROUPS = 10;
/** Candidates that get the full (more expensive) evaluation. */
const FULL_EVAL_TOP = 25;

type Vec = { x: number; y: number };
type Seg = [number, number, number, number];

interface Maps {
  w: number;
  h: number;
  /** Blurred gray with text removed (morphological close). */
  paper: Uint8Array;
  /** Blurred HSV saturation. */
  sat: Uint8Array;
  /** Thin edge map (Canny on gray OR saturation). */
  edges: Uint8Array;
  /** Edge map dilated by 1px, used for "does this side lie on an edge". */
  edgesWide: Uint8Array;
}

interface SideEvidence {
  support: number;
  consistency: number;
  innerMean: number | null;
  onBorder: boolean;
}

/** Shoelace area of an ordered quad. */
function quadArea(q: Vec[]): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

function isConvexQuad(q: Vec[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Every interior angle within ~53..127 degrees (a photographed sheet, not a sliver). */
function anglesOk(q: Vec[]): boolean {
  for (let i = 0; i < 4; i++) {
    const p = q[(i + 3) % 4];
    const c = q[i];
    const n = q[(i + 1) % 4];
    const v1x = p.x - c.x;
    const v1y = p.y - c.y;
    const v2x = n.x - c.x;
    const v2y = n.y - c.y;
    const len = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (len === 0 || Math.abs((v1x * v2x + v1y * v2y) / len) > 0.6) return false;
  }
  return true;
}

function intersect(l1: Seg, l2: Seg): Vec | null {
  const [x1, y1, x2, y2] = l1;
  const [x3, y3, x4, y4] = l2;
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-6) return null;
  const a = x1 * y2 - y1 * x2;
  const b = x3 * y4 - y3 * x4;
  return { x: (a * (x3 - x4) - (x1 - x2) * b) / den, y: (a * (y3 - y4) - (y1 - y2) * b) / den };
}

function centroid(q: Vec[]): Vec {
  return { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 };
}

/** Point `t` of the way from the centroid to each corner. */
function scaleQuad(q: Vec[], t: number): Vec[] {
  const c = centroid(q);
  return q.map((p) => ({ x: c.x + (p.x - c.x) * t, y: c.y + (p.y - c.y) * t }));
}

/**
 * Per-side evidence that the side is a real page boundary:
 * - support: share of points on an edge pixel;
 * - consistency: share of points where the page side is clearly brighter
 *   (or clearly less saturated) than the outside, i.e. a step that holds
 *   along the whole side rather than random texture;
 * - innerMean: paper brightness just inside (for cross-side uniformity).
 * Sides lying on the frame border have no evidence either way.
 */
function sideEvidence(q: Vec[], m: Maps): SideEvidence[] {
  const { w, h } = m;
  const c = centroid(q);
  const out: SideEvidence[] = [];
  const N = 32;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1) return [];
    let nx = -(b.y - a.y) / len;
    let ny = (b.x - a.x) / len;
    if ((c.x - a.x) * nx + (c.y - a.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    let inFrame = 0;
    let hits = 0;
    let stepped = 0;
    let darker = 0;
    let lessSat = 0;
    let counted = 0;
    let innerSum = 0;
    for (let k = 0; k < N; k++) {
      const t = 0.08 + (0.84 * k) / (N - 1);
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      if (px <= 2 || py <= 2 || px >= w - 3 || py >= h - 3) continue;
      inFrame++;
      const xi = Math.round(px);
      const yi = Math.round(py);
      if (m.edgesWide[yi * w + xi]) hits++;
      const ix = Math.round(px + nx * 5);
      const iy = Math.round(py + ny * 5);
      const ox = Math.round(px - nx * 5);
      const oy = Math.round(py - ny * 5);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h || ox < 0 || oy < 0 || ox >= w || oy >= h) continue;
      counted++;
      const gi = m.paper[iy * w + ix];
      const go = m.paper[oy * w + ox];
      const dg = gi - go;
      const ds = m.sat[oy * w + ox] - m.sat[iy * w + ix];
      if (dg > 10) stepped++;
      if (dg < -10) darker++;
      if (ds > 10) lessSat++;
      innerSum += gi;
    }
    if (inFrame < N * 0.4) {
      out.push({ support: 0, consistency: 0, innerMean: null, onBorder: true });
      continue;
    }
    out.push({
      support: hits / inFrame,
      consistency: counted >= 6 ? Math.max(stepped, darker, lessSat) / counted : 0,
      innerMean: counted >= 6 ? innerSum / counted : null,
      onBorder: false,
    });
  }
  return out;
}

/** Samples on a grid inside polygon strip [a0,a1,b1,b0] (a = outer edge, b = inner edge). */
function sampleStrip(a0: Vec, a1: Vec, b0: Vec, b1: Vec, visit: (x: number, y: number) => void) {
  const ALONG = 24;
  const DEPTH = 4;
  for (let i = 0; i < ALONG; i++) {
    const t = (i + 0.5) / ALONG;
    const ox = a0.x + (a1.x - a0.x) * t;
    const oy = a0.y + (a1.y - a0.y) * t;
    const ix = b0.x + (b1.x - b0.x) * t;
    const iy = b0.y + (b1.y - b0.y) * t;
    for (let j = 0; j < DEPTH; j++) {
      const s = (j + 0.5) / DEPTH;
      visit(Math.round(ox + (ix - ox) * s), Math.round(oy + (iy - oy) * s));
    }
  }
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = values.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
}

/**
 * Score a candidate quad (higher is better, <= 0 rejects). `full` adds the
 * interior checks: a page's inside is nearly edge-free at detection scale and
 * the strip just inside every side has the page's own paper colour. Those
 * reject outlines that swallowed part of the keyboard/desk next to the page.
 */
function scoreQuad(q: Vec[], m: Maps, full: boolean): number {
  const { w, h } = m;
  const frac = quadArea(q) / (w * h);
  if (frac < 0.08 || frac > 0.97) return -1;
  const ev = sideEvidence(q, m);
  if (ev.length !== 4) return -1;

  const sides: number[] = [];
  let border = 0;
  const innerMeans: number[] = [];
  for (const e of ev) {
    if (e.onBorder) {
      border++;
      sides.push(0.15); // allowed (page clipped by the frame) but carries no evidence
      continue;
    }
    sides.push(0.4 * e.support + 0.6 * e.consistency);
    if (e.innerMean !== null) innerMeans.push(e.innerMean);
  }
  if (border > 1) return -1;
  const weakest = Math.min(...sides);
  if (border === 0 && weakest < 0.3) return -1;

  let uniform = 1;
  if (innerMeans.length >= 2) {
    const spread = (Math.max(...innerMeans) - Math.min(...innerMeans)) / 255;
    uniform = Math.max(0, 1 - 2.5 * spread);
  }
  const mean = sides.reduce((s, v) => s + v, 0) / 4;
  const base = mean * (0.5 + 0.5 * weakest) * (0.4 + 0.6 * uniform) * Math.pow(frac, 0.35);
  if (!full) return base;

  // Paper reference from the middle of the quad (text already removed).
  const core = scaleQuad(q, 0.4);
  const refG: number[] = [];
  const refS: number[] = [];
  sampleStrip(core[0], core[1], core[3], core[2], (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    refG.push(m.paper[y * w + x]);
    refS.push(m.sat[y * w + x]);
  });
  const gRef = median(refG);
  const sRef = median(refS);

  const outer = scaleQuad(q, 0.96);
  const inner = scaleQuad(q, 0.8);
  let worstEdges = 0;
  let worstOff = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    let n = 0;
    let edgeHits = 0;
    let off = 0;
    sampleStrip(outer[i], outer[j], inner[i], inner[j], (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const idx = y * w + x;
      n++;
      if (m.edges[idx]) edgeHits++;
      if (Math.abs(m.paper[idx] - gRef) > 28 || Math.abs(m.sat[idx] - sRef) > 28) off++;
    });
    if (n) {
      worstEdges = Math.max(worstEdges, edgeHits / n);
      worstOff = Math.max(worstOff, off / n);
    }
  }
  const empty = Math.max(0, 1 - worstEdges / 0.1) * (0.3 + 0.7 * Math.max(0, 1 - worstOff / 0.5));
  return base * (0.15 + 0.85 * empty);
}

/** Fit each side to nearby edge pixels (robust line fit) and re-intersect neighbours. */
function refineQuad(q: Vec[], edgePts: Float32Array, m: Maps): Vec[] {
  const { w, h } = m;
  const band = Math.max(4, 0.02 * Math.max(w, h));
  const lines: Seg[] = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let k = 0; k < edgePts.length; k += 2) {
      const rx = edgePts[k] - a.x;
      const ry = edgePts[k + 1] - a.y;
      const t = rx * ux + ry * uy;
      if (t < 0.1 * len || t > 0.9 * len) continue;
      if (Math.abs(-rx * uy + ry * ux) >= band) continue;
      xs.push(edgePts[k]);
      ys.push(edgePts[k + 1]);
    }
    if (xs.length < 10) {
      lines.push([a.x, a.y, b.x, b.y]);
      continue;
    }
    // Total least squares, then one Huber-style reweighting pass.
    let wts = new Float64Array(xs.length).fill(1);
    let dirX = ux;
    let dirY = uy;
    let mx = 0;
    let my = 0;
    for (let pass = 0; pass < 2; pass++) {
      let sw = 0;
      mx = 0;
      my = 0;
      for (let k = 0; k < xs.length; k++) {
        sw += wts[k];
        mx += wts[k] * xs[k];
        my += wts[k] * ys[k];
      }
      mx /= sw;
      my /= sw;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let k = 0; k < xs.length; k++) {
        const dx = xs[k] - mx;
        const dy = ys[k] - my;
        sxx += wts[k] * dx * dx;
        syy += wts[k] * dy * dy;
        sxy += wts[k] * dx * dy;
      }
      const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      dirX = Math.cos(theta);
      dirY = Math.sin(theta);
      const next = new Float64Array(xs.length);
      for (let k = 0; k < xs.length; k++) {
        const r = Math.abs(-(xs[k] - mx) * dirY + (ys[k] - my) * dirX);
        next[k] = r <= 1.5 ? 1 : 1.5 / r;
      }
      wts = next;
    }
    lines.push([mx, my, mx + dirX, my + dirY]);
  }
  const out: Vec[] = [];
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    if (!p || p.x < -0.05 * w || p.x > 1.05 * w || p.y < -0.05 * h || p.y > 1.05 * h) return q;
    out.push({ x: Math.min(w - 1, Math.max(0, p.x)), y: Math.min(h - 1, Math.max(0, p.y)) });
  }
  return orderCorners(out);
}

/** Group near-collinear Hough segments; keep the strongest groups' longest segment. */
function groupLines(segs: Seg[]): Seg[] {
  const groups: { ang: number; rho: number; len: number; total: number; seg: Seg }[] = [];
  for (const s of segs) {
    const [x1, y1, x2, y2] = s;
    const ang = ((Math.atan2(y2 - y1, x2 - x1) % Math.PI) + Math.PI) % Math.PI;
    const len = Math.hypot(x2 - x1, y2 - y1);
    const rho = x1 * -Math.sin(ang) + y1 * Math.cos(ang);
    const g = groups.find((g) => {
      const da = Math.abs(g.ang - ang);
      return Math.min(da, Math.PI - da) < (4 * Math.PI) / 180 && Math.abs(g.rho - rho) < 8;
    });
    if (g) {
      if (len > g.len) Object.assign(g, { ang, rho, len, seg: s });
      g.total += len;
    } else {
      groups.push({ ang, rho, len, total: len, seg: s });
    }
  }
  return groups
    .sort((a, b) => b.total - a.total)
    .slice(0, MAX_LINE_GROUPS)
    .map((g) => g.seg);
}

function lineAngle(l: Seg): number {
  return ((Math.atan2(l[3] - l[1], l[2] - l[0]) % Math.PI) + Math.PI) % Math.PI;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, Math.PI - d);
}

/**
 * Detects the bounding 4-corner document quadrilateral from an image Mat.
 *
 * Built for real desks, where the page touches keyboards, other papers and the
 * frame edge. Instead of trusting the single largest 4-sided contour, it
 * gathers candidates from three sources and scores each on evidence:
 *
 * 1. Candidates (on a ~500px copy):
 *    - closed edge contours simplified to 4 points (and their convex hulls);
 *    - the largest edge-free region (a page's interior has almost no edges at
 *      this scale), seeded at the distance-transform peak;
 *    - quads formed by pairs of long Hough lines (plus the frame borders, for
 *      pages clipped by the frame).
 *    Edges come from both brightness and colour saturation, which separates
 *    white paper from coloured surfaces with similar brightness.
 * 2. Scoring: per-side edge support and a brightness/saturation step that is
 *    consistent along the whole side; similar paper tone inside every side;
 *    an edge-free interior; and paper-coloured strips just inside each side.
 * 3. The best candidates are refined by fitting each side to nearby edges.
 *
 * @param cv OpenCV.js / WASM instance
 * @param srcMat Input source cv.Mat (RGBA, RGB or gray)
 * @param options Optional tuning parameters (blurKernelSize, minAreaFraction)
 * @returns Array of 4 sorted corner Points [TL, TR, BR, BL] or null if no valid quadrilateral is found
 */
export function detectDocumentCorners(
  cv: any,
  srcMat: any,
  options: DetectionOptions = {}
): Point[] | null {
  let blurKernel = options.blurKernelSize ?? 5;
  if (blurKernel > 1 && blurKernel % 2 === 0) blurKernel += 1;
  const minAreaFraction = options.minAreaFraction ?? 0.08;

  const srcW = srcMat.cols;
  const srcH = srcMat.rows;
  if (srcW < 16 || srcH < 16) return null;

  const scale = Math.min(1, (options.maxSide ?? DETECTION_MAX_SIDE) / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  const mats: any[] = [];
  const track = <T,>(mat: T): T => {
    mats.push(mat);
    return mat;
  };

  try {
    // --- Prepare maps -------------------------------------------------------
    const small = track(new cv.Mat());
    if (scale < 1) cv.resize(srcMat, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    else srcMat.copyTo(small);

    const gray = track(new cv.Mat());
    const sat = track(new cv.Mat());
    const ch = small.channels();
    if (ch === 1) {
      small.copyTo(gray);
      sat.create(h, w, cv.CV_8UC1);
      sat.setTo(new cv.Scalar(0));
    } else {
      cv.cvtColor(small, gray, ch === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGB2GRAY);
      const rgb = track(new cv.Mat());
      if (ch === 4) cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
      else small.copyTo(rgb);
      const hsv = track(new cv.Mat());
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      const planes = track(new cv.MatVector());
      cv.split(hsv, planes);
      const s = planes.get(1);
      s.copyTo(sat);
      s.delete();
    }

    const k = blurKernel > 1 ? new cv.Size(blurKernel, blurKernel) : null;
    const g = track(new cv.Mat());
    const sb = track(new cv.Mat());
    if (k) {
      cv.GaussianBlur(gray, g, k, 0, 0, cv.BORDER_DEFAULT);
      cv.GaussianBlur(sat, sb, k, 0, 0, cv.BORDER_DEFAULT);
    } else {
      gray.copyTo(g);
      sat.copyTo(sb);
    }

    // Text removed: closing fills dark strokes with the surrounding paper tone.
    const paper = track(new cv.Mat());
    const k9 = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9)));
    cv.morphologyEx(g, paper, cv.MORPH_CLOSE, k9);

    const gData: Uint8Array = g.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < gData.length; i++) hist[gData[i]]++;
    let acc = 0;
    let med = 127;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= gData.length / 2) {
        med = v;
        break;
      }
    }

    const e1 = track(new cv.Mat());
    const e2 = track(new cv.Mat());
    const edges = track(new cv.Mat());
    cv.Canny(g, e1, Math.max(10, 0.5 * med), Math.max(30, med), 3, false);
    cv.Canny(sb, e2, 20, 60, 3, false);
    cv.bitwise_or(e1, e2, edges);
    const k3 = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    const edgesWide = track(new cv.Mat());
    cv.dilate(edges, edgesWide, k3);

    const maps: Maps = {
      w,
      h,
      paper: paper.data,
      sat: sb.data,
      edges: edges.data,
      edgesWide: edgesWide.data,
    };
    const minArea = w * h * minAreaFraction;
    const candidates: Vec[][] = [];

    const pushApprox = (curve: any, eps: number): boolean => {
      const approx = new cv.Mat();
      try {
        cv.approxPolyDP(curve, approx, eps * cv.arcLength(curve, true), true);
        if (approx.rows !== 4 || !cv.isContourConvex(approx)) return false;
        const q: Vec[] = [];
        for (let r = 0; r < 4; r++) q.push({ x: approx.data32S[r * 2], y: approx.data32S[r * 2 + 1] });
        candidates.push(orderCorners(q));
        return true;
      } finally {
        approx.delete();
      }
    };

    // --- 1) Closed contours ------------------------------------------------
    {
      const k5 = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
      const closed = track(new cv.Mat());
      cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, k5);
      const contours = track(new cv.MatVector());
      const hier = track(new cv.Mat());
      cv.findContours(closed, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const hull = new cv.Mat();
        try {
          cv.convexHull(c, hull, false, true);
          if (cv.contourArea(hull) < minArea) continue;
          pushApprox(c, 0.02);
          pushApprox(hull, 0.02);
        } finally {
          hull.delete();
          c.delete();
        }
      }
    }

    // --- 2) Largest edge-free region ----------------------------------------
    for (const kk of [3, 5, 7]) {
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kk, kk));
      const free = new cv.Mat();
      const dist = new cv.Mat();
      const labels = new cv.Mat();
      const comp = new cv.Mat();
      const cs = new cv.MatVector();
      const hier = new cv.Mat();
      const hull = new cv.Mat();
      try {
        cv.dilate(edges, free, kernel);
        cv.bitwise_not(free, free);
        cv.rectangle(free, new cv.Point(0, 0), new cv.Point(w - 1, h - 1), new cv.Scalar(0), 1);
        cv.distanceTransform(free, dist, cv.DIST_L2, 5);
        const peak = cv.minMaxLoc(dist).maxLoc;
        cv.connectedComponents(free, labels, 8, cv.CV_32S);
        const target = labels.data32S[peak.y * w + peak.x];
        if (!target) continue;
        comp.create(h, w, cv.CV_8UC1);
        const cd: Uint8Array = comp.data;
        const ld: Int32Array = labels.data32S;
        let count = 0;
        for (let i = 0; i < ld.length; i++) {
          const on = ld[i] === target;
          cd[i] = on ? 255 : 0;
          if (on) count++;
        }
        if (count < minArea) continue;
        cv.findContours(comp, cs, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        let bestIdx = -1;
        let bestArea = 0;
        for (let i = 0; i < cs.size(); i++) {
          const c = cs.get(i);
          const a = cv.contourArea(c);
          if (a > bestArea) {
            bestArea = a;
            bestIdx = i;
          }
          c.delete();
        }
        if (bestIdx < 0) continue;
        const c = cs.get(bestIdx);
        cv.convexHull(c, hull, false, true);
        c.delete();
        const before = candidates.length;
        for (const eps of [0.02, 0.03, 0.05, 0.08]) if (pushApprox(hull, eps)) break;
        if (candidates.length > before) {
          // The free region stops ~kk/2 px short of the outline: push corners outward.
          const q = candidates[candidates.length - 1];
          const ctr = centroid(q);
          const r = q.reduce((s, p) => s + Math.hypot(p.x - ctr.x, p.y - ctr.y), 0) / 4;
          candidates[candidates.length - 1] = scaleQuad(q, 1 + (kk / 2 + 1) / Math.max(1, r));
        }
      } finally {
        kernel.delete();
        free.delete();
        dist.delete();
        labels.delete();
        comp.delete();
        cs.delete();
        hier.delete();
        hull.delete();
      }
    }

    // --- 3) Line pairs -------------------------------------------------------
    {
      const lines = track(new cv.Mat());
      cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 40, 0.15 * Math.min(w, h), 12);
      const segs: Seg[] = [];
      const ld: Int32Array = lines.data32S;
      for (let i = 0; i + 3 < ld.length; i += 4) segs.push([ld[i], ld[i + 1], ld[i + 2], ld[i + 3]]);
      const L: Seg[] = [
        ...groupLines(segs),
        [0, 0, w - 1, 0],
        [w - 1, 0, w - 1, h - 1],
        [0, h - 1, w - 1, h - 1],
        [0, 0, 0, h - 1],
      ];
      const ang = L.map(lineAngle);
      const near = (30 * Math.PI) / 180;
      const cross = (50 * Math.PI) / 180;
      for (let a = 0; a < L.length; a++)
        for (let b = a + 1; b < L.length; b++) {
          if (angleDiff(ang[a], ang[b]) > near) continue;
          // c > a: each pair-of-pairs is visited once, not twice.
          for (let c = a + 1; c < L.length; c++)
            for (let d = c + 1; d < L.length; d++) {
              if (c === b || d === b) continue;
              if (angleDiff(ang[c], ang[d]) > near || angleDiff(ang[a], ang[c]) < cross) continue;
              const pts = [intersect(L[a], L[c]), intersect(L[a], L[d]), intersect(L[b], L[d]), intersect(L[b], L[c])];
              if (pts.some((p) => !p || p.x < -0.02 * w || p.x > 1.02 * w || p.y < -0.02 * h || p.y > 1.02 * h)) continue;
              const q = orderCorners(
                (pts as Vec[]).map((p) => ({ x: Math.min(w - 1, Math.max(0, p.x)), y: Math.min(h - 1, Math.max(0, p.y)) }))
              );
              if (isConvexQuad(q)) candidates.push(q);
            }
        }
    }

    // --- 4) The quad tracked on the previous frame --------------------------
    const prior =
      options.prior?.length === 4
        ? orderCorners(options.prior.map((p) => ({ x: Math.min(w - 1, Math.max(0, p.x * scale)), y: Math.min(h - 1, Math.max(0, p.y * scale)) })))
        : null;
    if (prior) candidates.unshift(prior);
    const matchesPrior = (q: Vec[]) =>
      !!prior && Math.max(...q.map((p, i) => Math.hypot(p.x - prior[i].x, p.y - prior[i].y))) <= PRIOR_MATCH * Math.max(w, h);

    // --- Score: cheap pass for all, full pass + refinement for the best ------
    // Many line combinations yield the same quad; score each shape once.
    const seen = new Set<string>();
    const pre: { s: number; q: Vec[] }[] = [];
    for (const q of candidates) {
      const key = q.map((p) => `${Math.round(p.x / 3)},${Math.round(p.y / 3)}`).join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      if (!anglesOk(q)) continue;
      const s = scoreQuad(q, maps, false) * (matchesPrior(q) ? PRIOR_BONUS : 1);
      if (s > 0) pre.push({ s, q });
    }
    if (!pre.length) return null;
    pre.sort((x, y) => y.s - x.s);

    const ed: Uint8Array = edges.data;
    let n = 0;
    for (let i = 0; i < ed.length; i++) if (ed[i]) n++;
    const edgePts = new Float32Array(n * 2);
    for (let i = 0, j = 0; i < ed.length; i++) {
      if (!ed[i]) continue;
      edgePts[j++] = i % w;
      edgePts[j++] = (i / w) | 0;
    }

    let best: Vec[] | null = null;
    let bestScore = 0;
    for (const { q } of pre.slice(0, FULL_EVAL_TOP)) {
      for (const cand of [q, refineQuad(q, edgePts, maps)]) {
        if (!anglesOk(cand) || !isConvexQuad(cand)) continue;
        const s = scoreQuad(cand, maps, true) * (matchesPrior(cand) ? PRIOR_BONUS : 1);
        if (s > bestScore) {
          bestScore = s;
          best = cand;
        }
      }
    }
    if (!best) return null;

    const inv = 1 / scale;
    return (best as Vec[]).map((p) => ({
      x: Math.min(srcW - 1, Math.max(0, p.x * inv)),
      y: Math.min(srcH - 1, Math.max(0, p.y * inv)),
    }));
  } finally {
    for (const mat of mats) {
      if (mat && typeof mat.delete === "function" && !mat.isDeleted?.()) mat.delete();
    }
  }
}

/**
 * Rectifies and dewarps a document quadrilateral into a top-down, high-resolution matrix.
 *
 * Steps:
 * 1. Orders corner points canonically: [TL, TR, BR, BL]
 * 2. Computes the true physical aspect ratio from maximum edge lengths
 * 3. Applies high-performance homography perspective warp (cv.warpPerspective)
 *
 * @param cv OpenCV.js / WASM instance
 * @param srcMat Input source cv.Mat
 * @param corners 4 corner Points
 * @returns Rectified cv.Mat (Caller is responsible for calling .delete())
 */
export function dewarpDocument(cv: any, srcMat: any, corners: Point[]): any {
  const [tl, tr, br, bl] = orderCorners(corners);

  // Calculate width from Euclidean distance between top and bottom corner pairs
  const widthTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const widthBottom = Math.hypot(br.x - bl.x, br.y - bl.y);
  const targetWidth = Math.max(Math.round(Math.max(widthTop, widthBottom)), 1);

  // Calculate height from Euclidean distance between left and right corner pairs
  const heightLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const heightRight = Math.hypot(br.x - tr.x, br.y - tr.y);
  const targetHeight = Math.max(Math.round(Math.max(heightLeft, heightRight)), 1);

  const srcCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl.x, tl.y,
    tr.x, tr.y,
    br.x, br.y,
    bl.x, bl.y,
  ]);

  const dstCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    targetWidth - 1, 0,
    targetWidth - 1, targetHeight - 1,
    0, targetHeight - 1,
  ]);

  const transformMatrix = cv.getPerspectiveTransform(srcCoords, dstCoords);
  const dstMat = new cv.Mat();

  try {
    cv.warpPerspective(
      srcMat,
      dstMat,
      transformMatrix,
      new cv.Size(targetWidth, targetHeight),
      cv.INTER_LINEAR,
      cv.BORDER_REPLICATE
    );
    return dstMat;
  } finally {
    srcCoords.delete();
    dstCoords.delete();
    transformMatrix.delete();
  }
}

/**
 * Performs complete homography warping and converts the resulting OpenCV cv.Mat
 * directly into a transferable RGBA ArrayBuffer.
 *
 * Enables zero-copy memory transfer from Web Worker to the main thread:
 * `worker.postMessage({ buffer, width, height }, [buffer])`
 *
 * @param cv OpenCV.js / WASM instance
 * @param srcMat Input source cv.Mat
 * @param corners 4 detected document corner points
 * @returns ProcessedBufferResult with raw ArrayBuffer, width, height, and channel count
 */
export function dewarpDocumentToBuffer(
  cv: any,
  srcMat: any,
  corners: Point[]
): ProcessedBufferResult {
  const dewarpedMat = dewarpDocument(cv, srcMat, corners);
  let rgbaMat = dewarpedMat;
  let needsDelete = false;

  try {
    // Ensure standard 4-channel RGBA byte alignment
    if (dewarpedMat.channels() === 1) {
      rgbaMat = new cv.Mat();
      cv.cvtColor(dewarpedMat, rgbaMat, cv.COLOR_GRAY2RGBA);
      needsDelete = true;
    } else if (dewarpedMat.channels() === 3) {
      rgbaMat = new cv.Mat();
      cv.cvtColor(dewarpedMat, rgbaMat, cv.COLOR_RGB2RGBA);
      needsDelete = true;
    }

    const width = rgbaMat.cols;
    const height = rgbaMat.rows;
    const channels = rgbaMat.channels();

    // Copy underlying WebAssembly heap data into an independent Transferable ArrayBuffer
    const rawBytes = new Uint8Array(rgbaMat.data);
    const transferBuffer = rawBytes.slice().buffer;

    return {
      buffer: transferBuffer,
      width,
      height,
      channels,
    };
  } finally {
    dewarpedMat.delete();
    if (needsDelete) {
      rgbaMat.delete();
    }
  }
}
