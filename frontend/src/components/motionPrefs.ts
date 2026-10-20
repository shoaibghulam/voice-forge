/** prefers-reduced-motion as a live React value, plus a requestAnimationFrame loop hook. */
import { useEffect, useRef, useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const list = window.matchMedia(QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(QUERY).matches;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Calls `onFrame(dtSeconds)` every animation frame while `isActive`. */
export function useAnimationFrame(onFrame: (dt: number) => void, isActive = true): void {
  const callback = useRef(onFrame);
  callback.current = onFrame;
  useEffect(() => {
    if (!isActive || typeof requestAnimationFrame !== 'function') return undefined;
    let id = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      callback.current(dt);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [isActive]);
}
