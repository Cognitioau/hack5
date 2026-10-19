import { describe, expect, it, vi } from 'vitest';
import {
  GazeCamera,
  type CameraEnvironment,
  type FaceDetector,
} from '../../src/adapters/gaze/camera';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture(streamPromise?: Promise<MediaStream>) {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const detector: FaceDetector = { detectForVideo: () => ({ faceLandmarks: [] }), close: vi.fn() };
  const video = {
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    srcObject: null,
    readyState: 4,
  } as unknown as HTMLVideoElement;
  const environment: CameraEnvironment = {
    detector: vi.fn(async () => detector),
    stream: vi.fn(() => streamPromise ?? Promise.resolve(stream)),
    requestFrame: vi.fn(() => 7),
    cancelFrame: vi.fn(),
  };
  const onError = vi.fn();
  const camera = new GazeCamera(video, vi.fn(), onError, environment);
  return { camera, track, stream, detector, video, environment, onError };
}
describe('explicit camera ownership', () => {
  it('does not acquire a camera until started, and stops tracks plus model on Stop', async () => {
    const test = fixture();
    expect(test.environment.stream).not.toHaveBeenCalled();
    await test.camera.start();
    expect(test.video.srcObject).toBe(test.stream);
    test.camera.stop();
    expect(test.track.stop).toHaveBeenCalledOnce();
    expect(test.detector.close).toHaveBeenCalledOnce();
    expect(test.environment.cancelFrame).toHaveBeenCalledWith(7);
    expect(test.video.srcObject).toBeNull();
  });
  it('closes a late camera grant after the user has already stopped', async () => {
    const pending = deferred<MediaStream>();
    const test = fixture(pending.promise);
    const started = test.camera.start();
    await Promise.resolve();
    test.camera.stop();
    pending.resolve(test.stream);
    await started;
    expect(test.track.stop).toHaveBeenCalledOnce();
    expect(test.video.play).not.toHaveBeenCalled();
    expect(test.video.srcObject).toBeNull();
  });
  it('releases the model if camera permission fails', async () => {
    const test = fixture();
    vi.mocked(test.environment.stream).mockRejectedValueOnce(
      new DOMException('Permission denied', 'NotAllowedError'),
    );
    await expect(test.camera.start()).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(test.detector.close).toHaveBeenCalledOnce();
    expect(test.video.srcObject).toBeNull();
  });
  it('releases frames, model and video when camera access ends externally', async () => {
    const test = fixture();
    await test.camera.start();
    test.track.dispatchEvent(new Event('ended'));
    expect(test.detector.close).toHaveBeenCalledOnce();
    expect(test.environment.cancelFrame).toHaveBeenCalledWith(7);
    expect(test.video.srcObject).toBeNull();
    expect(test.onError).toHaveBeenCalledOnce();
    test.track.dispatchEvent(new Event('ended'));
    expect(test.onError).toHaveBeenCalledOnce();
  });
});
