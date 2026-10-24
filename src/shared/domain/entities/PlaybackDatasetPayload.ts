/**
 * Shared DOM Dataset Payload for High-Frequency Streaming State Synchronization.
 *
 * Implements Item 4 of adapter.design.md:
 * Specifically engineered for high-frequency synchronization (playback time, paused state, rate, offsets)
 * between the page's MAIN world (Injected script) and the extension's ISOLATED world (Content script).
 *
 * All fields are structured, strictly typed, and bound to `movieId` to guarantee single-source-of-truth
 * and prevent cross-episode / cross-video timeline pollution.
 */
export interface PlaybackDatasetPayload {
    /**
     * Authoritative entity ID (movieId, videoId, or episodeId).
     * MANDATORY: Content script MUST validate `payload.movieId === currentVideoId` before consuming.
     */
    movieId: string;

    /**
     * High-frequency playback position in seconds (e.g. Cadmium segment time, player currentTime).
     */
    currentTime: number;

    /**
     * High-resolution timestamp (`performance.now()`) when `currentTime` was captured.
     * Used by Content script to compute elapsed delta for smooth sub-second interpolation.
     */
    syncAt: number;

    /**
     * Whether the video player is currently paused.
     */
    isPaused: boolean;

    /**
     * Current playback rate multiplier (e.g. 1.0, 1.25, 1.5, 2.0).
     */
    playbackRate: number;

    /**
     * Whether commercial advertisement is currently playing.
     */
    isAd?: boolean;

    /**
     * Platform-specific timeline calibration offset in seconds (e.g. Cadmium offset or ad gap).
     */
    offset?: number;

    /**
     * Associated show/series ID (for series-level context and heartbeat).
     */
    showId?: string;

    /**
     * Wall-clock epoch timestamp (`Date.now()`) when this payload was written.
     */
    updatedAt?: number;
}

/**
 * DOM Dataset key used for high-frequency playback state exchange.
 * Corresponds to HTML attribute `data-ncw-sync`.
 */
export const NCW_DATASET_SYNC_KEY = 'ncwSync';

/**
 * Utility helpers for atomic serialization, deserialization, and DOM dataset access.
 */
export class PlaybackDatasetHelper {
    /**
     * Serialize payload to atomic JSON string for storage in HTMLElement.dataset.
     */
    static serialize(payload: PlaybackDatasetPayload): string {
        return JSON.stringify(payload);
    }

    /**
     * Safely deserialize a raw string from HTMLElement.dataset into PlaybackDatasetPayload.
     * Returns null if string is empty, invalid JSON, or missing mandatory fields.
     */
    static deserialize(
        raw: string | null | undefined,
    ): PlaybackDatasetPayload | null {
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            if (
                parsed &&
                typeof parsed.movieId === 'string' &&
                typeof parsed.currentTime === 'number' &&
                typeof parsed.syncAt === 'number'
            ) {
                return parsed as PlaybackDatasetPayload;
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Atomically write playback dataset to target element (default: document.documentElement).
     */
    static write(
        payload: PlaybackDatasetPayload,
        target: HTMLElement = document.documentElement,
    ): void {
        if (typeof document === 'undefined' || !target || !target.dataset)
            return;
        target.dataset[NCW_DATASET_SYNC_KEY] = this.serialize(payload);
    }

    /**
     * Read and validate playback dataset from target element (default: document.documentElement).
     * If `expectedMovieId` is provided, guarantees that the payload matches it, returning null if mismatched.
     */
    static read(
        expectedMovieId?: string | null,
        target: HTMLElement = document.documentElement,
    ): PlaybackDatasetPayload | null {
        if (typeof document === 'undefined' || !target || !target.dataset)
            return null;
        const raw = target.dataset[NCW_DATASET_SYNC_KEY];
        const payload = this.deserialize(raw);
        if (!payload) return null;

        if (expectedMovieId && payload.movieId !== expectedMovieId) {
            return null;
        }
        return payload;
    }

    /**
     * Clear the dataset payload from target element.
     */
    static clear(target: HTMLElement = document.documentElement): void {
        if (typeof document === 'undefined' || !target || !target.dataset)
            return;
        delete target.dataset[NCW_DATASET_SYNC_KEY];
    }
}
