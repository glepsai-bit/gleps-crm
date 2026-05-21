import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env, isDevelopment } from './config/env';
import { connectDatabase } from './config/database';
import { metricsCollector } from './services/metrics-collector';
import { emailService } from './services/email.service';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import routes from './routes';
import { logger } from './utils/logger';

async function bootstrap() {
  // Connect to database
  await connectDatabase();

  // Start metrics collector
  metricsCollector.start();

  // Start email cadence cron (every 5 minutes)
  const EMAIL_CRON_INTERVAL_MS = 5 * 60 * 1000;
  setInterval(async () => {
    try {
      const processed = await emailService.processCadenceQueue();
      if (processed > 0) {
        logger.info(`📧 [EmailCron] Processed ${processed} emails`);
      }
    } catch (error: any) {
      logger.error(`📧 [EmailCron] Error: ${error.message}`);
    }
  }, EMAIL_CRON_INTERVAL_MS);
  logger.info(`📧 Email cadence cron started (interval: ${EMAIL_CRON_INTERVAL_MS / 1000}s)`);

  const app = express();

  // Trust proxy (for rate limiting behind reverse proxy)
  app.set('trust proxy', 1);

  // Security middlewares
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  // CORS
  const corsOrigins = isDevelopment
    ? ['http://localhost:8080', 'http://localhost:5173', 'http://127.0.0.1:8080']
    : env.CORS_ORIGINS
      ? env.CORS_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
      : [env.FRONTEND_URL];

  app.use(cors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Confirm-Password'],
  }));

  // Rate limiting
  // Skip webhook endpoints (server-to-server calls from n8n / Chatwoot / SendGrid).
  // These have their own auth (shared secret / signature) and must not be throttled
  // by the per-IP limiter, otherwise bursts of automated events get rejected.
  const WEBHOOK_PATH_PREFIXES = [
    '/api/chatwoot/webhook',
    '/api/chatwoot/log-resolution',
    '/api/email/webhook',           // SendGrid event webhook (if used)
    '/api/email/inbound',           // SendGrid inbound parse (if used)
  ];
  // Rate limiter: write-heavy / sensitive endpoints only.
  // The previous implementation throttled ALL /api requests (including dozens of
  // GETs the email/campaigns dashboard fires on every render). With the default
  // 100 req / 15 min window per IP, opening the e-mails tab a few times in a
  // row was enough to start rejecting subsequent POSTs (create campaign /
  // audience / template) with 429, which the UI surfaced as
  // "Muitas requisições. Tente novamente mais tarde." and silently dropped
  // the data the user was trying to save.
  //
  // Strategy:
  //  - Skip GET / HEAD / OPTIONS (read-only traffic from authenticated UI).
  //  - Skip webhook prefixes (server-to-server).
  //  - Skip the entire /api/email surface for authenticated reads, where the
  //    dashboard naturally fans out into many parallel calls.
  //  - Keep throttling on auth and other sensitive write endpoints.
  const SKIP_PATH_PREFIXES = [
    ...WEBHOOK_PATH_PREFIXES,
    '/api/email',         // dashboards & campaign editor make many calls
    '/api/audiences',     // public lists / contacts polling
    '/api/contacts',      // contact lookups inside email composer
    '/api/dashboard',     // metrics polling
  ];
  const limiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    // Generous floor — the previous 100 req / 15 min was set for a single-page
    // app and constantly tripped legitimate users. We still throttle, just at
    // a level that matches real usage.
    max: Math.max(env.RATE_LIMIT_MAX, 1000),
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      const method = (req.method || '').toUpperCase();
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
      const p = req.path || req.originalUrl || '';
      return SKIP_PATH_PREFIXES.some((prefix) => p.startsWith(prefix));
    },
    message: {
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Muitas requisições. Tente novamente mais tarde.',
      },
    },
  });
  app.use('/api', limiter);

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Request logging
  if (isDevelopment) {
    app.use((req, res, next) => {
      logger.debug(`${req.method} ${req.path}`, {
        query: req.query,
        body: req.method !== 'GET' ? req.body : undefined,
      });
      next();
    });
  } else {
    // Production: log auth requests for diagnostics
    app.use('/api/auth', (req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
      });
      next();
    });
  }

  // Health endpoint with build version
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: process.env.BUILD_VERSION || 'dev',
      syncStrategy: 'create-or-update-v2',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // API routes
  app.use('/api', routes);

  // Error handlers
  app.use(notFoundHandler);
  app.use(errorHandler);

  // Start server
  app.listen(env.PORT, () => {
    logger.info(`🚀 Server running on port ${env.PORT}`);
    logger.info(`📍 Environment: ${env.NODE_ENV}`);
    logger.info(`🔗 API URL: ${env.API_URL}`);
    logger.info(`🔄 Sync strategy: create-or-update-v2 (no upsert)`);
    logger.info(`📦 Build version: ${process.env.BUILD_VERSION || 'dev'}`);
    const gId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const gSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const gRedirect = (process.env.GOOGLE_REDIRECT_URI || '').trim();
    logger.info(`📅 Google Calendar env: clientId=${gId ? gId.substring(0, 8) + '...' : 'EMPTY'}, secret=${gSecret ? 'SET' : 'EMPTY'}, redirect=${gRedirect ? 'SET' : 'EMPTY'}`);
    const rapidKey = (process.env.RAPIDAPI_KEY || '').trim();
    logger.info(`🔑 RapidAPI key: ${rapidKey ? rapidKey.substring(0, 8) + '...' : 'EMPTY'} (env.RAPIDAPI_KEY=${env.RAPIDAPI_KEY ? 'SET' : 'EMPTY'})`);
  });
}

bootstrap().catch((error) => {
  logger.error('Failed to start server', error);
  process.exit(1);
});
