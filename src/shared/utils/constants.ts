/**
 * Compatibility re-export module for legacy constants.
 * Strongly-typed modular constants are partitioned under:
 * - @shared/domain/constants/SettingsDefaults
 * - @shared/domain/constants/MessageTypes
 * - @shared/domain/constants/StorageKeys
 */

import {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  getPipelineConfig,
  ExtensionSettings,
  PipelineConfig,
} from '../domain/constants/SettingsDefaults';
import { NCW_STORAGE_KEYS } from '../domain/constants/StorageKeys';
import { NCW_MESSAGE_TYPES } from '../domain/constants/MessageTypes';

export { ExtensionSettings, PipelineConfig };

export const NCW_CONSTANTS = {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  getPipelineConfig,
  STORAGE_KEYS: NCW_STORAGE_KEYS,
  MESSAGE_TYPES: NCW_MESSAGE_TYPES,
};

export default NCW_CONSTANTS;
