import { Router } from 'express';
import authRoutes from './auth.routes';
import accountRoutes from './account.routes';
import userRoutes from './user.routes';
import contactRoutes from './contact.routes';
import productRoutes from './product.routes';
import tagRoutes, { funnelRouter } from './tag.routes';
import saleRoutes from './sale.routes';
import dashboardRoutes, { adminRouter } from './dashboard.routes';
import adminUserRoutes from './admin-user.routes';
import accountIntegrationsRoutes from './account-integrations.routes';
import financeRoutes from './finance.routes';
import insightsRoutes from './insights.routes';
import calendarRoutes from './calendar.routes';
import eventRoutes from './event.routes';
import prospectingRoutes from './prospecting.routes';
import emailRoutes from './email.routes';
import emailExtendedRoutes, { inboundWebhookRouter as emailInboundWebhookRouter } from './email-extended.routes';
import audienceRoutes from './audience.routes';
import evolutionRoutes from './evolution.routes';
import apiKeyRoutes from './api-key.routes';
import systemSettingsRoutes from './system-settings.routes';
import whatsappTemplateRoutes from './whatsapp-template.routes';
import whatsappCampaignJwtRoutes, { apiKeyRouter as whatsappCampaignApiKeyRoutes } from './whatsapp-campaign.routes';
import integrationWhatsappRoutes from './integration-whatsapp.routes';
import integrationKanbanRoutes from './integration-kanban.routes';
import integrationContactsRoutes from './integration-contacts.routes';
import integrationChatRoutes from './integration-chat.routes';
import integrationLookupRoutes from './integration-lookup.routes';
import contactsApiRoutes from './contacts-api.routes';
import webhookRoutes from './webhook-outbound.routes';
import {
  jwtRouter as inboundIntegrationJwtRoutes,
  publicRouter as inboundIntegrationPublicRoutes,
} from './inbound-integration.routes';
import whatsappConsentRoutes from './whatsapp-consent.routes';
// T-022 — chat interno / atendimento (inboxes, teams, conversations, etc.)
import inboxRoutes from './inbox.routes';
import teamRoutes from './team.routes';
import conversationRoutes from './conversation.routes';
import {
  jwtRouter as messageJwtRoutes,
  apiKeyRouter as messageApiKeyRoutes,
} from './message.routes';
import customAttributeRoutes from './custom-attribute.routes';
import cannedResponseRoutes from './canned-response.routes';
import slaRoutes, { conversationsRouter as slaConversationsRouter, slaDashboardRouter } from './sla.routes';
import chatMetricsRoutes from './chat-metrics.routes';
import agentAvailabilityRoutes from './agent-availability.routes';
import attachmentRoutes from './attachment.routes';
import warmupRoutes from './warmup.routes';
import { Router as LeadTagRouter } from 'express';
import { contactController } from '../controllers/contact.controller';
import { authenticate, requirePermission, requireAccountId } from '../middlewares/auth.middleware';

const router = Router();

// Health check
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Lead-tags endpoint (used by Kanban)
const leadTagRouter = LeadTagRouter();
leadTagRouter.use(authenticate);
leadTagRouter.use(requireAccountId);
leadTagRouter.get('/', requirePermission('leads', 'kanban'), (req, res, next) => contactController.listLeadTags(req, res, next));

// L-CROSS-1: rotas versionadas (`/api/v1/*`) NÃO existem no backend hoje, mas
// como o messageJwtRoutes mais abaixo está montado em '/' (catch-all com
// `authenticate`), qualquer request `/api/v1/auth/login` cai no middleware JWT
// e devolve 401 "Token não fornecido" em vez do esperado 404. O comportamento
// engana clientes — parece que a rota EXISTE mas está protegida.
// Interceptamos `/v1/*` aqui (antes de qualquer router com auth) e devolvemos
// 404 explícito via notFoundHandler. Quando/se introduzirmos versionamento,
// trocamos este handler pelo router de v1.
router.use('/v1', (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Rota não encontrada: ${req.method} /api/v1${req.path}`,
    },
  });
});

// API routes
router.use('/auth', authRoutes);
router.use('/accounts', accountRoutes);
router.use('/users', userRoutes);
router.use('/contacts', contactRoutes);
router.use('/products', productRoutes);
router.use('/tags', tagRoutes);
router.use('/funnels', funnelRouter);
router.use('/sales', saleRoutes);
router.use('/dashboard', dashboardRoutes);
// T-024: rota dedicada ao admin de conta gerenciar agentes da PROPRIA tenancy.
// DEVE ser registrada ANTES de /admin (adminRouter do dashboard) para evitar
// que o catch-all de /admin/* engula /admin/users.
router.use('/admin/users', adminUserRoutes);
// T-025: self-service de chaves de IA por admin de conta. Registrado ANTES
// de /admin (adminRouter do dashboard) para evitar que o catch-all engula
// /admin/integrations/*.
router.use('/admin/integrations', accountIntegrationsRoutes);
router.use('/admin', adminRouter);
router.use('/finance', financeRoutes);
router.use('/insights', insightsRoutes);
router.use('/calendar', calendarRoutes);
router.use('/events', eventRoutes);
router.use('/prospecting', prospectingRoutes);
// CRITICAL #6 fix: webhook público do SendGrid Inbound Parse precisa ser
// montado ANTES dos routers privados de /email. Caso contrário o
// `router.use(authenticate)` global de email.routes.ts intercepta TODA
// requisição que entra em /email/* e devolve 401 antes do handler público
// rodar (rota POST /email/inbound/webhook estava sempre dando 401).
router.use('/email/inbound', emailInboundWebhookRouter);
router.use('/email', emailRoutes);
router.use('/email', emailExtendedRoutes);
router.use('/email/audiences', audienceRoutes);
router.use('/evolution', evolutionRoutes);
router.use('/api-keys', apiKeyRoutes);
router.use('/system-settings', systemSettingsRoutes);
router.use('/whatsapp-templates', whatsappTemplateRoutes);
router.use('/whatsapp/campaigns', whatsappCampaignJwtRoutes);
router.use('/dispatch', whatsappCampaignJwtRoutes); // alias canonical para o frontend (DispatchDialog, aba Agendadas, Dashboard)
router.use('/integrations/whatsapp/campaigns', whatsappCampaignApiKeyRoutes);
router.use('/integrations/whatsapp', integrationWhatsappRoutes);
router.use('/integrations/kanban', integrationKanbanRoutes);
// T-LOOKUP-API: discovery endpoints (teams + users) pra agentes IA
// descobrirem destinatários válidos antes de chamar assign / assign-team.
// Mount na raiz '/integrations' porque expõe paths /teams e /users em
// paralelo (não um sub-recurso).
router.use('/integrations', integrationLookupRoutes);
// T-CONTACTS-API: novo CRUD canônico de contatos via API key (IA / n8n).
// Mount em '/integrations/contacts' (en-US, alinhado com kanban / chat).
// `/integrations/contatos` (pt-BR, legado) continua respondendo ao
// query endpoint antigo por compat.
router.use('/integrations/contacts', integrationContactsRoutes);
router.use('/integrations/contatos', contactsApiRoutes);
router.use('/webhooks', webhookRoutes);
// Inbound integrations:
// - PUBLIC receiver fica em '/integrations/inbound-receive/:accountId/:slug'
//   (auth via HMAC opcional dentro do service) — separado pra evitar colisão
//   com a rota JWT '/integrations/inbound/:slug' (DELETE).
// - JWT (list/create/delete) fica em '/integrations/inbound'.
router.use('/integrations/inbound-receive', inboundIntegrationPublicRoutes);
router.use('/integrations/inbound', inboundIntegrationJwtRoutes);
router.use('/whatsapp-consents', whatsappConsentRoutes);
router.use('/lead-tags', leadTagRouter);

// ============================================
// T-022 — Chat interno / atendimento
// ============================================
router.use('/inboxes', inboxRoutes);
router.use('/teams', teamRoutes);
router.use('/conversations', conversationRoutes);
// Aplica policy SLA a uma conversa específica: POST /conversations/:id/sla
router.use('/conversations', slaConversationsRouter);
// LIFECYCLE-BUG-1 fix: API Key router DEVE ser montado ANTES do JWT router
// catch-all. messageJwtRoutes em '/' aplica middleware authenticate (JWT) a
// TODA requisição que entra no sub-router — incluindo /integrations/chat/* —
// rejeitando com 401 antes do requireApiKey ter chance de rodar. Ao registrar
// '/integrations/chat' primeiro, o Express casa o handler do apiKeyRouter
// (que responde sem chamar next), e o JWT router nunca é alcançado para
// rotas de integração.
// API Key router p/ integrações externas (n8n, agente IA)
// T-CHAT-API: integrationChatRoutes precisa vir ANTES de messageApiKeyRoutes
// porque ambos cobrem `/integrations/chat/conversations/:id/messages`. O
// novo router é o canônico (default senderType='ai_bot', marca ai_handled,
// retorna no padrão `{ data }`). messageApiKeyRoutes fica como fallback
// pra compat com integrações antigas que ainda mandam `sender_type` no body.
router.use('/integrations/chat', integrationChatRoutes);
router.use('/integrations/chat', messageApiKeyRoutes);
// messageJwtRoutes usa paths absolutos (/conversations/:id/messages,
// /messages/:id/read, /messages/search) — montamos na raiz para cobrir
// ambos os prefixos (/conversations e /messages) com um único mount.
router.use('/', messageJwtRoutes);
router.use('/custom-attributes', customAttributeRoutes);
router.use('/canned-responses', cannedResponseRoutes);
router.use('/sla-policies', slaRoutes);
router.use('/sla', slaDashboardRouter);
router.use('/chat', chatMetricsRoutes);
router.use('/availability', agentAvailabilityRoutes);
// Bug A: media proxy (audio/image/video baixados da Evolution)
router.use('/attachments', attachmentRoutes);

// T-023 — WhatsApp Warmup (aquecimento de chips Evolution)
router.use('/warmup', warmupRoutes);

export default router;
