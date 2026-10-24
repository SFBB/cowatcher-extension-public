import { Logger } from '@shared/utils/logger';
import { SubtitleStreamDetector } from './SubtitleStreamDetector';

declare global {
    interface XMLHttpRequest {
        _ncw_url?: string | URL;
    }
}

export type SubtitlePayloadHandler = (url: string, text: string) => void;
export type MetadataPayloadHandler = (url: string, data: any) => void;

export class NetworkHook {
    private static isInstalled = false;
    private static handlers: SubtitlePayloadHandler[] = [];
    private static metadataHandlers: MetadataPayloadHandler[] = [];

    private static logger: Logger = new Logger('NetworkHook');

    static onSubtitlePayload(handler: SubtitlePayloadHandler): () => void {
        this.handlers.push(handler);
        this.ensureInstalled();
        return () => {
            this.handlers = this.handlers.filter((h) => h !== handler);
        };
    }

    static onMetadataPayload(handler: MetadataPayloadHandler): () => void {
        this.metadataHandlers.push(handler);
        this.ensureInstalled();
        return () => {
            this.metadataHandlers = this.metadataHandlers.filter(
                (h) => h !== handler,
            );
        };
    }

    private static notifyMetadataHandlers(url: string, data: any): void {
        for (const handler of this.metadataHandlers) {
            try {
                handler(url, data);
            } catch (e) {
                this.logger.error(
                    'NCW-Injected',
                    'Error in metadata payload handler:',
                    e,
                );
            }
        }
    }

    private static notifyHandlers(url: string, text: string): void {
        for (const handler of this.handlers) {
            try {
                handler(url, text);
            } catch (e) {
                this.logger.error(
                    'NCW-Injected',
                    'Error in subtitle payload handler:',
                    e,
                );
            }
        }
    }

    static ensureInstalled(): void {
        if (this.isInstalled) return;
        this.isInstalled = true;

        this.hookFetch();
        this.hookXHR();
    }

    private static hookFetch(): void {
        const originalFetch = window.fetch;
        const notify = this.notifyHandlers.bind(this);

        window.fetch = async function (
            input: RequestInfo | URL,
            init?: RequestInit,
        ): Promise<Response> {
            const response = await originalFetch.call(this, input, init);
            try {
                let url = '';
                if (typeof input === 'string') {
                    url = input;
                } else if (input instanceof URL) {
                    url = input.href;
                } else if (
                    input &&
                    typeof input === 'object' &&
                    'url' in input
                ) {
                    url = (input as Request).url;
                } else {
                    url = response.url || '';
                }

                const contentLength = parseInt(
                    response.headers.get('content-length') || '0',
                    10,
                );
                // Skip media streams larger than 3MB
                if (contentLength > 3 * 1024 * 1024) {
                    return response;
                }

                const contentType = (
                    response.headers.get('content-type') || ''
                ).toLowerCase();
                const u = url.toLowerCase();

                const isMetadataCandidate =
                    u.includes('/memberapi/release/metadata') ||
                    u.includes('/metadata?');

                if (isMetadataCandidate) {
                    const clone = response.clone();
                    clone
                        .json()
                        .then((data) => {
                            if (data && data.video) {
                                NetworkHook.notifyMetadataHandlers(url, data);
                            }
                        })
                        .catch(() => {});
                }

                const isCandidate =
                    u.includes('timedtext') ||
                    u.includes('ttml') ||
                    u.includes('dfxp') ||
                    u.includes('.xml') ||
                    u.includes('.vtt') ||
                    u.includes('/?o=') ||
                    u.includes('/range/') ||
                    u.includes('subtitles') ||
                    u.includes('nflxvideo.net') ||
                    contentType.includes('xml') ||
                    contentType.includes('vtt') ||
                    contentType.includes('text') ||
                    contentType.includes('octet-stream');

                if (isCandidate) {
                    const clone = response.clone();
                    clone
                        .text()
                        .then((text) => {
                            if (
                                (u.includes('timedtext') &&
                                    text &&
                                    text.trim().length > 0) ||
                                SubtitleStreamDetector.isSubtitleContent(text)
                            ) {
                                notify(url, text);
                            }
                        })
                        .catch(() => {});
                }
            } catch {
                // Safe boundary: never break web page playback
            }
            return response;
        };
    }

    private static hookXHR(): void {
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        const notify = this.notifyHandlers.bind(this);

        XMLHttpRequest.prototype.open = function (
            this: XMLHttpRequest,
            ...args: any[]
        ) {
            this._ncw_url = args[1];
            return (origOpen as any).apply(this, args);
        };

        XMLHttpRequest.prototype.send = function (
            this: XMLHttpRequest,
            ...args: any[]
        ) {
            this.addEventListener(
                'load',
                () => {
                    try {
                        const rawUrl = this._ncw_url;
                        const url =
                            (typeof rawUrl === 'string'
                                ? rawUrl
                                : rawUrl instanceof URL
                                  ? rawUrl.href
                                  : '') ||
                            this.responseURL ||
                            '';
                        const responseType = this.responseType;
                        const u = url.toLowerCase();

                        if (
                            u.includes('/memberapi/release/metadata') ||
                            u.includes('/metadata?')
                        ) {
                            try {
                                let data = this.response;
                                if (typeof data === 'string') {
                                    data = JSON.parse(data);
                                }
                                if (data && data.video) {
                                    NetworkHook.notifyMetadataHandlers(
                                        url,
                                        data,
                                    );
                                }
                            } catch {}
                        }

                        if (responseType === '' || responseType === 'text') {
                            const text = this.responseText;
                            if (
                                (u.includes('timedtext') &&
                                    text &&
                                    text.trim().length > 0) ||
                                SubtitleStreamDetector.isSubtitleContent(text)
                            ) {
                                notify(url, text);
                            }
                        } else if (responseType === 'json' && this.response) {
                            const text =
                                typeof this.response === 'string'
                                    ? this.response
                                    : JSON.stringify(this.response);
                            if (
                                (u.includes('timedtext') &&
                                    text &&
                                    text.trim().length > 0) ||
                                SubtitleStreamDetector.isSubtitleContent(text)
                            ) {
                                notify(url, text);
                            }
                        } else if (
                            responseType === 'arraybuffer' &&
                            this.response instanceof ArrayBuffer
                        ) {
                            if (this.response.byteLength < 3 * 1024 * 1024) {
                                if (
                                    SubtitleStreamDetector.looksLikeSubtitleBuffer(
                                        this.response,
                                    )
                                ) {
                                    const text = new TextDecoder(
                                        'utf-8',
                                    ).decode(this.response);
                                    if (
                                        SubtitleStreamDetector.isSubtitleContent(
                                            text,
                                        )
                                    ) {
                                        notify(url, text);
                                    }
                                }
                            }
                        } else if (
                            responseType === 'blob' &&
                            this.response instanceof Blob
                        ) {
                            if (this.response.size < 3 * 1024 * 1024) {
                                const reader = new FileReader();
                                reader.onload = function () {
                                    const text = reader.result;
                                    if (
                                        typeof text === 'string' &&
                                        SubtitleStreamDetector.isSubtitleContent(
                                            text,
                                        )
                                    ) {
                                        notify(url, text);
                                    }
                                };
                                reader.readAsText(this.response, 'utf-8');
                            }
                        }
                    } catch {
                        // Safe boundary
                    }
                },
                { passive: true },
            );
            return (origSend as any).apply(this, args);
        };
    }
}
