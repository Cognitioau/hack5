export type FacePoint = { x: number; y: number; z: number };
export interface FaceDetector {
  detectForVideo(video: HTMLVideoElement, time: number): { faceLandmarks: FacePoint[][] };
  close(): void;
}
export interface CameraEnvironment {
  detector(): Promise<FaceDetector>;
  stream(): Promise<MediaStream>;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
}

const browserEnvironment = (): CameraEnvironment => ({
  async detector() {
    const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
    const files = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('gaze-runtime'));
    return FaceLandmarker.createFromOptions(files, {
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL(
          'models/mediapipe-face-landmarker/face_landmarker.task',
        ),
        delegate: 'CPU',
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
    });
  },
  stream: () =>
    navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    }),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
});

/** Explicitly started, visible-page camera owner. Never records or persists frames. */
export class GazeCamera {
  private epoch = 0;
  private detector: FaceDetector | undefined;
  private stream: MediaStream | undefined;
  private frame: number | undefined;
  private trackListeners: AbortController | undefined;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onFrame: (points: readonly FacePoint[], timestamp: number) => void,
    private readonly onError: (error: unknown) => void,
    private readonly environment: CameraEnvironment = browserEnvironment(),
  ) {}

  async start(): Promise<void> {
    this.stop();
    const epoch = this.epoch;
    let detector: FaceDetector | undefined;
    let stream: MediaStream | undefined;
    try {
      detector = await this.environment.detector();
      if (epoch !== this.epoch) {
        detector.close();
        return;
      }
      this.detector = detector;
      stream = await this.environment.stream();
      if (epoch !== this.epoch) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      this.trackListeners = new AbortController();
      for (const track of stream.getTracks())
        track.addEventListener(
          'ended',
          () => {
            if (epoch !== this.epoch) return;
            this.stop();
            this.onError(new Error('Camera access ended. Start again to recalibrate.'));
          },
          { signal: this.trackListeners.signal },
        );
      this.video.srcObject = stream;
      await this.video.play();
      if (epoch !== this.epoch) return;
      let last = -Infinity;
      const frame: FrameRequestCallback = (timestamp) => {
        if (epoch !== this.epoch) return;
        try {
          if (timestamp - last >= 80 && this.video.readyState >= 2) {
            last = timestamp;
            this.onFrame(
              detector?.detectForVideo(this.video, timestamp).faceLandmarks[0] ?? [],
              timestamp,
            );
          }
          this.frame = this.environment.requestFrame(frame);
        } catch (error) {
          this.stop();
          this.onError(error);
        }
      };
      this.frame = this.environment.requestFrame(frame);
    } catch (error) {
      if (epoch === this.epoch) {
        this.stop();
        throw error;
      }
      // A Stop during an outstanding permission request still closes a subsequently returned stream.
      for (const track of stream?.getTracks() ?? []) track.stop();
    }
  }

  stop(): void {
    this.epoch++;
    if (this.frame !== undefined) this.environment.cancelFrame(this.frame);
    this.frame = undefined;
    this.trackListeners?.abort();
    this.trackListeners = undefined;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
    this.video.pause();
    this.video.srcObject = null;
    this.detector?.close();
    this.detector = undefined;
  }
}
