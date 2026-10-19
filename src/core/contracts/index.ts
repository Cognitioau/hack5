import { z } from 'zod';

export const safeUrlSchema = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'An HTTP(S) URL without embedded credentials is required');
export const idSchema = z.string().uuid();
export const cueSchema = z
  .object({
    start: z.number().finite().min(0).max(604800),
    duration: z.number().finite().min(0).max(86400).optional(),
    text: z.string().max(2000),
  })
  .strict();
export const transcriptSchema = z
  .object({
    status: z.enum(['available', 'partial', 'unavailable', 'permission-required', 'failed']),
    cues: z.array(cueSchema).max(2000),
    language: z.string().max(80).optional(),
    provenance: z.enum(['youtube-panel', 'import']),
  })
  .strict();
export const candidateSchema = z
  .object({
    kind: z.enum(['text', 'link', 'image', 'youtube', 'file']),
    title: z.string().min(1).max(400),
    url: safeUrlSchema,
    text: z.string().max(32000),
    image: z
      .object({
        url: safeUrlSchema,
        alt: z.string().max(2000),
        rect: z
          .object({
            x: z.number().finite(),
            y: z.number().finite(),
            width: z.number().positive().max(50000),
            height: z.number().positive().max(50000),
            viewportWidth: z.number().positive().max(50000),
            viewportHeight: z.number().positive().max(50000),
          })
          .strict(),
      })
      .strict()
      .optional(),
    video: z
      .object({
        id: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
        seconds: z.number().finite().min(0).max(604800),
        transcript: transcriptSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if ((candidate.kind === 'image') !== !!candidate.image)
      context.addIssue({ code: 'custom', message: 'Image metadata must match capture kind' });
    if ((candidate.kind === 'youtube') !== !!candidate.video)
      context.addIssue({ code: 'custom', message: 'Video metadata must match capture kind' });
    if (candidate.video) {
      const url = new URL(candidate.url);
      if (
        !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname) ||
        url.pathname !== '/watch' ||
        url.searchParams.get('v') !== candidate.video.id
      )
        context.addIssue({ code: 'custom', message: 'YouTube identity must match source URL' });
    }
  });
export type CaptureCandidate = z.infer<typeof candidateSchema>;
export type TranscriptResult = z.infer<typeof transcriptSchema>;
export type TranscriptCue = z.infer<typeof cueSchema>;
export const assetSchema = z
  .object({
    bytes: z
      .instanceof(Uint8Array)
      .refine(
        (bytes) => bytes.byteLength > 0 && bytes.byteLength <= 10 * 1024 * 1024,
        'Attachment size limit exceeded',
      ),
    mimeType: z.string().max(100),
    extension: z.enum(['png', 'jpg', 'webp', 'gif', 'avif', 'pdf']),
  })
  .strict();
export const captureRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: idSchema,
    operationId: idSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    candidate: candidateSchema,
    lifecycle: z.enum(['active', 'archived']),
    lifecycleRevision: z.number().int().min(0),
    contentRevision: z.number().int().min(0),
    persistence: z.enum(['queued-local', 'saved-vault', 'uncertain', 'conflict', 'failed']),
    preservation: z.enum(['text', 'file', 'screenshot', 'link']),
    preparation: z.enum(['pending', 'ready']).optional(),
    lastError: z.string().max(2000).optional(),
    asset: assetSchema.optional(),
    vault: z
      .object({
        notePath: z.string(),
        metadataPath: z.string(),
        metadataEtag: z.string().optional(),
      })
      .strict()
      .optional(),
    indexState: z.enum(['pending', 'ready', 'failed', 'disabled']).default('pending'),
    indexError: z.string().max(2000).optional(),
    vectors: z
      .array(
        z.object({
          model: z.string(),
          hash: z.string(),
          text: z.string().max(32000),
          sourceUrl: safeUrlSchema,
          vector: z.array(z.number().finite()).max(4096),
        }),
      )
      .max(100)
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CaptureRecord = z.infer<typeof captureRecordSchema>;
export type PublicCapture = Omit<CaptureRecord, 'asset' | 'vectors'>;
export type VaultConfig = {
  endpoint: string;
  apiKey: string;
  folder: string;
  allowInsecureLoopback?: boolean;
};
export type VaultSaveResult = {
  status: 'saved-vault' | 'uncertain' | 'conflict' | 'failed';
  message?: string;
  metadataEtag?: string;
  vault?: { notePath: string; metadataPath: string; metadataEtag?: string };
};
export type VaultProbeResult = { ok: boolean; message: string };
export type VaultUnavailableCapture = {
  id: string;
  operationId: string;
  contentRevision: number;
  lifecycleRevision: number;
  notePath: string;
  metadataPath: string;
  reason: 'missing' | 'conflict';
  message: string;
};
export type VaultImportResult = {
  records: CaptureRecord[];
  skipped: number;
  message?: string;
  unavailable?: VaultUnavailableCapture[];
};
export interface VaultRepository {
  ensureCapture(record: CaptureRecord, signal?: AbortSignal): Promise<VaultSaveResult>;
  syncLifecycle(record: CaptureRecord, signal?: AbortSignal): Promise<VaultSaveResult>;
  probe(signal?: AbortSignal): Promise<VaultProbeResult>;
  importCaptures(signal?: AbortSignal): Promise<VaultImportResult>;
}
export interface Embedder {
  id: string;
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
}
export const pendingOperationSchema = z
  .object({
    captureId: idSchema,
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: z.number().finite().nonnegative(),
  })
  .strict();
export type PendingOperation = z.infer<typeof pendingOperationSchema>;
export interface CaptureRepository {
  create(record: CaptureRecord): Promise<CaptureRecord>;
  get(id: string): Promise<CaptureRecord | undefined>;
  list(): Promise<CaptureRecord[]>;
  exportRecords(): Promise<unknown[]>;
  update(
    id: string,
    change: (record: CaptureRecord) => CaptureRecord,
    queue?: boolean,
  ): Promise<CaptureRecord>;
  pending(): Promise<PendingOperation[]>;
  settle(id: string, lifecycleRevision: number, result: VaultSaveResult): Promise<CaptureRecord>;
  import(records: CaptureRecord[], accept?: () => boolean): Promise<number>;
}
export type SearchResult = {
  capture: PublicCapture;
  score: number;
  excerpt: string;
  sourceUrl: string;
  mode: 'semantic' | 'keyword';
};
export const featureSchema = z
  .object({
    images: z.boolean(),
    youtube: z.boolean(),
    haunting: z.boolean(),
    semantic: z.boolean(),
    gaze: z.boolean(),
  })
  .strict();
export type Features = z.infer<typeof featureSchema>;
export const settingsSchema = z
  .object({
    endpoint: z.string().max(200),
    folder: z.string().max(150),
    allowInsecureLoopback: z.boolean(),
    rememberKey: z.boolean(),
    features: featureSchema,
    excludedOrigins: z.array(z.string().max(200)).max(100),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  endpoint: 'https://127.0.0.1:27124',
  folder: 'Zombie Hand',
  allowInsecureLoopback: false,
  rememberKey: false,
  features: { images: true, youtube: true, haunting: true, semantic: true, gaze: false },
  excludedOrigins: [],
};
export const contentMessageSchema = z.discriminatedUnion('type', [
  z.object({ v: z.literal(1), type: z.literal('CONTENT_STATUS') }).strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal('ARM'),
      candidate: candidateSchema,
      pageUrl: safeUrlSchema,
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal('CAPTURE'),
      token: idSchema,
      operationId: idSchema,
      videoSeconds: z.number().finite().min(0).max(604800).optional(),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal('CANCEL'),
      token: idSchema,
      operationId: idSchema.optional(),
    })
    .strict(),
  z.object({ v: z.literal(1), type: z.literal('ARCHIVE'), captureId: idSchema }).strict(),
  z.object({ v: z.literal(1), type: z.literal('GET_CAPTURE'), captureId: idSchema }).strict(),
  z.object({ v: z.literal(1), type: z.literal('SEARCH'), query: z.string().max(2000) }).strict(),
]);
export const trustedMessageSchema = z.discriminatedUnion('type', [
  z.object({ v: z.literal(1), type: z.literal('GET_STATE') }).strict(),
  z.object({ v: z.literal(1), type: z.literal('EXPORT_RECORDS') }).strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal('SAVE_SETTINGS'),
      settings: settingsSchema,
      apiKey: z.string().max(1000).optional(),
    })
    .strict(),
  z.object({ v: z.literal(1), type: z.literal('FORGET_KEY') }).strict(),
  z.object({ v: z.literal(1), type: z.literal('PROBE_VAULT') }).strict(),
  z.object({ v: z.literal(1), type: z.literal('RETRY') }).strict(),
  z.object({ v: z.literal(1), type: z.literal('IMPORT_VAULT') }).strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal('IMPORT_TRANSCRIPT'),
      operationId: idSchema,
      url: safeUrlSchema,
      title: z.string().min(1).max(400),
      text: z.string().min(1).max(100000),
      seconds: z.number().finite().min(0).max(604800),
    })
    .strict(),
  z.object({ v: z.literal(1), type: z.literal('SEARCH'), query: z.string().max(2000) }).strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal('SET_LIFECYCLE'),
      captureId: idSchema,
      lifecycle: z.enum(['active', 'archived']),
    })
    .strict(),
  z.object({ v: z.literal(1), type: z.literal('PREPARE_MODEL') }).strict(),
]);
export type ContentMessage = z.infer<typeof contentMessageSchema>;
export type TrustedMessage = z.infer<typeof trustedMessageSchema>;
export type AppResponse =
  | {
      ok: true;
      token?: string;
      capture?: PublicCapture;
      results?: SearchResult[];
      settings?: Settings;
      hasKey?: boolean;
      captures?: PublicCapture[];
      exportRecords?: unknown[];
      message?: string;
      features?: Features;
    }
  | { ok: false; error: string };
export type FocusPoint = {
  x: number;
  y: number;
  source: 'mouse' | 'gaze';
  timestamp: number;
  tabId: number;
  frameId: number;
  documentId: string;
  navigationGeneration: number;
  confidence?: number;
};
