import {
    SubtitleCue,
    createSubtitleCue,
} from '@shared/domain/entities/Subtitle';
import { ContentMessageService } from '../services/ContentMessageService';
import { ExtensionSettings } from '@shared/utils/constants';
import { Logger } from '@shared/utils/logger';

export interface AsrStreamMergerDelegate {
    isContextValid(): boolean;
    addMergedCues(cues: SubtitleCue[]): void;
    onMergedCuesAdded(epoch: number): void;
}

export class AsrStreamMerger {
    private readonly logger = new Logger('AsrStreamMerger');

    isAsrTrack = false;
    rawAsrCues: SubtitleCue[] = [];
    asrMergeIndex = 0;
    isMergingAsr = false;

    constructor(
        private readonly messageService: ContentMessageService,
        private readonly delegate: AsrStreamMergerDelegate,
        private readonly getSettings: () => Partial<ExtensionSettings>,
    ) {}

    loadRawAsrCues(cues: SubtitleCue[]): void {
        this.isAsrTrack = true;
        this.rawAsrCues = cues;
        this.asrMergeIndex = 0;
        this.isMergingAsr = false;
        this.logger.info(
            'AsrStreamMerger',
            `Loaded ${cues.length} raw ASR fragments.`,
        );
    }

    reset(): void {
        this.isAsrTrack = false;
        this.rawAsrCues = [];
        this.asrMergeIndex = 0;
        this.isMergingAsr = false;
    }

    findActiveRawAsrCues(time: number): SubtitleCue[] {
        if (!this.isAsrTrack || this.rawAsrCues.length === 0) return [];
        return this.rawAsrCues.filter(
            (c) => time >= c.startTime && time <= c.endTime,
        );
    }

    async checkAsrMergePipeline(
        currentTime: number,
        lastMergedTime: number,
        epoch: number,
    ): Promise<void> {
        if (
            !this.isAsrTrack ||
            this.isMergingAsr ||
            !this.delegate.isContextValid()
        )
            return;
        if (this.rawAsrCues.length === 0) return;

        this.fastForwardMergeIndexIfNeeded(currentTime, lastMergedTime);
        if (this.asrMergeIndex >= this.rawAsrCues.length) return;

        const TARGET_BUFFER_SEC = 60;
        const remainingBuffer = lastMergedTime - currentTime;
        if (lastMergedTime > 0 && remainingBuffer >= TARGET_BUFFER_SEC) return;

        await this.dispatchMergeBatch(currentTime, remainingBuffer, epoch);
    }

    private fastForwardMergeIndexIfNeeded(
        currentTime: number,
        lastMergedTime: number,
    ): void {
        if (
            currentTime > lastMergedTime &&
            this.asrMergeIndex < this.rawAsrCues.length
        ) {
            const seekRawIdx = this.rawAsrCues.findIndex(
                (c) => c.startTime >= currentTime - 1,
            );
            if (seekRawIdx >= 0 && seekRawIdx > this.asrMergeIndex) {
                this.asrMergeIndex = seekRawIdx;
            }
        }
    }

    private async dispatchMergeBatch(
        _currentTime: number,
        remainingBuffer: number,
        epoch: number,
    ): Promise<void> {
        this.isMergingAsr = true;
        const batchSize = Math.max(
            20,
            this.getSettings().asrMergeBatchSize || 20,
        );
        const chunk = this.rawAsrCues.slice(
            this.asrMergeIndex,
            this.asrMergeIndex + batchSize,
        );
        this.asrMergeIndex += chunk.length;

        try {
            this.logger.info(
                'AsrStreamMerger',
                `Dispatching merge batch for ${chunk.length} raw fragments (${chunk[0].startTime.toFixed(2)}s - ${chunk[chunk.length - 1].endTime.toFixed(2)}s, buffer ahead: ${remainingBuffer.toFixed(2)}s)`,
            );
            const res = await this.messageService.mergeAsrBatch({
                items: chunk.map((c) => ({
                    id: c.id,
                    startTime: c.startTime,
                    endTime: c.endTime,
                    rawText: c.rawText,
                })),
            });

            if (!res?.success || !res.mergedCues || res.mergedCues.length === 0)
                return;

            const newCues = res.mergedCues.map((c) =>
                createSubtitleCue({
                    id: c.id,
                    startTime: c.startTime,
                    endTime: c.endTime,
                    rawText: c.rawText,
                }),
            );

            this.delegate.addMergedCues(newCues);
            this.delegate.onMergedCuesAdded(epoch);
        } catch (err) {
            this.logger.error(
                'AsrStreamMerger',
                'Error in ASR merge batch:',
                err,
            );
        } finally {
            this.isMergingAsr = false;
        }
    }
}
