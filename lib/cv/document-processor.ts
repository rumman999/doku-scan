/**
 * Document Processor Module
 *
 * Implements standard OpenCV routines:
 * - Edge detection via dual-axis Sobel (3x3), weighted blending (0.5/0.5), dilation, and approxPolyDP.
 * - Perspective dewarping via canonical corner sorting and warpPerspective.
 */

export interface Point {
  x: number;
  y: number;
}

export interface DetectionOptions {
  /** Approximation epsilon factor relative to contour arc length (default: 0.02) */
  epsilonFactor?: number;
  /** Morphological dilation kernel size (default: 3) */
  dilationKernelSize?: number;
  /** Minimum area fraction relative to total image area (default: 0.05) */
  minAreaFraction?: number;
}

/**
 * Sorts four corner coordinates into canonical order: [Top-Left, Top-Right, Bottom-Right, Bottom-Left].
 */
export function orderCorners(pts: Point[]): [Point, Point, Point, Point] {
  if (pts.length !== 4) {
    throw new Error(`Expected exactly 4 points to order, received ${pts.length}`);
  }

  // Sort primarily by Y coordinate
  const sortedByY = [...pts].sort((a, b) => a.y - b.y);

  // Top two points sorted by X
  const top = sortedByY.slice(0, 2).sort((a, b) => a.x - b.x);
  // Bottom two points sorted by X descending
  const bottom = sortedByY.slice(2, 4).sort((a, b) => b.x - a.x);

  return [top[0], top[1], bottom[0], bottom[1]];
}

/**
 * Detects the bounding 4-corner document quadrilateral from an image Mat.
 *
 * Recreates document scanner edge map:
 * 1. Convert to Grayscale
 * 2. Compute horizontal & vertical gradients via Sobel (ddepth=CV_16S, ksize=3)
 * 3. Convert scales with convertScaleAbs
 * 4. Blend gradients equally: addWeighted(abs_dx, 0.5, abs_dy, 0.5, 0.0)
 * 5. Morphological dilation with 3x3 rectangular kernel
 * 6. Find contours and approximate convex quadrilateral with approxPolyDP
 *
 * @param cv OpenCV.js / WASM instance
 * @param srcMat Input cv.Mat (RGBA or RGB)
 * @param options Optional tuning parameters
 * @returns Array of 4 Points representing detected corners, or null if no valid quad is found
 */
export function detectDocumentCorners(
  cv: any,
  srcMat: any,
  options: DetectionOptions = {}
): Point[] | null {
  const epsilonFactor = options.epsilonFactor ?? 0.02;
  const kernelSize = options.dilationKernelSize ?? 3;
  const minAreaFraction = options.minAreaFraction ?? 0.05;

  const totalArea = srcMat.rows * srcMat.cols;
  const minArea = totalArea * minAreaFraction;

  const gray = new cv.Mat();
  const gradX = new cv.Mat();
  const gradY = new cv.Mat();
  const absGradX = new cv.Mat();
  const absGradY = new cv.Mat();
  const gradCombined = new cv.Mat();
  const dilated = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let kernel: any = null;

  try {
    // 1. Convert to single-channel grayscale
    if (srcMat.channels() === 4) {
      cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
    } else if (srcMat.channels() === 3) {
      cv.cvtColor(srcMat, gray, cv.COLOR_RGB2GRAY);
    } else {
      srcMat.copyTo(gray);
    }

    // 2. Sobel horizontal (dx=1, dy=0) and vertical (dx=0, dy=1) with ksize=3
    cv.Sobel(gray, gradX, cv.CV_16S, 1, 0, 3, 1, 0, cv.BORDER_DEFAULT);
    cv.convertScaleAbs(gradX, absGradX, 1.0, 0.0);

    cv.Sobel(gray, gradY, cv.CV_16S, 0, 1, 3, 1, 0, cv.BORDER_DEFAULT);
    cv.convertScaleAbs(gradY, absGradY, 1.0, 0.0);

    // 3. Blend horizontal and vertical gradients with alpha=0.5, beta=0.5, gamma=0.0
    cv.addWeighted(absGradX, 0.5, absGradY, 0.5, 0.0, gradCombined);

    // 4. Morphological dilation to bridge broken edge segments
    kernel = cv.getStructuringElement(
      cv.MORPH_RECT,
      new cv.Size(kernelSize, kernelSize)
    );
    cv.dilate(
      gradCombined,
      dilated,
      kernel,
      new cv.Point(-1, -1),
      1,
      cv.BORDER_CONSTANT,
      cv.morphologyDefaultBorderValue()
    );

    // 5. Find contours and approximate 4-corner polygon
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

      // Approximate polygon curve with extracted 2% epsilon
      cv.approxPolyDP(contour, approx, epsilonFactor * perimeter, true);

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
    gradX.delete();
    gradY.delete();
    absGradX.delete();
    absGradY.delete();
    gradCombined.delete();
    dilated.delete();
    contours.delete();
    hierarchy.delete();
    if (kernel) kernel.delete();
  }
}

/**
 * Rectifies and dewarps a document region from quadrilateral corners.
 *
 * Recreates document scanner dewarp / DewarpImgFile:
 * 1. Orders corner points into [TL, TR, BR, BL]
 * 2. Computes unwarped destination bounds using Euclidean distance
 * 3. Applies getPerspectiveTransform and warpPerspective with BORDER_REPLICATE
 *
 * @param cv OpenCV.js / WASM instance
 * @param srcMat Input source cv.Mat
 * @param corners 4 detected corner points
 * @returns Unwarped cv.Mat (caller is responsible for invoking .delete())
 */
export function dewarpDocument(cv: any, srcMat: any, corners: Point[]): any {
  const [tl, tr, br, bl] = orderCorners(corners);

  // Compute maximum width across top and bottom edges
  const widthTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const widthBottom = Math.hypot(br.x - bl.x, br.y - bl.y);
  const targetWidth = Math.max(Math.round(Math.max(widthTop, widthBottom)), 1);

  // Compute maximum height across left and right edges
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
