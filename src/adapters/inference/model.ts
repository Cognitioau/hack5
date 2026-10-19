export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const MODEL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_ID = `${MODEL_ID}@${MODEL_REVISION}:q8:mean-normalized`;
// MiniLM was trained for short passages. The coordinator should chunk longer sources.
export const MAX_EMBEDDING_CHARACTERS = 8_000;

export interface EmbeddingPipeline {
  embed(text: string): Promise<number[]>;
  dispose(): Promise<void>;
}
export type PipelineFactory = () => Promise<EmbeddingPipeline>;
