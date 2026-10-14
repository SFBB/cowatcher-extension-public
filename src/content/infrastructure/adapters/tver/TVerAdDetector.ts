import { Logger } from '@shared/utils/logger';
import { IAdDetector, AdDetectorOptions } from '../../../domain/adapters/IAdDetector';
import { NCW_MESSAGE_TYPES } from '@shared/domain/constants/MessageTypes';

export class TVerAdDetector implements IAdDetector {
  readonly onAdStart: () => void;
  readonly onAdEnd: () => void;
  isAdPlaying: boolean = false;

  private observer: MutationObserver | null = null;
  private checkInterval: NodeJS.Timeout | number | null = null;
  private messageListener: ((e: MessageEvent) => void) | null = null;
  private consecutiveAdDetections: number = 0;
  private adStartTime: number = 0;
  private accumulatedAdOffset: number = 0;

  private readonly logger: Logger = new Logger('TVerAdDetector');

  constructor(options: AdDetectorOptions = {}) {
    this.onAdStart = options.onAdStart || (() => {});
    this.onAdEnd = options.onAdEnd || (() => {});
  }

  startMonitoring(): void {
    this.stopMonitoring();

    // 1. Listen for authoritative ad state messages from TVerInjectedAdapter (streaksplayer.inAdBreak / currentAd)
    this.messageListener = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.AD_STATE_CHANGED) {
        this.setAuthoritativeAdState(Boolean(event.data.isAd));
      }
    };
    window.addEventListener('message', this.messageListener);

    // 2. DOM Mutation Observer for Google IMA / Video.js Ads containers
    let adDebounceTimer: NodeJS.Timeout | number | null = null;
    this.observer = new MutationObserver(() => {
      if (adDebounceTimer) return;
      adDebounceTimer = setTimeout(() => {
        adDebounceTimer = null;
        this.checkAdStatus();
      }, 350);
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'id', 'aria-label', 'src'],
    });

    // 3. Periodic status polling
    this.checkInterval = setInterval(() => {
      this.checkAdStatus();
    }, 1000);

    this.logger.info('TVer-AI-Sub', 'TVer ad detector monitoring started.');
  }

  stopMonitoring(): void {
    if (this.messageListener) {
      window.removeEventListener('message', this.messageListener);
      this.messageListener = null;
    }
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  reset(): void {
    this.isAdPlaying = false;
    this.consecutiveAdDetections = 0;
    this.adStartTime = 0;
    this.accumulatedAdOffset = 0;
  }

  setAuthoritativeAdState(isAd: boolean): void {
    if (isAd && !this.isAdPlaying) {
      this.isAdPlaying = true;
      this.adStartTime = Date.now();
      this.logger.info('TVer-AI-Sub', 'Authoritative Ad break started (TVer Player API). Hiding subtitles.');
      try {
        this.onAdStart();
      } catch (err) {
        this.logger.error('TVer-AI-Sub', 'Error in onAdStart callback:', err);
      }
    } else if (!isAd && this.isAdPlaying) {
      this.isAdPlaying = false;
      this.consecutiveAdDetections = 0;
      const durationSec = (Date.now() - this.adStartTime) / 1000;
      this.accumulatedAdOffset += durationSec;
      this.logger.info(
        'TVer-AI-Sub',
        `Authoritative Ad break ended (${durationSec.toFixed(1)}s). Total ad offset: ${this.accumulatedAdOffset.toFixed(1)}s. Resuming subtitles.`
      );
      try {
        this.onAdEnd();
      } catch (err) {
        this.logger.error('TVer-AI-Sub', 'Error in onAdEnd callback:', err);
      }
    }
  }

  private isAdPresentInDom(): boolean {
    // 1. Video.js active ad classes on the player container
    const activeAdSelectors = [
      '.vjs-ad-playing',
      '.vjs-ad-loading',
    ];

    for (const sel of activeAdSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        return true;
      }
    }

    // 2. Active Google IMA ad container check (must be visible and actively displaying an ad UI)
    const imaAdContainer = document.querySelector('.ima-ad-container, .ima-container');
    if (imaAdContainer && (imaAdContainer as HTMLElement).offsetParent !== null) {
      const activeUi = imaAdContainer.querySelector('.videoAdUi, .ima-countdown-div, [class*="ad-skip"], [id*="ad-ui"]');
      if (activeUi) {
        return true;
      }
    }

    // 3. Video element source checks
    const video = document.getElementById('video-player') as HTMLVideoElement || document.querySelector('video');
    if (video) {
      const src = (video.src || video.currentSrc || '').toLowerCase();
      if (src.includes('imasdk') || src.includes('googlevideo') && !src.includes('streaks.jp')) {
        return true;
      }
    }

    return false;
  }

  private checkAdStatus(): void {
    const detected = this.isAdPresentInDom();

    if (detected) {
      this.consecutiveAdDetections++;
      if (this.consecutiveAdDetections >= 1 && !this.isAdPlaying) {
        this.isAdPlaying = true;
        this.adStartTime = Date.now();
        this.logger.info('TVer-AI-Sub', 'DOM Commercial Ad detected. Hiding subtitles.');
        try {
          this.onAdStart();
        } catch (e) {
          this.logger.error('TVer-AI-Sub', 'Error in onAdStart callback:', e);
        }
      }
    } else {
      if (this.consecutiveAdDetections > 0) {
        this.consecutiveAdDetections = 0;
      }

      if (this.isAdPlaying) {
        this.isAdPlaying = false;
        const durationSec = (Date.now() - this.adStartTime) / 1000;
        this.accumulatedAdOffset += durationSec;
        this.logger.info(
          'TVer-AI-Sub',
          `DOM Commercial Ad ended (${durationSec.toFixed(1)}s). Total ad offset: ${this.accumulatedAdOffset.toFixed(1)}s. Resuming subtitles.`
        );
        try {
          this.onAdEnd();
        } catch (e) {
          this.logger.error('TVer-AI-Sub', 'Error in onAdEnd callback:', e);
        }
      }
    }
  }
}
