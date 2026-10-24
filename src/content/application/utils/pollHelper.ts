import { Logger } from '@shared/utils/logger';

const logger: Logger = new Logger('pollHelper');

export interface PollOptions<T> {
    immediate: boolean;
    intervalMs?: number;
    timeoutMs?: number; // The max poll duration
    maxAttempts?: number;
    abortSignal?: AbortSignal;
    backoffFactor?: number;
    maxIntervalMs?: number;
    onSuccess: (result: T | null) => void | Promise<void>;
    onAbort?: (reason: 'aborted' | 'timeout') => void;
    onError?: (error: unknown) => void;
}

export interface PollHandle<T> {
    initialResult: T | null | undefined;
    stop: () => void;
}

export async function startTriStatePoll<T>(
    queryFn: () => Promise<T | null | undefined>,
    options: PollOptions<T>,
): Promise<PollHandle<T>> {
    const {
        immediate,
        intervalMs = 1000,
        timeoutMs = Infinity,
        abortSignal,
        maxAttempts = 18,
        backoffFactor = 1.0,
        maxIntervalMs = 3000,
        onSuccess: onSuccess,
        onAbort,
        onError,
    } = options;

    let isStopped = false;
    let attemptCount = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startTime = Date.now();

    const onAbortSignal = () => {
        stop('aborted');
    };

    const stop = (reason: 'aborted' | 'timeout' = 'aborted') => {
        if (isStopped) return;
        isStopped = true;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (typeof onAbort === 'function') {
            onAbort(reason);
        }
        abortSignal?.removeEventListener('abort', onAbortSignal);
    };

    if (abortSignal) {
        if (abortSignal.aborted) {
            stop('aborted');
            return { initialResult: undefined, stop: () => {} };
        }
        abortSignal.addEventListener('abort', onAbortSignal, {
            once: true,
        });
    }

    const executeQuery = async (
        isImmediate: boolean,
    ): Promise<{ finished: boolean; result?: T | null }> => {
        if (isStopped || abortSignal?.aborted) return { finished: true };
        try {
            const res = await queryFn();

            if (isStopped || abortSignal?.aborted) return { finished: true };

            if (res !== undefined) {
                isStopped = true;
                abortSignal?.removeEventListener('abort', onAbortSignal);
                if (timer) clearTimeout(timer);

                if (!isImmediate) {
                    await onSuccess(res);
                }

                return { finished: true, result: res };
            }
        } catch (err) {
            if (onError) {
                onError(err);
            } else {
                logger.warn('executeQuery', `Query throws error: ${err}`);
            }
        }

        return { finished: false };
    };

    const scheduleNext = () => {
        if (isStopped || abortSignal?.aborted) return;

        if (Date.now() - startTime >= timeoutMs) {
            stop('timeout');
            return;
        }

        timer = setTimeout(
            async () => {
                const { finished } = await executeQuery(false);
                if (
                    Date.now() - startTime >= timeoutMs ||
                    attemptCount >= maxAttempts - 1
                ) {
                    stop('timeout');
                    return;
                }
                attemptCount += 1;
                if (!finished && !isStopped) {
                    scheduleNext();
                }
            },
            Math.min(
                Math.max(intervalMs * Math.pow(backoffFactor, attemptCount), 0),
                maxIntervalMs,
            ),
        );
    };

    let initialResult: T | null | undefined = undefined;
    if (immediate) {
        const { finished, result } = await executeQuery(true);
        attemptCount += 1;
        initialResult = result;
        if (!finished && !isStopped) {
            scheduleNext();
        }
    } else {
        scheduleNext();
    }

    return {
        initialResult,
        stop: () => {
            stop('aborted');
        },
    };
}
