/**
 * T-027 Fase 1 — validador mínimo de JSON Schema para a saída do agente.
 *
 * Por que não uma lib: o único schema que passa por aqui é o que o admin
 * escreve na tela do agente, e ele descreve um objeto raso — os dois parsers do
 * fluxo n8n atual são exatamente isso ({etapa, transferir_para_humano,
 * confianca, ...}). Trazer ajv (e o eval de schema que vem junto) pra validar
 * meia dúzia de campos escalares não se paga.
 *
 * Cobre: type, properties, required, enum, items, nullable via type[].
 * NÃO cobre: $ref, allOf/anyOf/oneOf, condicionais, restrições numéricas.
 * Schema com essas construções passa reto — o validador nunca REPROVA o que
 * não entende, pra não travar um atendimento por limitação própria.
 */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

type JsonSchema = Record<string, unknown>;

export function validateAgainstSchema(value: unknown, schema: JsonSchema): ValidationResult {
  const errors: string[] = [];
  walk(value, schema, '', errors);
  return { valid: errors.length === 0, errors };
}

function walk(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if (!schema || typeof schema !== 'object') return;

  const where = path || 'raiz';

  const types = normalizeTypes(schema.type);
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    errors.push(`${where}: esperado ${types.join(' ou ')}, recebido ${describe(value)}`);
    return; // sem o tipo certo, validar filhos só geraria ruído
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    errors.push(`${where}: valor "${String(value)}" fora dos permitidos (${schema.enum.join(', ')})`);
  }

  if (types.includes('object') || (isPlainObject(value) && schema.properties)) {
    const obj = value as Record<string, unknown>;

    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && obj[key] === undefined) {
          errors.push(`${where}: campo obrigatório "${key}" ausente`);
        }
      }
    }

    const props = schema.properties as Record<string, JsonSchema> | undefined;
    if (props) {
      for (const [key, sub] of Object.entries(props)) {
        if (obj[key] !== undefined) {
          walk(obj[key], sub, path ? `${path}.${key}` : key, errors);
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    const items = schema.items as JsonSchema;
    value.forEach((item, i) => walk(item, items, `${path}[${i}]`, errors));
  }
}

function normalizeTypes(type: unknown): string[] {
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === 'string');
  return [];
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      // Tipo desconhecido não reprova — ver nota no topo.
      return true;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * A saída estruturada às vezes vem embrulhada — cercada por texto, ou dentro de
 * um bloco ```json. Recuperar isso vale mais que uma rodada extra de correção
 * com o modelo: é mais barato e mais rápido.
 */
export function extractJson(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1]?.trim(), text].filter((c): c is string => !!c);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // tenta o primeiro objeto/array balanceado dentro do texto
      const sliced = sliceBalanced(candidate);
      if (sliced) {
        try {
          return JSON.parse(sliced);
        } catch {
          /* segue pro próximo candidato */
        }
      }
    }
  }
  return null;
}

/** Primeiro { } ou [ ] balanceado, ignorando chaves dentro de string. */
function sliceBalanced(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
