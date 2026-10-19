/**
 * Games saved in sessionStorage, so that reloading the page resumes them. sessionStorage is per tab, so two tabs of one
 * browser can play both sides of an online game without overwriting each other; closing the tab forgets the game (an
 * online game then catches up from the opponent).
 */

/** The value saved under `key`, or undefined (nothing saved, unreadable, or storage disabled). */
export function load<T>(key: string): T | undefined {
  try {
    const raw = sessionStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

/** Saves `value` under `key` (silently does nothing when storage is full or disabled); undefined removes it. */
export function save(key: string, value: unknown) {
  try {
    if (value === undefined) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is full or disabled: the game still plays, it just won't survive a reload.
  }
}

/** A random 32-bit dice seed. */
export const randomSeed = () => Math.floor(Math.random() * 2 ** 32);
