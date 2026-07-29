import type { MobileReminder, MobileReminderState } from '../domain/reminder-service.ts';
import type { LocalNotificationRequest, NotificationPort } from './ports.ts';

const REMINDER_CHANNEL_ID = 'easy-rewind-reminders';

type ExpoModuleLoader = (specifier: string) => Promise<unknown>;

interface ExpoNotificationsModule {
  AndroidImportance: { HIGH: unknown };
  getPermissionsAsync(): Promise<{ granted: boolean }>;
  setNotificationChannelAsync(
    channelId: string,
    options: { name: string; importance: unknown; vibrationPattern: number[] }
  ): Promise<unknown>;
  scheduleNotificationAsync(request: {
    content: {
      title: string;
      body: string;
      data: Readonly<Record<string, string>>;
    };
    trigger: {
      type: 'date';
      date: number;
      channelId?: string;
    };
  }): Promise<string>;
  cancelScheduledNotificationAsync(notificationId: string): Promise<void>;
}

export class MobileNotificationError extends Error {
  readonly code:
    | 'notification_configuration_invalid'
    | 'notification_permission_required'
    | 'reminder_not_found'
    | 'reminder_not_schedulable';

  constructor(code: MobileNotificationError['code'], message: string) {
    super(message);
    this.name = 'MobileNotificationError';
    this.code = code;
  }
}

function defaultModuleLoader(specifier: string): Promise<unknown> {
  return import(specifier);
}

function asNotificationsModule(value: unknown): ExpoNotificationsModule {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('AndroidImportance' in value) ||
    !('getPermissionsAsync' in value) ||
    typeof value.getPermissionsAsync !== 'function' ||
    !('setNotificationChannelAsync' in value) ||
    typeof value.setNotificationChannelAsync !== 'function' ||
    !('scheduleNotificationAsync' in value) ||
    typeof value.scheduleNotificationAsync !== 'function' ||
    !('cancelScheduledNotificationAsync' in value) ||
    typeof value.cancelScheduledNotificationAsync !== 'function'
  ) {
    throw new MobileNotificationError('notification_configuration_invalid', 'Expo notifications are unavailable.');
  }
  return value as ExpoNotificationsModule;
}

function validRequest(request: LocalNotificationRequest): boolean {
  return (
    typeof request.title === 'string' &&
    request.title.trim() !== '' &&
    typeof request.body === 'string' &&
    Number.isSafeInteger(request.triggerAtUtcMs) &&
    request.triggerAtUtcMs >= 0 &&
    (request.id === undefined || (typeof request.id === 'string' && request.id.trim() !== ''))
  );
}

export function createExpoNotificationPort({
  loadModule = defaultModuleLoader,
  platform = 'android',
}: {
  loadModule?: ExpoModuleLoader;
  platform?: 'android' | 'ios';
} = {}): NotificationPort {
  let modulePromise: Promise<ExpoNotificationsModule> | undefined;
  let prepared = false;
  const load = () => {
    modulePromise ??= loadModule('expo-notifications').then(asNotificationsModule);
    return modulePromise;
  };

  async function prepare(module: ExpoNotificationsModule): Promise<void> {
    if (prepared) return;
    const permission = await module.getPermissionsAsync();
    if (!permission.granted) {
      throw new MobileNotificationError(
        'notification_permission_required',
        'Notification permission is required before scheduling reminders.'
      );
    }
    if (platform === 'android') {
      await module.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
        name: 'Reminders',
        importance: module.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
      });
    }
    prepared = true;
  }

  return Object.freeze({
    async schedule(request: LocalNotificationRequest): Promise<string> {
      if (!validRequest(request)) {
        throw new MobileNotificationError(
          'notification_configuration_invalid',
          'The local notification request is invalid.'
        );
      }
      const module = await load();
      await prepare(module);
      const data = {
        ...(request.data ?? {}),
        ...(request.id === undefined ? {} : { localDeliveryId: request.id }),
      };
      return module.scheduleNotificationAsync({
        content: {
          title: request.title,
          body: request.body,
          data,
        },
        trigger: {
          type: 'date',
          date: request.triggerAtUtcMs,
          ...(platform === 'android' ? { channelId: REMINDER_CHANNEL_ID } : {}),
        },
      });
    },

    async cancel(notificationId: string): Promise<void> {
      if (typeof notificationId !== 'string' || notificationId.trim() === '') {
        throw new MobileNotificationError(
          'notification_configuration_invalid',
          'The local notification identifier is invalid.'
        );
      }
      const module = await load();
      await module.cancelScheduledNotificationAsync(notificationId);
    },
  });
}

interface ReminderOperations {
  get(
    id: string
  ): Pick<MobileReminder, 'id' | 'profileId' | 'title' | 'body' | 'dueAt' | 'state' | 'localNotificationId'> | null;
  edit(
    id: string,
    patch: { localNotificationId?: string | null; state?: MobileReminderState }
  ): Pick<MobileReminder, 'id' | 'profileId' | 'title' | 'body' | 'dueAt' | 'state' | 'localNotificationId'>;
}

export function createMobileReminderNotifications({
  notifications,
  reminders,
}: {
  notifications: NotificationPort;
  reminders: ReminderOperations;
}) {
  if (
    notifications === null ||
    typeof notifications !== 'object' ||
    typeof notifications.schedule !== 'function' ||
    typeof notifications.cancel !== 'function' ||
    reminders === null ||
    typeof reminders !== 'object' ||
    typeof reminders.get !== 'function' ||
    typeof reminders.edit !== 'function'
  ) {
    throw new MobileNotificationError(
      'notification_configuration_invalid',
      'The reminder notification service configuration is invalid.'
    );
  }

  function getReminder(id: string) {
    const reminder = reminders.get(id);
    if (reminder === null) {
      throw new MobileNotificationError('reminder_not_found', 'The mobile reminder was not found.');
    }
    return reminder;
  }

  async function schedule(id: string, replace: boolean) {
    const reminder = getReminder(id);
    if (reminder.state !== 'scheduled') {
      throw new MobileNotificationError(
        'reminder_not_schedulable',
        'Only scheduled reminders can create a local notification.'
      );
    }
    if (reminder.localNotificationId !== null && !replace) return reminder;
    if (reminder.localNotificationId !== null) {
      await notifications.cancel(reminder.localNotificationId);
    }
    const localNotificationId = await notifications.schedule({
      id: `android:${reminder.profileId}:reminder:${reminder.id}`,
      title: reminder.title,
      body: reminder.body,
      triggerAtUtcMs: reminder.dueAt,
      data: {
        reminderId: reminder.id,
        profileId: reminder.profileId,
      },
    });
    return reminders.edit(id, { localNotificationId });
  }

  async function cancel(id: string) {
    const reminder = getReminder(id);
    if (reminder.localNotificationId === null) return reminder;
    await notifications.cancel(reminder.localNotificationId);
    return reminders.edit(id, { localNotificationId: null });
  }

  return Object.freeze({
    ensureScheduled(id: string) {
      return schedule(id, false);
    },
    reschedule(id: string) {
      return schedule(id, true);
    },
    cancel,
    async acknowledgeOnAndroid(id: string) {
      const reminder = getReminder(id);
      if (reminder.localNotificationId !== null) {
        await notifications.cancel(reminder.localNotificationId);
      }
      if (reminder.state === 'completed' && reminder.localNotificationId === null) return reminder;
      return reminders.edit(id, {
        localNotificationId: null,
        state: 'completed',
      });
    },
  });
}
