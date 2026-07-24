import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import process from 'node:process';

function parseExtensionRoot(argv) {
  const index = argv.indexOf('--extension-root');
  if (index >= 0 && !argv[index + 1]) {
    throw new Error('Extension root argument is missing.');
  }
  return resolve(index >= 0 ? argv[index + 1] : resolve(import.meta.dirname, '..', '..', 'extension'));
}

function collectReferences(manifest) {
  return [
    ['background.service_worker', manifest.background?.service_worker],
    ['action.default_popup', manifest.action?.default_popup],
    ...(manifest.content_scripts ?? []).flatMap((script, scriptIndex) =>
      (script.js ?? []).map((path, pathIndex) => [`content_scripts.${scriptIndex}.js.${pathIndex}`, path])
    ),
    ...Object.entries(manifest.icons ?? {}).map(([size, path]) => [`icons.${size}`, path]),
    ...Object.entries(manifest.action?.default_icon ?? {}).map(([size, path]) => [`action.default_icon.${size}`, path]),
  ];
}

function isContained(root, target) {
  const fromRoot = relative(root, target);
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function validateReference(extensionRoot, canonicalRoot, label, reference) {
  if (typeof reference !== 'string' || reference.length === 0) {
    return `${label}: expected a non-empty relative file path`;
  }
  if (
    reference.includes('\0') ||
    isAbsolute(reference) ||
    win32.isAbsolute(reference) ||
    reference.split(/[\\/]/).includes('..')
  ) {
    return `${label}: path must remain inside the extension`;
  }

  const target = resolve(extensionRoot, reference);
  if (!isContained(extensionRoot, target)) {
    return `${label}: path must remain inside the extension`;
  }
  const metadata = lstatSync(target, { throwIfNoEntry: false });
  if (!metadata || !metadata.isFile()) {
    return `${label}: referenced file is missing or is not a regular file`;
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
    if (!rootMetadata?.isDirectory()) {
      throw new Error('Extension root is not a directory.');
    }
    const canonicalRoot = realpathSync.native(extensionRoot);
    const manifest = JSON.parse(readFileSync(join(extensionRoot, 'manifest.json'), 'utf8'));
    const failures = [];

    if (manifest.manifest_version !== 3) {
      failures.push('manifest_version: extension must use Manifest V3');
    }
    const references = collectReferences(manifest);
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
