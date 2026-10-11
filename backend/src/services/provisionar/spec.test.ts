/**
 * PROVISIONAMENTO — o zod do spec v1: defaults, limites e mensagens em
 * português. Quem lê o erro é o operador montando o JSON em outra pasta; a
 * mensagem precisa dizer o campo e o que está errado, sem conhecer o código.
 */

import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { specSchema, validarSpec, etapasDoSpec, MAX_SERVICOS, MAX_FAQ } from './spec';
import { SPEC_MINIMO, SPEC_CLINICA } from './fixtures.test-util';

function erros(bruto: unknown): { caminho: string; mensagem: string }[] {
  try {
    validarSpec(bruto);
  } catch (err) {
    if (err instanceof ZodError) {
      return err.errors.map((e) => ({ caminho: e.path.join('.'), mensagem: e.message }));
    }
    throw err;
  }
  throw new Error('esperava erro de validação');
}

describe('spec v1 — aceita e normaliza', () => {
  it('o mínimo passa e ganha os defaults (agenda off, funil padrão, transferência, follow-up off)', () => {
    const s = validarSpec(SPEC_MINIMO);
    expect(s.agenda.ativo).toBe(false);
    expect(s.funil).toEqual({ etapaAoAtender: 'Em atendimento', etapaAoAgendar: 'Agendado', etapaAoTransferir: 'Com humano' });
    expect(s.transferencia.mensagemAoCliente).toContain('um instante');
    expect(s.followup.ativo).toBe(false);
    expect(s.servicos).toEqual([]);
    expect(s.conhecimento).toEqual({ textos: [], faq: [] });
  });

  it('o spec completo da clínica passa inteiro', () => {
    const s = specSchema.parse(SPEC_CLINICA);
    expect(s.agenda.ativo).toBe(true);
    expect(s.servicos).toHaveLength(2);
    expect(s.servicos[1].valorPadrao).toBe(0); // default
    expect(s.triagem.camposMemoria[0].chave).toBe('motivo');
  });

  it('etapasDoSpec tira repetição (case-insensitive) e vazio', () => {
    const s = validarSpec({
      ...SPEC_MINIMO,
      funil: { etapaAoAtender: 'Em atendimento', etapaAoAgendar: 'EM ATENDIMENTO', etapaAoTransferir: 'Com humano' },
    });
    expect(etapasDoSpec(s)).toEqual(['Em atendimento', 'Com humano']);
  });
});

describe('spec v1 — 10 erros, cada um com mensagem em português e caminho', () => {
  it('1. versao diferente de 1', () => {
    const e = erros({ ...SPEC_MINIMO, versao: 2 });
    expect(e[0]).toEqual({ caminho: 'versao', mensagem: 'versao precisa ser 1 (única versão suportada)' });
  });

  it('2. negocio.nome ausente', () => {
    const e = erros({ ...SPEC_MINIMO, negocio: { ...SPEC_MINIMO.negocio, nome: undefined } });
    expect(e[0].caminho).toBe('negocio.nome');
    expect(e[0].mensagem).toBe('negocio.nome é obrigatório');
  });

  it('3. segmento fora da lista', () => {
    const e = erros({ ...SPEC_MINIMO, negocio: { ...SPEC_MINIMO.negocio, segmento: 'padaria' } });
    expect(e[0].caminho).toBe('negocio.segmento');
    expect(e[0].mensagem).toBe('segmento precisa ser um de: clinica, estetica, academia, servicos, outro');
  });

  it('4. tom inválido', () => {
    const e = erros({ ...SPEC_MINIMO, agente: { ...SPEC_MINIMO.agente, tom: 'bravo' } });
    expect(e[0]).toEqual({ caminho: 'agente.tom', mensagem: 'tom precisa ser um de: acolhedor, direto, formal, descontraido' });
  });

  it('5. temperatura fora de 0–2', () => {
    const e = erros({ ...SPEC_MINIMO, agente: { ...SPEC_MINIMO.agente, temperatura: 3 } });
    expect(e[0]).toEqual({ caminho: 'agente.temperatura', mensagem: 'temperatura vai de 0 a 2' });
  });

  it('6. serviço com duração fora de 5–600', () => {
    const e = erros({ ...SPEC_MINIMO, servicos: [{ nome: 'Avaliação', duracaoMinutos: 4 }] });
    expect(e[0]).toEqual({ caminho: 'servicos.0.duracaoMinutos', mensagem: 'duracaoMinutos precisa ser entre 5 e 600' });
  });

  it('7. mais de 50 serviços', () => {
    const servicos = Array.from({ length: MAX_SERVICOS + 1 }, (_, i) => ({ nome: `S${i}`, duracaoMinutos: 30 }));
    const e = erros({ ...SPEC_MINIMO, servicos });
    expect(e[0]).toEqual({ caminho: 'servicos', mensagem: 'servicos: no máximo 50' });
  });

  it('8. horário com fim antes do início e HH:MM inválido', () => {
    const e = erros({
      ...SPEC_MINIMO,
      agenda: { ativo: true, horarios: [{ dias: [1], inicio: '18:00', fim: '08:00' }, { dias: [2], inicio: '9h', fim: '18:00' }] },
    });
    expect(e).toContainEqual({ caminho: 'agenda.horarios.0.fim', mensagem: 'fim precisa vir depois de inicio' });
    expect(e).toContainEqual({ caminho: 'agenda.horarios.1.inicio', mensagem: 'inicio precisa ser HH:MM' });
  });

  it('9. e-mail de profissional inválido e chave de memória com espaço', () => {
    const e = erros({
      ...SPEC_MINIMO,
      agenda: { ativo: true, profissionais: [{ email: 'nao-e-email' }] },
      triagem: { camposMemoria: [{ chave: 'Motivo do contato', descricao: 'x' }] },
    });
    expect(e).toContainEqual({ caminho: 'agenda.profissionais.0.email', mensagem: 'e-mail do profissional inválido' });
    expect(e.find((x) => x.caminho === 'triagem.camposMemoria.0.chave')?.mensagem).toContain('minúscula, sem espaço');
  });

  it('10. mais de 200 FAQ, link sem URL válida e inboxIds que não é uuid', () => {
    const faq = Array.from({ length: MAX_FAQ + 1 }, (_, i) => ({ pergunta: `P${i}`, resposta: 'R' }));
    const e = erros({
      ...SPEC_MINIMO,
      conhecimento: { faq },
      regras: { linksUteis: [{ rotulo: 'Site', url: 'site.com' }] },
      inboxIds: ['abc'],
    });
    expect(e).toContainEqual({ caminho: 'conhecimento.faq', mensagem: 'conhecimento.faq: no máximo 200' });
    expect(e).toContainEqual({ caminho: 'regras.linksUteis.0.url', mensagem: 'url precisa ser um endereço completo (https://…)' });
    expect(e).toContainEqual({ caminho: 'inboxIds.0', mensagem: 'inboxIds precisa conter ids (uuid)' });
  });

  it('11. followup.maxTentativas acima de 3 e aposHoras zero', () => {
    const e = erros({ ...SPEC_MINIMO, followup: { ativo: true, aposHoras: 0, maxTentativas: 5 } });
    expect(e).toContainEqual({ caminho: 'followup.aposHoras', mensagem: 'aposHoras vai de 1 a 720' });
    expect(e).toContainEqual({ caminho: 'followup.maxTentativas', mensagem: 'maxTentativas vai de 1 a 3' });
  });

  it('12. objeto obrigatório ausente (negocio, agente) e campos sem mensagem própria: nunca "Required"', () => {
    const e = erros({
      versao: 1,
      servicos: [{ nome: 'X' }],
      agenda: { horarios: [{ dias: [1] }], profissionais: [{}] },
      triagem: { camposMemoria: [{ descricao: 'x' }] },
      regras: { linksUteis: [{ rotulo: 'Site' }] },
      followup: {},
    });
    expect(e).toContainEqual({ caminho: 'negocio', mensagem: 'negocio é obrigatório' });
    expect(e).toContainEqual({ caminho: 'agente', mensagem: 'agente é obrigatório' });
    expect(e).toContainEqual({ caminho: 'servicos.0.duracaoMinutos', mensagem: 'servicos.0.duracaoMinutos é obrigatório' });
    expect(e).toContainEqual({ caminho: 'agenda.ativo', mensagem: 'agenda.ativo é obrigatório' });
    expect(e).toContainEqual({ caminho: 'agenda.horarios.0.inicio', mensagem: 'agenda.horarios.0.inicio é obrigatório' });
    expect(e).toContainEqual({ caminho: 'agenda.profissionais.0.email', mensagem: 'agenda.profissionais.0.email é obrigatório' });
    expect(e).toContainEqual({ caminho: 'triagem.camposMemoria.0.chave', mensagem: 'triagem.camposMemoria.0.chave é obrigatório' });
    expect(e).toContainEqual({ caminho: 'regras.linksUteis.0.url', mensagem: 'regras.linksUteis.0.url é obrigatório' });
    expect(e).toContainEqual({ caminho: 'followup.ativo', mensagem: 'followup.ativo é obrigatório' });
    expect(e.map((x) => x.mensagem)).not.toContain('Required');
    expect(e.every((x) => !/required/i.test(x.mensagem))).toBe(true);
  });

  it('13. mensagem própria em português vence a rede de segurança (negocio.nome, versao)', () => {
    const e = erros({ negocio: { segmento: 'clinica', sobre: 'x' }, agente: { nome: 'A', tom: 'direto' } });
    expect(e).toContainEqual({ caminho: 'versao', mensagem: 'versao precisa ser 1 (única versão suportada)' });
    expect(e).toContainEqual({ caminho: 'negocio.nome', mensagem: 'negocio.nome é obrigatório' });
    expect(e.map((x) => x.mensagem)).not.toContain('Required');
  });
});
