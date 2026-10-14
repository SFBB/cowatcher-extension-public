import { ExtensionSettings } from '@shared/utils/constants';

export interface OverlayCueItem {
  id: number | string;
  originalText: string;
  translatedText: string | null;
  position?: 'bottom' | 'top' | 'left-vertical' | 'right-vertical' | string;
}

export class SubtitleOverlay {
  container: HTMLElement | null = null;
  slots: {
    bottom: HTMLElement | null;
    top: HTMLElement | null;
    rightVertical: HTMLElement | null;
    leftVertical: HTMLElement | null;
  } = {
    bottom: null,
    top: null,
    rightVertical: null,
    leftVertical: null,
  };
  translatedEl: HTMLElement | null = null;
  originalEl: HTMLElement | null = null;
  wrapper: HTMLElement | null = null;
  currentText: { original: string; translated: string | null } = { original: '', translated: '' };
  isVisible: boolean = false;
  settings: Partial<ExtensionSettings> = {};

  init(settings: Partial<ExtensionSettings> = {}): void {
    this.settings = settings;
    this.ensureInDOM();
  }

  updateSettings(settings: Partial<ExtensionSettings>): void {
    const oldSwap = Boolean(this.settings.swapSubtitleOrder);
    this.settings = { ...this.settings, ...settings };
    this.applyStyles();
    if (this.settings.enabled === false) {
      this.hide(true);
    } else if (settings.swapSubtitleOrder !== undefined && settings.swapSubtitleOrder !== oldSwap) {
      this.reorderVisibleWrappers();
    }
  }

  private reorderVisibleWrappers(): void {
    if (!this.slots) return;
    const swap = Boolean(this.settings.swapSubtitleOrder);
    Object.values(this.slots).forEach((slotEl) => {
      if (!slotEl) return;
      const wrappers = slotEl.querySelectorAll('.ncw-subtitle-wrapper');
      wrappers.forEach((wrapper) => {
        const transEl = wrapper.querySelector('.ncw-translated-text');
        const origEl = wrapper.querySelector('.ncw-original-text');
        if (transEl && origEl) {
          const firstChild = wrapper.firstElementChild;
          if (swap && firstChild !== origEl) {
            wrapper.insertBefore(origEl, transEl);
          } else if (!swap && firstChild !== transEl) {
            wrapper.insertBefore(transEl, origEl);
          }
        }
      });
    });
  }

  ensureInDOM(): void {
    if (this.container && document.body && document.body.contains(this.container)) {
      return;
    }

    if (typeof document === 'undefined') return;

    const existing = document.getElementById('ncw-subtitle-container');
    if (existing) existing.remove();

    this.container = document.createElement('div');
    this.container.id = 'ncw-subtitle-container';
    this.container.className = 'ncw-subtitle-master-container';

    const slotConfigs = [
      { key: 'bottom' as const, className: 'ncw-slot ncw-slot-bottom' },
      { key: 'top' as const, className: 'ncw-slot ncw-slot-top' },
      { key: 'rightVertical' as const, className: 'ncw-slot ncw-slot-right-vertical' },
      { key: 'leftVertical' as const, className: 'ncw-slot ncw-slot-left-vertical' },
    ];

    slotConfigs.forEach(({ key, className }) => {
      const slotEl = document.createElement('div');
      slotEl.className = className;
      slotEl.style.visibility = 'hidden';
      slotEl.style.opacity = '0';
      if (this.container) {
        this.container.appendChild(slotEl);
      }
      this.slots[key] = slotEl;
    });

    this.applyStyles();
  }

  mountToPlayer(): void {
    if (!this.container || !document.body || !document.body.contains(this.container)) {
      this.ensureInDOM();
    }

    if (typeof document === 'undefined') return;

    const candidates = [
      document.querySelector('.watch-video--player-view'),
      document.querySelector('[data-uia="watch-video"]'),
      document.querySelector('.NFPlayer'),
      document.querySelector('video')?.parentElement,
      document.body,
    ];

    const target = candidates.find((el) => el !== null && el !== undefined);
    if (target && this.container && this.container.parentElement !== target) {
      target.appendChild(this.container);
    }
  }

  applyStyles(): void {
    if (!this.container) return;

    const fontSize = this.settings.fontSize || 26;
    const offsetBottom = this.settings.subOffsetBottom || 80;
    const bgOpacity = this.settings.bgOpacity !== undefined ? this.settings.bgOpacity : 0.0;

    const showOriginalSmaller = this.settings.showOriginalSmaller !== false;
    const origRatio = showOriginalSmaller ? 0.75 : 1.0;

    const enableAnimation = Boolean(this.settings.enableAnimation);
    const enableGlass = Boolean(this.settings.enableGlassEffect);
    const swap = Boolean(this.settings.swapSubtitleOrder);

    this.container.classList.toggle('ncw-enable-anim', enableAnimation);
    this.container.classList.toggle('ncw-glass-effect', enableGlass);
    this.container.classList.toggle('ncw-swapped-subs', swap);

    if (this.container.style) {
      this.container.style.setProperty('--ncw-font-size', `${fontSize}px`);
      this.container.style.setProperty(
        '--ncw-font-size-orig',
        `${Math.round(fontSize * origRatio)}px`
      );
      this.container.style.setProperty('--ncw-bg-opacity', String(bgOpacity));
      this.container.style.setProperty('--ncw-bottom-offset', `${offsetBottom}px`);
    }

    if (this.slots && this.slots.bottom && this.slots.bottom.style) {
      this.slots.bottom.style.bottom = `${offsetBottom}px`;
    }
  }

  showCues(cues: OverlayCueItem[] = []): void {
    if (this.settings.enabled === false) {
      this.hide(true);
      return;
    }

    if (!cues || cues.length === 0) {
      this.hide();
      return;
    }

    this.ensureInDOM();
    this.mountToPlayer();

    const slotMap: Record<string, OverlayCueItem[]> = {
      bottom: [],
      top: [],
      rightVertical: [],
      leftVertical: [],
    };

    cues.forEach((c) => {
      const pos = c.position || 'bottom';
      if (pos === 'top') {
        slotMap.top.push(c);
      } else if (pos === 'right-vertical' || pos === 'vertical' || pos === 'vertical-rl') {
        slotMap.rightVertical.push(c);
      } else if (pos === 'left-vertical' || pos === 'vertical-lr') {
        slotMap.leftVertical.push(c);
      } else {
        slotMap.bottom.push(c);
      }
    });

    const mode = this.settings.displayMode || 'bilingual';
    let anyVisible = false;

    if (this.slots) {
      for (const [slotKey, slotCues] of Object.entries(slotMap)) {
        const slotEl = (this.slots as Record<string, HTMLElement | null>)[slotKey];
        if (!slotEl) continue;

        if (slotCues.length === 0) {
          slotEl.style.opacity = '0';
          slotEl.style.visibility = 'hidden';
          slotEl.innerHTML = '';
        } else {
          anyVisible = true;
          this.reconcileSlotCues(slotEl, slotCues, mode);
          slotEl.style.visibility = 'visible';
          slotEl.style.opacity = '1';
        }
      }
    }

    this.isVisible = anyVisible;
    if (cues[0]) {
      this.currentText = { original: cues[0].originalText, translated: cues[0].translatedText };
      this.wrapper = this.slots?.bottom?.querySelector?.('.ncw-subtitle-wrapper') || null;
      this.translatedEl = this.wrapper?.querySelector?.('.ncw-translated-text') || null;
      this.originalEl = this.wrapper?.querySelector?.('.ncw-original-text') || null;
    }
  }

  reconcileSlotCues(slotEl: HTMLElement, slotCues: OverlayCueItem[], mode: string): void {
    if (!slotEl) return;

    const existingMap = new Map<string, HTMLElement>();
    const children = Array.from(slotEl.children) as HTMLElement[];
    children.forEach((child) => {
      const cueId = child.getAttribute('data-cue-id');
      if (cueId !== null && cueId !== undefined) {
        existingMap.set(String(cueId), child);
      }
    });

    const targetIds = new Set(
      slotCues.map((c) => String(c.id !== undefined && c.id !== null ? c.id : 0))
    );

    children.forEach((child) => {
      const cueId = child.getAttribute('data-cue-id');
      if (cueId && !targetIds.has(String(cueId))) {
        child.remove();
      }
    });

    slotCues.forEach((cue) => {
      const idStr = String(cue.id !== undefined && cue.id !== null ? cue.id : 0);
      const existing = existingMap.get(idStr);

      if (existing) {
        this.updateCueWrapper(existing, cue.originalText, cue.translatedText, mode);
        if (existing.parentElement !== slotEl) {
          slotEl.appendChild(existing);
        }
      } else {
        const newWrapper = this.createCueWrapper(
          cue.id,
          cue.originalText,
          cue.translatedText,
          mode
        );
        slotEl.appendChild(newWrapper);
      }
    });
  }

  createCueWrapper(
    cueId: number | string,
    originalText: string,
    translatedText: string | null,
    mode: string = 'bilingual'
  ): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'ncw-subtitle-wrapper';
    wrapper.setAttribute('data-cue-id', String(cueId));

    const formattedOrig = (originalText || '').replace(/\n/g, '<br/>');
    const formattedTrans = (translatedText || '').replace(/\n/g, '<br/>');

    const transEl = document.createElement('div');
    transEl.className = 'ncw-sub-line ncw-translated-text';

    const origEl = document.createElement('div');
    origEl.className = 'ncw-sub-line ncw-original-text';

    const swap = Boolean(this.settings.swapSubtitleOrder);

    if (mode === 'bilingual') {
      transEl.innerHTML = formattedTrans || '<span class="ncw-translating">...</span>';
      transEl.style.display = 'block';
      origEl.innerHTML = formattedOrig;
      origEl.style.display = formattedOrig ? 'block' : 'none';

      if (swap) {
        if (formattedOrig) wrapper.appendChild(origEl);
        wrapper.appendChild(transEl);
      } else {
        wrapper.appendChild(transEl);
        if (formattedOrig) wrapper.appendChild(origEl);
      }
    } else if (mode === 'translated') {
      transEl.innerHTML = formattedTrans || formattedOrig || '';
      transEl.style.display = 'block';
      wrapper.appendChild(transEl);
    } else if (mode === 'original') {
      origEl.innerHTML = formattedOrig;
      origEl.style.display = 'block';
      wrapper.appendChild(origEl);
    }

    return wrapper;
  }

  updateCueWrapper(
    wrapper: HTMLElement,
    originalText: string,
    translatedText: string | null,
    mode: string
  ): void {
    if (!wrapper) return;

    const formattedOrig = (originalText || '').replace(/\n/g, '<br/>');
    const formattedTrans = (translatedText || '').replace(/\n/g, '<br/>');

    const transEl = wrapper.querySelector('.ncw-translated-text') as HTMLElement | null;
    const origEl = wrapper.querySelector('.ncw-original-text') as HTMLElement | null;
    const swap = Boolean(this.settings.swapSubtitleOrder);

    if (mode === 'bilingual') {
      const targetTrans = formattedTrans || '<span class="ncw-translating">...</span>';
      if (transEl && transEl.innerHTML !== targetTrans) {
        transEl.innerHTML = targetTrans;
      }
      if (origEl) {
        if (origEl.innerHTML !== formattedOrig) {
          origEl.innerHTML = formattedOrig;
        }
        origEl.style.display = formattedOrig ? 'block' : 'none';
      }

      if (origEl && transEl) {
        const firstChild = wrapper.firstElementChild;
        if (swap && firstChild !== origEl) {
          wrapper.insertBefore(origEl, transEl);
        } else if (!swap && firstChild !== transEl) {
          wrapper.insertBefore(transEl, origEl);
        }
      }
    } else if (mode === 'translated') {
      const targetTrans = formattedTrans || formattedOrig || '';
      if (transEl && transEl.innerHTML !== targetTrans) {
        transEl.innerHTML = targetTrans;
      }
    } else if (mode === 'original') {
      if (origEl && origEl.innerHTML !== formattedOrig) {
        origEl.innerHTML = formattedOrig;
      }
    }
  }

  show(originalText: string, translatedText: string | null, position: string = 'bottom'): void {
    this.showCues([{ id: 0, originalText, translatedText, position }]);
  }

  hide(immediate: boolean = false): void {
    if (this.slots) {
      const animEnabled = Boolean(this.settings.enableAnimation);
      Object.values(this.slots).forEach((slotEl) => {
        if (!slotEl || !slotEl.style) return;
        slotEl.style.opacity = '0';
        if (immediate || !animEnabled || this.settings.enabled === false) {
          slotEl.style.visibility = 'hidden';
          slotEl.innerHTML = '';
        }
      });
    }
    this.isVisible = false;
  }
}

export default SubtitleOverlay;
