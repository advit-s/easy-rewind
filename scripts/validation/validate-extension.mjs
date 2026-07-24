import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path';
import process from 'node:process';

function parseExtensionRoot(argv) {
  const index = argv.indexOf('--extension-root');
  if (index >= 0 && !argv[index + 1]) {
    throw new Error('Extension root argument is missing.');
  }
  return resolve(index >= 0 ? argv[index + 1] : resolve(import.meta.dirname, '..', '..', 'extension'));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isContained(root, target) {
  const fromRoot = relative(root, target);
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function hasLinkedComponent(absolutePath) {
  const anchor = parse(absolutePath).root;
  const components = absolutePath.slice(anchor.length).split(sep).filter(Boolean);
  let current = anchor;
  for (const component of components) {
    current = join(current, component);
    const metadata = lstatSync(current, { throwIfNoEntry: false });
    if (!metadata) return false;
    if (metadata.isSymbolicLink()) return true;
  }
  return false;
}

function validateSchema(manifest) {
  const failures = [];
  if (!isPlainObject(manifest)) return ['manifest: expected a plain object'];
  if (manifest.manifest_version !== 3) {
    failures.push('manifest_version: extension must use Manifest V3');
  }
  for (const field of ['name', 'version']) {
    if (typeof manifest[field] !== 'string' || manifest[field].length === 0) {
      failures.push(`${field}: expected a non-empty string`);
    }
  }
  for (const field of ['background', 'action']) {
    if (!isPlainObject(manifest[field])) {
      failures.push(`${field}: expected a plain object`);
    }
  }
  if (
    isPlainObject(manifest.background) &&
    (typeof manifest.background.service_worker !== 'string' || manifest.background.service_worker.length === 0)
  ) {
    failures.push('background.service_worker: expected a non-empty string');
  }
  if (
    isPlainObject(manifest.action) &&
    (typeof manifest.action.default_popup !== 'string' || manifest.action.default_popup.length === 0)
  ) {
    failures.push('action.default_popup: expected a non-empty string');
  }
  for (const [field, value] of [
    ['icons', manifest.icons],
    ['action.default_icon', isPlainObject(manifest.action) ? manifest.action.default_icon : undefined],
  ]) {
    if (value !== undefined && !isPlainObject(value)) {
      failures.push(`${field}: expected a plain object`);
    } else if (isPlainObject(value)) {
      for (const [key, path] of Object.entries(value)) {
        if (typeof path !== 'string' || path.length === 0) {
          failures.push(`${field}.${key}: expected a non-empty string`);
        }
      }
    }
  }
  if (manifest.content_scripts !== undefined && !Array.isArray(manifest.content_scripts)) {
    failures.push('content_scripts: expected an array');
  } else {
    for (const [index, script] of (manifest.content_scripts ?? []).entries()) {
      if (!isPlainObject(script)) {
        failures.push(`content_scripts.${index}: expected a plain object`);
      } else if (!Array.isArray(script.js)) {
        failures.push(`content_scripts.${index}.js: expected an array`);
      } else {
        for (const [pathIndex, path] of script.js.entries()) {
          if (typeof path !== 'string' || path.length === 0) {
            failures.push(`content_scripts.${index}.js.${pathIndex}: expected a non-empty string`);
          }
        }
      }
    }
  }
  return failures;
}

function collectReferences(manifest) {
  return [
    ['background.service_worker', manifest.background.service_worker],
    ['action.default_popup', manifest.action.default_popup],
    ...(manifest.content_scripts ?? []).flatMap((script, scriptIndex) =>
      script.js.map((path, pathIndex) => [`content_scripts.${scriptIndex}.js.${pathIndex}`, path])
    ),
    ...Object.entries(manifest.icons ?? {}).map(([size, path]) => [`icons.${size}`, path]),
    ...Object.entries(manifest.action.default_icon ?? {}).map(([size, path]) => [`action.default_icon.${size}`, path]),
  ];
}

function validateReference(extensionRoot, canonicalRoot, label, reference) {
  if (
    reference.includes('\0') ||
    reference.includes('\\') ||
    /%[0-9a-f]{2}/i.test(reference) ||
    /^[a-z][a-z0-9+.-]*:/i.test(reference) ||
    reference.includes('://') ||
    isAbsolute(reference) ||
    win32.isAbsolute(reference) ||
    reference.split('/').some(segment => segment === '.' || segment === '..')
  ) {
    return `${label}: path must be an unambiguous relative extension path`;
  }

  const target = resolve(extensionRoot, reference);
  if (!isContained(extensionRoot, target)) {
    return `${label}: path must remain inside the extension`;
  }
  const metadata = lstatSync(target, { throwIfNoEntry: false });
  if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()) {
    return `${label}: referenced file is missing or is not a regular file`;
  }
  if (hasLinkedComponent(target)) {
    return `${label}: referenced path contains a symbolic or reparse link`;
  }

  const canonicalTarget = realpathSync.native(target);
  if (!isContained(canonicalRoot, canonicalTarget)) {
    return `${label}: resolved path must remain inside the extension`;
  }
  return null;
}

function main() {
  try {
    const extensionRoot = parseExtensionRoot(process.argv.slice(2));
    const rootMetadata = lstatSync(extensionRoot, { throwIfNoEntry: false });
    if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink() || hasLinkedComponent(extensionRoot)) {
      throw new Error('Extension root path is invalid or ambiguous.');
    }
    const canonicalRoot = realpathSync.native(extensionRoot);
    const manifestPath = join(extensionRoot, 'manifest.json');
    const manifestMetadata = lstatSync(manifestPath, { throwIfNoEntry: false });
    if (
      !manifestMetadata?.isFile() ||
      manifestMetadata.isSymbolicLink() ||
      hasLinkedComponent(manifestPath) ||
      !isContained(canonicalRoot, realpathSync.native(manifestPath))
    ) {
      process.stderr.write('manifest.json: expected an in-root regular file without links\n');
      process.exitCode = 1;
      return;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const failures = validateSchema(manifest);
    const references = failures.length === 0 ? collectReferences(manifest) : [];
    for (const [label, reference] of references) {
      const failure = validateReference(extensionRoot, canonicalRoot, label, reference);
      if (failure) failures.push(failure);
    }

    if (failures.length > 0) {
      process.stderr.write(`Extension validation failed:\n${failures.join('\n')}\n`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`Extension baseline validation passed (${references.length} references).\n`);
  } catch (error) {
    const message =
      error instanceof SyntaxError
        ? 'Extension manifest is not valid JSON.'
        : error instanceof Error && /^Extension root/.test(error.message)
          ? error.message
          : 'Extension validation could not be completed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

main();
