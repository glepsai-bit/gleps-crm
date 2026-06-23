import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import { whatsappConsentService } from '../services/whatsapp-consent.service';
import { AuthenticatedRequest } from '../types';
import { NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors';

// ============================================
// Validation schemas
// ============================================

const listOptedOutQuerySchema = z.object({
  status: z.string().optional(),
  search: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const optInOutBodySchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict();

const exportQuerySchema = z.object({
  format: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

const checkBatchBodySchema = z
  .object({
    phones: z.array(z.string()).min(1).max(5000),
  })
  .strict();

// ============================================
// Helpers
// ============================================

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Retorna accountId do request, suportando JWT (req.user.accountId)
 * ou API Key (req.apiKey.accountId).
 */
function getAccountId(req: Request): string {
  const authReq = req as AuthenticatedRequest;
  const fromJwt = authReq.user?.accountId ?? null;
  const fromApiKey = req.apiKey?.accountId ?? null;
  const accountId = fromJwt || fromApiKey;

  if (!accountId) {
    throw new UnauthorizedError('Conta não identificada no request');
  }

  return accountId;
}

function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError('Data inválida');
  }
  return d;
}

/**
 * Resolve { phone, contactId } a partir de um parâmetro de URL que pode
 * ser um UUID (contactId) ou um telefone bruto.
 *
 * - UUID: busca contato; exige telefone cadastrado; preenche contactId.
 * - Caso contrário: trata como telefone e normaliza; tenta vincular contactId
 *   pelo telefone (best-effort).
 */
async function resolveContactIdOrPhone(
  accountId: string,
  contactIdOrPhone: string
): Promise<{ phone: string; contactId?: string }> {
  const value = (contactIdOrPhone ?? '').trim();
  if (!value) {
    throw new ValidationError('contactIdOrPhone é obrigatório');
  }

  if (UUID_REGEX.test(value)) {
    const contact = await prisma.contact.findFirst({
      where: { id: value, accountId },
      select: { id: true, telefone: true },
    });
    if (!contact) {
      throw new NotFoundError('Contato');
    }
    if (!contact.telefone) {
      throw new ValidationError(
        `Contato ${contact.id} não possui telefone cadastrado`
      );
    }
    return { phone: contact.telefone, contactId: contact.id };
  }

  const normalized = whatsappConsentService.normalizePhone(value);
  if (!normalized) {
    throw new ValidationError('Telefone inválido');
  }

  // Best-effort: tenta vincular contato pelo telefone (normalizado)
  let contactId: string | undefined;
  try {
    const contact = await prisma.contact.findFirst({
      where: { accountId, telefone: normalized },
      select: { id: true },
    });
    contactId = contact?.id;
  } catch {
    // Silencioso: vincular contactId é best-effort
  }

  return { phone: normalized, contactId };
}

// ============================================
// Controller
// ============================================

export class WhatsappConsentController {
  /**
   * GET /api/whatsapp-consents?status=opted_out&search=&fromDate=&toDate=
   * Lista contatos opted_out de uma conta.
   */
  async listOptedOut(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = getAccountId(req);
      const query = listOptedOutQuerySchema.parse(req.query ?? {});

      // Por enquanto apenas status='opted_out' é suportado.
      if (query.status && query.status !== 'opted_out') {
        throw new ValidationError(
          "Filtro 'status' só aceita 'opted_out' no momento"
        );
      }

      const result = await whatsappConsentService.listOptedOut(accountId, {
        search: query.search,
        fromDate: parseDate(query.fromDate),
        toDate: parseDate(query.toDate),
        limit: query.limit,
        offset: query.offset,
      });

      res.json({ data: result.data, meta: { total: result.total } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /:contactIdOrPhone/opt-in
   * Body: { reason? }
   */
  async optIn(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = getAccountId(req);
      const contactIdOrPhone = req.params.contactIdOrPhone as string | undefined;
      if (!contactIdOrPhone) {
        throw new ValidationError('contactIdOrPhone é obrigatório');
      }
      const body = optInOutBodySchema.parse(req.body ?? {});

      const { phone, contactId } = await resolveContactIdOrPhone(
        accountId,
        contactIdOrPhone
      );

      const record = await whatsappConsentService.optIn(accountId, phone, {
        contactId,
        source: 'manual',
        reason: body.reason,
      });

      res.status(201).json({ data: record });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /:contactIdOrPhone/opt-out
   * Body: { reason? }
   */
  async optOut(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = getAccountId(req);
      const contactIdOrPhone = req.params.contactIdOrPhone as string | undefined;
      if (!contactIdOrPhone) {
        throw new ValidationError('contactIdOrPhone é obrigatório');
      }
      const body = optInOutBodySchema.parse(req.body ?? {});

      const { phone, contactId } = await resolveContactIdOrPhone(
        accountId,
        contactIdOrPhone
      );

      const record = await whatsappConsentService.optOut(accountId, phone, {
        contactId,
        source: 'manual',
        reason: body.reason,
      });

      res.status(201).json({ data: record });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/whatsapp-consents/check-batch
   * Body: { phones: string[] }  (min 1, max 5000)
   *
   * Verifica, em massa, quais dos telefones recebidos estão com opt-out ativo
   * para a conta autenticada. Usado pelo frontend (ComplianceWarning no
   * DispatchDialog) antes de iniciar um disparo — não tem efeito colateral.
   */
  async checkBatch(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = getAccountId(req);
      const body = checkBatchBodySchema.parse(req.body ?? {});

      const result = await whatsappConsentService.checkBatch(
        accountId,
        body.phones
      );

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/whatsapp-consents/export?format=csv
   * Content-Type: text/csv; filename: optouts-YYYY-MM-DD.csv
   */
  async exportCsv(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = getAccountId(req);
      const query = exportQuerySchema.parse(req.query ?? {});

      const format = (query.format ?? 'csv').toLowerCase();
      if (format !== 'csv') {
        throw new ValidationError("Formato não suportado. Use format=csv.");
      }

      const csv = await whatsappConsentService.exportOptedOutCsv(accountId, {
        fromDate: parseDate(query.fromDate),
        toDate: parseDate(query.toDate),
      });

      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const filename = `optouts-${today}.csv`;

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`
      );
      res.status(200).send(csv);
    } catch (error) {
      next(error);
    }
  }
}

export const whatsappConsentController = new WhatsappConsentController();
