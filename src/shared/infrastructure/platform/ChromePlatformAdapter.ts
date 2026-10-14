import { Logger } from '@shared/utils/logger';
import {
  IBrowserPlatform,
  ActiveTabInfo,
  PopupWindowOptions,
  PlatformMessageSender,
  PlatformMessageListener,
} from './IBrowserPlatform';

/**
 * Chrome Platform Implementation of IBrowserPlatform.
 */
export class ChromePlatformAdapter implements IBrowserPlatform {
  private static instance: ChromePlatformAdapter | null = null;

  private logger: Logger = new Logger('ChromePlatformAdapter');

  static getInstance(): ChromePlatformAdapter {
    if (!ChromePlatformAdapter.instance) {
      ChromePlatformAdapter.instance = new ChromePlatformAdapter();
    }
    return ChromePlatformAdapter.instance;
  }

  async getActiveTab(): Promise<ActiveTabInfo | null> {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) {
        resolve(null);
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        this.logger.info(
          'Platform',
          `get tab id: ${tab.id}, tab title: ${tab.title}, tab url: ${tab.url}`
        );
        if (tab) {
          resolve({
            id: tab.id,
            url: tab.url,
            title: tab.title,
          });
        } else {
          resolve(null);
        }
      });
    });
  }

  openOptionsPage(): void {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open('../options/options.html', '_blank');
    }
  }

  createTab(url: string): void {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url });
    } else {
      window.open(url, '_blank');
    }
  }

  async openPopupWindow(options: PopupWindowOptions): Promise<number | undefined> {
    const width = options.width || 760;
    const height = options.height || 800;

    if (typeof chrome !== 'undefined' && chrome.windows?.create) {
      // Calculate centered position if screen info available
      let left: number | undefined;
      let top: number | undefined;
      try {
        if (typeof window !== 'undefined' && window.screen) {
          left = Math.round((window.screen.availWidth - width) / 2);
          top = Math.round((window.screen.availHeight - height) / 2);
        }
      } catch {
        // Fallback to default
      }

      const win = await chrome.windows.create({
        url: options.url,
        type: 'popup',
        width,
        height,
        left,
        top,
        focused: true,
      });
      return win?.id;
    } else {
      window.open(
        options.url,
        options.title || 'PopupWindow',
        `width=${width},height=${height},menubar=no,toolbar=no,location=no,status=no`
      );
      return undefined;
    }
  }

  async setupOllamaRules(customHost?: string): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest) return;
    try {
      const rules: chrome.declarativeNetRequest.Rule[] = [
        {
          id: 101,
          priority: 10,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            requestHeaders: [
              { header: 'Origin', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE },
            ],
          },
          condition: {
            urlFilter: ':11434/',
            resourceTypes: [
              chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
              chrome.declarativeNetRequest.ResourceType.OTHER,
            ],
          },
        },
        {
          id: 102,
          priority: 10,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            requestHeaders: [
              { header: 'Origin', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE },
            ],
          },
          condition: {
            urlFilter: '||localhost/',
            resourceTypes: [
              chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
              chrome.declarativeNetRequest.ResourceType.OTHER,
            ],
          },
        },
        {
          id: 103,
          priority: 10,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            requestHeaders: [
              { header: 'Origin', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE },
            ],
          },
          condition: {
            urlFilter: '||127.0.0.1/',
            resourceTypes: [
              chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
              chrome.declarativeNetRequest.ResourceType.OTHER,
            ],
          },
        },
      ];

      if (customHost) {
        try {
          const u = new URL(customHost);
          rules.push({
            id: 104,
            priority: 10,
            action: {
              type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
              requestHeaders: [
                {
                  header: 'Origin',
                  operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
                },
              ],
            },
            condition: {
              urlFilter: `||${u.host}/`,
              resourceTypes: [
                chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
                chrome.declarativeNetRequest.ResourceType.OTHER,
              ],
            },
          });
        } catch {
          // Ignore invalid URL
        }
      }

      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [101, 102, 103, 104],
        addRules: rules,
      });
    } catch {
      // Ignore rules failure
    }
  }

  onInstalled(callback: () => void): void {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onInstalled) {
      chrome.runtime.onInstalled.addListener(callback);
    }
  }

  onStartup(callback: () => void): void {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onStartup) {
      chrome.runtime.onStartup.addListener(callback);
    }
  }

  isContextValid(): boolean {
    return Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
  }

  async sendMessage<T = any>(message: any): Promise<T> {
    return new Promise((resolve) => {
      try {
        if (!this.isContextValid()) {
          resolve({
            success: false,
            error: 'Extension context invalidated',
          } as T);
          return;
        }

        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              success: false,
              error: chrome.runtime.lastError.message,
            } as T);
            return;
          }
          resolve(response as T);
        });
      } catch (err) {
        resolve({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        } as T);
      }
    });
  }

  async broadcastToTabs(message: any): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) return;
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, message).catch(() => {});
        }
      }
    } catch (_e) {
      // Ignore
    }
  }

  onMessage(listener: PlatformMessageListener): () => void {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) {
      return () => {};
    }

    const chromeListener = (
      message: any,
      sender: chrome.runtime.MessageSender,
      sendResponse: (res?: any) => void
    ) => {
      const platformSender: PlatformMessageSender = {
        id: sender.id,
        url: sender.url,
        tab: sender.tab
          ? {
              id: sender.tab.id,
              url: sender.tab.url,
              title: sender.tab.title,
            }
          : undefined,
      };
      return listener(message, platformSender, sendResponse);
    };

    chrome.runtime.onMessage.addListener(chromeListener);
    return () => chrome.runtime.onMessage.removeListener(chromeListener);
  }

  onTabRemoved(callback: (tabId: number) => void): () => void {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.onRemoved) {
      return () => {};
    }

    chrome.tabs.onRemoved.addListener(callback);
    return () => chrome.tabs.onRemoved.removeListener(callback);
  }
}

