import { CannedResponse, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';

export interface CreateCannedResponseInput {
  shortCode: string;
  content: string;
  description?: string | null;
  createdById?: string | null;
}

export interface UpdateCannedResponseInput {
  shortCode?: string;
  content?: string;
  description?: string | null;
}

/**
 * Normaliza o shortCode: trim, lowercase, sem barra inicial.
 * Ex.: "/Saudacao " -> "saudacao"
 */
function normalizeShortCode(raw: string): string {
  const trimmed = (raw ?? '').trim().toLowerCase();
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
}

class CannedResponseService {
  /**
   * Lista respostas prontas da conta. `search` aplica filtro case-insensitive
   * em shortCode/content/description.
   */
  async list(accountId: string, search?: string): Promise<CannedResponse[]> {
    const where: Prisma.CannedResponseWhereInput = { accountId };

    if (search && search.trim().length > 0) {
      const term = search.trim();
      where.OR = [
        { shortCode: { contains: term, mode: 'insensitive' } },
        { content: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
      ];
    }

    return prisma.cannedResponse.findMany({
      where,
      orderBy: { shortCode: 'asc' },
    });
  }

  /**
   * Busca por id, escopado pela conta.
   */
  async get(id: string, accountId: string): Promise<CannedResponse> {
    const record = await prisma.cannedResponse.findFirst({
      where: { id, accountId },
    });

    if (!record) {
      throw new NotFoundError('Resposta pronta');
    }

    return record;
  }

  /**
   * Busca por shortCode dentro da conta. Retorna null se não encontrado.
   */
  async findByShortCode(accountId: string, shortCode: string): Promise<CannedResponse | null> {
    const normalized = normalizeShortCode(shortCode);
    if (!normalized) {
      return null;
    }

    return prisma.cannedResponse.findUnique({
      where: {
        accountId_shortCode: {
          accountId,
          shortCode: normalized,
        },
      },
    });
  }

  /**
   * Cria nova resposta pronta. shortCode é normalizado (lowercase, sem "/").
   * Lança ConflictError se já existir shortCode na conta.
   */
  async create(
    accountId: string,
    input: CreateCannedResponseInput
  ): Promise<CannedResponse> {
    const shortCode = normalizeShortCode(input.shortCode);

    if (!shortCode) {
      throw new ValidationError('shortCode é obrigatório');
    }

    if (shortCode.length > 80) {
      throw new ValidationError('shortCode excede 80 caracteres');
    }

    if (!input.content || input.content.trim().length === 0) {
      throw new ValidationError('content é obrigatório');
    }

    try {
      return await prisma.cannedResponse.create({
        data: {
          accountId,
          shortCode,
          content: input.content,
          description: input.description ?? null,
          createdById: input.createdById ?? null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictError('Já existe uma resposta pronta com este shortCode', {
          shortCode,
        });
      }
      throw error;
    }
  }

  /**
   * Atualização parcial. Garante escopo da conta e normaliza shortCode quando enviado.
   */
  async update(
    id: string,
    accountId: string,
    input: UpdateCannedResponseInput
  ): Promise<CannedResponse> {
    // Garante existência + escopo
    await this.get(id, accountId);

    const data: Prisma.CannedResponseUpdateInput = {};

    if (input.shortCode !== undefined) {
      const shortCode = normalizeShortCode(input.shortCode);
      if (!shortCode) {
        throw new ValidationError('shortCode é obrigatório');
      }
      if (shortCode.length > 80) {
        throw new ValidationError('shortCode excede 80 caracteres');
      }
      data.shortCode = shortCode;
    }

    if (input.content !== undefined) {
      if (!input.content || input.content.trim().length === 0) {
        throw new ValidationError('content é obrigatório');
      }
      data.content = input.content;
    }

    if (input.description !== undefined) {
      data.description = input.description;
    }

    try {
      return await prisma.cannedResponse.update({
        where: { id },
        data,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictError('Já existe uma resposta pronta com este shortCode', {
          shortCode: data.shortCode as string | undefined,
        });
      }
      throw error;
    }
  }

  /**
   * Remove a resposta pronta. Escopado pela conta.
   */
  async delete(id: string, accountId: string): Promise<void> {
    // Garante existência + escopo (lança NotFoundError se faltar)
    await this.get(id, accountId);

    await prisma.cannedResponse.delete({
      where: { id },
    });
  }
}

export const cannedResponseService = new CannedResponseService();
