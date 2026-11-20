/**
 * Document image enhancement filters (OpenCV.js).
 *
 * 1. Enhanced colour ("magic-color" in code):
 *    - Background illumination division, (pixel / local background) * 255, which
 *      whitens paper and removes shadows (a standard flat-field correction)
 *    - Unsharp masking for crisp ink edges
 *    - Gentle saturation boost so pen, stamp and highlighter colours stay vivid
 *
 * 2. Black & white:
 *    - Adaptive Gaussian thresholding or Otsu's global threshold
 *    - Pure black text on a pure white page
 */

export interface MagicColorOptions {
  /** Block stride for illumination sampling grid (default: 32) */
  blockSize?: number;
  /** Minimum background floor to prevent division-by-zero (default: 15) */
  minBackgroundFloor?: number;
  /** Unsharp masking sharpening strength (default: 0.6) */
  unsharpStrength?: number;
  /** Color saturation enhancement multiplier (default: 1.25) */
  saturationBoost?: number;
  /** Contrast adjustment exponent / boost (default: 1.1) */
  contrastBoost?: number;
}

export interface BwFilterOptions {
  /** Method for binarization: 'adaptive-gaussian' or 'otsu' (default: 'adaptive-gaussian') */
  method?: 'adaptive-gaussian' | 'otsu';
  /** Block size for adaptive thresholding (must be an odd integer, default: 21) */
  blockSize?: number;
  /** Constant subtracted from mean/weighted mean (default: 10) */
  cConstant?: number;
  /** Optional noise reduction pre-filter kernel size (default: 3) */
  denoiseKernelSize?: number;
}

/**
 * Applies the enhanced-colour document filter using OpenCV.js matrix operations.
 *
 * Steps:
 * 1. Downsamples luminance to calculate local paper white background grid.
 * 2. Upsamples smoothly via bilinear interpolation.
 * 3. Element-wise division normalization: (pixel / background) * 255.0.
 * 4. Unsharp masking: sharpened = src + unsharpStrength * (src - gaussianBlur(src)).
 * 5. Targeted saturation boost: converts to HSV/YCrCb, scales saturation channel, clamps to [0, 255].
 *
 * @param cv OpenCV.js / WASM instance
 * @param srcMat Input source cv.Mat (RGBA or RGB)
 * @param options MagicColorOptions
 * @returns Enhanced cv.Mat (Caller is responsible for calling .delete())
 */
export function applyMagicColor(
  cv: any,
  srcMat: any,
  options: MagicColorOptions = {}
): any {
  const blockSize = options.blockSize ?? 32;
  const minFloor = options.minBackgroundFloor ?? 15;
  const unsharpStrength = options.unsharpStrength ?? 0.6;
  const satBoost = options.saturationBoost ?? 1.25;

  const width = srcMat.cols;
  const height = srcMat.rows;

  const gray = new cv.Mat();
  const smallBg = new cv.Mat();
  const fullBg = new cv.Mat();
  const normalized = new cv.Mat(height, width, srcMat.type());

  try {
    // 1. Grayscale luminance extraction
    if (srcMat.channels() === 4) {
      cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
    } else if (srcMat.channels() === 3) {
      cv.cvtColor(srcMat, gray, cv.COLOR_RGB2GRAY);
    } else {
      srcMat.copyTo(gray);
    }

    // 2. Downscaled background grid estimation
    const gridCols = Math.max(Math.floor(width / blockSize), 2);
    const gridRows = Math.max(Math.floor(height / blockSize), 2);
    cv.resize(gray, smallBg, new cv.Size(gridCols, gridRows), 0, 0, cv.INTER_AREA);

    // 3. Morphological dilation to sample pure paper highlights
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(smallBg, smallBg, kernel);
    kernel.delete();

    // 4. Upscale background map back to full document resolution
    cv.resize(smallBg, fullBg, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR);

    // 5. High-performance typed-array division normalization & saturation scaling
    const srcData = srcMat.data;
    const bgData = fullBg.data;
    const outData = normalized.data;
    const channels = srcMat.channels();
    const totalPixels = width * height;

    for (let i = 0; i < totalPixels; i++) {
      const bgVal = Math.max(bgData[i], minFloor);
      const idx = i * channels;

      // Extract normalized RGB
      let r = (srcData[idx] / bgVal) * 255.0;
      let g = (srcData[idx + 1] / bgVal) * 255.0;
      let b = (srcData[idx + 2] / bgVal) * 255.0;

      // Targeted saturation boost
      if (satBoost !== 1.0) {
        const maxVal = Math.max(r, g, b);
        const minVal = Math.min(r, g, b);
        const delta = maxVal - minVal;

        if (delta > 8.0 && maxVal > 20.0) {
          // Pixel contains meaningful chromatic color (pen, stamp, highlighter)
          const luma = 0.299 * r + 0.587 * g + 0.114 * b;
          r = luma + (r - luma) * satBoost;
          g = luma + (g - luma) * satBoost;
          b = luma + (b - luma) * satBoost;
        }
      }

      outData[idx] = Math.min(Math.max(Math.round(r), 0), 255);
      outData[idx + 1] = Math.min(Math.max(Math.round(g), 0), 255);
      outData[idx + 2] = Math.min(Math.max(Math.round(b), 0), 255);

      if (channels === 4) {
        outData[idx + 3] = srcData[idx + 3];
      }
    }

    // 6. Unsharp Masking for crisp text and ink boundaries
    if (unsharpStrength > 0.0) {
      const blurred = new cv.Mat();
      const sharpened = new cv.Mat();
      try {
        cv.GaussianBlur(normalized, blurred, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
        // sharpened = normalized * (1 + strength) - blurred * strength
        cv.addWeighted(
          normalized,
          1.0 + unsharpStrength,
          blurred,
          -unsharpStrength,
          0.0,
          sharpened
        );
        return sharpened;
      } finally {
        blurred.delete();
        normalized.delete();
      }
    }

    return normalized;
  } finally {
    gray.delete();
    smallBg.delete();
    fullBg.delete();
  }
}

/**
 * Applies pure Black & White document binarization using Adaptive Gaussian or Otsu thresholding.
 *
 * Guarantees crisp #000000 text on a pure #ffffff paper canvas.
 *
 * @param cv OpenCV.js / WASM instance
 * @param srcMat Input source cv.Mat
 * @param options BwFilterOptions
 * @returns Binarized cv.Mat in RGBA format (Caller must call .delete())
 */
export function applyBwFilter(
  cv: any,
  srcMat: any,
  options: BwFilterOptions = {}
): any {
  const method = options.method ?? 'adaptive-gaussian';
  let blockSize = options.blockSize ?? 21;
  const cConstant = options.cConstant ?? 10;
  const denoiseKernel = options.denoiseKernelSize ?? 3;

  // Adaptive threshold requires an odd block size > 1
  if (blockSize % 2 === 0) blockSize += 1;
  if (blockSize < 3) blockSize = 3;

  const gray = new cv.Mat();
  const denoised = new cv.Mat();
  const binary = new cv.Mat();
  const resultRgba = new cv.Mat();

  try {
    // 1. Convert to single-channel grayscale
    if (srcMat.channels() === 4) {
      cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
    } else if (srcMat.channels() === 3) {
      cv.cvtColor(srcMat, gray, cv.COLOR_RGB2GRAY);
    } else {
      srcMat.copyTo(gray);
    }

    // 2. Pre-filter noise with gentle Gaussian blur
    if (denoiseKernel > 1) {
      const ksize = new cv.Size(denoiseKernel, denoiseKernel);
      cv.GaussianBlur(gray, denoised, ksize, 0, 0, cv.BORDER_DEFAULT);
    } else {
      gray.copyTo(denoised);
    }

    // 3. Thresholding binarization
    if (method === 'otsu') {
      // Otsu's optimal global binarization
      cv.threshold(denoised, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    } else {
      // Adaptive Gaussian thresholding (robust against uneven gradients and page folds)
      cv.adaptiveThreshold(
        denoised,
        binary,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY,
        blockSize,
        cConstant
      );
    }

    // 4. Convert single-channel binary to 4-channel RGBA for canvas display & pipeline compatibility
    cv.cvtColor(binary, resultRgba, cv.COLOR_GRAY2RGBA);
    return resultRgba;
  } finally {
    gray.delete();
    denoised.delete();
    binary.delete();
  }
}
