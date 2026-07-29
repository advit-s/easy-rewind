import type { BackgroundScheduler, NetworkStatus, NetworkStatusSnapshot } from '../platform/ports.ts';

export type SyncTriggerReason = 'app_open' | 'local_mutation' | 'manual' | 'network_return' | 'periodic_android';

export type TerminalSyncReason = 'device_revoked' | 'tls_fingerprint_mismatch';

export interface TriggeredSyncCoordinator {
  synchronize(): Promise<unknown>;
}

export interface RetryClock {
  now(): number;
  sleep(delayMs: number): Promise<void>;
}

export interface SyncRetryOptions {
  baseDelayMs: number;
  maximumDelayMs: number;
  maximumAttempts: number;
  jitterRatio: number;
}

export interface SyncTriggerStatus {
  state: 'idle' | 'synchronizing' | 'retry_wait' | 'queued' | 'blocked' | 'stopped';
  queued: boolean;
  activeTrigger: SyncTriggerReason | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextRetryAt: number | null;
  terminalReason: TerminalSyncReason | null;
  backgroundScheduled: boolean;
  backgroundScheduleError: string | null;
}

const BACKGROUND_TASK_NAME = 'easy-rewind-sync';
const BACKGROUND_INTERVAL_MINUTES = 15;
const DEFAULT_RETRY: SyncRetryOptions = {
  baseDelayMs: 1_000,
  maximumDelayMs: 60_000,
  maximumAttempts: 5,
  jitterRatio: 0.25,
};

function errorCode(error: unknown): string | null {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return null;
}

function terminalReason(error: unknown): TerminalSyncReason | null {
  const code = errorCode(error);
  return code === 'device_revoked' || code === 'tls_fingerprint_mismatch' ? code : null;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message
    : 'Background scheduling is unavailable.';
}

function isReachable(status: NetworkStatusSnapshot): boolean {
  return status.connected && status.internetReachable !== false;
}

function validateRetry(options: SyncRetryOptions): void {
  if (
    !Number.isSafeInteger(options.baseDelayMs) ||
    options.baseDelayMs < 0 ||
    !Number.isSafeInteger(options.maximumDelayMs) ||
    options.maximumDelayMs < options.baseDelayMs ||
    !Number.isSafeInteger(options.maximumAttempts) ||
    options.maximumAttempts < 1 ||
    !Number.isFinite(options.jitterRatio) ||
    options.jitterRatio < 0 ||
    options.jitterRatio > 1
  ) {
    throw new TypeError('Invalid sync retry configuration.');
  }
}

export class SyncTriggers {
  readonly #coordinator: TriggeredSyncCoordinator;
  readonly #clock: RetryClock;
  readonly #jitter: (maximumInclusive: number) => number;
  readonly #network: NetworkStatus;
  readonly #scheduler: BackgroundScheduler;
  readonly #retry: SyncRetryOptions;
  #status: SyncTriggerStatus = {
    state: 'idle',
    queued: false,
    activeTrigger: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextRetryAt: null,
    terminalReason: null,
    backgroundScheduled: false,
    backgroundScheduleError: null,
  };
  #started = false;
  #stopped = false;
  #previouslyReachable = false;
  #unsubscribeNetwork: (() => void) | null = null;
  #activePromise: Promise<void> | null = null;
  #rerunRequested = false;

  constructor({
    coordinator,
    clock,
    jitter,
    network,
    scheduler,
    retry = DEFAULT_RETRY,
  }: {
    coordinator: TriggeredSyncCoordinator;
    clock: RetryClock;
    jitter: (maximumInclusive: number) => number;
    network: NetworkStatus;
    scheduler: BackgroundScheduler;
    retry?: SyncRetryOptions;
  }) {
    if (
      typeof coordinator.synchronize !== 'function' ||
      typeof clock.now !== 'function' ||
      typeof clock.sleep !== 'function' ||
      typeof jitter !== 'function' ||
      typeof network.getStatus !== 'function' ||
      typeof network.subscribe !== 'function' ||
      typeof scheduler.register !== 'function' ||
      typeof scheduler.unregister !== 'function'
    ) {
      throw new TypeError('Invalid sync trigger dependencies.');
    }
    validateRetry(retry);
    this.#coordinator = coordinator;
    this.#clock = clock;
    this.#jitter = jitter;
    this.#network = network;
    this.#scheduler = scheduler;
    this.#retry = { ...retry };
  }

  getStatus(): SyncTriggerStatus {
    return { ...this.#status };
  }

  async start(): Promise<void> {
    if (this.#started || this.#stopped || this.#status.terminalReason !== null) return;
    this.#started = true;

    try {
      this.#previouslyReachable = isReachable(await this.#network.getStatus());
    } catch {
      this.#previouslyReachable = false;
    }
    this.#unsubscribeNetwork = this.#network.subscribe(status => {
      const reachable = isReachable(status);
      const returned = reachable && !this.#previouslyReachable;
      this.#previouslyReachable = reachable;
      if (returned) {
        void this.#requestSync('network_return').catch(() => undefined);
      }
    });

    try {
      await this.#scheduler.register(BACKGROUND_TASK_NAME, () => this.#requestSync('periodic_android'), {
        minimumIntervalMinutes: BACKGROUND_INTERVAL_MINUTES,
        requiresNetwork: true,
      });
      this.#status.backgroundScheduled = true;
      this.#status.backgroundScheduleError = null;
    } catch (error) {
      this.#status.backgroundScheduled = false;
      this.#status.backgroundScheduleError = safeErrorMessage(error);
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#started = false;
    this.#unsubscribeNetwork?.();
    this.#unsubscribeNetwork = null;
    if (this.#status.backgroundScheduled) {
      try {
        await this.#scheduler.unregister(BACKGROUND_TASK_NAME);
      } catch (error) {
        this.#status.backgroundScheduleError = safeErrorMessage(error);
      }
    }
    this.#status.backgroundScheduled = false;
    this.#status.state = 'stopped';
    this.#status.activeTrigger = null;
    this.#status.nextRetryAt = null;
  }

  appOpened(): Promise<void> {
    return this.#requestSync('app_open');
  }

  localMutationCommitted(): Promise<void> {
    return this.#requestSync('local_mutation');
  }

  manualRequested(): Promise<void> {
    return this.#requestSync('manual');
  }

  #requestSync(reason: SyncTriggerReason): Promise<void> {
    if (this.#stopped || this.#status.terminalReason !== null) return Promise.resolve();
    if (this.#activePromise !== null) {
      this.#rerunRequested = true;
      this.#status.queued = true;
      return this.#activePromise;
    }

    this.#status.activeTrigger = reason;
    this.#status.queued = false;
    const running = this.#runLoop(reason).finally(() => {
      this.#activePromise = null;
      this.#status.activeTrigger = null;
    });
    this.#activePromise = running;
    return running;
  }

  async #runLoop(initialReason: SyncTriggerReason): Promise<void> {
    let reason = initialReason;
    for (;;) {
      this.#status.activeTrigger = reason;
      await this.#synchronizeWithRetry();
      if (!this.#rerunRequested || this.#status.terminalReason !== null || this.#stopped) {
        this.#status.state = this.#status.terminalReason !== null ? 'blocked' : this.#stopped ? 'stopped' : 'idle';
        this.#status.queued = false;
        return;
      }
      this.#rerunRequested = false;
      this.#status.queued = false;
      reason = 'local_mutation';
    }
  }

  async #synchronizeWithRetry(): Promise<void> {
    for (let attempt = 1; attempt <= this.#retry.maximumAttempts; attempt += 1) {
      this.#status.state = 'synchronizing';
      this.#status.lastAttemptAt = this.#clock.now();
      this.#status.nextRetryAt = null;
      try {
        await this.#coordinator.synchronize();
        this.#status.lastSuccessAt = this.#clock.now();
        this.#status.queued = this.#rerunRequested;
        return;
      } catch (error) {
        const terminal = terminalReason(error);
        if (terminal !== null) {
          await this.#blockTerminal(terminal);
          throw error;
        }
        if (attempt === this.#retry.maximumAttempts) {
          this.#status.state = 'queued';
          this.#status.queued = true;
          this.#status.nextRetryAt = null;
          throw error;
        }

        const exponential = Math.min(this.#retry.maximumDelayMs, this.#retry.baseDelayMs * 2 ** (attempt - 1));
        const maximumJitter = Math.floor(exponential * this.#retry.jitterRatio);
        const injected = this.#jitter(maximumJitter);
        const jitter = Number.isFinite(injected) ? Math.max(0, Math.min(maximumJitter, Math.floor(injected))) : 0;
        const delay = Math.min(this.#retry.maximumDelayMs, exponential + jitter);
        this.#status.state = 'retry_wait';
        this.#status.queued = true;
        this.#status.nextRetryAt = this.#clock.now() + delay;
        await this.#clock.sleep(delay);
      }
    }
  }

  async #blockTerminal(reason: TerminalSyncReason): Promise<void> {
    this.#status.terminalReason = reason;
    this.#status.state = 'blocked';
    this.#status.queued = true;
    this.#status.nextRetryAt = null;
    this.#unsubscribeNetwork?.();
    this.#unsubscribeNetwork = null;
    if (this.#status.backgroundScheduled) {
      try {
        await this.#scheduler.unregister(BACKGROUND_TASK_NAME);
      } catch (error) {
        this.#status.backgroundScheduleError = safeErrorMessage(error);
      }
    }
    this.#status.backgroundScheduled = false;
  }
}

export function createSyncTriggers(dependencies: ConstructorParameters<typeof SyncTriggers>[0]): SyncTriggers {
  return new SyncTriggers(dependencies);
}
