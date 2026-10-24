import { Logger } from '@shared/utils/logger';
import {
    IAdDetector,
    AdDetectorOptions,
} from '../../../domain/adapters/IAdDetector';
import { NCW_MESSAGE_TYPES } from '@shared/domain/constants/MessageTypes';

export type { IAdDetector, AdDetectorOptions };

export class NetflixAdDetector implements IAdDetector {
    readonly onAdStart: () => void;
    readonly onAdEnd: () => void;
    isAdPlaying: boolean = false;
    private messageListener: ((e: MessageEvent) => void) | null = null;

    logger: Logger = new Logger('NetflixAdDetector');

    constructor(options: AdDetectorOptions = {}) {
        this.onAdStart = options.onAdStart || (() => {});
        this.onAdEnd = options.onAdEnd || (() => {});
    }

    startMonitoring(): void {
        this.stopMonitoring();

        // Listen strictly to authoritative player isAd state emitted from injected KadmiumPlayerBridge
        this.messageListener = (event: MessageEvent) => {
            if (event.source !== window || !event.data) return;
            if (event.data.type === NCW_MESSAGE_TYPES.AD_STATE_CHANGED) {
                this.setAuthoritativeAdState(Boolean(event.data.isAd));
            }
        };
        window.addEventListener('message', this.messageListener);
    }

    stopMonitoring(): void {
        if (this.messageListener) {
            window.removeEventListener('message', this.messageListener);
            this.messageListener = null;
        }
    }

    reset(): void {
        this.isAdPlaying = false;
    }

    private setAuthoritativeAdState(isAd: boolean): void {
        if (isAd === this.isAdPlaying) return;

        if (isAd) {
            this.isAdPlaying = true;
            this.logger.info(
                'Netflix-Ad',
                'Player API reported Ad start. Hiding subtitles.',
            );
            try {
                this.onAdStart();
            } catch (e) {
                this.logger.error(
                    'Netflix-Ad',
                    'Error in onAdStart callback:',
                    e,
                );
            }
        } else {
            this.isAdPlaying = false;
            this.logger.info(
                'Netflix-Ad',
                'Player API reported Ad end. Resuming subtitles.',
            );
            try {
                this.onAdEnd();
            } catch (e) {
                this.logger.error(
                    'Netflix-Ad',
                    'Error in onAdEnd callback:',
                    e,
                );
            }
        }
    }
}

// Backward compatible export alias
export { NetflixAdDetector as AdDetector };
