import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../utils/errors';
import { escapeLike } from '../utils/helpers';
import { logger } from '../utils/logger';

/* ============================================================================
 * INTEGRATION CONTACTS API (T-CONTACTS-API)
 *
 * Endpoints externos (API key) que dão à IA via n8n autonomia sobre o
 * cadastro de contatos do CRM — sem JWT.
 *
 * Endpoints (montados em /api/integrations/contacts/*):
 *
 *   POST   /                          → cria ou upsert por telefone
 *   GET    /                          → lista paginada com filtros
 *   GET    /by-phone/:phone           → busca por telefone normalizado
 *   PATCH  /:id                       → atualiza campos básicos
 *   PATCH  /:id/custom-attributes     → merge nos custom attrs (preserva keys)
 *
 * Scopes:
 *   - contacts:read   → GET (list, by-phone)
 *   - contacts:write  → POST, PATCH
 *
 * Multi-tenant: tudo escopado por req.accountId (populado pelo requireApiKey).
 * Cross-tenant lookups devolvem 404 — nunca expomos a existência do recurso.
 *
 * Custom attributes são guardados em Contact.customAttributes (jsonb).
 * Mutations fazem MERGE (não substituem) — preserva keys não mencionadas.
 * ========================================================================= */

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Normaliza telefone: remove tudo que não for dígito.
 * Aceita "+5534993383017", "55 34 9 9338-3017" etc — devolve "5534993383017".
 * Devolve null se não restar nenhum dígito.
 */
function normalizePhone(input: string | undefined | null): string | null {
  if (!input) return null;
  const onlyDigits = String(input).replace(/\D+/g, '');
  if (onlyDigits.length === 0) return null;
  return onlyDigits;
}

/** Regex chave de custom attribute: alfanumérico + underscore, começa com letra/_. */
const ATTR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Valida shape de customAttributes:
 *  - objeto plano (não array, não null)
 *  - chaves alfanuméricas + underscore
 *  - valores: string/number/boolean/null  (sem nested objects pra evitar
 *    bag de dados ad-hoc difícil de filtrar)
 */
function assertValidAttrs(attrs: unknown): asserts attrs is Record<string, unknown> {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) {
    throw new ValidationError('customAttributes deve ser um objeto plano');
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (!ATTR_KEY_RE.test(key)) {
      throw new ValidationError(
        `customAttributes: chave "${key}" inválida (apenas letras, números e underscore; começar com letra ou _)`
      );
    }
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new ValidationError(
        `customAttributes: valor de "${key}" deve ser string, number, boolean ou null`
      );
    }
  }
}

/**
 * Faz merge raso: existing + patch.
 * Chave com valor `null` em `patch` REMOVE a key (idioma n8n usual).
 * Chaves em `existing` não mencionadas em `patch` são preservadas.
 */
function mergeAttrs(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Garante que o jsonb retornado pelo Prisma seja sempre um objeto plano. */
function attrsAsObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}

// ───────────────────────────────────────────────────────────────────────────
// Schemas
// ───────────────────────────────────────────────────────────────────────────

const phoneSchema = z
  .string()
  .trim()
  .min(1, 'telefone não pode ser vazio')
  .refine(
    (v) => {
      const digits = v.replace(/\D+/g, '');
      return digits.length >= 10 && digits.length <= 15;
    },
    { message: 'telefone inválido (10-15 dígitos, com ou sem +)' }
  );

const emailSchema = z.string().trim().min(1, 'email vazio').email('email inválido');

// Aceita um Record genérico — validação fina (chaves/valores) feita por
// assertValidAttrs() depois do parse.
const customAttributesSchema = z.record(z.unknown());

const createContactSchema = z
  .object({
    nome: z
      .string()
      .trim()
      .min(1, 'Nome obrigatório')
      .max(120, 'Nome deve ter no máximo 120 caracteres'),
    telefone: phoneSchema.optional(),
    email: emailSchema.optional(),
    origem: z
      .enum(['whatsapp', 'instagram', 'site', 'indicacao', 'integration', 'outro'])
      .optional(),
    customAttributes: customAttributesSchema.optional(),
    upsert: z.boolean().optional(),
  })
  .strict();

const updateContactSchema = z
  .object({
    nome: z
      .string()
      .trim()
      .min(1, 'Nome não pode ser vazio')
      .max(120, 'Nome deve ter no máximo 120 caracteres')
      .optional(),
    telefone: phoneSchema.optional(),
    email: emailSchema.optional(),
    origem: z
      .enum(['whatsapp', 'instagram', 'site', 'indicacao', 'integration', 'outro'])
      .optional(),
  })
  .strict();

// PATCH /:id/custom-attributes aceita { attrs } OU { customAttributes } pra
// reduzir atrito com payloads do n8n (ambos os nomes aparecem na natureza).
const patchAttrsSchema = z
  .object({
    attrs: customAttributesSchema.optional(),
    customAttributes: customAttributesSchema.optional(),
  })
  .refine((d) => Boolean(d.attrs || d.customAttributes), {
    message: 'Informe "attrs" OU "customAttributes"',
  });

const listQuerySchema = z.object({
  phone: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  upsert: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional(),
});

const idSchema = z.string().uuid({ message: 'id deve ser um UUID válido' });

// ───────────────────────────────────────────────────────────────────────────
// Serialização canonica
// ───────────────────────────────────────────────────────────────────────────

function serializeContact(c: {
  id: string;
  accountId: string;
  nome: string | null;
  telefone: string | null;
  email: string | null;
  origem: string | null;
  customAttributes: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: c.id,
    accountId: c.accountId,
    nome: c.nome,
    telefone: c.telefone,
    email: c.email,
    origem: c.origem,
    customAttributes: attrsAsObject(c.customAttributes),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Controller
// ───────────────────────────────────────────────────────────────────────────

class IntegrationContactsController {
  /**
   * POST /api/integrations/contacts
   *
   * Cria contato (default) OU upsert por telefone (se body.upsert=true OU
   * ?upsert=true). No upsert, campos não-nulos do payload sobrescrevem +
   * customAttributes faz MERGE com o existente.
   */
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.accountId;
      if (!accountId) {
        throw new UnauthorizedError('API key inválida ou revogada');
      }

      const body = createContactSchema.parse(req.body ?? {});

      // upsert pode vir no body OU na query (?upsert=true). Default: false —
      // semântica "criar"; com upsert=true vira "criar OU atualizar".
      const upsert =
        body.upsert === true ||
        req.query.upsert === 'true' ||
        req.query.upsert === '1';

      if (body.customAttributes) {
        assertValidAttrs(body.customAttributes);
      }

      const normalizedPhone = body.telefone ? normalizePhone(body.telefone) : null;

      // Se telefone informado, checa duplicidade dentro do tenant (unique
      // parcial em contacts(account_id, telefone) WHERE telefone IS NOT NULL).
      let existing: Awaited<ReturnType<typeof prisma.contact.findFirst>> | null = null;
      if (normalizedPhone) {
        existing = await prisma.contact.findFirst({
          where: { accountId, telefone: normalizedPhone },
        });
      }

      if (existing) {
        if (!upsert) {
          throw new ConflictError(
            'Contato com este telefone já existe nesta conta',
            { contactId: existing.id, telefone: existing.telefone }
          );
        }

        // upsert: atualiza campos informados, merge custom attributes
        const mergedAttrs = body.customAttributes
          ? mergeAttrs(attrsAsObject(existing.customAttributes), body.customAttributes)
          : attrsAsObject(existing.customAttributes);

        const updated = await prisma.contact.update({
          where: { id: existing.id },
          data: {
            nome: body.nome, // sempre exigido no schema → sempre sobrescreve
            email: body.email ?? existing.email,
            origem: (body.origem ?? existing.origem) as any,
            customAttributes: mergedAttrs as Prisma.InputJsonValue,
          },
        });

        logger.info('[integration-contacts] upsert update', {
          accountId,
          apiKeyId: req.apiKey?.id ?? null,
          contactId: updated.id,
        });

        res.status(200).json({
          data: serializeContact(updated),
          created: false,
          updated: true,
        });
        return;
      }

      // Cria novo
      try {
        const created = await prisma.contact.create({
          data: {
            accountId,
            nome: body.nome,
            telefone: normalizedPhone,
            email: body.email ?? null,
            origem: (body.origem ?? 'integration') as any,
            customAttributes: (body.customAttributes ?? {}) as Prisma.InputJsonValue,
          },
        });

        logger.info('[integration-contacts] create', {
          accountId,
          apiKeyId: req.apiKey?.id ?? null,
          contactId: created.id,
        });

        res.status(201).json({
          data: serializeContact(created),
          created: true,
          updated: false,
        });
      } catch (err) {
        // P2002 = unique constraint (corrida raríssima: outro request inseriu
        // o mesmo telefone entre o findFirst e o create acima).
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          normalizedPhone
        ) {
          if (upsert) {
            // Reexecuta como upsert: busca de novo e atualiza
            const after = await prisma.contact.findFirst({
              where: { accountId, telefone: normalizedPhone },
            });
            if (after) {
              const mergedAttrs = body.customAttributes
                ? mergeAttrs(attrsAsObject(after.customAttributes), body.customAttributes)
                : attrsAsObject(after.customAttributes);
              const updated = await prisma.contact.update({
                where: { id: after.id },
                data: {
                  nome: body.nome,
                  email: body.email ?? after.email,
                  origem: (body.origem ?? after.origem) as any,
                  customAttributes: mergedAttrs as Prisma.InputJsonValue,
                },
              });
              res.status(200).json({
                data: serializeContact(updated),
                created: false,
                updated: true,
              });
              return;
            }
          }
          throw new ConflictError(
            'Contato com este telefone já existe nesta conta',
            { telefone: normalizedPhone }
          );
        }
        throw err;
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('Payload inválido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /**
   * GET /api/integrations/contacts/by-phone/:phone
   *
   * Busca exata por telefone normalizado (qualquer formato de entrada).
   */
  async getByPhone(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.accountId;
      if (!accountId) {
        throw new UnauthorizedError('API key inválida ou revogada');
      }

      const rawPhone = typeof req.params.phone === 'string' ? req.params.phone : '';
      const normalized = normalizePhone(rawPhone);
      if (!normalized) {
        throw new ValidationError('Telefone inválido');
      }

      const contact = await prisma.contact.findFirst({
        where: { accountId, telefone: normalized },
      });

      if (!contact) {
        throw new NotFoundError('Contato');
      }

      res.status(200).json({ data: serializeContact(contact) });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/contacts
   *
   * Query params suportados:
   *   - phone          → busca exata por telefone normalizado
   *   - search         → ILIKE em nome/email/telefone (com escapeLike)
   *   - attr.{key}={v} → filtro exato de custom attribute (jsonb)
   *   - attr.{key}.month_day={MM-DD} → matchea o "MM-DD" do valor (date) —
   *                                    útil pra aniversariantes
   *   - limit (default 50, max 200), offset
   *
   * Retorna paginado: { data, total, limit, offset }.
   */
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.accountId;
      if (!accountId) {
        throw new UnauthorizedError('API key inválida ou revogada');
      }

      const parsed = listQuerySchema.parse(req.query);

      const limit = Math.min(Math.max(parsed.limit ?? 50, 1), 200);
      const offset = Math.max(parsed.offset ?? 0, 0);

      const where: Prisma.ContactWhereInput = { accountId };
      const andConditions: Prisma.ContactWhereInput[] = [];

      // Filtro phone exato (normalizado)
      if (parsed.phone) {
        const norm = normalizePhone(parsed.phone);
        if (!norm) {
          throw new ValidationError('phone inválido');
        }
        andConditions.push({ telefone: norm });
      }

      // Filtro search (nome / email / telefone)
      if (parsed.search) {
        const safe = escapeLike(parsed.search);
        andConditions.push({
          OR: [
            { nome: { contains: safe, mode: 'insensitive' } },
            { email: { contains: safe, mode: 'insensitive' } },
            { telefone: { contains: safe } },
          ],
        });
      }

      // Filtros attr.* — parseamos manualmente porque o nome da key é dinâmico
      // ?attr.plano=Anual                       → customAttributes->>'plano' = 'Anual'
      // ?attr.data_nascimento.month_day=06-28   → match no formato MM-DD da data ISO
      const attrFilters = this.extractAttrFilters(req.query);
      for (const f of attrFilters) {
        if (!ATTR_KEY_RE.test(f.key)) {
          throw new ValidationError(
            `attr.${f.key}: nome de atributo inválido (apenas letras/números/underscore)`
          );
        }

        if (f.kind === 'eq') {
          // customAttributes->>'key' = 'value' (PostgreSQL jsonb)
          // Esta versão do Prisma client não expõe `string_equals`/`equals`
          // de forma consistente entre Postgres e MySQL — usamos $queryRaw
          // e filtramos via id IN (...) pra manter portabilidade.
          const matchingIds = await prisma.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`
              SELECT id::text FROM contacts
              WHERE account_id = ${accountId}::uuid
                AND custom_attributes->>${f.key} = ${f.value}
            `
          );
          const ids = matchingIds.map((r) => r.id);
          if (ids.length === 0) {
            res.status(200).json({ data: [], total: 0, limit, offset });
            return;
          }
          andConditions.push({ id: { in: ids } });
        } else if (f.kind === 'month_day') {
          // Valor MM-DD (ex: "06-28"). Filtramos com raw SQL (Prisma JSON ops
          // não tem regex). Usamos $queryRaw → IDs e depois filtramos in.
          if (!/^\d{2}-\d{2}$/.test(f.value)) {
            throw new ValidationError(
              `attr.${f.key}.month_day deve estar no formato MM-DD`
            );
          }
          // strpos('06-28', substring(value from 6 for 5)) — ou usamos LIKE.
          // Mais portável: SUBSTRING(value, 6, 5) = 'MM-DD' (assume ISO yyyy-mm-dd).
          // Também aceitamos formato pt-BR "dd/mm/yyyy" — convertemos via SUBSTRING.
          const matchingIds = await prisma.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`
              SELECT id::text FROM contacts
              WHERE account_id = ${accountId}::uuid
                AND (
                  -- ISO yyyy-mm-dd → mês-dia em chars 6..10
                  SUBSTRING((custom_attributes->>${f.key}) FROM 6 FOR 5) = ${f.value}
                  OR
                  -- pt-BR dd/mm/yyyy → mês-dia em chars 4..5 + '-' + 1..2
                  SUBSTRING((custom_attributes->>${f.key}) FROM 4 FOR 2) || '-' || SUBSTRING((custom_attributes->>${f.key}) FROM 1 FOR 2) = ${f.value}
                )
            `
          );
          const ids = matchingIds.map((r) => r.id);
          if (ids.length === 0) {
            res.status(200).json({ data: [], total: 0, limit, offset });
            return;
          }
          andConditions.push({ id: { in: ids } });
        }
      }

      if (andConditions.length > 0) {
        where.AND = andConditions;
      }

      const [rows, total] = await Promise.all([
        prisma.contact.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
        }),
        prisma.contact.count({ where }),
      ]);

      res.status(200).json({
        data: rows.map(serializeContact),
        total,
        limit,
        offset,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('Query inválida', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /**
   * PATCH /api/integrations/contacts/:id
   *
   * Atualiza campos básicos (nome/telefone/email/origem). Cross-tenant 404.
   */
  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.accountId;
      if (!accountId) {
        throw new UnauthorizedError('API key inválida ou revogada');
      }

      const id = idSchema.parse(req.params.id);
      const body = updateContactSchema.parse(req.body ?? {});

      // Cross-tenant: lookup limitado ao tenant da api key → 404 se não existir
      const existing = await prisma.contact.findFirst({
        where: { id, accountId },
      });
      if (!existing) {
        throw new NotFoundError('Contato');
      }

      const data: Prisma.ContactUpdateInput = {};
      if (body.nome !== undefined) data.nome = body.nome;
      if (body.email !== undefined) data.email = body.email;
      if (body.origem !== undefined) data.origem = body.origem as any;
      if (body.telefone !== undefined) {
        const norm = normalizePhone(body.telefone);
        if (!norm) {
          throw new ValidationError('telefone inválido');
        }
        data.telefone = norm;
      }

      try {
        const updated = await prisma.contact.update({
          where: { id },
          data,
        });

        logger.info('[integration-contacts] patch', {
          accountId,
          apiKeyId: req.apiKey?.id ?? null,
          contactId: id,
        });

        res.status(200).json({ data: serializeContact(updated) });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          throw new ConflictError(
            'Telefone já em uso por outro contato nesta conta'
          );
        }
        throw err;
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('Payload inválido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /**
   * PATCH /api/integrations/contacts/:id/custom-attributes
   *
   * Faz MERGE no jsonb existente (preserva keys não mencionadas). Valor `null`
   * remove a key (semântica idiomática em integrações).
   */
  async patchCustomAttributes(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.accountId;
      if (!accountId) {
        throw new UnauthorizedError('API key inválida ou revogada');
      }

      const id = idSchema.parse(req.params.id);
      const body = patchAttrsSchema.parse(req.body ?? {});

      const patch = (body.attrs ?? body.customAttributes ?? {}) as Record<string, unknown>;
      assertValidAttrs(patch);

      const existing = await prisma.contact.findFirst({
        where: { id, accountId },
      });
      if (!existing) {
        throw new NotFoundError('Contato');
      }

      const merged = mergeAttrs(attrsAsObject(existing.customAttributes), patch);

      const updated = await prisma.contact.update({
        where: { id },
        data: { customAttributes: merged as Prisma.InputJsonValue },
      });

      logger.info('[integration-contacts] patch custom-attributes', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        contactId: id,
        keys: Object.keys(patch),
      });

      res.status(200).json({ data: serializeContact(updated) });
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('Payload inválido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /**
   * Lê `attr.foo=bar` e `attr.foo.month_day=06-28` direto do req.query.
   * Express parseia "attr.foo" como string (não objeto aninhado) em queries
   * simples — então iteramos manualmente.
   */
  private extractAttrFilters(
    query: Record<string, unknown>
  ): Array<
    | { kind: 'eq'; key: string; value: string }
    | { kind: 'month_day'; key: string; value: string }
  > {
    const out: Array<
      | { kind: 'eq'; key: string; value: string }
      | { kind: 'month_day'; key: string; value: string }
    > = [];

    for (const [rawKey, rawVal] of Object.entries(query)) {
      if (!rawKey.startsWith('attr.')) continue;
      const value = Array.isArray(rawVal) ? String(rawVal[0]) : String(rawVal);
      const path = rawKey.slice('attr.'.length);
      if (path.endsWith('.month_day')) {
        const attrKey = path.slice(0, -'.month_day'.length);
        out.push({ kind: 'month_day', key: attrKey, value });
      } else {
        out.push({ kind: 'eq', key: path, value });
      }
    }
    return out;
  }
}

export const integrationContactsController = new IntegrationContactsController();
