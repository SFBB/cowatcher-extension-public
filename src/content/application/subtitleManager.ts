import { SubtitleOverlay } from '../presentation/SubtitleOverlay';
import { IAdDetector } from '../domain/adapters/IAdDetector';
import { ExtensionSettings, PipelineConfig } from '@shared/utils/constants';
import {
    IStreamingAdapter,
    VideoMetadata,
} from '../domain/adapters/IStreamingAdapter';
import { ContentMessageService } from './services/ContentMessageService';
import { BrowserPlatformFactory } from '@shared/infrastructure/platform/BrowserPlatformFactory';
import { IBrowserPlatform } from '@shared/infrastructure/platform/IBrowserPlatform';
import { PrecedingContextItem } from '@shared/types/Messages';
import { Context } from '@shared/domain/entities/Context';
import { TranslationStatus } from '@shared/domain/entities/Translation';
import { Language } from '@shared/domain/value-objects/Language';
import { SubtitleCue } from '@shared/domain/entities/Subtitle';
import { Logger } from '@shared/utils/logger';
import { SubtitleLearningManager } from './learning/SubtitleLearningManager';
import { WatchHistoryTracker } from './history/WatchHistoryTracker';

import { SubtitleStore, TranslationItem } from './store/SubtitleStore';
import { AsrStreamMerger } from './pipeline/AsrStreamMerger';
import { SubtitlePlaybackSyncer } from './playback/SubtitlePlaybackSyncer';
import { EpisodeContextManager } from './context/EpisodeContextManager';
import { SubtitlePipelineCoordinator } from './pipeline/SubtitlePipelineCoordinator';

export type CueItem = SubtitleCue;

interface CuesStalePayload {
    readonly movieId?: string;
    readonly movieIds?: string[];
    readonly trackHash?: string;
    readonly showTitle?: string;
    readonly showId?: string;
    readonly invalidatedCount?: number;
}

export class SubtitleManager {
    readonly overlay: SubtitleOverlay;
    readonly adDetector: IAdDetector;
    readonly adapter?: IStreamingAdapter;
    settings: Partial<ExtensionSettings>;
    readonly platform: IBrowserPlatform;
    readonly learningManager?: SubtitleLearningManager;
    readonly historyTracker?: WatchHistoryTracker;

    readonly store: SubtitleStore;
    readonly asrMerger: AsrStreamMerger;
    readonly syncer: SubtitlePlaybackSyncer;
    readonly contextManager: EpisodeContextManager;
    readonly pipeline: SubtitlePipelineCoordinator;

    currentRawLanguage = '';
    private readonly messageService: ContentMessageService;
    private readonly logger = new Logger('SubtitleManager');

    constructor(
        overlay: SubtitleOverlay,
        adDetector: IAdDetector,
        settings: Partial<ExtensionSettings> = {},
        adapter?: IStreamingAdapter,
    ) {
        this.overlay = overlay;
        this.adDetector = adDetector;
        this.settings = settings;
        this.adapter = adapter;
        this.messageService = ContentMessageService.getInstance();
        this.platform = BrowserPlatformFactory.getPlatform();

        if (this.adapter && this.overlay) {
            this.overlay.bindContainerResolver(
                () => this.adapter?.getPlayerContainer?.() || null,
            );
            this.learningManager = new SubtitleLearningManager(
                this.adapter,
                this.messageService,
                this.settings as ExtensionSettings,
            );
            this.overlay.setLearningManager(this.learningManager);
            this.historyTracker = new WatchHistoryTracker(
                this.adapter,
                this.messageService,
            );
        }

        this.store = new SubtitleStore();
        this.asrMerger = this.createAsrMerger();
        this.syncer = this.createPlaybackSyncer();
        this.contextManager = this.createContextManager();
        this.pipeline = this.createPipelineCoordinator();

        this.bindDelegates();
        this.subscribeMessageService();
    }

    get video(): HTMLVideoElement | null {
        return this.syncer.video;
    }
    get cues(): SubtitleCue[] {
        return this.store.cues;
    }
    set cues(val: SubtitleCue[]) {
        this.store.cues = val;
    }
    get translationMap(): Map<number, TranslationItem> {
        return this.store.translationMap;
    }
    get cueStateMap(): Map<number, TranslationStatus> {
        return this.store.cueStateMap;
    }
    get canonicalReviewIndex(): number {
        return this.store.canonicalReviewIndex;
    }
    set canonicalReviewIndex(val: number) {
        this.store.canonicalReviewIndex = val;
    }
    get currentMovieId(): string | null {
        return this.contextManager.currentMovieId;
    }
    set currentMovieId(val: string | null) {
        this.contextManager.currentMovieId = val;
    }
    get currentShowId(): string | null {
        return this.contextManager.currentShowId;
    }
    set currentShowId(val: string | null) {
        this.contextManager.currentShowId = val;
    }
    get currentTrackHash(): string {
        return this.store.currentTrackHash;
    }
    set currentTrackHash(val: string) {
        this.store.currentTrackHash = val;
    }
    get currentContext(): Context {
        return this.contextManager.currentContext;
    }
    set currentContext(val: Context) {
        this.contextManager.currentContext = val;
    }
    get activeCueId(): number | null {
        return this.syncer.activeCueId;
    }
    get cadmiumOffset(): number {
        return this.syncer.cadmiumOffset;
    }
    set cadmiumOffset(val: number) {
        this.syncer.cadmiumOffset = val;
    }
    get domOffset(): number {
        return this.syncer.domOffset;
    }
    set domOffset(val: number) {
        this.syncer.domOffset = val;
    }
    get manualOffset(): number {
        return this.syncer.manualOffset;
    }
    set manualOffset(val: number) {
        this.syncer.manualOffset = val;
    }
    get sessionEpoch(): number {
        return this.store.sessionEpoch;
    }
    set sessionEpoch(val: number) {
        this.store.sessionEpoch = val;
    }
    get isTranslating(): boolean {
        return this.pipeline.isTranslating;
    }
    get isReviewing(): boolean {
        return this.pipeline.isReviewing;
    }
    get isPreReviewing(): boolean {
        return this.pipeline.isPreReviewing;
    }
    get videoInfo(): VideoMetadata | null {
        return this.contextManager.vidoeInfo;
    }

    private createAsrMerger(): AsrStreamMerger {
        return new AsrStreamMerger(
            this.messageService,
            {
                isContextValid: () => this.isContextValid(),
                addMergedCues: (c) => this.addMergedAsrCues(c),
                onMergedCuesAdded: (epoch) => this.onMergedAsrCuesAdded(epoch),
            },
            () => this.settings,
        );
    }

    private createPlaybackSyncer(): SubtitlePlaybackSyncer {
        return new SubtitlePlaybackSyncer(
            this.overlay,
            {
                isContextValid: () => this.isContextValid(),
                isAdPlaying: () => Boolean(this.adDetector?.isAdPlaying),
                getCues: () => this.store.cues,
                getRawAsrCues: () => this.asrMerger.rawAsrCues,
                isAsrTrack: () => this.asrMerger.isAsrTrack,
                getTranslation: (id) => this.store.translationMap.get(id),
                checkCueStaleness: (id) =>
                    this.store.checkCueStaleness(
                        id,
                        this.contextManager.currentContext,
                    ),
                onPipelineTick: (t) => this.checkPipeline(t),
                onSeeked: (t) => this.handleSeeked(t),
                onVideoAttached: (v) => this.historyTracker?.attachVideo(v),
                onVideoDetached: () => this.historyTracker?.detachVideo(),
            },
            () => this.settings,
        );
    }

    private createContextManager(): EpisodeContextManager {
        return new EpisodeContextManager(
            this.messageService,
            {
                isContextValid: () => this.isContextValid(),
                getCues: () => this.store.cues,
                getCurrentRawLanguage: () => this.currentRawLanguage,
                onGlossaryUpdated: () => this.checkStaleCues(),
                onEpisodeReset: () => {
                    this.store.cues = [];
                },
                onEpisodeRetained: () => {},
            },
            () => this.settings,
            this.adapter,
            this.learningManager,
            this.historyTracker,
        );
    }

    private createPipelineCoordinator(): SubtitlePipelineCoordinator {
        return new SubtitlePipelineCoordinator(
            this.messageService,
            this.store,
            {
                isContextValid: () => this.isContextValid(),
                isAdPlaying: () => Boolean(this.adDetector?.isAdPlaying),
                isVideoPaused: () => Boolean(this.syncer.video?.paused),
                detachVideo: () => this.detachVideo(),
                getEffectiveTime: () => this.getEffectiveTime(),
                findCueIndexAtTime: (t) => this.syncer.findCueIndexAtTime(t),
                findActiveCues: (t) => this.syncer.findActiveCues(t),
                onTick: () => this.onTick(),
                checkAsrMerge: (t) => this.checkAsrMergePipeline(t),
                getCurrentMovieId: () => this.contextManager.currentMovieId,
                getCurrentShowId: () => this.contextManager.currentShowId,
                getCurrentContext: () => this.contextManager.currentContext,
                onContextUpdated: (ctx) => {
                    this.contextManager.currentContext = ctx;
                    this.checkStaleCues();
                },
                getCurrentRawLanguage: () => this.currentRawLanguage,
                isAsrTrack: () => this.asrMerger.isAsrTrack,
                getRawAsrCuesCount: () => this.asrMerger.rawAsrCues.length,
                getAsrMergeIndex: () => this.asrMerger.asrMergeIndex,
            },
            () => this.settings,
            this.adapter,
        );
    }

    private bindDelegates(): void {
        this.bindVideoEvents = this.bindVideoEvents.bind(this);
        this.onTick = this.onTick.bind(this);
        this.onSeeked = this.onSeeked.bind(this);
        this.onSeeking = this.onSeeking.bind(this);
    }

    private subscribeMessageService(): void {
        this.messageService.onGlossaryChanged((context) => {
            if (!context) return;
            this.contextManager.currentContext = Context.fromDTO(context);
            this.checkStaleCues();
            if (!context.isWarmedUp) {
                this.contextManager.hasWarmedUpForEpisode = false;
                if (this.contextManager.latestMetadata || this.adapter) {
                    this.contextManager.warmupShowContext(true);
                }
            }
        });

        this.messageService.onCuesStale((payload) =>
            this.handleCuesStale(payload),
        );
    }

    private handleCuesStale(payload?: CuesStalePayload): void {
        if (!payload) return;
        const currentMid = String(this.contextManager.currentMovieId || '');
        const matchesMid = Boolean(
            payload.movieId && String(payload.movieId) === currentMid,
        );
        const matchesMidList = Boolean(
            Array.isArray(payload.movieIds) &&
            payload.movieIds.some((id) => String(id) === currentMid),
        );
        const matchesTrack = Boolean(
            payload.trackHash &&
            payload.trackHash === this.store.currentTrackHash,
        );
        const matchesShowId = Boolean(
            payload.showId &&
            (String(payload.showId) ===
                String(this.contextManager.currentShowId) ||
                String(payload.showId) ===
                    String(this.contextManager.currentContext?.showId)),
        );

        if (matchesMid || matchesMidList || matchesTrack || matchesShowId) {
            this.logger.info(
                'SubtitleManager',
                `Cues invalidated (${payload.invalidatedCount || 0}). Resetting translations.`,
            );
            this.store.clearTranslations();
            this.syncer.lastCueSig = '';
            this.onTick();
            if (this.syncer.video) {
                this.pipeline.checkPipeline(this.getEffectiveTime());
            }
        }
    }

    isContextValid(): boolean {
        return this.platform.isContextValid();
    }

    isSameSubtitle(newCues: CueItem[], isAsr = false): boolean {
        const targetCues =
            isAsr &&
            this.asrMerger.isAsrTrack &&
            this.asrMerger.rawAsrCues.length > 0
                ? this.asrMerger.rawAsrCues
                : this.store.cues;
        if (
            !targetCues ||
            targetCues.length === 0 ||
            !newCues ||
            newCues.length === 0
        )
            return false;
        if (targetCues.length !== newCues.length) return false;

        const mid = Math.floor(newCues.length / 2);
        const last = newCues.length - 1;
        return (
            targetCues[0]?.rawText === newCues[0]?.rawText &&
            targetCues[0]?.startTime === newCues[0]?.startTime &&
            targetCues[mid]?.rawText === newCues[mid]?.rawText &&
            targetCues[last]?.rawText === newCues[last]?.rawText
        );
    }

    getCueStatus(cueId: number): TranslationStatus {
        return this.store.getCueStatus(cueId);
    }

    isCueTranslated(cueId: number): boolean {
        return this.store.isCueTranslated(cueId);
    }

    isCueReviewed(cueId: number): boolean {
        return this.store.isCueReviewed(cueId);
    }

    checkCueStaleness(cueId: number): boolean {
        return this.store.checkCueStaleness(
            cueId,
            this.contextManager.currentContext,
        );
    }

    checkStaleCues(): void {
        const hasInvalidated = this.store.checkStaleCues(
            this.getEffectiveTime(),
            this.contextManager.currentContext,
            (t) => this.syncer.findCueIndexAtTime(t),
        );
        if (hasInvalidated) {
            this.syncer.lastCueSig = '';
            this.onTick();
            if (this.syncer.video) {
                this.checkPipeline(this.getEffectiveTime());
            }
        }
    }

    loadCues(
        cues: CueItem[],
        movieId: string | number | null = null,
        isAsr = false,
        language?: string,
    ): void {
        if (!cues || cues.length === 0) return;
        if (language) this.currentRawLanguage = language;
        if (this.isSameSubtitle(cues, isAsr)) return;

        if (movieId) {
            this.contextManager.currentMovieId = String(movieId);
            this.learningManager?.onShowContext(
                this.contextManager.currentMovieId,
                this.contextManager.latestMetadata?.fullTitle ||
                    this.contextManager.latestMetadata?.mainTitle ||
                    this.contextManager.currentContext?.mainTitle,
                this.currentRawLanguage,
                Language.resolve(this.settings.targetLanguage).code,
            );
        }

        if (this.isContextValid()) {
            this.messageService.clearQueues().catch(() => {});
        }

        const epoch = Date.now();
        this.store.sessionEpoch = epoch;
        this.store.lastCuesLoadedAt = epoch;
        this.store.clearTranslations();
        this.pipeline.isTranslating = false;
        this.pipeline.isReviewing = false;
        this.pipeline.isPreReviewing = false;
        this.syncer.hasLoggedEndOfCues = false;

        const shouldMergeAsr =
            isAsr && this.settings.enableAutomaticAsrMerging !== false;
        if (shouldMergeAsr) {
            this.asrMerger.loadRawAsrCues(cues);
            this.store.cues = [];
        } else {
            this.asrMerger.reset();
            this.store.cues = cues;
            this.pipeline.loadSubtitlesForCurrentTrack(cues, epoch);
        }
        this.postLoadCues(epoch, shouldMergeAsr);
    }

    private postLoadCues(epoch: number, shouldMergeAsr: boolean): void {
        if (this.settings.enabled === false) {
            this.overlay.hide(true);
            return;
        }
        if (
            typeof document !== 'undefined' &&
            (!this.syncer.video ||
                (document.body && !document.body.contains(this.syncer.video)))
        ) {
            const v = document.querySelector('video');
            if (v) this.attachVideo(v);
        }
        this.overlay.mountToPlayer(this.adapter?.getPlayerContainer?.());
        if (this.syncer.video) {
            this.onTick();
            const effectiveTime = this.getEffectiveTime();
            if (shouldMergeAsr) {
                this.checkAsrMergePipeline(effectiveTime);
            } else if (this.settings.preferNativeSubtitles === false) {
                this.pipeline.checkPipeline(effectiveTime);
            }
            if (!this.syncer.video.paused) {
                this.syncer.startRafLoop();
            }
        }
        setTimeout(() => {
            if (this.store.sessionEpoch === epoch) {
                this.contextManager.warmupShowContext();
            }
        }, 2500);
    }

    clearCues(): void {
        this.pipeline.stopNativePollingInterval();
        if (this.isContextValid()) {
            this.messageService.clearQueues().catch(() => {});
        }
        this.store.clearCues();
        this.asrMerger.reset();
        this.pipeline.isTranslating = false;
        this.pipeline.isReviewing = false;
        this.pipeline.isPreReviewing = false;
        this.syncer.activeCueId = null;
        this.syncer.lastCueSig = '';
        this.syncer.hasLoggedEndOfCues = false;
        this.overlay.hide(true);
        this.logger.info(
            'SubtitleManager',
            'Cleared subtitle cues and hid overlay.',
        );
    }

    onEpisodeChange(newMovieId: string | number | null): void {
        const newIdStr = newMovieId ? String(newMovieId) : null;
        if (this.historyTracker) {
            this.historyTracker.onEpisodeChange(newIdStr);
        }
        this.pipeline.stopNativePollingInterval();
        this.contextManager.onEpisodeChange(newMovieId);
        this.store.clearTranslations();
        this.pipeline.isTranslating = false;
        this.pipeline.isReviewing = false;
        this.pipeline.isPreReviewing = false;
        this.syncer.activeCueId = null;
        this.syncer.lastCueSig = '';
        this.syncer.lastContentTime = null;
        this.syncer.emptyCueSince = null;
        this.syncer.cadmiumOffset = 0;
        this.syncer.domOffset = 0;
        this.syncer.lastNativeCalibAt = 0;
        this.syncer.hasLoggedEndOfCues = false;
        this.overlay.hide(true);
        this.adDetector?.reset?.();

        const isKnown = this.contextManager.isEpisodeOfCurrentShow(
            newMovieId ? String(newMovieId) : null,
        );
        if (
            this.settings.enabled !== false &&
            this.store.cues.length > 0 &&
            isKnown
        ) {
            this.contextManager.warmupShowContext();
            if (this.syncer.video) {
                this.onTick();
                this.pipeline.checkPipeline(this.getEffectiveTime());
                if (!this.syncer.video.paused) {
                    this.syncer.startRafLoop();
                }
            }
        }
    }

    onMetadataLoaded(meta: VideoMetadata): void {
        this.contextManager.onMetadataLoaded(meta);
        if (this.historyTracker) {
            this.historyTracker.onMetadataLoaded(meta);
        }
    }

    warmupShowContext(force = false, metadataOverride?: VideoMetadata): void {
        this.contextManager.warmupShowContext(force, metadataOverride);
    }

    getPrecedingContextItems(
        targetCueIndex: number,
        maxContext = 3,
    ): PrecedingContextItem[] {
        return this.pipeline.getPrecedingContextItems(
            targetCueIndex,
            maxContext,
        );
    }

    attachVideo(videoEl: HTMLVideoElement): void {
        this.syncer.attachVideo(videoEl);
    }

    detachVideo(): void {
        this.syncer.detachVideo();
    }

    bindVideoEvents(): void {
        this.syncer.bindVideoEvents();
    }

    startRafLoop(): void {
        this.syncer.startRafLoop();
    }

    stopRafLoop(): void {
        this.syncer.stopRafLoop();
    }

    getContentTime(): number {
        return this.syncer.getContentTime();
    }

    getEffectiveTime(): number {
        return this.syncer.getEffectiveTime();
    }

    setCadmiumOffset(offset: number): void {
        this.syncer.setCadmiumOffset(offset);
    }

    setAdOffset(offset: number): void {
        this.syncer.setAdOffset(offset);
    }

    calibrateOffsetFromNativeSubtitles(): void {
        this.syncer.calibrateOffsetFromNativeSubtitles();
    }

    onSeeking(): void {
        this.syncer.onSeeking();
    }

    onSeeked(): void {
        this.syncer.onSeeked();
    }

    private handleSeeked(effectiveTime: number): void {
        if (this.asrMerger.isAsrTrack) {
            this.checkAsrMergePipeline(effectiveTime);
        }
        this.onTick();
        this.checkPipeline(effectiveTime);
    }

    onTick(): void {
        this.syncer.onTick();
    }

    findActiveCues(time: number): CueItem[] {
        return this.syncer.findActiveCues(time);
    }

    findActiveCue(time: number): CueItem | null {
        return this.syncer.findActiveCue(time);
    }

    findCueIndexAtTime(time: number): number {
        return this.syncer.findCueIndexAtTime(time);
    }

    private addMergedAsrCues(newCues: SubtitleCue[]): void {
        const existingIds = new Set(this.store.cues.map((c) => c.id));
        const toAdd = newCues.filter((c) => !existingIds.has(c.id));
        this.store.cues.push(...toAdd);
        this.store.cues.sort((a, b) => a.startTime - b.startTime);

        for (let i = 0; i < this.store.cues.length - 1; i++) {
            const curr = this.store.cues[i];
            const nxt = this.store.cues[i + 1];
            if (
                curr.endTime > nxt.startTime &&
                nxt.startTime > curr.startTime
            ) {
                curr.endTime = nxt.startTime;
            }
            const gap = nxt.startTime - curr.endTime;
            if (gap > 0 && gap <= 3.5) {
                curr.endTime = nxt.startTime;
            }
        }
    }

    private onMergedAsrCuesAdded(epoch: number): void {
        if (this.store.cues.length > 0 && !this.store.currentTrackHash) {
            this.pipeline.loadSubtitlesForCurrentTrack(this.store.cues, epoch);
        }
        this.onTick();
        const effectiveTime = this.getEffectiveTime();
        this.pipeline.checkPipeline(effectiveTime);
    }

    async checkAsrMergePipeline(currentTime: number): Promise<void> {
        const lastMergedTime =
            this.store.cues.length > 0
                ? this.store.cues[this.store.cues.length - 1].endTime
                : 0;
        await this.asrMerger.checkAsrMergePipeline(
            currentTime,
            lastMergedTime,
            this.store.sessionEpoch,
        );
    }

    checkPipeline(currentTime: number): void {
        this.pipeline.checkPipeline(currentTime);
    }

    processSupervisorReviewQueue(pipelineConfig?: PipelineConfig): void {
        this.pipeline.processSupervisorReviewQueue(pipelineConfig);
    }

    updateSettings(newSettings: Partial<ExtensionSettings>): void {
        const wasEnabled = this.settings.enabled !== false;
        const oldTargetLanguage = this.settings.targetLanguage;
        const oldAiProvider = this.settings.aiProvider;
        const oldPreferNative = this.settings.preferNativeSubtitles !== false;

        this.settings = { ...this.settings, ...newSettings };
        this.overlay.updateSettings(this.settings);
        this.learningManager?.updateSettings(
            this.settings as ExtensionSettings,
        );
        this.applySettingsOffsetChanges(newSettings);

        const oldLang = Language.resolve(oldTargetLanguage).code;
        const newLang = newSettings.targetLanguage
            ? Language.resolve(newSettings.targetLanguage).code
            : oldLang;
        const langChanged = Boolean(oldLang && newLang && oldLang !== newLang);
        const providerChanged = Boolean(
            newSettings.aiProvider &&
            oldAiProvider &&
            newSettings.aiProvider !== oldAiProvider,
        );
        const preferChanged = Boolean(
            newSettings.preferNativeSubtitles !== undefined &&
            (newSettings.preferNativeSubtitles !== false) !== oldPreferNative,
        );

        if (this.settings.enabled === false) {
            this.handleSettingsDisabled();
        } else if (providerChanged || langChanged || preferChanged) {
            this.handleTranslationSettingsChanged();
        } else if (!wasEnabled && this.settings.enabled) {
            this.handleSettingsEnabled();
        }
    }

    private applySettingsOffsetChanges(
        newSettings: Partial<ExtensionSettings>,
    ): void {
        if (newSettings.subSyncOffset !== undefined) {
            this.syncer.manualOffset = newSettings.subSyncOffset;
            if (this.syncer.video && this.store.cues.length > 0) this.onTick();
        }
        if (
            newSettings.enableDomSubtitleSync !== undefined &&
            !newSettings.enableDomSubtitleSync
        ) {
            this.syncer.domOffset = 0;
        }
    }

    private handleSettingsDisabled(): void {
        this.pipeline.stopNativePollingInterval();
        this.overlay.hide(true);
        this.syncer.activeCueId = null;
        this.pipeline.isTranslating = false;
        this.pipeline.isReviewing = false;
        this.pipeline.isPreReviewing = false;
    }

    private handleTranslationSettingsChanged(): void {
        this.pipeline.stopNativePollingInterval();
        if (this.isContextValid())
            this.messageService.clearQueues().catch(() => {});
        const epoch = Date.now();
        this.store.sessionEpoch = epoch;
        this.store.clearTranslations();
        this.overlay.hide(true);
        this.syncer.activeCueId = null;
        this.pipeline.isTranslating = false;
        this.pipeline.isReviewing = false;
        this.pipeline.isPreReviewing = false;

        if (this.store.cues.length > 0) {
            this.contextManager.warmupShowContext(true);
            this.pipeline.loadSubtitlesForCurrentTrack(
                this.store.cues,
                epoch,
                this.store.currentTrackHash,
            );
        }
    }

    private handleSettingsEnabled(): void {
        this.contextManager.warmupShowContext();
        if (
            !this.syncer.video ||
            (document.body && !document.body.contains(this.syncer.video))
        ) {
            const v = document.querySelector('video');
            if (v) this.attachVideo(v);
        }
        this.overlay.mountToPlayer(this.adapter?.getPlayerContainer?.());

        if (this.store.cues.length > 0 && this.syncer.video) {
            const epoch = Date.now();
            this.store.sessionEpoch = epoch;
            this.pipeline.loadSubtitlesForCurrentTrack(
                this.store.cues,
                epoch,
                this.store.currentTrackHash,
            );
            if (!this.syncer.video.paused) this.syncer.startRafLoop();
        } else if (this.store.cues.length === 0 && this.adapter) {
            this.adapter.requestSubtitleRetry();
        }
    }
}

export default SubtitleManager;
