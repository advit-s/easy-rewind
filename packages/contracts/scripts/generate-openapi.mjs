import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, stableJson(value[key])])
  );
}

export function listCanonicalSchemas(packageRoot) {
  const schemaRoot = join(packageRoot, 'schema');
  return readdirSync(schemaRoot)
    .filter(filename => filename.endsWith('.json'))
    .sort()
    .map(filename => ({
      filename,
      bytes: readFileSync(join(schemaRoot, filename)),
      schema: JSON.parse(readFileSync(join(schemaRoot, filename), 'utf8')),
    }));
}

function componentSchemas(packageRoot) {
  const schemas = listCanonicalSchemas(packageRoot);
  const componentByReference = new Map();

  for (const { schema } of schemas) {
    for (const name of Object.keys(schema.$defs ?? {})) {
      const reference = `${schema.$id}#/$defs/${name}`;
      if (componentByReference.has(reference)) {
        throw new Error(`Duplicate canonical schema reference: ${reference}`);
      }
      componentByReference.set(reference, name);
    }
  }

  function rewrite(value, schemaId) {
    if (Array.isArray(value)) return value.map(item => rewrite(item, schemaId));
    if (value === null || typeof value !== 'object') return value;

    const rewritten = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref') {
        const absoluteReference = child.startsWith('#') ? `${schemaId}${child}` : child;
        const componentName = componentByReference.get(absoluteReference);
        if (!componentName) throw new Error(`Unresolved canonical schema reference: ${child}`);
        rewritten.$ref = `#/components/schemas/${componentName}`;
      } else {
        rewritten[key] = rewrite(child, schemaId);
      }
    }
    return rewritten;
  }

  const components = {};
  for (const { schema } of schemas) {
    for (const [name, definition] of Object.entries(schema.$defs ?? {})) {
      if (Object.hasOwn(components, name)) {
        throw new Error(`Duplicate OpenAPI component schema name: ${name}`);
      }
      components[name] = {
        ...rewrite(definition, schema.$id),
        'x-canonical-schema-id': `${schema.$id}#/$defs/${name}`,
      };
    }
  }
  return stableJson(components);
}

function schemaReference(name) {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonContent(name) {
  return {
    content: {
      'application/json': {
        schema: schemaReference(name),
      },
    },
  };
}

function errorResponses(...statuses) {
  return Object.fromEntries(
    statuses.map(status => [
      String(status),
      {
        description: 'Safe error response.',
        ...jsonContent('ErrorResponse'),
      },
    ])
  );
}

function operation({ summary, request, response, responseStatus = 200, errors = [400, 401, 500] }) {
  return {
    summary,
    ...(request
      ? {
          requestBody: {
            required: true,
            ...jsonContent(request),
          },
        }
      : {}),
    responses: {
      [String(responseStatus)]: response
        ? { description: 'Successful response.', ...jsonContent(response) }
        : { description: 'Successful response with no body.' },
      ...errorResponses(...errors),
    },
  };
}

export function generateOpenApi(packageRoot) {
  return stableJson({
    openapi: '3.1.0',
    info: {
      title: 'Easy Rewind Local API',
      version: '1.0.0',
      description: 'Frozen local API and device synchronization contract.',
    },
    paths: {
      '/v1/health': {
        get: operation({
          summary: 'Read sanitized service readiness.',
          response: 'HealthResponse',
          errors: [500],
        }),
      },
      '/v1/session': {
        post: operation({
          summary: 'Exchange an authenticated local request for a browser session.',
          responseStatus: 204,
          errors: [400, 401, 403, 429, 500],
        }),
      },
      '/v1/pairing/challenges': {
        post: operation({
          summary: 'Create a short-lived one-use pairing challenge.',
          request: 'PairingChallengeRequest',
          response: 'PairingChallengeResponse',
          responseStatus: 201,
          errors: [400, 401, 403, 429, 500],
        }),
      },
      '/v1/pairing/confirmations': {
        post: operation({
          summary: 'Explicitly confirm a pairing challenge on the PC.',
          request: 'PairingConfirmationRequest',
          responseStatus: 204,
          errors: [400, 401, 404, 409, 429, 500],
        }),
      },
      '/v1/pairing/credentials': {
        post: operation({
          summary: 'Issue a credential for a confirmed one-use challenge.',
          request: 'PairingCredentialIssueRequest',
          response: 'PairingCredentialResponse',
          responseStatus: 201,
          errors: [400, 401, 404, 409, 429, 500],
        }),
      },
      '/v1/pairing/revocations': {
        post: operation({
          summary: 'Revoke a paired device.',
          request: 'PairingRevokeRequest',
          response: 'PairingRevokeResponse',
          errors: [400, 401, 403, 404, 409, 500],
        }),
      },
      '/v1/sync/push': {
        post: operation({
          summary: 'Push a bounded idempotent operation batch.',
          request: 'SyncPushRequest',
          response: 'SyncPushResponse',
          errors: [400, 401, 403, 409, 429, 500],
        }),
      },
      '/v1/sync/pull': {
        post: operation({
          summary: 'Pull a bounded page of changes from an opaque cursor.',
          request: 'SyncPullRequest',
          response: 'SyncPullResponse',
          errors: [400, 401, 403, 409, 429, 500],
        }),
      },
    },
    components: {
      schemas: componentSchemas(packageRoot),
    },
  });
}

export function generateOpenApiText(packageRoot) {
  return `${JSON.stringify(generateOpenApi(packageRoot), null, 2)}\n`;
}

export function computeContractChecksums(packageRoot) {
  const schemaHash = createHash('sha256');
  for (const { filename, bytes } of listCanonicalSchemas(packageRoot)) {
    schemaHash.update(filename, 'utf8');
    schemaHash.update(Uint8Array.of(0));
    schemaHash.update(bytes);
    schemaHash.update(Uint8Array.of(0));
  }
  const openApiText = generateOpenApiText(packageRoot);
  return {
    schemaBundleSha256: schemaHash.digest('hex'),
    openApiSha256: createHash('sha256').update(openApiText, 'utf8').digest('hex'),
  };
}

function runCli() {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repositoryRoot = resolve(packageRoot, '..', '..');
  const outputPath = join(repositoryRoot, 'docs', 'api', 'openapi.json');
  const generated = generateOpenApiText(packageRoot);
  const command = process.argv[2] ?? '--check';

  if (command === '--write') {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, generated, 'utf8');
    return;
  }
  if (command === '--hash') {
    process.stdout.write(`${JSON.stringify(computeContractChecksums(packageRoot))}\n`);
    return;
  }
  if (command !== '--check') throw new Error('Expected --check, --write, or --hash.');
  if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== generated) {
    throw new Error('OpenAPI drift detected. Run the generator with --write.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli();
}
