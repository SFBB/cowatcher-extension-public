import { VideoMetadata, IStreamingAdapter } from '../../domain/adapters/IStreamingAdapter';
import { Context } from '@shared/domain/entities/Context';
import { Language } from '@shared/domain/value-objects/Language';
import { ExtensionSettings } from '@shared/utils/constants';
import { ContentMessageService } from '../services/ContentMessageService';
import { SubtitleLearningManager } from '../learning/SubtitleLearningManager';
import { WatchHistoryTracker } from '../history/WatchHistoryTracker';
import { SubtitleCue } from '@shared/domain/entities/Subtitle';
import { Logger } from '@shared/utils/logger';

export interface EpisodeContextDelegate {
  isContextValid(): boolean;
  getCues(): SubtitleCue[];
  getCurrentRawLanguage(): string;
  onGlossaryUpdated(context: Context): void;
  onEpisodeReset(newMovieId: string | null): void;
  onEpisodeRetained(movieId: string): void;
}

export class EpisodeContextManager {
  private readonly logger = new Logger('EpisodeContextManager');

  currentMovieId: string | null = null;
  currentShowId: string | null = null;
  currentContext: Context = Context.createEmpty(Language.DEFAULT);
  hasWarmedUpForEpisode = false;
  latestMetadata?: VideoMetadata;

  constructor(
    private readonly messageService: ContentMessageService,
    private readonly delegate: EpisodeContextDelegate,
    private readonly getSettings: () => Partial<ExtensionSettings>,
    private readonly adapter?: IStreamingAdapter,
    private readonly learningManager?: SubtitleLearningManager,
    private readonly historyTracker?: WatchHistoryTracker,
  ) {}

  isEpisodeOfCurrentShow(newIdStr: string | null): boolean {
    if (!newIdStr || !this.currentShowId) return false;
    const matchContextEpisode = this.currentContext?.episodes?.some((e) => e.videoId === newIdStr);
    const matchLatestMeta = this.latestMetadata?.videoId === newIdStr && this.latestMetadata?.showId === this.currentShowId;
    const matchCurrentMovie = this.currentMovieId === newIdStr;
    return Boolean(matchContextEpisode || matchLatestMeta || matchCurrentMovie);
  }

  private clearDOMDatasetAttributes(): void {
    if (typeof document === 'undefined' || !document.documentElement) return;
    delete document.documentElement.dataset.ncwSegmentAtomic;
    delete document.documentElement.dataset.ncwSegmentTime;
    delete document.documentElement.dataset.ncwSegmentSyncAt;
    delete document.documentElement.dataset.ncwIsPaused;
    delete document.documentElement.dataset.ncwPlaybackRate;
    delete document.documentElement.dataset.ncwCadmiumOffset;
    delete document.documentElement.dataset.ncwAdOffset;
    delete document.documentElement.dataset.ncwKadmiumTime;
    delete document.documentElement.dataset.ncwTimeSyncAt;
  }

  onEpisodeChange(newMovieId: string | number | null): void {
    const newIdStr = newMovieId ? String(newMovieId) : null;
    this.logger.info('EpisodeContextManager', `Episode switch detected (${newIdStr || 'new'}).`);

    const isKnown = this.isEpisodeOfCurrentShow(newIdStr);
    const cues = this.delegate.getCues();
    const cuesBelongToNewEpisode = Boolean(cues.length > 0 && this.currentMovieId && newIdStr && this.currentMovieId === newIdStr);

    if (cuesBelongToNewEpisode) {
      this.logger.info('EpisodeContextManager', `Retaining ${cues.length} cues for episode (${newIdStr}).`);
      this.delegate.onEpisodeRetained(newIdStr!);
    } else {
      this.handleEpisodeCuesReset(newIdStr);
    }

    if (!isKnown) {
      this.handleUnknownShowSwitch(newIdStr);
    } else if (this.delegate.isContextValid() && this.currentShowId) {
      this.notifyCurrentShowEpisodeChanged(newIdStr);
    }

    this.clearDOMDatasetAttributes();
    this.hasWarmedUpForEpisode = false;
  }

  private handleEpisodeCuesReset(newIdStr: string | null): void {
    this.logger.info('EpisodeContextManager', `Resetting cues for episode switch (next: ${newIdStr}).`);
    this.currentMovieId = newIdStr;
    this.latestMetadata = undefined;
    if (newIdStr) {
      this.learningManager?.onShowContext(
        newIdStr,
        this.currentContext?.mainTitle,
        this.delegate.getCurrentRawLanguage(),
        Language.resolve(this.getSettings().targetLanguage).code,
      );
    }
    this.delegate.onEpisodeReset(newIdStr);
  }

  private handleUnknownShowSwitch(newIdStr: string | null): void {
    if (this.currentShowId && this.delegate.isContextValid()) {
      this.logger.info('EpisodeContextManager', `Unloading old show context (${this.currentShowId}).`);
      this.messageService.unloadContext(this.currentShowId, this.getSettings().targetLanguage || Language.DEFAULT);
    }
    this.currentShowId = null;
    this.currentContext = Context.createEmpty(this.getSettings().targetLanguage);
    this.adapter?.clearMetadata?.();
    if (newIdStr && this.adapter?.requestMetadata) {
      this.logger.info('EpisodeContextManager', `Requesting fresh metadata for episode (${newIdStr}).`);
      this.adapter.requestMetadata(newIdStr);
    }
  }

  private notifyCurrentShowEpisodeChanged(newIdStr: string | null): void {
    let currentShowInfo: VideoMetadata | null = null;
    if (this.adapter) {
      try {
        currentShowInfo = this.adapter.getVideoInfo();
      } catch {
        // Ignore
      }
    }
    const targetLanguage = this.getSettings().targetLanguage || Language.DEFAULT;
    const matched = this.currentContext?.episodes?.find((e) => e.videoId === newIdStr);
    this.messageService
      .notifyEpisodeChanged(
        this.currentShowId!,
        targetLanguage,
        currentShowInfo?.fullTitle || this.currentContext?.title,
        currentShowInfo?.mainTitle || this.currentContext?.mainTitle,
        currentShowInfo?.showSummary || this.currentContext?.showSynopsis,
        currentShowInfo?.episodeSummary || matched?.synopsis,
        newIdStr || undefined,
        matched?.episodeNumber !== undefined ? String(matched.episodeNumber) : undefined,
        currentShowInfo?.seasonId,
      )
      .catch(() => {});
  }

  onMetadataLoaded(meta: VideoMetadata): void {
    if (!meta) return;
    this.latestMetadata = meta;
    this.historyTracker?.onMetadataLoaded(meta);

    if (meta.videoId) {
      this.currentMovieId = meta.videoId;
      this.learningManager?.onShowContext(
        meta.videoId,
        meta.fullTitle || meta.mainTitle || this.currentContext?.mainTitle,
        this.delegate.getCurrentRawLanguage(),
        Language.resolve(this.getSettings().targetLanguage).code,
      );
    }
    const newShowId = meta.showId || null;
    if (newShowId && this.currentShowId && newShowId !== this.currentShowId) {
      this.logger.info('EpisodeContextManager', `Show switch: ${this.currentShowId} -> ${newShowId}`);
      if (this.delegate.isContextValid()) {
        this.messageService.unloadContext(this.currentShowId, this.getSettings().targetLanguage || Language.DEFAULT);
      }
      this.currentContext = Context.createEmpty(this.getSettings().targetLanguage);
      this.currentShowId = newShowId;
      this.loadGlossaryAndNotify(meta);
    } else if (newShowId && !this.currentShowId) {
      this.currentContext = Context.createEmpty(this.getSettings().targetLanguage);
      this.currentShowId = newShowId;
      this.loadGlossaryAndNotify(meta);
    } else {
      this.notifyEpisodeContext(meta);
      this.warmupShowContext(true, meta);
    }
  }

  private loadGlossaryAndNotify(meta: VideoMetadata): void {
    const showId = meta.showId || this.currentShowId;
    if (!showId) return;

    if (this.delegate.isContextValid()) {
      this.messageService
        .getGlossaryContext({ showId, mainTitle: meta.mainTitle, videoId: meta.videoId })
        .then((res) => {
          if (res?.success && res.context) {
            this.currentContext = Context.fromDTO(res.context);
            this.delegate.onGlossaryUpdated(this.currentContext);
          }
        })
        .catch(() => {});

      this.notifyEpisodeContext(meta);
    }
    this.warmupShowContext(true, meta);
  }

  private notifyEpisodeContext(meta: VideoMetadata): void {
    const showId = meta.showId || this.currentShowId;
    if (!showId || !this.delegate.isContextValid()) return;
    const targetLanguage = this.getSettings().targetLanguage || Language.DEFAULT;
    this.messageService
      .notifyEpisodeChanged(
        showId,
        targetLanguage,
        meta.fullTitle,
        meta.mainTitle,
        meta.showSummary,
        meta.episodeSummary,
        meta.videoId || this.currentMovieId || undefined,
        meta.episodeNum !== undefined ? String(meta.episodeNum) : undefined,
        meta.seasonId,
      )
      .catch(() => {});
  }

  warmupShowContext(force = false, metadataOverride?: VideoMetadata): void {
    if (!this.delegate.isContextValid() || this.getSettings().enableSupervisor === false) return;
    if (!this.currentShowId) return;
    if (this.getSettings().targetLanguage === undefined) {
      setTimeout(() => this.warmupShowContext(force, metadataOverride), 300);
      return;
    }
    if (this.hasWarmedUpForEpisode && !force) return;

    const showInfo = this.resolveShowInfoForWarmup(metadataOverride);
    if (!showInfo.mainTitle && !showInfo.fullTitle && !showInfo.showSummary && !showInfo.episodeSummary) return;

    this.hasWarmedUpForEpisode = true;
    const sampleDialogues = this.delegate
      .getCues()
      .slice(0, 8)
      .map((c) => `[${c.id}]: ${c.rawText.replace(/\n+/g, ' ')}`)
      .join('\n');

    this.dispatchWarmupRequest(showInfo, sampleDialogues);
  }

  private resolveShowInfoForWarmup(override?: VideoMetadata): VideoMetadata {
    let showInfo: VideoMetadata = override || this.latestMetadata || {
      fullTitle: '',
      mainTitle: '',
      episodeTitle: '',
      videoId: this.currentMovieId || '',
    };
    if (!override && !this.latestMetadata && this.adapter) {
      showInfo = this.adapter.getVideoInfo();
    }
    if (!showInfo.videoId && this.currentMovieId) showInfo.videoId = this.currentMovieId;
    if (!showInfo.showId && this.currentShowId) showInfo.showId = this.currentShowId;
    return showInfo;
  }

  private dispatchWarmupRequest(showInfo: VideoMetadata, sampleDialogues: string): void {
    this.messageService
      .warmupGlossaryContext({
        title: showInfo.fullTitle,
        mainTitle: showInfo.mainTitle,
        videoId: showInfo.videoId,
        showId: showInfo.showId || this.currentShowId || undefined,
        seasonId: showInfo.seasonId,
        showSummary: showInfo.showSummary,
        episodeSummary: showInfo.episodeSummary,
        sampleDialogues,
      })
      .then((res) => {
        if (!this.delegate.isContextValid()) return;
        if (res?.success && res.context) {
          this.currentContext = Context.fromDTO(res.context);
          if (res.context.showId) {
            this.currentShowId = res.context.showId;
          }
          this.delegate.onGlossaryUpdated(this.currentContext);
        }
      })
      .catch((e) => this.logger.warn('EpisodeContextManager', e));
  }
}
