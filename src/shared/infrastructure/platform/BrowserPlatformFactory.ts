import { IBrowserPlatform } from './IBrowserPlatform';
import { ChromePlatformAdapter } from './ChromePlatformAdapter';

export type PlatformDriverType = 'chrome';

export class BrowserPlatformFactory {
  private static defaultInstance: IBrowserPlatform | null = null;

  static getPlatform(driver: PlatformDriverType = 'chrome'): IBrowserPlatform {
    if (driver === 'chrome') {
      if (!this.defaultInstance) {
        this.defaultInstance = ChromePlatformAdapter.getInstance();
      }
      return this.defaultInstance;
    }
    throw new Error(`Unsupported platform driver: ${driver}`);
  }
}
