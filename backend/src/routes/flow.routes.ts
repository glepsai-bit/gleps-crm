import { Router } from 'express';
import { flowController } from '../controllers/flow.controller';
import { authenticate, requireAdmin, requireAccountId } from '../middlewares/auth.middleware';

/**
 * T-028 Fase 2 — fluxos de atendimento IA.
 *
 * Admin da conta apenas: um fluxo ativo responde os leads da conta inteira e
 * pode transferir e encerrar conversa — não é configuração de atendente.
 */

const router = Router();

router.use(authenticate);
router.use(requireAdmin);
router.use(requireAccountId);

// Execuções primeiro: rotas literais antes das paramétricas, senão
// `/runs` casaria com `/:id`.
router.get('/runs', (req, res, next) => flowController.listRuns(req, res, next));
router.get('/runs/:runId', (req, res, next) => flowController.getRun(req, res, next));
router.get('/catalog', (req, res, next) => flowController.catalog(req, res, next));
router.get('/preview/:conversationId/run', (req, res, next) =>
  flowController.previewRunAtual(req, res, next)
);
router.delete('/preview/:conversationId', (req, res, next) =>
  flowController.resetPreview(req, res, next)
);
router.post('/seed-default', (req, res, next) => flowController.seedDefault(req, res, next));
router.post('/seed-followup', (req, res, next) => flowController.seedFollowup(req, res, next));

router.get('/', (req, res, next) => flowController.list(req, res, next));
router.post('/', (req, res, next) => flowController.create(req, res, next));
router.get('/:id', (req, res, next) => flowController.get(req, res, next));
router.patch('/:id', (req, res, next) => flowController.update(req, res, next));
router.delete('/:id', (req, res, next) => flowController.delete(req, res, next));
router.post('/:id/status', (req, res, next) => flowController.setStatus(req, res, next));
// Simulador: roda o fluxo inteiro sem enviar nada pro WhatsApp.
router.post('/:id/preview', (req, res, next) => flowController.preview(req, res, next));

export default router;
