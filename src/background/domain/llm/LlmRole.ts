export type LlmRole = 'translator' | 'supervisor';

export interface AiCapability {
    hasAi: boolean;
    provider?: string;
    model?: string;
    isSupervisor: boolean;
}
