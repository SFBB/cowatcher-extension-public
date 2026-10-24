import { IBrowserStorage } from './IBrowserStorage';
import { ChromeStorageAdapter } from './ChromeStorageAdapter';

export type StorageDriverType = 'chrome';

export class BrowserStorageFactory {
    private static defaultInstance: IBrowserStorage | null = null;

    static getStorage(driver: StorageDriverType = 'chrome'): IBrowserStorage {
        if (driver === 'chrome') {
            if (!this.defaultInstance) {
                this.defaultInstance = ChromeStorageAdapter.getInstance();
            }
            return this.defaultInstance;
        }
        throw new Error(`Unsupported storage driver: ${driver}`);
    }
}
