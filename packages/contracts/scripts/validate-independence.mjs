import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const bannedImportPatterns = [
  /^node:/,
  /(?:^|[/\\])backend(?:[/\\]|$)/i,
  /electron/i,
  /(?:^|[/\\])react(?:-native)?(?:[/\\]|$)/i,
  /jsdom/i,
];
const bannedRuntimePatterns = [/\b(?:window|document|HTMLElement|navigator)\b/, /\b(?:require|process)\s*[.(]/];

export function inspectPublicImports(packageRoot) {
  const sourceRoot = join(packageRoot, 'src');
  const findings = [];

  for (const filename of readdirSync(sourceRoot)
    .filter(name => name.endsWith('.js'))
    .sort()) {
    const text = readFileSync(join(sourceRoot, filename), 'utf8');
    const importSpecifiers = [
      ...text.matchAll(/\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g),
      ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map(match => match[1]);

    for (const specifier of importSpecifiers) {
      if (bannedImportPatterns.some(pattern => pattern.test(specifier))) {
        findings.push({ filename, kind: 'import', value: specifier });
      }
    }
    for (const pattern of bannedRuntimePatterns) {
      if (pattern.test(text)) {
        findings.push({ filename, kind: 'runtime', value: pattern.source });
      }
    }
  }

  return findings;
}
