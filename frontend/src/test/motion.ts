/** Shared flag for the matchMedia stub in setup.ts: tests flip prefers-reduced-motion here. */
let reducedMotion = false;

export function setReducedMotion(value: boolean): void {
  reducedMotion = value;
}

export function isReducedMotion(): boolean {
  return reducedMotion;
}
