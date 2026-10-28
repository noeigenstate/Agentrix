import type { Settings } from './types';

// The app's own animation setting decides motion. Windows reports "reduced motion" whenever its
// "Animation effects" switch is off, which would otherwise silence breathing lights and zooms
// that the user never asked to remove, so the default ignores the system preference.
export function applyMotion(mode: Settings['focusAnimation']) { document.documentElement.dataset.motion = mode; }

export function motionReduced() {
  const mode = document.documentElement.dataset.motion;
  return mode === 'off' || mode === 'system' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// CSS stops its own animations; imperative motion also has to react while it is running.
export function observeMotion(change: () => void) {
  const observer = new MutationObserver(change);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  preference.addEventListener('change', change);
  return () => { observer.disconnect(); preference.removeEventListener('change', change); };
}
