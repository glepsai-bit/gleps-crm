import * as Sentry from '@sentry/node';
import { env, isDevelopment } from './config/env';

// PISTA A — Sentry error tracking.
// Init roda no MODULE LOAD (antes de rotas / bootstrap) para instrumentar
// http + express + prisma automaticamente. É guardado por SENTRY_DSN: se
// ausente, nada é inicializado e o app continua funcionando normalmente
// (sem coleta de erros). tracesSampleRate=0.1 mantém overhead baixo em prod.
if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: process.env.BUILD_VERSION || 'dev',
    integrations: [
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
      Sentry.prismaIntegration(),
    ],
    tracesSampleRate: 0.1,
  });
}

import http from 'http';
import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { connectDatabase, prisma } from './config/database';
import { metricsCollector } from './services/metrics-collector';
import { emailService } from './services/email.service';
import { whatsappCampaignService } from './services/whatsapp-campaign.service';
import { whatsappRateLimitService } from './services/whatsapp-rate-limit.service';
import { whatsappWarmupService } from './services/whatsapp-warmup.service';
import { webhookOutboundService } from './services/webhook-outbound.service';
import { slaService } from './services/sla.service';
import { csatService } from './services/csat.service';
import { agentAvailabilityService } from './services/agent-availability.service';
import { flowService } from './services/flow.service';
import { knowledgeService } from './services/knowledge.service';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import routes from './routes';
import { logger } from './utils/logger';
import { initSocket } from './socket';

async function bootstrap() {
  // Connect to database
  await connectDatabase();

  // H-DISP-B: recupera batches WhatsApp em 'running' orfaos de restart anterior
  // (processBatchInBackground vive em memoria, nao sobrevive a reboot). Volta
  // para 'scheduled' para o cron de WhatsApp reprocessar. Roda ANTES do cron
  // subir para evitar race com novos ticks.
  try {
    await whatsappCampaignService.recoverOrphanRunningBatches();
  } catch (err) {
    logger.error('[wa-campaign] recoverOrphanRunningBatches failed at bootstrap', err);
  }

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

  // T-027 Fase 1 — worker de indexação da base de conhecimento (RAG).
  // Documento entra 'pending' pela tela e é indexado aqui: quebrar em trechos +
  // gerar embedding leva dezenas de segundos de chamada de API, tempo demais
  // pra caber no request. O mutex evita sobreposição no processo; entre
  // réplicas quem garante é o claim atômico pending→indexing no service.
  {
    const KB_CRON_INTERVAL_MS = 30 * 1000;
    let isIndexing = false;
    setInterval(async () => {
      if (isIndexing) return;
      isIndexing = true;
      try {
        const result = await knowledgeService.processPendingDocs();
        if (result.ok > 0 || result.failed > 0) {
          logger.info(`🧠 Knowledge index: ${result.ok} ok, ${result.failed} falhas`);
        }
      } catch (err) {
        logger.error('Knowledge index cron error:', err);
      } finally {
        isIndexing = false;
      }
    }, KB_CRON_INTERVAL_MS);
    logger.info(`🧠 Knowledge index cron started (interval: ${KB_CRON_INTERVAL_MS / 1000}s)`);
  }

  // T-028 — worker do fluxo de atendimento IA.
  //
  // Tick de 5s (o mais rápido do sistema) porque é ele que faz a IA responder:
  // o lead está do outro lado esperando. Os demais crons são de tarefa de
  // fundo; este é caminho de atendimento.
  //
  // O mutex evita sobreposição, mas a garantia dura contra execução dupla é o
  // claim atômico dentro do processDueRuns — dois processos respondendo o mesmo
  // lead seria pior que atrasar.
  {
    const FLOW_CRON_INTERVAL_MS = 5 * 1000;
    let isRunningFlows = false;
    setInterval(async () => {
      if (isRunningFlows) return;
      isRunningFlows = true;
      try {
        const r = await flowService.processDueRuns();
        if (r.ok > 0 || r.failed > 0) {
          logger.info(`🔀 Fluxo IA: ${r.ok} executados, ${r.failed} com falha`);
        }
      } catch (err) {
        logger.error('Flow engine cron error:', err);
      } finally {
        isRunningFlows = false;
      }
    }, FLOW_CRON_INTERVAL_MS);
    logger.info(`🔀 Flow engine cron started (interval: ${FLOW_CRON_INTERVAL_MS / 1000}s)`);
  }

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

  // T-023 — cron de aquecimento de chips WhatsApp (tick 60s).
  // CRON-WARMUP-001: mutex isWarmingChips evita overlap se um tick demorar
  // mais que o intervalo (rede lenta + muitos numbers em pool). Idempotencia
  // por number eh garantida pelos increments atomicos em recordSend.
  {
    const WARMUP_CRON_INTERVAL_MS = 60 * 1000;
    let isWarmingChips = false;
    setInterval(async () => {
      if (isWarmingChips) {
        logger.warn('[warmup] previous tick still running, skipping');
        return;
      }
      isWarmingChips = true;
      try {
        const result = await whatsappWarmupService.tick();
        if (result.sent > 0 || result.failed > 0) {
          logger.info(
            `🔥 Warmup tick: ${result.sent} sent, ${result.failed} failed, ${result.skipped} skipped (checked ${result.checked})`
          );
        }
      } catch (err) {
        logger.error('Warmup cron error:', err);
      } finally {
        isWarmingChips = false;
      }
    }, WARMUP_CRON_INTERVAL_MS);
    logger.info(`🔥 Warmup cron started (60s tick)`);
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
  // CRON-002: mutex isCheckingSla evita overlap caso uma execucao demore
  // mais que o intervalo. Idempotencia entre replicas e garantida pelo
  // @@unique([conversationId, breachType]) + tratamento P2002.
  {
    const SLA_CRON_INTERVAL_MS = 60 * 1000;
    let isCheckingSla = false;
    setInterval(async () => {
      if (isCheckingSla) {
        logger.warn('[sla] previous check still running, skipping tick');
        return;
      }
      isCheckingSla = true;
      try {
        await slaService.checkBreaches();
      } catch (err) {
        logger.error('SLA breach check cron error:', err);
      } finally {
        isCheckingSla = false;
      }
    }, SLA_CRON_INTERVAL_MS);
    logger.info(`⏱️  SLA breach check cron started (interval: ${SLA_CRON_INTERVAL_MS / 1000}s)`);
  }

  // SLA v2 — cron CSAT (5 min). Envia mensagem de CSAT pros ciclos elegiveis
  // (csatRequested=true, csatSentAt=null, resolvedAt entre [now-24h, now-15min]).
  {
    const CSAT_CRON_INTERVAL_MS = 5 * 60 * 1000;
    let isSendingCsat = false;
    setInterval(async () => {
      if (isSendingCsat) {
        logger.warn('[csat] previous send still running, skipping tick');
        return;
      }
      isSendingCsat = true;
      try {
        const result = await csatService.sendPendingCsatMessages();
        if (result.sent > 0 || result.failed > 0) {
          logger.info('[csat] sendPendingCsatMessages tick', { ...result });
        }
      } catch (err) {
        logger.error('CSAT cron error:', err instanceof Error ? err : new Error(String(err)));
      } finally {
        isSendingCsat = false;
      }
    }, CSAT_CRON_INTERVAL_MS);
    logger.info(`💬 CSAT cron started (interval: ${CSAT_CRON_INTERVAL_MS / 1000}s)`);
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

  // H-AUTH-4: cleanup diario de refresh tokens orfaos.
  // Sem isso a tabela refresh_tokens cresce indefinidamente — em prod ja
  // tinhamos 154 tokens revogados/expirados acumulados so para o admin
  // do FitPark. Removemos:
  //   - tokens revogados ha mais de 7 dias (mantemos janela curta de
  //     auditoria para detectar reuse de token rotacionado);
  //   - tokens com expiresAt no passado (sao 401 garantidos, nao servem
  //     mais nem para validacao).
  // Executa 1x no bootstrap para limpar o backlog historico e depois
  // a cada 24h. Roda em background — falha nao impede o servidor de subir.
  {
    const REFRESH_TOKEN_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const REFRESH_TOKEN_REVOKED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
    const cleanupRefreshTokens = async () => {
      try {
        const result = await prisma.refreshToken.deleteMany({
          where: {
            OR: [
              { revokedAt: { not: null, lt: new Date(Date.now() - REFRESH_TOKEN_REVOKED_GRACE_MS) } },
              { expiresAt: { lt: new Date() } },
            ],
          },
        });
        if (result.count > 0) {
          logger.info(`🧹 [auth] removidos ${result.count} refresh tokens revogados/expirados`);
        }
      } catch (err) {
        logger.error('Refresh token cleanup cron error:', err);
      }
    };
    // backlog cleanup no boot (nao bloqueia subida do servidor)
    void cleanupRefreshTokens();
    setInterval(cleanupRefreshTokens, REFRESH_TOKEN_CLEANUP_INTERVAL_MS);
    logger.info(`🧹 Refresh token cleanup cron started (interval: ${REFRESH_TOKEN_CLEANUP_INTERVAL_MS / 1000}s)`);
  }

  const app = express();

  // Trust proxy (for rate limiting behind reverse proxy)
  app.set('trust proxy', 1);

  // Security middlewares
  // H-CROSS-1b: CSP restritiva + headers de seguranca padrao do helmet
  // (X-Frame-Options, X-Content-Type-Options, Referrer-Policy etc.).
  // O nginx atras nao adicionava nada disso, deixando o app vulneravel
  // a clickjacking e injecao de scripts inline. Politicas:
  //   - scriptSrc 'self': sem inline JS (eval/onclick bloqueados).
  //   - styleSrc 'unsafe-inline': necessario pra Tailwind/Vite em dev
  //     e pros estilos inline injetados pelo shadcn em tempo de render.
  //   - connectSrc inclui WS/WSS pra Socket.IO + dominio de prod.
  //   - imgSrc 'data:' pra avatares base64 e 'https:' pra anexos externos.
  //   - crossOriginEmbedderPolicy desligado: evita quebrar recursos
  //     cross-origin (Chatwoot iframe, ASN etc.) que nao mandam CORP.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https://autevo.gleps.com.br', 'wss:', 'ws:'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
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
  // Skip webhook endpoints (server-to-server calls from n8n / SendGrid).
  // These have their own auth (shared secret / signature) and must not be throttled
  // by the per-IP limiter, otherwise bursts of automated events get rejected.
  const WEBHOOK_PATH_PREFIXES = [
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

  // CRITICAL #8 — rate-limit dedicado para endpoints de autenticação.
  // O limiter global (1000/15min) é generoso demais para login: permitia brute
  // force virtualmente livre (60 tentativas em segundos sem 429). Este limiter
  // dedicado bloqueia após 10 tentativas falhas em 15min por IP. Logins
  // bem-sucedidos não consomem cota (skipSuccessfulRequests), então usuários
  // legítimos que erram a senha algumas vezes não ficam presos.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    max: 10,                  // 10 tentativas por janela
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: {
      error: 'TOO_MANY_LOGIN_ATTEMPTS',
      message: 'Muitas tentativas. Tente novamente em 15 minutos.',
    },
  });
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/forgot-password', authLimiter);

  app.use('/api', limiter);

  // Body parsing
  // BUG-007: capturamos o raw body em req.rawBody pra que webhooks que assinam
  // o payload (HMAC SHA-256) possam validar a assinatura byte-a-byte. Sem isso,
  // o JSON.stringify(req.body) gera bytes diferentes do que o cliente assinou
  // (espaços, ordem de chaves, escapes Unicode) e a assinatura nunca bate.
  // 24MB acomoda o teto de 16MB do WhatsApp para PTT/imagem/video
  // inflado ~33% pelo base64 do payload JSON (frontend envia
  // attachments como data:base64 inline enquanto nao ha upload dedicado).
  // Antes era 10MB e audios reais de ~1min ou fotos de camera moderna
  // caiam com 413 ou eram bloqueados pelo guard do MessageComposer.
  app.use(
    express.json({
      limit: '24mb',
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: '24mb' }));

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

  // Servir arquivos estaticos de upload (warmup media: audio/sticker/image,
  // e qualquer outro modulo que grave em backend/uploads). Caminho casado
  // com mediaPath persistido em WarmupTemplate.mediaPath (relativo a
  // backend/uploads). CORS ja configurado acima; cache curto pra permitir
  // hot-reload de stickers.
  app.use(
    '/uploads',
    express.static(path.resolve(process.cwd(), 'uploads'), {
      maxAge: '1h',
      fallthrough: true,
    })
  );

  // Health endpoint with build version
  // BUG-014: antes nao pingava Postgres — Docker/EasyPanel nunca restartava
  // em outage de DB (parcial silenciosa). Agora roda SELECT 1 com timeout
  // curto. Se DB falhar, retorna 503 e o orquestrador reinicia.
  app.get('/api/health', async (_req, res) => {
    const baseInfo = {
      version: process.env.BUILD_VERSION || 'dev',
      syncStrategy: 'create-or-update-v2',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };

    const pingPromise = prisma.$queryRaw`SELECT 1`;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('db_ping_timeout')), 2000)
    );

    try {
      await Promise.race([pingPromise, timeoutPromise]);
      res.json({ status: 'ok', db: 'ok', ...baseInfo });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(503).json({ status: 'degraded', db: 'down', error: errMsg, ...baseInfo });
    }
  });

  // API routes
  app.use('/api', routes);

  // PISTA A — Sentry error handler.
  // Deve rodar DEPOIS das rotas e ANTES dos error handlers customizados
  // para capturar exceptions lançadas dentro dos handlers de rota. No-op
  // silencioso se Sentry.init não foi chamado (SENTRY_DSN ausente).
  if (env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
  }

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
