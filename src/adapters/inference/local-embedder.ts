import type { Embedder } from '../../core/contracts/index';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_ID,
  MAX_EMBEDDING_CHARACTERS,
  type EmbeddingPipeline,
  type PipelineFactory,
} from './model';

const aborted = () => new DOMException('Embedding cancelled', 'AbortError');

/** One disposable host; persisted source text makes worker restarts recoverable. */
export class LocalEmbedder implements Embedder {
  readonly id = EMBEDDING_ID;
  private loading: Promise<EmbeddingPipeline> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private epoch = 0;

  constructor(
    private readonly createPipeline: PipelineFactory = async () => {
      // esbuild bundles this local module into the background entrypoint without a remote import.
      const { createBundledPipeline } = await import('./runtime');
      return createBundledPipeline(chrome.runtime.getURL(''));
    },
  ) {}

  private pipeline(): Promise<EmbeddingPipeline> {
    if (!this.loading) {
      const operation = this.createPipeline();
      this.loading = operation;
      void operation.catch(() => {
        if (this.loading === operation) this.loading = undefined;
      });
    }
    return this.loading;
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    const epoch = this.epoch;
    if (signal?.aborted) throw aborted();
    await this.pipeline();
    if (signal?.aborted || epoch !== this.epoch) throw aborted();
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Embedding needs non-empty text');
    if (text.length > MAX_EMBEDDING_CHARACTERS)
      throw new Error('Embedding input exceeds the passage limit; split it into chunks');
    const epoch = this.epoch;
    const operation = this.queue.then(async () => {
      if (signal?.aborted || epoch !== this.epoch) throw aborted();
      const pipeline = await this.pipeline();
      if (signal?.aborted || epoch !== this.epoch) throw aborted();
      const vector = await pipeline.embed(text);
      // WASM evaluation cannot be interrupted safely. A cancelled/disabled result is discarded.
      if (signal?.aborted || epoch !== this.epoch) throw aborted();
      if (
        vector.length !== EMBEDDING_DIMENSIONS ||
        vector.some((value) => !Number.isFinite(value))
      ) {
        throw new Error('The local model returned an invalid embedding');
      }
      const magnitude = Math.hypot(...vector);
      if (magnitude < 1e-8) throw new Error('The local model returned an empty embedding');
      return vector.map((value) => value / magnitude);
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async dispose(): Promise<void> {
    this.epoch += 1;
    const loading = this.loading;
    this.loading = undefined;
    // Stop accepting stale results before releasing an in-flight WASM session.
    await this.queue;
    if (loading) {
      const pipeline = await loading.catch(() => undefined);
      await pipeline?.dispose();
    }
  }
}
