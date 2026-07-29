'use strict';

const { randomUUID } = require('node:crypto');
const { dirname } = require('node:path');
const { createAiService } = require('../ai/ai-service');
const { createGeminiProvider } = require('../ai/gemini-provider');
const { createProviderRegistry } = require('../ai/provider-registry');
const { createBrowserSessionService } = require('../auth/browser-session-service');
const { createInstallTokenService } = require('../auth/install-token-service');
const { createPairingService } = require('../auth/pairing-service');
const { createConfig } = require('../config/create-config');
const { createContentRepository } = require('../domain/content/content-repository');
const { createContentService } = require('../domain/content/content-service');
const { createGraphRepository } = require('../domain/graph/graph-repository');
const { createGraphService } = require('../domain/graph/graph-service');
const { createLearningRepository } = require('../domain/learning/learning-repository');
const { createLearningService } = require('../domain/learning/learning-service');
const { createReminderRepository } = require('../domain/reminders/reminder-repository');
const { createReminderService } = require('../domain/reminders/reminder-service');
const { createReminderWorker } = require('../domain/reminders/reminder-worker');
const { createRepositoryUtils } = require('../domain/repository-utils');
const { createResearchRepository } = require('../domain/research/research-repository');
const { createResearchService } = require('../domain/research/research-service');
const { createSettingsService } = require('../domain/settings/settings-service');
const { createApp } = require('../http/create-app');
const { createBackupService } = require('../import-export/backup-service');
const { createExportService } = require('../import-export/export-service');
const { createImportService } = require('../import-export/import-service');
const { createNodeArtifactPathAdapter, createNodeArtifactStore } = require('../import-export/node-artifact-store');
const { createJobRepository } = require('../jobs/job-repository');
const { createJobRunner } = require('../jobs/job-runner');
const { createLanGateway } = require('../lan/lan-gateway');
const { createSecretStore } = require('../platform/secret-store');
const { createNodeRemoteAdapters } = require('../remote/node-remote-adapters');
const { createRemoteFetcher } = require('../remote/remote-fetch');
const { createStage3CompatibilityService } = require('../routes/stage3-compatibility-service');
const { createConflictService } = require('../sync/conflict-service');
const { createEntityRegistry } = require('../sync/entity-registry');
const { createSnapshotService } = require('../sync/snapshot-service');
const { createSqliteEntityAdapters } = require('../sync/sqlite-entity-adapters');
const { createSyncRepository } = require('../sync/sync-repository');
const { createSyncService } = require('../sync/sync-service');
const { createAuthBootstrap } = require('./auth-bootstrap');
const { createRuntime } = require('./create-runtime');

function requireAdapter(value, methods, message) {
  if (value === null || typeof value !== 'object' || methods.some(method => typeof value[method] !== 'function')) {
    throw new TypeError(message);
  }
  return value;
}

async function createCanonicalRouteDependencies({
  database,
  generateId = randomUUID,
  now = Date.now,
  secretStore,
  serviceFactories = {},
} = {}) {
  requireAdapter(database, ['prepare', 'transaction'], 'A canonical database is required');
  requireAdapter(secretStore, ['get', 'set', 'delete'], 'A protected secret store is required');
  const installFactory = serviceFactories.createInstallTokenService ?? createInstallTokenService;
  const browserFactory = serviceFactories.createBrowserSessionService ?? createBrowserSessionService;
  const pairingFactory = serviceFactories.createPairingService ?? createPairingService;
  const bootstrapFactory = serviceFactories.createAuthBootstrap ?? createAuthBootstrap;
  for (const factory of [installFactory, browserFactory, pairingFactory, bootstrapFactory]) {
    if (typeof factory !== 'function') throw new TypeError('Authentication service factories are invalid');
  }

  const sharedOptions = { db: database, generateId, now, secretStore };
  const installTokenService = await installFactory(sharedOptions);
  const browserSessionService = await browserFactory(sharedOptions);
  const pairingService = await pairingFactory(sharedOptions);
  const authBootstrap = await bootstrapFactory({
    ...sharedOptions,
    installTokenService,
  });
  requireAdapter(authBootstrap, ['getAuthorization', 'initialize'], 'Authentication bootstrap is invalid');
  await authBootstrap.initialize();
  return Object.freeze({
    authBootstrap,
    browserSessionService,
    installTokenService,
    pairingService,
  });
}

function createSyncRecorder({ entityRegistry, repository, now }) {
  const tombstoneRetentionMs = 30 * 24 * 60 * 60 * 1000;
  return Object.freeze({
    recordChange({ profileId, entityType, entityId, revision, changeKind = 'upsert', payload, record } = {}) {
      const kind = changeKind === 'delete' ? 'delete' : 'upsert';
      let canonicalPayload = payload ?? record ?? {};
      if (kind === 'upsert' && entityRegistry.supports(entityType)) {
        canonicalPayload =
          entityRegistry.get({
            profileId,
            entityType,
            entityId,
          })?.payload ?? canonicalPayload;
      }
      return repository.recordChange({
        profileId,
        entityType,
        entityId,
        revision,
        kind,
        payload: kind === 'delete' ? {} : canonicalPayload,
        tombstoneExpiresAt: kind === 'delete' ? now() + tombstoneRetentionMs : null,
      });
    },
  });
}

function createInProcessLeaseAdapter() {
  const active = new Set();
  return Object.freeze({
    async withLease(key, work) {
      if (active.has(key)) return false;
      active.add(key);
      try {
        return await work();
      } finally {
        active.delete(key);
      }
    },
  });
}

function createDisabledNotifier() {
  return Object.freeze({
    async deliver() {
      throw new Error('No reminder notification adapter is configured.');
    },
  });
}

function createImportExportDependencies({ database, config, adapters, now, ids }) {
  const artifactFilePermissions = adapters.artifactFilePermissions;
  const pathAdapter =
    adapters.importExportPathAdapter ??
    createNodeArtifactPathAdapter({
      exportsRoot: config.paths.exports,
      backupsRoot: config.paths.backups,
    });
  const artifactStore =
    adapters.artifactStore ??
    createNodeArtifactStore({
      exportsRoot: config.paths.exports,
      backupsRoot: config.paths.backups,
      filePermissions: artifactFilePermissions,
    });
  const backupPermissions =
    adapters.backupPermissions ??
    Object.freeze({
      restrict: reference => artifactFilePermissions.restrictFile(reference),
    });
  requireAdapter(artifactStore, ['writeAtomic', 'read', 'remove'], 'Import/export artifact storage is invalid');
  requireAdapter(pathAdapter, ['exportReference', 'backupReference'], 'Import/export path configuration is invalid');
  requireAdapter(backupPermissions, ['restrict'], 'Import/export backup permissions are invalid');
  const backupService = createBackupService({
    artifactStore,
    pathAdapter,
    filePermissions: backupPermissions,
    now,
    ids,
  });
  return {
    backupService,
    exportService: createExportService({ db: database, artifactStore, pathAdapter, now, ids }),
    importService: createImportService({ db: database, backupService, now, ids }),
  };
}

function createLanPairingAdapter(pairingService) {
  return Object.freeze({
    authenticateDevice: input => pairingService.authenticateDevice(input),
    bootstrap({ body, tlsFingerprint } = {}) {
      if (body?.action === 'request') {
        return pairingService.createChallenge({
          profileId: body.profileId,
          deviceName: body.deviceName,
          platform: body.platform,
          syncEndpoint: body.syncEndpoint,
          tlsFingerprint,
          installationId: body.installationId,
        });
      }
      if (body?.action === 'issue') {
        return pairingService.issueCredential({ challengeId: body.challengeId });
      }
      throw new TypeError('LAN pairing request is invalid');
    },
  });
}

function createLanSyncAdapter(syncService) {
  function context(auth) {
    return Object.freeze({
      authenticationType: 'sync_device',
      deviceId: auth.deviceId,
      profileId: auth.profileId,
    });
  }
  return Object.freeze({
    acknowledge({ auth, body } = {}) {
      return syncService.acknowledge({
        profileId: auth?.profileId,
        deviceId: auth?.deviceId,
        sequence: body?.sequence,
      });
    },
    pull({ auth, body, query } = {}) {
      const request = body ?? {
        deviceId: query?.deviceId,
        cursor: query?.cursor,
        limit: query?.limit === undefined ? undefined : Number(query.limit),
      };
      return syncService.pull({ context: context(auth), request });
    },
    push({ auth, body } = {}) {
      return syncService.push({ context: context(auth), request: body });
    },
    snapshot({ auth } = {}) {
      return syncService.createSnapshot({
        profileId: auth?.profileId,
        deviceId: auth?.deviceId,
      });
    },
  });
}

async function createStage3RouteDependencies({
  database,
  secretStore,
  config,
  adapters = {},
  serviceFactories = {},
} = {}) {
  requireAdapter(database, ['prepare', 'transaction'], 'A canonical database is required');
  requireAdapter(secretStore, ['get', 'set', 'delete'], 'A protected secret store is required');
  if (config === null || typeof config !== 'object' || config.paths === null || typeof config.paths !== 'object') {
    throw new TypeError('Canonical storage configuration is required');
  }
  const now = adapters.now ?? Date.now;
  const ids = adapters.ids ?? randomUUID;
  if (typeof now !== 'function' || typeof ids !== 'function') {
    throw new TypeError('Canonical clock and identifier adapters are invalid');
  }

  const authentication = await createCanonicalRouteDependencies({
    database,
    generateId: ids,
    now,
    secretStore,
    serviceFactories,
  });
  const repositoryUtils = createRepositoryUtils({ db: database, ids, now });
  const syncRepository = createSyncRepository({ db: database, ids, now });
  const entityRegistry = createEntityRegistry({
    adapters: createSqliteEntityAdapters({ db: database, now }),
  });
  const conflictService = createConflictService({
    db: database,
    repository: syncRepository,
    entityRegistry,
    ids,
    now,
  });
  const snapshotService = createSnapshotService({
    db: database,
    repository: syncRepository,
    entityRegistry,
    ids,
    now,
  });
  const syncService = createSyncService({
    db: database,
    entityRegistry,
    repository: syncRepository,
    conflicts: conflictService,
    snapshots: snapshotService,
    now,
  });
  const syncRecorder = createSyncRecorder({
    entityRegistry,
    repository: syncRepository,
    now,
  });

  const contentRepository = createContentRepository({ db: database, repositoryUtils });
  const graphRepository = createGraphRepository({ db: database, repositoryUtils });
  const learningRepository = createLearningRepository({ db: database, repositoryUtils });
  const reminderRepository = createReminderRepository({ db: database, repositoryUtils });
  const researchRepository = createResearchRepository({ db: database, repositoryUtils });
  const jobRepository = createJobRepository({ db: database, ids, now });
  const contentService = createContentService({ repository: contentRepository, syncRecorder });
  const graphService = createGraphService({ repository: graphRepository, syncRecorder });
  const learningService = createLearningService({ repository: learningRepository, syncRecorder });
  const reminderService = createReminderService({
    repository: reminderRepository,
    jobs: jobRepository,
    syncRecorder,
    now,
    ids,
  });
  const settingsService = createSettingsService({
    db: database,
    ids,
    now,
    syncRecorder,
  });

  const remoteAdapters = adapters.remoteAdapters ?? createNodeRemoteAdapters();
  requireAdapter(remoteAdapters, ['lookup', 'request'], 'Remote acquisition adapters are invalid');
  const remoteFetcher = createRemoteFetcher(remoteAdapters);
  const geminiProvider = adapters.geminiProvider ?? createGeminiProvider();
  const providerRegistry = createProviderRegistry({
    secretStore,
    providers: { gemini: geminiProvider },
  });
  const aiService = createAiService({ registry: providerRegistry, jobs: jobRepository, now });
  const researchService = createResearchService({
    repository: researchRepository,
    jobs: jobRepository,
    remoteFetcher,
    aiService,
  });
  const reminderWorker = createReminderWorker({
    repository: reminderRepository,
    notifier: adapters.reminderNotifier ?? createDisabledNotifier(),
    leases: adapters.reminderLeases ?? createInProcessLeaseAdapter(),
    now,
  });
  const jobRunner = createJobRunner({
    repository: jobRepository,
    handlers: {
      'ai.generate': (payload, context) => aiService.execute(payload, context),
      reminder_delivery: async (payload, context) => {
        await reminderWorker.runOnce({ profileId: context.profileId });
        const delivery = reminderRepository.getDelivery(context.profileId, payload.deliveryId);
        if (delivery.state === 'pending') throw new Error('Reminder delivery will be retried.');
        return { deliveryId: delivery.id, state: delivery.state };
      },
      'research.run': (payload, context) => researchService.run(payload, context),
    },
    workerId: adapters.workerId ?? `backend-${process.pid}`,
    now,
  });
  const importExport = createImportExportDependencies({ database, config, adapters, now, ids });
  const compatibilityService = (adapters.createCompatibilityService ?? createStage3CompatibilityService)({
    database,
    contentService,
    graphService,
    learningService,
    reminderService,
    researchService,
    settingsService,
    aiService,
    now,
    ...importExport,
  });

  return Object.freeze({
    ...authentication,
    ...importExport,
    aiService,
    compatibilityService,
    contentService,
    graphService,
    jobRunner,
    learningService,
    providerRegistry,
    reminderService,
    researchService,
    settingsService,
    syncService,
  });
}

function storageDirectories(config) {
  return [
    config.storageRoot,
    dirname(config.paths.database),
    dirname(config.paths.settings),
    dirname(config.paths.runtimeState),
    config.paths.logs,
    config.paths.exports,
    config.paths.backups,
    config.paths.migrationWork,
  ].filter((path, index, paths) => paths.indexOf(path) === index);
}

async function prepareCanonicalStorage(config, filePermissions) {
  const { mkdir } = require('node:fs/promises');
  for (const directory of storageDirectories(config)) {
    await mkdir(directory, { recursive: true });
    await filePermissions.restrictDirectory(directory);
  }
}

function defaultMigrateDatabase(database) {
  const { discoverMigrations, runMigrations } = require('../database/migration-runner');
  return runMigrations({ db: database, migrations: discoverMigrations() });
}

function createBackendComposition({ config: configInput, adapters = {}, dashboardDirectory } = {}) {
  if (adapters === null || typeof adapters !== 'object' || Array.isArray(adapters)) {
    throw new TypeError('Composition adapters are invalid');
  }
  const secretStoreAdapter = requireAdapter(
    adapters.secretStoreAdapter,
    ['get', 'set', 'delete'],
    'A protected secret-store adapter is required'
  );
  const filePermissions = requireAdapter(
    adapters.filePermissions,
    ['restrictDirectory', 'restrictFile'],
    'A restrictive file-permission adapter is required'
  );
  const config = createConfig(configInput);
  const secretStore = createSecretStore(secretStoreAdapter);
  const migrateDatabase = adapters.migrateDatabase ?? defaultMigrateDatabase;
  const createRouteDependencies =
    adapters.createRouteDependencies ??
    (options =>
      createStage3RouteDependencies({
        ...options,
        adapters,
        serviceFactories: adapters.serviceFactories,
      }));
  const applicationFactory = adapters.createApplication ?? createApp;
  const prepareStorage = adapters.prepareStorage ?? prepareCanonicalStorage;
  for (const operation of [migrateDatabase, createRouteDependencies, applicationFactory, prepareStorage]) {
    if (typeof operation !== 'function') throw new TypeError('Composition factory adapters are invalid');
  }

  let routeDependencies;
  const configuredSchedulerJobs = Array.isArray(adapters.schedulerJobs) ? [...adapters.schedulerJobs] : [];
  const schedulerJobs = [...configuredSchedulerJobs];
  const lanGatewayFactory =
    adapters.createLanGateway ??
    (({ config: lanConfig }) => {
      if (!lanConfig.enabled) return createLanGateway({ config: lanConfig });
      if (routeDependencies === undefined) {
        throw new TypeError('LAN services must be constructed before the gateway');
      }
      return createLanGateway({
        certificateAdapter: adapters.lanCertificateAdapter,
        config: lanConfig,
        httpsServerAdapter: adapters.lanHttpsServerAdapter,
        now: adapters.now ?? Date.now,
        pairingService: adapters.lanPairingService ?? createLanPairingAdapter(routeDependencies.pairingService),
        requestTracker: adapters.lanRequestTracker,
        syncService: adapters.lanSyncService ?? createLanSyncAdapter(routeDependencies.syncService),
      });
    });
  const runtime = createRuntime(config, {
    ...adapters,
    createLanGateway: lanGatewayFactory,
    filePermissions,
    schedulerJobs,
    async migrateDatabase(database) {
      const migration = await migrateDatabase(database);
      routeDependencies = await createRouteDependencies({ database, secretStore, config });
      if (routeDependencies === null || typeof routeDependencies !== 'object') {
        throw new TypeError('Route dependencies are invalid');
      }
      schedulerJobs.splice(0, schedulerJobs.length, ...configuredSchedulerJobs);
      if (routeDependencies.jobRunner !== undefined) {
        requireAdapter(routeDependencies.jobRunner, ['runOnce'], 'Canonical job runner is invalid');
        schedulerJobs.push({
          name: 'durable-jobs',
          intervalMs: 1_000,
          run: () => routeDependencies.jobRunner.runOnce(),
        });
      }
      return migration;
    },
    createApplication({ database, health }) {
      if (routeDependencies === undefined) {
        throw new TypeError('Route dependencies must be constructed before the application');
      }
      return applicationFactory({
        database,
        dashboardDirectory,
        health,
        routeDependencies,
      });
    },
  });

  let lifecycleState = 'created';
  let startPromise;
  let stopPromise;

  const composition = Object.freeze({
    config,
    getInstallAuthorization() {
      if (lifecycleState !== 'running') {
        return Promise.reject(new Error('Backend composition is not running.'));
      }
      return Promise.resolve().then(async () => {
        requireAdapter(
          routeDependencies?.authBootstrap,
          ['getAuthorization'],
          'Authentication bootstrap is unavailable'
        );
        const authorization = await routeDependencies.authBootstrap.getAuthorization();
        if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/.test(authorization)) {
          throw new TypeError('Authentication bootstrap returned invalid authorization');
        }
        return authorization;
      });
    },
    health: runtime.health,
    start() {
      if (lifecycleState === 'running') return Promise.resolve(composition);
      if (startPromise !== undefined) return startPromise;
      if (lifecycleState === 'stopping') {
        return Promise.reject(new Error('Backend composition is stopping.'));
      }
      stopPromise = undefined;
      lifecycleState = 'starting';
      startPromise = Promise.resolve()
        .then(() => prepareStorage(config, filePermissions))
        .then(() => runtime.start())
        .then(() => {
          lifecycleState = 'running';
          return composition;
        })
        .catch(error => {
          lifecycleState = 'failed';
          throw error;
        })
        .finally(() => {
          startPromise = undefined;
        });
      return startPromise;
    },
    state() {
      return lifecycleState;
    },
    stop() {
      if (stopPromise !== undefined) return stopPromise;
      if (lifecycleState === 'created' || lifecycleState === 'stopped') return Promise.resolve();
      lifecycleState = 'stopping';
      const waitForStart = startPromise?.catch(() => undefined) ?? Promise.resolve();
      stopPromise = waitForStart
        .then(() => runtime.stop())
        .finally(() => {
          lifecycleState = 'stopped';
          startPromise = undefined;
        });
      return stopPromise;
    },
  });
  return composition;
}

module.exports = {
  createBackendComposition,
  createCanonicalRouteDependencies,
  createStage3RouteDependencies,
  prepareCanonicalStorage,
};
