export interface ActiveTabInfo {
  id?: number;
  url?: string;
  title?: string;
}

export interface PopupWindowOptions {
  url: string;
  width?: number;
  height?: number;
  title?: string;
}

export interface PlatformMessageSender {
  id?: string;
  url?: string;
  tab?: ActiveTabInfo;
}

export type PlatformMessageListener = (
  message: any,
  sender: PlatformMessageSender,
  sendResponse: (res?: any) => void
) => boolean | void;

/**
 * Generic Browser Platform API Abstraction.
 * Decouples platform actions (tabs, window navigation, declarative header rules, runtime messaging).
 */
export interface IBrowserPlatform {
  getActiveTab(): Promise<ActiveTabInfo | null>;
  openOptionsPage(): void;
  createTab(url: string): void;
  openPopupWindow(options: PopupWindowOptions): Promise<number | undefined>;
  setupOllamaRules(customHost?: string): Promise<void>;
  onInstalled(callback: () => void): void;
  onStartup(callback: () => void): void;
  isContextValid(): boolean;

  // --- Runtime Messaging & Tabs Lifecycle ---
  sendMessage<T = any>(message: any): Promise<T>;
  broadcastToTabs(message: any): Promise<void>;
  onMessage(listener: PlatformMessageListener): () => void;
  onTabRemoved(callback: (tabId: number) => void): () => void;
}

