import { join } from "node:path";
import { AutoProcessor, RawImage, Sam2Model, env, type Processor, type Tensor } from "@huggingface/transformers";
import { CACHE_DIR, CONFIG } from "./config.ts";
import type { Mask } from "./mask.ts";
import type { Mosaic } from "./tiles.ts";

env.cacheDir = join(CACHE_DIR, "models");

const EMBEDDING_CACHE_SIZE = 4;

export type PointPrompt = [x: number, y: number, label: 0 | 1];
export type BoxPrompt = [x1: number, y1: number, x2: number, y2: number];

export interface Prediction {
  mask: Mask;
  score: number;
}

interface Embedding {
  tensors: Record<string, Tensor>;
  original_sizes: [number, number][];
  reshaped_input_sizes: [number, number][];
}

interface SamImageProcessor {
  reshape_input_points(points: unknown, original: unknown, reshaped: unknown, isBox?: boolean): Tensor;
  add_input_labels(labels: unknown, points: Tensor): Tensor;
  post_process_masks(masks: Tensor, original: unknown, reshaped: unknown): Promise<Tensor[]>;
}

class SamEngine {
  private model: Sam2Model | null = null;
  private processor: Processor | null = null;
  private embeddings = new Map<string, Embedding>();
  private queue: Promise<unknown> = Promise.resolve();
  loading = false;
  error: string | null = null;

  get ready(): boolean {
    return this.model !== null;
  }

  async load(): Promise<void> {
    if (!CONFIG.sam.enabled) {
      this.error = "SAM2 is disabled in config.json";
      return;
    }
    this.loading = true;
    try {
      const started = Date.now();
      this.processor = await AutoProcessor.from_pretrained(CONFIG.sam.model);
      this.model = (await Sam2Model.from_pretrained(CONFIG.sam.model, {
        dtype: CONFIG.sam.dtype as "fp32",
      })) as Sam2Model;
      console.log(`SAM2 ${CONFIG.sam.model} loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (ex) {
      this.error = `SAM2 failed to load: ${(ex as Error).message}`;
      console.error(this.error);
    } finally {
      this.loading = false;
    }
  }

  private get imageProcessor(): SamImageProcessor {
    return (this.processor as unknown as { image_processor: SamImageProcessor }).image_processor;
  }

  private async embed(mosaic: Mosaic): Promise<Embedding> {
    const cached = this.embeddings.get(mosaic.key);
    if (cached) {
      this.embeddings.delete(mosaic.key);
      this.embeddings.set(mosaic.key, cached);
      return cached;
    }
    const { width, height } = mosaic.window;
    const image = new RawImage(new Uint8ClampedArray(mosaic.rgb), width, height, 3);
    const inputs = await this.processor!(image);
    const tensors = (await this.model!.get_image_embeddings({ pixel_values: inputs.pixel_values })) as Record<string, Tensor>;
    const embedding = { tensors, original_sizes: inputs.original_sizes, reshaped_input_sizes: inputs.reshaped_input_sizes };
    this.embeddings.set(mosaic.key, embedding);
    if (this.embeddings.size > EMBEDDING_CACHE_SIZE) this.embeddings.delete(this.embeddings.keys().next().value!);
    return embedding;
  }

  predict(mosaic: Mosaic, points: PointPrompt[], box?: BoxPrompt): Promise<Prediction[]> {
    if (!this.ready) return Promise.reject(new Error(this.error ?? "SAM2 is still loading, try again in a moment"));
    const run = this.queue.then(() => this.run(mosaic, points, box));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(mosaic: Mosaic, points: PointPrompt[], box?: BoxPrompt): Promise<Prediction[]> {
    const embedding = await this.embed(mosaic);
    const { original_sizes, reshaped_input_sizes } = embedding;
    const ip = this.imageProcessor;
    const inputs: Record<string, Tensor> = { ...embedding.tensors };
    if (points.length > 0) {
      inputs.input_points = ip.reshape_input_points([[points.map(([x, y]) => [x, y])]], original_sizes, reshaped_input_sizes);
      inputs.input_labels = ip.add_input_labels([[points.map(([, , label]) => label)]], inputs.input_points);
    }
    if (box) inputs.input_boxes = ip.reshape_input_points([[box]], original_sizes, reshaped_input_sizes, true);
    const outputs = (await this.model!(inputs)) as { pred_masks: Tensor; iou_scores: Tensor };
    const [masks] = await ip.post_process_masks(outputs.pred_masks, original_sizes, reshaped_input_sizes);
    const [height, width] = masks.dims.slice(-2);
    const plane = width * height;
    const data = masks.data as Uint8Array;
    const scores = Array.from(outputs.iou_scores.data as Float32Array);
    return scores
      .map((score, i) => ({ score, mask: { width, height, data: data.subarray(i * plane, (i + 1) * plane) } }))
      .sort((a, b) => b.score - a.score);
  }
}

export const SAM = new SamEngine();
