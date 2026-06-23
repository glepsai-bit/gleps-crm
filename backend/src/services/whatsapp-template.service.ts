import { prisma } from '../config/database';
import { NotFoundError, ValidationError } from '../utils/errors';
import type { WhatsappTemplate } from '@prisma/client';

export interface CreateWhatsappTemplateInput {
  name: string;
  content: string;
  category?: string;
  createdById?: string;
}

export interface UpdateWhatsappTemplateInput {
  name?: string;
  content?: string;
  category?: string;
}

const VARIABLE_REGEX = /\{(\w+)\}/g;

/**
 * Extrai a lista de variáveis presentes em um template ({nome}, {valor}, ...).
 * Retorna nomes únicos na ordem de primeira aparição.
 */
function extractVariables(content: string): string[] {
  const found = new Set<string>();
  const ordered: string[] = [];
  const matches = content.matchAll(VARIABLE_REGEX);
  for (const match of matches) {
    const name = match[1];
    if (!found.has(name)) {
      found.add(name);
      ordered.push(name);
    }
  }
  return ordered;
}

class WhatsappTemplateService {
  /**
   * Lista todos os templates de WhatsApp da conta.
   */
  async list(accountId: string): Promise<WhatsappTemplate[]> {
    return prisma.whatsappTemplate.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Busca um template específico, garantindo escopo de accountId.
   */
  async get(id: string, accountId: string): Promise<WhatsappTemplate> {
    const template = await prisma.whatsappTemplate.findFirst({
      where: { id, accountId },
    });

    if (!template) {
      throw new NotFoundError('Template de WhatsApp');
    }

    return template;
  }

  /**
   * Cria um novo template de WhatsApp.
   * Extrai variáveis do conteúdo automaticamente.
   */
  async create(
    accountId: string,
    input: CreateWhatsappTemplateInput
  ): Promise<WhatsappTemplate> {
    if (!input.name || !input.name.trim()) {
      throw new ValidationError('Nome do template é obrigatório');
    }
    if (!input.content || !input.content.trim()) {
      throw new ValidationError('Conteúdo do template é obrigatório');
    }

    const variables = extractVariables(input.content);

    return prisma.whatsappTemplate.create({
      data: {
        accountId,
        name: input.name,
        content: input.content,
        category: input.category ?? 'custom',
        variables,
        createdById: input.createdById,
      },
    });
  }

  /**
   * Atualiza um template existente.
   * Se content mudou, recalcula 'variables'.
   */
  async update(
    id: string,
    accountId: string,
    input: UpdateWhatsappTemplateInput
  ): Promise<WhatsappTemplate> {
    const existing = await this.get(id, accountId);

    const data: {
      name?: string;
      content?: string;
      category?: string;
      variables?: string[];
    } = {};

    if (input.name !== undefined) {
      if (!input.name.trim()) {
        throw new ValidationError('Nome do template é obrigatório');
      }
      data.name = input.name;
    }

    if (input.content !== undefined) {
      if (!input.content.trim()) {
        throw new ValidationError('Conteúdo do template é obrigatório');
      }
      if (input.content !== existing.content) {
        data.content = input.content;
        data.variables = extractVariables(input.content);
      } else {
        data.content = input.content;
      }
    }

    if (input.category !== undefined) {
      data.category = input.category;
    }

    return prisma.whatsappTemplate.update({
      where: { id },
      data,
    });
  }

  /**
   * Remove um template (hard delete), garantindo escopo de accountId.
   */
  async delete(id: string, accountId: string): Promise<void> {
    await this.get(id, accountId);
    await prisma.whatsappTemplate.delete({ where: { id } });
  }

  /**
   * Renderiza um template substituindo variáveis ({nome}, {valor}, ...) pelos
   * valores fornecidos. Variáveis sem valor correspondente viram string vazia.
   */
  render(content: string, variables: Record<string, string>): string {
    return content.replace(VARIABLE_REGEX, (_match, name: string) => {
      const value = variables[name];
      return value !== undefined && value !== null ? String(value) : '';
    });
  }
}

export const whatsappTemplateService = new WhatsappTemplateService();
