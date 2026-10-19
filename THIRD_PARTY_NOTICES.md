# Third-party software and model notices

Zombie Hand project code is licensed GPL-3.0-only; see LICENSE. Preserve upstream license/copyright notices when distributing a build. The public source and reproducible build instructions accompany the extension; its archive is not a substitute for corresponding source.

## Distributed runtime

| Component | Pinned version or revision | License | Source |
| --- | --- | --- | --- |
| Hugging Face Transformers.js | 4.3.1 | Apache-2.0 | https://github.com/huggingface/transformers.js |
| Hugging Face Jinja | 0.5.10 (prebundled in Transformers.js) | MIT | https://github.com/huggingface/jinja.js |
| Hugging Face Tokenizers | 0.2.0 (prebundled in Transformers.js) | Apache-2.0 | https://github.com/huggingface/tokenizers.js |
| ONNX Runtime Web | 1.31.0-dev.20260914-8d85527a0 (Transformers.js dependency) | MIT, with bundled third-party notices | https://github.com/microsoft/onnxruntime/tree/8d85527a0 |
| all-MiniLM-L6-v2 ONNX model and tokenizer | Xenova/all-MiniLM-L6-v2 revision 751bff37182d3f1213fa05d7196b954e230abad9 | Apache-2.0 | https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/751bff37182d3f1213fa05d7196b954e230abad9 |
| Zod | 4.6.7 | MIT | https://github.com/colinhacks/zod |
| YAML | 2.9.1 | ISC | https://github.com/eemeli/yaml |
| MediaPipe Tasks Vision | 1.1.1, full build's isolated gaze lab only | Apache-2.0 | https://github.com/google-ai-edge/mediapipe |
| Face Landmarker model bundle (face detector, mesh V2, blendshapes V2) | float16 version 1, hash in scripts/gaze-model-assets.json | Apache-2.0 | https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker#models |

Model assets are unchanged upstream q8 weights/configuration/tokenizer files, bundled rather than fetched during browsing. scripts/model-assets.json records their exact sizes and SHA-256 digests. The model produces 384-dimensional text embeddings; it does not interpret image pixels or video frames.

The build copies full license texts into licenses/ and preserves linked bundled-code legal notices. The ONNX Runtime notices in this source are retrieved from the exact upstream commit included in its dependency version. The embedding model independently declares Apache-2.0 in its model card; the packaged Apache-2.0 text covers those terms as well as Transformers.js. Additional bundled dependency notices retained by esbuild accompany the JavaScript output.

The face model bundle's three official model cards each state Apache License 2.0: [BlazeFace](https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20(Short%20Range).pdf), [Face Mesh V2](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf), [Blendshape V2](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf). The unchanged files are used only for local landmark detection in the gaze lab. The core build excludes this library, its runtime assets and its model.

## Build-only tools

Node.js 24.22.0 LTS (npm 11.19.1), TypeScript 5.9.3, esbuild 0.28.2, Vitest 5.0.5, Playwright 1.64.1, Biome 2.5.15, fake-indexeddb 6.2.6 and jsdom 30.1.3 are pinned directly. package-lock.json fixes transitive versions and integrity values. npm lifecycle scripts are disabled; build/test tools use the installed platform binaries. No native ONNX Node runtime or Sharp binaries are distributed with the extension.

The proposed WebGazer integration is not included in this runtime baseline. Its GPLv3 license motivated the project license choice; incorporating it still requires preserving its own notices and checking the actual selected code and model assets.
