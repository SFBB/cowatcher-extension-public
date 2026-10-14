import { AiSubState } from '@shared/domain/entities/AiSubState';
import { ContentBackgroundBus } from '@shared/infrastructure/bus/ContentBackgroundBus';
import { IBrowserStorage } from '@shared/infrastructure/storage/IBrowserStorage';
import { BrowserStorageFactory } from '@shared/infrastructure/storage/BrowserStorageFactory';
import { ExtensionSettings } from '@shared/domain/constants/SettingsDefaults';
import { NCW_STORAGE_KEYS } from '@shared/domain/constants/StorageKeys';
import { StreamingPlatformId } from '@shared/domain/constants/StreamingPlatforms';

import { Language, LanguageInfo } from '@shared/domain/value-objects/Language';
import NCW_CONSTANTS from '@shared/utils/constants';

export class AiSubStateService {
  private static instance: AiSubStateService | null = null;
  private state: AiSubState;
  private storage: IBrowserStorage;

  private constructor(storage: IBrowserStorage = BrowserStorageFactory.getStorage()) {
    this.storage = storage;
    this.state = AiSubState.defaultState();
  }

  static getInstance(storage?: IBrowserStorage): AiSubStateService {
    if (!AiSubStateService.instance) {
      AiSubStateService.instance = new AiSubStateService(storage);
    }
    return AiSubStateService.instance;
  }

  async initialize(): Promise<void> {
    try {
      const res = await this.storage.get<Partial<ExtensionSettings>>([NCW_STORAGE_KEYS.SETTINGS]);
      const settings = (res[NCW_STORAGE_KEYS.SETTINGS] || {}) as Partial<ExtensionSettings>;
      this.state = new AiSubState({
        enabled: settings.enabled !== false,
        platformEnabled: settings.platformEnabled,
        targetLanguage: Language.resolve(settings.targetLanguage || 'English'),
        displayMode: settings.displayMode || 'bilingual',
        isOverlayVisible: true,
        updatedAt: Date.now(),
      });
    } catch (_e) {
      this.state = AiSubState.defaultState();
    }
  }

  getState(): AiSubState {
    return this.state;
  }

  async setEnabled(enabled: boolean, platform?: StreamingPlatformId): Promise<AiSubState> {
    this.state = this.state.withEnabled(enabled, platform);

    // Persist via abstracted storage repository
    try {
      const res = await this.storage.get<Partial<ExtensionSettings>>([NCW_STORAGE_KEYS.SETTINGS]);
      const current = (res[NCW_STORAGE_KEYS.SETTINGS] || {}) as Partial<ExtensionSettings>;
      const updatedPlatformEnabled = {
        ...(current.platformEnabled || {}),
        ...(platform ? { [platform]: enabled } : this.state.platformEnabled),
      };
      await this.storage.set({
        [NCW_STORAGE_KEYS.SETTINGS]: {
          ...current,
          enabled: platform ? (current.enabled ?? true) : enabled,
          platformEnabled: updatedPlatformEnabled,
        },
      });
    } catch (_e) {
      // Ignore
    }

    // Push notification to all content scripts & UIs
    this.broadcastState();
    return this.state;
  }

  async setTargetLanguage(language: LanguageInfo): Promise<AiSubState> {
    this.state = this.state.withTargetLanguage(language);
    try {
      const res = await this.storage.get<Partial<ExtensionSettings>>([NCW_STORAGE_KEYS.SETTINGS]);
      const current = (res[NCW_STORAGE_KEYS.SETTINGS] || {}) as Partial<ExtensionSettings>;
      await this.storage.set({
        [NCW_STORAGE_KEYS.SETTINGS]: { ...current, targetLanguage: language },
      });
    } catch (_e) {
      // Ignore
    }
    this.broadcastState();
    return this.state;
  }

  private broadcastState(): void {
    ContentBackgroundBus.broadcastToTabs(NCW_CONSTANTS.MESSAGE_TYPES.PUSH_AI_SUB_STATE_CHANGED, {
      state: this.state,
    }).catch(() => {});
  }
}
