/**
 * PROVISIONAMENTO — o prompt por seções: cada campo do spec aparece onde
 * deve, seção sem conteúdo não entra, e o teto de tamanho é respeitado.
 */

import { describe, it, expect } from 'vitest';
import { montarPrompt, schemaDeSaida, LIMITE_PROMPT_CHARS, PromptLongoDemaisError } from './prompt';
import { validarSpec } from './spec';
import { SPEC_MINIMO, SPEC_CLINICA } from './fixtures.test-util';

const secoesDe = (prompt: string) =>
  prompt.split('\n\n---\n\n').map((bloco) => bloco.split('\n')[0]);

describe('montarPrompt — spec completo', () => {
  const prompt = montarPrompt(validarSpec(SPEC_CLINICA));

  it('tem as seções na ordem fixa', () => {
    expect(secoesDe(prompt)).toEqual([
      'IDENTIDADE',
      'SOBRE O NEGÓCIO',
      'SERVIÇOS',
      'COMO ATENDER',
      'AGENDA',
      'REGRAS',
      'TRANSFERÊNCIA',
      'ESTILO',
      'FOLLOW-UP',
      'FORMATO DA RESPOSTA',
    ]);
  });

  it('IDENTIDADE: nome, negócio, tom e apresentação', () => {
    expect(prompt).toContain('Você é Bia, atendente virtual de Clínica Vida Plena (clínica de saúde)');
    expect(prompt).toContain('Seu tom é acolhedor');
    expect(prompt).toContain('"Oi! Eu sou a Bia, da Clínica Vida Plena."');
  });

  it('SOBRE O NEGÓCIO: sobre, endereço, contato e diferenciais', () => {
    expect(prompt).toContain('Clínica médica com foco em atenção primária');
    expect(prompt).toContain('Endereço: Rua das Flores, 120');
    expect(prompt).toContain('Contato: (19) 3333-0000');
    expect(prompt).toContain('- Sem fila: hora marcada');
  });

  it('SERVIÇOS: duração, preço quando há, e a regra de não inventar valor quando falta', () => {
    expect(prompt).toContain('- Consulta clínica (30 min, R$ 250,00) — Consulta com clínico geral');
    expect(prompt).toContain('- Avaliação (20 min)');
    expect(prompt).toContain('Serviço sem preço aqui: não invente valor');
  });

  it('COMO ATENDER: perguntas de triagem e campos de memória com a ferramenta lembrar', () => {
    expect(prompt).toContain('- Qual seu nome?');
    expect(prompt).toContain('ferramenta `lembrar`');
    expect(prompt).toContain('- motivo: motivo do contato');
  });

  it('AGENDA: o roteiro pelas ferramentas e a proibição de inventar horário', () => {
    expect(prompt).toContain('Nunca invente, calcule ou prometa horário');
    expect(prompt).toContain('`consultar_horarios`');
    expect(prompt).toContain('só depois do sim explícito, `agendar`');
    expect(prompt).toContain('menos de 2h de antecedência');
  });

  it('REGRAS: nunca responder, sempre transferir, limites e links', () => {
    expect(prompt).toContain('NUNCA responda sobre');
    expect(prompt).toContain('- diagnóstico');
    expect(prompt).toContain('SEMPRE transfira para um humano (rota "humano")');
    expect(prompt).toContain('- urgência');
    expect(prompt).toContain('- não prometer resultados');
    expect(prompt).toContain('- Instagram: https://instagram.com/vidaplena');
  });

  it('TRANSFERÊNCIA cita a mensagem que o sistema manda; FOLLOW-UP carrega {{objetivo_do_passo}}', () => {
    expect(prompt).toContain('"Vou chamar alguém da equipe para te ajudar, um instante."');
    expect(prompt).toContain('{{objetivo_do_passo}}');
    expect(prompt).toContain('"Oi {{nome}}, ficou alguma dúvida? Posso ajudar."');
  });

  it('ESTILO e FORMATO: sem emoji, uma pergunta por vez, JSON com rota', () => {
    expect(prompt).toContain('sem emoji');
    expect(prompt).toContain('Uma pergunta por vez');
    expect(prompt).toContain('rota: "respondeu"');
  });
});

describe('montarPrompt — spec mínimo', () => {
  const prompt = montarPrompt(validarSpec(SPEC_MINIMO));

  it('seções sem conteúdo não entram (serviços, agenda, regras, follow-up)', () => {
    expect(secoesDe(prompt)).toEqual([
      'IDENTIDADE',
      'SOBRE O NEGÓCIO',
      'COMO ATENDER',
      'TRANSFERÊNCIA',
      'ESTILO',
      'FORMATO DA RESPOSTA',
    ]);
  });

  it('sem apresentação, manda apresentar-se pelo nome', () => {
    expect(prompt).toContain('Apresente-se pelo nome na primeira mensagem');
    expect(prompt).not.toContain('{{objetivo_do_passo}}');
  });
});

describe('limite de tamanho', () => {
  it(`acima de ${LIMITE_PROMPT_CHARS} caracteres recusa com a dica do que encurtar`, () => {
    const spec = validarSpec({
      ...SPEC_MINIMO,
      regras: { limites: Array.from({ length: 30 }, () => 'x'.repeat(300)) },
      servicos: Array.from({ length: 50 }, (_, i) => ({ nome: `Serviço ${i}`, duracaoMinutos: 30, descricao: 'y'.repeat(600) })),
    });
    expect(() => montarPrompt(spec)).toThrow(PromptLongoDemaisError);
    expect(() => montarPrompt(spec)).toThrow(/o limite é 30\.000/);
  });

  it('o spec da clínica fica bem abaixo do teto', () => {
    expect(montarPrompt(validarSpec(SPEC_CLINICA)).length).toBeLessThan(8000);
  });
});

describe('schemaDeSaida', () => {
  it('rota fechada em respondeu|humano, resumo opcional', () => {
    const s = schemaDeSaida();
    expect((s.properties.rota as { enum: string[] }).enum).toEqual(['respondeu', 'humano']);
    expect(s.required).toEqual(['mensagem_de_resposta', 'rota']);
    expect(s.properties).toHaveProperty('resumo');
  });
});
