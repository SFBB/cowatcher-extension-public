import { SubtitleOverlay } from "../presentation/SubtitleOverlay";
import { IAdDetector } from "../domain/adapters/IAdDetector";
import {
  ExtensionSettings,
  NCW_CONSTANTS,
  PipelineConfig,
} from "@shared/utils/constants";
import {
  IStreamingAdapter,
  VideoMetadata,
} from "../domain/adapters/IStreamingAdapter";
import { computeTrackHash } from "@shared/utils/hash";
import { ContentMessageService } from "./services/ContentMessageService";
import { BrowserPlatformFactory } from "@shared/infrastructure/platform/BrowserPlatformFactory";
import { IBrowserPlatform } from "@shared/infrastructure/platform/IBrowserPlatform";
import { PrecedingContextItem } from "@shared/types/Messages";
import { Context } from "@shared/domain/entities/Context";
import { TranslationStatus } from "@shared/domain/entities/Translation";
import { Language } from "@shared/domain/value-objects/Language";
import {
  SubtitleCue,
  createSubtitleCue,
} from "@shared/domain/entities/Subtitle";
import { SubtitleAlignmentService } from "../domain/services/SubtitleAlignmentService";
import { Logger } from "@shared/utils/logger";

import { SubtitleLearningManager } from "./learning/SubtitleLearningManager";
import { WatchHistoryTracker } from "./history/WatchHistoryTracker";

export type CueItem = SubtitleCue;

export class SubtitleManager {
  overlay: SubtitleOverlay;
  adDetector: IAdDetector;
  adapter?: IStreamingAdapter;
  settings: Partial<ExtensionSettings>;
  platform: IBrowserPlatform;
  learningManager?: SubtitleLearningManager;
  historyTracker?: WatchHistoryTracker;

  video: HTMLVideoElement | null = null;
  cues: CueItem[] = [];
  translationMap: Map<
    number,
    {
      text: string;
      status: TranslationStatus;
      usedTerms?: Record<string, number>;
    }
  > = new Map();
  cueStateMap: Map<number, TranslationStatus> = new Map();
  canonicalReviewIndex: number = 0;

  sessionEpoch: number = 0;
  lastCuesLoadedAt: number = 0;
  currentMovieId: string | null = null;
  currentShowId: string | null = null;
  private hasWarmedUpForEpisode: boolean = false;
  private latestMetadata?: VideoMetadata;

  isTranslating: boolean = false;
  isReviewing: boolean = false;
  isPreReviewing: boolean = false;
  currentTrackHash: string = "";
  currentContext: Context = Context.createEmpty(Language.DEFAULT);

  activeCueId: number | null = null;
  _lastCueSig: string = "";
  rafId: number | null = null;
  _lastContentTime: number | null = null;
  _emptyCueSince: number | null = null;

  cadmiumOffset: number = 0;
  domOffset: number = 0;
  manualOffset: number = 0;
  _lastNativeCalibAt: number = 0;
  _hasLoggedEndOfCues: boolean = false;

  private isAsrTrack: boolean = false;
  private rawAsrCues: CueItem[] = [];
  private asrMergeIndex: number = 0;
  private isMergingAsr: boolean = false;
  private currentRawLanguage: string = ""; // bcp code

  private messageService: ContentMessageService;

  private logger: Logger = new Logger("SubtitleManager");

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
    if (this.adapter && this.overlay && typeof this.overlay.bindContainerResolver === 'function') {
      this.overlay.bindContainerResolver(() => this.adapter?.getPlayerContainer?.() || null);
    }
    this.messageService = ContentMessageService.getInstance();
    this.platform = BrowserPlatformFactory.getPlatform();

    if (this.adapter) {
      this.learningManager = new SubtitleLearningManager(
        this.adapter,
        this.messageService,
        this.settings as any
      );
      this.overlay.setLearningManager(this.learningManager);
      this.historyTracker = new WatchHistoryTracker(
        this.adapter,
        this.messageService
      );
    }

    this.bindVideoEvents = this.bindVideoEvents.bind(this);
    this.onTick = this.onTick.bind(this);
    this.onSeeked = this.onSeeked.bind(this);
    this.onSeeking = this.onSeeking.bind(this);

    this.messageService.onGlossaryChanged((context) => {
      if (context) {
        this.currentContext = Context.fromDTO(context);
        this.checkStaleCues();
        if (!context.isWarmedUp) {
          this.hasWarmedUpForEpisode = false;
          if (this.latestMetadata || this.adapter) {
            this.warmupShowContext(true);
          }
        }
      }
    });

    this.messageService.onCuesStale((payload) => {
      if (!payload) return;
      const currentMid = String(this.currentMovieId || "");
      const matchesEpisode =
        payload.movieId && String(payload.movieId) === currentMid;
      const matchesEpisodeList =
        Array.isArray(payload.movieIds) &&
        payload.movieIds.some((id: string) => String(id) === currentMid);
      const matchesTrack =
        payload.trackHash && payload.trackHash === this.currentTrackHash;
      const matchesShowTitle =
        payload.showTitle &&
        this.currentContext &&
        ((this.currentContext.mainTitle &&
          payload.showTitle
            .toLowerCase()
            .includes(this.currentContext.mainTitle.toLowerCase())) ||
          (this.currentContext.mainTitle &&
            this.currentContext.mainTitle
              .toLowerCase()
              .includes(payload.showTitle.toLowerCase())));
      const matchesShowId =
        payload.showId &&
        (String(payload.showId) === String(this.currentShowId) ||
          String(payload.showId) === String(this.currentContext?.showId));

      if (
        matchesEpisode ||
        matchesEpisodeList ||
        matchesTrack ||
        matchesShowTitle ||
        matchesShowId
      ) {
        this.logger.info(
          "Subtitle",
          `Cues invalidated (${payload.invalidatedCount || 0} cues). Clearing in-memory translations to re-translate with updated glossary.`,
        );
        this.translationMap.clear();
        this.cueStateMap.clear();
        this.canonicalReviewIndex = 0;
        this._lastCueSig = "";
        this.onTick();
        if (this.video) {
          this.checkPipeline(this.getEffectiveTime());
        }
      }
    });
  }

  isContextValid(): boolean {
    return this.platform.isContextValid();
  }

  isSameSubtitle(newCues: CueItem[], isAsr = false): boolean {
    const targetCues =
      isAsr && this.isAsrTrack && this.rawAsrCues.length > 0
        ? this.rawAsrCues
        : this.cues;
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
    return this.cueStateMap.get(cueId) || "untranslated";
  }

  isCueTranslated(cueId: number): boolean {
    const status = this.getCueStatus(cueId);
    return (
      (status === "raw" ||
        status === "pre_reviewing" ||
        status === "pre_reviewed" ||
        status === "reviewing" ||
        status === "reviewed") &&
      this.translationMap.has(cueId)
    );
  }

  isCueReviewed(cueId: number): boolean {
    return this.getCueStatus(cueId) === "reviewed";
  }

  checkCueStaleness(cueId: number): boolean {
    const trans = this.translationMap.get(cueId);
    if (!trans || !trans.usedTerms || Object.keys(trans.usedTerms).length === 0)
      return false;

    if (this.currentContext.checkTermStaleness(trans.usedTerms)) {
      this.logger.info(
        "Subtitle",
        `Cue #${cueId} uses outdated glossary terms:`,
        trans.usedTerms,
      );
      this.markCueStaleWithLookahead(cueId, Object.keys(trans.usedTerms));
      return true;
    }
    return false;
  }

  markCueStaleWithLookahead(cueId: number, staleTermKeys: string[]): void {
    this.cueStateMap.set(cueId, "stale");
    this.translationMap.delete(cueId);

    const cueIdx = this.cues.findIndex((c) => c.id === cueId);
    if (cueIdx >= 0) {
      const lookaheadLimit = Math.min(this.cues.length, cueIdx + 16);
      for (let j = cueIdx + 1; j < lookaheadLimit; j++) {
        const aheadCue = this.cues[j];
        const aheadTrans = this.translationMap.get(aheadCue.id);
        if (aheadTrans && aheadTrans.usedTerms) {
          const sharesStaleTerm = staleTermKeys.some((termKey) => {
            const norm = termKey.toLowerCase();
            return (
              aheadTrans.usedTerms && aheadTrans.usedTerms[norm] !== undefined
            );
          });
          if (sharesStaleTerm) {
            this.logger.info(
              "Subtitle",
              `Propagated staleness to cue #${aheadCue.id}`,
            );
            this.cueStateMap.set(aheadCue.id, "stale");
            this.translationMap.delete(aheadCue.id);
          }
        }
      }
    }
  }

  checkStaleCues(): void {
    if (!this.video || this.cues.length === 0) return;
    const effectiveTime = this.getEffectiveTime();
    const currentIdx = this.findCueIndexAtTime(effectiveTime);
    if (currentIdx >= 0) {
      let hasInvalidatedActive = false;
      const windowEnd = Math.min(this.cues.length, currentIdx + 10);
      for (let i = currentIdx; i < windowEnd; i++) {
        const cue = this.cues[i];
        if (cue && this.checkCueStaleness(cue.id)) {
          if (i === currentIdx) hasInvalidatedActive = true;
        }
      }
      if (hasInvalidatedActive) {
        this._lastCueSig = "";
        this.onTick();
        this.checkPipeline(effectiveTime);
      }
    }
  }

  loadCues(
    cues: CueItem[],
    movieId: string | number | null = null,
    isAsr = false,
    language?: string, // bcp code
  ): void {
    if (!cues || cues.length === 0) return;
    if (language) {
      this.currentRawLanguage = language;
    }
    if (this.isSameSubtitle(cues, isAsr)) {
      this.logger.info(
        "Subtitle",
        `Subtitle cues already loaded (${cues.length} cues). Skipping reload.`,
      );
      return;
    }

    if (movieId) {
      this.currentMovieId = String(movieId);
      this.learningManager?.onShowContext(
        this.currentMovieId,
        this.latestMetadata?.fullTitle || this.latestMetadata?.mainTitle || this.currentContext?.mainTitle,
        this.currentRawLanguage,
        Language.resolve(this.settings.targetLanguage).code
      );
    }

    // Tell background worker to immediately clear pending translation & review queues from any previous track/episode
    if (this.isContextValid()) {
      this.messageService.clearQueues().catch(() => {});
    }

    const epoch = Date.now();
    this.sessionEpoch = epoch;
    this.lastCuesLoadedAt = epoch;
    this.currentTrackHash = "";
    this.translationMap.clear();
    this.cueStateMap.clear();
    this.canonicalReviewIndex = 0;
    this.isTranslating = false;
    this.isReviewing = false;
    this.isPreReviewing = false;
    this.activeCueId = null;
    this._hasLoggedEndOfCues = false;

    const shouldMergeAsr =
      isAsr && this.settings.enableAutomaticAsrMerging !== false;
    this.isAsrTrack = shouldMergeAsr;

    if (shouldMergeAsr) {
      this.rawAsrCues = cues;
      this.asrMergeIndex = 0;
      this.isMergingAsr = false;
      this.cues = [];
      this.logger.info(
        "ASR-Pipeline",
        `📥 Loaded ${cues.length} raw ASR fragments (language: ${this.currentRawLanguage || language || "auto"}, movie: ${this.currentMovieId || "active"}). Initializing ASR auto-merge pipeline...`,
      );
    } else {
      this.rawAsrCues = [];
      this.asrMergeIndex = 0;
      this.isMergingAsr = false;
      this.cues = cues;
      // Asynchronously compute Track Hash and query subtitle cache / native tracks
      this.loadSubtitlesForCurrentTrack(cues, epoch);

      this.logger.info(
        "Subtitle",
        `Loaded ${cues.length} subtitle cues for movie (${this.currentMovieId || "active"}).`,
      );
    }

    if (this.settings.enabled !== false) {
      // 1. Immediately tick to display active cue (or placeholder) and trigger pipeline
      if (typeof document !== "undefined") {
        if (
          !this.video ||
          (document.body && !document.body.contains(this.video))
        ) {
          const v = document.querySelector("video");
          if (v) this.attachVideo(v);
        }
      }
      if (this.overlay && typeof this.overlay.mountToPlayer === "function") {
        this.overlay.mountToPlayer(this.adapter?.getPlayerContainer?.());
      }

      if (this.video) {
        this.onTick();
        const effectiveTime = this.getEffectiveTime();
        if (shouldMergeAsr) {
          this.checkAsrMergePipeline(effectiveTime);
        } else if (this.settings.preferNativeSubtitles === false) {
          this.checkPipeline(effectiveTime);
        }
        if (!this.video.paused) {
          this.startRafLoop();
        }
      }

      // 2. Defer Context Warmup so it NEVER blocks urgent playback start translation
      setTimeout(() => {
        if (this.sessionEpoch === epoch) {
          this.warmupShowContext();
        }
      }, 2500);
    } else {
      this.overlay.hide(true);
    }
  }

  /**
   * Clears currently loaded subtitle cues, aborts background pipeline queues,
   * advances session epoch to invalidate any pending async tasks,
   * and immediately hides the subtitle overlay.
   */
  clearCues(): void {
    if (this.isContextValid()) {
      this.messageService.clearQueues().catch(() => {});
    }

    const epoch = Date.now();
    this.sessionEpoch = epoch;
    this.cues = [];
    this.isAsrTrack = false;
    this.rawAsrCues = [];
    this.asrMergeIndex = 0;
    this.isMergingAsr = false;
    this.currentTrackHash = "";
    this.translationMap.clear();
    this.cueStateMap.clear();
    this.canonicalReviewIndex = 0;
    this.isTranslating = false;
    this.isReviewing = false;
    this.isPreReviewing = false;
    this.activeCueId = null;
    this._lastCueSig = "";
    this._hasLoggedEndOfCues = false;

    if (this.overlay) {
      this.overlay.hide(true);
    }

    this.logger.info("Subtitle", "Cleared subtitle cues and hid overlay.");
  }

  onEpisodeChange(newMovieId: string | number | null): void {
    const newIdStr = newMovieId ? String(newMovieId) : null;
    this.logger.info(
      "Subtitle",
      `Episode switch detected (${newIdStr || "new"}).`,
    );
    this.sessionEpoch = Date.now();

    // Check if newIdStr is confirmed to belong to the currently active show:
    const isKnownEpisodeOfCurrentShow = Boolean(
      newIdStr &&
      this.currentShowId &&
      (this.currentContext?.episodes?.some((e) => e.videoId === newIdStr) ||
        (this.latestMetadata?.videoId === newIdStr &&
          this.latestMetadata?.showId === this.currentShowId) ||
        (this.currentMovieId === newIdStr && this.currentShowId)),
    );

    // Only retain cues if the cues currently in memory were explicitly loaded for THIS new movie ID:
    const cuesBelongToNewEpisode =
      this.cues &&
      this.cues.length > 0 &&
      this.currentMovieId &&
      newIdStr &&
      this.currentMovieId === newIdStr;

    if (cuesBelongToNewEpisode) {
      this.logger.info(
        "Subtitle",
        `Retaining ${this.cues.length} cues confirmed for episode (${newIdStr}).`,
      );
    } else {
      this.logger.info(
        "Subtitle",
        `Resetting cues for episode switch (previous: ${this.currentMovieId}, next: ${newIdStr}).`,
      );
      this.cues = [];
      this.currentMovieId = newIdStr;
      this.latestMetadata = undefined;
      if (newIdStr) {
        this.learningManager?.onShowContext(
          newIdStr,
          this.currentContext?.mainTitle,
          this.currentRawLanguage,
          Language.resolve(this.settings.targetLanguage).code
        );
      }
    }

    if (!isKnownEpisodeOfCurrentShow) {
      if (this.currentShowId && this.isContextValid()) {
        this.logger.info(
          "Subtitle",
          `📺 Episode ${newIdStr} does not belong to show ${this.currentShowId}. Unloading old show context.`,
        );
        this.messageService.unloadContext(
          this.currentShowId,
          this.settings.targetLanguage || Language.DEFAULT,
        );
      }
      this.currentShowId = null;
      this.currentContext = Context.createEmpty(this.settings.targetLanguage);
      if (this.adapter?.clearMetadata) {
        this.adapter.clearMetadata();
      }
      if (newIdStr && this.adapter?.requestMetadata) {
        this.logger.info(
          "Subtitle",
          `Requesting fresh metadata from streaming adapter for episode (${newIdStr}).`,
        );
        this.adapter.requestMetadata(newIdStr);
      }
    }

    this.translationMap.clear();
    this.cueStateMap.clear();
    this.canonicalReviewIndex = 0;
    this.currentTrackHash = "";
    this.hasWarmedUpForEpisode = false;
    this.isTranslating = false;
    this.isReviewing = false;
    this.isPreReviewing = false;
    this.activeCueId = null;
    this._lastCueSig = "";
    this._lastContentTime = null;
    this._emptyCueSince = null;
    this.cadmiumOffset = 0;
    this.domOffset = 0;
    this._lastNativeCalibAt = 0;
    this._hasLoggedEndOfCues = false;
    if (typeof document !== "undefined" && document.documentElement) {
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
    this.overlay.hide(true);

    if (this.adDetector && typeof this.adDetector.reset === "function") {
      this.adDetector.reset();
    }

    // Only notify background if this is confirmed to be an episode of the current show.
    // If it's a cross-show or unconfirmed switch, we wait until onMetadataLoaded arrives with confirmed show metadata!
    if (
      isKnownEpisodeOfCurrentShow &&
      this.isContextValid() &&
      this.currentShowId
    ) {
      let currentShowInfo: VideoMetadata | null = null;
      if (this.adapter) {
        try {
          currentShowInfo = this.adapter.getVideoInfo();
        } catch (_e) {
          // Ignore
        }
      }
      const targetLanguage = this.settings.targetLanguage || Language.DEFAULT;
      const matchedEpisode = this.currentContext?.episodes?.find(
        (e) => e.videoId === newIdStr,
      );
      this.messageService
        .notifyEpisodeChanged(
          this.currentShowId,
          targetLanguage,
          currentShowInfo?.fullTitle || this.currentContext?.title,
          currentShowInfo?.mainTitle || this.currentContext?.mainTitle,
          currentShowInfo?.showSummary || this.currentContext?.showSynopsis,
          currentShowInfo?.episodeSummary || matchedEpisode?.synopsis,
          newIdStr || undefined,
          matchedEpisode?.episodeNumber !== undefined
            ? String(matchedEpisode.episodeNumber)
            : undefined,
          currentShowInfo?.seasonId,
        )
        .catch(() => {});
    }

    // If enabled and cues are retained, immediately align and start pipeline
    if (
      this.settings.enabled !== false &&
      this.cues &&
      this.cues.length > 0 &&
      isKnownEpisodeOfCurrentShow
    ) {
      this.warmupShowContext();
      if (this.video) {
        const effectiveTime = this.getEffectiveTime();
        this.onTick();
        this.checkPipeline(effectiveTime);
        if (!this.video.paused) {
          this.startRafLoop();
        }
      }
    }
  }

  /**
   * Handle metadata loaded from streaming adapter
   */
  onMetadataLoaded(meta: VideoMetadata): void {
    if (!meta) return;
    this.latestMetadata = meta;
    if (this.historyTracker) {
      this.historyTracker.onMetadataLoaded(meta);
    }
    if (meta.videoId) {
      this.currentMovieId = meta.videoId;
      this.learningManager?.onShowContext(
        meta.videoId,
        meta.fullTitle || meta.mainTitle || this.currentContext?.mainTitle,
        this.currentRawLanguage,
        Language.resolve(this.settings.targetLanguage).code
      );
    }
    const newShowId = meta.showId || null;

    // Detect cross-show switching in the same tab:
    // When a different show is switched into, unload the previous show's Context and load the new show's glossary context.
    if (newShowId && this.currentShowId && newShowId !== this.currentShowId) {
      this.logger.info(
        "Subtitle",
        `📺 Show switch detected from ${this.currentShowId} to ${newShowId}. Unloading old show context and loading new.`,
      );
      if (this.isContextValid()) {
        this.messageService.unloadContext(
          this.currentShowId,
          this.settings.targetLanguage || Language.DEFAULT,
        );
      }
      this.currentContext = Context.createEmpty(this.settings.targetLanguage);
      this.currentShowId = newShowId;
      this.loadGlossaryAndNotify(meta);
    } else if (newShowId && !this.currentShowId) {
      this.logger.info(
        "Subtitle",
        `📺 Show context initialized with showId: ${newShowId}. Loading context.`,
      );
      this.currentContext = Context.createEmpty(this.settings.targetLanguage);
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

    if (this.isContextValid()) {
      this.messageService
        .getGlossaryContext({
          showId,
          mainTitle: meta.mainTitle,
          videoId: meta.videoId,
        })
        .then((res) => {
          if (res && res.success && res.context) {
            this.currentContext = Context.fromDTO(res.context);
            this.checkStaleCues();
          }
        })
        .catch(() => {});

      this.notifyEpisodeContext(meta);
    }

    this.warmupShowContext(true, meta);
  }

  private notifyEpisodeContext(meta: VideoMetadata): void {
    const showId = meta.showId || this.currentShowId;
    if (!showId || !this.isContextValid()) return;
    const targetLanguage = this.settings.targetLanguage || Language.DEFAULT;
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

  /**
   * Warm up Context with Supervisor Model (gemma4:e4b)
   */
  warmupShowContext(force = false, metadataOverride?: VideoMetadata): void {
    if (!this.isContextValid() || this.settings.enableSupervisor === false)
      return;
    if (!this.currentShowId) {
      this.logger.info(
        "Glossary",
        "Try to warmup show context without a valid show id!",
      );
      return;
    } else {
      this.logger.info(
        "Glossary",
        `Try to warmup show context with show id ${this.currentShowId}!`,
      );
    }
    if (this.settings.targetLanguage === undefined) {
      this.logger.info(
        "Glossary",
        `There is no target lanaguage when trying to warm up show context of show ${this.currentShowId}.`,
      );
      setTimeout(() => this.warmupShowContext(force, metadataOverride), 300);
      return;
    }
    if (this.hasWarmedUpForEpisode && !force) return;

    let showInfo: VideoMetadata = metadataOverride ||
      this.latestMetadata || {
        fullTitle: "",
        mainTitle: "",
        episodeTitle: "",
        videoId: this.currentMovieId || "",
      };
    if (!metadataOverride && !this.latestMetadata && this.adapter) {
      showInfo = this.adapter.getVideoInfo();
    }
    if (!showInfo.videoId && this.currentMovieId) {
      showInfo.videoId = this.currentMovieId;
    }
    if (!showInfo.showId && this.currentShowId) {
      showInfo.showId = this.currentShowId;
    }

    if (
      !showInfo.mainTitle &&
      !showInfo.fullTitle &&
      !showInfo.showSummary &&
      !showInfo.episodeSummary
    ) {
      return;
    }

    this.hasWarmedUpForEpisode = true;

    const sampleDialogues = this.cues
      .slice(0, 8)
      .map((c) => `[${c.id}]: ${c.rawText.replace(/\n+/g, " ")}`)
      .join("\n");

    this.logger.info(
      "Subtitle",
      `Supervisor warming up context for "${showInfo.fullTitle || showInfo.mainTitle || "Streaming"}" (showId=${showInfo.showId || this.currentShowId || "N/A"})...`,
    );

    this.messageService
      .warmupGlossaryContext({
        title: showInfo.fullTitle,
        mainTitle: showInfo.mainTitle,
        videoId: showInfo.videoId,
        showId: showInfo.showId || this.currentShowId || undefined,
        seasonId: showInfo.seasonId,
        showSummary: showInfo.showSummary,
        episodeSummary: showInfo.episodeSummary,
        sampleDialogues: sampleDialogues,
      })
      .then((res) => {
        if (!this.isContextValid()) return;
        if (res && res.success && res.context) {
          this.logger.info("Subtitle", "Context warmed up successfully.");
          this.currentContext = Context.fromDTO(res.context);
          if (res.context.showId) {
            this.currentShowId = res.context.showId;
          }
          this.checkStaleCues();
        }
      })
      .catch((e) => {
        this.logger.warn("Subtitle", e);
      });
  }

  /**
   * Request cached cues for this subtitle track
   */
  async requestSubtitleCache(
    trackHash: string,
    cues: CueItem[],
  ): Promise<boolean> {
    if (!this.isContextValid() || !trackHash) return false;
    const epoch = this.sessionEpoch;

    try {
      const targetLangCode = this.settings.targetLanguage?.code || "en";
      const res = await this.messageService.getSubtitleCache({
        trackHash,
        movieId: this.currentMovieId || undefined,
        targetLanguage: targetLangCode,
      });

      if (!this.isContextValid()) return false;
      if (this.sessionEpoch !== epoch || this.currentTrackHash !== trackHash)
        return false;

      if (res && res.hit && res.cachedCues) {
        const cached = res.cachedCues;
        let hitCount = 0;
        let reviewedCount = 0;
        let rawCount = 0;

        for (const [idStr, entry] of Object.entries(cached)) {
          const id = parseInt(idStr, 10);
          if (isNaN(id) || !entry || !entry.transText) continue;

          const entryStatus: TranslationStatus =
            (entry.status as TranslationStatus) || "raw";
          if (entryStatus === "stale") continue;

          // Check if cached entry has stale terms against live context
          if (
            entry.usedTerms &&
            this.currentContext.checkTermStaleness(entry.usedTerms)
          ) {
            this.cueStateMap.set(id, "stale");
            continue;
          }

          const existing = this.translationMap.get(id);
          if (
            !existing ||
            (existing.status !== "reviewed" && entryStatus === "reviewed")
          ) {
            this.translationMap.set(id, {
              text: entry.transText,
              status: entryStatus,
              usedTerms: entry.usedTerms,
            });
            this.cueStateMap.set(id, entryStatus);
            hitCount++;
            if (entryStatus === "reviewed" || entryStatus === "pre_reviewed")
              reviewedCount++;
            else rawCount++;
          }
        }

        this.logger.info(
          "Subtitle",
          `Loaded ${hitCount} cached cues for track (${trackHash.slice(0, 8)}...) [${reviewedCount} reviewed, ${rawCount} raw, out of ${cues.length} total].`,
        );

        if (this.video) {
          const effectiveTime = this.getEffectiveTime();
          const activeCues = this.findActiveCues(effectiveTime);
          if (activeCues.some((c) => this.translationMap.has(c.id))) {
            this._lastCueSig = "";
            this.onTick();
          }
        }

        return hitCount >= cues.length * 0.7;
      }
      return false;
    } catch (e) {
      this.logger.warn("Subtitle", "Request cache error:", e);
      return false;
    }
  }

  /**
   * Main subtitle acquisition pipeline for a track:
   * 1. Query persistent cache
   * 2. If not covered by cache and preferNativeSubtitles !== false, fetch & align official native track
   * 3. Fallback to AI translation pipeline if needed
   */
  private async loadSubtitlesForCurrentTrack(
    cues: CueItem[],
    epoch: number,
    trackHash?: string,
  ): Promise<void> {
    if (!cues || cues.length === 0) return;

    try {
      const hash = trackHash || (await computeTrackHash(cues));
      if (this.sessionEpoch !== epoch || this.cues !== cues) return;

      this.currentTrackHash = hash;
      this.logger.info("Subtitle", `Subtitle Track Hash: ${hash}`);

      // 1. Query persistent cache
      const cacheHit = await this.requestSubtitleCache(hash, cues);

      if (this.sessionEpoch !== epoch || this.cues !== cues) return;

      // 2. If not fully covered by cache and native subtitles are preferred, try native track
      if (!cacheHit && this.settings.preferNativeSubtitles !== false) {
        const nativeLoaded = await this.tryLoadNativeBilingualSubtitles(
          cues,
          epoch,
          hash,
        );
        if (nativeLoaded) {
          this.logger.info(
            "Subtitle",
            "✅ Native official bilingual subtitles loaded and active.",
          );
          return;
        }
      }

      if (this.sessionEpoch !== epoch || this.cues !== cues) return;

      // 3. Fallback to AI translation pipeline if needed
      if (this.video && this.settings.enabled !== false) {
        const effectiveTime = this.getEffectiveTime();
        this.onTick();
        this.checkPipeline(effectiveTime);
      }
    } catch (e) {
      this.logger.warn("Subtitle", "Track hash / subtitle load error:", e);
      if (
        this.video &&
        this.settings.enabled !== false &&
        this.sessionEpoch === epoch
      ) {
        const effectiveTime = this.getEffectiveTime();
        this.onTick();
        this.checkPipeline(effectiveTime);
      }
    }
  }

  /**
   * Attempts to fetch and align native platform official bilingual subtitles
   */
  private async tryLoadNativeBilingualSubtitles(
    cues: CueItem[],
    epoch: number,
    trackHash?: string,
  ): Promise<boolean> {
    if (this.settings.preferNativeSubtitles === false) return false;
    if (
      !this.adapter ||
      typeof this.adapter.fetchNativeTargetTrack !== "function"
    )
      return false;

    const targetLang = this.settings.targetLanguage || Language.DEFAULT;
    this.logger.info(
      "Subtitle",
      `Checking native target subtitle track for language: ${targetLang.code || "default"}...`,
    );

    try {
      const nativeCues = await this.adapter.fetchNativeTargetTrack(
        targetLang,
        this.currentMovieId || undefined,
      );

      if (!nativeCues || nativeCues.length === 0) {
        this.logger.info(
          "Subtitle",
          "No native target subtitle track returned from platform.",
        );
        return false;
      }

      if (this.sessionEpoch !== epoch || this.cues !== cues) {
        return false;
      }

      // Guard: Check if the returned native track is literally identical to the source cues (same language)
      if (this.cues.length > 0 && nativeCues.length > 0) {
        const sampleCheckCount = Math.min(
          this.cues.length,
          nativeCues.length,
          10,
        );
        let identicalCount = 0;
        for (let i = 0; i < sampleCheckCount; i++) {
          if (
            (this.cues[i].rawText || "").trim() ===
            (nativeCues[i].text || "").trim()
          ) {
            identicalCount++;
          }
        }
        if (identicalCount >= sampleCheckCount * 0.7) {
          const isTargetLangFamilyMatch = this.isLanguageMatchingTarget(
            this.currentRawLanguage,
            targetLang.code,
          );
          if (isTargetLangFamilyMatch) {
            this.logger.info(
              "Subtitle",
              `Native target track text and language (${this.currentRawLanguage}) match current source track (${targetLang.code}). Satisfied without translation.`,
            );
            return true;
          }
          this.logger.info(
            "Subtitle",
            "Native target track text is identical to current source track (same language). Skipping self-alignment.",
          );
          return false;
        }
      }

      const alignResult = SubtitleAlignmentService.align(this.cues, nativeCues);
      this.logger.info(
        "Subtitle",
        `Native track alignment result: ${alignResult.totalMatched}/${alignResult.totalSource} cues matched (${(alignResult.matchCoverage * 100).toFixed(1)}% coverage).`,
      );

      // If coverage is at least 70%, adopt native subtitles
      if (alignResult.matchCoverage >= 0.7) {
        const resultsMap: Record<number, string> = {};
        const pairs: Array<{ originalText: string; translatedText: string }> =
          [];

        alignResult.alignedMap.forEach((matchedText, cueId) => {
          this.translationMap.set(cueId, {
            text: matchedText,
            status: "reviewed",
          });
          this.cueStateMap.set(cueId, "reviewed");
          resultsMap[cueId] = matchedText;

          const srcCue = this.cues.find((c) => c.id === cueId);
          if (srcCue) {
            pairs.push({
              originalText: srcCue.rawText,
              translatedText: matchedText,
            });
          }
        });

        // Immediately update presentation
        this._lastCueSig = "";
        this.onTick();

        // Persist aligned native subtitles into TrackCacheRepository
        const effectiveHash = trackHash || this.currentTrackHash;
        if (effectiveHash) {
          const showInfo = this.adapter.getVideoInfo();
          this.messageService
            .saveSubtitleCache({
              trackHash: effectiveHash,
              movieId: this.currentMovieId || "",
              showTitle: showInfo?.mainTitle || showInfo?.fullTitle || "",
              targetLanguage: targetLang.code || "en",
              provider: "netflix_native",
              translationModel: "official",
              supervisorModel: "official",
              results: resultsMap,
            })
            .catch(() => {});
        }

        // Supervisor Glossary Extraction from Native Subtitles (if enabled)
        if (this.settings.extractTermsFromNativeSubtitles && pairs.length > 0) {
          const showInfo = this.adapter.getVideoInfo();
          const showId =
            showInfo?.showId || this.currentShowId || this.currentMovieId || "";
          this.messageService
            .extractTermsFromNativeBilingualCues({
              showId,
              targetLanguage: targetLang,
              pairs,
            })
            .catch((e) => this.logger.warn("Subtitle", e));
        }

        return true;
      }

      return false;
    } catch (err) {
      this.logger.warn(
        "Subtitle",
        "Error during native subtitle loading:",
        err,
      );
      return false;
    }
  }

  private isLanguageMatchingTarget(
    rawLangStr: string,
    targetLangCode: string,
  ): boolean {
    if (!rawLangStr || !targetLangCode) return false;
    try {
      const rawLang = Language.resolve(rawLangStr);
      const targetLang = Language.resolve(targetLangCode);
      return rawLang.code.toLowerCase() === targetLang.code.toLowerCase();
    } catch {
      return rawLangStr
        .toLowerCase()
        .startsWith(targetLangCode.toLowerCase().slice(0, 2));
    }
  }

  /**
   * Helper: Extract up to `maxContext` preceding cues with their original and translated text
   */
  getPrecedingContextItems(
    targetCueIndex: number,
    maxContext = 3,
  ): PrecedingContextItem[] {
    if (!this.cues || this.cues.length === 0 || targetCueIndex <= 0) return [];
    const start = Math.max(0, targetCueIndex - maxContext);
    const contextCues = this.cues.slice(start, targetCueIndex);
    return contextCues.map((c) => {
      const transEntry = this.translationMap.get(c.id);
      return createSubtitleCue({
        ...c,
        transText: transEntry ? transEntry.text : c.transText || undefined,
      });
    });
  }

  attachVideo(videoEl: HTMLVideoElement): void {
    if (this.video === videoEl) return;

    this.detachVideo();
    this.video = videoEl;

    if (this.historyTracker) {
      this.historyTracker.attachVideo(videoEl);
    }

    this.video.addEventListener("timeupdate", this.onTick);
    this.video.addEventListener("seeking", this.onSeeking);
    this.video.addEventListener("seeked", this.onSeeked);
    this.video.addEventListener("play", this.startRafLoop.bind(this));
    this.video.addEventListener("pause", this.stopRafLoop.bind(this));

    this.logger.info("Subtitle", "Attached to video element.");

    if (!this.video.paused) {
      this.startRafLoop();
    }
  }

  detachVideo(): void {
    if (this.historyTracker) {
      this.historyTracker.detachVideo();
    }
    if (this.video) {
      this.video.removeEventListener("timeupdate", this.onTick);
      this.video.removeEventListener("seeking", this.onSeeking);
      this.video.removeEventListener("seeked", this.onSeeked);
      this.stopRafLoop();
      this.video = null;
    }
  }

  bindVideoEvents(): void {
    const video = document.querySelector("video");
    if (video) {
      this.attachVideo(video);
    }
  }

  startRafLoop(): void {
    this.stopRafLoop();
    const loop = () => {
      this.onTick();
      if (this.video && !this.video.paused) {
        this.rafId = requestAnimationFrame(loop);
      }
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stopRafLoop(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  getContentTime(): number {
    if (!this.video) return 0;

    if (typeof document !== "undefined" && document.documentElement) {
      const atomicStr = document.documentElement.dataset?.ncwSegmentAtomic;
      let baseTime = NaN;
      let syncAt = NaN;
      let isPaused = Boolean(this.video && this.video.paused);
      let rate = (this.video && this.video.playbackRate) || 1.0;

      if (atomicStr) {
        const parts = atomicStr.split("|");
        if (parts.length >= 4) {
          baseTime = parseFloat(parts[0]);
          syncAt = parseFloat(parts[1]);
          isPaused =
            parts[2] === "1" || Boolean(this.video && this.video.paused);
          rate = parseFloat(parts[3]) || rate;
        }
      }

      if (isNaN(baseTime)) {
        const segStr = document.documentElement.dataset?.ncwSegmentTime;
        const syncStr = document.documentElement.dataset?.ncwSegmentSyncAt;
        const isPausedStr = document.documentElement.dataset?.ncwIsPaused;
        const rateStr = document.documentElement.dataset?.ncwPlaybackRate;

        if (segStr !== undefined && segStr !== "") {
          baseTime = parseFloat(segStr);
          syncAt = parseFloat(syncStr || "0");
          isPaused =
            isPausedStr === "true" || Boolean(this.video && this.video.paused);
          rate = parseFloat(rateStr || "1") || rate;
        }
      }

      if (!isNaN(baseTime) && baseTime >= 0) {
        if (isPaused) {
          this._lastContentTime = baseTime;
          return baseTime;
        }

        let calculatedTime = baseTime;
        if (!isNaN(syncAt) && isFinite(syncAt)) {
          const now =
            typeof performance !== "undefined" && performance.now
              ? performance.now()
              : Date.now();
          const elapsedMs = Math.max(0, now - syncAt);
          if (elapsedMs < 5000) {
            calculatedTime = baseTime + (elapsedMs / 1000) * rate;
          }
        }

        if (
          !this.video.seeking &&
          typeof this._lastContentTime === "number" &&
          this._lastContentTime > 0
        ) {
          const delta = calculatedTime - this._lastContentTime;
          if (delta < 0 && delta > -0.25) {
            calculatedTime = this._lastContentTime;
          }
        }

        this._lastContentTime = calculatedTime;
        return calculatedTime;
      }
    }

    const rawTime =
      typeof this.video.currentTime === "number" ? this.video.currentTime : 0;
    this._lastContentTime = rawTime;
    return rawTime;
  }

  getEffectiveTime(): number {
    if (!this.video) return 0;
    const contentTime = this.getContentTime();

    const rawCadmium = document.documentElement?.dataset?.ncwCadmiumOffset;
    const datasetCadmium = rawCadmium ? parseFloat(rawCadmium) : NaN;
    if (!isNaN(datasetCadmium) && Math.abs(datasetCadmium) <= 180) {
      this.cadmiumOffset = datasetCadmium;
    }
    const validCadmium =
      typeof this.cadmiumOffset === "number" &&
      Math.abs(this.cadmiumOffset) <= 180
        ? this.cadmiumOffset
        : 0;

    const domOffset =
      this.settings.enableDomSubtitleSync && typeof this.domOffset === "number"
        ? this.domOffset
        : 0;

    const manualOffset =
      typeof this.settings.subSyncOffset === "number"
        ? this.settings.subSyncOffset
        : this.manualOffset || 0;
    this.manualOffset = manualOffset;

    return Math.max(0, contentTime + validCadmium + domOffset + manualOffset);
  }

  setCadmiumOffset(offset: number): void {
    if (typeof offset === "number" && !isNaN(offset)) {
      this.cadmiumOffset = offset;
    }
  }

  setAdOffset(offset: number): void {
    if (typeof offset === "number" && !isNaN(offset)) {
      this.cadmiumOffset = -offset;
    }
  }

  calibrateOffsetFromNativeSubtitles(): void {
    if (!this.settings.enableDomSubtitleSync) return;
    if (typeof document === "undefined") return;
    if (!this.video || !this.cues || this.cues.length === 0) return;
    const timedTextContainer = document.querySelector(".player-timedtext");
    if (!timedTextContainer) return;

    const nativeText = timedTextContainer.textContent?.trim();
    if (!nativeText || nativeText.length < 3) return;

    const norm = (s: string) =>
      s.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
    const cleanNative = norm(nativeText);
    if (cleanNative.length < 3) return;

    const apiTime = this.getContentTime() + (this.cadmiumOffset || 0);
    const objectiveTime = apiTime + (this.domOffset || 0);

    const candidates = this.cues.filter((c) => {
      const cleanCue = norm(c.rawText);
      return (
        cleanCue.length >= 3 &&
        (cleanCue === cleanNative ||
          cleanCue.includes(cleanNative) ||
          cleanNative.includes(cleanCue))
      );
    });

    if (candidates.length > 0) {
      const match = candidates.reduce((prev, curr) => {
        return Math.abs(curr.startTime - objectiveTime) <
          Math.abs(prev.startTime - objectiveTime)
          ? curr
          : prev;
      });

      const cueMid = (match.startTime + match.endTime) / 2;
      const neededDomOffset = Math.round((cueMid - apiTime) * 10) / 10;

      if (
        neededDomOffset >= -120 &&
        neededDomOffset <= 300 &&
        Math.abs((this.domOffset || 0) - neededDomOffset) > 1.0
      ) {
        this.logger.info(
          "Subtitle",
          `Auto-calibrated DOM offset: ${(this.domOffset || 0).toFixed(2)}s -> ${neededDomOffset.toFixed(2)}s (matched cue #${match.id}: "${match.rawText.replace(/\n+/g, " ").slice(0, 30)}")`,
        );
        this.domOffset = neededDomOffset;
      }
    }
  }

  onSeeking(): void {
    if (!this.isContextValid()) {
      this.detachVideo();
      return;
    }
    this._lastContentTime = null;
    this._emptyCueSince = null;
    this.overlay.hide(true);
    this.activeCueId = null;
    this._lastCueSig = "";
  }

  onSeeked(): void {
    if (!this.isContextValid()) {
      this.detachVideo();
      return;
    }
    this._lastContentTime = null;
    this._emptyCueSince = null;
    if (!this.video || Boolean(this.adDetector?.isAdPlaying)) return;
    if (this.cues.length === 0 && !this.isAsrTrack) return;
    const effectiveTime = this.getEffectiveTime();
    this.logger.info(
      "Subtitle",
      `Timeline jump detected at ${effectiveTime.toFixed(2)}s (contentTime: ${this.getContentTime().toFixed(2)}s, raw: ${this.video.currentTime.toFixed(2)}s, domOffset: ${(this.domOffset || 0).toFixed(2)}s, manualOffset: ${(this.manualOffset || 0).toFixed(2)}s)`,
    );

    if (this.isAsrTrack) {
      this.checkAsrMergePipeline(effectiveTime);
    }
    this.onTick();
    this.checkPipeline(effectiveTime);
  }

  onTick(): void {
    if (!this.isContextValid()) {
      this.detachVideo();
      return;
    }
    if (!this.video || this.cues.length === 0) return;

    if (
      this.settings.enabled === false ||
      Boolean(this.adDetector?.isAdPlaying)
    ) {
      this._emptyCueSince = null;
      if (
        this.overlay.isVisible ||
        this.activeCueId !== null ||
        this._lastCueSig !== ""
      ) {
        this.overlay.hide(true);
        this.activeCueId = null;
        this._lastCueSig = "";
      }
      return;
    }

    const effectiveTime = this.getEffectiveTime();

    const now = Date.now();
    if (!this._lastNativeCalibAt || now - this._lastNativeCalibAt > 1500) {
      this._lastNativeCalibAt = now;
      this.calibrateOffsetFromNativeSubtitles();
    }

    const activeCues = this.findActiveCues(effectiveTime);

    if (activeCues.length > 0) {
      this._emptyCueSince = null;

      // JIT staleness verification on active cues
      for (const c of activeCues) {
        this.checkCueStaleness(c.id);
      }

      const cueSig = activeCues
        .map((c) => {
          const entry = this.translationMap.get(c.id);
          return `${c.id}:${entry ? entry.text : ""}`;
        })
        .join("|");

      if (this._lastCueSig !== cueSig) {
        this._lastCueSig = cueSig;
        this.activeCueId = activeCues[0].id;

        const cueItems = activeCues.map((c) => {
          const entry = this.translationMap.get(c.id);
          return {
            id: c.id,
            originalText: c.rawText,
            translatedText: entry ? entry.text : null,
            position: c.position || "bottom",
          };
        });

        if (typeof this.overlay.showCues === "function") {
          this.overlay.showCues(cueItems);
        } else {
          this.overlay.show(
            cueItems[0].originalText,
            cueItems[0].translatedText,
          );
        }

        const first = cueItems[0];
        const isFallbackRaw =
          this.isAsrTrack && !this.cues.some((c) => c.id === first.id);
        const transPreview = first.translatedText
          ? ` -> "${first.translatedText}"`
          : " (pending translation)";

        if (isFallbackRaw) {
          this.logger.warn(
            "ASR-Sync",
            `⚠️ Buffer underrun at ${effectiveTime.toFixed(2)}s: displaying fallback raw ASR fragment #${first.id} [${activeCues[0].startTime.toFixed(2)}s - ${activeCues[0].endTime.toFixed(2)}s]: "${first.originalText}"`,
          );
          this.checkAsrMergePipeline(effectiveTime);
        } else {
          this.logger.info(
            this.isAsrTrack ? "ASR-Sync" : "Subtitle",
            `Cue #${first.id} [${activeCues[0].startTime.toFixed(2)}s - ${activeCues[0].endTime.toFixed(2)}s] (time: ${effectiveTime.toFixed(2)}s): "${first.originalText.replace(/\n+/g, " ").slice(0, 50)}"${transPreview}`,
          );
        }
      }
    } else {
      const nowMs =
        typeof performance !== "undefined" && performance.now
          ? performance.now()
          : Date.now();
      if (!this._emptyCueSince) {
        this._emptyCueSince = nowMs;
      }

      const isPaused = this.video ? this.video.paused : false;
      const emptyElapsed = nowMs - this._emptyCueSince;
      const hideGraceMs = isPaused ? 0 : this.isAsrTrack ? 600 : 80;

      if (emptyElapsed >= hideGraceMs) {
        if (this.activeCueId !== null || this._lastCueSig !== "") {
          if (this.isAsrTrack && !isPaused) {
            this.logger.info(
              "ASR-Sync",
              `Overlay hidden at ${effectiveTime.toFixed(2)}s (silence elapsed: ${Math.round(emptyElapsed)}ms >= ${hideGraceMs}ms).`,
            );
          }
          this.activeCueId = null;
          this._lastCueSig = "";
          this.overlay.hide();
        }
      }
    }

    if (this.cues && this.cues.length > 0) {
      const lastCue = this.cues[this.cues.length - 1];
      if (lastCue && effectiveTime > lastCue.endTime) {
        if (!this._hasLoggedEndOfCues) {
          this._hasLoggedEndOfCues = true;
          this.logger.info(
            "Subtitle",
            `Reached end of subtitle dialogue at ${effectiveTime.toFixed(1)}s (final cue #${lastCue.id} ended at ${lastCue.endTime.toFixed(1)}s, total cues: ${this.cues.length}).`,
          );
        }
      } else {
        this._hasLoggedEndOfCues = false;
      }
    }

    this.checkPipeline(effectiveTime);
  }

  findActiveRawAsrCues(time: number): CueItem[] {
    if (!this.rawAsrCues || this.rawAsrCues.length === 0) return [];
    let low = 0;
    let high = this.rawAsrCues.length - 1;
    let foundIdx = -1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const cue = this.rawAsrCues[mid];
      if (cue.startTime <= time && cue.endTime >= time) {
        foundIdx = mid;
        break;
      } else if (cue.startTime > time) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    if (foundIdx === -1 && high >= 0 && high < this.rawAsrCues.length) {
      const prev = this.rawAsrCues[high];
      if (time >= prev.startTime && time <= prev.endTime + 0.5) {
        foundIdx = high;
      }
    }

    if (foundIdx >= 0) {
      const raw = this.rawAsrCues[foundIdx];
      return [
        createSubtitleCue({
          id: raw.id,
          startTime: raw.startTime,
          endTime: raw.endTime,
          rawText: raw.rawText,
          position: raw.position || "bottom",
        }),
      ];
    }
    return [];
  }

  findActiveCues(time: number): CueItem[] {
    if (!this.cues || this.cues.length === 0) {
      if (this.isAsrTrack && this.rawAsrCues.length > 0) {
        return this.findActiveRawAsrCues(time);
      }
      return [];
    }

    let low = 0;
    let high = this.cues.length - 1;
    let startIdx = 0;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.cues[mid].startTime <= time) {
        startIdx = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const active: CueItem[] = [];
    for (let i = startIdx; i >= 0; i--) {
      const cue = this.cues[i];
      if (time - cue.startTime > 30) {
        break;
      }
      if (time >= cue.startTime && time <= cue.endTime) {
        active.unshift(cue);
      }
    }

    for (let i = startIdx + 1; i < this.cues.length; i++) {
      const cue = this.cues[i];
      if (cue.startTime > time) break;
      if (time >= cue.startTime && time <= cue.endTime) {
        active.push(cue);
      }
    }

    // Safety fallback: If active merged cues is empty for ASR:
    // 1. First check if previous cue should linger during natural speaking pauses (up to 3.0s until next cue)
    if (active.length === 0 && this.isAsrTrack && this.cues.length > 0) {
      if (startIdx >= 0 && startIdx < this.cues.length) {
        const prevCue = this.cues[startIdx];
        const nextCue =
          startIdx + 1 < this.cues.length ? this.cues[startIdx + 1] : null;
        if (time >= prevCue.endTime && time <= prevCue.endTime + 3.0) {
          if (!nextCue || time < nextCue.startTime) {
            return [prevCue];
          }
        }
      }
    }

    // 2. If still empty, fall back to raw ASR fragment to prevent blank screen
    if (active.length === 0 && this.isAsrTrack && this.rawAsrCues.length > 0) {
      const rawFallback = this.findActiveRawAsrCues(time);
      if (rawFallback.length > 0) {
        return rawFallback;
      }
    }

    return active;
  }

  findActiveCue(time: number): CueItem | null {
    const active = this.findActiveCues(time);
    return active.length > 0 ? active[0] : null;
  }

  findCueIndexAtTime(time: number): number {
    for (let i = 0; i < this.cues.length; i++) {
      if (this.cues[i].endTime >= time) {
        return i;
      }
    }
    return Math.max(0, this.cues.length - 1);
  }

  async checkAsrMergePipeline(currentTime: number): Promise<void> {
    if (!this.isAsrTrack || this.isMergingAsr || !this.isContextValid()) return;
    if (!this.rawAsrCues || this.rawAsrCues.length === 0) return;

    // Fast-forward raw merge index if user sought ahead of currently merged cues
    const lastMergedTime =
      this.cues.length > 0 ? this.cues[this.cues.length - 1].endTime : 0;
    if (
      currentTime > lastMergedTime &&
      this.asrMergeIndex < this.rawAsrCues.length
    ) {
      const seekRawIdx = this.rawAsrCues.findIndex(
        (c) => c.startTime >= currentTime - 1,
      );
      if (seekRawIdx >= 0 && seekRawIdx > this.asrMergeIndex) {
        this.logger.info(
          "ASR-Pipeline",
          `Seek jump detected: fast-forwarding ASR merge index ${this.asrMergeIndex} -> ${seekRawIdx} (target time: ${currentTime.toFixed(2)}s)...`,
        );
        this.asrMergeIndex = seekRawIdx;
      }
    }

    if (this.asrMergeIndex >= this.rawAsrCues.length) return;

    // Check if we need more merged cues ahead:
    // Maintain a generous 60s prefetch buffer so playback never outpaces merging
    const TARGET_BUFFER_SEC = 60;
    const remainingBuffer = lastMergedTime - currentTime;
    const needsMore =
      this.cues.length === 0 || remainingBuffer < TARGET_BUFFER_SEC;
    if (!needsMore) return;

    this.isMergingAsr = true;
    const epoch = this.sessionEpoch;
    const batchSize = Math.max(20, this.settings.asrMergeBatchSize || 20);
    const chunk = this.rawAsrCues.slice(
      this.asrMergeIndex,
      this.asrMergeIndex + batchSize,
    );
    this.asrMergeIndex += chunk.length;

    try {
      this.logger.info(
        "ASR-Pipeline",
        `🚀 Dispatching merge batch for ${chunk.length} raw fragments [${chunk[0].id}..${chunk[chunk.length - 1].id}] (${chunk[0].startTime.toFixed(2)}s - ${chunk[chunk.length - 1].endTime.toFixed(2)}s, buffer ahead: ${remainingBuffer.toFixed(2)}s):`,
      );
      chunk.forEach((c) => {
        this.logger.info(
          "ASR-Pipeline",
          `   📋 Raw Fragment #${c.id} [${c.startTime.toFixed(2)}s - ${c.endTime.toFixed(2)}s, dur=${(c.endTime - c.startTime).toFixed(2)}s]: "${c.rawText}"`,
        );
      });

      const res = await this.messageService.mergeAsrBatch({
        items: chunk.map((c) => ({
          id: c.id,
          startTime: c.startTime,
          endTime: c.endTime,
          rawText: c.rawText,
        })),
      });

      if (epoch !== this.sessionEpoch) return;

      if (res && res.success && res.mergedCues && res.mergedCues.length > 0) {
        const newCues: CueItem[] = res.mergedCues.map((c) =>
          createSubtitleCue({
            id: c.id,
            startTime: c.startTime,
            endTime: c.endTime,
            rawText: c.rawText,
          }),
        );

        const existingIds = new Set(this.cues.map((c) => c.id));
        const toAdd = newCues.filter((c) => !existingIds.has(c.id));
        this.cues.push(...toAdd);
        this.cues.sort((a, b) => a.startTime - b.startTime);

        // Resolve overlapping cues and snap small pause gaps <= 3.5s
        for (let i = 0; i < this.cues.length - 1; i++) {
          const curr = this.cues[i];
          const nxt = this.cues[i + 1];
          if (curr.endTime > nxt.startTime && nxt.startTime > curr.startTime) {
            curr.endTime = nxt.startTime;
          }
          const gap = nxt.startTime - curr.endTime;
          if (gap > 0 && gap <= 3.5) {
            curr.endTime = nxt.startTime;
          }
        }

        const newLastMergedTime = this.cues[this.cues.length - 1].endTime;
        const newBufferAhead = newLastMergedTime - currentTime;

        this.logger.info(
          "ASR-Pipeline",
          `✅ ASR merge complete: merged ${chunk.length} raw fragments into ${newCues.length} clean cues (total active cues: ${this.cues.length}). Coverage: 0.0s - ${newLastMergedTime.toFixed(2)}s (buffer ahead: ${newBufferAhead.toFixed(2)}s).`,
        );

        newCues.forEach((nc) => {
          this.logger.info(
            "ASR-Pipeline",
            `   🎯 Merged Cue #${nc.id} [${nc.startTime.toFixed(2)}s - ${nc.endTime.toFixed(2)}s, dur=${(nc.endTime - nc.startTime).toFixed(2)}s]: "${nc.rawText}"`,
          );
        });

        if (this.cues.length > 0 && !this.currentTrackHash) {
          this.loadSubtitlesForCurrentTrack(this.cues, epoch);
        }

        this.onTick();
        const effectiveTime = this.getEffectiveTime();
        this.checkPipeline(effectiveTime);

        // Proactive buffering: If buffer ahead is still below target, trigger next batch merge immediately
        if (
          newBufferAhead < TARGET_BUFFER_SEC &&
          this.asrMergeIndex < this.rawAsrCues.length
        ) {
          setTimeout(() => {
            if (this.sessionEpoch === epoch) {
              this.checkAsrMergePipeline(this.getEffectiveTime());
            }
          }, 50);
        }
      }
    } catch (err) {
      this.logger.error("ASR-Pipeline", "Error in ASR merge pipeline:", err);
    } finally {
      this.isMergingAsr = false;
    }
  }

  checkPipeline(currentTime: number): void {
    if (!this.isContextValid()) {
      this.detachVideo();
      return;
    }

    if (this.isAsrTrack) {
      this.checkAsrMergePipeline(currentTime);
    }

    if (
      Boolean(this.adDetector?.isAdPlaying) ||
      !this.settings.enabled ||
      this.cues.length === 0
    )
      return;

    const currentIdx = this.findCueIndexAtTime(currentTime);
    if (currentIdx < 0 || currentIdx >= this.cues.length) return;

    const config = NCW_CONSTANTS.getPipelineConfig(this.settings);
    const currentCue = this.cues[currentIdx];
    const isCurrentCueTranslated = currentCue
      ? this.isCueTranslated(currentCue.id)
      : true;

    // 1. Seek Burst: current playback cue untranslated -> urgently dispatch burst
    if (!isCurrentCueTranslated && !this.isTranslating) {
      const burstSize = Math.max(config.minTranslateCues || 1, 6);
      this.fetchSeekBurstBatch(currentIdx, burstSize);
      return;
    }

    // 2. Emergency Pre-Review:
    // If supervisor is enabled, and immediate upcoming viewport cues (currentIdx .. currentIdx + 5)
    // are in 'raw' status (not yet reviewed), and canonical review is far behind (> 4 cues behind currentIdx)
    if (
      this.settings.enableSupervisor !== false &&
      !this.isPreReviewing &&
      currentIdx - this.canonicalReviewIndex > 4
    ) {
      const preReviewCues = this.cues
        .slice(currentIdx, Math.min(this.cues.length, currentIdx + 6))
        .filter(
          (c) =>
            this.getCueStatus(c.id) === "raw" && this.translationMap.has(c.id),
        );

      if (preReviewCues.length > 0) {
        this.fetchEmergencyPreReview(preReviewCues, currentIdx);
      }
    }

    // 3. Regular dynamic prefetch refill check
    let translatedAhead = 0;
    for (
      let i = currentIdx + 1;
      i < this.cues.length && i < currentIdx + (config.refillThreshold || 12);
      i++
    ) {
      if (this.isCueTranslated(this.cues[i].id)) {
        translatedAhead++;
      } else {
        break;
      }
    }

    if (
      translatedAhead < (config.refillThreshold || 8) &&
      !this.isTranslating
    ) {
      this.fetchNextTranslationBatch(currentIdx, config);
    }

    // 4. Canonical Supervisor Review check
    if (!this.isReviewing && this.settings.enableSupervisor !== false) {
      if (
        translatedAhead >= 4 ||
        this.video?.paused ||
        currentIdx + translatedAhead >= this.cues.length - 1
      ) {
        this.processSupervisorReviewQueue(config);
      }
    }
  }

  async fetchEmergencyPreReview(
    cuesToPreReview: CueItem[],
    currentIdx: number,
  ): Promise<void> {
    if (this.isPreReviewing || cuesToPreReview.length === 0) return;
    this.isPreReviewing = true;
    const epoch = this.sessionEpoch;

    cuesToPreReview.forEach((c) => this.cueStateMap.set(c.id, "pre_reviewing"));

    try {
      this.logger.info(
        "Subtitle",
        `Emergency Pre-Review: polishing ${cuesToPreReview.length} cues around index ${currentIdx}...`,
      );
      const firstIdx = this.cues.findIndex(
        (c) => c.id === cuesToPreReview[0].id,
      );
      const contextItems = this.getPrecedingContextItems(
        firstIdx >= 0 ? firstIdx : currentIdx,
        3,
      );

      const reviewItems = cuesToPreReview.map((c) =>
        createSubtitleCue({
          ...c,
          transText: this.translationMap.get(c.id)?.text || c.transText || "",
        }),
      );

      const res = await this.messageService.reviewBatch({
        items: reviewItems,
        contextItems,
        trackHash: this.currentTrackHash,
        showId: this.currentShowId || undefined,
        movieId: this.currentMovieId || undefined,
        status: "pre_reviewed",
      });

      if (this.sessionEpoch !== epoch) return;

      if (res && res.success) {
        const corrections = (res.corrections || {}) as Record<
          string | number,
          string
        >;
        const usedTermsMap = res.usedTermsMap || {};

        if (res.updatedContext) {
          this.currentContext = Context.fromDTO(res.updatedContext);
        }

        cuesToPreReview.forEach((c) => {
          const correctedText = corrections[c.id] || corrections[String(c.id)];
          const existing = this.translationMap.get(c.id);
          const finalText =
            correctedText && correctedText.trim().length > 0
              ? correctedText.trim()
              : existing?.text || "";
          const usedTerms = usedTermsMap[c.id] || existing?.usedTerms;

          this.translationMap.set(c.id, {
            text: finalText,
            status: "pre_reviewed",
            usedTerms,
          });
          this.cueStateMap.set(c.id, "pre_reviewed");
        });

        const activeCues = this.video
          ? this.findActiveCues(this.getEffectiveTime())
          : [];
        if (
          activeCues.some((c) => cuesToPreReview.some((pr) => pr.id === c.id))
        ) {
          this._lastCueSig = "";
          this.onTick();
        }
      } else {
        cuesToPreReview.forEach((c) => {
          if (this.cueStateMap.get(c.id) === "pre_reviewing") {
            this.cueStateMap.set(c.id, "raw");
          }
        });
      }
    } catch (err) {
      this.logger.warn("Subtitle", "Emergency Pre-Review error:", err);
      cuesToPreReview.forEach((c) => {
        if (this.cueStateMap.get(c.id) === "pre_reviewing") {
          this.cueStateMap.set(c.id, "raw");
        }
      });
    } finally {
      this.isPreReviewing = false;
    }
  }

  async fetchSeekBurstBatch(
    currentIdx: number,
    burstSize: number,
  ): Promise<void> {
    if (this.isTranslating) return;
    this.isTranslating = true;

    try {
      const endIdx = Math.min(this.cues.length, currentIdx + burstSize);
      const burstCues = this.cues.slice(currentIdx, endIdx);
      const missing = burstCues.filter((c) => c && !this.isCueTranslated(c.id));

      if (missing.length > 0) {
        this.logger.info(
          "Subtitle",
          `Seek Burst (size=${burstSize}): urgently translating ${missing.length} cues around index ${currentIdx}...`,
        );
        missing.forEach((c) => this.cueStateMap.set(c.id, "translating"));
        const firstMissingIdx = this.cues.findIndex(
          (c) => c && c.id === missing[0].id,
        );
        const contextItems = this.getPrecedingContextItems(
          firstMissingIdx >= 0 ? firstMissingIdx : currentIdx,
          3,
        );
        await this.dispatchTranslationSubBatch(missing, contextItems, true);
      }
    } catch (err) {
      this.logger.error("Subtitle", "Error in fetchSeekBurstBatch:", err);
    } finally {
      this.isTranslating = false;
    }
  }

  async fetchNextTranslationBatch(
    currentIdx: number,
    config: PipelineConfig,
  ): Promise<void> {
    if (this.isTranslating) return;
    this.isTranslating = true;

    try {
      const maxCues = Math.max(1, config?.maxTranslateCues || 30);
      const minCues = Math.max(1, config?.minTranslateCues || 1);

      let startGapIdx = -1;
      for (let i = currentIdx + 1; i < this.cues.length; i++) {
        if (!this.isCueTranslated(this.cues[i].id)) {
          startGapIdx = i;
          break;
        }
      }

      if (startGapIdx === -1) {
        for (let i = this.canonicalReviewIndex; i <= currentIdx; i++) {
          if (!this.isCueTranslated(this.cues[i].id)) {
            startGapIdx = i;
            break;
          }
        }
      }

      if (startGapIdx === -1 || startGapIdx >= this.cues.length) return;

      const endIdx = Math.min(this.cues.length, startGapIdx + maxCues);
      const candidateCues = this.cues.slice(startGapIdx, endIdx);
      const missing = candidateCues.filter(
        (c) => c && !this.isCueTranslated(c.id),
      );

      if (missing.length === 0) return;

      const effectiveTime = this.getEffectiveTime();
      const isUrgent = missing[0].startTime - effectiveTime <= 5;

      // Calculate total untranslated cues from startGapIdx to the end of the raw subtitle track
      let totalRemainingUntranslated = 0;
      for (let i = startGapIdx; i < this.cues.length; i++) {
        if (!this.isCueTranslated(this.cues[i].id)) {
          totalRemainingUntranslated++;
          if (totalRemainingUntranslated >= minCues) break;
        }
      }

      const lastMissingCue = missing[missing.length - 1];
      const lastMissingIdx = this.cues.findIndex(
        (c) => c && c.id === lastMissingCue.id,
      );
      const searchBeyondIdx = lastMissingIdx >= 0 ? lastMissingIdx + 1 : endIdx;

      let hasMoreUntranslatedBeyond = false;
      for (let i = searchBeyondIdx; i < this.cues.length; i++) {
        if (!this.isCueTranslated(this.cues[i].id)) {
          hasMoreUntranslatedBeyond = true;
          break;
        }
      }

      // Check whether this batch is at the end of the entire raw subtitles track:
      // 1. If endIdx reaches or exceeds the total raw cues length
      // 2. Or if there are no more untranslated cues anywhere beyond this batch in the entire raw subtitle list
      // 3. Or if the last missing cue is at or near the very end of the raw subtitle list
      // 4. Or if the total remaining untranslated cues across the entire rest of the track is fewer than minCues
      const isEndOfRawCues =
        (!this.isAsrTrack || this.asrMergeIndex >= this.rawAsrCues.length) &&
        (!hasMoreUntranslatedBeyond ||
          endIdx >= this.cues.length ||
          (lastMissingIdx >= 0 && lastMissingIdx >= this.cues.length - 1) ||
          totalRemainingUntranslated < minCues);

      if (missing.length >= minCues || isUrgent || isEndOfRawCues) {
        const payload = missing.slice(0, maxCues);
        this.logger.info(
          "Subtitle",
          `Dynamic Prefetch: translating ${payload.length} cues [index ${startGapIdx}..${startGapIdx + payload.length - 1}]${isEndOfRawCues ? " (end of raw subtitles, min_cues bypassed)" : ""}...`,
        );
        payload.forEach((c) => this.cueStateMap.set(c.id, "translating"));

        const firstMissingIdx = this.cues.findIndex(
          (c) => c && c.id === payload[0].id,
        );
        const contextItems = this.getPrecedingContextItems(
          firstMissingIdx >= 0 ? firstMissingIdx : startGapIdx,
          3,
        );

        await this.dispatchTranslationSubBatch(payload, contextItems);
      }
    } catch (err) {
      this.logger.error("Subtitle", "Error in fetchNextTranslationBatch:", err);
    } finally {
      this.isTranslating = false;
    }
  }

  dispatchTranslationSubBatch(
    batch: CueItem[],
    contextItems: PrecedingContextItem[] = [],
    isUrgent = false,
  ): Promise<void> {
    const epoch = this.sessionEpoch;
    return new Promise<void>((resolve) => {
      if (!this.isContextValid()) {
        this.detachVideo();
        return resolve();
      }

      this.messageService
        .translateBatch({
          items: batch,
          contextItems: contextItems,
          trackHash: this.currentTrackHash,
          movieId: this.currentMovieId || undefined,
          showId: this.currentShowId || undefined,
          urgent: Boolean(isUrgent),
        })
        .then((response) => {
          if (epoch !== this.sessionEpoch) return resolve();

          if (!response || !response.success) {
            this.logger.warn("Subtitle", response?.error || "Empty response");
            batch.forEach((c) => {
              if (this.cueStateMap.get(c.id) === "translating") {
                this.cueStateMap.set(c.id, "untranslated");
              }
            });
            return resolve();
          }

          if (response.results) {
            const resEntries = Object.entries(response.results);
            this.logger.info(
              "Subtitle",
              `Received translation for ${resEntries.length} cues.`,
            );
            for (const [idStr, translatedText] of resEntries) {
              const id = parseInt(idStr, 10);
              if (!this.translationMap.has(id)) {
                this.translationMap.set(id, {
                  text: String(translatedText),
                  status: "raw",
                });
              }
              this.cueStateMap.set(id, "raw");
            }

            batch.forEach((c) => {
              if (this.cueStateMap.get(c.id) === "translating") {
                this.cueStateMap.set(c.id, "untranslated");
              }
            });

            const nowCues = this.video
              ? this.findActiveCues(this.getEffectiveTime())
              : [];
            const hasActiveNewlyTranslated = nowCues.some((c) => {
              const newTrans =
                response.results![c.id] ||
                (response.results as Record<string, string>)[String(c.id)];
              return typeof newTrans === "string" && newTrans.trim().length > 0;
            });

            if (hasActiveNewlyTranslated) {
              this._lastCueSig = "";
              this.onTick();
            }
          }
          resolve();
        })
        .catch((e) => {
          this.logger.error("Subtitle", e);
          batch.forEach((c) => {
            if (this.cueStateMap.get(c.id) === "translating") {
              this.cueStateMap.set(c.id, "untranslated");
            }
          });
          resolve();
        });
    });
  }

  processSupervisorReviewQueue(pipelineConfig?: PipelineConfig): void {
    if (
      this.isReviewing ||
      !this.settings.enabled ||
      this.settings.enableSupervisor === false
    )
      return;
    if (!this.isContextValid()) {
      this.detachVideo();
      return;
    }

    const config =
      pipelineConfig || NCW_CONSTANTS.getPipelineConfig(this.settings);
    const epoch = this.sessionEpoch;
    const reviewBatchSize = Math.max(1, config.reviewBatchSize || 8);
    const toReview: {
      id: number;
      orig: string;
      trans: string;
      cueIndex: number;
      start: number;
      end: number;
    }[] = [];

    for (
      let i = this.canonicalReviewIndex;
      i < this.cues.length && toReview.length < reviewBatchSize;
      i++
    ) {
      const cue = this.cues[i];
      const state = this.getCueStatus(cue.id);
      const entry = this.translationMap.get(cue.id);

      if (state === "reviewed") {
        this.canonicalReviewIndex = i + 1;
        continue;
      }

      if (state === "raw" || state === "pre_reviewed") {
        if (entry && entry.text) {
          toReview.push({
            id: cue.id,
            orig: cue.rawText,
            trans: entry.text,
            cueIndex: i,
            start: cue.startTime,
            end: cue.endTime,
          });
        } else {
          break;
        }
      } else if (
        state === "untranslated" ||
        state === "stale" ||
        state === "translating"
      ) {
        break;
      }
    }

    if (toReview.length === 0) return;

    this.isReviewing = true;
    toReview.forEach((r) => this.cueStateMap.set(r.id, "reviewing"));

    const firstReviewIdx =
      toReview[0]?.cueIndex !== undefined
        ? toReview[0].cueIndex
        : this.canonicalReviewIndex;
    const contextItems = this.getPrecedingContextItems(firstReviewIdx, 3);

    this.messageService
      .reviewBatch({
        items: toReview.map((r) =>
          createSubtitleCue({
            id: r.id,
            rawText: r.orig,
            transText: r.trans,
            startTime: r.start,
            endTime: r.end,
            status: "reviewing",
          }),
        ),
        contextItems: contextItems,
        trackHash: this.currentTrackHash,
        movieId: this.currentMovieId || undefined,
        showId: this.currentShowId || undefined,
        status: "reviewed",
      })
      .then((res) => {
        this.isReviewing = false;
        if (epoch !== this.sessionEpoch) return;

        if (res && res.success) {
          const corrections = (res.corrections || {}) as Record<
            string | number,
            string
          >;
          const usedTermsMap = res.usedTermsMap || {};

          if (res.updatedContext) {
            this.currentContext = Context.fromDTO(res.updatedContext);
          }

          toReview.forEach((r) => {
            const correctedText =
              corrections[r.id] || corrections[String(r.id)];
            const finalText =
              correctedText && correctedText.trim().length > 0
                ? correctedText.trim()
                : r.trans;
            const usedTerms =
              usedTermsMap[r.id] || this.translationMap.get(r.id)?.usedTerms;

            this.translationMap.set(r.id, {
              text: finalText,
              status: "reviewed",
              usedTerms,
            });
            this.cueStateMap.set(r.id, "reviewed");
            this.canonicalReviewIndex = Math.max(
              this.canonicalReviewIndex,
              r.cueIndex + 1,
            );
          });

          const activeCues = this.video
            ? this.findActiveCues(this.getEffectiveTime())
            : [];
          const hasRealChange = activeCues.some((c) => {
            const corr = corrections[c.id] || corrections[String(c.id)];
            const existing = this.translationMap.get(c.id)?.text;
            return corr && corr.trim() !== (existing || "").trim();
          });
          if (hasRealChange) {
            this._lastCueSig = "";
            this.onTick();
          }

          this.processSupervisorReviewQueue(config);
        } else {
          toReview.forEach((r) => {
            if (this.cueStateMap.get(r.id) === "reviewing") {
              const entry = this.translationMap.get(r.id);
              this.cueStateMap.set(r.id, entry?.status || "raw");
            }
          });
        }
      })
      .catch(() => {
        this.isReviewing = false;
        toReview.forEach((r) => {
          if (this.cueStateMap.get(r.id) === "reviewing") {
            const entry = this.translationMap.get(r.id);
            this.cueStateMap.set(r.id, entry?.status || "raw");
          }
        });
      });
  }

  updateSettings(newSettings: Partial<ExtensionSettings>): void {
    const wasEnabled = this.settings.enabled !== false;
    const oldTargetLanguage = this.settings.targetLanguage;
    const oldAiProvider = this.settings.aiProvider;
    this.settings = { ...this.settings, ...newSettings };
    this.overlay.updateSettings(this.settings);
    if (this.learningManager) {
      this.learningManager.updateSettings(this.settings as any);
    }

    if (newSettings.subSyncOffset !== undefined) {
      this.settings.subSyncOffset = newSettings.subSyncOffset;
      this.manualOffset = newSettings.subSyncOffset;
      if (this.video && this.cues && this.cues.length > 0) {
        this.onTick();
      }
    }
    if (newSettings.enableDomSubtitleSync !== undefined) {
      this.settings.enableDomSubtitleSync = Boolean(
        newSettings.enableDomSubtitleSync,
      );
      if (!this.settings.enableDomSubtitleSync) {
        this.domOffset = 0;
      }
    }

    const oldPreferNative = this.settings.preferNativeSubtitles !== false;
    const oldLangCode = Language.resolve(oldTargetLanguage).code;
    const newLangCode = newSettings.targetLanguage
      ? Language.resolve(newSettings.targetLanguage).code
      : oldLangCode;
    const langChanged = Boolean(
      oldLangCode && newLangCode && oldLangCode !== newLangCode,
    );

    const providerChanged = Boolean(
      newSettings.aiProvider &&
      oldAiProvider &&
      newSettings.aiProvider !== oldAiProvider,
    );

    const preferNativeChanged = Boolean(
      newSettings.preferNativeSubtitles !== undefined &&
      (newSettings.preferNativeSubtitles !== false) !== oldPreferNative,
    );

    if (this.settings.enabled === false) {
      this.overlay.hide(true);
      this.activeCueId = null;
      this.isTranslating = false;
      this.isReviewing = false;
      this.isPreReviewing = false;
    } else if (providerChanged || langChanged || preferNativeChanged) {
      this.logger.info(
        "Subtitle",
        `Translation settings switched (provider: "${oldAiProvider}" -> "${newSettings.aiProvider}", targetLang: "${oldLangCode}" -> "${newLangCode}", preferNative: ${oldPreferNative} -> ${this.settings.preferNativeSubtitles !== false}). Resetting translation pipeline.`,
      );
      if (this.isContextValid()) {
        this.messageService.clearQueues().catch(() => {});
      }

      const epoch = Date.now();
      this.sessionEpoch = epoch;
      this.translationMap.clear();
      this.cueStateMap.clear();
      this.canonicalReviewIndex = 0;
      this.overlay.hide(true);
      this.activeCueId = null;
      this.isTranslating = false;
      this.isReviewing = false;
      this.isPreReviewing = false;

      if (this.cues && this.cues.length > 0) {
        this.warmupShowContext(true);
        this.loadSubtitlesForCurrentTrack(
          this.cues,
          epoch,
          this.currentTrackHash,
        );
      }
    } else if (!wasEnabled && this.settings.enabled) {
      this.logger.info("Subtitle", "Subtitle translation enabled.");
      this.warmupShowContext();

      if (!this.video || !document.body.contains(this.video)) {
        const v = document.querySelector("video");
        if (v) this.attachVideo(v);
      }
      this.overlay.mountToPlayer(this.adapter?.getPlayerContainer?.());

      if (this.cues && this.cues.length > 0) {
        this.logger.info(
          "Subtitle",
          `Resuming with ${this.cues.length} cues loaded.`,
        );
        if (this.video) {
          const epoch = Date.now();
          this.sessionEpoch = epoch;
          this.loadSubtitlesForCurrentTrack(
            this.cues,
            epoch,
            this.currentTrackHash,
          );
          if (!this.video.paused) {
            this.startRafLoop();
          }
        }
      } else {
        this.logger.info(
          "Subtitle",
          "Subtitle translation enabled but 0 cues loaded. Requesting subtitle track...",
        );
        if (this.adapter) {
          this.adapter.requestSubtitleRetry();
        }
      }
    }
  }
}

export default SubtitleManager;
