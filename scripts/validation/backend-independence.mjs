import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const sourceExtensions = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx']);
const electronImport =
  /(?:\brequire\s*\(\s*['"](?:node:)?electron['"]\s*\)|\bimport\s*\(\s*['"](?:node:)?electron['"]\s*\)|\bimport(?:[\s\S]*?\bfrom\s*)?['"](?:node:)?electron['"])/m;

function extension(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot) : '';
}

function label(root, path) {
  return relative(root, path).split(sep).join('/');
}

export function inspectBackendElectronImports(root) {
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('Backend source root must be a regular directory.');
  }

  const matches = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Backend source links are not allowed: ${label(root, path)}`);
      }
      if (metadata.isDirectory()) {
        if (!['data', 'node_modules', 'tests'].includes(entry.name)) pending.push(path);
      } else if (
        metadata.isFile() &&
        sourceExtensions.has(extension(entry.name)) &&
        electronImport.test(readFileSync(path, 'utf8'))
      ) {
        matches.push(label(root, path));
      }
    }
  }
  return matches.sort((left, right) => left.localeCompare(right));
}
