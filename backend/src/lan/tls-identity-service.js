'use strict';

const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SERVER_NAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

class LanTlsIdentityError extends Error {
  constructor() {
    super('The LAN TLS identity is unavailable or invalid.');
    this.name = 'LanTlsIdentityError';
    this.code = 'LAN_TLS_IDENTITY_INVALID';
  }
}

function fail() {
  throw new LanTlsIdentityError();
}

function isNonemptyBinary(value) {
  return (Buffer.isBuffer(value) || value instanceof Uint8Array) && value.byteLength > 0;
}

function createTlsIdentityService({ certificateAdapter, now = Date.now } = {}) {
  if (
    certificateAdapter === null ||
    typeof certificateAdapter !== 'object' ||
    typeof certificateAdapter.loadIdentity !== 'function' ||
    typeof certificateAdapter.inspectIdentity !== 'function' ||
    typeof now !== 'function'
  ) {
    throw new TypeError('LAN certificate dependencies are invalid');
  }

  async function load(identityReference) {
    if (typeof identityReference !== 'string' || identityReference.length < 1 || identityReference.length > 256) {
      fail();
    }
    let material;
    let inspection;
    let timestamp;
    try {
      material = await certificateAdapter.loadIdentity(identityReference);
      if (
        material === null ||
        typeof material !== 'object' ||
        !isNonemptyBinary(material.certificate) ||
        !isNonemptyBinary(material.privateKey)
      ) {
        fail();
      }
      inspection = await certificateAdapter.inspectIdentity({
        certificate: material.certificate,
        privateKey: material.privateKey,
      });
      timestamp = now();
    } catch (error) {
      if (error?.code === 'LAN_TLS_IDENTITY_INVALID') throw error;
      fail();
    }
    if (
      inspection === null ||
      typeof inspection !== 'object' ||
      inspection.keyMatches !== true ||
      !Number.isSafeInteger(inspection.validFromMs) ||
      !Number.isSafeInteger(inspection.validToMs) ||
      !Number.isSafeInteger(timestamp) ||
      timestamp < inspection.validFromMs ||
      timestamp >= inspection.validToMs ||
      !FINGERPRINT_PATTERN.test(inspection.fingerprint) ||
      material.fingerprint !== inspection.fingerprint ||
      material.credentialBoundary !== 'lan-sync' ||
      !SERVER_NAME_PATTERN.test(material.serverName)
    ) {
      fail();
    }
    return Object.freeze({
      certificate: Buffer.from(material.certificate),
      fingerprint: inspection.fingerprint,
      privateKey: Buffer.from(material.privateKey),
      serverName: material.serverName.toLowerCase(),
    });
  }

  return Object.freeze({ load });
}

module.exports = {
  LanTlsIdentityError,
  createTlsIdentityService,
};
