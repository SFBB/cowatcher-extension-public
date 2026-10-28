import {
    LearningCueItem,
    SubtitlePhraseSelection,
    SubtitleToken,
} from '@shared/domain/entities/SubtitleLearning';

export interface ISubtitleSelectionListener {
    onSelectionStart(button: 0 | 2): void;
    onSelectionCommit(selection: SubtitlePhraseSelection): void;
    onSelectionCancel(button: 0 | 2): void;
}

/**
 * Controller managing multi-word interactive drag and click selection
 * across subtitle tokens within a cue line.
 */
export class SubtitleSelectionController {
    private listener: ISubtitleSelectionListener | null = null;
    private readonly cueMap = new WeakMap<HTMLElement, LearningCueItem>();

    private isSelecting: boolean = false;
    private activeButton: (0 | 2) | null = null;
    private activeCue: LearningCueItem | null = null;
    private activeOrigEl: HTMLElement | null = null;
    private startToken: SubtitleToken | null = null;
    private startSpan: HTMLElement | null = null;
    private currentEndToken: SubtitleToken | null = null;

    private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
    private mouseUpHandler: ((e: MouseEvent) => void) | null = null;
    private contextMenuHandler: ((e: MouseEvent) => void) | null = null;
    private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

    setListener(listener: ISubtitleSelectionListener): void {
        this.listener = listener;
    }

    /**
     * Attach interactive selection listeners to the original subtitle line element.
     */
    attach(origEl: HTMLElement, cue: LearningCueItem): void {
        this.cueMap.set(origEl, cue);

        if (origEl.dataset.hasSelectionController === 'true') {
            return;
        }
        origEl.dataset.hasSelectionController = 'true';

        origEl.addEventListener('mousedown', (e: MouseEvent) => {
            this.handleMouseDown(e, origEl);
        });

        origEl.addEventListener('contextmenu', (e: MouseEvent) => {
            const tokenSpan = (e.target as HTMLElement)?.closest('.ncw-token');
            if (tokenSpan) {
                e.preventDefault();
                e.stopPropagation();
            }
        });
    }

    private handleMouseDown(e: MouseEvent, origEl: HTMLElement): void {
        const tokenSpan = (e.target as HTMLElement)?.closest(
            '.ncw-token',
        ) as HTMLElement | null;
        if (!tokenSpan || !origEl.contains(tokenSpan)) {
            return;
        }

        // Only left button (0) and right button (2) are handled
        if (e.button !== 0 && e.button !== 2) {
            return;
        }

        const cue = this.cueMap.get(origEl);
        if (!cue) return;

        const tokenId = tokenSpan.dataset.tokenId;
        const token = cue.tokens.find((t) => t.id === tokenId);
        if (!token || !token.isWordLike) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        this.isSelecting = true;
        this.activeButton = e.button as 0 | 2;
        this.activeCue = cue;
        this.activeOrigEl = origEl;
        this.startToken = token;
        this.startSpan = tokenSpan;
        this.currentEndToken = token;

        // Apply initial highlight
        this.updateRangeHighlights();

        // Notify listener immediately to pause playback with 0ms latency
        this.listener?.onSelectionStart(this.activeButton);

        this.bindWindowEvents();
    }

    private bindWindowEvents(): void {
        this.unbindWindowEvents();

        this.mouseMoveHandler = (e: MouseEvent) => {
            this.handleMouseMove(e);
        };
        window.addEventListener('mousemove', this.mouseMoveHandler, {
            passive: false,
        });

        this.mouseUpHandler = (e: MouseEvent) => {
            this.handleMouseUp(e);
        };
        window.addEventListener('mouseup', this.mouseUpHandler);

        this.contextMenuHandler = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
        };
        window.addEventListener('contextmenu', this.contextMenuHandler, true);

        this.keydownHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                this.cancelSelection();
            }
        };
        window.addEventListener('keydown', this.keydownHandler);
    }

    private unbindWindowEvents(): void {
        if (this.mouseMoveHandler) {
            window.removeEventListener('mousemove', this.mouseMoveHandler);
            this.mouseMoveHandler = null;
        }
        if (this.mouseUpHandler) {
            window.removeEventListener('mouseup', this.mouseUpHandler);
            this.mouseUpHandler = null;
        }
        if (this.contextMenuHandler) {
            // Keep blocking context menu briefly after mouseup to prevent native menu flash
            const handler = this.contextMenuHandler;
            setTimeout(() => {
                window.removeEventListener('contextmenu', handler, true);
            }, 100);
            this.contextMenuHandler = null;
        }
        if (this.keydownHandler) {
            window.removeEventListener('keydown', this.keydownHandler);
            this.keydownHandler = null;
        }
    }

    private handleMouseMove(e: MouseEvent): void {
        if (!this.isSelecting || !this.activeOrigEl || !this.activeCue) {
            return;
        }

        const element = document.elementFromPoint(
            e.clientX,
            e.clientY,
        ) as HTMLElement | null;
        const hoverSpan = element?.closest('.ncw-token') as HTMLElement | null;

        if (hoverSpan && this.activeOrigEl.contains(hoverSpan)) {
            const tokenId = hoverSpan.dataset.tokenId;
            const hoverToken = this.activeCue.tokens.find((t) => t.id === tokenId);
            if (
                hoverToken &&
                hoverToken.isWordLike &&
                hoverToken !== this.currentEndToken
            ) {
                this.currentEndToken = hoverToken;
                this.updateRangeHighlights();
            }
        }
    }

    private updateRangeHighlights(): void {
        if (
            !this.activeOrigEl ||
            !this.activeCue ||
            !this.startToken ||
            !this.currentEndToken
        ) {
            return;
        }

        const startIdx = this.activeCue.tokens.findIndex(
            (t) => t.id === this.startToken!.id,
        );
        const endIdx = this.activeCue.tokens.findIndex(
            (t) => t.id === this.currentEndToken!.id,
        );
        if (startIdx === -1 || endIdx === -1) return;

        const minIdx = Math.min(startIdx, endIdx);
        const maxIdx = Math.max(startIdx, endIdx);

        const spans =
            this.activeOrigEl.querySelectorAll<HTMLElement>('.ncw-token');
        spans.forEach((span) => {
            const tid = span.dataset.tokenId;
            const idx = this.activeCue!.tokens.findIndex((t) => t.id === tid);
            if (idx >= minIdx && idx <= maxIdx) {
                span.classList.add('is-selecting');
            } else {
                span.classList.remove('is-selecting');
            }
        });
    }

    private clearHighlights(): void {
        if (this.activeOrigEl) {
            const spans =
                this.activeOrigEl.querySelectorAll<HTMLElement>('.ncw-token');
            spans.forEach((span) => span.classList.remove('is-selecting'));
        }
    }

    private handleMouseUp(e: MouseEvent): void {
        if (!this.isSelecting || this.activeButton === null) {
            return;
        }
        if (e.button !== this.activeButton) {
            return;
        }

        const button = this.activeButton;
        const cue = this.activeCue;
        const startToken = this.startToken;
        const endToken = this.currentEndToken;
        const startSpan = this.startSpan;
        const origEl = this.activeOrigEl;

        this.unbindWindowEvents();
        this.clearHighlights();
        this.isSelecting = false;
        this.activeButton = null;
        this.activeCue = null;
        this.activeOrigEl = null;
        this.startToken = null;
        this.startSpan = null;
        this.currentEndToken = null;

        if (!cue || !startToken || !endToken || !startSpan || !origEl) {
            this.listener?.onSelectionCancel(button);
            return;
        }

        // 1. Compute exact character offsets on original full subtitle line
        const startOffset = Math.min(startToken.index, endToken.index);
        const endOffset = Math.max(
            startToken.index + startToken.text.length,
            endToken.index + endToken.text.length,
        );

        // 2. Extract slice preserving natural spacing, punctuation, and hyphenation
        const selectedText = cue.originalText
            .slice(startOffset, endOffset)
            .trim();

        if (!selectedText) {
            this.listener?.onSelectionCancel(button);
            return;
        }

        // 3. Collect all word tokens and elements within range
        const startIdx = cue.tokens.findIndex((t) => t.id === startToken.id);
        const endIdx = cue.tokens.findIndex((t) => t.id === endToken.id);
        const minIdx = Math.min(startIdx, endIdx);
        const maxIdx = Math.max(startIdx, endIdx);

        const inRangeTokens = cue.tokens
            .slice(minIdx, maxIdx + 1)
            .filter((t) => t.isWordLike);

        const tokenElements: HTMLElement[] = [];
        inRangeTokens.forEach((t) => {
            const span = origEl.querySelector<HTMLElement>(
                `[data-token-id="${t.id}"]`,
            );
            if (span) tokenElements.push(span);
        });

        const selection: SubtitlePhraseSelection = {
            cueId: cue.cueId,
            startToken,
            endToken,
            tokens: inRangeTokens,
            selectedText,
            originalText: cue.originalText,
            translatedText: cue.translatedText,
            button,
            anchorEl: startSpan,
            tokenElements,
        };

        this.listener?.onSelectionCommit(selection);
    }

    cancelSelection(): void {
        if (!this.isSelecting) return;
        const button = this.activeButton ?? 0;
        this.unbindWindowEvents();
        this.clearHighlights();
        this.isSelecting = false;
        this.activeButton = null;
        this.activeCue = null;
        this.activeOrigEl = null;
        this.startToken = null;
        this.startSpan = null;
        this.currentEndToken = null;

        this.listener?.onSelectionCancel(button);
    }

    destroy(): void {
        this.cancelSelection();
    }
}
