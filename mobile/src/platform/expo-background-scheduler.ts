import type { BackgroundScheduler, BackgroundTaskOptions } from './ports.ts';

interface TaskManagerModule {
  defineTask(taskName: string, task: () => Promise<unknown>): void;
  isTaskDefined(taskName: string): boolean;
}

interface BackgroundTaskModule {
  BackgroundTaskResult: {
    Success: unknown;
    Failed: unknown;
  };
  registerTaskAsync(taskName: string, options: { minimumInterval: number }): Promise<void>;
  unregisterTaskAsync(taskName: string): Promise<void>;
}

type ExpoModuleLoader = (specifier: string) => Promise<unknown>;

function defaultModuleLoader(specifier: string): Promise<unknown> {
  return import(specifier);
}

function asTaskManager(value: unknown): TaskManagerModule {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('defineTask' in value) ||
    typeof value.defineTask !== 'function' ||
    !('isTaskDefined' in value) ||
    typeof value.isTaskDefined !== 'function'
  ) {
    throw new TypeError('expo-task-manager is unavailable.');
  }
  return value as TaskManagerModule;
}

function asBackgroundTask(value: unknown): BackgroundTaskModule {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('BackgroundTaskResult' in value) ||
    !('registerTaskAsync' in value) ||
    typeof value.registerTaskAsync !== 'function' ||
    !('unregisterTaskAsync' in value) ||
    typeof value.unregisterTaskAsync !== 'function'
  ) {
    throw new TypeError('expo-background-task is unavailable.');
  }
  return value as BackgroundTaskModule;
}

export function createExpoBackgroundScheduler({
  loadModule = defaultModuleLoader,
}: {
  loadModule?: ExpoModuleLoader;
} = {}): BackgroundScheduler {
  const tasks = new Map<string, () => Promise<void>>();
  let modules: Promise<{ taskManager: TaskManagerModule; backgroundTask: BackgroundTaskModule }> | undefined;

  const loadModules = () => {
    modules ??= Promise.all([loadModule('expo-task-manager'), loadModule('expo-background-task')]).then(
      ([taskManager, backgroundTask]) => ({
        taskManager: asTaskManager(taskManager),
        backgroundTask: asBackgroundTask(backgroundTask),
      })
    );
    return modules;
  };

  return {
    async register(taskName: string, task: () => Promise<void>, options: BackgroundTaskOptions): Promise<void> {
      if (
        taskName.trim() === '' ||
        typeof task !== 'function' ||
        !Number.isFinite(options.minimumIntervalMinutes) ||
        options.minimumIntervalMinutes <= 0
      ) {
        throw new TypeError('Invalid Expo background task registration.');
      }

      const { taskManager, backgroundTask } = await loadModules();
      tasks.set(taskName, task);
      if (!taskManager.isTaskDefined(taskName)) {
        taskManager.defineTask(taskName, async () => {
          try {
            const registered = tasks.get(taskName);
            if (registered === undefined) return backgroundTask.BackgroundTaskResult.Failed;
            await registered();
            return backgroundTask.BackgroundTaskResult.Success;
          } catch {
            return backgroundTask.BackgroundTaskResult.Failed;
          }
        });
      }
      await backgroundTask.registerTaskAsync(taskName, {
        minimumInterval: options.minimumIntervalMinutes,
      });
    },

    async unregister(taskName: string): Promise<void> {
      const { backgroundTask } = await loadModules();
      await backgroundTask.unregisterTaskAsync(taskName);
      tasks.delete(taskName);
    },
  };
}
