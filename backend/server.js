'use strict';

const { resolve } = require('node:path');
const { startStandalone } = require('./src/lifecycle/start-standalone');

function parsePort(value) {
  if (value === undefined || value === '') return 3210;
  if (!/^[1-9][0-9]*$/.test(value)) throw new TypeError('Standalone port is invalid');
  const port = Number(value);
  if (port > 65_535) throw new TypeError('Standalone port is invalid');
  return port;
}

function createStandaloneConfigFromEnvironment(environment = process.env) {
  if (environment === null || typeof environment !== 'object') {
    throw new TypeError('Standalone environment is invalid');
  }
  const localAppData = environment.LOCALAPPDATA;
  if (typeof localAppData !== 'string' || localAppData.trim().length === 0) {
    throw new TypeError('Windows local application data is unavailable');
  }
  const storageRoot = resolve(environment.EASY_REWIND_STORAGE_ROOT || resolve(localAppData, 'easy-rewind', 'runtime'));
  return {
    mode: 'standalone',
    storageRoot,
    applicationApi: {
      enabled: true,
      host: '127.0.0.1',
      port: parsePort(environment.EASY_REWIND_PORT),
    },
    scheduler: {
      enabled: environment.EASY_REWIND_SCHEDULERS_ENABLED !== 'false',
    },
    lanSync: { enabled: false },
  };
}

async function runStandalone({
  config,
  adapters,
  dashboardDirectory = resolve(__dirname, '..', 'frontend'),
  createPlatformAdapters = options => {
    const { createStandaloneWindowsPlatformAdapters } = require('../desktop/windows-platform-adapters');
    return createStandaloneWindowsPlatformAdapters(options);
  },
  environment = process.env,
  signalSource = process,
  logger = console,
  start = startStandalone,
} = {}) {
  try {
    const resolvedConfig = config ?? createStandaloneConfigFromEnvironment(environment);
    const resolvedAdapters =
      adapters ??
      createPlatformAdapters({
        localAppData: environment.LOCALAPPDATA,
      });
    return await start({
      adapters: resolvedAdapters,
      config: resolvedConfig,
      dashboardDirectory,
      logger,
      signalSource,
    });
  } catch {
    logger.error('Easy Rewind backend startup failed safely.');
    signalSource.exitCode = 1;
    return undefined;
  }
}

if (require.main === module) {
  void runStandalone();
}

module.exports = {
  createStandaloneConfigFromEnvironment,
  runStandalone,
  startStandalone,
};
