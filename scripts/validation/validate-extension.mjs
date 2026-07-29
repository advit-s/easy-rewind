import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path';
import process from 'node:process';

const EXPECTED_PERMISSIONS = Object.freeze(['activeTab', 'alarms', 'contextMenus', 'notifications', 'storage']);
const EXPECTED_HOST_PERMISSIONS = Object.freeze(['http://127.0.0.1/*', 'http://localhost/*']);
const EXPECTED_CSP = "script-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'";
const EXPECTED_CONTENT_MATCHES = Object.freeze(['http://*/*', 'https://*/*']);
const EXPECTED_WEB_RESOURCES = Object.freeze(['content.js', 'src/message-contracts.js', 'src/privacy-policy.js']);
const OMITTED_PACKAGE_PATHS = new Set(['generate-icons.js', 'icons/icon.svg']);
const OMITTED_PACKAGE_DIRECTORIES = new Set(['test']);
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.mjs']);

function parseArguments(argv) {
  let extensionRoot = resolve(import.meta.dirname, '..', '..', 'extension');
  let packageOutput = null;
  let strictPackage = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--extension-root' || argument === '--package-output') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(
          argument === '--extension-root'
            ? 'Extension root argument is missing.'
            : 'Package output argument is missing.'
        );
      }
      if (argument === '--extension-root') extensionRoot = resolve(value);
      else packageOutput = resolve(value);
      index += 1;
    } else if (argument === '--package') {
      strictPackage = true;
    } else {
      throw new Error('Extension validation arguments are invalid.');
    }
  }

  return {
    extensionRoot,
    packageOutput,
    strictPackage: strictPackage || packageOutput !== null,
  };
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
    typeof reference !== 'string' ||
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

function sameStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function validateStrictManifest(manifest) {
  const failures = [];
  if (manifest.background?.type !== 'module') {
    failures.push('background.type: service worker must be an ES module');
  }
  if (!sameStrings(manifest.permissions, EXPECTED_PERMISSIONS)) {
    failures.push('permissions: expected the exact executable-code-used permission set');
  }
  if (!sameStrings(manifest.host_permissions, EXPECTED_HOST_PERMISSIONS)) {
    failures.push('host_permissions: expected exact loopback-only HTTP access');
  }
  if (JSON.stringify(manifest).includes('<all_urls>')) {
    failures.push('manifest: broad <all_urls> access is forbidden');
  }
  if (manifest.content_security_policy?.extension_pages !== EXPECTED_CSP) {
    failures.push('content_security_policy.extension_pages: expected the strict local-only policy');
  }

  const scripts = manifest.content_scripts;
  if (
    !Array.isArray(scripts) ||
    scripts.length !== 1 ||
    !sameStrings(scripts[0]?.matches, EXPECTED_CONTENT_MATCHES) ||
    !sameStrings(scripts[0]?.js, ['content-loader.js']) ||
    scripts[0]?.run_at !== 'document_idle'
  ) {
    failures.push('content_scripts: expected the http/https-only classic module loader');
  }

  const resources = manifest.web_accessible_resources;
  if (
    !Array.isArray(resources) ||
    resources.length !== 1 ||
    !sameStrings(resources[0]?.resources, EXPECTED_WEB_RESOURCES) ||
    !sameStrings(resources[0]?.matches, EXPECTED_CONTENT_MATCHES) ||
    resources[0]?.use_dynamic_url !== true
  ) {
    failures.push('web_accessible_resources: expected the exact dynamic content-module graph');
  }
  return failures;
}

function extensionOf(path) {
  const index = path.lastIndexOf('.');
  return index < 0 ? '' : path.slice(index).toLowerCase();
}

function collectPackageFiles(root) {
  const files = [];

  function visit(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (prefix === '' && entry.isDirectory() && OMITTED_PACKAGE_DIRECTORIES.has(entry.name)) {
        continue;
      }
      if (OMITTED_PACKAGE_PATHS.has(relativePath)) continue;

      const absolutePath = join(directory, entry.name);
      const metadata = lstatSync(absolutePath);
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
        throw new Error('Extension package contains a symbolic or reparse link.');
      }
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error('Extension package contains an unsupported filesystem entry.');
      }
    }
  }

  visit(root, '');
  return files.sort();
}

function validateLocalCodeReferences(extensionRoot, files) {
  const failures = [];
  const packagedFiles = new Set(files);
  const importPattern = /(?:\b(?:import|export)\s+(?:[^'"]*?\s+from\s*)?|\bimport\s*\()\s*['"]([^'"]+)['"]/g;
  const runtimeUrlPattern = /\bchrome\.runtime\.getURL\(\s*['"]([^'"]+)['"]\s*\)/g;
  const htmlReferencePattern = /<(?:script|img)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;

  for (const relativePath of files) {
    const extension = extensionOf(relativePath);
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const content = readFileSync(join(extensionRoot, relativePath), 'utf8');
    const references = [];

    if (extension === '.js' || extension === '.mjs') {
      for (const match of content.matchAll(importPattern)) {
        if (match[1].startsWith('.')) {
          references.push(resolve(dirname(join(extensionRoot, relativePath)), match[1]));
        } else if (/^[a-z][a-z0-9+.-]*:/i.test(match[1]) || match[1].startsWith('//')) {
          failures.push(`${relativePath}: remotely hosted code is forbidden`);
        }
      }
      for (const match of content.matchAll(runtimeUrlPattern)) {
        references.push(resolve(extensionRoot, match[1]));
      }
    } else if (extension === '.html') {
      for (const match of content.matchAll(htmlReferencePattern)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(match[1]) || match[1].startsWith('//')) {
          failures.push(`${relativePath}: remotely hosted code or assets are forbidden`);
        } else {
          references.push(resolve(dirname(join(extensionRoot, relativePath)), match[1]));
        }
      }
    }

    for (const reference of references) {
      const fromRoot = relative(extensionRoot, reference).split(sep).join('/');
      if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith('../') || !packagedFiles.has(fromRoot)) {
        failures.push(`${relativePath}: missing local code reference`);
      }
    }
  }
  return failures;
}

function validatePackageContent(extensionRoot, files) {
  const failures = [];
  const credentialMaterial =
    /(?:AIza[0-9A-Za-z_-]{35}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/=-]{16,})/;

  for (const relativePath of files) {
    const lowerPath = relativePath.toLowerCase();
    if (
      lowerPath.endsWith('.map') ||
      /(?:^|\/)\.(?:env|npmrc)(?:\.|$)/.test(lowerPath) ||
      /\.(?:key|p12|pfx|pem)$/.test(lowerPath)
    ) {
      failures.push(`${relativePath}: source map or secret-bearing file is forbidden`);
      continue;
    }

    if (!TEXT_EXTENSIONS.has(extensionOf(relativePath))) continue;
    const content = readFileSync(join(extensionRoot, relativePath), 'utf8');
    if (/sourceMappingURL\s*=/.test(content)) {
      failures.push(`${relativePath}: source map references are forbidden`);
    }
    if (credentialMaterial.test(content)) {
      failures.push(`${relativePath}: credential material is forbidden`);
    }
    if (/\b(?:https?:)?\/\/[^'"\s)]+\.js(?:[?#][^'"\s)]*)?/i.test(content)) {
      failures.push(`${relativePath}: remotely hosted code is forbidden`);
    }
    if (extensionOf(relativePath) === '.html' && /<[^>]+\son[a-z]+\s*=/i.test(content)) {
      failures.push(`${relativePath}: inline event handlers are forbidden`);
    }
    if (extensionOf(relativePath) === '.js' || extensionOf(relativePath) === '.mjs') {
      if (/\.(?:innerHTML|outerHTML)\b|insertAdjacentHTML\s*\(|document\.write\s*\(/.test(content)) {
        failures.push(`${relativePath}: unsafe HTML sink is forbidden`);
      }
      if (relativePath !== 'src/api-client.js' && /\bfetch\s*\(/.test(content)) {
        failures.push(`${relativePath}: direct fetch outside src/api-client.js is forbidden`);
      }
    }
  }

  failures.push(...validateLocalCodeReferences(extensionRoot, files));
  return failures;
}

function copyPackage(sourceRoot, destinationRoot, files) {
  if (lstatSync(destinationRoot, { throwIfNoEntry: false })) {
    throw new Error('Package output must not already exist.');
  }
  mkdirSync(destinationRoot, { recursive: true });
  for (const relativePath of files) {
    const source = join(sourceRoot, relativePath);
    const destination = join(destinationRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

function validateRoot(extensionRoot, strictPackage) {
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
    return {
      failures: ['manifest.json: expected an in-root regular file without links'],
      files: [],
      references: [],
    };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const failures = validateSchema(manifest);
  const references = failures.length === 0 ? collectReferences(manifest) : [];
  for (const [label, reference] of references) {
    const failure = validateReference(extensionRoot, canonicalRoot, label, reference);
    if (failure) failures.push(failure);
  }

  let files = [];
  if (strictPackage && failures.length === 0) {
    failures.push(...validateStrictManifest(manifest));
    files = collectPackageFiles(extensionRoot);
    failures.push(...validatePackageContent(extensionRoot, files));
  }
  return { failures, files, references };
}

function main() {
  let cleanupRoot = null;
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = validateRoot(options.extensionRoot, options.strictPackage);

    if (result.failures.length > 0) {
      process.stderr.write(`Extension validation failed:\n${result.failures.join('\n')}\n`);
      process.exitCode = 1;
      return;
    }

    if (options.strictPackage) {
      let destination = options.packageOutput;
      if (destination === null) {
        cleanupRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-extension-validation-'));
        destination = join(cleanupRoot, 'package');
      }
      copyPackage(options.extensionRoot, destination, result.files);
      const packagedResult = validateRoot(destination, true);
      if (packagedResult.failures.length > 0) {
        process.stderr.write(`Extension validation failed:\n${packagedResult.failures.join('\n')}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `Packaged extension validation passed (${packagedResult.files.length} files, ${packagedResult.references.length} manifest references).\n`
      );
    } else {
      process.stdout.write(`Extension baseline validation passed (${result.references.length} references).\n`);
    }
  } catch (error) {
    const message =
      error instanceof SyntaxError
        ? 'Extension manifest is not valid JSON.'
        : error instanceof Error &&
            /^(?:Extension root|Package output|Extension validation arguments|Extension package)/.test(error.message)
          ? error.message
          : 'Extension validation could not be completed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    if (cleanupRoot) rmSync(cleanupRoot, { recursive: true, force: true });
  }
}

main();
