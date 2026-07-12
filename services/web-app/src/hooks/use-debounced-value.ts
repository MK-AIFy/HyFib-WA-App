import { useEffect, useState } from "react";

/**
 * Returns `value`, but delayed by `delayMs` of no further changes — the
 * classic search-box debounce. The caller keeps its own immediate state for
 * a responsive input (bind that directly to the `<Input>`), and only reads
 * this debounced value where it's expensive to react to every keystroke
 * (e.g. as a query-hook argument that triggers a network request).
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
