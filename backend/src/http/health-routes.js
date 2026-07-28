'use strict';

function createHealthRouter({ health } = {}) {
  if (typeof health !== 'function') throw new TypeError('health function is required');
  const express = require('express');
  const router = express.Router();
  router.get('/v1/health', async (_request, response, next) => {
    try {
      const report = await health();
      response.setHeader('Cache-Control', 'no-store');
      response.status(200).json(report);
    } catch (error) {
      next(error);
    }
  });
  return router;
}

module.exports = { createHealthRouter };
