'use strict';

const { isIP } = require('node:net');

const REMOTE_FETCH_ERROR_MESSAGES = Object.freeze({
  REMOTE_URL_INVALID: 'The remote URL is invalid.',
  REMOTE_SCHEME_UNSUPPORTED: 'The remote URL scheme is not supported.',
  REMOTE_URL_CREDENTIALS: 'Remote URLs must not contain credentials.',
  REMOTE_ADDRESS_BLOCKED: 'The remote destination is not allowed.',
  REMOTE_DNS_FAILED: 'The remote destination could not be resolved.',
  REMOTE_DNS_EMPTY: 'The remote destination did not resolve to an address.',
  REMOTE_REDIRECT_INVALID: 'The remote redirect is invalid.',
  REMOTE_REDIRECT_LOOP: 'The remote redirect looped.',
  REMOTE_REDIRECT_LIMIT: 'The remote redirect limit was exceeded.',
  REMOTE_CONNECT_TIMEOUT: 'The remote connection timed out.',
  REMOTE_TOTAL_TIMEOUT: 'The remote request timed out.',
  REMOTE_REQUEST_FAILED: 'The remote request failed.',
  REMOTE_RESPONSE_INVALID: 'The remote response is invalid.',
  REMOTE_STATUS_UNSUPPORTED: 'The remote response status is not supported.',
  REMOTE_CONTENT_TYPE_INVALID: 'The remote content type is invalid.',
  REMOTE_CONTENT_TYPE_UNSUPPORTED: 'The remote content type is not supported.',
  REMOTE_CONTENT_ENCODING_UNSUPPORTED: 'The remote content encoding is not supported.',
  REMOTE_CONTENT_ENCODING_INVALID: 'The remote content encoding is invalid.',
  REMOTE_COMPRESSED_TOO_LARGE: 'The encoded remote response is too large.',
  REMOTE_DECODED_TOO_LARGE: 'The decoded remote response is too large.',
});

class RemoteFetchError extends Error {
  constructor(code) {
    super(REMOTE_FETCH_ERROR_MESSAGES[code] ?? REMOTE_FETCH_ERROR_MESSAGES.REMOTE_REQUEST_FAILED);
    this.name = 'RemoteFetchError';
    this.code = REMOTE_FETCH_ERROR_MESSAGES[code] ? code : 'REMOTE_REQUEST_FAILED';
  }
}

function failRemoteFetch(code) {
  throw new RemoteFetchError(code);
}

function parseIPv4(address) {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(part => Number(part));
  if (octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function ipv4InRange(value, base, prefix) {
  const shift = 32 - prefix;
  return value >>> shift === parseIPv4(base) >>> shift;
}

function isBlockedIPv4(address) {
  const value = parseIPv4(address);
  if (value === null) return true;
  return [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.31.196.0', 24],
    ['192.52.193.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ].some(([base, prefix]) => ipv4InRange(value, base, prefix));
}

function parseIPv6(address) {
  let normalized = address.toLowerCase();
  if (normalized.includes('%')) return null;

  const lastColon = normalized.lastIndexOf(':');
  const possibleIPv4 = normalized.slice(lastColon + 1);
  if (possibleIPv4.includes('.')) {
    const ipv4 = parseIPv4(possibleIPv4);
    if (ipv4 === null) return null;
    const high = ((ipv4 >>> 16) & 0xffff).toString(16);
    const low = (ipv4 & 0xffff).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right = halves.length === 1 || halves[1] === '' ? [] : halves[1].split(':');
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const pieces = halves.length === 1 ? left : [...left, ...Array(missing).fill('0'), ...right];
  if (pieces.length !== 8 || pieces.some(piece => !/^[0-9a-f]{1,4}$/.test(piece))) return null;
  return pieces.reduce((value, piece) => (value << 16n) | BigInt(`0x${piece}`), 0n);
}

function ipv6InRange(value, base, prefix) {
  const baseValue = parseIPv6(base);
  const shift = BigInt(128 - prefix);
  return value >> shift === baseValue >> shift;
}

function isBlockedIPv6(address) {
  const value = parseIPv6(address);
  if (value === null) return true;
  return [
    ['::', 96],
    ['::ffff:0:0', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ].some(([base, prefix]) => ipv6InRange(value, base, prefix));
}

function normalizeAddress(address) {
  if (typeof address !== 'string' || address.length === 0 || address.trim() !== address) {
    failRemoteFetch('REMOTE_DNS_FAILED');
  }
  return address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
}

function isBlockedAddress(address) {
  const normalized = normalizeAddress(address);
  const family = isIP(normalized);
  if (family === 4) return isBlockedIPv4(normalized);
  if (family === 6) return isBlockedIPv6(normalized);
  return true;
}

function parseAndValidateRemoteUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    failRemoteFetch('REMOTE_URL_INVALID');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    failRemoteFetch('REMOTE_SCHEME_UNSUPPORTED');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    failRemoteFetch('REMOTE_URL_CREDENTIALS');
  }
  if (parsed.hostname.length === 0) failRemoteFetch('REMOTE_URL_INVALID');

  const hostname = normalizeAddress(parsed.hostname).toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home') ||
    hostname.endsWith('.lan')
  ) {
    failRemoteFetch('REMOTE_ADDRESS_BLOCKED');
  }
  if (isIP(hostname) !== 0 && isBlockedAddress(hostname)) {
    failRemoteFetch('REMOTE_ADDRESS_BLOCKED');
  }
  return parsed;
}

function assertSafeRemoteUrl(input) {
  return parseAndValidateRemoteUrl(input);
}

module.exports = {
  REMOTE_FETCH_ERROR_MESSAGES,
  RemoteFetchError,
  assertSafeRemoteUrl,
  failRemoteFetch,
  isBlockedAddress,
  parseAndValidateRemoteUrl,
};
