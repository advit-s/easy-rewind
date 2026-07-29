import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const REQUIRED_FILES = Object.freeze([
  'dashboard.html',
  'styles/dashboard.css',
  'js/dashboard.js',
  'js/api-client.js',
  'js/session.js',
  'js/dom.js',
  'js/view-models.js',
  'js/graph-renderer.js',
]);
const REQUIRED_DASHBOARD_IMPORTS = Object.freeze([
  './api-client.js',
  './session.js',
  './dom.js',
  './view-models.js',
  './graph-renderer.js',
]);
const EXPECTED_CSP = Object.freeze({
  'default-src': ["'self'"],
  'connect-src': ['http://127.0.0.1:*', 'http://localhost:*'],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'base-uri': ["'none'"],
});
const FORBIDDEN_DIRECTORIES = new Set([
  '.cache',
  '.parcel-cache',
  'artifacts',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release',
  'test-results',
]);
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.mjs']);
const SENSITIVE_PATH =
  /(?:^|\/)(?:\.env(?:\..+)?|\.npmrc|credentials\.json|secrets\.json|settings\.json)$|(?:\.(?:key|p12|pfx|pem))$/i;
const DATABASE_PATH = /\.(?:db|sqlite)(?:-(?:wal|shm))?$/i;
const BUILD_OUTPUT = /\.(?:aab|apk|exe|map|msi|zip)$/i;
const CREDENTIAL_MATERIAL =
  /(?:AIza[0-9A-Za-z_-]{35}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/=-]{24,})/;

function parseArguments(argv) {
  let frontendRoot = resolve(import.meta.dirname, '..', '..', 'frontend');
  if (argv.length === 0) return { frontendRoot };
  if (argv.length !== 2 || argv[0] !== '--frontend-root' || !argv[1] || argv[1].startsWith('--')) {
    throw new Error('Dashboard validation arguments are invalid.');
  }
  frontendRoot = resolve(argv[1]);
  return { frontendRoot };
}

function slashPath(root, target) {
  return relative(root, target).split(sep).join('/');
}

function isContained(root, target) {
  const fromRoot = relative(root, target);
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function collectFiles(root, failures) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const relativePath = slashPath(root, absolutePath);
      const metadata = lstatSync(absolutePath);
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
        failures.push(`${relativePath}: symbolic or reparse links are forbidden`);
      } else if (entry.isDirectory()) {
        if (FORBIDDEN_DIRECTORIES.has(entry.name.toLowerCase())) {
          failures.push(`${relativePath}: generated dependency or build directory is forbidden`);
        } else {
          visit(absolutePath);
        }
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        failures.push(`${relativePath}: unsupported filesystem entry`);
      }
    }
  }
  visit(root);
  return files.sort();
}

function parseCsp(value) {
  const directives = new Map();
  for (const part of value.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [name, ...sources] = tokens;
    if (directives.has(name)) throw new Error('duplicate CSP directive');
    directives.set(name, sources);
  }
  return directives;
}

function sameValues(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function validateHtml(html, failures) {
  const stylesheetReferences = [
    ...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi),
  ].map(match => match[1]);
  const scriptReferences = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi)].map(
    match => match[1]
  );
  if (!sameValues(stylesheetReferences, ['/styles/dashboard.css'])) {
    failures.push('dashboard.html: expected the exact external local stylesheet');
  }
  if (!sameValues(scriptReferences, ['/js/dashboard.js'])) {
    failures.push('dashboard.html: expected the exact external local script');
  }
  if (!/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']\/js\/dashboard\.js["'][^>]*>/i.test(html)) {
    failures.push('dashboard.html: dashboard.js must be an external module');
  }
  if (/<style(?:\s|>)/i.test(html) || /<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) {
    failures.push('dashboard.html: inline style and script blocks are forbidden');
  }
  if (/\sstyle\s*=/i.test(html) || /\son[a-z]+\s*=/i.test(html)) {
    failures.push('dashboard.html: inline style and event-handler attributes are forbidden');
  }
  if (/https?:\/\/(?!127\.0\.0\.1(?::\*)?|localhost(?::\*)?)/i.test(html)) {
    failures.push('dashboard.html: external network assets or origins are forbidden');
  }

  const csp =
    html.match(/<meta\b[^>]*\bhttp-equiv="Content-Security-Policy"[^>]*\bcontent="([^"]+)"[^>]*\/?>/i)?.[1] ?? null;
  if (csp === null) {
    failures.push('dashboard.html: strict Content Security Policy is missing');
  } else {
    try {
      const directives = parseCsp(csp);
      if (
        directives.size !== Object.keys(EXPECTED_CSP).length ||
        Object.entries(EXPECTED_CSP).some(([name, sources]) => !sameValues(directives.get(name), sources))
      ) {
        failures.push('dashboard.html: Content Security Policy is not the exact local-only policy');
      }
      if (/unsafe-inline|unsafe-eval/i.test(csp)) {
        failures.push('dashboard.html: unsafe CSP allowances are forbidden');
      }
    } catch {
      failures.push('dashboard.html: Content Security Policy is invalid');
    }
  }
}

function validateCss(css, failures) {
  if (/@import\b/i.test(css) || /url\(\s*["']?(?:https?:)?\/\//i.test(css)) {
    failures.push('styles/dashboard.css: external imports and network assets are forbidden');
  }
  if (/expression\s*\(|javascript\s*:/i.test(css)) {
    failures.push('styles/dashboard.css: executable CSS is forbidden');
  }
}

function importsFor(source) {
  const imports = [];
  const pattern = /(?:\b(?:import|export)\s+(?:[^'"]*?\s+from\s*)?|\bimport\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

function validateJavascript(root, productionFiles, failures) {
  const sources = new Map(
    productionFiles.filter(path => path.endsWith('.js')).map(path => [path, readFileSync(join(root, path), 'utf8')])
  );
  const dashboardImports = importsFor(sources.get('js/dashboard.js') ?? '');
  for (const required of REQUIRED_DASHBOARD_IMPORTS) {
    if (!dashboardImports.includes(required)) {
      failures.push(`js/dashboard.js: required module import ${required} is missing`);
    }
  }

  for (const [relativePath, source] of sources) {
    if (/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|DOMParser|document\.write|\beval\s*\(/.test(source)) {
      failures.push(`${relativePath}: forbidden DOM or code parser sink`);
    }
    if (/\.on(?:click|change|input|submit|keydown|keyup|load|error)\s*=|setAttribute\(\s*['"]on/i.test(source)) {
      failures.push(`${relativePath}: inline event handlers are forbidden`);
    }
    if (/\.style(?:\.|\[)|setAttribute\(\s*['"]style/i.test(source)) {
      failures.push(`${relativePath}: inline style mutation is forbidden`);
    }
    if (relativePath !== 'js/api-client.js' && /\bfetch\s*\(/.test(source)) {
      failures.push(`${relativePath}: direct fetch outside the API client is forbidden`);
    }
    if (
      /\blocalStorage\b|\/api\/session\b/i.test(source) ||
      (relativePath !== 'js/api-client.js' && /\bx-user-id\b/i.test(source))
    ) {
      failures.push(`${relativePath}: legacy identity or session behavior is forbidden`);
    }
    if (/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/i.test(source)) {
      failures.push(`${relativePath}: hardcoded loopback hosts or ports are forbidden`);
    }
    if (/\bconsole\.(?:debug|info|log|warn|error)\s*\(/.test(source)) {
      failures.push(`${relativePath}: production console logging is forbidden`);
    }

    for (const specifier of importsFor(source)) {
      if (
        !specifier.startsWith('./') ||
        specifier.includes('\\') ||
        specifier.split('/').includes('..') ||
        !specifier.endsWith('.js')
      ) {
        failures.push(`${relativePath}: browser imports must be dependency-free relative ESM`);
        continue;
      }
      const target = slashPath(root, resolve(dirname(join(root, relativePath)), specifier));
      if (!productionFiles.includes(target)) {
        failures.push(`${relativePath}: imported browser module is missing from the asset inventory`);
      }
    }

    const syntax = spawnSync(process.execPath, ['--check', join(root, relativePath)], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1_024,
    });
    if (syntax.status !== 0 || syntax.error) {
      failures.push(`${relativePath}: browser ESM syntax check failed`);
    }
  }
}

function validateFiles(root, canonicalRoot, files, failures) {
  const observed = new Set(files);
  for (const required of REQUIRED_FILES) {
    if (!observed.has(required)) failures.push(`${required}: required dashboard asset is missing`);
  }

  const productionFiles = files.filter(path => !path.startsWith('test/'));
  if (
    productionFiles.length !== REQUIRED_FILES.length ||
    REQUIRED_FILES.some(path => !productionFiles.includes(path))
  ) {
    failures.push('frontend: production asset inventory contains unexpected files');
  }

  for (const relativePath of files) {
    const absolutePath = resolve(root, relativePath);
    if (!isContained(root, absolutePath) || !isContained(canonicalRoot, realpathSync.native(absolutePath))) {
      failures.push(`${relativePath}: resolved path leaves the frontend root`);
      continue;
    }
    if (SENSITIVE_PATH.test(relativePath)) {
      failures.push(`${relativePath}: secret-bearing configuration file is forbidden`);
    }
    if (DATABASE_PATH.test(relativePath)) {
      failures.push(`${relativePath}: runtime database or SQLite sidecar is forbidden`);
    }
    if (BUILD_OUTPUT.test(relativePath)) {
      failures.push(`${relativePath}: generated build output is forbidden`);
    }
    if (!TEXT_EXTENSIONS.has(extname(relativePath).toLowerCase())) continue;
    const source = readFileSync(absolutePath, 'utf8');
    if (CREDENTIAL_MATERIAL.test(source)) {
      failures.push(`${relativePath}: credential material is forbidden`);
    }
  }

  const html = observed.has('dashboard.html') ? readFileSync(join(root, 'dashboard.html'), 'utf8') : '';
  const css = observed.has('styles/dashboard.css') ? readFileSync(join(root, 'styles/dashboard.css'), 'utf8') : '';
  validateHtml(html, failures);
  validateCss(css, failures);
  validateJavascript(root, productionFiles, failures);
}

function validateRootScripts(root, failures) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, '..', 'package.json'), 'utf8'));
    if (
      manifest.scripts?.['test:dashboard'] !==
      'node --test frontend/test/*.test.mjs backend/src/http/dashboard-routes.test.js'
    ) {
      failures.push('package.json: test:dashboard command is missing or unstable');
    }
    if (manifest.scripts?.['validate:dashboard'] !== 'node scripts/validation/validate-dashboard.mjs') {
      failures.push('package.json: validate:dashboard command is missing or unstable');
    }
  } catch {
    failures.push('package.json: root package manifest is invalid');
  }
}

function main() {
  try {
    const { frontendRoot } = parseArguments(process.argv.slice(2));
    const metadata = lstatSync(frontendRoot, { throwIfNoEntry: false });
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Dashboard root must be a regular directory without links.');
    }
    const canonicalRoot = realpathSync.native(frontendRoot);
    const failures = [];
    const files = collectFiles(frontendRoot, failures);
    validateFiles(frontendRoot, canonicalRoot, files, failures);
    validateRootScripts(frontendRoot, failures);

    if (failures.length > 0) {
      process.stderr.write(`Dashboard validation failed:\n${failures.join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Dashboard source validation passed (${REQUIRED_FILES.length} production assets, ${files.length} inspected files, dependency-free browser ESM).\n`
    );
  } catch (error) {
    const message =
      error instanceof Error && /^(?:Dashboard root|Dashboard validation arguments)/.test(error.message)
        ? error.message
        : 'Dashboard validation could not be completed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

main();
