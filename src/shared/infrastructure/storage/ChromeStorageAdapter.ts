import { IBrowserStorage } from './IBrowserStorage';

/**
 * Chrome Extension Storage Implementation of IBrowserStorage.
 */
export class ChromeStorageAdapter implements IBrowserStorage {
    private static instance: ChromeStorageAdapter | null = null;

    static getInstance(): ChromeStorageAdapter {
        if (!ChromeStorageAdapter.instance) {
            ChromeStorageAdapter.instance = new ChromeStorageAdapter();
        }
        return ChromeStorageAdapter.instance;
    }

    async get<T>(keys?: string | string[] | null): Promise<Record<string, T>> {
        return new Promise((resolve) => {
            if (
                typeof chrome === 'undefined' ||
                !chrome.storage ||
                !chrome.storage.local
            ) {
                resolve({});
                return;
            }
            chrome.storage.local.get(keys ?? null, (res) => {
                resolve((res || {}) as Record<string, T>);
            });
        });
    }

    async set(items: Record<string, unknown>): Promise<void> {
        return new Promise((resolve) => {
            if (
                typeof chrome === 'undefined' ||
                !chrome.storage ||
                !chrome.storage.local
            ) {
                resolve();
                return;
            }
            chrome.storage.local.set(items, () => {
                resolve();
            });
        });
    }

    async remove(keys: string | string[]): Promise<void> {
        return new Promise((resolve) => {
            if (
                typeof chrome === 'undefined' ||
                !chrome.storage ||
                !chrome.storage.local
            ) {
                resolve();
                return;
            }
            chrome.storage.local.remove(keys, () => {
                resolve();
            });
        });
    }

    async clear(): Promise<void> {
        return new Promise((resolve) => {
            if (
                typeof chrome === 'undefined' ||
                !chrome.storage ||
                !chrome.storage.local
            ) {
                resolve();
                return;
            }
            chrome.storage.local.clear(() => {
                resolve();
            });
        });
    }

    onChanged(
        listener: (
            changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
        ) => void,
    ): () => void {
        if (
            typeof chrome === 'undefined' ||
            !chrome.storage ||
            !chrome.storage.onChanged
        ) {
            return () => {};
        }

        const callback = (
            changes: { [key: string]: chrome.storage.StorageChange },
            areaName: string,
        ) => {
            if (areaName === 'local') {
                listener(changes);
            }
        };

        chrome.storage.onChanged.addListener(callback);
        return () => chrome.storage.onChanged.removeListener(callback);
    }
}
