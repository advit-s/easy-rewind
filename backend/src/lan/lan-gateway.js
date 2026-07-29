'use strict';

const { createTlsIdentityService } = require('./tls-identity-service');

const DEFAULT_LIMITS = Object.freeze({
  drainTimeoutMs: 5_000,
  maxBatchSize: 100,
  maxBodyBytes: 100 * 1_024,
  requestTimeoutMs: 10_000,
});
const PROXY_HEADERS = Object.freeze([
  'forwarded',
  'proxy-authorization',
  'proxy-connection',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
]);
const ERROR_RESPONSES = Object.freeze({
  batch_too_large: [413, 'The synchronization batch is too large.'],
  content_type_invalid: [415, 'JSON content is required.'],
  device_credential_invalid: [401, 'A valid paired-device credential is required.'],
  device_revoked: [403, 'The paired device has been revoked.'],
  host_mismatch: [421, 'The requested LAN identity does not match.'],
  invalid_json: [400, 'The JSON request body is invalid.'],
  invalid_request_target: [400, 'The request target is invalid.'],
  not_found: [404, 'The requested resource was not found.'],
  rate_limited: [429, 'Too many LAN requests.'],
  request_timed_out: [408, 'The LAN request timed out.'],
  request_too_large: [413, 'The LAN request is too large.'],
  source_forbidden: [403, 'The request source is not allowed.'],
  tls_required: [426, 'TLS is required.'],
  unexpected_error: [500, 'The LAN request could not be completed.'],
});

class LanGatewayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LanGatewayError';
    this.code = code;
  }
}

function configurationError(code, message) {
  throw new LanGatewayError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeIpv4Address(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.toLowerCase().startsWith('::ffff:') ? value.slice(7) : value;
  const parts = candidate.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9][0-9]{0,2})$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.some(octet => octet > 255) ? null : octets;
}

function isPrivateAddress(value) {
  const ipv4 = normalizeIpv4Address(value);
  if (ipv4 !== null) {
    return (
      ipv4[0] === 10 || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) || (ipv4[0] === 192 && ipv4[1] === 168)
    );
  }
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/^\[|\]$/g, '').toLowerCase();
  const first = normalized.split(':', 1)[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false;
  const prefix = Number.parseInt(first, 16);
  return prefix >= 0xfc00 && prefix <= 0xfdff;
}

function validateLimit(value, fallback, maximum) {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new TypeError('LAN gateway limits are invalid');
  }
  return normalized;
}

function validateEnabledDependencies({
  certificateAdapter,
  config,
  httpsServerAdapter,
  now,
  pairingService,
  requestTracker,
  syncService,
}) {
  if (
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65_535 ||
    typeof config.tlsIdentityRef !== 'string' ||
    config.tlsIdentityRef.length < 1 ||
    config.pairingPolicy?.mode !== 'explicit-confirmation' ||
    config.allowedSubnetPolicy?.mode !== 'private-lan-only' ||
    certificateAdapter === null ||
    typeof certificateAdapter !== 'object' ||
    httpsServerAdapter === null ||
    typeof httpsServerAdapter !== 'object' ||
    pairingService === null ||
    typeof pairingService !== 'object' ||
    syncService === null ||
    typeof syncService !== 'object' ||
    requestTracker === null ||
    typeof requestTracker !== 'object' ||
    typeof now !== 'function'
  ) {
    throw new TypeError('LAN gateway dependencies are invalid');
  }
  for (const name of ['close', 'createSecureServer', 'drain', 'listen', 'resolveBindAddress', 'stopAccepting']) {
    if (typeof httpsServerAdapter[name] !== 'function') {
      throw new TypeError('LAN HTTPS server adapter is invalid');
    }
  }
  for (const name of ['authenticateDevice', 'bootstrap']) {
    if (typeof pairingService[name] !== 'function') throw new TypeError('LAN pairing service is invalid');
  }
  for (const name of ['acknowledge', 'pull', 'push', 'snapshot']) {
    if (typeof syncService[name] !== 'function') throw new TypeError('LAN sync service is invalid');
  }
  if (typeof requestTracker.allow !== 'function') throw new TypeError('LAN request tracker is invalid');
}

function responseJson(response, status, value) {
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.end(JSON.stringify(value));
}

function errorJson(response, code) {
  const [status, message] = ERROR_RESPONSES[code] ?? ERROR_RESPONSES.unexpected_error;
  responseJson(response, status, { error: { code, message } });
}

function invalidRequestTarget(request) {
  const target = request.url;
  if (
    typeof target !== 'string' ||
    target.length < 1 ||
    target.length > 2_048 ||
    !target.startsWith('/') ||
    target.startsWith('//') ||
    target.includes('\\') ||
    /%2e|%2f|%5c/i.test(target) ||
    /(?:^|\/)\.\.(?:\/|$)/.test(target)
  ) {
    return true;
  }
  if (PROXY_HEADERS.some(header => request.headers?.[header] !== undefined)) return true;
  const connection = request.headers?.connection;
  return (
    request.headers?.upgrade !== undefined ||
    (typeof connection === 'string' &&
      connection
        .toLowerCase()
        .split(/\s*,\s*/)
        .includes('upgrade'))
  );
}

function validHostAndSni(request, serverName, port) {
  const host = request.headers?.host;
  const sni = request.socket?.servername;
  return (
    typeof host === 'string' &&
    host.toLowerCase() === `${serverName}:${port}` &&
    typeof sni === 'string' &&
    sni.toLowerCase() === serverName
  );
}

function readJsonBody(request, { maxBodyBytes, requestTimeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks = [];
    const finish = operation => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      operation();
    };
    const timeout = setTimeout(() => {
      request.destroy?.();
      finish(() => reject(new LanGatewayError('request_timed_out')));
    }, requestTimeoutMs);
    timeout.unref?.();
    request.on('data', chunk => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBodyBytes) {
        request.destroy?.();
        finish(() => reject(new LanGatewayError('request_too_large')));
        return;
      }
      chunks.push(bytes);
    });
    request.once('error', () => finish(() => reject(new LanGatewayError('invalid_json'))));
    request.once('end', () => {
      finish(() => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!isPlainObject(parsed)) throw new TypeError('JSON object required');
          resolve(parsed);
        } catch {
          reject(new LanGatewayError('invalid_json'));
        }
      });
    });
  });
}

function authErrorCode(error) {
  if (error?.code === 'AUTH_DEVICE_REVOKED') return 'device_revoked';
  if (typeof error?.code === 'string' && (error.code.startsWith('AUTH_') || error.code.startsWith('PAIRING_'))) {
    return 'device_credential_invalid';
  }
  return 'unexpected_error';
}

function createLanGateway({
  certificateAdapter,
  config,
  httpsServerAdapter,
  now = Date.now,
  pairingService,
  requestTracker,
  syncService,
} = {}) {
  if (!isPlainObject(config) || typeof config.enabled !== 'boolean') {
    throw new TypeError('LAN gateway configuration is invalid');
  }
  if (!config.enabled) {
    return Object.freeze({
      health: () => Object.freeze({ status: 'disabled' }),
      start: async () => undefined,
      stop: async () => undefined,
    });
  }

  validateEnabledDependencies({
    certificateAdapter,
    config,
    httpsServerAdapter,
    now,
    pairingService,
    requestTracker,
    syncService,
  });
  const limits = Object.freeze({
    drainTimeoutMs: validateLimit(config.drainTimeoutMs, DEFAULT_LIMITS.drainTimeoutMs, 60_000),
    maxBatchSize: validateLimit(config.maxBatchSize, DEFAULT_LIMITS.maxBatchSize, 1_000),
    maxBodyBytes: validateLimit(config.maxBodyBytes, DEFAULT_LIMITS.maxBodyBytes, 10 * 1_024 * 1_024),
    requestTimeoutMs: validateLimit(config.requestTimeoutMs, DEFAULT_LIMITS.requestTimeoutMs, 60_000),
  });
  const identityService = createTlsIdentityService({ certificateAdapter, now });
  let state = 'created';
  let server;
  let identity;
  let bindAddress;
  let startPromise;
  let stopPromise;

  async function handleRequest(request, response) {
    try {
      if (request.socket?.encrypted !== true) {
        errorJson(response, 'tls_required');
        return;
      }
      if (request.socket?.localAddress !== bindAddress || !isPrivateAddress(request.socket?.remoteAddress)) {
        errorJson(response, 'source_forbidden');
        return;
      }
      if (!validHostAndSni(request, identity.serverName, config.port)) {
        errorJson(response, 'host_mismatch');
        return;
      }
      if (invalidRequestTarget(request)) {
        errorJson(response, 'invalid_request_target');
        return;
      }
      const target = new URL(request.url, `https://${identity.serverName}:${config.port}`);
      const path = target.pathname;
      let allowed;
      try {
        allowed = await requestTracker.allow({
          now: now(),
          route: path,
          source: request.socket.remoteAddress,
        });
      } catch {
        allowed = false;
      }
      if (allowed !== true) {
        errorJson(response, 'rate_limited');
        return;
      }
      if (request.method === 'GET' && path === '/health' && target.search === '') {
        responseJson(response, 200, { protocolVersion: '1', status: 'ok' });
        return;
      }

      const needsBody = request.method === 'POST';
      let body;
      if (needsBody) {
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers?.['content-type'] ?? '')) {
          errorJson(response, 'content_type_invalid');
          return;
        }
        try {
          body = await readJsonBody(request, limits);
        } catch (error) {
          errorJson(response, ERROR_RESPONSES[error?.code] === undefined ? 'invalid_json' : error.code);
          return;
        }
      }

      if (request.method === 'POST' && path === '/v1/pairing/bootstrap' && target.search === '') {
        const result = await pairingService.bootstrap({
          body,
          source: request.socket.remoteAddress,
          tlsFingerprint: identity.fingerprint,
        });
        responseJson(response, 200, result);
        return;
      }

      const routeOperations = {
        'GET /v1/sync/pull': 'pull',
        'GET /v1/sync/snapshot': 'snapshot',
        'POST /v1/sync/acknowledge': 'acknowledge',
        'POST /v1/sync/push': 'push',
      };
      const operation = routeOperations[`${request.method} ${path}`];
      if (operation === undefined) {
        errorJson(response, 'not_found');
        return;
      }
      if (operation === 'push' && (!Array.isArray(body.operations) || body.operations.length > limits.maxBatchSize)) {
        errorJson(response, 'batch_too_large');
        return;
      }

      let auth;
      try {
        auth = await pairingService.authenticateDevice({
          authorization: request.headers?.authorization,
          transport: 'lan',
        });
      } catch (error) {
        errorJson(response, authErrorCode(error));
        return;
      }
      if (
        !isPlainObject(auth) ||
        auth.authenticationType !== 'sync_device' ||
        typeof auth.deviceId !== 'string' ||
        typeof auth.profileId !== 'string'
      ) {
        errorJson(response, 'device_credential_invalid');
        return;
      }
      const result = await syncService[operation]({
        auth: Object.freeze({
          deviceId: auth.deviceId,
          profileId: auth.profileId,
        }),
        body,
        query: Object.freeze(Object.fromEntries(target.searchParams)),
      });
      responseJson(response, 200, result);
    } catch {
      errorJson(response, 'unexpected_error');
    }
  }

  async function performStart() {
    state = 'starting';
    try {
      identity = await identityService.load(config.tlsIdentityRef);
      bindAddress = await httpsServerAdapter.resolveBindAddress(config.allowedSubnetPolicy);
      if (!isPrivateAddress(bindAddress)) {
        configurationError('LAN_BIND_ADDRESS_FORBIDDEN', 'LAN sync requires a private bind address.');
      }
      server = httpsServerAdapter.createSecureServer({
        certificate: identity.certificate,
        maxHeaderBytes: 16 * 1_024,
        privateKey: identity.privateKey,
        requestHandler: handleRequest,
        requestTimeoutMs: limits.requestTimeoutMs,
      });
      if (server === null || typeof server !== 'object' || server.secure !== true || server.protocol !== 'https:') {
        configurationError('LAN_TLS_REQUIRED', 'The LAN listener must use HTTPS.');
      }
      await httpsServerAdapter.listen(server, { host: bindAddress, port: config.port });
      state = 'running';
      return gateway;
    } catch (error) {
      if (server !== undefined) {
        try {
          await httpsServerAdapter.close(server);
        } catch {
          // Preserve the startup failure.
        }
      }
      server = undefined;
      identity = undefined;
      bindAddress = undefined;
      state = 'failed';
      throw error;
    } finally {
      startPromise = undefined;
    }
  }

  function start() {
    if (state === 'running') return Promise.resolve(gateway);
    if (startPromise !== undefined) return startPromise;
    if (state === 'stopping') return Promise.reject(new Error('LAN gateway is stopping.'));
    stopPromise = undefined;
    startPromise = performStart();
    return startPromise;
  }

  async function performStop() {
    state = 'stopping';
    let firstError;
    const attempt = async operation => {
      try {
        await operation();
      } catch (error) {
        firstError ??= error;
      }
    };
    if (server !== undefined) {
      await attempt(() => httpsServerAdapter.stopAccepting(server));
      await attempt(() => httpsServerAdapter.drain(server, { timeoutMs: limits.drainTimeoutMs }));
      await attempt(() => httpsServerAdapter.close(server));
    }
    server = undefined;
    identity = undefined;
    bindAddress = undefined;
    state = 'stopped';
    startPromise = undefined;
    if (firstError) throw firstError;
  }

  function stop() {
    if (stopPromise !== undefined) return stopPromise;
    if (state === 'created' || state === 'stopped') return Promise.resolve();
    if (state === 'starting' && startPromise !== undefined) {
      stopPromise = startPromise.then(performStop, () => undefined);
    } else if (state === 'failed') {
      state = 'stopped';
      stopPromise = Promise.resolve();
    } else {
      stopPromise = performStop();
    }
    return stopPromise;
  }

  function health() {
    return Object.freeze({ status: state === 'running' ? 'ready' : 'unavailable' });
  }

  const gateway = Object.freeze({ health, start, stop });
  return gateway;
}

module.exports = {
  LanGatewayError,
  createLanGateway,
  isPrivateAddress,
};
