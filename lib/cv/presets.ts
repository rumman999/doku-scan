import type { BwFilterOptions, MagicColorOptions } from "./filters"

/** Filter parameters used everywhere pages are enhanced (capture, preview, save). */
export const MAGIC_COLOR_OPTIONS: MagicColorOptions = { unsharpStrength: 0.6, saturationBoost: 1.25 }
export const BW_OPTIONS: BwFilterOptions = { method: "adaptive-gaussian", blockSize: 21, cConstant: 10 }
