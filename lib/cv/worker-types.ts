import { Point, ProcessedBufferResult } from './document-processor';
import { MagicColorOptions, BwFilterOptions } from './filters';

export type WorkerTaskType =
  | 'INIT'
  | 'DETECT_CORNERS'
  | 'DEWARP'
  | 'DEWARP_TO_BUFFER'
  | 'MAGIC_COLOR'
  | 'BW_FILTER'
  | 'PROCESS_FULL';

export interface BaseTaskPayload {
  taskId: string;
}

export interface InitPayload extends BaseTaskPayload {
  type: 'INIT';
  opencvUrl?: string;
}

export interface DetectCornersPayload extends BaseTaskPayload {
  type: 'DETECT_CORNERS';
  bitmap: ImageBitmap;
  options?: {
    blurKernelSize?: number;
    cannyThreshold1?: number;
    cannyThreshold2?: number;
    epsilonFactor?: number;
    dilationKernelSize?: number;
    minAreaFraction?: number;
  };
}

export interface DewarpPayload extends BaseTaskPayload {
  type: 'DEWARP';
  bitmap: ImageBitmap;
  corners: Point[];
}

export interface DewarpToBufferPayload extends BaseTaskPayload {
  type: 'DEWARP_TO_BUFFER';
  bitmap: ImageBitmap;
  corners: Point[];
}

export interface MagicColorPayload extends BaseTaskPayload {
  type: 'MAGIC_COLOR';
  bitmap: ImageBitmap;
  options?: MagicColorOptions;
}

export interface BwFilterPayload extends BaseTaskPayload {
  type: 'BW_FILTER';
  bitmap: ImageBitmap;
  options?: BwFilterOptions;
}

export interface ProcessFullPayload extends BaseTaskPayload {
  type: 'PROCESS_FULL';
  bitmap: ImageBitmap;
  corners?: Point[];
  filter?: 'magic-color' | 'bw' | 'none';
  magicColorOptions?: MagicColorOptions;
  bwOptions?: BwFilterOptions;
}

export type WorkerRequest =
  | InitPayload
  | DetectCornersPayload
  | DewarpPayload
  | DewarpToBufferPayload
  | MagicColorPayload
  | BwFilterPayload
  | ProcessFullPayload;

export interface WorkerSuccessResponse {
  taskId: string;
  success: true;
  type: WorkerTaskType;
  corners?: Point[] | null;
  bitmap?: ImageBitmap;
  bufferResult?: ProcessedBufferResult;
  durationMs: number;
}

export interface WorkerErrorResponse {
  taskId: string;
  success: false;
  type: WorkerTaskType;
  error: string;
  durationMs: number;
}

export type WorkerResponse = WorkerSuccessResponse | WorkerErrorResponse;
