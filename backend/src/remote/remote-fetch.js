'use strict';

const { isIP } = require('node:net');
const { brotliDecompressSync, gunzipSync, inflateSync } = require('node:zlib');
const { sanitizeHtml } = require('./html-sanitizer');
const { RemoteFetchError, failRemoteFetch, isBlockedAddress, parseAndValidateRemoteUrl } = require('./url-policy');

const DEFAULT_LIMITS = Object.freeze({
  connectTimeoutMs: 5_000,
  totalTimeoutMs: 15_000,
  maxRedirects: 4,
  maxCompressedBytes: 1_048_576,
  maxDecodedBytes: 4_194_304,
});
const ALLOWED_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SYSTEM_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => clearTimeout(handle),
});

function validateDependencies({ lookup, request, clock }) {
  if (typeof lookup !== 'function' || typeof request !== 'function') {
    throw new TypeError('Remote fetch lookup and request adapters are required.');
  }
  if (
    clock === null ||
    typeof clock !== 'object' ||
    typeof clock.now !== 'function' ||
    typeof clock.setTimeout !== 'function' ||
    typeof clock.clearTimeout !== 'function'
  ) {
    throw new TypeError('The remote fetch clock adapter is invalid.');
  }
}

function createLimits(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Remote fetch limits must be an object.');
  }
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    const permitsZero = name === 'maxRedirects';
    if (!Number.isSafeInteger(value) || value < (permitsZero ? 0 : 1)) {
      throw new TypeError('Remote fetch limits must be bounded integers.');
    }
  }
  if (limits.connectTimeoutMs > limits.totalTimeoutMs) {
    throw new TypeError('The connection timeout must not exceed the total timeout.');
  }
  return Object.freeze(limits);
}

function normalizeLookupAnswer(answer) {
  const address = typeof answer === 'string' ? answer : answer?.address;
  if (typeof address !== 'string' || isIP(address) === 0) failRemoteFetch('REMOTE_DNS_FAILED');
  if (isBlockedAddress(address)) failRemoteFetch('REMOTE_ADDRESS_BLOCKED');
  return address;
}

async function resolveDestination(url, lookup) {
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (isIP(hostname) !== 0) return hostname;

  let answers;
  try {
    answers = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    failRemoteFetch('REMOTE_DNS_FAILED');
  }
  if (!Array.isArray(answers) || answers.length === 0) failRemoteFetch('REMOTE_DNS_EMPTY');
  return answers.map(normalizeLookupAnswer)[0];
}

function normalizeHeaders(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    failRemoteFetch('REMOTE_RESPONSE_INVALID');
  }
  const headers = Object.create(null);
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      failRemoteFetch('REMOTE_RESPONSE_INVALID');
    }
    headers[name.toLowerCase()] = String(value);
  }
  return headers;
}

function validateResponse(response) {
  if (
    response === null ||
    typeof response !== 'object' ||
    !Number.isInteger(response.statusCode) ||
    response.statusCode < 100 ||
    response.statusCode > 599
  ) {
    failRemoteFetch('REMOTE_RESPONSE_INVALID');
  }
  return {
    statusCode: response.statusCode,
    headers: normalizeHeaders(response.headers),
    body: response.body,
  };
}

function disposeBody(body) {
  if (body && typeof body.destroy === 'function') {
    try {
      body.destroy();
    } catch {
      // Disposal failures do not replace the controlled primary error.
    }
  }
}

function createRequestOptions(url, address, signal) {
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return Object.freeze({
    protocol: url.protocol,
    hostname: address,
    port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    headers: Object.freeze({
      accept: 'text/html, application/xhtml+xml, text/plain;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      host: url.host,
    }),
    servername: url.protocol === 'https:' && isIP(hostname) === 0 ? hostname : undefined,
    signal,
  });
}

function requestWithConnectTimeout({ request, options, clock, timeoutMs, controller, timeoutState }) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = clock.setTimeout(() => {
      timeoutState.value = 'connect';
      controller.abort();
      reject(new RemoteFetchError('REMOTE_CONNECT_TIMEOUT'));
    }, timeoutMs);
  });
  let pending;
  try {
    pending = Promise.resolve(request(options));
  } catch {
    pending = Promise.reject(new RemoteFetchError('REMOTE_REQUEST_FAILED'));
  }
  return Promise.race([pending, timeout])
    .catch(error => {
      if (error instanceof RemoteFetchError) throw error;
      if (timeoutState.value === 'connect') failRemoteFetch('REMOTE_CONNECT_TIMEOUT');
      if (timeoutState.value === 'total') failRemoteFetch('REMOTE_TOTAL_TIMEOUT');
      failRemoteFetch('REMOTE_REQUEST_FAILED');
    })
    .finally(() => clock.clearTimeout(timer));
}

function validateContentType(headers) {
  const raw = headers['content-type'];
  if (typeof raw !== 'string' || raw.trim() === '') failRemoteFetch('REMOTE_CONTENT_TYPE_INVALID');
  const type = raw.split(';', 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) {
    failRemoteFetch('REMOTE_CONTENT_TYPE_INVALID');
  }
  if (!ALLOWED_CONTENT_TYPES.has(type)) failRemoteFetch('REMOTE_CONTENT_TYPE_UNSUPPORTED');
  return type;
}

function validateContentLength(headers, maxCompressedBytes) {
  const raw = headers['content-length'];
  if (raw === undefined) return;
  if (!/^(0|[1-9]\d*)$/.test(raw)) failRemoteFetch('REMOTE_RESPONSE_INVALID');
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) failRemoteFetch('REMOTE_RESPONSE_INVALID');
  if (length > maxCompressedBytes) failRemoteFetch('REMOTE_COMPRESSED_TOO_LARGE');
}

async function readEncodedBody(body, maxCompressedBytes) {
  if (
    body === null ||
    body === undefined ||
    (typeof body[Symbol.asyncIterator] !== 'function' && typeof body[Symbol.iterator] !== 'function')
  ) {
    failRemoteFetch('REMOTE_RESPONSE_INVALID');
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      if (!(typeof chunk === 'string' || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
        failRemoteFetch('REMOTE_RESPONSE_INVALID');
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxCompressedBytes) failRemoteFetch('REMOTE_COMPRESSED_TOO_LARGE');
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof RemoteFetchError) throw error;
    failRemoteFetch('REMOTE_REQUEST_FAILED');
  }
  return Buffer.concat(chunks, size);
}

function decodeBody(encoded, encoding, maxDecodedBytes) {
  const normalized = (encoding ?? 'identity').trim().toLowerCase();
  if (normalized.includes(',')) failRemoteFetch('REMOTE_CONTENT_ENCODING_UNSUPPORTED');
  let decoded;
  try {
    const options = { maxOutputLength: maxDecodedBytes + 1 };
    if (normalized === '' || normalized === 'identity') decoded = encoded;
    else if (normalized === 'gzip' || normalized === 'x-gzip') decoded = gunzipSync(encoded, options);
    else if (normalized === 'deflate') decoded = inflateSync(encoded, options);
    else if (normalized === 'br') decoded = brotliDecompressSync(encoded, options);
    else failRemoteFetch('REMOTE_CONTENT_ENCODING_UNSUPPORTED');
  } catch (error) {
    if (error instanceof RemoteFetchError) throw error;
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') failRemoteFetch('REMOTE_DECODED_TOO_LARGE');
    failRemoteFetch('REMOTE_CONTENT_ENCODING_INVALID');
  }
  if (decoded.length > maxDecodedBytes) failRemoteFetch('REMOTE_DECODED_TOO_LARGE');
  return decoded;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    failRemoteFetch('REMOTE_RESPONSE_INVALID');
  }
}

function redirectTarget(currentUrl, headers) {
  const location = headers.location;
  if (typeof location !== 'string' || location.trim() === '') failRemoteFetch('REMOTE_REDIRECT_INVALID');
  try {
    return new URL(location, currentUrl);
  } catch {
    failRemoteFetch('REMOTE_REDIRECT_INVALID');
  }
}

function createRemoteFetcher({ lookup, request, clock = SYSTEM_CLOCK, limits: limitOverrides = {} } = {}) {
  validateDependencies({ lookup, request, clock });
  const limits = createLimits(limitOverrides);

  async function execute(input, controller, timeoutState) {
    let currentUrl = parseAndValidateRemoteUrl(input);
    const visited = new Set();
    let redirectCount = 0;

    while (true) {
      const key = currentUrl.href;
      if (visited.has(key)) failRemoteFetch('REMOTE_REDIRECT_LOOP');
      visited.add(key);

      const address = await resolveDestination(currentUrl, lookup);
      const response = validateResponse(
        await requestWithConnectTimeout({
          request,
          options: createRequestOptions(currentUrl, address, controller.signal),
          clock,
          timeoutMs: limits.connectTimeoutMs,
          controller,
          timeoutState,
        })
      );

      if (REDIRECT_STATUSES.has(response.statusCode)) {
        disposeBody(response.body);
        if (redirectCount >= limits.maxRedirects) failRemoteFetch('REMOTE_REDIRECT_LIMIT');
        currentUrl = parseAndValidateRemoteUrl(redirectTarget(currentUrl, response.headers));
        redirectCount += 1;
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        disposeBody(response.body);
        failRemoteFetch('REMOTE_STATUS_UNSUPPORTED');
      }

      const contentType = validateContentType(response.headers);
      validateContentLength(response.headers, limits.maxCompressedBytes);
      const encoded = await readEncodedBody(response.body, limits.maxCompressedBytes);
      const decoded = decodeBody(encoded, response.headers['content-encoding'], limits.maxDecodedBytes);
      const text = decodeUtf8(decoded);
      return Object.freeze({
        statusCode: response.statusCode,
        contentType,
        body: contentType === 'text/html' || contentType === 'application/xhtml+xml' ? sanitizeHtml(text) : text,
        redirectCount,
      });
    }
  }

  return Object.freeze({
    fetch(input) {
      const controller = new AbortController();
      const timeoutState = { value: null };
      let totalTimer;
      const totalTimeout = new Promise((_, reject) => {
        totalTimer = clock.setTimeout(() => {
          timeoutState.value = 'total';
          controller.abort();
          reject(new RemoteFetchError('REMOTE_TOTAL_TIMEOUT'));
        }, limits.totalTimeoutMs);
      });
      return Promise.race([execute(input, controller, timeoutState), totalTimeout])
        .catch(error => {
          if (error instanceof RemoteFetchError) throw error;
          failRemoteFetch('REMOTE_REQUEST_FAILED');
        })
        .finally(() => clock.clearTimeout(totalTimer));
    },
  });
}

module.exports = {
  DEFAULT_LIMITS,
  RemoteFetchError,
  createRemoteFetcher,
};
