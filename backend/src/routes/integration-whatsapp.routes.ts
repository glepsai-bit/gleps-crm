import { Router } from 'express';
import { requireApiKey, requireScope } from '../middlewares/apiKey.middleware';
import { integrationWhatsappController } from '../controllers/integration-whatsapp.controller';

// ============================================
// T-022 — Integração WhatsApp (API key)
//
// Mountado em '/integrations/whatsapp' (ver routes/index.ts):
//   POST /integrations/whatsapp/send                       — mensagem avulsa
//                                                            (text/image/audio/document)
//   POST /integrations/whatsapp/campaigns/send-single      — 1 texto (contactId|phone)
//   POST /integrations/whatsapp/campaigns/send-batch       — disparo em massa
//   GET  /integrations/whatsapp/campaigns/batches          — lista de disparos
//   GET  /integrations/whatsapp/campaigns/batches/:id      — disparo + envios
//
// `/campaigns/*` é o contrato antigo (whatsapp-campaign, apagado na etapa C1)
// reapontado pro motor único de disparos — ver services/disparo/compat-campanhas.ts
// e docs/fitpark/API_INTEGRATIONS_WHATSAPP.md.
//
// Auth: x-api-key OU Authorization: Bearer <key>.
// Scopes: 'messages:write' (send, send-single), 'campaigns:write'
//         (send-single, send-batch), 'campaigns:read'|'campaigns:write' (GETs).
// ============================================

const router = Router();

router.use(requireApiKey);

router.post(
  '/send',
  requireScope('messages:write'),
  (req, res, next) => integrationWhatsappController.send(req, res, next)
);

router.post(
  '/campaigns/send-single',
  requireScope('campaigns:write', 'messages:write'),
  (req, res, next) => integrationWhatsappController.sendSingle(req, res, next)
);
router.post(
  '/campaigns/send-batch',
  requireScope('campaigns:write'),
  (req, res, next) => integrationWhatsappController.sendBatch(req, res, next)
);
router.get(
  '/campaigns/batches',
  requireScope('campaigns:read', 'campaigns:write'),
  (req, res, next) => integrationWhatsappController.listBatches(req, res, next)
);
router.get(
  '/campaigns/batches/:id',
  requireScope('campaigns:read', 'campaigns:write'),
  (req, res, next) => integrationWhatsappController.getBatch(req, res, next)
);

export default router;
