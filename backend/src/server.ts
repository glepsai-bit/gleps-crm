import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env, isDevelopment } from './config/env';
import { connectDatabase } from './config/database';
import { metricsCollector } from './services/metrics-collector';
import { emailService } from './services/email.service';
import { whatsappCampaignService } from './services/whatsapp-campaign.service';
import { whatsappRateLimitService } from './services/whatsapp-rate-limit.service';
import { webhookOutboundService } from './services/webhook-outbound.service';
import { slaService } from './services/sla.service';
import { agentAvailabilityService } from './services/agent-availability.service';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import routes from './routes';
import { logger } from './utils/logger';
import { initSocket } from './socket';

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

  // T-022 Sprint 2 — cron de campanhas WhatsApp agendadas
  // BUG-034: mutex global previne sobreposição de execuções caso a anterior
  // ainda esteja em andamento quando o próximo tick disparar.
  {
    const WA_CRON_INTERVAL_MS = 5 * 60 * 1000;
    let isProcessingWa = false;
    setInterval(async () => {
      if (isProcessingWa) return;
      isProcessingWa = true;
      try {
        const result = await whatsappCampaignService.processScheduledQueue();
        if (result.processed > 0 || result.failed > 0) {
          logger.info(`📲 WhatsApp scheduled cron: ${result.processed} processed, ${result.failed} failed`);
        }
      } catch (err) {
        logger.error('WhatsApp scheduled cron error:', err);
      } finally {
        isProcessingWa = false;
      }
    }, WA_CRON_INTERVAL_MS);
    logger.info(`📲 WhatsApp campaign cron started (interval: ${WA_CRON_INTERVAL_MS / 1000}s)`);
  }

  // BUG-038 — cron de cleanup das janelas de rate-limit do WhatsApp (5 min)
  {
    const WA_RL_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
    setInterval(() => {
      try {
        whatsappRateLimitService.cleanupOld();
      } catch (err) {
        logger.error('WhatsApp rate-limit cleanup cron error:', err);
      }
    }, WA_RL_CLEANUP_INTERVAL_MS);
    logger.info(`🧹 WhatsApp rate-limit cleanup cron started (interval: ${WA_RL_CLEANUP_INTERVAL_MS / 1000}s)`);
  }

  // T-022 Sprint 3 — cron de retry da fila de webhooks outbound
  {
    const WH_CRON_INTERVAL_MS = 60 * 1000;  // 1 min
    setInterval(async () => {
      try {
        const result = await webhookOutboundService.processRetryQueue();
        if (result.processed > 0) logger.info(`🔁 Webhook retry: ${result.processed} processed`);
      } catch (err) { logger.error('Webhook retry cron error:', err); }
    }, WH_CRON_INTERVAL_MS);
    logger.info(`🔁 Webhook retry cron started (interval: ${WH_CRON_INTERVAL_MS / 1000}s)`);
  }

  // T-022 Sprint 4 — cron de checagem de breaches de SLA (1 min)
  {
    const SLA_CRON_INTERVAL_MS = 60 * 1000;
    setInterval(async () => {
      try {
        await slaService.checkBreaches();
      } catch (err) {
        logger.error('SLA breach check cron error:', err);
      }
    }, SLA_CRON_INTERVAL_MS);
    logger.info(`⏱️  SLA breach check cron started (interval: ${SLA_CRON_INTERVAL_MS / 1000}s)`);
  }

  // T-022 Sprint 4 — cron de "agente offline por inatividade" (1 min, 2min idle = offline)
  {
    const AGENT_OFFLINE_INTERVAL_MS = 60 * 1000;
    const AGENT_IDLE_THRESHOLD_MS = 2 * 60 * 1000;
    setInterval(async () => {
      try {
        await agentAvailabilityService.markOfflineAfterTimeout(AGENT_IDLE_THRESHOLD_MS);
      } catch (err) {
        logger.error('Agent offline timeout cron error:', err);
      }
    }, AGENT_OFFLINE_INTERVAL_MS);
    logger.info(`👤 Agent offline timeout cron started (interval: ${AGENT_OFFLINE_INTERVAL_MS / 1000}s, idle threshold: ${AGENT_IDLE_THRESHOLD_MS / 1000}s)`);
  }

  const app = express();

  // Trust proxy (for rate limiting behind reverse proxy)
  app.set('trust proxy', 1);

  // Security middlewares
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  // CORS
  const corsOrigins = isDevelopment
    ? ['http://localhost:8080', 'http://localhost:5173', 'http://localhost:8081', 'http://127.0.0.1:8080', 'http://127.0.0.1:8081']
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
  // BUG-007: capturamos o raw body em req.rawBody pra que webhooks que assinam
  // o payload (HMAC SHA-256) possam validar a assinatura byte-a-byte. Sem isso,
  // o JSON.stringify(req.body) gera bytes diferentes do que o cliente assinou
  // (espaços, ordem de chaves, escapes Unicode) e a assinatura nunca bate.
  app.use(
    express.json({
      limit: '10mb',
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf;
      },
    })
  );
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

  // T-022 Sprint 4 — HTTP server + Socket.IO (chat interno em tempo real)
  // Trocamos app.listen() por http.createServer(app) pra que o Socket.IO
  // possa anexar no mesmo servidor e compartilhar a porta com o REST.
  const httpServer = http.createServer(app);
  initSocket(httpServer);

  // Start server
  httpServer.listen(env.PORT, () => {
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
