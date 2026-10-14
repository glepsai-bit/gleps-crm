/**
 * Specs de exemplo compartilhados pelos testes do provisionamento. O sufixo
 * `.test-util` deixa o arquivo fora do glob `*.test.ts` do vitest.
 */

import type { SpecV1Entrada } from './spec';

export const SPEC_MINIMO: SpecV1Entrada = {
  versao: 1,
  negocio: { nome: 'Oficina do Zé', segmento: 'servicos', sobre: 'Oficina mecânica de bairro, 20 anos de estrada.' },
  agente: { nome: 'Léo', tom: 'direto' },
};

export const SPEC_CLINICA: SpecV1Entrada = {
  versao: 1,
  negocio: {
    nome: 'Clínica Vida Plena',
    segmento: 'clinica',
    sobre: 'Clínica médica com foco em atenção primária e check-up. Atendemos adultos e idosos desde 2012.',
    endereco: 'Rua das Flores, 120 — Campinas/SP',
    contato: '(19) 3333-0000',
    diferenciais: ['Sem fila: hora marcada', 'Estacionamento próprio'],
  },
  agente: { nome: 'Bia', tom: 'acolhedor', apresentacao: 'Oi! Eu sou a Bia, da Clínica Vida Plena.', temperatura: 0.4 },
  servicos: [
    { nome: 'Consulta clínica', duracaoMinutos: 30, valorPadrao: 250, descricao: 'Consulta com clínico geral' },
    { nome: 'Avaliação', duracaoMinutos: 20 },
  ],
  agenda: {
    ativo: true,
    fuso: 'America/Sao_Paulo',
    horarios: [
      { dias: [1, 2, 3, 4, 5], inicio: '08:00', fim: '12:00' },
      { dias: [1, 2, 3, 4, 5], inicio: '13:00', fim: '18:00' },
    ],
    profissionais: [{ email: 'carlos@clinicavidaplena.com' }],
    antecedenciaMinimaHoras: 2,
  },
  triagem: {
    perguntas: ['Qual seu nome?', 'Já é paciente da clínica?'],
    camposMemoria: [
      { chave: 'motivo', descricao: 'motivo do contato' },
      { chave: 'ja_paciente', descricao: 'se já é paciente (sim/não)' },
    ],
  },
  regras: {
    nuncaResponder: ['diagnóstico', 'valores de procedimentos médicos não listados'],
    sempreTransferir: ['reclamação', 'pedido explícito de humano', 'urgência'],
    limites: ['não prometer resultados'],
    linksUteis: [{ rotulo: 'Instagram', url: 'https://instagram.com/vidaplena' }],
  },
  funil: { etapaAoAtender: 'Em atendimento', etapaAoAgendar: 'Agendado', etapaAoTransferir: 'Com humano' },
  transferencia: { mensagemAoCliente: 'Vou chamar alguém da equipe para te ajudar, um instante.' },
  followup: { ativo: true, aposHoras: 24, mensagem: 'Oi {{nome}}, ficou alguma dúvida? Posso ajudar.', maxTentativas: 2 },
  conhecimento: {
    textos: [{ titulo: 'Convênios', conteudo: 'Aceitamos Unimed, Bradesco Saúde e SulAmérica. Particular com desconto no pix.' }],
    faq: [
      { pergunta: 'Atendem sábado?', resposta: 'Não, de segunda a sexta.' },
      { pergunta: 'Tem estacionamento?', resposta: 'Sim, gratuito para pacientes.' },
    ],
  },
};

/**
 * v1.1 — agente de pré-venda (papel sdr) com bloco de vendas, catálogo com
 * unidade e item não agendável, follow-up por intervalos e raciocínio.
 */
export const SPEC_SDR: SpecV1Entrada = {
  versao: 1.1,
  negocio: { nome: 'Studio Luz', segmento: 'estetica', sobre: 'Estúdio de estética facial e corporal. Avaliação gratuita antes de qualquer procedimento.' },
  agente: {
    nome: 'Sofia',
    tom: 'descontraido',
    papel: 'sdr',
    apresentacao: 'Oi! Aqui é a Sofia, do Studio Luz.',
    model: 'gpt-5-mini',
    raciocinio: 'low',
  },
  vendas: {
    objetivo: 'agendar avaliacao',
    roteiro: ['Descobrir o que incomoda a pessoa', 'Mostrar o tratamento certo para isso', 'Oferecer a avaliação gratuita'],
    objecoes: [
      { objecao: 'Está caro', resposta: 'A avaliação é gratuita e o plano cabe em 10x.' },
      { objecao: 'Vou pensar', resposta: 'Sem pressa; a agenda da semana tem poucas vagas, posso reservar uma?' },
    ],
    gatilhos: ['Perguntou preço', 'Falou de evento próximo'],
    fechamento: 'Proponha o horário mais próximo e confirme.',
  },
  servicos: [
    { nome: 'Avaliação', duracaoMinutos: 30, unidade: 'avaliacao' },
    { nome: 'Limpeza de pele', duracaoMinutos: 60, valorPadrao: 180, unidade: 'sessao' },
    { nome: 'Plano mensal', valorPadrao: 390, unidade: 'mes', agendavel: false, descricao: '4 sessões por mês' },
    { nome: 'Pacote 10 sessões', valorPadrao: 1500, unidade: 'pacote', duracaoMinutos: 60, agendavel: false },
  ],
  agenda: {
    ativo: true,
    horarios: [{ dias: [2, 3, 4, 5, 6], inicio: '10:00', fim: '19:00' }],
    profissionais: [{ email: 'marina@studioluz.com' }],
  },
  followup: {
    ativo: true,
    tentativas: ['2h', '1d', '3d'],
    janela: { inicio: '09:00', fim: '19:00' },
    mensagens: [
      'Oi {{nome}}, ficou alguma dúvida sobre a avaliação?',
      'Passando pra lembrar que a avaliação é gratuita.',
      'Se preferir, retomo em outro momento — me avisa.',
    ],
  },
};
