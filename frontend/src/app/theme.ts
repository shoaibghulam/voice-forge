/** Theme preference: follow the system, or force light/dark via `data-theme` on <html>. */
export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'mt.theme';

export function readTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    if (choice === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch {
    // storage unavailable (private mode): the choice still applies for this visit
  }
  window.dispatchEvent(new CustomEvent('mt:themechange'));
}

export function nextTheme(choice: ThemeChoice): ThemeChoice {
  if (choice === 'system') return 'light';
  if (choice === 'light') return 'dark';
  return 'system';
}
