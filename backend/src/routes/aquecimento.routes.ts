/**
 * Aquecimento — rotas (ETAPA W). Montadas em /api/aquecimento.
 *
 *   GET    /                        lista números + situação de agora
 *   GET    /inboxes-disponiveis     inboxes WhatsApp que ainda não aquecem
 *   POST   /numeros                 { inboxId } começa a aquecer
 *   POST   /numeros/:id/pausar
 *   POST   /numeros/:id/retomar     zera falhas, mantém o dia
 *   DELETE /numeros/:id
 *   GET    /numeros/:id/historico   30 dias (planejado × enviado × falhas)
 *
 * As rotas antigas /api/warmup continuam montadas até a etapa C.
 */

import { Router } from 'express';
import { aquecimentoController } from '../controllers/aquecimento.controller';
import {
  authenticate,
  requireAccountId,
  requireRole,
  requireModulo,
} from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticate);
router.use(requireModulo('aquecimento'));
router.use(requireAccountId);
router.use(requireRole('admin', 'super_admin'));

router.get('/', (req, res, next) => aquecimentoController.listar(req, res, next));
router.get('/inboxes-disponiveis', (req, res, next) =>
  aquecimentoController.inboxesDisponiveis(req, res, next)
);
router.post('/numeros', (req, res, next) => aquecimentoController.adicionar(req, res, next));
router.post('/numeros/:id/pausar', (req, res, next) => aquecimentoController.pausar(req, res, next));
router.post('/numeros/:id/retomar', (req, res, next) => aquecimentoController.retomar(req, res, next));
router.delete('/numeros/:id', (req, res, next) => aquecimentoController.remover(req, res, next));
router.get('/numeros/:id/historico', (req, res, next) =>
  aquecimentoController.historico(req, res, next)
);

export default router;
