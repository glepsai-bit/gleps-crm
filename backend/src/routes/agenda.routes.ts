import { Router } from 'express';
import { agendaController } from '../controllers/agenda.controller';
import { authenticate, requireAdmin, requireAccountId } from '../middlewares/auth.middleware';

/**
 * T-039 — regras do agendamento pelo agente. Admin da conta: define quem
 * atende e quando — não é configuração de atendente.
 */
const router = Router();

router.use(authenticate);
router.use(requireAdmin);
router.use(requireAccountId);

router.get('/configuracao', (req, res, next) => agendaController.configuracao(req, res, next));
router.put('/configuracao', (req, res, next) => agendaController.salvarConfiguracao(req, res, next));
router.put('/profissionais/:userId', (req, res, next) => agendaController.salvarProfissional(req, res, next));
router.put('/servicos/:productId', (req, res, next) => agendaController.salvarServico(req, res, next));
router.get('/horarios', (req, res, next) => agendaController.horarios(req, res, next));

export default router;
