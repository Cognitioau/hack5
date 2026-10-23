import './style.css';
import { DOWNLOAD_URL } from './config.js';

for (const link of document.querySelectorAll('[data-download]')) link.href = DOWNLOAD_URL;

const dialog = document.querySelector('dialog.install');
for (const button of document.querySelectorAll('[data-open-install]')) {
  button.addEventListener('click', () => dialog.showModal());
}
document.querySelector('[data-close-install]').addEventListener('click', () => dialog.close());
// A click on the dimmed backdrop lands on the dialog element itself.
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

const stage = document.querySelector('.stage');
const canvas = document.querySelector('#scene');
const toggle = document.querySelector('[data-motion-toggle]');
const params = new URLSearchParams(location.search);
const freezeAt = params.has('t') ? Number(params.get('t')) : null;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function webglAvailable() {
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

function setPausedUi(paused) {
  toggle.setAttribute('aria-pressed', String(paused));
  toggle.querySelector('.motion-label').textContent = paused ? 'Play' : 'Pause';
}

if (!webglAvailable()) {
  stage.classList.add('no-webgl');
  toggle.hidden = true;
} else {
  const { startScene } = await import('./scene/index.js');
  try {
    const scene = await startScene(canvas, {
      // Reduced motion opens on the moment the hand has the letter, standing still.
      startAt: freezeAt ?? (reducedMotion ? 7.6 : 0),
      paused: freezeAt !== null || reducedMotion,
      onReady: () => {
        stage.classList.add('ready');
        window.__sceneReady = true;
      },
    });
    setPausedUi(scene.paused());
    toggle.hidden = freezeAt !== null;
    toggle.addEventListener('click', () => {
      scene.setPaused(!scene.paused());
      setPausedUi(scene.paused());
    });
  } catch (error) {
    console.error(error);
    stage.classList.add('no-webgl');
    toggle.hidden = true;
  }
}
