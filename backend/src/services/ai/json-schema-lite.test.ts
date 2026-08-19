/**
 * T-027 Fase 1 — validador de saída estruturada + extração de JSON.
 *
 * Os schemas testados aqui são os dois do fluxo n8n atual (classificador e
 * respondente): é o formato que a migração precisa continuar aceitando.
 */

import { describe, it, expect } from 'vitest';
import { validateAgainstSchema, extractJson } from './json-schema-lite';

const SCHEMA_CLASSIFICADOR = {
  type: 'object',
  properties: {
    etapa: {
      type: 'string',
      enum: [
        'novo-lead',
        'em-atendimento',
        'aguardando-resposta',
        'agendado',
        'convertido',
        'perdido',
      ],
    },
    transferir_para_humano: { type: 'boolean' },
    confianca: { type: 'number' },
  },
  required: ['etapa', 'transferir_para_humano'],
};

describe('validateAgainstSchema', () => {
  it('aprova a saída do classificador do fluxo atual', () => {
    const r = validateAgainstSchema(
      { etapa: 'em-atendimento', transferir_para_humano: false, confianca: 0.92 },
      SCHEMA_CLASSIFICADOR
    );
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('reprova campo obrigatório ausente, dizendo qual', () => {
    const r = validateAgainstSchema({ etapa: 'novo-lead' }, SCHEMA_CLASSIFICADOR);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('transferir_para_humano');
  });

  it('reprova tipo errado', () => {
    const r = validateAgainstSchema(
      { etapa: 'novo-lead', transferir_para_humano: 'sim' },
      SCHEMA_CLASSIFICADOR
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('boolean');
  });

  it('reprova etapa fora do enum — é o que impede label inventada no kanban', () => {
    const r = validateAgainstSchema(
      { etapa: 'quase-fechando', transferir_para_humano: false },
      SCHEMA_CLASSIFICADOR
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('quase-fechando');
  });

  it('aceita null quando o type é uma lista com null', () => {
    const schema = { type: 'object', properties: { obs: { type: ['string', 'null'] } } };
    expect(validateAgainstSchema({ obs: null }, schema).valid).toBe(true);
    expect(validateAgainstSchema({ obs: 'ok' }, schema).valid).toBe(true);
    expect(validateAgainstSchema({ obs: 5 }, schema).valid).toBe(false);
  });

  it('valida itens de array', () => {
    const schema = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } };
    expect(validateAgainstSchema({ tags: ['a', 'b'] }, schema).valid).toBe(true);
    expect(validateAgainstSchema({ tags: ['a', 3] }, schema).valid).toBe(false);
  });

  it('não reprova construção que não entende (anyOf) — limitação declarada', () => {
    const schema = { anyOf: [{ type: 'string' }, { type: 'number' }] };
    expect(validateAgainstSchema('qualquer coisa', schema).valid).toBe(true);
  });

  it('integer distingue de number fracionário', () => {
    const schema = { type: 'object', properties: { n: { type: 'integer' } } };
    expect(validateAgainstSchema({ n: 3 }, schema).valid).toBe(true);
    expect(validateAgainstSchema({ n: 3.5 }, schema).valid).toBe(false);
  });
});

describe('extractJson', () => {
  it('lê JSON puro', () => {
    expect(extractJson('{"etapa":"novo-lead"}')).toEqual({ etapa: 'novo-lead' });
  });

  it('lê JSON dentro de bloco ```json — formato mais comum do modelo', () => {
    const raw = 'Claro!\n```json\n{"etapa":"agendado"}\n```\nQualquer coisa me chama.';
    expect(extractJson(raw)).toEqual({ etapa: 'agendado' });
  });

  it('lê JSON cercado de texto solto, sem bloco de código', () => {
    const raw = 'Segue a análise: {"etapa":"perdido","confianca":0.4} — foi isso.';
    expect(extractJson(raw)).toEqual({ etapa: 'perdido', confianca: 0.4 });
  });

  it('não se perde com chave dentro de string', () => {
    const raw = 'x {"msg":"ele disse } aqui","ok":true} y';
    expect(extractJson(raw)).toEqual({ msg: 'ele disse } aqui', ok: true });
  });

  it('devolve null quando não há JSON', () => {
    expect(extractJson('sem nada estruturado aqui')).toBeNull();
    expect(extractJson('')).toBeNull();
  });
});
