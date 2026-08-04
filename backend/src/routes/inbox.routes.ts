import { Router } from 'express';
import { inboxChannelController } from '../controllers/inbox.controller';
import {
  authenticate,
  requireRole,
  requireAccountId,
} from '../middlewares/auth.middleware';

const router = Router();

// ============================================
// CRUD de Inboxes (canais de atendimento — T-022)
// JWT + accountId obrigatório para todas as rotas.
// Leitura (GET) liberada para agent (necessário p/ filtros/badges no Chat UI).
// Mutação (POST/PUT/DELETE) restrita a super_admin/admin.
// ============================================
router.use(authenticate);
router.use(requireAccountId);

// Leitura — liberada para agent, admin e super_admin
router.get('/', (req, res, next) =>
  inboxChannelController.list(req, res, next)
);

router.get('/:id', (req, res, next) =>
  inboxChannelController.getById(req, res, next)
);

// H-CONFIG-1: contagens de cascade pra UI exibir antes do DELETE.
// Restrita a admin/super_admin — só quem pode deletar precisa saber.
router.get(
  '/:id/dependencies',
  requireRole('super_admin', 'admin'),
  (req, res, next) => inboxChannelController.getDependencies(req, res, next)
);

// Mutação — restrita a super_admin/admin
router.post('/', requireRole('super_admin', 'admin'), (req, res, next) =>
  inboxChannelController.create(req, res, next)
);

router.put('/:id', requireRole('super_admin', 'admin'), (req, res, next) =>
  inboxChannelController.update(req, res, next)
);

router.delete('/:id', requireRole('super_admin', 'admin'), (req, res, next) =>
  inboxChannelController.delete(req, res, next)
);

// ============================================
// Conexão Evolution / WhatsApp por Inbox (T-022 refactor)
// agent/admin/super_admin — qualquer um da conta pode parear/consultar/desconectar
// o WhatsApp do seu próprio Inbox (já tá escopado por accountId no controller).
// ============================================
router.post(
  '/:id/whatsapp/connect',
  requireRole('super_admin', 'admin', 'agent'),
  (req, res, next) => inboxChannelController.connectWhatsApp(req, res, next)
);

router.get(
  '/:id/whatsapp/status',
  requireRole('super_admin', 'admin', 'agent'),
  (req, res, next) => inboxChannelController.getWhatsAppStatus(req, res, next)
);

// Número conectado da instância (auto-preencher telefone ao selecionar a
// instância — ex.: adicionar chip ao pool de aquecimento).
router.get(
  '/:id/whatsapp/number',
  requireRole('super_admin', 'admin', 'agent'),
  (req, res, next) => inboxChannelController.getWhatsAppNumber(req, res, next)
);

router.post(
  '/:id/whatsapp/disconnect',
  requireRole('super_admin', 'admin', 'agent'),
  (req, res, next) => inboxChannelController.disconnectWhatsApp(req, res, next)
);

export default router;
