'use strict';

const { readFile, realpath } = require('node:fs/promises');
const path = require('node:path');
const { createHttpError } = require('./error-handler');

const DASHBOARD_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');
const JAVASCRIPT_CONTENT_TYPE = 'application/javascript; charset=utf-8';

function dashboardAsset(relativePath, contentType) {
  return Object.freeze({
    relativePath: Object.freeze(relativePath),
    contentType,
  });
}

const DASHBOARD_ASSETS = Object.freeze({
  '/dashboard': dashboardAsset(['dashboard.html'], 'text/html; charset=utf-8'),
  '/styles/dashboard.css': dashboardAsset(['styles', 'dashboard.css'], 'text/css; charset=utf-8'),
  '/js/api-client.js': dashboardAsset(['js', 'api-client.js'], JAVASCRIPT_CONTENT_TYPE),
  '/js/dashboard.js': dashboardAsset(['js', 'dashboard.js'], JAVASCRIPT_CONTENT_TYPE),
  '/js/dom.js': dashboardAsset(['js', 'dom.js'], JAVASCRIPT_CONTENT_TYPE),
  '/js/graph-renderer.js': dashboardAsset(['js', 'graph-renderer.js'], JAVASCRIPT_CONTENT_TYPE),
  '/js/session.js': dashboardAsset(['js', 'session.js'], JAVASCRIPT_CONTENT_TYPE),
  '/js/view-models.js': dashboardAsset(['js', 'view-models.js'], JAVASCRIPT_CONTENT_TYPE),
});
const MAX_DASHBOARD_FILE_BYTES = 5 * 1_024 * 1_024;

function validDashboardDirectory(value) {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 32_768 &&
    !value.includes('\0') &&
    path.isAbsolute(value)
  );
}

function insideDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function readDashboardAsset(dashboardDirectory, asset) {
  const canonicalDirectory = await realpath(dashboardDirectory);
  const requestedPath = path.join(canonicalDirectory, ...asset.relativePath);
  const canonicalFile = await realpath(requestedPath);
  if (!insideDirectory(canonicalDirectory, canonicalFile)) {
    throw createHttpError('not_found', 404);
  }
  const contents = await readFile(canonicalFile);
  if (contents.length > MAX_DASHBOARD_FILE_BYTES) {
    throw createHttpError('not_found', 404);
  }
  return contents;
}

function setDashboardHeaders(response, contentType, contentLength) {
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', String(contentLength));
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Expires', '0');
  response.setHeader('Content-Security-Policy', DASHBOARD_CSP);
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  response.setHeader('Content-Disposition', 'inline');
  response.setHeader('X-DNS-Prefetch-Control', 'off');
  response.removeHeader('ETag');
  response.removeHeader('Last-Modified');
}

function createDashboardRouter({ dashboardDirectory } = {}) {
  if (!validDashboardDirectory(dashboardDirectory)) {
    throw new TypeError('Dashboard directory is invalid');
  }
  const express = require('express');
  const router = express.Router();

  router.use((request, response, next) => {
    const asset = DASHBOARD_ASSETS[request.path];
    if (asset === undefined || !['GET', 'HEAD'].includes(request.method)) {
      next();
      return;
    }
    Promise.resolve()
      .then(() => readDashboardAsset(dashboardDirectory, asset))
      .then(contents => {
        setDashboardHeaders(response, asset.contentType, contents.length);
        response.status(200);
        if (request.method === 'HEAD') {
          response.end();
          return;
        }
        response.end(contents);
      })
      .catch(error => {
        next(error?.code === 'not_found' ? error : createHttpError('not_found', 404));
      });
  });
  return router;
}

module.exports = {
  DASHBOARD_ASSETS,
  DASHBOARD_CSP,
  createDashboardRouter,
};
