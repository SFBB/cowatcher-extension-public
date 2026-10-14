/**
 * CoWatcher - Options & Dashboard Controller
 */

import { NCW_CONSTANTS, ExtensionSettings } from '@shared/utils/constants';
import { TrackCacheRepositoryFactory } from '../background/infrastructure/cache/TrackCacheRepositoryFactory';
import { OptionsMessageService } from './application/OptionsMessageService';
import { TrackCacheRecord, EpisodeVocabData } from '@shared/types/Messages';
import { ContextDTO } from '@shared/domain/entities/Context';
import { BrowserStorageFactory } from '@shared/infrastructure/storage/BrowserStorageFactory';
import { BrowserPlatformFactory } from '@shared/infrastructure/platform/BrowserPlatformFactory';
import { NCW_STORAGE_KEYS } from '@shared/domain/constants/StorageKeys';
import { Language } from '@shared/domain/value-objects/Language';
import { Logger } from '@shared/utils/logger';
import { TranslationProvider } from '@shared/domain/entities/PipelineTypes';

const logger = new Logger('options');

interface CachedContextItem extends ContextDTO {
  storageKey: string;
}

document.addEventListener('DOMContentLoaded', () => {
  const messageService = OptionsMessageService.getInstance();
  const storage = BrowserStorageFactory.getStorage();
  const cacheRepository = TrackCacheRepositoryFactory.getRepository();

  let cachedTracks: TrackCacheRecord[] = [];
  let cachedVocabList: EpisodeVocabData[] = [];
  let cachedContextList: CachedContextItem[] = [];
  let currentSettings: ExtensionSettings = { ...NCW_CONSTANTS.DEFAULT_SETTINGS };
  let activeModalVocab: EpisodeVocabData | null = null;

  // Accordion and batch selection state
  const expandedCacheGroups = new Set<string>();
  const expandedVocabGroups = new Set<string>();
  const selectedVocabEpisodeIds = new Set<string>();

  // DOM Elements - Navigation
  const navTabs = document.querySelectorAll<HTMLButtonElement>('.nav-tab-btn');
  const tabPanes = document.querySelectorAll<HTMLElement>('.tab-pane');
  const navCacheCount = document.getElementById('nav-cache-count');
  const navVocabCount = document.getElementById('nav-vocab-count');
  const navContextCount = document.getElementById('nav-context-count');
  const uiLanguageSelect = document.getElementById(
    'options-ui-language'
  ) as HTMLSelectElement | null;

  // DOM Elements - Subtitle Cache Pane
  const btnRefreshCache = document.getElementById('btn-refresh-cache');
  const btnClearAllCache = document.getElementById('btn-clear-all-cache');
  const cacheSearchInput = document.getElementById('cache-search') as HTMLInputElement | null;
  const cacheTableBody = document.getElementById('cache-table-body');
  const statCacheTracks = document.getElementById('stat-cache-tracks');
  const statCacheCues = document.getElementById('stat-cache-cues');
  const statCacheReviewedRaw = document.getElementById('stat-cache-reviewed-raw');
  const cacheListCount = document.getElementById('cache-list-count');

  // DOM Elements - Vocabulary Pane
  const btnRefreshVocab = document.getElementById('btn-refresh-vocab');
  const btnClearAllVocab = document.getElementById('btn-clear-all-vocab');
  const vocabSearchInput = document.getElementById('vocab-search') as HTMLInputElement | null;
  const vocabCardsGrid = document.getElementById('vocab-cards-grid');
  const vocabSelectAllCheckbox = document.getElementById(
    'vocab-select-all'
  ) as HTMLInputElement | null;
  const btnExportSelectedVocab = document.getElementById(
    'btn-export-selected-vocab'
  ) as HTMLButtonElement | null;
  const statVocabEpisodes = document.getElementById('stat-vocab-episodes');
  const statVocabWords = document.getElementById('stat-vocab-words');
  const vocabListCount = document.getElementById('vocab-list-count');

  // DOM Elements - Show Context Pane
  const btnRefreshContext = document.getElementById('btn-refresh-context');
  const btnClearAllContext = document.getElementById('btn-clear-all-context');
  const contextSearchInput = document.getElementById('context-search') as HTMLInputElement | null;
  const contextCardsGrid = document.getElementById('context-cards-grid');
  const statContextShows = document.getElementById('stat-context-shows');
  const statContextChars = document.getElementById('stat-context-chars');
  const statContextTerms = document.getElementById('stat-context-terms');
  const contextListCount = document.getElementById('context-list-count');

  // DOM Elements - Settings Pane
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const cfgAiProvider = document.getElementById('cfg-ai-provider') as HTMLSelectElement | null;
  const cfgOllamaSection = document.getElementById('cfg-ollama-section');
  const cfgOpenrouterSection = document.getElementById('cfg-openrouter-section');
  const cfgOllamaHost = document.getElementById('cfg-ollama-host') as HTMLInputElement | null;
  const cfgTranslationModel = document.getElementById(
    'cfg-translation-model'
  ) as HTMLInputElement | null;
  const cfgSupervisorModel = document.getElementById(
    'cfg-supervisor-model'
  ) as HTMLInputElement | null;
  const cfgOpenrouterKey = document.getElementById('cfg-openrouter-key') as HTMLInputElement | null;
  const cfgOpenrouterTransModel = document.getElementById(
    'cfg-openrouter-trans-model'
  ) as HTMLSelectElement | null;
  const cfgOpenrouterSupModel = document.getElementById(
    'cfg-openrouter-sup-model'
  ) as HTMLSelectElement | null;
  const cfgEnableSupervisor = document.getElementById(
    'cfg-enable-supervisor'
  ) as HTMLInputElement | null;
  const cfgTargetLang = document.getElementById('cfg-target-lang') as HTMLInputElement | null;
  const cfgDisplayMode = document.getElementById('cfg-display-mode') as HTMLSelectElement | null;
  const cfgPreferNativeSubtitles = document.getElementById(
    'cfg-prefer-native-subtitles'
  ) as HTMLInputElement | null;
  const cfgExtractNativeTerms = document.getElementById(
    'cfg-extract-native-terms'
  ) as HTMLInputElement | null;
  const cfgHideNative = document.getElementById('cfg-hide-native') as HTMLInputElement | null;
  const cfgEnableDomSync = document.getElementById(
    'cfg-enable-dom-sync'
  ) as HTMLInputElement | null;
  const cfgVocabEnabled = document.getElementById('cfg-vocab-enabled') as HTMLInputElement | null;
  const cfgVocabProvider = document.getElementById(
    'cfg-vocab-provider'
  ) as HTMLSelectElement | null;
  const cfgVocabDifficulty = document.getElementById(
    'cfg-vocab-difficulty'
  ) as HTMLSelectElement | null;
  const cfgVocabSourceLang = document.getElementById(
    'cfg-vocab-source-lang'
  ) as HTMLInputElement | null;
  const cfgVocabCustomPrompt = document.getElementById(
    'cfg-vocab-custom-prompt'
  ) as HTMLTextAreaElement | null;

  // DOM Elements - Modal & Toast
  const vocabPreviewModal = document.getElementById('vocab-preview-modal');
  const modalEpisodeTitle = document.getElementById('modal-episode-title');
  const modalWordsList = document.getElementById('modal-words-list');
  const modalWordCount = document.getElementById('modal-word-count');
  const modalDownloadBtn = document.getElementById('modal-download-btn');
  const btnModalClose = document.getElementById('btn-modal-close');
  const toastNotify = document.getElementById('toast-notify');

  // DOM Elements - Range Invalidate Modal
  const cacheRangeModal = document.getElementById('cache-range-modal');
  const rangeModalShowTitle = document.getElementById('range-modal-show-title');
  const rangeModalTrackHash = document.getElementById('range-modal-track-hash');
  const rangeStartText = document.getElementById('range-start-text') as HTMLInputElement | null;
  const rangeEndText = document.getElementById('range-end-text') as HTMLInputElement | null;
  const rangeSliderStart = document.getElementById('range-slider-start') as HTMLInputElement | null;
  const rangeSliderEnd = document.getElementById('range-slider-end') as HTMLInputElement | null;
  const rangeSliderStartVal = document.getElementById('range-slider-start-val');
  const rangeSliderEndVal = document.getElementById('range-slider-end-val');
  const rangeSliderMaxLabel = document.getElementById('range-slider-max-label');
  const rangePreviewCount = document.getElementById('range-preview-count');
  const btnRangeModalClose = document.getElementById('btn-range-modal-close');
  const btnRangeModalCancel = document.getElementById('btn-range-modal-cancel');
  const btnRangeModalConfirm = document.getElementById('btn-range-modal-confirm');

  let activeRangeTrack: TrackCacheRecord | null = null;

  // 1. Tab Switching
  function switchTab(tabId?: string): void {
    if (!tabId) return;
    navTabs.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    tabPanes.forEach((pane) => {
      pane.classList.toggle('active', pane.id === `pane-${tabId}`);
    });
    sessionStorage.setItem('ncw_options_active_tab', tabId);
  }

  navTabs.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  const savedTab = sessionStorage.getItem('ncw_options_active_tab');
  if (savedTab) {
    switchTab(savedTab);
  }

  // Toast Helper
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function showToast(message: string): void {
    if (!toastNotify) return;
    toastNotify.textContent = message;
    toastNotify.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastNotify.classList.remove('show');
    }, 2400);
  }

  function escapeHtml(str: string): string {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatRelativeTime(ts?: number): string {
    if (!ts) return 'Never';
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // ==========================================
  // TAB 1: SUBTITLE CACHE CONTROLLER
  // ==========================================
  async function loadSubtitleCaches(): Promise<void> {
    try {
      const records = await cacheRepository.getAllTrackCaches();
      cachedTracks = records || [];
      renderSubtitleCaches();
    } catch (e) {
      logger.warn('options', 'Failed loading caches:', e);
    }
  }

  function renderSubtitleCaches(): void {
    const query = (cacheSearchInput?.value || '').trim().toLowerCase();
    const filtered = cachedTracks.filter((t) => {
      if (!query) return true;
      return (
        (t.showTitle && t.showTitle.toLowerCase().includes(query)) ||
        (t.movieId && t.movieId.toLowerCase().includes(query)) ||
        (t.trackHash && t.trackHash.toLowerCase().includes(query)) ||
        (t.translationModel && t.translationModel.toLowerCase().includes(query)) ||
        (t.targetLanguage && t.targetLanguage.toLowerCase().includes(query))
      );
    });

    const totalTracks = cachedTracks.length;
    let totalCues = 0;
    let totalReviewed = 0;
    let totalRaw = 0;

    cachedTracks.forEach((t) => {
      const cuesCount = Object.keys(t.cues || {}).length;
      totalCues += cuesCount;
      const rev = t.reviewedCount || 0;
      totalReviewed += rev;
      totalRaw += Math.max(0, cuesCount - rev);
    });

    if (statCacheTracks) statCacheTracks.textContent = String(totalTracks);
    if (statCacheCues) statCacheCues.textContent = String(totalCues);
    if (statCacheReviewedRaw) statCacheReviewedRaw.textContent = `${totalReviewed} / ${totalRaw}`;
    if (navCacheCount) navCacheCount.textContent = String(totalTracks);
    if (cacheListCount)
      cacheListCount.textContent = `Showing ${filtered.length} of ${totalTracks} tracks`;

    if (!cacheTableBody) return;

    if (filtered.length === 0) {
      cacheTableBody.innerHTML = `
        <tr>
          <td colspan="7" class="empty-state" style="text-align: center; padding: 40px; color: #888;">
            ${cachedTracks.length === 0 ? 'No persistent subtitle caches found yet. Watch any video with translation enabled to populate the cache.' : 'No matching subtitle tracks found.'}
          </td>
        </tr>
      `;
      return;
    }

    // Group filtered tracks by show title (or movie ID if no title)
    const groupsMap = new Map<
      string,
      {
        groupId: string;
        showTitle: string;
        tracks: TrackCacheRecord[];
        totalCues: number;
        reviewedCues: number;
        rawCues: number;
        latestUpdated: number;
      }
    >();

    filtered.forEach((t) => {
      const rawTitle = (t.showTitle || '').trim();
      const groupId = rawTitle ? rawTitle.toLowerCase() : `movie_${t.movieId || 'unknown'}`;
      const showTitle = rawTitle || `Episode ${t.movieId || 'Unknown'}`;
      const cuesCount = Object.keys(t.cues || {}).length;
      const rev = t.reviewedCount || 0;
      const raw = Math.max(0, cuesCount - rev);
      const updatedAt = t.updatedAt || 0;

      let group = groupsMap.get(groupId);
      if (!group) {
        group = {
          groupId,
          showTitle,
          tracks: [],
          totalCues: 0,
          reviewedCues: 0,
          rawCues: 0,
          latestUpdated: updatedAt,
        };
        groupsMap.set(groupId, group);
      }
      group.tracks.push(t);
      group.totalCues += cuesCount;
      group.reviewedCues += rev;
      group.rawCues += raw;
      if (updatedAt > group.latestUpdated) {
        group.latestUpdated = updatedAt;
      }
    });

    const groups = Array.from(groupsMap.values()).sort((a, b) => b.latestUpdated - a.latestUpdated);

    let html = '';
    groups.forEach((g) => {
      const isExpanded = expandedCacheGroups.has(g.groupId);
      html += `
        <tr class="cache-group-header-row" data-group-id="${escapeHtml(g.groupId)}">
          <td colspan="7">
            <div class="cache-group-header">
              <div class="cache-group-title-area">
                <span class="cache-group-toggle-btn">
                  <span class="toggle-icon ${isExpanded ? 'expanded' : ''}">▶</span>
                  <span class="cache-group-title">${escapeHtml(g.showTitle)}</span>
                </span>
                <span class="badge badge-neutral">${g.tracks.length} ${g.tracks.length > 1 ? 'episodes' : 'episode'}</span>
              </div>
              <div class="cache-group-stats">
                <span style="color: #46d369; font-weight: 600;">${g.reviewedCues}</span>
                <span style="color: #666;"> / </span>
                <span style="color: #e5a00d;">${g.rawCues}</span>
                <span style="font-size: 11px; color: #777;"> (${g.totalCues} cues)</span>
                <span class="cache-group-hint">${isExpanded ? 'Click to collapse ▲' : 'Click to expand episodes ▼'}</span>
              </div>
            </div>
          </td>
        </tr>
      `;

      g.tracks
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .forEach((t) => {
          const cuesCount = Object.keys(t.cues || {}).length;
          const reviewed = t.reviewedCount || 0;
          const raw = Math.max(0, cuesCount - reviewed);
          const hashDisplay = escapeHtml((t.trackHash || '').slice(0, 10));
          const modelDisplay = escapeHtml(
            `${t.provider || 'ollama'} : ${t.translationModel || ''}`
          );
          const langDisplay = escapeHtml(t.targetLanguage || 'English');

          html += `
            <tr class="cache-child-row" data-parent-group="${escapeHtml(g.groupId)}" style="${isExpanded ? '' : 'display: none;'}">
              <td>
                <div style="font-weight: 600; color: #fff;">Episode ID: ${escapeHtml(t.movieId || 'N/A')}</div>
                <div style="font-size: 11px; color: #888;">${escapeHtml(t.showTitle || '')}</div>
              </td>
              <td><code>${hashDisplay}...</code></td>
              <td><span class="badge badge-neutral">${langDisplay}</span></td>
              <td><span style="font-size: 12px; color: #aaa;">${modelDisplay}</span></td>
              <td>
                <span style="font-weight: 600; color: #46d369;">${reviewed}</span>
                <span style="color: #666;"> / </span>
                <span style="color: #e5a00d;">${raw}</span>
                <span style="font-size: 11px; color: #777;"> (${cuesCount} total)</span>
              </td>
              <td style="font-size: 12px; color: #888;">${formatRelativeTime(t.updatedAt)}</td>
              <td style="white-space: nowrap;">
                <button class="btn-secondary btn-sm btn-range-stale" data-key="${escapeHtml(t.cacheKey)}" style="margin-right: 6px;">
                  ⏱️ Invalidate Range
                </button>
                <button class="btn-danger btn-sm btn-delete-cache" data-key="${escapeHtml(t.cacheKey)}">
                  🗑️ Delete
                </button>
              </td>
            </tr>
          `;
        });
    });

    cacheTableBody.innerHTML = html;
  }

  // --- Range Invalidate Modal Handlers ---

  function formatSecondsToTime(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const remainingS = s % 60;
    const h = Math.floor(m / 60);
    const remainingM = m % 60;
    if (h > 0) {
      return `${String(h).padStart(2, '0')}:${String(remainingM).padStart(2, '0')}:${String(remainingS).padStart(2, '0')}`;
    }
    return `${String(remainingM).padStart(2, '0')}:${String(remainingS).padStart(2, '0')}`;
  }

  function parseTimeToSeconds(str: string): number {
    const parts = str
      .trim()
      .split(':')
      .map((p) => parseInt(p, 10));
    if (parts.some((p) => isNaN(p))) return 0;
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    } else if (parts.length === 1) {
      return parts[0];
    }
    return 0;
  }

  function updateRangePreview(): void {
    if (!activeRangeTrack || !rangeSliderStart || !rangeSliderEnd) return;
    let startSec = parseInt(rangeSliderStart.value, 10) || 0;
    let endSec = parseInt(rangeSliderEnd.value, 10) || 0;

    if (startSec > endSec) {
      endSec = startSec;
      rangeSliderEnd.value = String(endSec);
    }

    if (rangeSliderStartVal) rangeSliderStartVal.textContent = formatSecondsToTime(startSec);
    if (rangeSliderEndVal) rangeSliderEndVal.textContent = formatSecondsToTime(endSec);
    if (rangeStartText && document.activeElement !== rangeStartText) {
      rangeStartText.value = formatSecondsToTime(startSec);
    }
    if (rangeEndText && document.activeElement !== rangeEndText) {
      rangeEndText.value = formatSecondsToTime(endSec);
    }

    const cues = Object.values(activeRangeTrack.cues || {});
    const count = cues.filter((c) => {
      const cStart = c.startTime ?? 0;
      const cEnd = c.endTime ?? cStart + 5;
      return cStart <= endSec && cEnd >= startSec && c.status !== 'stale';
    }).length;

    if (rangePreviewCount) {
      rangePreviewCount.innerHTML = `<strong>${count}</strong> cues match this range (${formatSecondsToTime(startSec)} - ${formatSecondsToTime(endSec)}) and will be marked stale.`;
    }
  }

  function openRangeModal(track: TrackCacheRecord): void {
    activeRangeTrack = track;
    if (rangeModalShowTitle) {
      rangeModalShowTitle.textContent = `${track.showTitle || 'Unknown Show'} (${track.movieId || 'N/A'})`;
    }
    if (rangeModalTrackHash) {
      rangeModalTrackHash.textContent = `Track Hash: ${track.trackHash} | Provider: ${track.provider} (${track.translationModel})`;
    }

    const cues = Object.values(track.cues || {});
    let maxSec = 3600;
    cues.forEach((c) => {
      if (c.endTime && c.endTime > maxSec) maxSec = Math.ceil(c.endTime);
      else if (c.startTime && c.startTime + 10 > maxSec) maxSec = Math.ceil(c.startTime + 10);
    });

    if (rangeSliderStart && rangeSliderEnd) {
      rangeSliderStart.max = String(maxSec);
      rangeSliderEnd.max = String(maxSec);
      rangeSliderStart.value = '0';
      rangeSliderEnd.value = String(Math.min(600, maxSec));
    }
    if (rangeSliderMaxLabel) {
      rangeSliderMaxLabel.textContent = formatSecondsToTime(maxSec);
    }

    updateRangePreview();

    if (cacheRangeModal) {
      cacheRangeModal.style.display = 'flex';
    }
  }

  function closeRangeModal(): void {
    activeRangeTrack = null;
    if (cacheRangeModal) {
      cacheRangeModal.style.display = 'none';
    }
  }

  // Handle Cache Table Actions (Delete, Invalidate Range, & Accordion Toggle)
  cacheTableBody?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;

    const groupRow = target?.closest('.cache-group-header-row') as HTMLElement | null;
    if (groupRow && !target?.closest('button')) {
      const gid = groupRow.dataset.groupId;
      if (gid) {
        if (expandedCacheGroups.has(gid)) {
          expandedCacheGroups.delete(gid);
        } else {
          expandedCacheGroups.add(gid);
        }
        renderSubtitleCaches();
        return;
      }
    }

    const rangeBtn = target?.closest('.btn-range-stale') as HTMLButtonElement | null;
    if (rangeBtn) {
      const cacheKey = rangeBtn.dataset.key;
      const track = cachedTracks.find((t) => t.cacheKey === cacheKey);
      if (track) openRangeModal(track);
      return;
    }

    const delBtn = target?.closest('.btn-delete-cache') as HTMLButtonElement | null;
    if (delBtn) {
      const cacheKey = delBtn.dataset.key;
      if (!cacheKey) return;
      if (confirm('Are you sure you want to delete this cached subtitle track?')) {
        cacheRepository.deleteTrackCache(cacheKey).then(() => {
          showToast('Cached subtitle track deleted');
          loadSubtitleCaches();
        });
      }
    }
  });

  btnRangeModalClose?.addEventListener('click', closeRangeModal);
  btnRangeModalCancel?.addEventListener('click', closeRangeModal);
  cacheRangeModal?.addEventListener('click', (e) => {
    if (e.target === cacheRangeModal) closeRangeModal();
  });

  rangeSliderStart?.addEventListener('input', () => {
    if (rangeSliderStart && rangeSliderEnd) {
      if (parseInt(rangeSliderStart.value, 10) > parseInt(rangeSliderEnd.value, 10)) {
        rangeSliderEnd.value = rangeSliderStart.value;
      }
    }
    updateRangePreview();
  });

  rangeSliderEnd?.addEventListener('input', () => {
    if (rangeSliderStart && rangeSliderEnd) {
      if (parseInt(rangeSliderEnd.value, 10) < parseInt(rangeSliderStart.value, 10)) {
        rangeSliderStart.value = rangeSliderEnd.value;
      }
    }
    updateRangePreview();
  });

  rangeStartText?.addEventListener('change', () => {
    if (!rangeStartText || !rangeSliderStart) return;
    const sec = parseTimeToSeconds(rangeStartText.value);
    rangeSliderStart.value = String(sec);
    if (rangeSliderEnd && parseInt(rangeSliderEnd.value, 10) < sec) {
      rangeSliderEnd.value = String(sec);
    }
    updateRangePreview();
  });

  rangeEndText?.addEventListener('change', () => {
    if (!rangeEndText || !rangeSliderEnd) return;
    const sec = parseTimeToSeconds(rangeEndText.value);
    rangeSliderEnd.value = String(sec);
    if (rangeSliderStart && parseInt(rangeSliderStart.value, 10) > sec) {
      rangeSliderStart.value = String(sec);
    }
    updateRangePreview();
  });

  btnRangeModalConfirm?.addEventListener('click', async () => {
    if (!activeRangeTrack || !rangeSliderStart || !rangeSliderEnd) return;
    const startSec = parseInt(rangeSliderStart.value, 10) || 0;
    const endSec = parseInt(rangeSliderEnd.value, 10) || 0;

    btnRangeModalConfirm.setAttribute('disabled', 'true');
    btnRangeModalConfirm.textContent = 'Invalidating...';

    try {
      const res = await messageService.markCuesStale({
        cacheKey: activeRangeTrack.cacheKey,
        trackHash: activeRangeTrack.trackHash,
        startTime: startSec,
        endTime: endSec,
      });

      if (res && res.success) {
        showToast(
          `Marked ${res.invalidatedCount} cues as stale [${formatSecondsToTime(startSec)} - ${formatSecondsToTime(endSec)}]`
        );
        closeRangeModal();
        await loadSubtitleCaches();
      } else {
        alert(`Failed to invalidate cues: ${res?.error || 'Unknown error'}`);
      }
    } catch (err: any) {
      alert(`Error invalidating cues: ${err?.message || err}`);
    } finally {
      btnRangeModalConfirm.removeAttribute('disabled');
      btnRangeModalConfirm.textContent = '⚠️ Mark Range Stale';
    }
  });

  btnClearAllCache?.addEventListener('click', () => {
    if (confirm('⚠️ Clear ALL indexedDB subtitle translation caches?')) {
      cacheRepository.clearAllTrackCaches().then(() => {
        showToast('All subtitle caches cleared');
        loadSubtitleCaches();
      });
    }
  });

  btnRefreshCache?.addEventListener('click', loadSubtitleCaches);
  cacheSearchInput?.addEventListener('input', renderSubtitleCaches);

  // ==========================================
  // TAB 2: VOCABULARY CONTROLLER
  // ==========================================
  function loadVocabBank(): void {
    storage.get<EpisodeVocabData>(null).then((all) => {
      cachedVocabList = [];
      if (all) {
        for (const [key, val] of Object.entries(all)) {
          if (
            key.startsWith(NCW_STORAGE_KEYS.VOCAB_PREFIX) &&
            val &&
            Array.isArray((val as EpisodeVocabData).words)
          ) {
            cachedVocabList.push(val as EpisodeVocabData);
          }
        }
      }
      cachedVocabList.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      renderVocabBank();
    });
  }

  function renderVocabBank(): void {
    const query = (vocabSearchInput?.value || '').trim().toLowerCase();
    const filtered = cachedVocabList.filter((v) => {
      if (!query) return true;
      const titleMatch =
        (v.showTitle && v.showTitle.toLowerCase().includes(query)) ||
        (v.movieId && v.movieId.toLowerCase().includes(query));
      if (titleMatch) return true;
      return v.words.some(
        (w) =>
          (w.word && w.word.toLowerCase().includes(query)) ||
          (w.meaning && w.meaning.toLowerCase().includes(query))
      );
    });

    const totalEpisodes = cachedVocabList.length;
    let totalWords = 0;
    cachedVocabList.forEach((v) => {
      totalWords += v.words.length;
    });

    if (statVocabEpisodes) statVocabEpisodes.textContent = String(totalEpisodes);
    if (statVocabWords) statVocabWords.textContent = String(totalWords);
    if (navVocabCount) navVocabCount.textContent = String(totalWords);
    if (vocabListCount)
      vocabListCount.textContent = `Showing ${filtered.length} of ${totalEpisodes} episodes`;

    // Update Select All Checkbox and Batch Export Button
    const allFilteredEpisodeIds = filtered.map((v) => v.movieId);
    const selectedCountInFiltered = allFilteredEpisodeIds.filter((id) =>
      selectedVocabEpisodeIds.has(id)
    ).length;

    if (vocabSelectAllCheckbox) {
      if (
        allFilteredEpisodeIds.length > 0 &&
        selectedCountInFiltered === allFilteredEpisodeIds.length
      ) {
        vocabSelectAllCheckbox.checked = true;
        vocabSelectAllCheckbox.indeterminate = false;
      } else if (selectedCountInFiltered > 0) {
        vocabSelectAllCheckbox.checked = false;
        vocabSelectAllCheckbox.indeterminate = true;
      } else {
        vocabSelectAllCheckbox.checked = false;
        vocabSelectAllCheckbox.indeterminate = false;
      }
    }

    if (btnExportSelectedVocab) {
      const totalSelected = selectedVocabEpisodeIds.size;
      btnExportSelectedVocab.disabled = totalSelected === 0;
      btnExportSelectedVocab.textContent = `⬇️ Export Selected (${totalSelected})`;
    }

    if (!vocabCardsGrid) return;

    if (filtered.length === 0) {
      vocabCardsGrid.innerHTML = `
        <div class="empty-state" style="text-align: center; padding: 40px; color: #888;">
          ${cachedVocabList.length === 0 ? 'No vocabulary collected yet. Enable AI Vocabulary Extractor in settings to start collecting difficult words while watching.' : 'No matching vocabulary found.'}
        </div>
      `;
      return;
    }

    // Group filtered vocabulary by show title (or movie ID if no title)
    const groupsMap = new Map<
      string,
      {
        groupId: string;
        showTitle: string;
        episodes: EpisodeVocabData[];
        totalWords: number;
        latestUpdated: number;
      }
    >();

    filtered.forEach((v) => {
      const rawTitle = (v.showTitle || '').trim();
      const groupId = rawTitle ? rawTitle.toLowerCase() : `movie_${v.movieId || 'unknown'}`;
      const showTitle = rawTitle || `Episode ${v.movieId || 'Unknown'}`;
      const wordCount = v.words.length;
      const updatedAt = v.updatedAt || 0;

      let group = groupsMap.get(groupId);
      if (!group) {
        group = {
          groupId,
          showTitle,
          episodes: [],
          totalWords: 0,
          latestUpdated: updatedAt,
        };
        groupsMap.set(groupId, group);
      }
      group.episodes.push(v);
      group.totalWords += wordCount;
      if (updatedAt > group.latestUpdated) {
        group.latestUpdated = updatedAt;
      }
    });

    const groups = Array.from(groupsMap.values()).sort((a, b) => b.latestUpdated - a.latestUpdated);

    let html = '';
    groups.forEach((g) => {
      const isExpanded = expandedVocabGroups.has(g.groupId);
      const groupEpisodeIds = g.episodes.map((e) => e.movieId);
      const allGroupSelected =
        groupEpisodeIds.length > 0 &&
        groupEpisodeIds.every((id) => selectedVocabEpisodeIds.has(id));
      const someGroupSelected =
        !allGroupSelected && groupEpisodeIds.some((id) => selectedVocabEpisodeIds.has(id));

      html += `
        <div class="vocab-show-group ${isExpanded ? 'expanded' : ''}" data-group-id="${escapeHtml(g.groupId)}">
          <div class="vocab-show-header">
            <div class="vocab-show-info">
              <input type="checkbox" class="chk-show-select" data-group-id="${escapeHtml(g.groupId)}" ${allGroupSelected ? 'checked' : ''} ${someGroupSelected ? 'data-indeterminate="true"' : ''} title="Select all episodes of this show">
              <div class="vocab-show-toggle" data-toggle="${escapeHtml(g.groupId)}">
                <span class="toggle-icon ${isExpanded ? 'expanded' : ''}">▶</span>
                <span class="vocab-show-title">${escapeHtml(g.showTitle)}</span>
              </div>
              <span class="badge badge-neutral">${g.episodes.length} ${g.episodes.length > 1 ? 'episodes' : 'episode'}</span>
              <span class="badge badge-green">${g.totalWords} words</span>
            </div>
            <div class="vocab-show-actions">
              <button class="btn-secondary btn-sm btn-export-show" data-group-id="${escapeHtml(g.groupId)}">
                ⬇️ Export Entire Show (CSV)
              </button>
              <button class="btn-secondary btn-sm btn-toggle-vocab-group" data-group-id="${escapeHtml(g.groupId)}">
                ${isExpanded ? 'Collapse ▲' : 'Expand ▼'}
              </button>
            </div>
          </div>
          <div class="vocab-episodes-container" style="${isExpanded ? '' : 'display: none;'}">
            ${g.episodes
              .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
              .map((v) => {
                const count = v.words.length;
                const isEpSelected = selectedVocabEpisodeIds.has(v.movieId);
                const wordPreview = v.words
                  .slice(0, 6)
                  .map((w) => `<span class="word-chip">${escapeHtml(w.word)}</span>`)
                  .join('');

                return `
                  <div class="vocab-episode-card">
                    <div>
                      <div class="vocab-episode-header">
                        <div class="vocab-episode-title-area">
                          <input type="checkbox" class="chk-episode-select" data-id="${escapeHtml(v.movieId)}" ${isEpSelected ? 'checked' : ''}>
                          <div>
                            <div class="vocab-episode-id">Episode ID: ${escapeHtml(v.movieId)}</div>
                            <div style="font-size: 11px; color: #888;">${escapeHtml(v.showTitle || '')}</div>
                          </div>
                        </div>
                        <span class="badge badge-green">${count} words</span>
                      </div>
                      <div class="vocab-episode-body">
                        <div style="font-size: 11px; color:#888; margin-bottom: 6px;">Collected Words Preview:</div>
                        <div class="tags-cloud">${wordPreview || '<span style="color:#666; font-size: 11px;">No words yet</span>'}</div>
                      </div>
                    </div>
                    <div class="vocab-episode-footer">
                      <span style="font-size: 11px; color:#777;">${formatRelativeTime(v.updatedAt)}</span>
                      <div style="display: flex; gap: 6px;">
                        <button class="btn-secondary btn-sm btn-preview-vocab" data-id="${escapeHtml(v.movieId)}">
                          👁️ View
                        </button>
                        <button class="btn-primary btn-sm btn-export-single-vocab" data-id="${escapeHtml(v.movieId)}">
                          ⬇️ Export
                        </button>
                        <button class="btn-danger btn-sm btn-delete-vocab" data-id="${escapeHtml(v.movieId)}">
                          🗑️
                        </button>
                      </div>
                    </div>
                  </div>
                `;
              })
              .join('')}
          </div>
        </div>
      `;
    });

    vocabCardsGrid.innerHTML = html;

    // Apply indeterminate property to show checkboxes
    vocabCardsGrid
      .querySelectorAll<HTMLInputElement>('.chk-show-select[data-indeterminate="true"]')
      .forEach((cb) => {
        cb.indeterminate = true;
      });
  }

  // Handle Vocab Actions
  vocabCardsGrid?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;

    // Episode Checkbox Toggle
    const chkEp = target?.closest('.chk-episode-select') as HTMLInputElement | null;
    if (chkEp) {
      const mid = chkEp.dataset.id;
      if (mid) {
        if (chkEp.checked) {
          selectedVocabEpisodeIds.add(mid);
        } else {
          selectedVocabEpisodeIds.delete(mid);
        }
        renderVocabBank();
      }
      return;
    }

    // Show Checkbox Toggle
    const chkShow = target?.closest('.chk-show-select') as HTMLInputElement | null;
    if (chkShow) {
      const gid = chkShow.dataset.groupId;
      if (gid) {
        const isChecked = chkShow.checked;
        const matchingEps = cachedVocabList.filter((v) => {
          const rawTitle = (v.showTitle || '').trim();
          const g = rawTitle ? rawTitle.toLowerCase() : `movie_${v.movieId || 'unknown'}`;
          return g === gid;
        });
        matchingEps.forEach((v) => {
          if (isChecked) {
            selectedVocabEpisodeIds.add(v.movieId);
          } else {
            selectedVocabEpisodeIds.delete(v.movieId);
          }
        });
        renderVocabBank();
      }
      return;
    }

    // Expand / Collapse Show Group
    const toggleTarget = target?.closest(
      '.vocab-show-toggle, .btn-toggle-vocab-group'
    ) as HTMLElement | null;
    if (toggleTarget) {
      const gid = toggleTarget.dataset.groupId || toggleTarget.dataset.toggle;
      if (gid) {
        if (expandedVocabGroups.has(gid)) {
          expandedVocabGroups.delete(gid);
        } else {
          expandedVocabGroups.add(gid);
        }
        renderVocabBank();
        return;
      }
    }

    // Export Entire Show
    const exportShowBtn = target?.closest('.btn-export-show') as HTMLButtonElement | null;
    if (exportShowBtn) {
      const gid = exportShowBtn.dataset.groupId;
      if (gid) {
        const matchingEps = cachedVocabList.filter((v) => {
          const rawTitle = (v.showTitle || '').trim();
          const g = rawTitle ? rawTitle.toLowerCase() : `movie_${v.movieId || 'unknown'}`;
          return g === gid;
        });
        if (matchingEps.length > 0) {
          const showTitle = matchingEps[0].showTitle || 'show';
          const cleanTitle = showTitle
            .replace(/[^\w\s\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af-]/g, '')
            .trim()
            .replace(/\s+/g, '_');
          exportMergedVocabCsv(matchingEps, `${cleanTitle}_full_show_vocab.csv`);
        }
      }
      return;
    }

    // Export Single Episode
    const exportSingleBtn = target?.closest('.btn-export-single-vocab') as HTMLButtonElement | null;
    if (exportSingleBtn) {
      const mid = exportSingleBtn.dataset.id;
      const found = cachedVocabList.find((v) => v.movieId === mid);
      if (found) {
        exportVocabCsv(found);
      }
      return;
    }

    // Preview Vocab Modal
    const viewBtn = target?.closest('.btn-preview-vocab') as HTMLButtonElement | null;
    if (viewBtn) {
      const mid = viewBtn.dataset.id;
      const found = cachedVocabList.find((v) => v.movieId === mid);
      if (found) openVocabPreviewModal(found);
      return;
    }

    // Delete Episode Vocab
    const deleteBtn = target?.closest('.btn-delete-vocab') as HTMLButtonElement | null;
    if (deleteBtn) {
      const mid = deleteBtn.dataset.id;
      if (mid && confirm('Delete collected vocabulary for this episode?')) {
        messageService.resetVocabData(mid).then(() => {
          selectedVocabEpisodeIds.delete(mid);
          showToast('Episode vocabulary deleted');
          loadVocabBank();
        });
      }
    }
  });

  // Select All Checkbox Handler
  vocabSelectAllCheckbox?.addEventListener('change', () => {
    const isChecked = vocabSelectAllCheckbox.checked;
    const query = (vocabSearchInput?.value || '').trim().toLowerCase();
    const filtered = cachedVocabList.filter((v) => {
      if (!query) return true;
      const titleMatch =
        (v.showTitle && v.showTitle.toLowerCase().includes(query)) ||
        (v.movieId && v.movieId.toLowerCase().includes(query));
      if (titleMatch) return true;
      return v.words.some(
        (w) =>
          (w.word && w.word.toLowerCase().includes(query)) ||
          (w.meaning && w.meaning.toLowerCase().includes(query))
      );
    });

    filtered.forEach((v) => {
      if (isChecked) {
        selectedVocabEpisodeIds.add(v.movieId);
      } else {
        selectedVocabEpisodeIds.delete(v.movieId);
      }
    });
    renderVocabBank();
  });

  // Export Selected Button Handler
  btnExportSelectedVocab?.addEventListener('click', () => {
    const selectedEpisodes = cachedVocabList.filter((v) => selectedVocabEpisodeIds.has(v.movieId));
    if (selectedEpisodes.length === 0) {
      alert('Please select at least one episode to export.');
      return;
    }
    const filename = `cowatcher_selected_vocab_${selectedEpisodes.length}_episodes.csv`;
    exportMergedVocabCsv(selectedEpisodes, filename);
  });

  btnClearAllVocab?.addEventListener('click', async () => {
    if (confirm('⚠️ Clear ALL collected vocabulary across all episodes?')) {
      const all = await storage.get<Record<string, unknown>>(null);
      const toRemove = Object.keys(all || {}).filter((k) => k.startsWith('ncw_vocab_'));
      if (toRemove.length > 0) {
        await storage.remove(toRemove);
        selectedVocabEpisodeIds.clear();
        showToast('All vocabulary cleared');
        loadVocabBank();
      }
    }
  });

  btnRefreshVocab?.addEventListener('click', loadVocabBank);
  vocabSearchInput?.addEventListener('input', renderVocabBank);

  // Vocab Modal Preview
  function openVocabPreviewModal(data: EpisodeVocabData): void {
    activeModalVocab = data;
    if (!vocabPreviewModal) return;

    if (modalEpisodeTitle) {
      modalEpisodeTitle.textContent = `${data.showTitle || 'Episode'} (${data.movieId}) - Vocab List`;
    }
    if (modalWordCount) {
      modalWordCount.textContent = `${data.words.length} words collected`;
    }

    if (modalWordsList) {
      if (data.words.length === 0) {
        modalWordsList.innerHTML =
          '<div style="text-align:center; padding: 20px; color:#888;">No words collected.</div>';
      } else {
        modalWordsList.innerHTML = data.words
          .map((w) => {
            const word = escapeHtml(w.word || '');
            const pos = w.pos
              ? `<span style="color:#aaa; font-style: italic; font-size: 11px;">(${escapeHtml(w.pos)})</span>`
              : '';
            const pho = w.phonetic
              ? `<span style="color:#777; font-size: 11px;">[${escapeHtml(w.phonetic)}]</span>`
              : '';
            const freq =
              w.frequency && w.frequency > 1
                ? `<span style="color:var(--accent-red); font-size: 11px;">×${w.frequency}</span>`
                : '';
            const meaning = escapeHtml(w.meaning || '');
            const sentence = w.sentence
              ? `<div style="font-size: 12px; color: #999; margin-top: 4px;">"${escapeHtml(w.sentence)}"</div>`
              : '';
            const trans = w.sentenceTranslation
              ? `<div style="font-size: 11.5px; color: #666;">${escapeHtml(w.sentenceTranslation)}</div>`
              : '';

            return `
              <div style="background:#16161b; border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; margin-bottom: 10px;">
                <div style="display:flex; justify-content: space-between; align-items: center;">
                  <strong style="color:#fff; font-size: 14.5px;">${word}</strong>
                  <div style="display: flex; gap: 6px;">${pos} ${pho} ${freq}</div>
                </div>
                <div style="color: #46d369; font-size: 13px; margin: 4px 0;">${meaning}</div>
                ${sentence}
                ${trans}
              </div>
            `;
          })
          .join('');
      }
    }

    vocabPreviewModal.style.display = 'flex';
  }

  btnModalClose?.addEventListener('click', () => {
    if (vocabPreviewModal) vocabPreviewModal.style.display = 'none';
  });

  vocabPreviewModal?.addEventListener('click', (e) => {
    if (e.target === vocabPreviewModal) vocabPreviewModal.style.display = 'none';
  });

  modalDownloadBtn?.addEventListener('click', () => {
    if (activeModalVocab) exportVocabCsv(activeModalVocab);
  });

  function exportMergedVocabCsv(episodes: EpisodeVocabData[], filename: string): void {
    if (!episodes || episodes.length === 0) return;
    const headers = [
      'Word',
      'POS',
      'Phonetic',
      'Contextual Meaning',
      'Original Sentence',
      'Sentence Translation',
      'Timestamp',
      'Frequency',
      'Episode ID',
      'Show Title',
    ];

    const escapeCsv = (str: string | number): string => {
      const s = String(str || '');
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : `"${s}"`;
    };

    const rows: string[][] = [];
    episodes.forEach((ep) => {
      const epTitle = ep.showTitle || '';
      const epMid = ep.movieId || '';
      ep.words.forEach((w) => {
        rows.push([
          escapeCsv(w.word || ''),
          escapeCsv(w.pos || ''),
          escapeCsv(w.phonetic || ''),
          escapeCsv(w.meaning || ''),
          escapeCsv(w.sentence || ''),
          escapeCsv(w.sentenceTranslation || ''),
          escapeCsv(
            typeof w.timestamp === 'number'
              ? `${Math.floor(w.timestamp / 60)}:${String(Math.floor(w.timestamp % 60)).padStart(2, '0')}`
              : ''
          ),
          escapeCsv(w.frequency || 1),
          escapeCsv(epMid),
          escapeCsv(epTitle),
        ]);
      });
    });

    const csvContent =
      '\uFEFF' +
      [headers.map((h) => `"${h}"`).join(','), ...rows.map((r) => r.join(','))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 500);
  }

  function exportVocabCsv(data: EpisodeVocabData): void {
    if (!data || !Array.isArray(data.words) || data.words.length === 0) return;

    const srcLang = data.sourceLanguage || 'Source';
    const tgtLang = data.targetLanguage || 'Target';

    const headers = [
      `Word (${srcLang})`,
      'POS',
      'Phonetic',
      `Contextual Meaning (${tgtLang})`,
      `Original Sentence (${srcLang})`,
      `Sentence Translation (${tgtLang})`,
      'Timestamp',
      'Frequency',
    ];

    const escapeCsv = (str: string | number): string => {
      const s = String(str || '');
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : `"${s}"`;
    };

    const rows = data.words.map((w) => [
      escapeCsv(w.word || ''),
      escapeCsv(w.pos || ''),
      escapeCsv(w.phonetic || ''),
      escapeCsv(w.meaning || ''),
      escapeCsv(w.sentence || ''),
      escapeCsv(w.sentenceTranslation || ''),
      escapeCsv(
        typeof w.timestamp === 'number'
          ? `${Math.floor(w.timestamp / 60)}:${String(Math.floor(w.timestamp % 60)).padStart(2, '0')}`
          : ''
      ),
      escapeCsv(w.frequency || 1),
    ]);

    const csvContent =
      '\uFEFF' +
      [headers.map((h) => `"${h}"`).join(','), ...rows.map((r) => r.join(','))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const rawTitle = data.showTitle || `episode_${data.movieId}`;
    const cleanTitle = rawTitle
      .replace(/[^\w\s\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af-]/g, '')
      .trim()
      .replace(/\s+/g, '_');
    const filename = `${cleanTitle}_${data.movieId}_vocab.csv`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 500);
  }

  // ==========================================
  // TAB 3: SHOW CONTEXT & MEMORY CONTROLLER
  // ==========================================
  async function loadShowContexts(): Promise<void> {
    const all = await storage.get<Record<string, unknown>>(null);
    cachedContextList = [];
    if (all) {
      for (const [key, val] of Object.entries(all)) {
        // Only load show-level memory from ncw_show_ keys
        if (key.startsWith('ncw_show_') && val) {
          const dto = val as unknown as ContextDTO;
          const langCode = (Language.resolve(dto.targetLanguage)?.code || 'en').toLowerCase();
          const showIdentifier = (dto.showId || dto.mainTitle || dto.title || '')
            .trim()
            .toLowerCase();
          if (!showIdentifier) continue;

          const existingIndex = cachedContextList.findIndex((c) => {
            const cLangCode = (Language.resolve(c.targetLanguage)?.code || 'en').toLowerCase();
            if (cLangCode !== langCode) return false;
            if (dto.showId && c.showId) return c.showId === dto.showId;
            const cShowIdentifier = (c.showId || c.mainTitle || c.title || '').trim().toLowerCase();
            return cShowIdentifier === showIdentifier;
          });

          if (existingIndex >= 0) {
            if ((dto.updatedAt || 0) > (cachedContextList[existingIndex].updatedAt || 0)) {
              cachedContextList[existingIndex] = { ...dto, storageKey: key };
            }
          } else {
            cachedContextList.push({ ...dto, storageKey: key });
          }
        }
      }
    }
    cachedContextList.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    renderShowContexts();
  }

  function renderShowContexts(): void {
    const query = (contextSearchInput?.value || '').trim().toLowerCase();
    const filtered = cachedContextList.filter((c) => {
      if (!query) return true;
      const titleMatch =
        (c.title && c.title.toLowerCase().includes(query)) ||
        (c.mainTitle && c.mainTitle.toLowerCase().includes(query));
      if (titleMatch) return true;
      const charMatch = Object.keys(c.characters || {}).some((k) =>
        k.toLowerCase().includes(query)
      );
      const termMatch = Object.keys(c.terms || {}).some((k) => k.toLowerCase().includes(query));
      return charMatch || termMatch;
    });

    const totalShows = cachedContextList.length;
    let totalChars = 0;
    let totalTerms = 0;
    cachedContextList.forEach((c) => {
      totalChars += Object.keys(c.characters || {}).length;
      totalTerms += Object.keys(c.terms || {}).length;
    });

    if (statContextShows) statContextShows.textContent = String(totalShows);
    if (statContextChars) statContextChars.textContent = String(totalChars);
    if (statContextTerms) statContextTerms.textContent = String(totalTerms);
    if (navContextCount) navContextCount.textContent = String(totalShows);
    if (contextListCount)
      contextListCount.textContent = `Showing ${filtered.length} of ${totalShows} shows`;

    if (!contextCardsGrid) return;

    if (filtered.length === 0) {
      contextCardsGrid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1; text-align: center; padding: 40px; color: #888;">
          ${cachedContextList.length === 0 ? 'No show context memory initialized yet. The supervisor model will automatically identify shows and character glossaries during playback.' : 'No matching show memory found.'}
        </div>
      `;
      return;
    }

    contextCardsGrid.innerHTML = filtered
      .map((c) => {
        const titleStr = escapeHtml(c.mainTitle || c.title || 'Unknown Show');
        const charEntries = Object.entries(c.characters || {});
        const termEntries = Object.entries(c.terms || {});
        const synopsisStr = c.showSynopsis
          ? `<p style="font-size: 12px; color: #aaa; margin-bottom: 8px;">${escapeHtml(c.showSynopsis.slice(0, 140))}${c.showSynopsis.length > 140 ? '...' : ''}</p>`
          : '';

        const charTags = charEntries
          .slice(0, 8)
          .map(([name, val]) => {
            const trans = typeof val === 'string' ? val : val?.canonical || name;
            return `<span class="term-tag"><strong>${escapeHtml(name)}</strong>: ${escapeHtml(trans)}</span>`;
          })
          .join('');

        const termTags = termEntries
          .slice(0, 6)
          .map(([term, trans]) => {
            return `<span class="term-tag" style="background:#1e293b;">${escapeHtml(term)} ➔ ${escapeHtml(trans)}</span>`;
          })
          .join('');

        const langDisplay = escapeHtml(
          typeof c.targetLanguage === 'object'
            ? c.targetLanguage?.label || c.targetLanguage?.name || 'English'
            : c.targetLanguage || 'English'
        );
        const resolvedLangCode = Language.resolve(c.targetLanguage)?.code || 'en';

        return `
          <div class="card-item">
            <div>
              <div class="card-item-header">
                <div>
                  <div class="card-item-title">${titleStr}</div>
                  <div class="card-item-id">Lang: ${langDisplay}</div>
                </div>
                <span class="badge ${c.known ? 'badge-green' : 'badge-neutral'}">${c.known ? 'IDENTIFIED' : 'PENDING'}</span>
              </div>

              ${synopsisStr}

              <div class="card-item-body">
                <div style="font-size: 11px; color:#888; margin-bottom: 4px;">Characters & Aliases (${charEntries.length}):</div>
                <div class="tags-cloud">${charTags || '<span style="color:#666; font-size: 11px;">None discovered yet</span>'}</div>

                ${
                  termEntries.length > 0
                    ? `
                  <div style="font-size: 11px; color:#888; margin-top: 10px; margin-bottom: 4px;">Glossary Terms (${termEntries.length}):</div>
                  <div class="tags-cloud">${termTags}</div>
                `
                    : ''
                }
              </div>
            </div>

            <div class="card-item-footer">
              <span style="font-size: 11px; color:#777;">${formatRelativeTime(c.updatedAt)}</span>
              <div style="display: flex; gap: 8px;">
                <button class="btn-primary btn-sm btn-open-glossary-editor"
                  data-showid="${escapeHtml(c.showId || '')}"
                  data-title="${escapeHtml(c.mainTitle || c.title || '')}"
                  data-lang="${escapeHtml(resolvedLangCode)}">
                  ✏️ Open Glossary Editor
                </button>
                <button class="btn-danger btn-sm btn-delete-context"
                  data-key="${escapeHtml(c.storageKey)}"
                  data-showid="${escapeHtml(c.showId || '')}"
                  data-lang="${escapeHtml(resolvedLangCode)}">
                  🗑️
                </button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // Handle Context Actions (Open Glossary Editor & Delete)
  contextCardsGrid?.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement | null;

    // Handle Open Standalone Glossary Editor
    const editorBtn = target?.closest('.btn-open-glossary-editor') as HTMLButtonElement | null;
    if (editorBtn) {
      const showId = editorBtn.dataset.showid || '';
      const title = editorBtn.dataset.title || '';
      const langCode = editorBtn.dataset.lang || 'en';

      const params = new URLSearchParams();
      if (showId) params.set('showId', showId);
      if (title) params.set('title', title);
      if (langCode) params.set('targetLang', langCode);
      if (currentSettings.uiLanguage) params.set('uiLang', currentSettings.uiLanguage);

      const editorUrl = `editor/editor.html?${params.toString()}`;
      try {
        const platform = BrowserPlatformFactory.getPlatform();
        platform.openPopupWindow({
          url: editorUrl,
          width: 780,
          height: 820,
          title: 'CoWatcher - Glossary Editor',
        });
      } catch {
        window.open(editorUrl, '_blank', 'width=780,height=820');
      }
      return;
    }

    // Handle Context Delete
    const btn = target?.closest('.btn-delete-context') as HTMLButtonElement | null;
    if (!btn) return;
    const key = btn.dataset.key;
    if (!key) return;

    if (
      confirm(
        'Are you sure you want to clear memory for this show? The supervisor will rebuild character context on next playback.'
      )
    ) {
      await storage.remove([key]);
      const showId = btn.dataset.showid;
      const langCode = btn.dataset.lang;
      if (showId && langCode) {
        messageService.resetGlossaryContext(showId, Language.resolve(langCode)).catch(() => {});
      }
      showToast('Show context memory cleared');
      loadShowContexts();
    }
  });

  btnClearAllContext?.addEventListener('click', async () => {
    if (confirm('⚠️ Clear ALL show context and supervisor memories?')) {
      const all = await storage.get<Record<string, unknown>>(null);
      const toRemove = Object.keys(all || {}).filter((k) => k.startsWith('ncw_show_'));
      if (toRemove.length > 0) {
        await storage.remove(toRemove);
        showToast('All show context memory cleared');
        loadShowContexts();
      }
    }
  });

  btnRefreshContext?.addEventListener('click', loadShowContexts);
  contextSearchInput?.addEventListener('input', renderShowContexts);

  // ==========================================
  // TAB 4: SETTINGS CONTROLLER
  // ==========================================
  async function loadSettings(): Promise<void> {
    const res = await storage.get<Record<string, unknown>>([NCW_CONSTANTS.STORAGE_KEYS.SETTINGS]);
    if (res && res[NCW_CONSTANTS.STORAGE_KEYS.SETTINGS]) {
      currentSettings = {
        ...NCW_CONSTANTS.DEFAULT_SETTINGS,
        ...(res[NCW_CONSTANTS.STORAGE_KEYS.SETTINGS] as Partial<ExtensionSettings>),
      };
    }
    syncSettingsUI();
  }

  function syncSettingsUI(): void {
    if (cfgAiProvider) cfgAiProvider.value = currentSettings.aiProvider || 'google';
    toggleProviderVisibility(currentSettings.aiProvider || 'google');

    if (cfgOllamaHost) cfgOllamaHost.value = currentSettings.ollamaHost || 'http://localhost:11434';
    if (cfgTranslationModel)
      cfgTranslationModel.value = currentSettings.translationModel || 'translategemma:4b';
    if (cfgSupervisorModel)
      cfgSupervisorModel.value = currentSettings.supervisorModel || 'translategemma:4b';

    if (cfgOpenrouterKey) cfgOpenrouterKey.value = currentSettings.openrouterApiKey || '';
    if (cfgEnableSupervisor)
      cfgEnableSupervisor.checked = currentSettings.enableSupervisor !== false;
    if (cfgTargetLang) {
      cfgTargetLang.innerHTML = Language.getAll()
        .map((l) => `<option value="${l.code}">${l.label}</option>`)
        .join('');
      const currentLang = Language.resolve(currentSettings.targetLanguage);
      cfgTargetLang.value = currentLang.code;
    }
    if (cfgDisplayMode) cfgDisplayMode.value = currentSettings.displayMode || 'bilingual';
    if (cfgPreferNativeSubtitles)
      cfgPreferNativeSubtitles.checked = currentSettings.preferNativeSubtitles !== false;
    if (cfgExtractNativeTerms)
      cfgExtractNativeTerms.checked = Boolean(currentSettings.extractTermsFromNativeSubtitles);
    if (cfgHideNative) cfgHideNative.checked = currentSettings.hideNativeSubtitles !== false;
    if (cfgEnableDomSync) cfgEnableDomSync.checked = Boolean(currentSettings.enableDomSubtitleSync);

    if (cfgVocabEnabled) cfgVocabEnabled.checked = Boolean(currentSettings.vocabExtractorEnabled);
    if (cfgVocabProvider)
      cfgVocabProvider.value = currentSettings.vocabExtractorProvider || 'openrouter';
    if (cfgVocabDifficulty)
      cfgVocabDifficulty.value = currentSettings.vocabExtractorDifficulty || 'medium';
    if (cfgVocabSourceLang) {
      const currentSrc = currentSettings.vocabSourceLanguage || 'auto';
      cfgVocabSourceLang.innerHTML = [
        '<option value="auto">✨ Auto Detect</option>',
        ...Language.getAll().map((l) => `<option value="${l.code}">${l.label}</option>`),
      ].join('');
      const matched = Language.get(currentSrc);
      cfgVocabSourceLang.value = matched
        ? matched.code
        : currentSrc === 'auto'
          ? 'auto'
          : Language.resolve(currentSrc).code;
    }
    if (cfgVocabCustomPrompt)
      cfgVocabCustomPrompt.value = currentSettings.vocabExtractorCustomPrompt || '';
    if (uiLanguageSelect) uiLanguageSelect.value = currentSettings.uiLanguage || 'en';

    populateOpenRouterOptions();
  }

  function toggleProviderVisibility(provider: string): void {
    const isOllama = provider === 'ollama';
    const isOpenRouter = provider === 'openrouter';
    if (cfgOllamaSection) cfgOllamaSection.style.display = isOllama ? 'block' : 'none';
    if (cfgOpenrouterSection) cfgOpenrouterSection.style.display = isOpenRouter ? 'block' : 'none';
  }

  cfgAiProvider?.addEventListener('change', (e) => {
    const target = e.target as HTMLSelectElement | null;
    if (target) toggleProviderVisibility(target.value);
  });

  const RECOMMENDED_MODELS = [
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3' },
    { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B Instruct' },
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct' },
    { id: 'anthropic/claude-3.5-haiku', name: 'Claude 3.5 Haiku' },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
  ];

  function populateOpenRouterOptions(): void {
    if (!cfgOpenrouterTransModel || !cfgOpenrouterSupModel) return;

    cfgOpenrouterTransModel.innerHTML = '';
    cfgOpenrouterSupModel.innerHTML = '';

    RECOMMENDED_MODELS.forEach((m) => {
      const opt1 = document.createElement('option');
      opt1.value = m.id;
      opt1.textContent = `${m.name} (${m.id})`;
      cfgOpenrouterTransModel?.appendChild(opt1);

      const opt2 = document.createElement('option');
      opt2.value = m.id;
      opt2.textContent = `${m.name} (${m.id})`;
      cfgOpenrouterSupModel?.appendChild(opt2);
    });

    if (currentSettings.openrouterTranslationModel) {
      cfgOpenrouterTransModel.value = currentSettings.openrouterTranslationModel;
    }
    if (currentSettings.openrouterSupervisorModel) {
      cfgOpenrouterSupModel.value = currentSettings.openrouterSupervisorModel;
    }
  }

  btnSaveSettings?.addEventListener('click', async () => {
    const updated: ExtensionSettings = {
      ...currentSettings,
      aiProvider: (cfgAiProvider
        ? cfgAiProvider.value
        : currentSettings.aiProvider) as TranslationProvider,
      ollamaHost: cfgOllamaHost ? cfgOllamaHost.value.trim() : currentSettings.ollamaHost,
      translationModel: cfgTranslationModel
        ? cfgTranslationModel.value
        : currentSettings.translationModel,
      supervisorModel: cfgSupervisorModel
        ? cfgSupervisorModel.value
        : currentSettings.supervisorModel,
      openrouterApiKey: cfgOpenrouterKey
        ? cfgOpenrouterKey.value.trim()
        : currentSettings.openrouterApiKey,
      openrouterTranslationModel: cfgOpenrouterTransModel
        ? cfgOpenrouterTransModel.value
        : currentSettings.openrouterTranslationModel,
      openrouterSupervisorModel: cfgOpenrouterSupModel
        ? cfgOpenrouterSupModel.value
        : currentSettings.openrouterSupervisorModel,
      enableSupervisor: cfgEnableSupervisor
        ? cfgEnableSupervisor.checked
        : currentSettings.enableSupervisor,
      targetLanguage: cfgTargetLang
        ? Language.resolve(cfgTargetLang.value)
        : currentSettings.targetLanguage,
      displayMode: (cfgDisplayMode ? cfgDisplayMode.value : currentSettings.displayMode) as
        'bilingual' | 'translated' | 'original',
      preferNativeSubtitles: cfgPreferNativeSubtitles
        ? cfgPreferNativeSubtitles.checked
        : currentSettings.preferNativeSubtitles,
      extractTermsFromNativeSubtitles: cfgExtractNativeTerms
        ? cfgExtractNativeTerms.checked
        : currentSettings.extractTermsFromNativeSubtitles,
      hideNativeSubtitles: cfgHideNative
        ? cfgHideNative.checked
        : currentSettings.hideNativeSubtitles,
      enableDomSubtitleSync: cfgEnableDomSync
        ? cfgEnableDomSync.checked
        : currentSettings.enableDomSubtitleSync,
      vocabExtractorEnabled: cfgVocabEnabled
        ? cfgVocabEnabled.checked
        : currentSettings.vocabExtractorEnabled,
      vocabExtractorProvider: (cfgVocabProvider
        ? cfgVocabProvider.value
        : currentSettings.vocabExtractorProvider) as 'ollama' | 'openrouter',
      vocabExtractorDifficulty: (cfgVocabDifficulty
        ? cfgVocabDifficulty.value
        : currentSettings.vocabExtractorDifficulty) as 'easy' | 'medium' | 'hard',
      vocabSourceLanguage: cfgVocabSourceLang
        ? cfgVocabSourceLang.value === 'auto'
          ? 'auto'
          : Language.resolve(cfgVocabSourceLang.value)
        : currentSettings.vocabSourceLanguage,
      vocabExtractorCustomPrompt: cfgVocabCustomPrompt
        ? cfgVocabCustomPrompt.value.trim()
        : currentSettings.vocabExtractorCustomPrompt,
      uiLanguage: (uiLanguageSelect ? uiLanguageSelect.value : currentSettings.uiLanguage) as
        'en' | 'zh',
    };

    currentSettings = updated;
    await storage.set({ [NCW_CONSTANTS.STORAGE_KEYS.SETTINGS]: updated });
    showToast('Settings saved successfully!');
  });

  uiLanguageSelect?.addEventListener('change', async (e) => {
    const target = e.target as HTMLSelectElement | null;
    if (!target) return;
    const lang = target.value as 'en' | 'zh';
    currentSettings.uiLanguage = lang;
    await storage.set({ [NCW_CONSTANTS.STORAGE_KEYS.SETTINGS]: currentSettings });
  });

  // Initial Data Loads
  loadSubtitleCaches();
  loadVocabBank();
  loadShowContexts();
  loadSettings();
});
