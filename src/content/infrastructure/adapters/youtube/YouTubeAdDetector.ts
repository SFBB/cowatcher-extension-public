import { Logger } from '@shared/utils/logger';
import { IAdDetector, AdDetectorOptions } from '../../../domain/adapters/IAdDetector';
import { NCW_MESSAGE_TYPES } from '@shared/domain/constants/MessageTypes';

export class YouTubeAdDetector implements IAdDetector {
  readonly onAdStart: () => void;
  readonly onAdEnd: () => void;
  isAdPlaying: boolean = false;

  private observer: MutationObserver | null = null;
  private checkInterval: NodeJS.Timeout | number | null = null;
  private messageListener: ((e: MessageEvent) => void) | null = null;
  private consecutiveAdDetections: number = 0;
  private adStartTime: number = 0;
  private accumulatedAdOffset: number = 0;

  private readonly logger: Logger = new Logger('YouTubeAdDetector');

  constructor(options: AdDetectorOptions = {}) {
    this.onAdStart = options.onAdStart || (() => {});
    this.onAdEnd = options.onAdEnd || (() => {});
  }

  startMonitoring(): void {
    this.stopMonitoring();

    // 1. Listen for authoritative ad state messages from YouTubeInjectedAdapter
    this.messageListener = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.AD_STATE_CHANGED) {
        this.setAuthoritativeAdState(Boolean(event.data.isAd));
      }
    };
    window.addEventListener('message', this.messageListener);

    // 2. DOM MutationObserver for YouTube player container and ad classes
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
      attributeFilter: ['class', 'id'],
    });

    // 3. Periodic status polling
    this.checkInterval = setInterval(() => {
      this.checkAdStatus();
    }, 1000);

    this.logger.info('YouTube-AI-Sub', 'YouTube ad detector monitoring started.');
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
      this.logger.info('YouTube-AI-Sub', 'Authoritative Ad break started (YouTube Player API). Hiding subtitles.');
      try {
        this.onAdStart();
      } catch (err) {
        this.logger.error('YouTube-AI-Sub', 'Error in onAdStart callback:', err);
      }
    } else if (!isAd && this.isAdPlaying) {
      this.isAdPlaying = false;
      this.consecutiveAdDetections = 0;
      const durationSec = (Date.now() - this.adStartTime) / 1000;
      this.accumulatedAdOffset += durationSec;
      this.logger.info(
        'YouTube-AI-Sub',
        `Authoritative Ad break ended (${durationSec.toFixed(1)}s). Total ad offset: ${this.accumulatedAdOffset.toFixed(1)}s. Resuming subtitles.`
      );
      try {
        this.onAdEnd();
      } catch (err) {
        this.logger.error('YouTube-AI-Sub', 'Error in onAdEnd callback:', err);
      }
    }
  }

  private isAdPresentInDom(): boolean {
    // 1. YouTube player class: #movie_player.ad-showing or .ad-interrupting
    const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    if (player) {
      if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
        return true;
      }
    }

    // 2. Active YouTube ad overlay or module
    const adOverlay = document.querySelector(
      '.ytp-ad-player-overlay, .ytp-ad-module .ytp-ad-text, .ytp-ad-skip-button, .ytp-skip-ad-button, .video-ads'
    );
    if (adOverlay && (adOverlay as HTMLElement).offsetParent !== null && (adOverlay as HTMLElement).children.length > 0) {
      return true;
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
        this.logger.info('YouTube-AI-Sub', 'DOM Commercial Ad detected. Hiding subtitles.');
        try {
          this.onAdStart();
        } catch (e) {
          this.logger.error('YouTube-AI-Sub', 'Error in onAdStart callback:', e);
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
          'YouTube-AI-Sub',
          `DOM Commercial Ad ended (${durationSec.toFixed(1)}s). Total ad offset: ${this.accumulatedAdOffset.toFixed(1)}s. Resuming subtitles.`
        );
        try {
          this.onAdEnd();
        } catch (e) {
          this.logger.error('YouTube-AI-Sub', 'Error in onAdEnd callback:', e);
        }
      }
    }
  }
}
