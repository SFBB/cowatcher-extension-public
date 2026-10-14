/**
 * CoWatcher - Background Service Worker Entry
 * Coordinates domain services and registers message dispatchers without direct chrome platform coupling.
 */

import { AiSubStateService } from './application/services/AiSubStateService';
import { GlossaryService } from './application/services/GlossaryService';
import { BackgroundMessageService } from './presentation/BackgroundMessageService';
import { BrowserPlatformFactory } from '@shared/infrastructure/platform/BrowserPlatformFactory';
import { BrowserStorageFactory } from '@shared/infrastructure/storage/BrowserStorageFactory';
import { ContentBackgroundBus } from '@shared/infrastructure/bus/ContentBackgroundBus';
import { Logger } from '@shared/utils/logger';
import NCW_CONSTANTS from '@shared/utils/constants';

const logger: Logger = new Logger('background');

const platform = BrowserPlatformFactory.getPlatform();
const storage = BrowserStorageFactory.getStorage();

// 1. Initialize Authoritative Domain Services
AiSubStateService.getInstance(storage)
  .initialize()
  .catch((err) => {
    logger.warn('Subtitle', 'Failed to initialize AiSubStateService:', err);
  });

GlossaryService.getInstance(storage)
  .initialize()
  .catch((err) => {
    logger.warn('Glossary', 'Failed to initialize GlossaryService:', err);
  });

// 2. Register Central Message Dispatcher
BackgroundMessageService.getInstance(storage).registerHandlers();

// 3. Configure declarativeNetRequest Rules via Platform Adapter
platform.onInstalled(() => {
  platform.setupOllamaRules();
});
platform.onStartup(() => {
  platform.setupOllamaRules();
});
platform.setupOllamaRules();

ContentBackgroundBus.onMessage(NCW_CONSTANTS.MESSAGE_TYPES.PUSH_SETTINGS_CHANGED, (payload) => {
  if (payload && payload.settings && payload.settings.ollamaHost) {
    platform.setupOllamaRules(payload.settings.ollamaHost);
  }
});
