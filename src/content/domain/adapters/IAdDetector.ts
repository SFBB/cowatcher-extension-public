/**
 * Domain interface and options for Platform-specific Ad Detectors.
 *
 * Ad detectors are responsible for monitoring platform player state, DOM changes,
 * or ad break events to suppress custom subtitles and pause translation during commercials.
 */

export interface AdDetectorOptions {
  onAdStart?: () => void;
  onAdEnd?: () => void;
}

export interface IAdDetector {
  readonly isAdPlaying: boolean;
  startMonitoring(): void;
  stopMonitoring(): void;
  reset(): void;
}
