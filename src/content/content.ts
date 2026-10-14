/**
 * CoWatcher - Content Script Entry
 * Bridges DOM, streaming adapters, ad detector, subtitle synchronization manager, and message services.
 */

import { NCW_CONSTANTS, ExtensionSettings } from '@shared/utils/constants';
import NCW_I18N from '@shared/utils/i18n';
import { SubtitleOverlay } from './presentation/SubtitleOverlay';
import { SubtitleManager, CueItem } from './application/subtitleManager';
import { createSubtitleCue } from '@shared/domain/entities/Subtitle';
import { NetflixAdDetector as AdDetector } from './infrastructure/adapters/netflix/NetflixAdDetector';
import { StreamingAdapterRegistry } from './domain/adapters/StreamingAdapterRegistry';
import { NetflixContentAdapter } from './infrastructure/adapters/netflix/NetflixContentAdapter';
import { TVerContentAdapter } from './infrastructure/adapters/tver/TVerContentAdapter';
import { ContentMessageService } from './application/services/ContentMessageService';
import { SubtitleParser } from './application/utils/parser';
import { BrowserStorageFactory } from '@shared/infrastructure/storage/BrowserStorageFactory';
import { BrowserPlatformFactory } from '@shared/infrastructure/platform/BrowserPlatformFactory';
import { NCW_STORAGE_KEYS } from '@shared/domain/constants/StorageKeys';
import { Logger } from '@shared/utils/logger';
import { Language, LanguageInfo } from '@shared/domain/value-objects/Language';
import { AiSubState } from '@shared/domain/entities/AiSubState';

const logger: Logger = new Logger('content');

(function () {
  'use strict';

  logger.info('Content', 'Content script initialized.');

  // Register platform content adapters
  StreamingAdapterRegistry.register(new NetflixContentAdapter());
  StreamingAdapterRegistry.register(new TVerContentAdapter());

  const adapter = StreamingAdapterRegistry.getMatchingAdapter() || new NetflixContentAdapter();
  const messageService = ContentMessageService.getInstance();
  const storage = BrowserStorageFactory.getStorage();
  const platform = BrowserPlatformFactory.getPlatform();

  let settings: ExtensionSettings = { ...NCW_CONSTANTS.DEFAULT_SETTINGS };
  const overlay = new SubtitleOverlay();

  const adDetectorOptions = {
    onAdStart: () => {
      overlay.hide(true);
    },
    onAdEnd: () => {
      if (subtitleManager) {
        setTimeout(() => subtitleManager.onSeeked(), 300);
      }
    },
  };

  const adDetector = adapter.createAdDetector
    ? adapter.createAdDetector(adDetectorOptions)
    : new AdDetector(adDetectorOptions);

  const subtitleManager = new SubtitleManager(overlay, adDetector, settings, adapter);

  let currentVideoId: string | null = adapter.getVideoInfo()?.videoId || null;
  let currentUrl = window.location.href;
  let retryCount = 0;
  const pendingSubtitlesByMovieId = new Map<
    string,
    { rawText: string; bcp47: string | null } | string
  >();
  let stagedNextEpisodeSubtitle: {
    rawText: string;
    cues: CueItem[];
    bcp47: string | null;
    timestamp: number;
  } | null = null;
  let currentSubtitleLanguage = 'auto';
  let lastParsedCues: CueItem[] | null = null;

  function isExtensionValid(): boolean {
    return platform.isContextValid();
  }

  function sendHeartbeat(): void {
    if (!isExtensionValid()) return;
    const showId =
      subtitleManager?.currentShowId ||
      (typeof document !== 'undefined' ? document.documentElement?.dataset?.ncwShowId : null) ||
      null;
    const videoId = currentVideoId || adapter.getVideoInfo()?.videoId || null;
    messageService
      .sendHeartbeat({
        showId,
        videoId,
        targetLanguage: settings.targetLanguage,
      })
      .catch(() => {});
  }

  function notifyVocabExtractor(
    cuesToFeed: CueItem[],
    movieIdToFeed?: string | null,
    sourceLangToFeed?: string
  ): void {
    if (!isExtensionValid()) return;
    if (!settings.vocabExtractorEnabled) return;
    if (!cuesToFeed || cuesToFeed.length === 0) return;
    const configuredSrcLang =
      settings.vocabSourceLanguage && settings.vocabSourceLanguage !== 'auto'
        ? settings.vocabSourceLanguage
        : null;
    const rawLang = configuredSrcLang || sourceLangToFeed || currentSubtitleLanguage || 'auto';
    const effectiveMovieId = movieIdToFeed || currentVideoId || '';

    const effectiveLang: LanguageInfo | 'auto' =
      rawLang === 'auto' ? 'auto' : Language.resolve(rawLang);

    messageService
      .feedVocabCues({
        movieId: effectiveMovieId,
        cues: cuesToFeed,
        sourceLanguage: effectiveLang,
        trackHash: subtitleManager?.currentTrackHash || '',
        showTitle: document.title || '',
      })
      .catch(() => {});
  }

  function handleEpisodeChange(info: { movieId: string; url?: string }): void {
    const newVideoId = String(info.movieId || '');
    if (!newVideoId || newVideoId === currentVideoId) {
      return;
    }

    logger.info(
      'Content',
      `🔄 Transitioning to episode: ${currentVideoId || 'initial'} -> ${newVideoId}`
    );
    currentVideoId = newVideoId;
    currentUrl = info.url || window.location.href;
    retryCount = 0;
    lastParsedCues = null;

    // Reset subtitle manager, ad detector, and overlay for the new episode
    subtitleManager.onEpisodeChange(currentVideoId);
    adDetector.reset();
    overlay.hide(true);
    sendHeartbeat();

    // Re-scan and re-mount to fresh player DOM
    scanAndAttachVideo();
    overlay.mountToPlayer();
    applyNativeSubtitleVisibility();

    // 1. Check if we have a staged preloaded subtitle by movie ID
    if (pendingSubtitlesByMovieId.has(currentVideoId)) {
      const item = pendingSubtitlesByMovieId.get(currentVideoId);
      pendingSubtitlesByMovieId.delete(currentVideoId);
      try {
        const stagedRawText = typeof item === 'string' ? item : item?.rawText;
        const stagedBcp = typeof item === 'object' ? item?.bcp47 : null;
        if (stagedRawText) {
          const rawCues = SubtitleParser.parse(stagedRawText);
          if (rawCues && rawCues.length > 0) {
            const cues = rawCues.map((c) =>
              createSubtitleCue({
                id: c.id,
                startTime: c.start,
                endTime: c.end,
                rawText: c.text,
                position: c.position,
              })
            );
            lastParsedCues = cues;
            currentSubtitleLanguage =
              stagedBcp || SubtitleParser.detectLanguage(stagedRawText, rawCues);
            logger.info(
              'Content',
              `⚡ Instantly activated staged preloaded subtitle for ${currentVideoId} (${cues.length} cues, lang: ${currentSubtitleLanguage}).`
            );
            subtitleManager.loadCues(cues, currentVideoId);
            notifyVocabExtractor(cues, currentVideoId, currentSubtitleLanguage);
            return;
          }
        }
      } catch (e) {
        logger.warn('Content', 'Failed parsing staged subtitle by movieId:', e);
      }
    }

    // 2. Fallback: check if we have a staged unknown preloaded subtitle captured recently (< 5 mins)
    if (stagedNextEpisodeSubtitle && Date.now() - stagedNextEpisodeSubtitle.timestamp < 300000) {
      const staged = stagedNextEpisodeSubtitle;
      stagedNextEpisodeSubtitle = null;
      try {
        const cues = staged.cues;
        if (cues && cues.length > 0) {
          lastParsedCues = cues;
          currentSubtitleLanguage =
            staged.bcp47 || SubtitleParser.detectLanguage(staged.rawText, cues);
          logger.info(
            'Content',
            `⚡ Instantly activated staged unknown preloaded subtitle for ${currentVideoId} (${cues.length} cues, lang: ${currentSubtitleLanguage}).`
          );
          subtitleManager.loadCues(cues, currentVideoId);
          notifyVocabExtractor(cues, currentVideoId, currentSubtitleLanguage);
          return;
        }
      } catch (e) {
        logger.warn('Content', 'Failed parsing staged unknown subtitle:', e);
      }
    }

    logger.info(
      'Content',
      `No staged preloaded subtitle found for ${currentVideoId}. Requesting from Player API...`
    );
    setTimeout(() => {
      adapter.requestSubtitleRetry();
    }, 400);
  }

  function handleUrlChange(newUrl: string): void {
    if (!newUrl || newUrl === currentUrl) return;
    currentUrl = newUrl;
    logger.info('Content', `Page route changed: ${newUrl}`);

    const newVid = adapter.getVideoInfo()?.videoId || null;
    if (!newVid) {
      currentVideoId = null;
      subtitleManager.clearCues();
      overlay.hide(true);
      sendHeartbeat();
    } else if (newVid !== currentVideoId) {
      handleEpisodeChange({ movieId: newVid, url: newUrl });
    }

    // Re-check player DOM and controls for the new page route
    scheduleScanAndAttachVideo();
    injectPlayerControlButton();
  }

  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function showToast(message: string): void {
    let toast = document.getElementById('ncw-toast');
    const playerTarget = adapter.getPlayerContainer() || document.body;

    if (!playerTarget) return;

    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'ncw-toast';
      toast.className = 'ncw-toast';
      playerTarget.appendChild(toast);
    } else if (toast.parentElement !== playerTarget) {
      playerTarget.appendChild(toast);
    }

    toast.textContent = message;
    toast.classList.add('ncw-toast-show');
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
      toast?.classList.remove('ncw-toast-show');
    }, 1800);
  }

  function toggleEnabledState(showNotification = true): void {
    if (!isExtensionValid()) {
      showToast(
        settings.uiLanguage === 'zh'
          ? '⚠️ 插件已在后台更新，请刷新网页 (F5)！'
          : '⚠️ Extension updated. Please refresh page (F5)!'
      );
      return;
    }

    const nextState = !settings.enabled;
    settings.enabled = nextState;
    if (adapter && adapter.platformName) {
      if (!settings.platformEnabled) settings.platformEnabled = {};
      settings.platformEnabled[adapter.platformName] = nextState;
    }
    logger.info(
      'Content',
      `Subtitle translation toggled for ${adapter.platformName}: ${nextState ? 'ON' : 'OFF'}`
    );

    // Update authoritative state in Background via ContentMessageService
    messageService.setAiSubEnabled(nextState, adapter.platformName).catch((err) => {
      logger.warn('Content', 'Failed to set AI Sub state in background:', err);
    });

    // Persist via storage
    storage
      .get<ExtensionSettings>([NCW_STORAGE_KEYS.SETTINGS])
      .then((res) => {
        if (!isExtensionValid()) return;
        const currentStored = res[NCW_STORAGE_KEYS.SETTINGS] || settings;
        const updatedPlatformEnabled = {
          ...(currentStored.platformEnabled || {}),
          [adapter.platformName]: nextState,
        };
        const updated = {
          ...currentStored,
          enabled: nextState,
          platformEnabled: updatedPlatformEnabled,
        };
        storage.set({ [NCW_STORAGE_KEYS.SETTINGS]: updated });
      })
      .catch((e) => {
        logger.warn('Content', 'Storage access failed:', e);
      });

    if (nextState) {
      scanAndAttachVideo();
      overlay.mountToPlayer();
      if (
        (!subtitleManager.cues || subtitleManager.cues.length === 0) &&
        lastParsedCues &&
        lastParsedCues.length > 0
      ) {
        logger.info(
          'Content',
          'Restoring subtitle cues from content script cache upon enabling translation.'
        );
        subtitleManager.loadCues(lastParsedCues);
      }
    }

    subtitleManager.updateSettings({ enabled: nextState });
    updatePlayerControlButtonState();
    applyNativeSubtitleVisibility();

    if (showNotification) {
      const msg = nextState
        ? NCW_I18N.getText('toastEnabled', settings.uiLanguage)
        : NCW_I18N.getText('toastDisabled', settings.uiLanguage);
      showToast(msg);
    }
  }

  function applyNativeSubtitleVisibility(): void {
    const shouldHide = settings.enabled !== false && settings.hideNativeSubtitles !== false;
    if (shouldHide) {
      document.body.classList.add('ncw-hide-native-subs');
    } else {
      document.body.classList.remove('ncw-hide-native-subs');
    }
  }

  let isBtnHovered = false;
  let btnFadeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastUserActivityTime = 0;
  const BTN_FADE_TIMEOUT_MS = 2500;

  function showPlayerControlButton(): void {
    const btn = document.getElementById('ncw-player-toggle-btn');
    if (!btn) return;

    if (btn.classList.contains('ncw-faded')) {
      btn.classList.remove('ncw-faded');
    }

    scheduleButtonFade();
  }

  function scheduleButtonFade(): void {
    if (btnFadeTimer) {
      clearTimeout(btnFadeTimer);
      btnFadeTimer = null;
    }

    if (isBtnHovered) return;
    if (!window.location.href.includes('/watch/')) return;

    btnFadeTimer = setTimeout(() => {
      btnFadeTimer = null;
      if (isBtnHovered) return;
      const btn = document.getElementById('ncw-player-toggle-btn');
      if (btn && !btn.classList.contains('ncw-faded')) {
        btn.classList.add('ncw-faded');
      }
    }, BTN_FADE_TIMEOUT_MS);
  }

  function onPlayerUserActivity(): void {
    if (!window.location.href.includes('/watch/')) return;
    const now = Date.now();
    if (now - lastUserActivityTime < 100) return;
    lastUserActivityTime = now;
    showPlayerControlButton();
  }

  window.addEventListener('mousemove', onPlayerUserActivity, { capture: true, passive: true });
  window.addEventListener('pointermove', onPlayerUserActivity, { capture: true, passive: true });
  window.addEventListener('keydown', onPlayerUserActivity, { capture: true, passive: true });
  window.addEventListener('touchstart', onPlayerUserActivity, { capture: true, passive: true });
  document.addEventListener(
    'mouseleave',
    () => {
      isBtnHovered = false;
      scheduleButtonFade();
    },
    { capture: true, passive: true }
  );

  function injectPlayerControlButton(): void {
    if (!window.location.href.includes('/watch/')) {
      const existing = document.getElementById('ncw-player-toggle-btn');
      if (existing) existing.remove();
      if (btnFadeTimer) {
        clearTimeout(btnFadeTimer);
        btnFadeTimer = null;
      }
      return;
    }

    const playerTarget = adapter.getPlayerContainer() || document.body;
    if (!playerTarget) return;

    let btn = document.getElementById('ncw-player-toggle-btn');
    if (!btn) {
      btn = document.createElement('div');
      btn.id = 'ncw-player-toggle-btn';
      btn.className = 'ncw-player-toggle-btn';
      btn.setAttribute('role', 'button');
      btn.setAttribute('tabindex', '0');
      btn.setAttribute('title', NCW_I18N.getText('btnPlayerTitle', settings.uiLanguage));

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleEnabledState();
        showPlayerControlButton();
      });

      btn.addEventListener('mouseenter', () => {
        isBtnHovered = true;
        if (btnFadeTimer) {
          clearTimeout(btnFadeTimer);
          btnFadeTimer = null;
        }
        btn?.classList.remove('ncw-faded');
      });

      btn.addEventListener('mouseleave', () => {
        isBtnHovered = false;
        scheduleButtonFade();
      });

      playerTarget.appendChild(btn);
      updatePlayerControlButtonState();
      scheduleButtonFade();
    } else if (btn.parentElement !== playerTarget) {
      playerTarget.appendChild(btn);
    }
  }

  function updatePlayerControlButtonState(): void {
    const btn = document.getElementById('ncw-player-toggle-btn');
    if (!btn) return;

    const isEnabled = settings.enabled !== false;
    const currentState = btn.getAttribute('data-enabled');
    const currentLang = btn.getAttribute('data-lang');
    const newState = isEnabled ? 'true' : 'false';

    btn.setAttribute('title', NCW_I18N.getText('btnPlayerTitle', settings.uiLanguage));

    if (currentState === newState && currentLang === settings.uiLanguage) return;
    btn.setAttribute('data-enabled', newState);
    btn.setAttribute('data-lang', settings.uiLanguage || 'en');

    const onText = NCW_I18N.getText('btnPlayerOn', settings.uiLanguage);
    const offText = NCW_I18N.getText('btnPlayerOff', settings.uiLanguage);

    if (isEnabled) {
      btn.innerHTML = `<span class="ncw-badge-icon">AI</span><span class="ncw-btn-text">${onText}</span>`;
      btn.classList.add('ncw-active');
      btn.classList.remove('ncw-inactive');
    } else {
      btn.innerHTML = `<span class="ncw-badge-icon">AI</span><span class="ncw-btn-text">${offText}</span>`;
      btn.classList.add('ncw-inactive');
      btn.classList.remove('ncw-active');
    }

    showPlayerControlButton();
  }

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    const activeEl = document.activeElement;
    if (
      activeEl &&
      (activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        (activeEl as HTMLElement).isContentEditable)
    ) {
      return;
    }

    if (e.altKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      toggleEnabledState();
    } else if (
      (e.key === '[' || (e.altKey && e.code === 'BracketLeft')) &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      e.preventDefault();
      adjustSubtitleOffset(0.5);
    } else if (
      (e.key === ']' || (e.altKey && e.code === 'BracketRight')) &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      e.preventDefault();
      adjustSubtitleOffset(-0.5);
    } else if (
      (e.key === '\\' || (e.altKey && e.code === 'Backslash')) &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      e.preventDefault();
      resetSubtitleOffset();
    }
  });

  function adjustSubtitleOffset(delta: number): void {
    if (!isExtensionValid()) {
      showToast(
        settings.uiLanguage === 'zh'
          ? '⚠️ 插件已在后台更新，请刷新网页 (F5)！'
          : '⚠️ Extension updated. Please refresh page (F5)!'
      );
      return;
    }
    const current = typeof settings.subSyncOffset === 'number' ? settings.subSyncOffset : 0;
    const updated = Math.round((current + delta) * 10) / 10;
    settings.subSyncOffset = updated;
    subtitleManager.updateSettings({ subSyncOffset: updated });
    storage
      .get<ExtensionSettings>([NCW_STORAGE_KEYS.SETTINGS])
      .then((res) => {
        if (!isExtensionValid()) return;
        const s = { ...(res[NCW_STORAGE_KEYS.SETTINGS] || settings), subSyncOffset: updated };
        storage.set({ [NCW_STORAGE_KEYS.SETTINGS]: s });
      })
      .catch((e) => {
        logger.warn('Content', 'Storage sync failed:', e);
      });

    const sign = updated > 0 ? '+' : '';
    const msg = NCW_I18N.getText('toastSyncOffset', settings.uiLanguage, {
      offset: `${sign}${updated.toFixed(1)}`,
    });
    showToast(msg);
  }

  function resetSubtitleOffset(): void {
    if (!isExtensionValid()) {
      showToast(
        settings.uiLanguage === 'zh'
          ? '⚠️ 插件已在后台更新，请刷新网页 (F5)！'
          : '⚠️ Extension updated. Please refresh page (F5)!'
      );
      return;
    }
    settings.subSyncOffset = 0;
    subtitleManager.updateSettings({ subSyncOffset: 0 });
    storage
      .get<ExtensionSettings>([NCW_STORAGE_KEYS.SETTINGS])
      .then((res) => {
        if (!isExtensionValid()) return;
        const s = { ...(res[NCW_STORAGE_KEYS.SETTINGS] || settings), subSyncOffset: 0 };
        storage.set({ [NCW_STORAGE_KEYS.SETTINGS]: s });
      })
      .catch((e) => {
        logger.warn('Content', 'Storage reset failed:', e);
      });

    const msg = NCW_I18N.getText('toastSyncOffset', settings.uiLanguage, { offset: '0.0' });
    showToast(msg);
  }

  // 1. Initial State Sync: Fetch authoritative state from Background service
  messageService
    .fetchAiSubState()
    .then((state: AiSubState | null) => {
      if (state) {
        const isPlatformOn =
          typeof state.isPlatformEnabled === 'function'
            ? state.isPlatformEnabled(adapter.platformName)
            : ((state.platformEnabled as Record<string, boolean> | undefined)?.[
                adapter.platformName
              ] ??
              state.enabled ??
              true);
        settings.enabled = isPlatformOn;
        subtitleManager.updateSettings({ enabled: isPlatformOn });
        updatePlayerControlButtonState();
        applyNativeSubtitleVisibility();
      }
    })
    .catch((err) => {
      logger.warn('Content', 'Could not fetch initial AiSubState:', err);
    });

  // 2. Push Listener: Listen to AI Sub state push events from Background service
  messageService.onAiSubStateChanged((state) => {
    if (state) {
      const isPlatformOn =
        typeof state.isPlatformEnabled === 'function'
          ? state.isPlatformEnabled(adapter.platformName)
          : ((state.platformEnabled as Record<string, boolean> | undefined)?.[
              adapter.platformName
            ] ??
            state.enabled ??
            true);
      if (settings.enabled !== isPlatformOn) {
        logger.info(
          'Content',
          `Received AiSubState push for ${adapter.platformName}: enabled=${isPlatformOn}`
        );
        settings.enabled = isPlatformOn;
        subtitleManager.updateSettings({ enabled: isPlatformOn });
        updatePlayerControlButtonState();
        applyNativeSubtitleVisibility();
      }
    }
  });

  // 3. Load initial settings from storage
  if (isExtensionValid()) {
    storage
      .get<ExtensionSettings>([NCW_STORAGE_KEYS.SETTINGS])
      .then((res) => {
        if (!isExtensionValid()) return;
        if (res && res[NCW_STORAGE_KEYS.SETTINGS]) {
          settings = { ...settings, ...res[NCW_STORAGE_KEYS.SETTINGS] };
          if (
            settings.platformEnabled &&
            typeof settings.platformEnabled[adapter.platformName] === 'boolean'
          ) {
            settings.enabled = settings.platformEnabled[adapter.platformName]!;
          }
          overlay.init(settings);
          subtitleManager.updateSettings(settings);
        } else {
          overlay.init(settings);
        }
        updatePlayerControlButtonState();
        applyNativeSubtitleVisibility();
      })
      .catch(() => {
        overlay.init(settings);
        updatePlayerControlButtonState();
      });
  } else {
    overlay.init(settings);
    updatePlayerControlButtonState();
  }

  // 4. Listen to settings changes from popup/options via ContentMessageService
  if (isExtensionValid()) {
    messageService.onSettingsChanged((newSettings) => {
      if (!isExtensionValid()) return;
      const oldVocabEnabled = settings.vocabExtractorEnabled;
      settings = { ...settings, ...newSettings };
      subtitleManager.updateSettings(settings);
      updatePlayerControlButtonState();
      applyNativeSubtitleVisibility();

      if (!oldVocabEnabled && settings.vocabExtractorEnabled && lastParsedCues) {
        notifyVocabExtractor(lastParsedCues, currentVideoId, currentSubtitleLanguage);
      }
      sendHeartbeat();
    });

    storage.onChanged((changes) => {
      if (!isExtensionValid()) return;
      if (changes[NCW_STORAGE_KEYS.SETTINGS]?.newValue) {
        const newSettings = changes[NCW_STORAGE_KEYS.SETTINGS].newValue as ExtensionSettings;
        settings = { ...settings, ...newSettings };
        if (
          settings.platformEnabled &&
          typeof settings.platformEnabled[adapter.platformName] === 'boolean'
        ) {
          settings.enabled = settings.platformEnabled[adapter.platformName]!;
        }
        subtitleManager.updateSettings(settings);
        updatePlayerControlButtonState();
        applyNativeSubtitleVisibility();
        sendHeartbeat();
      }
    });
  }

  // 5. Connect streaming adapter hooks
  adapter.onEpisodeChange((newEpisodeId) => {
    handleEpisodeChange({ movieId: newEpisodeId });
  });

  adapter.onSubtitleData((data) => {
    const cues: CueItem[] = data.cues.map((c) =>
      createSubtitleCue({
        id: c.id,
        startTime: c.start,
        endTime: c.end,
        rawText: c.text,
        position: c.position,
      })
    );
    if (cues.length > 0) {
      lastParsedCues = cues;
      currentSubtitleLanguage = data.language;
      const effectiveMid = data.movieId || currentVideoId;
      if (data.movieId && !currentVideoId) {
        currentVideoId = data.movieId;
      }
      subtitleManager.loadCues(cues, effectiveMid);
      notifyVocabExtractor(cues, effectiveMid, currentSubtitleLanguage);
    }
  });

  if (typeof adapter.onSubtitleOff === 'function') {
    adapter.onSubtitleOff(() => {
      logger.info('Content', 'Subtitle OFF event received from platform adapter.');
      lastParsedCues = null;
      subtitleManager.clearCues();
    });
  }

  // 6. Connect adapter platform-specific hooks
  if (typeof adapter.onMetadataLoaded === 'function') {
    adapter.onMetadataLoaded((meta) => {
      if (!isExtensionValid()) return;
      logger.info(
        'Content',
        `Metadata loaded event received for: ${meta.mainTitle} (showId=${meta.showId || 'N/A'}, ep=${meta.episodeTitle})`
      );
      if (meta.videoId && !currentVideoId) {
        currentVideoId = meta.videoId;
      }
      if (subtitleManager) {
        subtitleManager.onMetadataLoaded(meta);
      }
      sendHeartbeat();
    });
  }

  adapter.onUrlChange((url) => {
    if (!isExtensionValid()) return;
    handleUrlChange(url);
  });

  adapter.onTimeSync(({ cadmiumOffset, adOffset }) => {
    if (!isExtensionValid()) return;
    if (typeof cadmiumOffset === 'number') {
      subtitleManager.setCadmiumOffset(cadmiumOffset);
    } else if (typeof adOffset === 'number') {
      subtitleManager.setCadmiumOffset(-adOffset);
    }
  });

  adapter.onSubtitlePreload(({ movieId, rawText, bcp47, timestamp }) => {
    if (!isExtensionValid()) return;
    if (movieId) {
      pendingSubtitlesByMovieId.set(String(movieId), { rawText, bcp47: bcp47 || null });
      logger.info(
        'Content',
        `📦 Staged preloaded subtitle in content script for episode ${movieId}`
      );
    } else {
      try {
        const rawCues = SubtitleParser.parse(rawText);
        const cues = rawCues
          ? rawCues.map((c) =>
              createSubtitleCue({
                id: c.id,
                startTime: c.start,
                endTime: c.end,
                rawText: c.text,
                position: c.position,
              })
            )
          : [];
        stagedNextEpisodeSubtitle = {
          rawText,
          cues,
          bcp47: bcp47 || null,
          timestamp: timestamp || Date.now(),
        };
        logger.info(
          'Content',
          `📦 Staged unknown preloaded subtitle in content script (${cues?.length || 0} cues)`
        );
      } catch (e) {
        logger.warn('Content', 'Failed to parse staged subtitle:', e);
      }
    }
  });

  // 7. Start ad detector
  adDetector.startMonitoring();

  // 8. Watch for video element appearance / changes
  let intervalId: ReturnType<typeof setInterval> | null = null;

  function scanAndAttachVideo(): void {
    if (!isExtensionValid()) {
      if (bodyObserver) bodyObserver.disconnect();
      if (intervalId) clearInterval(intervalId);
      adDetector.stopMonitoring();
      return;
    }

    if (window.location.href !== currentUrl) {
      handleUrlChange(window.location.href);
    }

    const video = adapter.getVideoElement();
    if (video) {
      subtitleManager.attachVideo(video);
      overlay.mountToPlayer();
      injectPlayerControlButton();

      if (
        currentVideoId &&
        subtitleManager.cues.length === 0 &&
        !video.paused &&
        video.currentTime > 1
      ) {
        retryCount++;
        if (retryCount <= 10 && retryCount % 2 === 0) {
          logger.info(
            'Content',
            'Subtitle cues not yet caught during playback. Triggering adapter retry...'
          );
          adapter.requestSubtitleRetry();
        }
      }
    }
  }

  let scanDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleScanAndAttachVideo(): void {
    if (scanDebounceTimer) return;
    scanDebounceTimer = setTimeout(() => {
      scanDebounceTimer = null;
      scanAndAttachVideo();
    }, 250);
  }

  scanAndAttachVideo();

  const bodyObserver = new MutationObserver((mutations) => {
    const isInternalMutation = mutations.every((m) => {
      const t = m.target as HTMLElement | null;
      return (
        t &&
        (t.id === 'ncw-subtitle-container' ||
          t.id === 'ncw-player-toggle-btn' ||
          t.id === 'ncw-toast' ||
          t.closest?.('#ncw-subtitle-container') ||
          t.closest?.('#ncw-player-toggle-btn') ||
          t.closest?.('#ncw-toast'))
      );
    });

    if (!isInternalMutation) {
      scheduleScanAndAttachVideo();
    }
  });

  bodyObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Periodic heartbeat (every 20s) to keep SW alive and sync active showId
  setInterval(sendHeartbeat, 20000);
  sendHeartbeat();

  intervalId = setInterval(scanAndAttachVideo, 1500);
})();
