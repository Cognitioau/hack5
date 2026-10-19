import { describe, expect, it, vi } from 'vitest';
import { LocalEmbedder } from '../../src/adapters/inference/local-embedder';
import type { EmbeddingPipeline } from '../../src/adapters/inference/model';

const vector = () => Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('local embedding host lifecycle', () => {
  it('shares initialization and serializes evaluations', async () => {
    let active = 0;
    const inference = vi.fn(async () => {
      expect(++active).toBe(1);
      await Promise.resolve();
      active--;
      return vector();
    });
    const load = vi.fn(async () => ({ embed: inference, dispose: vi.fn() }));
    const adapter = new LocalEmbedder(load);
    await Promise.all([adapter.embed('first'), adapter.embed('second')]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(inference).toHaveBeenCalledTimes(2);
  });
  it('retries failed initialization rather than caching a rejected promise', async () => {
    const load = vi
      .fn<() => Promise<EmbeddingPipeline>>()
      .mockRejectedValueOnce(new Error('load failure'))
      .mockResolvedValueOnce({ embed: async () => vector(), dispose: async () => undefined });
    const adapter = new LocalEmbedder(load);
    await expect(adapter.embed('first')).rejects.toThrow('load failure');
    await expect(adapter.embed('retry')).resolves.toHaveLength(384);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('rejects a late result after cancellation', async () => {
    const result = deferred<number[]>();
    const entered = deferred<void>();
    const adapter = new LocalEmbedder(async () => ({
      embed: async () => {
        entered.resolve();
        return result.promise;
      },
      dispose: async () => undefined,
    }));
    const controller = new AbortController();
    const work = adapter.embed('cancel me', controller.signal);
    const assertion = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    controller.abort();
    result.resolve(vector());
    await assertion;
  });
  it('disposes only after active evaluation and invalidates queued work', async () => {
    const result = deferred<number[]>();
    const entered = deferred<void>();
    const dispose = vi.fn(async () => undefined);
    const evaluate = vi.fn(async () => {
      entered.resolve();
      return result.promise;
    });
    const adapter = new LocalEmbedder(async () => ({ embed: evaluate, dispose }));
    const first = adapter.embed('active');
    const firstAssertion = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    const second = adapter.embed('queued');
    const secondAssertion = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    const disposal = adapter.dispose();
    expect(dispose).not.toHaveBeenCalled();
    result.resolve(vector());
    await Promise.all([firstAssertion, secondAssertion, disposal]);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized input and malformed or zero vectors', async () => {
    const inference = vi.fn(async () => [1, 2, 3]);
    const adapter = new LocalEmbedder(async () => ({
      embed: inference,
      dispose: async () => undefined,
    }));
    await expect(adapter.embed('x'.repeat(8_001))).rejects.toThrow('passage limit');
    expect(inference).not.toHaveBeenCalled();
    await expect(adapter.embed('bad shape')).rejects.toThrow('invalid embedding');
    inference.mockResolvedValueOnce(Array(384).fill(Number.NaN) as number[]);
    await expect(adapter.embed('nonfinite')).rejects.toThrow('invalid embedding');
    inference.mockResolvedValueOnce(Array(384).fill(0) as number[]);
    await expect(adapter.embed('zero')).rejects.toThrow('empty embedding');
  });
});
