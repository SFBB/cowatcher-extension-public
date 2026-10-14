/**
 * Generic Browser Storage Repository Interface.
 * Decouples domain and application logic from browser-specific APIs (chrome.storage, browser.storage).
 */
export interface IBrowserStorage {
  get<T>(keys?: string | string[] | null): Promise<Record<string, T>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
  onChanged(
    listener: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void
  ): () => void;
}
