import "@testing-library/jest-dom/vitest";

// In this Node/jsdom/vitest combination, the ambient `localStorage` global
// is an inert stub (missing getItem/setItem/etc.) rather than jsdom's own
// Storage implementation — likely Node's native Web Storage API waiting on
// a --localstorage-file path that test runs never provide. Install a small
// in-memory Storage so app code that reads/writes localStorage behaves the
// same under test as it does in a real browser.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

if (typeof localStorage === "undefined" || typeof localStorage.setItem !== "function") {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true, writable: true });
}
