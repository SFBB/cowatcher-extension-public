import { ITrackCacheRepository } from '@shared/domain/repositories/ITrackCacheRepository';
import { ChromeCacheRepository } from './ChromeCacheRepository';

export type CacheRepositoryDriverType = 'indexeddb';

export class TrackCacheRepositoryFactory {
    private static defaultInstance: ITrackCacheRepository | null = null;

    static getRepository(
        driver: CacheRepositoryDriverType = 'indexeddb',
    ): ITrackCacheRepository {
        if (driver === 'indexeddb') {
            if (!this.defaultInstance) {
                this.defaultInstance = ChromeCacheRepository.getInstance();
            }
            return this.defaultInstance;
        }
        throw new Error(`Unsupported cache repository driver: ${driver}`);
    }
}
