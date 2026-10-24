import { IStreamingAdapter } from './IStreamingAdapter';

export class StreamingAdapterRegistry {
    private static adapters: IStreamingAdapter[] = [];

    static register(adapter: IStreamingAdapter): void {
        const exists = this.adapters.some(
            (a) => a.platformName === adapter.platformName,
        );
        if (!exists) {
            this.adapters.push(adapter);
        }
    }

    static getMatchingAdapter(
        url: string = window.location.href,
    ): IStreamingAdapter | null {
        for (const adapter of this.adapters) {
            if (adapter.matches(url)) {
                return adapter;
            }
        }
        return null;
    }

    static getAll(): IStreamingAdapter[] {
        return [...this.adapters];
    }
}
