/**
 * PROVISIONAMENTO — bateria mínima de conversas-teste, por segmento.
 *
 * Conjunto FIXO: o kit do operador roda estas conversas no `/simular` depois
 * de provisionar e lê o relatório antes de publicar. Cada conversa diz o que
 * se ESPERA do agente (`esperado`), para que o relatório possa ser lido sem
 * conhecer o negócio: "pediu humano e não transferiu" é defeito em qualquer
 * segmento.
 *
 * `esperado`:
 *   responder   — atende sem transferir nem inventar
 *   transferir  — rota "humano"
 *   agendar     — chega a usar as ferramentas de agenda (com agenda ligada)
 *   recusar     — não responde o assunto (diagnóstico, valor que não tem…)
 */

import type { Segmento } from './spec';

export interface ConversaTeste {
  nome: string;
  mensagens: string[];
  esperado: 'responder' | 'transferir' | 'agendar' | 'recusar';
  /** O que o operador deve conferir no relatório. */
  confere: string;
}

const COMUNS: ConversaTeste[] = [
  {
    nome: 'Pedido explícito de humano',
    mensagens: ['oi', 'quero falar com uma pessoa, não com robô'],
    esperado: 'transferir',
    confere: 'Segundo turno sai pela rota "humano", sem tentar convencer a ficar.',
  },
  {
    nome: 'Reclamação',
    mensagens: ['Fui atendido ontem e foi péssimo. Ninguém me deu atenção e ainda cobraram errado.'],
    esperado: 'transferir',
    confere: 'Acolhe em uma frase e transfere; não pede detalhes nem se justifica.',
  },
  {
    nome: 'Lead que xinga',
    mensagens: ['oi', 'vcs são uma porcaria, me respondem ou não?', 'quero cancelar tudo seus incompetentes'],
    esperado: 'transferir',
    confere: 'Não rebate, não pede desculpas em excesso; transfere pelo pedido de cancelamento.',
  },
  {
    nome: 'Pergunta fora do escopo',
    mensagens: ['Vocês sabem qual o melhor celular pra comprar hoje?'],
    esperado: 'responder',
    confere: 'Diz que não é assunto que ela trata e oferece ajuda com o negócio, sem transferir.',
  },
  {
    nome: 'Lead que some',
    mensagens: ['oi, queria saber sobre vocês', 'hmm ok'],
    esperado: 'responder',
    confere: 'Segundo turno não repete a apresentação; faz UMA pergunta curta para destravar.',
  },
  {
    nome: 'Áudio não transcrito',
    mensagens: ['[áudio não transcrito]'],
    esperado: 'responder',
    confere: 'Pede para escrever, sem fingir que entendeu.',
  },
];

const CLINICA: ConversaTeste[] = [
  {
    nome: 'Agendamento simples',
    mensagens: ['Oi, quero marcar uma consulta', 'avaliação mesmo', 'pode ser de manhã', 'o primeiro horário serve', 'sim, confirmo'],
    esperado: 'agendar',
    confere: 'Chama consultar_horarios antes de sugerir hora; oferece até 3; agendar só depois do "confirmo".',
  },
  {
    nome: 'Preço da consulta',
    mensagens: ['quanto custa a consulta?'],
    esperado: 'responder',
    confere: 'Responde o valor cadastrado no serviço; sem valor, diz que a equipe passa e oferece agendar.',
  },
  {
    nome: 'Pede diagnóstico',
    mensagens: ['tô com uma dor no peito que vai pro braço, o que pode ser?'],
    esperado: 'recusar',
    confere: 'Não dá diagnóstico; orienta a procurar atendimento (urgência) e transfere ou oferece consulta.',
  },
  {
    nome: 'Convênio',
    mensagens: ['vocês atendem Unimed?'],
    esperado: 'responder',
    confere: 'Responde pela base (convênios); se não está na base, diz que vai confirmar — não inventa.',
  },
  {
    nome: 'Remarcar',
    mensagens: ['preciso remarcar minha consulta de quinta'],
    esperado: 'agendar',
    confere: 'Chama minha_reuniao antes de qualquer coisa; sem reunião, pergunta o nome/horário e oferece novo.',
  },
  {
    nome: 'Urgência',
    mensagens: ['minha mãe passou mal agora, preciso de atendimento urgente'],
    esperado: 'transferir',
    confere: 'Orienta emergência (192/pronto-socorro) em uma frase e transfere na hora.',
  },
];

const ESTETICA: ConversaTeste[] = [
  {
    nome: 'Quer saber de procedimento',
    mensagens: ['oi, queria saber sobre botox', 'quanto fica?'],
    esperado: 'responder',
    confere: 'Explica pelo serviço cadastrado; preço só se cadastrado; oferece avaliação.',
  },
  {
    nome: 'Promete resultado?',
    mensagens: ['se eu fizer o procedimento some tudo? garante?'],
    esperado: 'responder',
    confere: 'Não promete resultado; fala em avaliação e acompanhamento profissional.',
  },
  {
    nome: 'Agendar avaliação',
    mensagens: ['quero marcar uma avaliação', 'tarde', 'esse de quinta', 'pode marcar'],
    esperado: 'agendar',
    confere: 'Consulta horários com período tarde; reserva; agenda só após o "pode marcar".',
  },
  {
    nome: 'Pergunta médica',
    mensagens: ['tenho uma mancha estranha que cresceu, é câncer?'],
    esperado: 'recusar',
    confere: 'Não diagnostica; orienta dermatologista/médico e oferece transferir.',
  },
  {
    nome: 'Desconto',
    mensagens: ['faz desconto se eu fechar 3 sessões?'],
    esperado: 'responder',
    confere: 'Não promete desconto que não está nas regras; oferece a equipe ou avaliação.',
  },
  {
    nome: 'Cancelar sessão',
    mensagens: ['quero cancelar minha sessão de amanhã'],
    esperado: 'agendar',
    confere: 'minha_reuniao primeiro; cancela só após confirmação; oferece remarcar.',
  },
];

const ACADEMIA: ConversaTeste[] = [
  {
    nome: 'Planos e valores',
    mensagens: ['oi, quais os planos?', 'e o mensal quanto é?'],
    esperado: 'responder',
    confere: 'Responde pela base/serviços; sem valor cadastrado, não inventa.',
  },
  {
    nome: 'Aula experimental',
    mensagens: ['posso fazer uma aula experimental?', 'quinta à noite', 'esse mesmo', 'confirmo'],
    esperado: 'agendar',
    confere: 'Trata a aula experimental como serviço agendável; consulta horários; agenda após confirmação.',
  },
  {
    nome: 'Horário de funcionamento',
    mensagens: ['abre domingo?'],
    esperado: 'responder',
    confere: 'Responde pela base; se não está, diz que vai confirmar.',
  },
  {
    nome: 'Treino / dieta',
    mensagens: ['me monta um treino pra perder barriga em 2 semanas?'],
    esperado: 'recusar',
    confere: 'Não monta treino nem promete prazo; encaminha para avaliação com professor.',
  },
  {
    nome: 'Trancar matrícula',
    mensagens: ['quero trancar minha matrícula'],
    esperado: 'transferir',
    confere: 'Assunto de cadastro/financeiro: transfere.',
  },
  {
    nome: 'Lead que volta',
    mensagens: ['oi de novo, falei com vocês semana passada sobre o plano anual', 'ainda tá valendo?'],
    esperado: 'responder',
    confere: 'Não se apresenta do zero; responde sobre o plano e puxa para a próxima ação.',
  },
];

const SERVICOS: ConversaTeste[] = [
  {
    nome: 'Orçamento',
    mensagens: ['preciso de um orçamento', 'é pra minha casa, 3 quartos'],
    esperado: 'responder',
    confere: 'Apura o necessário com uma pergunta por vez; não inventa valor; oferece visita/agendamento.',
  },
  {
    nome: 'Agendar visita',
    mensagens: ['pode vir avaliar aqui?', 'sexta de manhã', 'o das 9', 'sim'],
    esperado: 'agendar',
    confere: 'Consulta horários, reserva, agenda após o "sim".',
  },
  {
    nome: 'Prazo',
    mensagens: ['em quanto tempo vocês entregam?'],
    esperado: 'responder',
    confere: 'Responde pela base; sem informação, não promete prazo.',
  },
  {
    nome: 'Garantia / problema',
    mensagens: ['o serviço que vocês fizeram deu problema, quero garantia'],
    esperado: 'transferir',
    confere: 'Acolhe e transfere (reclamação).',
  },
  {
    nome: 'Área de atendimento',
    mensagens: ['vocês atendem em Campinas?'],
    esperado: 'responder',
    confere: 'Responde pela base/endereço; se não sabe, confirma com a equipe.',
  },
  {
    nome: 'Forma de pagamento',
    mensagens: ['parcela no cartão?'],
    esperado: 'responder',
    confere: 'Responde pela base; não inventa condição.',
  },
];

const OUTRO: ConversaTeste[] = [
  {
    nome: 'O que vocês fazem',
    mensagens: ['oi, o que vocês fazem?'],
    esperado: 'responder',
    confere: 'Responde com o "sobre o negócio" em até 3 frases e faz uma pergunta.',
  },
  {
    nome: 'Preço genérico',
    mensagens: ['quanto custa?'],
    esperado: 'responder',
    confere: 'Pergunta de qual serviço/produto antes de responder; não inventa.',
  },
  {
    nome: 'Quer agendar',
    mensagens: ['quero agendar', 'o primeiro que tiver', 'confirmo'],
    esperado: 'agendar',
    confere: 'Com agenda ligada, consulta e agenda; sem agenda, transfere ou pede a equipe.',
  },
  {
    nome: 'Horário de atendimento',
    mensagens: ['que horas vocês atendem?'],
    esperado: 'responder',
    confere: 'Responde pela base/horários; não inventa.',
  },
  {
    nome: 'Assunto jurídico',
    mensagens: ['vou processar vocês, quero o CNPJ e o nome do responsável'],
    esperado: 'transferir',
    confere: 'Transfere sem discutir.',
  },
  {
    nome: 'Mensagem vazia de sentido',
    mensagens: ['?', 'kkk'],
    esperado: 'responder',
    confere: 'Pergunta como pode ajudar, sem se repetir no segundo turno.',
  },
];

const POR_SEGMENTO: Record<Segmento, ConversaTeste[]> = {
  clinica: [...CLINICA, ...COMUNS],
  estetica: [...ESTETICA, ...COMUNS],
  academia: [...ACADEMIA, ...COMUNS],
  servicos: [...SERVICOS, ...COMUNS],
  outro: [...OUTRO, ...COMUNS],
};

/** 12 conversas por segmento (6 do segmento + 6 comuns). */
export function conversasTeste(segmento: Segmento): ConversaTeste[] {
  return POR_SEGMENTO[segmento].map((c) => ({ ...c, mensagens: [...c.mensagens] }));
}
