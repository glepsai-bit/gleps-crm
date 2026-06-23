import { Router } from 'express';
import authRoutes from './auth.routes';
import accountRoutes from './account.routes';
import userRoutes from './user.routes';
import contactRoutes from './contact.routes';
import productRoutes from './product.routes';
import tagRoutes, { funnelRouter } from './tag.routes';
import saleRoutes from './sale.routes';
import dashboardRoutes, { adminRouter } from './dashboard.routes';
import financeRoutes from './finance.routes';
import insightsRoutes from './insights.routes';
import calendarRoutes from './calendar.routes';
import eventRoutes from './event.routes';
import chatwootRoutes from './chatwoot.routes';
import prospectingRoutes from './prospecting.routes';
import emailRoutes from './email.routes';
import emailExtendedRoutes from './email-extended.routes';
import audienceRoutes from './audience.routes';
import evolutionRoutes from './evolution.routes';
import apiKeyRoutes from './api-key.routes';
import whatsappTemplateRoutes from './whatsapp-template.routes';
import whatsappCampaignJwtRoutes, { apiKeyRouter as whatsappCampaignApiKeyRoutes } from './whatsapp-campaign.routes';
import contactsApiRoutes from './contacts-api.routes';
import webhookRoutes from './webhook-outbound.routes';
import {
  jwtRouter as inboundIntegrationJwtRoutes,
  publicRouter as inboundIntegrationPublicRoutes,
} from './inbound-integration.routes';
import whatsappConsentRoutes from './whatsapp-consent.routes';
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
router.use('/admin', adminRouter);
router.use('/finance', financeRoutes);
router.use('/insights', insightsRoutes);
router.use('/calendar', calendarRoutes);
router.use('/events', eventRoutes);
router.use('/chatwoot', chatwootRoutes);
router.use('/prospecting', prospectingRoutes);
router.use('/email', emailRoutes);
router.use('/email', emailExtendedRoutes);
router.use('/email/audiences', audienceRoutes);
router.use('/evolution', evolutionRoutes);
router.use('/api-keys', apiKeyRoutes);
router.use('/whatsapp-templates', whatsappTemplateRoutes);
router.use('/whatsapp/campaigns', whatsappCampaignJwtRoutes);
router.use('/dispatch', whatsappCampaignJwtRoutes); // alias canonical para o frontend (DispatchDialog, aba Agendadas, Dashboard)
router.use('/integrations/whatsapp/campaigns', whatsappCampaignApiKeyRoutes);
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

export default router;
