const assert = require('node:assert/strict');
const { readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const test = require('node:test');

const { runImportProbe } = require('./support/import-safety-probe');

const backendRoot = resolve(__dirname, '..');

function productionModules(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'test' || entry.name === 'tests' || entry.name === 'data'
        ? []
        : productionModules(absolutePath);
    }
    return entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') ? [absolutePath] : [];
  });
}

test('importing every backend production module is inert', () => {
  const modules = [join(backendRoot, 'server.js'), ...productionModules(join(backendRoot, 'routes'))];
  const helpersPath = join(backendRoot, 'routes', 'helpers.js');
  const result = runImportProbe({
    modules,
    sourceRoot: backendRoot,
    mutableExportTargets: [{ modulePath: helpersPath, exportName: 'config' }],
  });

  assert.equal(result.status, 0, `backend imports were not inert:\n${JSON.stringify(result.report, null, 2)}`);
  assert.equal(result.report.imported, modules.length);
  assert.equal(result.report.importError, undefined);
  assert.deepEqual(result.report.violations, []);
  assert.deepEqual(result.report.environmentMutations, []);
  assert.deepEqual(result.report.mutableConfigChanges, []);
  assert.deepEqual(result.report.newBackendHandles, []);
  assert.deepEqual(result.report.newBackendResources, []);
  assert.equal(result.report.pathsChanged, false);
});
