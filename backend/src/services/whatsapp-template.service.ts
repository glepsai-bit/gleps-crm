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

/**
 * Regex unificada para variáveis de template de WhatsApp.
 * Aceita tanto `{nome}` quanto `{{ nome }}` (com espaços opcionais),
 * e nomes com pontos para acesso aninhado (ex.: `{{ contato.nome }}`).
 *
 * Compartilhada entre whatsapp-template.service e whatsapp-campaign.service
 * para garantir que extração e renderização usem exatamente o mesmo padrão.
 */
export const TEMPLATE_VAR_REGEX = /\{\{?\s*([\w.]+)\s*\}?\}/g;

/**
 * Extrai a lista de variáveis presentes em um template ({nome}, {{ valor }}, ...).
 * Retorna nomes únicos na ordem de primeira aparição.
 */
export function extractTemplateVariables(content: string): string[] {
  const found = new Set<string>();
  const ordered: string[] = [];
  if (!content) return ordered;
  const matches = content.matchAll(TEMPLATE_VAR_REGEX);
  for (const match of matches) {
    const name = match[1];
    if (!found.has(name)) {
      found.add(name);
      ordered.push(name);
    }
  }
  return ordered;
}

/**
 * Renderiza um template substituindo variáveis pelos valores fornecidos.
 * Variáveis sem valor correspondente viram string vazia.
 *
 * Aceita opcionalmente um callback `onMissing(name)` invocado uma vez por
 * variável declarada que não tem valor correspondente (útil para logging).
 */
export function renderTemplate(
  content: string,
  variables: Record<string, string> = {},
  onMissing?: (name: string) => void
): string {
  if (!content) return '';
  return content.replace(TEMPLATE_VAR_REGEX, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined || value === null) {
      if (onMissing) {
        try {
          onMissing(name);
        } catch {
          // callback nunca deve quebrar o render
        }
      }
      return '';
    }
    return String(value);
  });
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

    const variables = extractTemplateVariables(input.content);

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
        data.variables = extractTemplateVariables(input.content);
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
   * Renderiza um template substituindo variáveis ({nome}, {{ valor }}, ...) pelos
   * valores fornecidos. Variáveis sem valor correspondente viram string vazia.
   *
   * Delega para o helper `renderTemplate` para garantir consistência com
   * `whatsapp-campaign.service` e `extractTemplateVariables`.
   */
  render(content: string, variables: Record<string, string>): string {
    return renderTemplate(content, variables);
  }
}

export const whatsappTemplateService = new WhatsappTemplateService();
