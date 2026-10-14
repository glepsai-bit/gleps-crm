/**
 * PROVISIONAMENTO — o zod do spec v1.1: defaults, limites e mensagens em
 * português. Quem lê o erro é o operador montando o JSON em outra pasta; a
 * mensagem precisa dizer o campo e o que está errado, sem conhecer o código.
 *
 * v1 continua aceito: os campos novos (papel, vendas, unidade/agendavel,
 * tentativas/janela/mensagens, raciocinio) têm default.
 */

import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  specSchema,
  validarSpec,
  etapasDoSpec,
  servicosAgendaveis,
  horasDoIntervalo,
  MAX_SERVICOS,
  MAX_FAQ,
} from './spec';
import { SPEC_MINIMO, SPEC_CLINICA, SPEC_SDR } from './fixtures.test-util';

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
    expect(s.servicos[0].valorPadrao).toBe(250);
    expect(s.servicos[1].valorPadrao).toBeNull(); // sem valor = "sob consulta" (não vira 0 = gratuito)
    expect(validarSpec({ ...SPEC_MINIMO, servicos: [{ nome: 'X', valorPadrao: 0 }, { nome: 'Y', valorPadrao: null }] }).servicos.map((v) => v.valorPadrao)).toEqual([0, null]);
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

describe('spec v1.1 — campos novos com default (v1 continua aceito)', () => {
  it('v1 sem os campos novos: papel recepcao, sem raciocinio, serviço com duração é agendável, follow-up compat', () => {
    const s = validarSpec(SPEC_CLINICA);
    expect(s.versao).toBe(1);
    expect(s.agente.papel).toBe('recepcao');
    expect(s.agente.raciocinio).toBeUndefined();
    expect(s.vendas).toBeUndefined();
    expect(s.servicos.map((x) => [x.agendavel, x.unidade ?? null])).toEqual([
      [true, null],
      [true, null],
    ]);
    // aposHoras 24 + maxTentativas 2 → duas tentativas de 24h; janela padrão 08–20.
    expect(s.followup).toEqual({
      ativo: true,
      tentativas: ['24h', '24h'],
      janela: { inicio: '08:00', fim: '20:00' },
      mensagem: 'Oi {{nome}}, ficou alguma dúvida? Posso ajudar.',
      mensagens: [],
      aposHoras: 24,
      maxTentativas: 2,
    });
  });

  it('follow-up ausente: desligado, com os derivados coerentes', () => {
    const s = validarSpec(SPEC_MINIMO);
    expect(s.followup).toMatchObject({ ativo: false, tentativas: ['24h', '24h'], aposHoras: 24, maxTentativas: 2 });
  });

  it('o spec SDR (v1.1) passa: vendas, unidade, agendavel, tentativas normalizadas, janela, mensagens, raciocinio', () => {
    const s = validarSpec(SPEC_SDR);
    expect(s.versao).toBe(1.1);
    expect(s.agente).toMatchObject({ papel: 'sdr', model: 'gpt-5-mini', raciocinio: 'low' });
    expect(s.vendas).toMatchObject({ objetivo: 'agendar avaliacao', fechamento: 'Proponha o horário mais próximo e confirme.' });
    expect(s.vendas?.roteiro).toHaveLength(3);
    expect(s.vendas?.objecoes).toHaveLength(2);
    expect(s.servicos.map((x) => [x.nome, x.agendavel, x.unidade, x.duracaoMinutos ?? null])).toEqual([
      ['Avaliação', true, 'avaliacao', 30],
      ['Limpeza de pele', true, 'sessao', 60],
      ['Plano mensal', false, 'mes', null],
      ['Pacote 10 sessões', false, 'pacote', 60],
    ]);
    expect(servicosAgendaveis(s).map((x) => x.nome)).toEqual(['Avaliação', 'Limpeza de pele']);
    expect(s.followup).toMatchObject({
      tentativas: ['2h', '1d', '3d'],
      janela: { inicio: '09:00', fim: '19:00' },
      aposHoras: 2,
      maxTentativas: 3,
    });
    expect(s.followup.mensagens).toHaveLength(3);
  });

  it('versao aceita 1, 1.1 e "1.1" (normaliza para número); tentativas aceitam "2 H" e "1D"', () => {
    expect(validarSpec({ ...SPEC_MINIMO, versao: '1.1' }).versao).toBe(1.1);
    expect(validarSpec({ ...SPEC_MINIMO, versao: 1.1 }).versao).toBe(1.1);
    const s = validarSpec({ ...SPEC_MINIMO, followup: { ativo: true, tentativas: ['2 H', '1D'] } });
    expect(s.followup.tentativas).toEqual(['2h', '1d']);
    expect(s.followup.aposHoras).toBe(2);
    expect(s.followup.maxTentativas).toBe(2);
  });

  it('tentativas vence aposHoras/maxTentativas quando os dois vêm', () => {
    const s = validarSpec({ ...SPEC_MINIMO, followup: { ativo: true, tentativas: ['3d'], aposHoras: 1, maxTentativas: 3 } });
    expect(s.followup).toMatchObject({ tentativas: ['3d'], aposHoras: 72, maxTentativas: 1 });
  });

  it('papel sdr sem vendas é aceito (o prompt usa um roteiro padrão)', () => {
    const s = validarSpec({ ...SPEC_MINIMO, agente: { ...SPEC_MINIMO.agente, papel: 'sdr' } });
    expect(s.agente.papel).toBe('sdr');
    expect(s.vendas).toBeUndefined();
  });

  it('horasDoIntervalo', () => {
    expect(horasDoIntervalo('2h')).toBe(2);
    expect(horasDoIntervalo('1d')).toBe(24);
    expect(horasDoIntervalo(' 3D ')).toBe(72);
    expect(() => horasDoIntervalo('2x')).toThrow();
  });
});

describe('spec v1.1 — erros dos campos novos, em português e com caminho', () => {
  it('vendas com papel recepcao é recusado', () => {
    const e = erros({ ...SPEC_MINIMO, vendas: { roteiro: ['x'] } });
    expect(e).toContainEqual({ caminho: 'vendas', mensagem: 'vendas só é aceito com agente.papel = "sdr" (o padrão é "recepcao")' });
  });

  it('papel, raciocinio, unidade e vendas.objetivo fora da lista', () => {
    const e = erros({
      ...SPEC_SDR,
      agente: { ...SPEC_SDR.agente, papel: 'vendedor', raciocinio: 'alto' },
      vendas: { ...SPEC_SDR.vendas, objetivo: 'vender' },
      servicos: [{ nome: 'X', valorPadrao: 10, unidade: 'cada' }],
    });
    expect(e).toContainEqual({ caminho: 'agente.papel', mensagem: 'papel precisa ser um de: sdr, recepcao, suporte' });
    expect(e).toContainEqual({ caminho: 'agente.raciocinio', mensagem: 'raciocinio precisa ser um de: minimal, low, medium, high' });
    expect(e).toContainEqual({ caminho: 'servicos.0.unidade', mensagem: 'unidade precisa ser um de: sessao, mes, pacote, unidade, hora, avaliacao' });
    expect(e).toContainEqual({ caminho: 'vendas.objetivo', mensagem: 'vendas.objetivo precisa ser um de: agendar avaliacao, fechar, qualificar' });
  });

  it('serviço agendável sem duração; roteiro > 12; objeções > 20', () => {
    const e = erros({
      ...SPEC_SDR,
      servicos: [{ nome: 'Plano', valorPadrao: 100, agendavel: true }],
      vendas: {
        roteiro: Array.from({ length: 13 }, (_, i) => `passo ${i}`),
        objecoes: Array.from({ length: 21 }, (_, i) => ({ objecao: `o${i}`, resposta: 'r' })),
      },
    });
    expect(e).toContainEqual({
      caminho: 'servicos.0.duracaoMinutos',
      mensagem: 'serviço agendável precisa de duracaoMinutos (5 a 600) — ou marque agendavel: false',
    });
    expect(e).toContainEqual({ caminho: 'vendas.roteiro', mensagem: 'vendas.roteiro: no máximo 12 etapas' });
    expect(e).toContainEqual({ caminho: 'vendas.objecoes', mensagem: 'vendas.objecoes: no máximo 20' });
  });

  it('tentativas inválidas (formato, teto 30d, mais de 5) e janela com fim antes do início', () => {
    const e = erros({
      ...SPEC_MINIMO,
      followup: { ativo: true, tentativas: ['2x', '40d'], janela: { inicio: '19:00', fim: '09:00' } },
    });
    expect(e).toContainEqual({ caminho: 'followup.tentativas.0', mensagem: 'intervalo precisa ser como "2h", "1d" ou "3d"' });
    expect(e).toContainEqual({ caminho: 'followup.tentativas.1', mensagem: 'intervalo vai de 1h a 30d' });
    expect(e).toContainEqual({ caminho: 'followup.janela.fim', mensagem: 'janela.fim precisa vir depois de janela.inicio' });

    const demais = erros({ ...SPEC_MINIMO, followup: { ativo: true, tentativas: ['1h', '1h', '1h', '1h', '1h', '1h'] } });
    expect(demais).toContainEqual({ caminho: 'followup.tentativas', mensagem: 'followup.tentativas: no máximo 5' });
  });

  it('mais de 200 serviços', () => {
    const servicos = Array.from({ length: MAX_SERVICOS + 1 }, (_, i) => ({ nome: `S${i}`, duracaoMinutos: 30 }));
    const e = erros({ ...SPEC_MINIMO, servicos });
    expect(e[0]).toEqual({ caminho: 'servicos', mensagem: 'servicos: no máximo 200' });
  });
});

describe('spec v1 — erros clássicos, cada um com mensagem em português e caminho', () => {
  it('1. versao diferente de 1 / 1.1', () => {
    const e = erros({ ...SPEC_MINIMO, versao: 2 });
    expect(e[0]).toEqual({ caminho: 'versao', mensagem: 'versao precisa ser 1 ou 1.1' });
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

  it('7. horário com fim antes do início e HH:MM inválido', () => {
    const e = erros({
      ...SPEC_MINIMO,
      agenda: { ativo: true, horarios: [{ dias: [1], inicio: '18:00', fim: '08:00' }, { dias: [2], inicio: '9h', fim: '18:00' }] },
    });
    expect(e).toContainEqual({ caminho: 'agenda.horarios.0.fim', mensagem: 'fim precisa vir depois de inicio' });
    expect(e).toContainEqual({ caminho: 'agenda.horarios.1.inicio', mensagem: 'inicio precisa ser HH:MM' });
  });

  it('8. e-mail de profissional inválido e chave de memória com espaço', () => {
    const e = erros({
      ...SPEC_MINIMO,
      agenda: { ativo: true, profissionais: [{ email: 'nao-e-email' }] },
      triagem: { camposMemoria: [{ chave: 'Motivo do contato', descricao: 'x' }] },
    });
    expect(e).toContainEqual({ caminho: 'agenda.profissionais.0.email', mensagem: 'e-mail do profissional inválido' });
    expect(e.find((x) => x.caminho === 'triagem.camposMemoria.0.chave')?.mensagem).toContain('minúscula, sem espaço');
  });

  it('9. mais de 200 FAQ, link sem URL válida e inboxIds que não é uuid', () => {
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

  it('10. followup.maxTentativas acima de 5 e aposHoras zero (compat v1)', () => {
    const e = erros({ ...SPEC_MINIMO, followup: { ativo: true, aposHoras: 0, maxTentativas: 6 } });
    expect(e).toContainEqual({ caminho: 'followup.aposHoras', mensagem: 'aposHoras vai de 1 a 720' });
    expect(e).toContainEqual({ caminho: 'followup.maxTentativas', mensagem: 'maxTentativas vai de 1 a 5' });
  });

  it('11. objeto obrigatório ausente (negocio, agente) e campos sem mensagem própria: nunca "Required"', () => {
    const e = erros({
      versao: 1,
      servicos: [{ nome: 'X', agendavel: true }],
      agenda: { horarios: [{ dias: [1] }], profissionais: [{}] },
      triagem: { camposMemoria: [{ descricao: 'x' }] },
      regras: { linksUteis: [{ rotulo: 'Site' }] },
      followup: {},
    });
    expect(e).toContainEqual({ caminho: 'negocio', mensagem: 'negocio é obrigatório' });
    expect(e).toContainEqual({ caminho: 'agente', mensagem: 'agente é obrigatório' });
    expect(e.find((x) => x.caminho === 'servicos.0.duracaoMinutos')?.mensagem).toContain('serviço agendável precisa de duracaoMinutos');
    expect(e).toContainEqual({ caminho: 'agenda.ativo', mensagem: 'agenda.ativo é obrigatório' });
    expect(e).toContainEqual({ caminho: 'agenda.horarios.0.inicio', mensagem: 'agenda.horarios.0.inicio é obrigatório' });
    expect(e).toContainEqual({ caminho: 'agenda.profissionais.0.email', mensagem: 'agenda.profissionais.0.email é obrigatório' });
    expect(e).toContainEqual({ caminho: 'triagem.camposMemoria.0.chave', mensagem: 'triagem.camposMemoria.0.chave é obrigatório' });
    expect(e).toContainEqual({ caminho: 'regras.linksUteis.0.url', mensagem: 'regras.linksUteis.0.url é obrigatório' });
    expect(e).toContainEqual({ caminho: 'followup.ativo', mensagem: 'followup.ativo é obrigatório' });
    expect(e.map((x) => x.mensagem)).not.toContain('Required');
    expect(e.every((x) => !/required/i.test(x.mensagem))).toBe(true);
  });

  it('12. mensagem própria em português vence a rede de segurança (negocio.nome, versao)', () => {
    const e = erros({ negocio: { segmento: 'clinica', sobre: 'x' }, agente: { nome: 'A', tom: 'direto' } });
    expect(e).toContainEqual({ caminho: 'versao', mensagem: 'versao precisa ser 1 ou 1.1' });
    expect(e).toContainEqual({ caminho: 'negocio.nome', mensagem: 'negocio.nome é obrigatório' });
    expect(e.map((x) => x.mensagem)).not.toContain('Required');
  });
});
