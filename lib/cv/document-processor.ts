/**
 * Document Processor Module
 *
 * Implements the standard OpenCV pipeline from the design notes:
 * - Preprocessing: Grayscale + Gaussian Blur (ksize=5x5 or 3x3)
 * - Edge Detection: Canny (thresholds 30/150) + Dual-axis Sobel (3x3, CV_16S) with 0.5/0.5 weighted blending
 * - Morphology: Rectangular dilation to bridge broken boundary edges
 * - Contour Finding & Polygon Approximation: Hierarchical/list contours + approxPolyDP (epsilon = 0.02 * perimeter)
 * - Geometric Sorting: Robust sum/diff algorithm for Top-Left, Top-Right, Bottom-Right, Bottom-Left corners
 * - Perspective Transformation: cv.warpPerspective into an unwarped top-down high-resolution Mat
 * - Raw Buffer Extraction: Returns raw RGBA ArrayBuffer and image dimensions for zero-copy thread messaging
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
  /** Lower hysteresis threshold for Canny (default: 30) */
  cannyThreshold1?: number;
  /** Upper hysteresis threshold for Canny (default: 150) */
  cannyThreshold2?: number;
  /** Polygon approximation epsilon factor relative to contour arc length (default: 0.02) */
  epsilonFactor?: number;
  /** Morphological dilation kernel size (default: 3) */
  dilationKernelSize?: number;
  /** Minimum area fraction relative to total image area (default: 0.1) */
  minAreaFraction?: number;
}

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

/** Shoelace area of an ordered quad. */
function quadArea(q: Point[]): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

/**
 * Rejects quads that can't be a photographed sheet: near-degenerate interior
 * angles, or the image frame itself (every corner hugging the border).
 */
function isPlausibleQuad(q: Point[], width: number, height: number): boolean {
  for (let i = 0; i < 4; i++) {
    const prev = q[(i + 3) % 4];
    const cur = q[i];
    const next = q[(i + 1) % 4];
    const v1x = prev.x - cur.x;
    const v1y = prev.y - cur.y;
    const v2x = next.x - cur.x;
    const v2y = next.y - cur.y;
    const len = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (len === 0) return false;
    const cos = (v1x * v2x + v1y * v2y) / len;
    // Interior angle must lie within roughly 35..145 degrees.
    if (Math.abs(cos) > 0.82) return false;
  }

  const margin = Math.max(width, height) * 0.01;
  const onBorder = q.every(
    (p) => p.x <= margin || p.y <= margin || p.x >= width - 1 - margin || p.y >= height - 1 - margin
  );
  return !onBorder;
}

/**
 * Detects the bounding 4-corner document quadrilateral from an image Mat.
 *
 * Pipeline (run on a copy downscaled to ~500px so parameters behave the same
 * for a 640px preview frame and a 12MP photo):
 * 1. Grayscale + Gaussian blur to suppress paper grain and sensor noise
 * 2. Several binary edge/region maps:
 *    - Canny (default 30/150, plus a median-adaptive pass) closed with a
 *      rectangular kernel to bridge broken page boundaries
 *    - Otsu threshold (bright paper on a darker surface)
 * 3. Contour extraction, then polygon simplification (epsilon = 2% of perimeter),
 *    falling back to the convex hull when the raw contour is ragged
 * 4. The convex, plausibly-shaped quadrilateral with the largest area wins
 * 5. Corners are mapped back to source resolution
 *
 * Note: findContours must be fed a binary map. Feeding it a raw gradient
 * magnitude image (non-zero almost everywhere) yields one giant blob and
 * makes detection lock onto the image frame or noise.
 *
 * @param cv OpenCV.js / WASM instance
 * @param srcMat Input source cv.Mat (RGBA, RGB or gray)
 * @param options Optional tuning parameters
 * @returns Array of 4 sorted corner Points [TL, TR, BR, BL] or null if no valid quadrilateral is found
 */
export function detectDocumentCorners(
  cv: any,
  srcMat: any,
  options: DetectionOptions = {}
): Point[] | null {
  let blurKernel = options.blurKernelSize ?? 5;
  if (blurKernel > 1 && blurKernel % 2 === 0) blurKernel += 1;
  const cannyThresh1 = options.cannyThreshold1 ?? 30.0;
  const cannyThresh2 = options.cannyThreshold2 ?? 150.0;
  const epsilonFactor = options.epsilonFactor ?? 0.02;
  const dilationKernelSize = Math.max(1, options.dilationKernelSize ?? 3);
  const minAreaFraction = options.minAreaFraction ?? 0.1;

  const srcW = srcMat.cols;
  const srcH = srcMat.rows;
  if (srcW < 16 || srcH < 16) return null;

  const scale = Math.min(1, DETECTION_MAX_SIDE / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const minArea = w * h * minAreaFraction;

  const gray = new cv.Mat();
  const small = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const mask = new cv.Mat();
  const kernel = cv.getStructuringElement(
    cv.MORPH_RECT,
    new cv.Size(dilationKernelSize, dilationKernelSize)
  );

  // Two tiers: quads whose every side lies on detected edges ("strong"), and a
  // weaker fallback ranked by area x support for faint or partly shadowed pages.
  let best: Point[] | null = null;
  let bestArea = 0;
  let weak: Point[] | null = null;
  let weakScore = 0;

  /** Fraction of points along the weakest side of `q` that land on non-zero pixels of `support`. */
  const edgeSupport = (q: Point[], support: any): number => {
    const data: Uint8Array = support.data;
    const cols = support.cols;
    const rows = support.rows;
    let minRatio = 1;
    for (let s = 0; s < 4; s++) {
      const a = q[s];
      const b = q[(s + 1) % 4];
      const samples = Math.max(8, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 3));
      let hits = 0;
      let counted = 0;
      // Skip the ends: corners are often rounded, folded or occluded.
      for (let k = 1; k < samples; k++) {
        const t = k / samples;
        if (t < 0.08 || t > 0.92) continue;
        const x = Math.round(a.x + (b.x - a.x) * t);
        const y = Math.round(a.y + (b.y - a.y) * t);
        counted++;
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        if (data[y * cols + x] !== 0) hits++;
      }
      if (counted > 0) minRatio = Math.min(minRatio, hits / counted);
    }
    return minRatio;
  };

  /**
   * Weakest per-side brightness step between just inside and just outside the
   * quad. A real page boundary separates two consistent regions; a "side" that
   * cuts through textured background (where the edge map is dense) does not.
   * Sides lying on the image border (page clipped by the frame) are skipped.
   */
  const sideContrast = (q: Point[], img: any): number => {
    const data: Uint8Array = img.data;
    const cols = img.cols;
    const rows = img.rows;
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
    const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    const d = 4;
    const at = (x: number, y: number) => {
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= cols || yi >= rows) return -1;
      return data[yi * cols + xi];
    };
    let minContrast = Infinity;
    for (let s = 0; s < 4; s++) {
      const a = q[s];
      const b = q[(s + 1) % 4];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len === 0) return 0;
      let nx = -(b.y - a.y) / len;
      let ny = (b.x - a.x) / len;
      // Point the normal inward.
      if ((cx - a.x) * nx + (cy - a.y) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      let sum = 0;
      let n = 0;
      for (let k = 1; k < 20; k++) {
        const t = 0.1 + (0.8 * k) / 20;
        const px = a.x + (b.x - a.x) * t;
        const py = a.y + (b.y - a.y) * t;
        const inside = at(px + nx * d, py + ny * d);
        const outside = at(px - nx * d, py - ny * d);
        if (inside < 0 || outside < 0) continue;
        sum += inside - outside;
        n++;
      }
      if (n < 5) continue; // side runs along / outside the frame
      minContrast = Math.min(minContrast, Math.abs(sum / n));
    }
    return minContrast === Infinity ? 0 : minContrast;
  };

  const consider = (approx: any, support: any | null) => {
    if (approx.rows !== 4 || !cv.isContourConvex(approx)) return;
    const quad: Point[] = [];
    for (let r = 0; r < 4; r++) {
      quad.push({ x: approx.data32S[r * 2], y: approx.data32S[r * 2 + 1] });
    }
    const ordered = orderCorners(quad);
    const area = quadArea(ordered);
    if (area < minArea) return;
    if (!isPlausibleQuad(ordered, w, h)) return;
    const contrast = sideContrast(ordered, blurred);
    if (contrast < 6) return;
    const ratio = support ? edgeSupport(ordered, support) : 1;
    if (ratio >= 0.8 && contrast >= 10) {
      if (area > bestArea) {
        best = ordered;
        bestArea = area;
      }
    } else if (ratio >= 0.5 && area * ratio > weakScore) {
      weak = ordered;
      weakScore = area * ratio;
    }
  };

  const fitQuad = (curve: any, support: any | null) => {
    const approx = new cv.Mat();
    try {
      cv.approxPolyDP(curve, approx, epsilonFactor * cv.arcLength(curve, true), true);
      consider(approx, support);
      return approx.rows === 4;
    } finally {
      approx.delete();
    }
  };

  const scanBinary = (binary: any, support: any | null) => {
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    try {
      cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const hull = new cv.Mat();
        try {
          // The hull of a broken outline can be large even when the contour itself isn't.
          cv.convexHull(contour, hull, false, true);
          if (cv.contourArea(hull) < minArea) continue;
          // Ragged outlines (shadows, fingers, dog-ears) often simplify to 5+ points;
          // their convex hull usually still simplifies to the page quad.
          if (!fitQuad(contour, support)) fitQuad(hull, support);
        } finally {
          hull.delete();
          contour.delete();
        }
      }
    } finally {
      contours.delete();
      hierarchy.delete();
    }
  };

  try {
    if (srcMat.channels() === 4) {
      cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
    } else if (srcMat.channels() === 3) {
      cv.cvtColor(srcMat, gray, cv.COLOR_RGB2GRAY);
    } else {
      srcMat.copyTo(gray);
    }

    if (scale < 1) {
      cv.resize(gray, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    } else {
      gray.copyTo(small);
    }

    if (blurKernel > 1) {
      cv.GaussianBlur(small, blurred, new cv.Size(blurKernel, blurKernel), 0, 0, cv.BORDER_DEFAULT);
    } else {
      small.copyTo(blurred);
    }

    // Canny passes: configured thresholds, plus median-adaptive ones for
    // low-contrast scenes (white page on a light desk).
    const cannyPasses: [number, number][] = [[cannyThresh1, cannyThresh2]];
    const px: Uint8Array = blurred.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < px.length; i++) hist[px[i]]++;
    let acc = 0;
    let median = 127;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= px.length / 2) {
        median = v;
        break;
      }
    }
    const lo = Math.max(10, 0.5 * median);
    const hi = Math.min(255, Math.max(lo + 20, 1.0 * median));
    if (Math.abs(lo - cannyThresh1) > 5 || Math.abs(hi - cannyThresh2) > 5) cannyPasses.push([lo, hi]);

    for (const [t1, t2] of cannyPasses) {
      cv.Canny(blurred, edges, t1, t2, 3, false);
      cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
      cv.dilate(edges, edges, kernel);
      scanBinary(edges, edges);
    }

    // Region fallback: a sheet of paper is usually the brightest large region.
    // Only used when no edge outline was found, because a global threshold can
    // merge the page with bright patches of the surface around it.
    if (!best && !weak) {
      cv.threshold(blurred, mask, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
      scanBinary(mask, null);
    }

    const chosen = best ?? weak;
    if (!chosen) return null;
    const inv = 1 / scale;
    return (chosen as Point[]).map((p) => ({
      x: Math.min(srcW - 1, Math.max(0, p.x * inv)),
      y: Math.min(srcH - 1, Math.max(0, p.y * inv)),
    }));
  } finally {
    gray.delete();
    small.delete();
    blurred.delete();
    edges.delete();
    mask.delete();
    kernel.delete();
  }
}

/**
 * Rectifies and dewarps a document quadrilateral into a top-down, high-resolution matrix.
 *
 * Implements document scanner dewarp:
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
