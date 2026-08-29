import { Router } from 'express';
import { voiceController } from '../controllers/voice.controller';
import { authenticate, requireAdmin, requireAccountId } from '../middlewares/auth.middleware';

/**
 * T-029 — Discador.
 *
 * DOIS routers, e a separação NÃO é estética.
 *
 * `router.use('/', messageJwtRoutes)` em routes/index.ts monta um router na
 * raiz que aplica `authenticate` a toda requisição que entra nele — inclusive
 * as que só seriam roteadas depois. Qualquer rota pública montada DEPOIS dele
 * toma 401 antes de chegar no handler (é o mesmo motivo do webhook do SendGrid
 * ser montado mais acima, e do LIFECYCLE-BUG-1 com as rotas de API key).
 *
 * Como a Twilio não tem como mandar nosso JWT, as rotas dela precisam ser
 * montadas ANTES daquele router — daí o export separado. A defesa delas é a
 * assinatura HMAC do provedor, conferida no controller.
 */

// ---- Públicas: chamadas pela operadora. Montar cedo em routes/index.ts. ----
export const voicePublicRoutes = Router();

voicePublicRoutes.post('/twiml/:accountId', (req, res) => voiceController.twiml(req, res));
voicePublicRoutes.post('/status', (req, res) => voiceController.status(req, res));
voicePublicRoutes.post('/recording', (req, res) => voiceController.recording(req, res));

// ---- Do operador (JWT) ----
const router = Router();

router.use(authenticate);
router.use(requireAccountId);

router.get('/token', (req, res, next) => voiceController.token(req, res, next));
router.post('/calls', (req, res, next) => voiceController.startCall(req, res, next));
router.get('/calls', (req, res, next) => voiceController.listCalls(req, res, next));
router.post('/calls/:callId/outcome', (req, res, next) =>
  voiceController.setOutcome(req, res, next)
);

// Credenciais da operadora: só admin da conta.
router.get('/config', requireAdmin, (req, res, next) => voiceController.getConfig(req, res, next));
router.patch('/config', requireAdmin, (req, res, next) =>
  voiceController.updateConfig(req, res, next)
);

export default router;
