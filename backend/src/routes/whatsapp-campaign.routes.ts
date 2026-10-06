import { Router } from 'express';
import { authenticate, requireAccountId, requirePermission, requireRole, requireModulo } from '../middlewares/auth.middleware';
import { requireApiKey, requireScope } from '../middlewares/apiKey.middleware';
import { whatsappCampaignController } from '../controllers/whatsapp-campaign.controller';

// ============================================
// JWT Router — usuários autenticados via Bearer JWT
// ============================================
const jwtRouter = Router();
jwtRouter.use(authenticate);
// Módulo "disparos" (ETAPA A). Vale pros dois mounts (/whatsapp/campaigns e
// /dispatch). O apiKeyRouter abaixo (integrações n8n/IA) fica de fora de
// propósito: a chave de API tem escopo próprio e não carrega req.account.
jwtRouter.use(requireModulo('disparos'));
jwtRouter.use(requireRole('super_admin', 'admin'));
jwtRouter.use(requireAccountId);

jwtRouter.post('/send-single', (req, res, next) =>
  whatsappCampaignController.sendSingle(req, res, next)
);
jwtRouter.post('/send-batch', (req, res, next) =>
  whatsappCampaignController.sendBatch(req, res, next)
);
jwtRouter.get('/batches', (req, res, next) =>
  whatsappCampaignController.listBatches(req, res, next)
);
jwtRouter.get('/batches/:id', (req, res, next) =>
  whatsappCampaignController.getBatch(req, res, next)
);
jwtRouter.delete('/batches/:id', (req, res, next) =>
  whatsappCampaignController.cancelScheduled(req, res, next)
);

// ============================================
// API Key Router — integrações externas (n8n, etc) via x-api-key/Bearer
// ============================================
const apiKeyRouter = Router();
apiKeyRouter.use(requireApiKey);

apiKeyRouter.post('/send-single', requireScope('campaigns:write'), (req, res, next) =>
  whatsappCampaignController.sendSingle(req, res, next)
);
apiKeyRouter.post('/send-batch', requireScope('campaigns:write'), (req, res, next) =>
  whatsappCampaignController.sendBatch(req, res, next)
);
apiKeyRouter.get('/batches', requireScope('campaigns:read', 'campaigns:write'), (req, res, next) =>
  whatsappCampaignController.listBatches(req, res, next)
);
apiKeyRouter.get('/batches/:id', requireScope('campaigns:read', 'campaigns:write'), (req, res, next) =>
  whatsappCampaignController.getBatch(req, res, next)
);

export { jwtRouter, apiKeyRouter };
export default jwtRouter;
