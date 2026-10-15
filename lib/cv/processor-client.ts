import { Point, ProcessedBufferResult } from './document-processor';
import { MagicColorOptions, BwFilterOptions } from './filters';
import {
  WorkerRequest,
  WorkerResponse,
  WorkerSuccessResponse,
} from './worker-types';

export interface ProcessorClientOptions {
  /** Optional custom URL for the compiled OpenCV WebAssembly script */
  opencvUrl?: string;
  /** Timeout for individual tasks in milliseconds (default: 30000) */
  timeoutMs?: number;
}

/**
 * Asynchronous Client for offloading heavy computer vision tasks
 * to a background Web Worker using zero-copy ImageBitmap and ArrayBuffer transfers.
 */
export class DocumentProcessorClient {
  private worker: Worker | null = null;
  private pendingTasks = new Map<
    string,
    {
      resolve: (res: any) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout | number;
    }
  >();
  private isReady = false;
  private initPromise: Promise<void> | null = null;
  private options: ProcessorClientOptions;

  constructor(options: ProcessorClientOptions = {}) {
    this.options = options;
  }

  /**
   * Initializes or returns the existing Web Worker instance.
   */
  public async init(): Promise<void> {
    if (this.isReady) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise<void>((resolve, reject) => {
      try {
        if (typeof window === 'undefined') {
          throw new Error('DocumentProcessorClient can only run in browser environments');
        }

        // Prebuilt by scripts/build-worker.mjs. Must be a classic worker (no
        // `type: 'module'`) so OpenCV.js can be loaded with importScripts().
        this.worker = new Worker('/cv-worker.js');

        this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
          this.handleWorkerResponse(e.data);
        };

        this.worker.onerror = (e: ErrorEvent) => {
          console.error('[DocumentProcessorWorker Error]', e);
        };

        const taskId = this.generateTaskId();
        this.dispatch<void>(
          {
            taskId,
            type: 'INIT',
            opencvUrl: this.options.opencvUrl,
          },
          []
        )
          .then(() => {
            this.isReady = true;
            resolve();
          })
          .catch(reject);
      } catch (err) {
        reject(err);
      }
    });

    return this.initPromise;
  }

  /**
   * Detects document corner coordinates from an image source without blocking the UI thread.
   */
  public async detectCorners(
    source: ImageBitmap | HTMLCanvasElement | HTMLImageElement | Blob | ImageData,
    options?: {
      blurKernelSize?: number;
      cannyThreshold1?: number;
      cannyThreshold2?: number;
      epsilonFactor?: number;
      dilationKernelSize?: number;
      minAreaFraction?: number;
    }
  ): Promise<Point[] | null> {
    await this.init();
    const bitmap = await this.ensureImageBitmap(source);
    const taskId = this.generateTaskId();

    const response = await this.dispatch<WorkerSuccessResponse>(
      {
        taskId,
        type: 'DETECT_CORNERS',
        bitmap,
        options,
      },
      [bitmap]
    );

    return response.corners ?? null;
  }

  /**
   * Applies perspective rectification / dewarping based on 4 quadrilateral corners.
   */
  public async dewarp(
    source: ImageBitmap | HTMLCanvasElement | HTMLImageElement | Blob | ImageData,
    corners: Point[]
  ): Promise<ImageBitmap> {
    await this.init();
    const bitmap = await this.ensureImageBitmap(source);
    const taskId = this.generateTaskId();

    const response = await this.dispatch<WorkerSuccessResponse>(
      {
        taskId,
        type: 'DEWARP',
        bitmap,
        corners,
      },
      [bitmap]
    );

    if (!response.bitmap) {
      throw new Error('Worker completed DEWARP but did not return an ImageBitmap');
    }

    return response.bitmap;
  }

  /**
   * Applies perspective rectification / dewarping and transfers the raw pixel buffer
   * as a zero-copy Transferable ArrayBuffer back to the main thread.
   */
  public async dewarpToBuffer(
    source: ImageBitmap | HTMLCanvasElement | HTMLImageElement | Blob | ImageData,
    corners: Point[]
  ): Promise<ProcessedBufferResult> {
    await this.init();
    const bitmap = await this.ensureImageBitmap(source);
    const taskId = this.generateTaskId();

    const response = await this.dispatch<WorkerSuccessResponse>(
      {
        taskId,
        type: 'DEWARP_TO_BUFFER',
        bitmap,
        corners,
      },
      [bitmap]
    );

    if (!response.bufferResult) {
      throw new Error('Worker completed DEWARP_TO_BUFFER but did not return a bufferResult');
    }

    return response.bufferResult;
  }

  /**
   * Applies document scanner 'Magic Color' filter (illumination division + unsharp mask + saturation boost).
   */
  public async magicColor(
    source: ImageBitmap | HTMLCanvasElement | HTMLImageElement | Blob | ImageData,
    options?: MagicColorOptions
  ): Promise<ImageBitmap> {
    await this.init();
    const bitmap = await this.ensureImageBitmap(source);
    const taskId = this.generateTaskId();

    const response = await this.dispatch<WorkerSuccessResponse>(
      {
        taskId,
        type: 'MAGIC_COLOR',
        bitmap,
        options,
      },
      [bitmap]
    );

    if (!response.bitmap) {
      throw new Error('Worker completed MAGIC_COLOR but did not return an ImageBitmap');
    }

    return response.bitmap;
  }

  /**
   * Applies pure Black & White document binarization (Adaptive Gaussian or Otsu thresholding).
   */
  public async applyBw(
    source: ImageBitmap | HTMLCanvasElement | HTMLImageElement | Blob | ImageData,
    options?: BwFilterOptions
  ): Promise<ImageBitmap> {
    await this.init();
    const bitmap = await this.ensureImageBitmap(source);
    const taskId = this.generateTaskId();

    const response = await this.dispatch<WorkerSuccessResponse>(
      {
        taskId,
        type: 'BW_FILTER',
        bitmap,
        options,
      },
      [bitmap]
    );

    if (!response.bitmap) {
      throw new Error('Worker completed BW_FILTER but did not return an ImageBitmap');
    }

    return response.bitmap;
  }

  /**
   * Runs the complete pipeline (Detect -> Dewarp -> Filter) in a single worker pass.
   */
  public async processFull(
    source: ImageBitmap | HTMLCanvasElement | HTMLImageElement | Blob | ImageData,
    corners?: Point[],
    filter: 'magic-color' | 'bw' | 'none' = 'magic-color',
    magicColorOptions?: MagicColorOptions,
    bwOptions?: BwFilterOptions
  ): Promise<{ bitmap: ImageBitmap; corners: Point[] | null; durationMs: number }> {
    await this.init();
    const bitmap = await this.ensureImageBitmap(source);
    const taskId = this.generateTaskId();

    const response = await this.dispatch<WorkerSuccessResponse>(
      {
        taskId,
        type: 'PROCESS_FULL',
        bitmap,
        corners,
        filter,
        magicColorOptions,
        bwOptions,
      },
      [bitmap]
    );

    if (!response.bitmap) {
      throw new Error('Worker completed PROCESS_FULL but did not return an ImageBitmap');
    }

    return {
      bitmap: response.bitmap,
      corners: response.corners ?? null,
      durationMs: response.durationMs,
    };
  }

  /**
   * Terminate the worker and cancel pending operations.
   */
  public terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingTasks.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new Error('DocumentProcessorClient worker was terminated'));
    });
    this.pendingTasks.clear();
    this.isReady = false;
    this.initPromise = null;
  }

  /**
   * Converts any supported image source to an ImageBitmap.
   */
  private async ensureImageBitmap(
    source: ImageBitmap | HTMLCanvasElement | HTMLImageElement | Blob | ImageData
  ): Promise<ImageBitmap> {
    if (source instanceof ImageBitmap) {
      return source;
    }
    return await createImageBitmap(source);
  }

  /**
   * Internal asynchronous message dispatcher.
   */
  private dispatch<T>(request: WorkerRequest, transfer: Transferable[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.worker) {
        return reject(new Error('Worker is not initialized'));
      }

      const timeout = this.options.timeoutMs ?? 30000;
      const timer = setTimeout(() => {
        this.pendingTasks.delete(request.taskId);
        reject(
          new Error(`Worker task ${request.type} (${request.taskId}) timed out after ${timeout}ms`)
        );
      }, timeout);

      this.pendingTasks.set(request.taskId, {
        resolve,
        reject,
        timer,
      });

      this.worker.postMessage(request, transfer);
    });
  }

  /**
   * Processes worker response messages and resolves pending promises.
   */
  private handleWorkerResponse(response: WorkerResponse): void {
    const pending = this.pendingTasks.get(response.taskId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingTasks.delete(response.taskId);

    if (response.success) {
      pending.resolve(response);
    } else {
      pending.reject(new Error(response.error || 'Unknown worker error'));
    }
  }

  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}

// Export singleton instance for easy app-wide usage
export const documentProcessor = new DocumentProcessorClient();
