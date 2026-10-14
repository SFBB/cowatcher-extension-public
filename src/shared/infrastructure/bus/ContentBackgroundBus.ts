import { MessagePayloadMap, MessageType } from '../../types/Messages';
import { BrowserPlatformFactory } from '../platform/BrowserPlatformFactory';
import { PlatformMessageSender } from '../platform/IBrowserPlatform';

export type BusMessage<K extends MessageType = MessageType> = {
  [T in K]: MessagePayloadMap[T]['request'] extends void
    ? { type: T }
    : { type: T } & MessagePayloadMap[T]['request'];
}[K];

export type BusSender = PlatformMessageSender;

export type BusResponseCallback<T extends MessageType> = (
  response: MessagePayloadMap[T]['response']
) => void;

export type BusDispatcher = (
  message: BusMessage,
  sender: BusSender,
  sendResponse: (res: any) => void
) => boolean | void;

export class ContentBackgroundBus {
  /**
   * Send a strongly-typed message to the background service worker and receive typed response.
   */
  static async send<T extends MessageType>(
    type: T,
    payload: MessagePayloadMap[T]['request']
  ): Promise<MessagePayloadMap[T]['response']> {
    const platform = BrowserPlatformFactory.getPlatform();
    const messageData =
      typeof payload === 'object' && payload !== null ? { type, ...payload } : { type };
    return platform.sendMessage<MessagePayloadMap[T]['response']>(messageData);
  }

  /**
   * Broadcast message from background to all tabs (or content scripts).
   */
  static async broadcastToTabs<T extends MessageType>(
    type: T,
    payload: MessagePayloadMap[T]['request']
  ): Promise<void> {
    const platform = BrowserPlatformFactory.getPlatform();
    const messageData =
      typeof payload === 'object' && payload !== null ? { type, ...payload } : { type };
    await platform.broadcastToTabs(messageData);
  }

  /**
   * Subscribe to specific message types received via runtime bus.
   */
  static onMessage<T extends MessageType>(
    targetType: T,
    handler: (
      payload: MessagePayloadMap[T]['request'],
      sender: BusSender
    ) => Promise<MessagePayloadMap[T]['response']> | MessagePayloadMap[T]['response'] | void
  ): () => void {
    const platform = BrowserPlatformFactory.getPlatform();
    return platform.onMessage((message, sender, sendResponse) => {
      if (!message || message.type !== targetType) return false;

      const result = handler(message, sender);
      if (result instanceof Promise) {
        result.then((res) => {
          if (res !== undefined) sendResponse(res);
        });
        return true; // asynchronous sendResponse
      } else if (result !== undefined) {
        sendResponse(result);
        return false;
      }
      return false;
    });
  }

  /**
   * Central dispatcher registration for background listener.
   * Completely encapsulates runtime message listener via IBrowserPlatform.
   */
  static registerDispatcher(dispatcher: BusDispatcher): () => void {
    const platform = BrowserPlatformFactory.getPlatform();
    return platform.onMessage((message, sender, sendResponse) => {
      if (!message || typeof message.type !== 'string') return false;
      return dispatcher(message as BusMessage, sender, sendResponse);
    });
  }
}

