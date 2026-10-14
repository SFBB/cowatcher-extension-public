import { IInjectedAdapter } from './IInjectedAdapter';

export class InjectedAdapterRegistry {
  private static adapters: IInjectedAdapter[] = [];

  static register(adapter: IInjectedAdapter): void {
    const exists = this.adapters.some((a) => a.platformId === adapter.platformId);
    if (!exists) {
      this.adapters.push(adapter);
    }
  }

  static getMatchingAdapter(url: string = window.location.href): IInjectedAdapter | null {
    for (const adapter of this.adapters) {
      if (adapter.matches(url)) {
        return adapter;
      }
    }
    return null;
  }

  static getAll(): IInjectedAdapter[] {
    return [...this.adapters];
  }
}
