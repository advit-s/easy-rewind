/**
 * easy-rewind Learning Assistant - Express Backend Server
 *
 * Importing this module is intentionally inert. Call createApp() to compose
 * the Express application or startServer() to open production resources.
 */

const path = require('node:path');

function createApp(options = {}) {
  const express = require('express');
  const cors = require('cors');
  const rateLimit = require('express-rate-limit');
  const apiRoutes = require('./routes/api');
  const app = express();
  const rateLimitStores = [];
  const rateLimitsEnabled = options.rateLimitsEnabled !== false;
  const requestLogging = options.requestLogging !== false;

  const corsOptions = {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (origin.startsWith('chrome-extension://')) return callback(null, true);

      const allowedOrigins = [
        'http://localhost:3000',
        'http://localhost:5000',
        'http://127.0.0.1:5000',
        'http://127.0.0.1:3000',
      ];
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS policy: Origin ${origin} not allowed`));
    },
    methods: ['GET', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'],
    credentials: true,
  };
  app.use(cors(corsOptions));

  if (rateLimitsEnabled) {
    const generalStore = new rateLimit.MemoryStore();
    const aiStore = new rateLimit.MemoryStore();
    rateLimitStores.push(generalStore, aiStore);
    app.use(
      rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 200,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests. Please wait a few minutes and try again.' },
        store: generalStore,
      })
    );
    app.use(
      '/api/quick-lookup',
      rateLimit({
        windowMs: 60 * 1000,
        limit: 10,
        message: { error: 'Too many AI lookups. Please wait a moment.' },
        store: aiStore,
      })
    );
  }

  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('X-XSS-Protection', '1; mode=block');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' http://localhost:*"
    );
    next();
  });

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true }));

  if (requestLogging) {
    app.use((request, response, next) => {
      const start = Date.now();
      const timestamp = new Date().toISOString();
      response.on('finish', () => {
        const duration = Date.now() - start;
        const marker = response.statusCode >= 500 ? 'ERROR' : response.statusCode >= 400 ? 'WARN' : 'OK';
        console.log(
          `[${marker}] [${timestamp}] ${request.method} ${request.originalUrl} -> ${response.statusCode} (${duration}ms)`
        );
      });
      next();
    });
  }

  app.use(express.static(path.join(__dirname, '..', 'frontend')));
  app.get('/dashboard', (_request, response) => {
    response.sendFile(path.join(__dirname, '..', 'frontend', 'dashboard.html'));
  });
  app.get('/', (_request, response) => {
    response.redirect('/dashboard');
  });

  app.use('/api', apiRoutes);
  app.use((error, _request, response, _next) => {
    console.error('[Server Error]', error.message);
    if (error.message && error.message.startsWith('CORS policy')) {
      return response.status(403).json({ error: 'Request blocked by CORS policy.' });
    }
    response.status(500).json({
      error: 'Internal server error. Please try again.',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  });
  app.use((request, response) => {
    response.status(404).json({ error: `Route ${request.method} ${request.path} not found.` });
  });

  let appClosed = false;
  app.locals.close = () => {
    if (appClosed) return;
    appClosed = true;
    for (const store of rateLimitStores) store.shutdown();
  };
  return app;
}

function startSchedulers(origin) {
  const axios = require('axios');
  const intervals = [];

  intervals.push(
    setInterval(
      async () => {
        try {
          await axios.post(
            `${origin}/api/check-reminders`,
            {},
            { headers: { 'Content-Type': 'application/json', 'x-user-id': 'system' } }
          );
        } catch {
          // Server self-check is best effort.
        }
      },
      2 * 60 * 1000
    )
  );

  intervals.push(
    setInterval(
      async () => {
        try {
          const { config, loadSettings, saveSettings } = require('./routes/helpers');
          loadSettings();
          const prefs = config.digestPrefs || {};
          if (!prefs.enabled) return;

          const now = new Date();
          if (now.getDay() !== (prefs.day_of_week ?? 0) || now.getHours() !== (prefs.hour ?? 9)) return;
          const today = now.toISOString().slice(0, 10);
          if (prefs.last_digest_at?.startsWith(today) || now.getMinutes() > 15) return;

          await axios.post(
            `${origin}/api/digest/generate`,
            {},
            { headers: { 'Content-Type': 'application/json', 'x-user-id': 'system' } }
          );
          prefs.last_digest_at = now.toISOString();
          config.digestPrefs = prefs;
          saveSettings();
          console.log(`[Digest] Auto-generated weekly digest at ${now.toISOString()}`);
        } catch {
          // Digest generation is best effort.
        }
      },
      60 * 60 * 1000
    )
  );

  return intervals;
}

function listen(app, port, host) {
  let listener;
  return new Promise((resolve, reject) => {
    const removeStartupListeners = () => {
      listener?.removeListener('error', onError);
      listener?.removeListener('listening', onListening);
    };
    const onError = error => {
      removeStartupListeners();
      try {
        listener.close(() => reject(error));
      } catch {
        reject(error);
      }
    };
    const onListening = () => {
      removeStartupListeners();
      resolve(listener);
    };

    try {
      listener = host ? app.listen(port, host) : app.listen(port);
      listener.once('error', onError);
      listener.once('listening', onListening);
    } catch (error) {
      removeStartupListeners();
      reject(error);
    }
  });
}

async function closeRuntimeResources({ app, closeDb, intervals = [], server }) {
  let cleanupError;
  for (const interval of intervals) clearInterval(interval);

  try {
    if (server?.listening) {
      await new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  } catch (error) {
    cleanupError = error;
  }

  try {
    app?.locals.close?.();
  } catch (error) {
    cleanupError ||= error;
  }

  try {
    closeDb();
  } catch (error) {
    cleanupError ||= error;
  }

  if (cleanupError) throw cleanupError;
}

async function startServer(options = {}) {
  require('dotenv').config();
  const { closeDb, resetRuntimeState } = require('./routes/helpers');
  let app;
  let server;
  let intervals = [];

  try {
    resetRuntimeState();
    app = options.app || createApp(options);
    const port = Number.parseInt(options.port ?? process.env.PORT ?? '5000', 10);
    const host = options.host;
    server = await listen(app, port, host);
    const address = server.address();
    const actualPort = typeof address === 'object' ? address.port : port;
    const origin = `http://127.0.0.1:${actualPort}`;
    const schedulersEnabled = options.schedulersEnabled ?? process.env.EASY_REWIND_SCHEDULERS_ENABLED !== 'false';
    intervals = schedulersEnabled ? startSchedulers(origin) : [];
    let closePromise;

    console.log(`[Server] API listening at ${origin}/api`);
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
      console.warn('WARNING: Gemini API key not configured; AI quick-lookup will use fallback responses.');
    }

    return {
      app,
      server,
      origin,
      close() {
        if (!closePromise) {
          closePromise = closeRuntimeResources({ app, closeDb, intervals, server });
        }
        return closePromise;
      },
    };
  } catch (startupError) {
    try {
      await closeRuntimeResources({ app, closeDb, intervals, server });
    } catch {
      // Preserve the startup error after best-effort cleanup.
    }
    throw startupError;
  }
}

if (require.main === module) {
  startServer().catch(error => {
    console.error('[Server Startup Error]', error.message);
    process.exitCode = 1;
  });
}

module.exports = { createApp, startServer };
