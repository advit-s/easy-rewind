const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const reportMarker = 'IMPORT_SAFETY_REPORT:';

function runImportProbe({ modules, sourceRoot, mutableExportTargets = [] }) {
  assert.ok(Array.isArray(modules) && modules.length > 0, 'import probe requires at least one module');
  assert.equal(typeof sourceRoot, 'string', 'import probe requires a source root');

  const result = spawnSync(process.execPath, [join(__dirname, 'import-safety-probe-child.js')], {
    cwd: sourceRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      EASY_REWIND_IMPORT_MODULES: JSON.stringify(modules),
      EASY_REWIND_IMPORT_SOURCE_ROOT: sourceRoot,
      EASY_REWIND_IMPORT_MUTABLE_EXPORTS: JSON.stringify(mutableExportTargets),
    },
    timeout: 30_000,
    windowsHide: true,
  });
  const reportMatch = new RegExp(`${reportMarker}(\\{.*\\})`).exec(result.stdout);
  assert.notEqual(reportMatch, null, 'import-safety child did not produce a structured report');

  return {
    status: result.status,
    report: JSON.parse(reportMatch[1]),
  };
}

module.exports = { runImportProbe };
