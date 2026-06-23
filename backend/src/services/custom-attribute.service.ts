import { prisma } from '../config/database';
import { CustomAttributeDefinition, Prisma } from '@prisma/client';
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors';

/**
 * Custom Attribute Definitions (T-022)
 *
 * Permite que cada accountId defina campos customizados para 3 escopos:
 * - conversation
 * - contact
 * - account
 *
 * Tipos suportados: text | number | date | list | boolean
 * Para type=list, `options` é um array de strings (Json no Postgres).
 */

export type CustomAttributeScope = 'conversation' | 'contact' | 'account';
export type CustomAttributeType = 'text' | 'number' | 'date' | 'list' | 'boolean';

const VALID_SCOPES: CustomAttributeScope[] = ['conversation', 'contact', 'account'];
const VALID_TYPES: CustomAttributeType[] = ['text', 'number', 'date', 'list', 'boolean'];

// Permite letras, números e underscore; precisa começar com letra
const KEY_REGEX = /^[a-z][a-z0-9_]{0,79}$/i;

export interface CreateCustomAttributeInput {
  scope: CustomAttributeScope | string;
  key: string;
  label: string;
  type: CustomAttributeType | string;
  options?: string[] | null;
  required?: boolean;
}

export interface UpdateCustomAttributeInput {
  label?: string;
  type?: CustomAttributeType | string;
  options?: string[] | null;
  required?: boolean;
}

class CustomAttributeService {
  /**
   * Lista definições de uma conta, opcionalmente filtrando por escopo.
   */
  async list(accountId: string, scope?: CustomAttributeScope | string): Promise<CustomAttributeDefinition[]> {
    const where: { accountId: string; scope?: string } = { accountId };

    if (scope) {
      this.assertValidScope(scope);
      where.scope = scope;
    }

    return prisma.customAttributeDefinition.findMany({
      where,
      orderBy: [{ scope: 'asc' }, { key: 'asc' }],
    });
  }

  /**
   * Busca uma definição por id, validando o accountId.
   */
  async get(id: string, accountId: string): Promise<CustomAttributeDefinition> {
    const definition = await prisma.customAttributeDefinition.findFirst({
      where: { id, accountId },
    });

    if (!definition) {
      throw new NotFoundError('Custom attribute');
    }

    return definition;
  }

  /**
   * Busca uma definição pelo par (scope, key) — útil para validação em runtime.
   */
  async getDefinitionByKey(
    accountId: string,
    scope: CustomAttributeScope | string,
    key: string
  ): Promise<CustomAttributeDefinition | null> {
    return prisma.customAttributeDefinition.findUnique({
      where: {
        accountId_scope_key: {
          accountId,
          scope,
          key,
        },
      },
    });
  }

  /**
   * Cria uma nova definição. Garante unicidade por (accountId, scope, key).
   */
  async create(
    accountId: string,
    input: CreateCustomAttributeInput
  ): Promise<CustomAttributeDefinition> {
    this.assertValidScope(input.scope);
    this.assertValidType(input.type);
    this.assertValidKey(input.key);

    if (!input.label || input.label.trim().length === 0) {
      throw new ValidationError('Label é obrigatório');
    }

    if (input.type === 'list') {
      this.assertValidOptions(input.options);
    }

    const existing = await this.getDefinitionByKey(accountId, input.scope, input.key);
    if (existing) {
      throw new ConflictError('Já existe um atributo customizado com este key neste escopo', {
        scope: input.scope,
        key: input.key,
      });
    }

    return prisma.customAttributeDefinition.create({
      data: {
        accountId,
        scope: input.scope,
        key: input.key,
        label: input.label.trim(),
        type: input.type,
        options:
          input.type === 'list'
            ? (input.options as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        required: input.required ?? false,
      },
    });
  }

  /**
   * Atualiza uma definição (não permite mexer em scope/key — são parte da identidade).
   */
  async update(
    id: string,
    accountId: string,
    partial: UpdateCustomAttributeInput
  ): Promise<CustomAttributeDefinition> {
    const existing = await this.get(id, accountId);

    const data: Prisma.CustomAttributeDefinitionUpdateInput = {};

    if (partial.label !== undefined) {
      if (!partial.label || partial.label.trim().length === 0) {
        throw new ValidationError('Label não pode ser vazio');
      }
      data.label = partial.label.trim();
    }

    if (partial.type !== undefined) {
      this.assertValidType(partial.type);
      data.type = partial.type;
    }

    if (partial.required !== undefined) {
      data.required = partial.required;
    }

    const effectiveType = ((partial.type as string | undefined) ?? existing.type) as CustomAttributeType;

    if (effectiveType === 'list') {
      // Se está mudando para list ou já era list e veio options, valida
      if (partial.options !== undefined) {
        this.assertValidOptions(partial.options);
        data.options = partial.options as Prisma.InputJsonValue;
      } else if (partial.type === 'list' && !existing.options) {
        throw new ValidationError('Atributo do tipo list precisa de options');
      }
    } else if (partial.options !== undefined || partial.type !== undefined) {
      // Mudou pra um tipo que não é list → limpa options
      data.options = Prisma.JsonNull;
    }

    return prisma.customAttributeDefinition.update({
      where: { id },
      data,
    });
  }

  /**
   * Remove uma definição. Não toca em dados existentes (ficam órfãos nos JSONs).
   */
  async delete(id: string, accountId: string): Promise<void> {
    await this.get(id, accountId);
    await prisma.customAttributeDefinition.delete({ where: { id } });
  }

  /**
   * Valida um valor contra a definição. Retorna true se válido, false caso contrário.
   * - null/undefined: válido somente se !required
   * - text: string
   * - number: number finito (aceita string numérica convertível)
   * - date: Date válida ou string ISO parseable
   * - list: precisa estar entre options
   * - boolean: boolean (aceita "true"/"false")
   */
  validateValue(definition: CustomAttributeDefinition, value: unknown): boolean {
    if (value === null || value === undefined || value === '') {
      return !definition.required;
    }

    switch (definition.type as CustomAttributeType) {
      case 'text':
        return typeof value === 'string';

      case 'number': {
        if (typeof value === 'number') return Number.isFinite(value);
        if (typeof value === 'string' && value.trim() !== '') {
          const n = Number(value);
          return Number.isFinite(n);
        }
        return false;
      }

      case 'date': {
        if (value instanceof Date) return !Number.isNaN(value.getTime());
        if (typeof value === 'string') {
          const d = new Date(value);
          return !Number.isNaN(d.getTime());
        }
        return false;
      }

      case 'list': {
        const options = this.parseOptions(definition.options);
        if (!options || options.length === 0) return false;
        if (typeof value !== 'string') return false;
        return options.includes(value);
      }

      case 'boolean':
        if (typeof value === 'boolean') return true;
        if (typeof value === 'string') {
          const v = value.toLowerCase();
          return v === 'true' || v === 'false';
        }
        return false;

      default:
        return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers privados
  // ---------------------------------------------------------------------------

  private assertValidScope(scope: string): void {
    if (!VALID_SCOPES.includes(scope as CustomAttributeScope)) {
      throw new ValidationError(
        `Scope inválido. Esperado: ${VALID_SCOPES.join(' | ')}`,
        { scope }
      );
    }
  }

  private assertValidType(type: string): void {
    if (!VALID_TYPES.includes(type as CustomAttributeType)) {
      throw new ValidationError(
        `Type inválido. Esperado: ${VALID_TYPES.join(' | ')}`,
        { type }
      );
    }
  }

  private assertValidKey(key: string): void {
    if (!key || !KEY_REGEX.test(key)) {
      throw new ValidationError(
        'Key inválido. Use letras/números/underscore, começando com letra (max 80 chars).',
        { key }
      );
    }
  }

  private assertValidOptions(options: unknown): asserts options is string[] {
    if (!Array.isArray(options) || options.length === 0) {
      throw new ValidationError('Atributo do tipo list precisa de options (array não vazio)');
    }
    if (!options.every(o => typeof o === 'string' && o.trim().length > 0)) {
      throw new ValidationError('Options precisa ser um array de strings não vazias');
    }
  }

  private parseOptions(raw: unknown): string[] | null {
    if (raw === null || raw === undefined) return null;
    if (Array.isArray(raw)) {
      return raw.filter((o): o is string => typeof o === 'string');
    }
    return null;
  }
}

export const customAttributeService = new CustomAttributeService();
