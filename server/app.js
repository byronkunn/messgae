import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { openDb } from './db.js';
import { Hub } from './lib/realtime.js';
import { BlobStore } from './lib/storage.js';
import { createLimiter } from './lib/ratelimit.js';
import { HttpError } from './lib/http.js';
import { attachAuth, authenticateUpgrade } from './lib/auth.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import userRoutes from './routes/users.js';
import conversationRoutes from './routes/conversations.js';
import messageRoutes from './routes/messages.js';
import fileRoutes from './routes/files.js';
import linkRoutes from './routes/links.js';
import spaceRoutes from './routes/spaces.js';
import exploreRoutes from './routes/explore.js';
import notificationRoutes from './routes/notifications.js';
import reportRoutes from './routes/reports.js';
import adminRoutes from './routes/admin.js';
import inviteRoutes from './routes/invites.js';
import { registerRealtimeHandlers } from './routes/realtime.js';

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' ws: wss:",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  if (config.isProd) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
}

/**
 * CSRF protection for the JSON API: state-changing requests must carry a custom
 * header (which browsers cannot send cross-site without a CORS preflight we never
 * approve) and, when present, an allowed Origin. Cookies are also SameSite=Lax.
 */
function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'messgae') {
    return next(new HttpError(403, 'csrf', 'Missing request verification header.'));
  }
  const origin = req.get('origin');
  if (origin && !config.allowedOrigins.includes(origin) && origin !== config.publicOrigin) {
    return next(new HttpError(403, 'csrf', 'Cross-origin request rejected.'));
  }
  next();
}

export function createApp({ dbFile, dataDir } = {}) {
  const root = dataDir || config.dataDir;
  const db = openDb(dbFile ?? path.join(root, 'messgae.db'));
  const hub = new Hub();
  const blobs = new BlobStore(path.join(root, 'blobs'));
  const limiter = createLimiter();
  const ctx = { db, hub, blobs, limiter, config, startedAt: Date.now() };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.use(securityHeaders);
  app.use(cookieParser());
  app.use('/api', express.json({ limit: '256kb' }));
  app.use('/api', csrfGuard);
  app.use('/api', attachAuth(ctx));
  // Global API rate limit as a backstop; sensitive routes add stricter limits.
  app.use('/api', limiter.middleware('api', config.isTest ? 100_000 : 1200, 60_000));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes(ctx));
  app.use('/api/me', meRoutes(ctx));
  app.use('/api/users', userRoutes(ctx));
  app.use('/api/conversations', conversationRoutes(ctx));
  app.use('/api/messages', messageRoutes(ctx));
  app.use('/api/files', fileRoutes(ctx));
  app.use('/api', linkRoutes(ctx));
  app.use('/api/spaces', spaceRoutes(ctx));
  app.use('/api/explore', exploreRoutes(ctx));
  app.use('/api/notifications', notificationRoutes(ctx));
  app.use('/api/reports', reportRoutes(ctx));
  app.use('/api/invites', inviteRoutes(ctx));
  app.use('/api/admin', adminRoutes(ctx));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'Endpoint not found.')));

  // Production: serve the built client with SPA fallback.
  const dist = path.join(config.root, 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err?.code === 'LIMIT_FILE_SIZE') err = new HttpError(413, 'too_large', 'File is larger than your upload limit.');
    if (err?.type === 'entity.too.large') err = new HttpError(413, 'too_large', 'Request body too large.');
    if (err?.type === 'entity.parse.failed') err = new HttpError(400, 'bad_json', 'Malformed JSON body.');
    if (err instanceof HttpError) {
      if (err.extra?.retryAfter) res.setHeader('Retry-After', String(err.extra.retryAfter));
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.extra || {}) } });
    }
    if (!config.isTest || process.env.DEBUG_ERRORS) console.error(`[${req.method} ${req.originalUrl}]`, err);
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong.' } });
  });

  registerRealtimeHandlers(ctx);

  function attachRealtime(server) {
    hub.attach(server, (req) => authenticateUpgrade(ctx, req));
    hub.startHeartbeat();
  }

  function close() {
    hub.close();
    db.close();
  }

  return { app, ctx, attachRealtime, close };
}
