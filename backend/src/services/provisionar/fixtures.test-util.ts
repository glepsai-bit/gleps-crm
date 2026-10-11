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
