/**
 * PROVISIONAMENTO — o prompt por seções: cada campo do spec aparece onde
 * deve, seção sem conteúdo não entra, e o teto de tamanho é respeitado.
 *
 * ETAPA G: identidade sem "atendente virtual", apresentação como inspiração,
 * proibido "vou confirmar com a equipe" sem transferir, orientação ao
 * transferir, CATÁLOGO com unidade e COMO VENDER para papel sdr.
 */

import { describe, it, expect } from 'vitest';
import { montarPrompt, schemaDeSaida, linhaDoCatalogo, LIMITE_PROMPT_CHARS, PromptLongoDemaisError } from './prompt';
import { validarSpec } from './spec';
import { SPEC_MINIMO, SPEC_CLINICA, SPEC_SDR } from './fixtures.test-util';

const secoesDe = (prompt: string) =>
  prompt.split('\n\n---\n\n').map((bloco) => bloco.split('\n')[0]);

describe('montarPrompt — spec completo (clínica, papel recepcao)', () => {
  const prompt = montarPrompt(validarSpec(SPEC_CLINICA));

  it('tem as seções na ordem fixa (sem COMO VENDER: papel recepcao)', () => {
    expect(secoesDe(prompt)).toEqual([
      'IDENTIDADE',
      'SOBRE O NEGÓCIO',
      'CATÁLOGO',
      'COMO ATENDER',
      'AGENDA',
      'REGRAS',
      'TRANSFERÊNCIA',
      'ESTILO',
      'FOLLOW-UP',
      'FORMATO DA RESPOSTA',
    ]);
  });

  it('IDENTIDADE: nome, papel, negócio e tom — sem "atendente virtual"; apresentação é inspiração; só confirma IA se perguntarem', () => {
    expect(prompt).toContain('Você é Bia, da recepção e do atendimento de Clínica Vida Plena (clínica de saúde), no WhatsApp.');
    expect(prompt).toContain('Seu tom é acolhedor');
    expect(prompt).not.toContain('atendente virtual');
    expect(prompt).toContain('usando como base (inspiração, não frase pronta para repetir): "Oi! Eu sou a Bia, da Clínica Vida Plena."');
    expect(prompt).not.toContain('apresente-se assim:');
    expect(prompt).toContain('Não se declare "virtual", "assistente de IA" ou "robô" por conta própria.');
    expect(prompt).toContain('Se perguntarem se é uma pessoa ou uma IA, confirme com naturalidade');
    expect(prompt).toContain('Nunca diga que é humano.');
  });

  it('SOBRE O NEGÓCIO: sobre, endereço, contato e diferenciais', () => {
    expect(prompt).toContain('Clínica médica com foco em atenção primária');
    expect(prompt).toContain('Endereço: Rua das Flores, 120');
    expect(prompt).toContain('Contato: (19) 3333-0000');
    expect(prompt).toContain('- Sem fila: hora marcada');
  });

  it('CATÁLOGO: "Nome — R$ X (duração Y min) — descrição"; sem valor → "valor sob consulta"; regra de não inventar unidade', () => {
    expect(prompt).toContain('- Consulta clínica — R$ 250,00 (duração 30 min) — Consulta com clínico geral');
    expect(prompt).toContain('- Avaliação — valor sob consulta (duração 20 min)');
    expect(prompt).toContain('Para item SEM unidade, diga só o valor — nunca acrescente "cada", "por sessão" ou "por mês" por conta própria.');
    expect(prompt).toContain('"Valor sob consulta": não invente nem estime.');
    expect(prompt).not.toContain('Só os itens com duração se marcam'); // todos agendáveis
  });

  it('COMO ATENDER: triagem, lembrar, base — e PROIBIDO "vou confirmar com a equipe" sem transferir', () => {
    expect(prompt).toContain('- Qual seu nome?');
    expect(prompt).toContain('ferramenta `lembrar`');
    expect(prompt).toContain('- motivo: motivo do contato');
    expect(prompt).toContain('consulte a base de conhecimento antes de responder.');
    expect(prompt).toContain('É PROIBIDO dizer "vou confirmar com a equipe", "vou verificar e te retorno" ou qualquer promessa de retorno sem transferir');
    expect(prompt).toContain('transfira (rota "humano") explicando o motivo ao lead');
    expect(prompt).not.toContain('Diga que vai confirmar com a equipe');
  });

  it('AGENDA: o roteiro pelas ferramentas, a reserva guardada na conversa e a proibição de inventar horário', () => {
    expect(prompt).toContain('Nunca invente, calcule ou prometa horário');
    expect(prompt).toContain('`consultar_horarios`');
    expect(prompt).toContain('só depois do sim explícito, `agendar`');
    expect(prompt).toContain('A reserva fica guardada na conversa');
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

  it('TRANSFERÊNCIA: 1–2 frases de orientação enviadas antes; a mensagem fixa só se o agente não escrever; urgência → emergência', () => {
    expect(prompt).toContain('escreva em mensagem_de_resposta 1 ou 2 frases de orientação');
    expect(prompt).toContain('oriente a procurar atendimento de emergência ou pronto-socorro agora');
    expect(prompt).toContain('Esse texto é enviado à pessoa antes da transferência. Se você não escrever nada, o sistema manda: "Vou chamar alguém da equipe para te ajudar, um instante."');
    expect(prompt).not.toContain('não escreva despedida');
  });

  it('FOLLOW-UP (compat v1) carrega {{objetivo_do_passo}} e a mensagem única de referência', () => {
    expect(prompt).toContain('{{objetivo_do_passo}}');
    expect(prompt).toContain('Mensagem de referência do follow-up');
    expect(prompt).toContain('"Oi {{nome}}, ficou alguma dúvida? Posso ajudar."');
  });

  it('ESTILO e FORMATO: sem emoji, uma pergunta por vez, JSON com rota; com rota humano a mensagem é a orientação', () => {
    expect(prompt).toContain('sem emoji');
    expect(prompt).toContain('Uma pergunta por vez');
    expect(prompt).toContain('rota: "respondeu"');
    expect(prompt).toContain('Com rota "humano", são as 1–2 frases de orientação enviadas antes da transferência.');
  });
});

describe('montarPrompt — papel sdr (v1.1): COMO VENDER e CATÁLOGO com unidade', () => {
  const prompt = montarPrompt(validarSpec(SPEC_SDR));

  it('COMO VENDER entra entre COMO ATENDER e AGENDA', () => {
    expect(secoesDe(prompt)).toEqual([
      'IDENTIDADE',
      'SOBRE O NEGÓCIO',
      'CATÁLOGO',
      'COMO ATENDER',
      'COMO VENDER',
      'AGENDA',
      'TRANSFERÊNCIA',
      'ESTILO',
      'FOLLOW-UP',
      'FORMATO DA RESPOSTA',
    ]);
  });

  it('IDENTIDADE diz o papel de pré-venda', () => {
    expect(prompt).toContain('Você é Sofia, responsável pela pré-venda — entender o interesse e levar ao próximo passo de Studio Luz');
  });

  it('COMO VENDER: objetivo, roteiro numerado, gatilhos, objeções em tabela e fechamento', () => {
    expect(prompt).toContain('Objetivo da conversa: levar a pessoa a marcar uma avaliação — o agendamento é a conversão.');
    expect(prompt).toContain('1. Descobrir o que incomoda a pessoa\n2. Mostrar o tratamento certo para isso\n3. Oferecer a avaliação gratuita');
    expect(prompt).toContain('Quando oferecer (gatilhos');
    expect(prompt).toContain('- Perguntou preço');
    expect(prompt).toContain('| Objeção | Como responder |');
    expect(prompt).toContain('| Está caro | A avaliação é gratuita e o plano cabe em 10x. |');
    expect(prompt).toContain('Fechamento: Proponha o horário mais próximo e confirme.');
    expect(prompt).toContain('Nunca pressione');
  });

  it('CATÁLOGO: unidade por item, item sem duração, item sem valor', () => {
    expect(prompt).toContain('- Avaliação — valor sob consulta (duração 30 min)');
    expect(prompt).toContain('- Limpeza de pele — R$ 180,00 por sessão (duração 60 min)');
    expect(prompt).toContain('- Plano mensal — R$ 390,00 por mês — 4 sessões por mês');
    expect(prompt).toContain('- Pacote 10 sessões — R$ 1.500,00 por pacote (duração 60 min)');
    expect(prompt).toContain('Só os itens com duração se marcam pelas ferramentas de agenda');
  });

  it('FOLLOW-UP: uma mensagem de referência por toque', () => {
    expect(prompt).toContain('- Toque 1: "Oi {{nome}}, ficou alguma dúvida sobre a avaliação?"');
    expect(prompt).toContain('- Toque 3: "Se preferir, retomo em outro momento — me avisa."');
    expect(prompt).not.toContain('Mensagem de referência do follow-up (adapte');
  });

  it('papel sdr sem bloco vendas: COMO VENDER com o roteiro padrão', () => {
    const p = montarPrompt(validarSpec({ ...SPEC_MINIMO, agente: { ...SPEC_MINIMO.agente, papel: 'sdr' } }));
    expect(secoesDe(p)).toContain('COMO VENDER');
    expect(p).toContain('1. Entenda o que a pessoa procura e por quê');
    expect(p).not.toContain('| Objeção |');
  });

  it('papel suporte: identidade de suporte, sem COMO VENDER', () => {
    const p = montarPrompt(validarSpec({ ...SPEC_MINIMO, agente: { ...SPEC_MINIMO.agente, papel: 'suporte' } }));
    expect(p).toContain('Você é Léo, do suporte a quem já é cliente de Oficina do Zé');
    expect(secoesDe(p)).not.toContain('COMO VENDER');
  });
});

describe('linhaDoCatalogo', () => {
  it('as quatro formas', () => {
    const s = validarSpec({
      ...SPEC_MINIMO,
      servicos: [
        { nome: 'A', valorPadrao: 50, unidade: 'hora', duracaoMinutos: 60 },
        { nome: 'B', valorPadrao: 50 },
        { nome: 'C', duracaoMinutos: 15 },
        { nome: 'D', valorPadrao: 0, unidade: 'mes', agendavel: false, descricao: ' d ' },
        { nome: 'E', valorPadrao: null, agendavel: false },
      ],
    }).servicos;
    expect(s.map(linhaDoCatalogo)).toEqual([
      'A — R$ 50,00 por hora (duração 60 min)',
      'B — R$ 50,00',
      'C — valor sob consulta (duração 15 min)',
      // 0 é gratuito; ausente ou null é "valor sob consulta" — não se confundem.
      'D — gratuito — d',
      'E — valor sob consulta',
    ]);
  });

  it('a regra "valor sob consulta" só entra no prompt quando algum item está sem valor (0 é gratuito, não falta de valor)', () => {
    const comGratuito = montarPrompt(validarSpec({ ...SPEC_MINIMO, servicos: [{ nome: 'Avaliação', valorPadrao: 0, duracaoMinutos: 30 }, { nome: 'Consulta', valorPadrao: 200, duracaoMinutos: 30 }] }));
    expect(comGratuito).toContain('Avaliação — gratuito (duração 30 min)');
    expect(comGratuito).not.toContain('Valor sob consulta');
    const semValor = montarPrompt(validarSpec({ ...SPEC_MINIMO, servicos: [{ nome: 'Avaliação', duracaoMinutos: 30 }] }));
    expect(semValor).toContain('Avaliação — valor sob consulta (duração 30 min)');
    expect(semValor).toContain('"Valor sob consulta": não invente nem estime');
  });
});

describe('montarPrompt — spec mínimo', () => {
  const prompt = montarPrompt(validarSpec(SPEC_MINIMO));

  it('seções sem conteúdo não entram (catálogo, vender, agenda, regras, follow-up)', () => {
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

  it('o spec da clínica e o SDR ficam bem abaixo do teto', () => {
    expect(montarPrompt(validarSpec(SPEC_CLINICA)).length).toBeLessThan(9000);
    expect(montarPrompt(validarSpec(SPEC_SDR)).length).toBeLessThan(9000);
  });
});

describe('schemaDeSaida', () => {
  it('rota fechada em respondeu|humano, resumo opcional, mensagem com rota humano = orientação', () => {
    const s = schemaDeSaida();
    expect((s.properties.rota as { enum: string[] }).enum).toEqual(['respondeu', 'humano']);
    expect(s.required).toEqual(['mensagem_de_resposta', 'rota']);
    expect(s.properties).toHaveProperty('resumo');
    expect(s.properties.mensagem_de_resposta.description).toContain('1–2 frases de orientação');
  });
});
