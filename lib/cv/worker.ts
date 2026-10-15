import {
  detectDocumentCorners,
  dewarpDocument,
  dewarpDocumentToBuffer,
  Point,
} from './document-processor';
import { applyMagicColor, applyBwFilter } from './filters';
import { WorkerRequest, WorkerResponse } from './worker-types';

// Minimal worker-scope typing. The full `webworker` lib can't be enabled here
// because it conflicts with the `dom` lib the rest of the app compiles against.
declare const self: {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

let cv: any = null;
let isOpenCvReady = false;
let initPromise: Promise<any> | null = null;

// Bundled OpenCV 4.8.0 (WASM embedded) served from public/ so scanning works
// fully offline. Absolute path: resolves against the app origin, not this script.
const DEFAULT_OPENCV_URL = '/opencv.js';

/**
 * Initializes OpenCV.js compiled to WebAssembly inside the worker.
 */
function initOpenCV(opencvUrl = DEFAULT_OPENCV_URL): Promise<any> {
  if (isOpenCvReady && cv) {
    return Promise.resolve(cv);
  }
  if (initPromise) {
    return initPromise;
  }

  initPromise = new Promise((resolve, reject) => {
    try {
      let interval: ReturnType<typeof setInterval> | undefined;

      // OpenCV.js (emscripten) attaches a legacy `then` to its Module that
      // returns the Module itself. Resolving a Promise with that object makes
      // the Promise machinery call `then` forever, so strip it first.
      const finish = () => {
        if (isOpenCvReady) return;
        const instance = (self as any).cv;
        if (!instance?.Mat) return;
        if (typeof instance.then === 'function') delete instance.then;
        clearInterval(interval);
        cv = instance;
        isOpenCvReady = true;
        resolve(cv);
      };

      // opencv.js passes this global `Module` into its factory in a worker,
      // so onRuntimeInitialized fires once the WASM runtime is ready.
      (self as any).Module = { onRuntimeInitialized: finish };

      // Synchronous in classic workers; throws in module workers.
      (self as any).importScripts(opencvUrl);

      let attempts = 0;
      interval = setInterval(() => {
        attempts++;
        finish();
        if (!isOpenCvReady && attempts > 150) {
          clearInterval(interval);
          reject(new Error('OpenCV.js initialization timed out'));
        }
      }, 100);
    } catch (err) {
      reject(err);
    }
  });

  return initPromise;
}

/**
 * Converts an ImageBitmap into an OpenCV cv.Mat via an OffscreenCanvas without DOM dependencies.
 */
function bitmapToMat(cvInstance: any, bitmap: ImageBitmap): any {
  const width = bitmap.width;
  const height = bitmap.height;

  const offscreen = new OffscreenCanvas(width, height);
  const ctx = offscreen.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Could not create OffscreenCanvas 2D context');
  }

  ctx.drawImage(bitmap, 0, 0);
  const imgData = ctx.getImageData(0, 0, width, height);

  return cvInstance.matFromImageData(imgData);
}

/**
 * Converts an OpenCV cv.Mat back to an ImageBitmap using an OffscreenCanvas.
 */
async function matToBitmap(cvInstance: any, mat: any): Promise<ImageBitmap> {
  const width = mat.cols;
  const height = mat.rows;

  const offscreen = new OffscreenCanvas(width, height);
  const ctx = offscreen.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create OffscreenCanvas 2D context');
  }

  let rgbaMat = mat;
  let needsDelete = false;

  if (mat.channels() === 1) {
    rgbaMat = new cvInstance.Mat();
    cvInstance.cvtColor(mat, rgbaMat, cvInstance.COLOR_GRAY2RGBA);
    needsDelete = true;
  } else if (mat.channels() === 3) {
    rgbaMat = new cvInstance.Mat();
    cvInstance.cvtColor(mat, rgbaMat, cvInstance.COLOR_RGB2RGBA);
    needsDelete = true;
  }

  try {
    const imgData = new ImageData(
      new Uint8ClampedArray(rgbaMat.data),
      width,
      height
    );
    ctx.putImageData(imgData, 0, 0);
    return await createImageBitmap(offscreen);
  } finally {
    if (needsDelete) {
      rgbaMat.delete();
    }
  }
}

// Asynchronous message router
self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const data = e.data;
  const startTime = performance.now();

  try {
    switch (data.type) {
      case 'INIT': {
        await initOpenCV(data.opencvUrl);
        const res: WorkerResponse = {
          taskId: data.taskId,
          success: true,
          type: 'INIT',
          durationMs: performance.now() - startTime,
        };
        self.postMessage(res);
        break;
      }

      case 'DETECT_CORNERS': {
        const cvInstance = await initOpenCV();
        const srcMat = bitmapToMat(cvInstance, data.bitmap);
        data.bitmap.close();

        let corners: Point[] | null = null;
        try {
          corners = detectDocumentCorners(cvInstance, srcMat, data.options);
        } finally {
          srcMat.delete();
        }

        const res: WorkerResponse = {
          taskId: data.taskId,
          success: true,
          type: 'DETECT_CORNERS',
          corners,
          durationMs: performance.now() - startTime,
        };
        self.postMessage(res);
        break;
      }

      case 'DEWARP': {
        const cvInstance = await initOpenCV();
        const srcMat = bitmapToMat(cvInstance, data.bitmap);
        data.bitmap.close();

        let dewarpedMat: any = null;
        try {
          dewarpedMat = dewarpDocument(cvInstance, srcMat, data.corners);
          const outBitmap = await matToBitmap(cvInstance, dewarpedMat);

          const res: WorkerResponse = {
            taskId: data.taskId,
            success: true,
            type: 'DEWARP',
            bitmap: outBitmap,
            durationMs: performance.now() - startTime,
          };
          self.postMessage(res, [outBitmap]);
        } finally {
          srcMat.delete();
          if (dewarpedMat) dewarpedMat.delete();
        }
        break;
      }

      case 'DEWARP_TO_BUFFER': {
        const cvInstance = await initOpenCV();
        const srcMat = bitmapToMat(cvInstance, data.bitmap);
        data.bitmap.close();

        try {
          const bufferResult = dewarpDocumentToBuffer(cvInstance, srcMat, data.corners);
          const res: WorkerResponse = {
            taskId: data.taskId,
            success: true,
            type: 'DEWARP_TO_BUFFER',
            bufferResult,
            durationMs: performance.now() - startTime,
          };
          self.postMessage(res, [bufferResult.buffer]);
        } finally {
          srcMat.delete();
        }
        break;
      }

      case 'MAGIC_COLOR': {
        const cvInstance = await initOpenCV();
        const srcMat = bitmapToMat(cvInstance, data.bitmap);
        data.bitmap.close();

        let enhancedMat: any = null;
        try {
          enhancedMat = applyMagicColor(cvInstance, srcMat, data.options);
          const outBitmap = await matToBitmap(cvInstance, enhancedMat);

          const res: WorkerResponse = {
            taskId: data.taskId,
            success: true,
            type: 'MAGIC_COLOR',
            bitmap: outBitmap,
            durationMs: performance.now() - startTime,
          };
          self.postMessage(res, [outBitmap]);
        } finally {
          srcMat.delete();
          if (enhancedMat) enhancedMat.delete();
        }
        break;
      }

      case 'BW_FILTER': {
        const cvInstance = await initOpenCV();
        const srcMat = bitmapToMat(cvInstance, data.bitmap);
        data.bitmap.close();

        let bwMat: any = null;
        try {
          bwMat = applyBwFilter(cvInstance, srcMat, data.options);
          const outBitmap = await matToBitmap(cvInstance, bwMat);

          const res: WorkerResponse = {
            taskId: data.taskId,
            success: true,
            type: 'BW_FILTER',
            bitmap: outBitmap,
            durationMs: performance.now() - startTime,
          };
          self.postMessage(res, [outBitmap]);
        } finally {
          srcMat.delete();
          if (bwMat) bwMat.delete();
        }
        break;
      }

      case 'PROCESS_FULL': {
        const cvInstance = await initOpenCV();
        const srcMat = bitmapToMat(cvInstance, data.bitmap);
        data.bitmap.close();

        let workingMat = srcMat;
        let dewarpedMat: any = null;
        let filteredMat: any = null;

        try {
          let corners = data.corners;
          if (!corners || corners.length !== 4) {
            corners = detectDocumentCorners(cvInstance, srcMat) ?? undefined;
          }

          if (corners && corners.length === 4) {
            dewarpedMat = dewarpDocument(cvInstance, srcMat, corners);
            workingMat = dewarpedMat;
          }

          const filterType = data.filter ?? 'magic-color';
          if (filterType === 'bw') {
            filteredMat = applyBwFilter(cvInstance, workingMat, data.bwOptions);
          } else if (filterType === 'magic-color') {
            filteredMat = applyMagicColor(cvInstance, workingMat, data.magicColorOptions);
          } else {
            filteredMat = workingMat;
          }

          const outBitmap = await matToBitmap(cvInstance, filteredMat);

          const res: WorkerResponse = {
            taskId: data.taskId,
            success: true,
            type: 'PROCESS_FULL',
            corners: corners ?? null,
            bitmap: outBitmap,
            durationMs: performance.now() - startTime,
          };
          self.postMessage(res, [outBitmap]);
        } finally {
          srcMat.delete();
          if (dewarpedMat) dewarpedMat.delete();
          if (filteredMat && filteredMat !== workingMat && filteredMat !== dewarpedMat) {
            filteredMat.delete();
          }
        }
        break;
      }

      default:
        throw new Error(`Unknown task type: ${(data as any).type}`);
    }
  } catch (err: any) {
    const errorRes: WorkerResponse = {
      taskId: data.taskId,
      success: false,
      type: data.type,
      error: err?.message || String(err),
      durationMs: performance.now() - startTime,
    };
    self.postMessage(errorRes);
  }
};
