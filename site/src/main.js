import './style.css';

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
const freezeAt = params.has('t') ? Math.min(Math.max(Number(params.get('t')) || 0, 0), 64) : null;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function webglAvailable() {
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

function setPausedUi(paused) {
  toggle.classList.toggle('is-paused', paused);
  toggle.querySelector('.motion-label').textContent = paused ? 'Play' : 'Pause';
}

const nav = document.querySelector('.nav');
const hero = document.querySelector('.hero');
// The strip between the nav and the hero copy, where the hand should play on a portrait screen.
const openBand = () => ({ top: nav.offsetTop + nav.offsetHeight, bottom: hero.offsetTop });

if (!webglAvailable()) {
  stage.classList.add('no-webgl');
  toggle.hidden = true;
} else {
  try {
    const { startScene } = await import('./scene/index.js');
    const scene = await startScene(canvas, {
      // Reduced motion opens on the hand coiled over the letter, standing still.
      startAt: freezeAt ?? (reducedMotion ? 6.9 : 0),
      paused: freezeAt !== null || reducedMotion,
      openBand,
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
