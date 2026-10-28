import {
    EpisodeVocabData,
    VocabWordItem,
} from '@shared/domain/entities/Vocabulary';
import { VocabCurationService } from '../application/VocabCurationService';
import { AnkiExportModal } from '../anki/AnkiExportModal';
import { VocabExportItem } from '../anki/ankiTypes';

export class VocabPreviewEditorModal {
    private modalEl: HTMLElement | null = null;
    private currentEpisode: EpisodeVocabData | null = null;
    private words: VocabWordItem[] = [];
    private selectedIndices = new Set<number>();
    private isEnriching: boolean = false;
    private onUpdateCallback: (() => void) | null = null;

    constructor(
        private readonly curationService: VocabCurationService,
        private readonly ankiModal: AnkiExportModal,
        private readonly onToast: (msg: string) => void,
        private readonly onExportCsv: (
            episode: EpisodeVocabData,
            words: VocabWordItem[],
        ) => void,
    ) {
        this.init();
    }

    private init(): void {
        this.modalEl = document.getElementById('vocab-preview-modal');
        if (!this.modalEl) return;

        // Close handlers
        const btnClose = document.getElementById('btn-modal-close');
        btnClose?.addEventListener('click', () => this.hide());
        this.modalEl.addEventListener('click', (e) => {
            if (e.target === this.modalEl) {
                this.hide();
            }
        });

        // Prompt Preset Chips
        const chips = this.modalEl.querySelectorAll<HTMLButtonElement>('.btn-chip');
        const promptInput = document.getElementById(
            'curation-custom-prompt',
        ) as HTMLTextAreaElement | null;

        chips.forEach((chip) => {
            chip.addEventListener('click', () => {
                const text = chip.dataset.prompt || '';
                if (!promptInput) return;
                const current = promptInput.value.trim();
                if (!current) {
                    promptInput.value = text;
                } else if (!current.includes(text)) {
                    promptInput.value = `${current}；${text}`;
                }
                promptInput.focus();
                this.curationService.saveCustomPrompt(promptInput.value);
            });
        });

        promptInput?.addEventListener('change', () => {
            this.curationService.saveCustomPrompt(promptInput.value);
        });

        // Select All Handler
        const selectAllCheckbox = document.getElementById(
            'curation-select-all',
        ) as HTMLInputElement | null;
        selectAllCheckbox?.addEventListener('change', () => {
            if (selectAllCheckbox.checked) {
                this.words.forEach((_, idx) => this.selectedIndices.add(idx));
            } else {
                this.selectedIndices.clear();
            }
            this.updateSelectionUI();
            this.renderWordRows();
        });

        // Batch Delete Button
        const btnBatchDelete = document.getElementById(
            'btn-curation-batch-delete',
        );
        btnBatchDelete?.addEventListener('click', () => {
            if (this.selectedIndices.size === 0) return;
            if (
                confirm(
                    `Are you sure you want to delete ${this.selectedIndices.size} selected word(s)?`,
                )
            ) {
                this.words = this.words.filter(
                    (_, idx) => !this.selectedIndices.has(idx),
                );
                this.selectedIndices.clear();
                this.updateSelectionUI();
                this.renderWordRows();
                this.onToast('Selected words deleted from list');
            }
        });

        // Batch AI Enrich Button
        const btnEnrichAll = document.getElementById(
            'btn-curation-enrich-all',
        );
        btnEnrichAll?.addEventListener('click', async () => {
            await this.handleBatchEnrich();
        });

        // Save Changes Button
        const btnSave = document.getElementById('btn-curation-save');
        btnSave?.addEventListener('click', async () => {
            await this.handleSaveChanges();
        });

        // Download CSV Button
        const btnDownloadCsv = document.getElementById('modal-download-btn');
        btnDownloadCsv?.addEventListener('click', () => {
            if (this.currentEpisode) {
                this.onExportCsv(this.currentEpisode, this.words);
            }
        });

        // Export to Anki Button
        const btnAnki = document.getElementById('modal-anki-btn');
        btnAnki?.addEventListener('click', () => {
            if (!this.currentEpisode || this.words.length === 0) {
                this.onToast('No vocabulary items to export');
                return;
            }
            const items: VocabExportItem[] = this.words.map((w) => ({
                word: w,
                episodeInfo: {
                    showTitle: this.currentEpisode?.showTitle,
                    movieId: this.currentEpisode?.movieId,
                },
            }));
            const lang =
                this.words[0]?.sourceLang ||
                this.currentEpisode.sourceLanguage ||
                'ja_JP';
            this.ankiModal.show(items, lang);
        });
    }

    async open(
        episode: EpisodeVocabData,
        onUpdate?: () => void,
    ): Promise<void> {
        if (!this.modalEl) return;
        this.currentEpisode = episode;
        this.words = episode.words.map((w) => ({ ...w }));
        this.selectedIndices.clear();
        this.onUpdateCallback = onUpdate || null;

        // Populate Titles & Language Snapshot Badge
        const titleEl = document.getElementById('modal-episode-title');
        const badgeEl = document.getElementById('modal-lang-badge');
        const subtitleEl = document.getElementById('modal-episode-subtitle');
        const promptInput = document.getElementById(
            'curation-custom-prompt',
        ) as HTMLTextAreaElement | null;

        const src = episode.sourceLanguage || 'ja';
        const tgt = episode.targetLanguage || 'zh-CN';

        if (titleEl) {
            titleEl.textContent = `${episode.showTitle || 'Episode'} (${episode.movieId})`;
        }
        if (badgeEl) {
            badgeEl.textContent = `Snapshot: ${src} ➔ ${tgt}`;
        }
        if (subtitleEl) {
            subtitleEl.textContent = `Collected with difficulty [${episode.difficulty || 'normal'}]. Edit, delete, or enrich definitions using the supervisor model.`;
        }

        // Load saved custom prompt
        if (promptInput) {
            promptInput.value =
                (await this.curationService.getSavedCustomPrompt()) || '';
        }

        this.updateSelectionUI();
        this.renderWordRows();

        this.modalEl.style.display = 'flex';
    }

    hide(): void {
        if (this.modalEl) {
            this.modalEl.style.display = 'none';
        }
        this.currentEpisode = null;
        this.words = [];
        this.selectedIndices.clear();
    }

    private updateSelectionUI(): void {
        const selectAllCheckbox = document.getElementById(
            'curation-select-all',
        ) as HTMLInputElement | null;
        const btnBatchDelete = document.getElementById(
            'btn-curation-batch-delete',
        ) as HTMLButtonElement | null;
        const selectedCountSpan = document.getElementById(
            'curation-selected-count',
        );
        const wordCountSpan = document.getElementById('modal-word-count');

        const total = this.words.length;
        const selCount = this.selectedIndices.size;

        if (selectAllCheckbox) {
            selectAllCheckbox.checked = total > 0 && selCount === total;
            selectAllCheckbox.indeterminate = selCount > 0 && selCount < total;
        }

        if (btnBatchDelete) {
            btnBatchDelete.disabled = selCount === 0;
        }
        if (selectedCountSpan) {
            selectedCountSpan.textContent = String(selCount);
        }
        if (wordCountSpan) {
            const userCount = this.words.filter(
                (w) => w.source === 'user',
            ).length;
            wordCountSpan.textContent = `${total} words total (${userCount} starred by user)`;
        }
    }

    private renderWordRows(): void {
        const container = document.getElementById('modal-words-list');
        if (!container) return;

        if (this.words.length === 0) {
            container.innerHTML = `
        <div style="text-align:center; padding: 40px; color:#888;">
          No words in this episode.
        </div>
      `;
            return;
        }

        container.innerHTML = this.words
            .map((w, idx) => {
                const isChecked = this.selectedIndices.has(idx);
                const isUser = w.source === 'user';
                const word = this.escapeHtml(w.word || '');
                const pos = w.pos ? `(${this.escapeHtml(w.pos)})` : '';
                const pho = w.phonetic ? `[${this.escapeHtml(w.phonetic)}]` : '';
                const meaning = this.escapeHtml(w.meaning || '');
                const sentence = w.sentence
                    ? `"${this.escapeHtml(w.sentence)}"`
                    : '';
                const trans = w.sentenceTranslation
                    ? this.escapeHtml(w.sentenceTranslation)
                    : '';
                const langBadge =
                    w.sourceLang && w.targetLang
                        ? `<span class="badge badge-neutral" style="font-size:10px; margin-left:6px;">${w.sourceLang}➔${w.targetLang}</span>`
                        : '';

                return `
          <div class="curation-word-card ${isChecked ? 'selected' : ''}" data-idx="${idx}" style="background:#16161b; border: 1px solid ${isChecked ? '#38bdf8' : 'var(--border-color)'}; border-radius: 8px; padding: 12px; margin-bottom: 10px;">
            <div style="display:flex; justify-content: space-between; align-items: flex-start; gap: 10px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" class="chk-word-select" data-idx="${idx}" ${isChecked ? 'checked' : ''} style="cursor:pointer;" />
                <strong style="color:#fff; font-size: 15px;">${word}</strong>
                <span style="color:#aaa; font-style: italic; font-size: 11px;">${pos}</span>
                <span style="color:#888; font-size: 11px;">${pho}</span>
                ${langBadge}
                ${isUser ? '<span class="badge" style="background:rgba(212,175,55,0.2); color:#ffd700; border:1px solid #d4af37; font-size:10px;">⭐ User</span>' : '<span class="badge" style="background:#222; color:#888; font-size:10px;">🤖 AI</span>'}
              </div>
              <div style="display:flex; gap: 6px;">
                <button type="button" class="btn-secondary btn-sm btn-word-enrich" data-idx="${idx}" title="Re-enrich definition with supervisor model" style="font-size: 11px; padding: 2px 7px;">
                  ✨ 释义
                </button>
                <button type="button" class="btn-danger btn-sm btn-word-delete" data-idx="${idx}" title="Delete word" style="font-size: 11px; padding: 2px 7px;">
                  🗑️
                </button>
              </div>
            </div>

            <div style="margin-top: 8px;">
              <div style="font-size: 11px; color: #888; margin-bottom: 2px;">Meaning / Definition:</div>
              <input
                type="text"
                class="form-control input-word-meaning"
                data-idx="${idx}"
                value="${meaning}"
                placeholder="Definition in target language..."
                style="width: 100%; height: 28px; font-size: 13px; color: #46d369; background: #0e0e12;"
              />
            </div>

            ${sentence ? `
              <div style="margin-top: 6px; font-size: 12px; color: #aaa; background: rgba(0,0,0,0.2); padding: 5px 8px; border-radius: 4px; border-left: 2px solid #38bdf8;">
                <div>${sentence}</div>
                ${trans ? `<div style="font-size: 11.5px; color: #777; margin-top: 2px;">${trans}</div>` : ''}
              </div>
            ` : ''}
          </div>
        `;
            })
            .join('');

        // Attach Row Listeners
        container
            .querySelectorAll<HTMLInputElement>('.chk-word-select')
            .forEach((chk) => {
                chk.addEventListener('change', () => {
                    const idx = parseInt(chk.dataset.idx || '-1', 10);
                    if (idx >= 0) {
                        if (chk.checked) this.selectedIndices.add(idx);
                        else this.selectedIndices.delete(idx);
                        this.updateSelectionUI();
                        this.renderWordRows();
                    }
                });
            });

        container
            .querySelectorAll<HTMLInputElement>('.input-word-meaning')
            .forEach((input) => {
                input.addEventListener('input', () => {
                    const idx = parseInt(input.dataset.idx || '-1', 10);
                    if (idx >= 0 && this.words[idx]) {
                        this.words[idx].meaning = input.value;
                    }
                });
            });

        container
            .querySelectorAll<HTMLButtonElement>('.btn-word-delete')
            .forEach((btn) => {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.dataset.idx || '-1', 10);
                    if (idx >= 0) {
                        this.words.splice(idx, 1);
                        this.selectedIndices.delete(idx);
                        this.updateSelectionUI();
                        this.renderWordRows();
                    }
                });
            });

        container
            .querySelectorAll<HTMLButtonElement>('.btn-word-enrich')
            .forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const idx = parseInt(btn.dataset.idx || '-1', 10);
                    if (idx >= 0) {
                        await this.handleSingleEnrich(idx, btn);
                    }
                });
            });
    }

    private async handleSingleEnrich(
        idx: number,
        button: HTMLButtonElement,
    ): Promise<void> {
        if (!this.currentEpisode || !this.words[idx]) return;
        const promptInput = document.getElementById(
            'curation-custom-prompt',
        ) as HTMLTextAreaElement | null;
        const customPrompt = promptInput?.value || '';

        const origHtml = button.innerHTML;
        button.disabled = true;
        button.innerHTML = '⏳...';

        try {
            const enriched = await this.curationService.enrichWord(
                this.words[idx],
                this.currentEpisode,
                customPrompt,
            );
            this.words[idx] = enriched;
            this.renderWordRows();
            this.onToast(`✨ Enriched "${enriched.word}"`);
        } catch {
            button.disabled = false;
            button.innerHTML = origHtml;
            this.onToast('Enrichment failed');
        }
    }

    private async handleBatchEnrich(): Promise<void> {
        if (!this.currentEpisode || this.words.length === 0 || this.isEnriching)
            return;
        const promptInput = document.getElementById(
            'curation-custom-prompt',
        ) as HTMLTextAreaElement | null;
        const customPrompt = promptInput?.value || '';

        // Save prompt for future sessions
        if (customPrompt) {
            await this.curationService.saveCustomPrompt(customPrompt);
        }

        const indicesToEnrich =
            this.selectedIndices.size > 0
                ? Array.from(this.selectedIndices)
                : this.words.map((_, i) => i);

        const statusEl = document.getElementById('curation-enrich-status');
        const btnEnrichAll = document.getElementById(
            'btn-curation-enrich-all',
        ) as HTMLButtonElement | null;

        this.isEnriching = true;
        if (btnEnrichAll) {
            btnEnrichAll.disabled = true;
            btnEnrichAll.innerHTML = '⏳ Enriching...';
        }
        if (statusEl) {
            statusEl.style.display = 'inline-block';
        }

        let completed = 0;
        try {
            for (const idx of indicesToEnrich) {
                const w = this.words[idx];
                if (!w) continue;

                if (statusEl) {
                    statusEl.textContent = `✨ Enriching ${completed + 1}/${indicesToEnrich.length} [${w.word}] (Supervisor)...`;
                }

                const enriched = await this.curationService.enrichWord(
                    w,
                    this.currentEpisode,
                    customPrompt,
                );
                this.words[idx] = enriched;
                completed++;
            }

            this.renderWordRows();
            this.onToast(
                `🎉 Enriched ${completed} word(s) with supervisor model!`,
            );
        } catch {
            this.onToast('Batch enrichment encountered an error');
        } finally {
            this.isEnriching = false;
            if (btnEnrichAll) {
                btnEnrichAll.disabled = false;
                btnEnrichAll.innerHTML = '✨ 一键 AI 释义 (监督模型)';
            }
            if (statusEl) {
                statusEl.style.display = 'none';
            }
        }
    }

    private async handleSaveChanges(): Promise<void> {
        if (!this.currentEpisode) return;
        const btnSave = document.getElementById(
            'btn-curation-save',
        ) as HTMLButtonElement | null;
        if (btnSave) {
            btnSave.disabled = true;
            btnSave.innerHTML = '💾 Saving...';
        }

        try {
            await this.curationService.saveCuratedEpisode(
                this.currentEpisode.movieId,
                this.currentEpisode,
                this.words,
            );
            this.onToast('💾 Changes saved to episode vocabulary!');
            this.onUpdateCallback?.();
        } catch {
            this.onToast('Failed to save changes');
        } finally {
            if (btnSave) {
                btnSave.disabled = false;
                btnSave.innerHTML = '💾 保存修改';
            }
        }
    }

    private escapeHtml(str: string): string {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}
