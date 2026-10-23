import { boundedMessage } from '../core/domain/security';
import { haunts, publicCapture } from '../core/domain/retrieval';
import {
  contentMessageSchema,
  trustedMessageSchema,
  type AppResponse,
  type CaptureCandidate,
  type CaptureRecord,
  type VaultRepository,
  type VaultStatus,
} from '../core/contracts';
import { createCaptureStore } from '../adapters/persistence/indexed-db';
import { createVaultClient } from '../adapters/persistence/vault';
import { LocalEmbedder } from '../adapters/inference/local-embedder';
import {
  allowedOrigin,
  forgetKey,
  originPattern,
  readSettings,
  readVaultConfig,
  secureStorage,
  writeSettings,
} from '../adapters/browser/settings';
import { createHandActivation, universalPageOrigins } from '../adapters/browser/activation';
import {
  authorizeMediaOrigin,
  reconcileMediaOrigins,
  revokeMediaOrigin,
} from '../adapters/browser/media-access';
import { cropSnapshot, downloadImage } from '../adapters/browser/media';
import { preserveImage } from '../features/image/preserve';
import { createCoordinator } from '../application/coordinator';
import { parseImportedTranscript, youtubeVideoId } from '../features/youtube/transcript';
import { GRAVE_HANDS } from '../ui/grave-sprite';

type Arm = {
  token: string;
  tabId: number;
  documentId: string;
  pageUrl: string;
  candidate: CaptureCandidate;
  expires: number;
  cancelled: boolean;
  captureId?: string;
  controller: AbortController;
};
const arms = new Map<string, Arm>();
const reservedCaptureIds = new Set<string>();
const store = createCaptureStore();
const embedder = new LocalEmbedder();
let networkController = new AbortController();
let vaultCache: { identity: string; client: VaultRepository } | undefined;
let changingSettings = false;
let committingProbe = false;
let configurationWrites: Promise<void> = Promise.resolve();
function serializeConfiguration<T>(write: () => Promise<T>): Promise<T> {
  const operation = configurationWrites.then(write);
  configurationWrites = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

async function vault(ignorePause = false): Promise<VaultRepository | undefined> {
  if (changingSettings || committingProbe) return undefined;
  const controller = networkController;
  if (!ignorePause && (await chrome.storage.local.get('syncPaused')).syncPaused === true)
    return undefined;
  const config = await readVaultConfig();
  if (!config) return undefined;
  if (!(await chrome.permissions.contains({ origins: [originPattern(config.endpoint)] })))
    return undefined;
  if (controller.signal.aborted) return undefined;
  const identity = JSON.stringify(config);
  if (vaultCache?.identity !== identity) {
    const client = createVaultClient(config, {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
        }),
    });
    vaultCache = { identity, client };
  }
  return vaultCache.client;
}
/** Why the last vault test failed. Session storage: trusted contexts only, cleared on restart. */
const VAULT_TEST_ERROR = 'vaultTestError';
/** The vault connection as the pages show it, paused by the same flag that gates sync. Never the key. */
async function vaultStatus(rememberKey: boolean): Promise<VaultStatus> {
  if (!(await readVaultConfig())) return { state: 'none', remembered: false };
  if ((await chrome.storage.local.get('syncPaused')).syncPaused !== true)
    return { state: 'syncing', remembered: rememberKey };
  const error: unknown = (await chrome.storage.session.get(VAULT_TEST_ERROR))[VAULT_TEST_ERROR];
  return {
    state: 'paused',
    remembered: rememberKey,
    ...(typeof error === 'string' && error ? { error: error.slice(0, 300) } : {}),
  };
}
function changed(record: CaptureRecord) {
  const update = { v: 1, type: 'CAPTURE_UPDATE', capture: publicCapture(record) };
  for (const arm of arms.values())
    if (arm.captureId === record.id)
      void chrome.tabs
        .sendMessage(arm.tabId, update, { documentId: arm.documentId })
        .catch(() => undefined);
}
const coordinator = createCoordinator({
  store,
  vault,
  embedder,
  features: async () => {
    const { features } = await readSettings();
    if (changingSettings)
      return {
        ...features,
        semantic: false,
        haunting: false,
        images: false,
        youtube: false,
        gaze: false,
      };
    return __CORE_ONLY__ ? { ...features, images: false, youtube: false, gaze: false } : features;
  },
  changed,
});
const handActivation = createHandActivation({
  allowedOrigin,
  onPause: () => {
    clearCapabilities();
    void embedder.dispose();
  },
});
let activationIntent = 0;
let activationRequest: {
  id: string;
  intent: number;
  at: number;
  /** Whether site access was already held, so no prompt could stand in for the popup. */
  held: Promise<boolean>;
} | null = null;
/** Chrome's site-access prompt is answered within this, or its request has lapsed. */
const ACTIVATION_PROMPT_MS = 120_000;
/** An activation finished on Chrome's grant, after the popup that began it had closed. */
let grantedActivation: { id: string; enabled: Promise<void> } | null = null;
let captureViewEpoch = 0;
const ready = Promise.all([secureStorage(), handActivation.ready]).then(async () => {
  if (!__CORE_ONLY__) await reconcileMediaOrigins();
  await coordinator.recoverPreparation();
  if (!(await chrome.alarms.get('resume-captures')))
    await chrome.alarms.create('resume-captures', { periodInMinutes: 1 });
});

function clearCapabilities() {
  for (const arm of arms.values()) {
    arm.cancelled = true;
    arm.controller.abort();
  }
  arms.clear();
  networkController.abort();
  networkController = new AbortController();
  vaultCache = undefined;
  coordinator.disableJobs();
}
function invalidateCaptureView() {
  // A window-scoped screenshot can resolve after switching away and back.
  // Revoke pending view work synchronously; already recorded evidence still syncs.
  captureViewEpoch += 1;
  for (const [token, arm] of arms) {
    arm.controller.abort();
    if (!arm.captureId) arms.delete(token);
  }
}
async function currentDocument(sender: chrome.runtime.MessageSender, pageUrl?: string) {
  if (handActivation.getMode() === 'paused') throw new Error('Zombie Hand is paused everywhere');
  if (
    sender.id !== chrome.runtime.id ||
    !sender.tab?.id ||
    sender.frameId !== 0 ||
    !sender.documentId ||
    (sender.documentLifecycle && sender.documentLifecycle !== 'active')
  )
    throw new Error('Capture must come from the enabled top-level page');
  const tab = await chrome.tabs.get(sender.tab.id);
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (
    active?.id !== tab.id ||
    !tab.url ||
    !(await allowedOrigin(tab.url)) ||
    (pageUrl !== undefined && tab.url !== pageUrl)
  )
    throw new Error('The active page changed or capture is disabled here');
  return { tabId: sender.tab.id, documentId: sender.documentId, pageUrl: tab.url };
}
function ownedArm(sender: chrome.runtime.MessageSender, token?: string, captureId?: string): Arm {
  const arm = token
    ? arms.get(token)
    : [...arms.values()].find((item) => item.captureId === captureId);
  if (!arm || arm.tabId !== sender.tab?.id || arm.documentId !== sender.documentId)
    throw new Error('Capture capability expired; use the graveyard to manage saved notes');
  return arm;
}
async function executeCapture(arm: Arm): Promise<void> {
  const id = arm.captureId;
  if (!id) return;
  try {
    if (
      !__CORE_ONLY__ &&
      arm.candidate.kind === 'image' &&
      (await readSettings()).features.images &&
      !arm.cancelled
    ) {
      const media = await preserveImage(
        arm.candidate,
        {
          download: downloadImage,
          snapshot: (rect, signal) =>
            cropSnapshot(arm.tabId, arm.documentId, arm.pageUrl, rect, signal),
        },
        arm.controller.signal,
      );
      if (
        !arm.cancelled &&
        !arm.controller.signal.aborted &&
        (await readSettings()).features.images
      ) {
        changed(
          await store.update(id, (record) =>
            arm.cancelled || arm.controller.signal.aborted || record.lifecycle !== 'active'
              ? record
              : {
                  ...record,
                  ...(media.asset ? { asset: media.asset } : {}),
                  preservation: media.preservation,
                  preparation: 'ready',
                  ...(media.message ? { lastError: media.message } : {}),
                },
          ),
        );
      }
    }
    const prepared = await store.get(id);
    if (prepared?.preparation === 'pending')
      await store.update(id, (record) => ({ ...record, preparation: 'ready' }));
    if (arm.cancelled) {
      const record = await store.get(id);
      if (record?.lifecycle === 'active') await coordinator.lifecycle(id, 'archived');
    }
    await coordinator.sync(id);
  } catch {
    const current = await store.get(id);
    if (current)
      changed(
        await store.update(id, (record) => ({
          ...record,
          preparation: 'ready',
          persistence: 'failed',
          lastError:
            'Capture processing was interrupted. The original evidence is retained locally; retry from the graveyard.',
        })),
      );
  }
}

const handSprites = new Map<number, Promise<string>>();
/** A packaged hand's frames, read from the extension origin so they never need to be web accessible. */
function readHandSprite(hand: number): Promise<string> {
  const known = handSprites.get(hand);
  if (known) return known;
  const entry = GRAVE_HANDS[hand];
  if (!entry) return Promise.reject(new Error('There is no such hand in the package.'));
  const read = fetch(chrome.runtime.getURL(entry.path))
    .then(async (response) => {
      if (!response.ok) throw new Error('The hand sprite is missing from the package.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 16384)
        binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
      return btoa(binary);
    })
    .catch((error: unknown) => {
      handSprites.delete(hand);
      throw error;
    });
  handSprites.set(hand, read);
  return read;
}

async function contentRequest(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<AppResponse> {
  if (changingSettings) throw new Error('Settings are changing; enable the hand again shortly.');
  const controller = networkController;
  const viewEpoch = captureViewEpoch;
  const message = contentMessageSchema.parse(raw);
  const context = await currentDocument(sender);
  switch (message.type) {
    case 'OPEN_SETTINGS':
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    case 'HAND_SPRITE':
      return { ok: true, sprite: await readHandSprite(message.hand) };
    case 'READ_PAGE':
      // The article reader is loaded only for a whole-page grab, into the very
      // document that asked, so other pages never carry its weight.
      await chrome.scripting.executeScript({
        target: { tabId: context.tabId, documentIds: [context.documentId] },
        files: ['page-reader.js'],
      });
      return { ok: true };
    case 'CONTENT_STATUS': {
      const settings = await readSettings();
      const features = __CORE_ONLY__
        ? { ...settings.features, images: false, youtube: false, gaze: false }
        : settings.features;
      return { ok: true, features, activation: handActivation.getMode() };
    }
    case 'ARM': {
      await currentDocument(sender, message.pageUrl);
      const settings = await readSettings();
      if (message.candidate.kind === 'image' && (__CORE_ONLY__ || !settings.features.images))
        throw new Error('Image capture is disabled');
      if (message.candidate.kind === 'youtube' && (__CORE_ONLY__ || !settings.features.youtube))
        throw new Error('YouTube capture is disabled');
      if (changingSettings || controller.signal.aborted || viewEpoch !== captureViewEpoch)
        throw new Error('Page capability changed while arming.');
      for (const [token, arm] of arms)
        if (arm.tabId === context.tabId && !arm.captureId) {
          arm.controller.abort();
          arms.delete(token);
        }
      const token = crypto.randomUUID();
      arms.set(token, {
        token,
        ...context,
        candidate: message.candidate,
        expires: Date.now() + 30000,
        cancelled: false,
        controller: new AbortController(),
      });
      return { ok: true, token };
    }
    case 'CAPTURE': {
      const arm = ownedArm(sender, message.token);
      await currentDocument(sender, arm.pageUrl);
      if (arm.cancelled || arm.expires < Date.now())
        throw new Error('Capture expired or was cancelled');
      if (arm.captureId) {
        if (arm.captureId !== message.operationId)
          throw new Error('This capture was already confirmed');
        const record = await store.get(arm.captureId);
        return record
          ? { ok: true, capture: publicCapture(record) }
          : { ok: false, error: 'Capture is being recorded; retry shortly' };
      }
      if (message.videoSeconds !== undefined && !arm.candidate.video)
        throw new Error('Timestamp requires a video target');
      if (reservedCaptureIds.has(message.operationId))
        throw new Error('Capture identity already in use');
      reservedCaptureIds.add(message.operationId);
      try {
        if (await store.get(message.operationId))
          throw new Error('A new capture must use a new identity');
      } catch (error) {
        reservedCaptureIds.delete(message.operationId);
        throw error;
      }
      if (arm.cancelled || arm.controller.signal.aborted || changingSettings) {
        reservedCaptureIds.delete(message.operationId);
        throw new Error('Capture capability was revoked');
      }
      const seconds = message.videoSeconds;
      if (seconds !== undefined && arm.candidate.video) {
        arm.candidate.video.seconds = seconds;
        const url = new URL(arm.candidate.url);
        url.searchParams.set('t', `${Math.floor(seconds)}s`);
        arm.candidate.url = url.href;
        arm.candidate.text = arm.candidate.video.transcript.cues
          .filter((cue) => cue.start >= Math.max(0, seconds - 30) && cue.start <= seconds + 60)
          .map(
            (cue) =>
              `[${Math.floor(cue.start / 60)}:${String(Math.floor(cue.start % 60)).padStart(2, '0')}] ${cue.text}`,
          )
          .join('\n')
          .slice(0, 32000);
      }
      arm.captureId = message.operationId;
      let record: CaptureRecord;
      try {
        record = await coordinator.capture(
          arm.candidate,
          message.operationId,
          undefined,
          undefined,
          arm.candidate.kind === 'image',
        );
      } finally {
        reservedCaptureIds.delete(message.operationId);
      }
      if (arm.cancelled) await coordinator.lifecycle(record.id, 'archived');
      void executeCapture(arm);
      return { ok: true, capture: publicCapture(record) };
    }
    case 'CANCEL': {
      const arm = ownedArm(sender, message.token);
      if (message.operationId && arm.captureId && message.operationId !== arm.captureId)
        throw new Error('Cancellation identity mismatch');
      arm.cancelled = true;
      arm.controller.abort();
      const record = arm.captureId ? await store.get(arm.captureId) : undefined;
      return record
        ? { ok: true, capture: publicCapture(await coordinator.lifecycle(record.id, 'archived')) }
        : { ok: true, message: 'Capture cancelled' };
    }
    case 'ARCHIVE': {
      const arm = ownedArm(sender, undefined, message.captureId);
      arm.cancelled = true;
      arm.controller.abort();
      return {
        ok: true,
        capture: publicCapture(await coordinator.lifecycle(message.captureId, 'archived')),
      };
    }
    case 'GET_CAPTURE': {
      ownedArm(sender, undefined, message.captureId);
      const record = await store.get(message.captureId);
      return record
        ? { ok: true, capture: publicCapture(record) }
        : { ok: false, error: 'Capture not found' };
    }
    case 'SEARCH': {
      if (!(await readSettings()).features.haunting) return { ok: true, results: [] };
      // A ghost is never the page itself, so notes grabbed here cannot fill the cut.
      const results = await coordinator.search(
        message.query,
        (item) => item.capture.candidate.url !== context.pageUrl && haunts(item),
      );
      await currentDocument(sender, context.pageUrl);
      if (!(await readSettings()).features.haunting) return { ok: true, results: [] };
      return { ok: true, results: results.slice(0, 3) };
    }
  }
}
async function trustedRequest(raw: unknown): Promise<AppResponse> {
  const message = trustedMessageSchema.parse(raw);
  switch (message.type) {
    case 'GET_STATE': {
      const settings = await readSettings();
      return {
        ok: true,
        activation: handActivation.getMode(),
        settings,
        vaultStatus: await vaultStatus(settings.rememberKey),
        captures: (await store.list()).map(publicCapture),
      };
    }
    case 'BEGIN_ACTIVATION':
      activationRequest = {
        id: crypto.randomUUID(),
        intent: ++activationIntent,
        at: Date.now(),
        held: chrome.permissions.contains({ origins: [...universalPageOrigins] }).catch(() => true),
      };
      return { ok: true, activationRequest: activationRequest.id };
    case 'SET_ACTIVATION':
      if (message.enabled) {
        // A popup that survived the prompt waits for the grant's own activation to finish.
        const granted = grantedActivation;
        if (message.requestId !== undefined && message.requestId === granted?.id) {
          await granted.enabled;
          if (handActivation.getMode() === 'universal')
            return { ok: true, activation: 'universal' };
        }
        if (
          !activationRequest ||
          message.requestId !== activationRequest.id ||
          activationRequest.intent !== activationIntent
        )
          throw new Error('Activation request was superseded. Enable the hand again.');
        activationRequest = null;
        await handActivation.enable();
      } else {
        activationIntent += 1;
        activationRequest = null;
        await handActivation.pause();
      }
      return { ok: true, activation: handActivation.getMode() };
    case 'GRANT_MEDIA_ORIGIN':
      if (__CORE_ONLY__) throw new Error('Original image downloads are absent from this build');
      await authorizeMediaOrigin(message.origin);
      return { ok: true };
    case 'REVOKE_MEDIA_ORIGIN': {
      if (__CORE_ONLY__) throw new Error('Original image downloads are absent from this build');
      const revoked = revokeMediaOrigin(message.origin);
      clearCapabilities();
      await revoked;
      return { ok: true };
    }
    case 'EXPORT_RECORDS':
      return { ok: true, exportRecords: await store.exportRecords() };
    case 'SAVE_SETTINGS': {
      if (changingSettings) throw new Error('Another settings change is in progress.');
      changingSettings = true;
      clearCapabilities();
      try {
        await serializeConfiguration(async () => {
          const previous = await readSettings();
          // Persist the pause before changing credentials or destination, including across worker termination.
          if (
            previous.endpoint !== message.settings.endpoint ||
            previous.folder !== message.settings.folder ||
            message.apiKey
          ) {
            await chrome.storage.local.set({ syncPaused: true });
            // A failed test of the old destination or key says nothing about the new one.
            await chrome.storage.session.remove(VAULT_TEST_ERROR);
          }
          await writeSettings(message.settings, message.apiKey);
        });
        if (!message.settings.features.semantic) await embedder.dispose();
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs)
          if (tab.id)
            void chrome.tabs
              .sendMessage(tab.id, {
                v: 1,
                type:
                  tab.url && message.settings.excludedOrigins.includes(new URL(tab.url).origin)
                    ? 'DEACTIVATE'
                    : 'SETTINGS_CHANGED',
                features: message.settings.features,
              })
              .catch(() => undefined);
        return {
          ok: true,
          message: 'Settings saved. Test the connection before syncing to a changed vault.',
        };
      } finally {
        changingSettings = false;
      }
    }
    case 'FORGET_KEY':
      if (changingSettings) throw new Error('Another settings change is in progress.');
      changingSettings = true;
      try {
        clearCapabilities();
        await serializeConfiguration(forgetKey);
        return { ok: true, message: 'Vault key forgotten' };
      } finally {
        changingSettings = false;
      }
    case 'PROBE_VAULT': {
      const controller = networkController;
      const client = await vault(true);
      if (!client)
        throw new Error('Enter a vault key and grant access to the loopback endpoint first.');
      const probe = await client.probe();
      if (!probe.ok) {
        await serializeConfiguration(async () => {
          // A test of settings since replaced must not name its failure against the new ones.
          if (!controller.signal.aborted && !changingSettings)
            await chrome.storage.session.set({ [VAULT_TEST_ERROR]: probe.message });
        });
        return { ok: false, error: probe.message };
      }
      await serializeConfiguration(async () => {
        if (controller.signal.aborted || changingSettings)
          throw new Error(
            'Vault configuration changed during the test. Test the current endpoint again.',
          );
        committingProbe = true;
        try {
          await chrome.storage.session.remove(VAULT_TEST_ERROR);
          await chrome.storage.local.set({ syncPaused: false });
          if (controller.signal.aborted || changingSettings) {
            await chrome.storage.local.set({ syncPaused: true });
            throw new Error(
              'Vault configuration changed during the test. Test the current endpoint again.',
            );
          }
        } finally {
          committingProbe = false;
        }
      });
      if (controller.signal.aborted || changingSettings)
        throw new Error('Vault configuration changed during the test.');
      void coordinator.drain(true);
      return { ok: true, message: probe.message };
    }
    case 'RETRY':
      await coordinator.drain(true);
      return { ok: true, message: 'Retry completed; inspect each capture’s save status.' };
    case 'IMPORT_VAULT': {
      const imported = await coordinator.importVault();
      return {
        ok: true,
        message:
          imported.message ??
          `Imported ${imported.count} new captures; skipped ${imported.skipped} unsupported or inconsistent records.`,
      };
    }
    case 'IMPORT_TRANSCRIPT': {
      if (!__CORE_ONLY__) {
        const controller = networkController;
        const settings = await readSettings();
        if (changingSettings || controller.signal.aborted || !settings.features.youtube)
          return { ok: false, error: 'Enable YouTube moments in Settings before importing.' };
        const id = youtubeVideoId(message.url);
        if (!id || settings.excludedOrigins.includes(new URL(message.url).origin))
          return { ok: false, error: 'Use an allowed HTTPS YouTube watch URL.' };
        let transcript: CaptureCandidate['video'];
        try {
          transcript = {
            id,
            seconds: message.seconds,
            transcript: parseImportedTranscript(message.text),
          };
        } catch {
          return {
            ok: false,
            error:
              'Paste a bounded WebVTT, SRT, or timestamped transcript. Untimed text cannot supply cue times.',
          };
        }
        const candidate: CaptureCandidate = {
          kind: 'youtube',
          title: message.title,
          url: `https://www.youtube.com/watch?v=${id}&t=${Math.floor(message.seconds)}s`,
          text: transcript.transcript.cues
            .filter(
              (cue) =>
                cue.start >= Math.max(0, message.seconds - 30) && cue.start <= message.seconds + 60,
            )
            .map((cue) => cue.text)
            .join(' ')
            .slice(0, 32000),
          video: transcript,
        };
        const record = await coordinator.capture(candidate, message.operationId);
        if (controller.signal.aborted || changingSettings)
          return {
            ok: true,
            capture: publicCapture(record),
            message:
              'Transcript retained locally. Settings changed before immediate sync; inspect its status in the graveyard.',
          };
        void coordinator.sync(record.id);
        return {
          ok: true,
          capture: publicCapture(record),
          message: `Imported ${transcript.transcript.cues.length} timestamped cues. Check the capture’s vault save status below.`,
        };
      }
      return { ok: false, error: 'YouTube imports are unavailable in the core build.' };
    }
    case 'SET_LIFECYCLE':
      return {
        ok: true,
        capture: publicCapture(await coordinator.lifecycle(message.captureId, message.lifecycle)),
      };
    case 'SEARCH':
      return { ok: true, results: await coordinator.search(message.query) };
    case 'PREPARE_MODEL': {
      const controller = networkController;
      if (
        changingSettings ||
        !(await readSettings()).features.semantic ||
        controller.signal.aborted
      )
        throw new Error('Enable local semantic search first');
      await embedder.prepare(controller.signal);
      if (controller.signal.aborted || changingSettings)
        throw new Error('Local semantic search was disabled while preparing.');
      void coordinator.drain(true);
      return { ok: true, message: 'Local semantic model is ready. No API key is used.' };
    }
    case 'GRAB_ACTIVE_TAB': {
      // Opening the popup was the toolbar gesture that granted activeTab here.
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id === undefined) return { ok: false, error: 'There is no page to grab from.' };
      if (handActivation.getMode() === 'paused')
        return { ok: false, error: 'Zombie Hand is paused everywhere. Turn it on to grab.' };
      await handActivation.wake(tab.id, true);
      const reply = (await chrome.tabs
        .sendMessage(tab.id, { v: 1, type: 'GRAB', kind: message.kind }, { frameId: 0 })
        .catch(() => undefined)) as Partial<AppResponse> | undefined;
      if (!reply)
        return {
          ok: false,
          error:
            'Zombie Hand cannot reach this page. Browser pages, the Web Store and excluded sites are off limits.',
        };
      // The page's copy of the script reports in its own words; they stay plain text.
      return reply.ok === false && typeof reply.error === 'string'
        ? { ok: false, error: reply.error.slice(0, 300) }
        : { ok: true };
    }
  }
}
chrome.runtime.onMessage.addListener(
  (raw: unknown, sender, respond: (response: AppResponse) => void) => {
    void (async () => {
      await ready;
      if (sender.id !== chrome.runtime.id || !boundedMessage(raw))
        throw new Error('Invalid message source or message too large');
      const trustedPages = ['options.html', 'graveyard.html', 'popup.html'].map((path) =>
        chrome.runtime.getURL(path),
      );
      const trusted =
        !!sender.url && trustedPages.includes(sender.url.split('?')[0]?.split('#')[0] ?? '');
      return trusted ? trustedRequest(raw) : contentRequest(raw, sender);
    })().then(respond, () =>
      respond({
        ok: false,
        error:
          'The request was rejected or could not complete. Check the page, permissions and Settings, then retry.',
      }),
    );
    return true;
  },
);
// Chrome's site-access prompt can close the toolbar popup that asked for it, and
// the popup's own SET_ACTIVATION with it. The grant finishes the activation it began.
chrome.permissions.onAdded.addListener(() => {
  const pending = activationRequest;
  if (!pending) return;
  const current = () => activationRequest === pending && pending.intent === activationIntent;
  void ready
    .then(async () => {
      // Only a recent prompt for access not already held can have been answered by this grant.
      if (!current() || Date.now() - pending.at > ACTIVATION_PROMPT_MS) return;
      if (await pending.held) return;
      if (!(await chrome.permissions.contains({ origins: [...universalPageOrigins] }))) return;
      if (!current()) return;
      activationRequest = null;
      const enabled = handActivation.enable();
      grantedActivation = { id: pending.id, enabled };
      await enabled;
    })
    .catch(() => undefined);
});
void ready.then(() => handActivation.refresh()).catch(() => undefined);
chrome.tabs.onActivated.addListener(({ tabId }) => {
  invalidateCaptureView();
  void ready.then(() => handActivation.wake(tabId)).catch(() => undefined);
});
chrome.windows.onFocusChanged.addListener(() => invalidateCaptureView());
chrome.runtime.onInstalled.addListener(() => {
  void ready.then(() => chrome.alarms.create('resume-captures', { periodInMinutes: 1 }));
});
chrome.runtime.onStartup.addListener(() => {
  void ready.then(() => coordinator.drain()).catch(() => undefined);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'resume-captures')
    void ready.then(() => coordinator.drain()).catch(() => undefined);
});
chrome.permissions.onRemoved.addListener(() => {
  if (!__CORE_ONLY__) void reconcileMediaOrigins().catch(() => undefined);
  activationIntent += 1;
  void handActivation.pause().catch(() => undefined);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [token, arm] of arms)
    if (arm.tabId === tabId) {
      arm.controller.abort();
      arms.delete(token);
    }
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'complete')
    void ready.then(() => handActivation.wake(tabId)).catch(() => undefined);
  if (change.url || change.status === 'loading')
    for (const [token, arm] of arms)
      if (arm.tabId === tabId && (change.status === 'loading' || arm.pageUrl !== change.url)) {
        arm.controller.abort();
        arms.delete(token);
      }
});
