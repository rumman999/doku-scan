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
  /** Minimum area fraction relative to total image area (default: 0.05) */
  minAreaFraction?: number;
}

/**
 * Accurately sorts four corner points into canonical order:
 * [Top-Left, Top-Right, Bottom-Right, Bottom-Left].
 *
 * Employs the robust geometric coordinate sum and difference algorithm:
 * - Top-Left (TL): Smallest sum (x + y)
 * - Bottom-Right (BR): Largest sum (x + y)
 * - Top-Right (TR): Smallest difference (y - x) or largest (x - y)
 * - Bottom-Left (BL): Largest difference (y - x) or smallest (x - y)
 *
 * @param pts Array of exactly 4 Points
 * @returns Tuple [TL, TR, BR, BL]
 */
export function orderCorners(pts: Point[]): [Point, Point, Point, Point] {
  if (pts.length !== 4) {
    throw new Error(`Expected exactly 4 points to order, received ${pts.length}`);
  }

  // Calculate sums (x + y) and differences (y - x)
  const sums = pts.map((p) => p.x + p.y);
  const diffs = pts.map((p) => p.y - p.x);

  let tlIdx = 0;
  let brIdx = 0;
  let trIdx = 0;
  let blIdx = 0;

  let minSum = sums[0];
  let maxSum = sums[0];
  let minDiff = diffs[0];
  let maxDiff = diffs[0];

  for (let i = 1; i < 4; i++) {
    if (sums[i] < minSum) {
      minSum = sums[i];
      tlIdx = i;
    }
    if (sums[i] > maxSum) {
      maxSum = sums[i];
      brIdx = i;
    }
    if (diffs[i] < minDiff) {
      minDiff = diffs[i];
      trIdx = i;
    }
    if (diffs[i] > maxDiff) {
      maxDiff = diffs[i];
      blIdx = i;
    }
  }

  return [pts[tlIdx], pts[trIdx], pts[brIdx], pts[blIdx]];
}

/**
 * Detects the bounding 4-corner document quadrilateral from an image Mat.
 *
 * Recreates document scanner edge map:
 * 1. Convert to single-channel Grayscale
 * 2. Gaussian Blur to suppress high-frequency paper grain and noise
 * 3. Canny edge candidate generation (30 / 150)
 * 4. Dual-axis Sobel gradient extraction (3x3, CV_16S) with convertScaleAbs
 * 5. Weighted gradient blending (0.5 * Gx + 0.5 * Gy + 0.0)
 * 6. Morphological dilation to bridge broken page boundary edges
 * 7. Hierarchical contour extraction & polygon simplification (epsilon = 0.02 * perimeter)
 * 8. Convex quadrilateral validation and maximum enclosed area selection
 *
 * @param cv OpenCV.js / WASM instance
 * @param srcMat Input source cv.Mat (RGBA or RGB)
 * @param options Optional tuning parameters
 * @returns Array of 4 sorted corner Points [TL, TR, BR, BL] or null if no valid quadrilateral is found
 */
export function detectDocumentCorners(
  cv: any,
  srcMat: any,
  options: DetectionOptions = {}
): Point[] | null {
  const blurKernel = options.blurKernelSize ?? 5;
  const cannyThresh1 = options.cannyThreshold1 ?? 30.0;
  const cannyThresh2 = options.cannyThreshold2 ?? 150.0;
  const epsilonFactor = options.epsilonFactor ?? 0.02;
  const dilationKernelSize = options.dilationKernelSize ?? 3;
  const minAreaFraction = options.minAreaFraction ?? 0.05;

  const totalArea = srcMat.rows * srcMat.cols;
  const minArea = totalArea * minAreaFraction;

  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edgeCanny = new cv.Mat();
  const gradX = new cv.Mat();
  const gradY = new cv.Mat();
  const absGradX = new cv.Mat();
  const absGradY = new cv.Mat();
  const gradCombined = new cv.Mat();
  const dilated = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let morphKernel: any = null;

  try {
    // 1. Grayscale conversion
    if (srcMat.channels() === 4) {
      cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
    } else if (srcMat.channels() === 3) {
      cv.cvtColor(srcMat, gray, cv.COLOR_RGB2GRAY);
    } else {
      srcMat.copyTo(gray);
    }

    // 2. Gaussian Blur to eliminate high-frequency texture noise
    if (blurKernel > 1) {
      const ksize = new cv.Size(blurKernel, blurKernel);
      cv.GaussianBlur(gray, blurred, ksize, 0, 0, cv.BORDER_DEFAULT);
    } else {
      gray.copyTo(blurred);
    }

    // 3. Canny Edge Detection (hysteresis thresholds 30 / 150 from document scanner)
    cv.Canny(blurred, edgeCanny, cannyThresh1, cannyThresh2, 3, false);

    // 4. Dual-axis Sobel Filtering (ddepth=CV_16S to avoid clipping negative gradients)
    cv.Sobel(blurred, gradX, cv.CV_16S, 1, 0, 3, 1, 0, cv.BORDER_DEFAULT);
    cv.convertScaleAbs(gradX, absGradX, 1.0, 0.0);

    cv.Sobel(blurred, gradY, cv.CV_16S, 0, 1, 3, 1, 0, cv.BORDER_DEFAULT);
    cv.convertScaleAbs(gradY, absGradY, 1.0, 0.0);

    // 5. Gradient Blending: 0.5 * Gx + 0.5 * Gy + 0.0
    cv.addWeighted(absGradX, 0.5, absGradY, 0.5, 0.0, gradCombined);

    // Combine Sobel blended gradients with Canny edge map
    cv.addWeighted(gradCombined, 0.5, edgeCanny, 0.5, 0.0, gradCombined);

    // 6. Morphological Dilation with 3x3 rectangular kernel
    morphKernel = cv.getStructuringElement(
      cv.MORPH_RECT,
      new cv.Size(dilationKernelSize, dilationKernelSize)
    );
    cv.dilate(
      gradCombined,
      dilated,
      morphKernel,
      new cv.Point(-1, -1),
      1,
      cv.BORDER_CONSTANT,
      cv.morphologyDefaultBorderValue()
    );

    // 7. Hierarchical contour finding
    cv.findContours(
      dilated,
      contours,
      hierarchy,
      cv.RETR_LIST,
      cv.CHAIN_APPROX_SIMPLE
    );

    let maxArea = 0;
    let detectedQuad: Point[] | null = null;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const perimeter = cv.arcLength(contour, true);
      const approx = new cv.Mat();

      // Polygon curve simplification with document scanner 2% perimeter epsilon
      cv.approxPolyDP(contour, approx, epsilonFactor * perimeter, true);

      // Verify that polygon has exactly 4 vertices and forms a convex quadrilateral
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const area = cv.contourArea(approx);
        if (area > minArea && area > maxArea) {
          maxArea = area;
          detectedQuad = [];
          for (let r = 0; r < 4; r++) {
            detectedQuad.push({
              x: approx.data32S[r * 2],
              y: approx.data32S[r * 2 + 1],
            });
          }
        }
      }

      approx.delete();
      contour.delete();
    }

    return detectedQuad ? orderCorners(detectedQuad) : null;
  } finally {
    gray.delete();
    blurred.delete();
    edgeCanny.delete();
    gradX.delete();
    gradY.delete();
    absGradX.delete();
    absGradY.delete();
    gradCombined.delete();
    dilated.delete();
    contours.delete();
    hierarchy.delete();
    if (morphKernel) morphKernel.delete();
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
