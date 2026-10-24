/* eslint-disable no-console */
export class Logger {
    private readonly context: string;

    constructor(context: string) {
        this.context = context;
    }

    static create(context: string): Logger {
        return new Logger(context);
    }

    info(scope: string, message: string, ...args: unknown[]): void {
        console.log(`[${scope}]-[${this.context}] ${message}`, ...args);
    }

    warn(scope: string, message: string, ...args: unknown[]): void {
        console.warn(`[${scope}]-[${this.context}] ${message}`, ...args);
    }

    error(scope: string, message: string, ...args: unknown[]): void {
        console.error(`[${scope}]-[${this.context}] ${message}`, ...args);
    }

    debug(scope: string, message: string, ...args: unknown[]): void {
        console.debug(`[${scope}]-[${this.context}]- ${message}`, ...args);
    }
}
