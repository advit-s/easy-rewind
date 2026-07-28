'use strict';

/**
 * Thin standalone entry point.
 *
 * Compatibility exports remain lazy until the canonical routes replace the
 * legacy route adapter in Stage 2 Task 11. Importing this module performs no
 * I/O and never starts a listener.
 */

function createApp(options) {
  return require('./legacy-server').createApp(options);
}

function startServer(options) {
  return require('./legacy-server').startServer(options);
}

async function runStandalone() {
  let runtime;
  let shutdownPromise;
  const shutdown = () => {
    if (shutdownPromise === undefined) {
      shutdownPromise = Promise.resolve(runtime?.close()).catch(() => {
        process.exitCode = 1;
      });
    }
    return shutdownPromise;
  };
  const onSignal = () => {
    void shutdown();
  };
  try {
    runtime = await startServer();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  } catch {
    console.error('Easy Rewind backend startup failed safely.');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void runStandalone();
}

module.exports = { createApp, runStandalone, startServer };
