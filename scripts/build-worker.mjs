// Bundles the OpenCV Web Worker (lib/cv/worker.ts + its imports) into a single
// classic-script file at public/cv-worker.js.
//
// Turbopack doesn't compile `new Worker(new URL("./worker.ts", import.meta.url))`
// in production builds; it copies the raw .ts file. Building the worker
// ourselves sidesteps that, and the IIFE format matters: OpenCV.js is loaded
// with importScripts(), which only exists in classic (non-module) workers.
//
// Usage: node scripts/build-worker.mjs [--watch]

import * as esbuild from "esbuild"

const watch = process.argv.includes("--watch")

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["lib/cv/worker.ts"],
  outfile: "public/cv-worker.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020", "chrome90", "safari15"],
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  legalComments: "none",
  logLevel: "info",
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
} else {
  await esbuild.build(options)
}
