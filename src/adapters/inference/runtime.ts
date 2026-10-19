import { env, pipeline } from '@huggingface/transformers';
import { MODEL_ID, MODEL_REVISION, type EmbeddingPipeline } from './model';

/** All model data and executable assets are packaged and hash checked during the build. */
export async function createBundledPipeline(extensionBaseUrl: string): Promise<EmbeddingPipeline> {
  const base = new URL(extensionBaseUrl);
  if (base.protocol !== 'chrome-extension:')
    throw new Error('Inference must run inside the installed extension');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = new URL('models/', base).href;
  env.useFS = false;
  env.useFSCache = false;
  // Packaged assets survive browser restarts. Avoid duplicating weights or blob-backed executable factories.
  env.useBrowserCache = false;
  env.useWasmCache = false;
  env.useCustomCache = false;
  env.experimental_useCrossOriginStorage = false;
  const wasm = env.backends.onnx.wasm;
  if (!wasm) throw new Error('Bundled WASM runtime is unavailable');
  wasm.numThreads = 1;
  wasm.proxy = false;
  // Specify only binary location. ONNX's bundled ESM factory stays in background.js;
  // overriding its mjs URL would require dynamic import, forbidden in an MV3 worker.
  wasm.wasmPaths = { wasm: new URL('runtime/ort-wasm-simd-threaded.asyncify.wasm', base).href };
  const extractor = await pipeline('feature-extraction', MODEL_ID, {
    revision: MODEL_REVISION,
    dtype: 'q8',
    device: 'wasm',
    local_files_only: true,
  });
  return {
    async embed(text) {
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(output.data, Number);
    },
    async dispose() {
      await extractor.dispose();
    },
  };
}
