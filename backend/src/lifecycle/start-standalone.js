'use strict';

const { createBackendComposition } = require('./composition-root');

async function startStandalone({
  composition,
  config,
  adapters,
  dashboardDirectory,
  createComposition = createBackendComposition,
  signalSource = process,
  logger = console,
} = {}) {
  if (
    (composition === undefined && typeof createComposition !== 'function') ||
    signalSource === null ||
    typeof signalSource !== 'object' ||
    typeof signalSource.once !== 'function' ||
    typeof signalSource.removeListener !== 'function' ||
    logger === null ||
    typeof logger !== 'object' ||
    typeof logger.info !== 'function' ||
    typeof logger.error !== 'function'
  ) {
    throw new TypeError('Standalone lifecycle dependencies are invalid');
  }
  const runtime =
    composition ??
    createComposition({
      config,
      adapters,
      dashboardDirectory,
    });
  if (
    runtime === null ||
    typeof runtime !== 'object' ||
    typeof runtime.start !== 'function' ||
    typeof runtime.stop !== 'function'
  ) {
    throw new TypeError('Standalone composition is invalid');
  }
  await runtime.start();
  let shutdownPromise;
  const shutdown = () => {
    if (shutdownPromise === undefined) {
      shutdownPromise = runtime.stop().catch(() => {
        logger.error('Easy Rewind shutdown failed safely.');
        signalSource.exitCode = 1;
      });
    }
    return shutdownPromise;
  };
  const onSignal = () => {
    void shutdown();
  };
  signalSource.once('SIGINT', onSignal);
  signalSource.once('SIGTERM', onSignal);
  let disposed = false;

  logger.info('Easy Rewind backend is ready.');
  return Object.freeze({
    runtime,
    shutdown,
    disposeSignals() {
      if (disposed) return;
      disposed = true;
      signalSource.removeListener('SIGINT', onSignal);
      signalSource.removeListener('SIGTERM', onSignal);
    },
  });
}

module.exports = { startStandalone };
