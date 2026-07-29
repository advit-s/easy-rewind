export const MOBILE_UI_STATES = Object.freeze([
  'loading',
  'empty',
  'offline',
  'queued',
  'synchronized',
  'conflicted',
  'revoked',
  'incompatible',
  'retry',
] as const);

export type MobileUiState = (typeof MOBILE_UI_STATES)[number];
export type SyncStatusTone = 'neutral' | 'positive' | 'caution' | 'critical';

export interface SyncStatusOptions {
  readonly queuedCount?: number;
  readonly lastSyncedAt?: number | null;
}

export interface SyncStatusModel {
  readonly state: MobileUiState;
  readonly title: string;
  readonly message: string;
  readonly tone: SyncStatusTone;
  readonly actionLabel?: string;
  readonly accessibilityLabel: string;
}

function validQueuedCount(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : 0;
}

function synchronizedMessage(lastSyncedAt: number | null | undefined): string {
  if (
    !Number.isSafeInteger(lastSyncedAt) ||
    (lastSyncedAt ?? -1) < 0 ||
    (lastSyncedAt ?? Number.POSITIVE_INFINITY) > 8_640_000_000_000_000
  ) {
    return 'This device is synchronized with the paired PC.';
  }
  return `Last synchronized ${new Date(lastSyncedAt as number).toISOString()}.`;
}

export function createSyncStatusModel(
  state: MobileUiState,
  options: SyncStatusOptions = {}
): Readonly<SyncStatusModel> {
  const queuedCount = validQueuedCount(options.queuedCount);
  const models: Record<MobileUiState, Omit<SyncStatusModel, 'state' | 'accessibilityLabel'>> = {
    loading: {
      title: 'Loading',
      message: 'Opening your local library on this device.',
      tone: 'neutral',
    },
    empty: {
      title: 'Nothing here yet',
      message: 'Capture something on this device to begin.',
      tone: 'neutral',
    },
    offline: {
      title: 'Working offline',
      message: 'Changes are saved on this device and will wait for the paired PC.',
      tone: 'caution',
    },
    queued: {
      title: 'Waiting to sync',
      message:
        queuedCount === 1
          ? '1 change is safely queued on this device.'
          : `${queuedCount || 'Your'} changes are safely queued on this device.`,
      tone: 'caution',
    },
    synchronized: {
      title: 'Up to date',
      message: synchronizedMessage(options.lastSyncedAt),
      tone: 'positive',
    },
    conflicted: {
      title: 'Needs your choice',
      message: 'Both versions are preserved until you choose which one to keep.',
      tone: 'critical',
      actionLabel: 'Review conflicts',
    },
    revoked: {
      title: 'Pairing revoked',
      message: 'Synchronization is stopped. Your local data remains on this device.',
      tone: 'critical',
      actionLabel: 'Pair again',
    },
    incompatible: {
      title: 'Update required',
      message: 'This app and the paired PC use incompatible sync versions.',
      tone: 'critical',
      actionLabel: 'Update app',
    },
    retry: {
      title: 'Sync interrupted',
      message: 'Your local changes are safe. Try again when the paired PC is reachable.',
      tone: 'caution',
      actionLabel: 'Retry sync',
    },
  };
  const selected = models[state];
  if (selected === undefined) {
    throw new TypeError('The mobile UI state is invalid.');
  }
  return Object.freeze({
    state,
    ...selected,
    accessibilityLabel: `${selected.title}. ${selected.message}`,
  });
}

export async function runLocalFirstAction<T>({
  writeLocal,
  requestSync,
}: {
  readonly writeLocal: () => Promise<T>;
  readonly requestSync: (local: T) => Promise<void>;
}): Promise<Readonly<{ local: T; syncRequested: boolean }>> {
  if (typeof writeLocal !== 'function' || typeof requestSync !== 'function') {
    throw new TypeError('Local-first action dependencies are invalid.');
  }
  const local = await writeLocal();
  try {
    await requestSync(local);
    return Object.freeze({ local, syncRequested: true });
  } catch {
    return Object.freeze({ local, syncRequested: false });
  }
}
