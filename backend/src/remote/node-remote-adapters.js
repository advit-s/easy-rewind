'use strict';

const { request: defaultHttpRequest } = require('node:http');
const { request: defaultHttpsRequest } = require('node:https');
const { lookup: defaultLookup } = require('node:dns').promises;

function createNodeRemoteAdapters({
  lookup = defaultLookup,
  httpRequest = defaultHttpRequest,
  httpsRequest = defaultHttpsRequest,
} = {}) {
  if (typeof lookup !== 'function' || typeof httpRequest !== 'function' || typeof httpsRequest !== 'function') {
    throw new TypeError('Node remote adapter dependencies are invalid.');
  }

  function request(options) {
    if (options === null || typeof options !== 'object' || !['http:', 'https:'].includes(options.protocol)) {
      return Promise.reject(new TypeError('Remote request options are invalid.'));
    }
    const implementation = options.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      let outgoing;
      let settled = false;

      const finish = (operation, value) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener?.('abort', onAbort);
        operation(value);
      };
      const onAbort = () => {
        try {
          outgoing?.destroy?.();
        } catch {
          // The sanitized abort remains authoritative.
        }
        finish(reject, new Error('Remote request was aborted.'));
      };
      try {
        outgoing = implementation(options);
        if (
          outgoing === null ||
          typeof outgoing !== 'object' ||
          typeof outgoing.once !== 'function' ||
          typeof outgoing.end !== 'function'
        ) {
          finish(reject, new Error('Remote request failed.'));
          return;
        }
        outgoing.once('response', incoming => finish(resolve, incoming));
        outgoing.once('error', () => finish(reject, new Error('Remote request failed.')));
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        options.signal?.addEventListener?.('abort', onAbort, { once: true });
        outgoing.end();
      } catch {
        finish(reject, new Error('Remote request failed.'));
      }
    });
  }

  return Object.freeze({ lookup, request });
}

module.exports = { createNodeRemoteAdapters };
