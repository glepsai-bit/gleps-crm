/**
 * PROVISIONAMENTO — o systemPrompt montado por SEÇÕES a partir do spec.
 *
 * Seções fixas, nesta ordem: IDENTIDADE · SOBRE O NEGÓCIO · CATÁLOGO · COMO
 * ATENDER · COMO VENDER (só papel sdr) · AGENDA · REGRAS · TRANSFERÊNCIA ·
 * ESTILO · FOLLOW-UP (só com cadência) · FORMATO DA RESPOSTA. Uma seção sem
 * conteúdo no spec não entra — prompt curto é prompt obedecido.
 *
 * ETAPA G (piloto da Sofia) mudou quatro coisas que deixavam o agente pior:
 * - IDENTIDADE não se apresenta como "atendente virtual"; só confirma que é
 *   IA se perguntarem;
 * - `apresentacao` é inspiração, não frase a repetir;
 * - "vou confirmar com a equipe" sem transferir é proibido — ou tem a
 *   informação, ou transfere dizendo o motivo;
 * - ao transferir, o agente escreve 1–2 frases de orientação que o motor
 *   ENVIA antes da transferência (`enviarTextoAoTransferir` no ai.atender).
 *
 * Puro: sem banco. O que depende da conta (dia de hoje, memória, trechos da
 * base, etapas reais) o `ai-agent.service` acrescenta em tempo de execução.
 */

import type { SpecV1 } from './spec';
import { FOLLOWUP_PROMPT_HINT } from '../flow/followup-graph';

/** Teto do prompt gerado. Acima disso o operador precisa encurtar o briefing. */
export const LIMITE_PROMPT_CHARS = 30_000;

const TOM: Record<SpecV1['agente']['tom'], string> = {
  acolhedor: 'acolhedor e próximo — a pessoa precisa sentir que foi ouvida antes de ser encaminhada',
  direto: 'direto e objetivo — responde o que foi perguntado, sem rodeio nem floreio',
  formal: 'formal e cortês — trata por "você", sem gíria, sem intimidade',
  descontraido: 'descontraído e leve — conversa como gente, sem perder a clareza',
};

const SEGMENTO: Record<SpecV1['negocio']['segmento'], string> = {
  clinica: 'clínica de saúde',
  estetica: 'clínica/estúdio de estética',
  academia: 'academia',
  servicos: 'empresa de serviços',
  outro: 'negócio',
};

const PAPEL: Record<SpecV1['agente']['papel'], string> = {
  sdr: 'responsável pela pré-venda — entender o interesse e levar ao próximo passo',
  recepcao: 'da recepção e do atendimento',
  suporte: 'do suporte a quem já é cliente',
};

const UNIDADE: Record<NonNullable<SpecV1['servicos'][number]['unidade']>, string> = {
  sessao: 'por sessão',
  mes: 'por mês',
  pacote: 'por pacote',
  unidade: 'por unidade',
  hora: 'por hora',
  avaliacao: 'por avaliação',
};

const OBJETIVO_DE_VENDA: Record<NonNullable<SpecV1['vendas']>['objetivo'], string> = {
  'agendar avaliacao': 'levar a pessoa a marcar uma avaliação — o agendamento é a conversão',
  fechar: 'fechar nesta conversa — confirmar o serviço ou plano escolhido e o próximo passo para começar',
  qualificar: 'qualificar o interesse (necessidade, urgência, se faz sentido) e encaminhar para a equipe fechar',
};

const ROTEIRO_PADRAO = [
  'Entenda o que a pessoa procura e por quê (uma pergunta por vez).',
  'Conecte a necessidade dela com o item certo do catálogo, sem listar tudo.',
  'Ofereça o próximo passo concreto (horário, avaliação ou contato da equipe).',
  'Confirme o combinado e feche a conversa com o que acontece a seguir.',
];

const SEPARADOR = '\n\n---\n\n';

function lista(itens: string[]): string {
  return itens.map((i) => `- ${i.trim()}`).join('\n');
}

function numerada(itens: string[]): string {
  return itens.map((i, n) => `${n + 1}. ${i.trim()}`).join('\n');
}

/** "R$ 250,00" com espaço comum — o Intl usa NBSP, que vira ruído no prompt. */
export function moeda(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(new RegExp(String.fromCharCode(160), 'g'), ' ');
}

/**
 * Linha do catálogo: "Nome — R$ X por <unidade> (duração Y min) — descrição".
 * Sem valor (ausente/null) → "valor sob consulta"; `valorPadrao: 0` → "gratuito";
 * sem unidade → só o valor; sem duração → sem parênteses. É a mesma linha que
 * vai para o doc "Sobre o negócio".
 */
export function linhaDoCatalogo(s: SpecV1['servicos'][number]): string {
  const preco =
    s.valorPadrao == null
      ? 'valor sob consulta'
      : s.valorPadrao > 0
        ? `${moeda(s.valorPadrao)}${s.unidade ? ` ${UNIDADE[s.unidade]}` : ''}`
        : 'gratuito';
  const duracao = s.duracaoMinutos != null ? ` (duração ${s.duracaoMinutos} min)` : '';
  const desc = s.descricao?.trim() ? ` — ${s.descricao.trim()}` : '';
  return `${s.nome.trim()} — ${preco}${duracao}${desc}`;
}

function secaoIdentidade(spec: SpecV1): string {
  const { agente, negocio } = spec;
  const linhas = [
    `Você é ${agente.nome}, ${PAPEL[agente.papel]} de ${negocio.nome} (${SEGMENTO[negocio.segmento]}), no WhatsApp.`,
    `Seu tom é ${TOM[agente.tom]}.`,
  ];
  if (agente.apresentacao?.trim()) {
    linhas.push(
      `Na primeira mensagem de uma conversa nova, apresente-se de forma natural, usando como base (inspiração, não frase pronta para repetir): "${agente.apresentacao.trim()}". Depois não se apresente de novo.`
    );
  } else {
    linhas.push('Apresente-se pelo nome na primeira mensagem de uma conversa nova; depois não repita.');
  }
  linhas.push(
    'Não se declare "virtual", "assistente de IA" ou "robô" por conta própria. Se perguntarem se é uma pessoa ou uma IA, confirme com naturalidade que é a assistente de IA da equipe e siga ajudando. Nunca diga que é humano.'
  );
  return `IDENTIDADE\n\n${linhas.join('\n')}`;
}

function secaoNegocio(spec: SpecV1): string {
  const n = spec.negocio;
  const partes = [n.sobre.trim()];
  if (n.endereco?.trim()) partes.push(`Endereço: ${n.endereco.trim()}`);
  if (n.contato?.trim()) partes.push(`Contato: ${n.contato.trim()}`);
  if (n.diferenciais.length > 0) partes.push(`Diferenciais:\n${lista(n.diferenciais)}`);
  return `SOBRE O NEGÓCIO\n\n${partes.join('\n')}`;
}

function secaoCatalogo(spec: SpecV1): string {
  if (spec.servicos.length === 0) return '';
  const linhas = spec.servicos.map((s) => `- ${linhaDoCatalogo(s)}`);
  const regras = [
    'Cite o preço exatamente como está aqui, com a unidade informada ("por sessão", "por mês"…). Para item SEM unidade, diga só o valor — nunca acrescente "cada", "por sessão" ou "por mês" por conta própria.',
  ];
  if (spec.servicos.some((s) => s.valorPadrao == null)) {
    regras.push('"Valor sob consulta": não invente nem estime. Diga que a equipe passa o valor e ofereça o próximo passo (agendamento ou transferência).');
  }
  if (spec.servicos.some((s) => !s.agendavel)) {
    regras.push('Só os itens com duração se marcam pelas ferramentas de agenda; os outros você apresenta e encaminha.');
  }
  return `CATÁLOGO\n\n${linhas.join('\n')}\n\nRegras do catálogo:\n${lista(regras)}`;
}

function secaoComoAtender(spec: SpecV1): string {
  const t = spec.triagem;
  const blocos: string[] = [];
  blocos.push(
    'Entenda o que a pessoa precisa antes de oferecer qualquer coisa. Responda a dúvida dela primeiro; a triagem vem na conversa, não como formulário.'
  );
  if (t.perguntas.length > 0) {
    blocos.push(`Ao longo da conversa, apure (UMA pergunta por vez, sem repetir o que já foi dito):\n${lista(t.perguntas)}`);
  }
  if (t.camposMemoria.length > 0) {
    blocos.push(
      'Quando o lead informar um destes dados, guarde com a ferramenta `lembrar` (campo e valor):\n' +
        t.camposMemoria.map((c) => `- ${c.chave}: ${c.descricao.trim()}`).join('\n')
    );
  }
  blocos.push(
    'Se a pergunta for sobre o negócio (preço, horário, convênio, como funciona), consulte a base de conhecimento antes de responder.'
  );
  blocos.push(
    'Não está na base nem aqui? Diga com clareza que não tem essa informação. Se é algo que só a equipe responde, transfira (rota "humano") explicando o motivo ao lead. É PROIBIDO dizer "vou confirmar com a equipe", "vou verificar e te retorno" ou qualquer promessa de retorno sem transferir: você não volta depois, e a pessoa fica esperando.'
  );
  return `COMO ATENDER\n\n${blocos.join('\n\n')}`;
}

function secaoComoVender(spec: SpecV1): string {
  if (spec.agente.papel !== 'sdr') return '';
  const v = spec.vendas;
  const objetivo = v?.objetivo ?? 'agendar avaliacao';
  const blocos: string[] = [`Objetivo da conversa: ${OBJETIVO_DE_VENDA[objetivo]}.`];
  const roteiro = v && v.roteiro.length > 0 ? v.roteiro : ROTEIRO_PADRAO;
  blocos.push(
    `Roteiro (siga a ordem; avance só quando a etapa anterior estiver cumprida, sem pular para a oferta):\n${numerada(roteiro)}`
  );
  if (v && v.gatilhos.length > 0) {
    blocos.push(`Quando oferecer (gatilhos — ao ver um deles, é hora de propor o próximo passo):\n${lista(v.gatilhos)}`);
  }
  if (v && v.objecoes.length > 0) {
    const tabela = ['| Objeção | Como responder |', '| --- | --- |', ...v.objecoes.map((o) => `| ${celula(o.objecao)} | ${celula(o.resposta)} |`)];
    blocos.push(`Objeções — responda assim (adapte ao que a pessoa disse, sem recitar):\n${tabela.join('\n')}`);
  }
  if (v?.fechamento?.trim()) {
    blocos.push(`Fechamento: ${v.fechamento.trim()}`);
  }
  blocos.push('Nunca pressione: uma oferta por vez, e se a pessoa disser que não é o momento, registre e ofereça retomar depois.');
  return `COMO VENDER\n\n${blocos.join('\n\n')}`;
}

/** Célula de tabela markdown: sem quebra de linha nem barra vertical. */
function celula(texto: string): string {
  return texto.trim().replace(/\|/g, '/').replace(/\s*\n+\s*/g, ' ');
}

function secaoAgenda(spec: SpecV1): string {
  if (!spec.agenda.ativo) return '';
  const linhas = [
    'Você marca horário pelas ferramentas de agenda. Nunca invente, calcule ou prometa horário por conta própria.',
    'Roteiro: entenda o serviço → `consultar_horarios` (peça o período que a pessoa prefere: manhã, tarde, um dia) → ofereça até 3 opções com dia da semana e data → o lead escolhe → `reservar` → pergunte "confirmo?" → só depois do sim explícito, `agendar`.',
    'A reserva fica guardada na conversa: quando o lead confirmar na mensagem seguinte, chame `agendar` (sem precisar repetir a referência). Se ele já disse "sim" ao horário ofertado, `agendar` aceita o horário direto.',
    'Se a ferramenta disser que o horário acabou de ser ocupado ou que a reserva venceu, consulte de novo e ofereça outros — não diga que marcou.',
    'Depois de marcar, confirme dia e horário exatos e avise que a pessoa recebe um lembrete.',
    'Para remarcar ou cancelar: `minha_reuniao` primeiro, depois `remarcar`/`cancelar` só com confirmação do lead.',
  ];
  if (spec.agenda.antecedenciaMinimaHoras > 0) {
    linhas.push(
      `Horários com menos de ${spec.agenda.antecedenciaMinimaHoras}h de antecedência não são oferecidos (as ferramentas já filtram).`
    );
  }
  return `AGENDA\n\n${linhas.join('\n')}`;
}

function secaoRegras(spec: SpecV1): string {
  const r = spec.regras;
  const blocos: string[] = [];
  if (r.nuncaResponder.length > 0) {
    blocos.push(
      `NUNCA responda sobre (mesmo que insistam — explique que não é algo que você pode tratar e ofereça a equipe):\n${lista(r.nuncaResponder)}`
    );
  }
  if (r.sempreTransferir.length > 0) {
    blocos.push(`SEMPRE transfira para um humano (rota "humano") quando aparecer:\n${lista(r.sempreTransferir)}`);
  }
  if (r.limites.length > 0) blocos.push(`Limites:\n${lista(r.limites)}`);
  if (r.linksUteis.length > 0) {
    blocos.push(
      `Links que você pode mandar quando fizer sentido (só estes):\n${r.linksUteis
        .map((l) => `- ${l.rotulo.trim()}: ${l.url}`)
        .join('\n')}`
    );
  }
  if (blocos.length === 0) return '';
  return `REGRAS\n\n${blocos.join('\n\n')}`;
}

function secaoTransferencia(spec: SpecV1): string {
  const linhas = [
    'Transfira (rota "humano") quando: o lead pedir explicitamente uma pessoa; houver reclamação, urgência ou situação delicada; a pergunta sair do seu escopo depois de uma tentativa honesta; ou qualquer item de "sempre transferir" aparecer.',
    'Ao transferir, escreva em mensagem_de_resposta 1 ou 2 frases de orientação para a pessoa: o motivo (sem detalhe técnico) e o que fazer enquanto espera. Ex.: "Vou te passar para a equipe, que resolve isso melhor do que eu — já te respondem por aqui." Em urgência de saúde, oriente a procurar atendimento de emergência ou pronto-socorro agora, antes de qualquer outra coisa.',
    `Esse texto é enviado à pessoa antes da transferência. Se você não escrever nada, o sistema manda: "${spec.transferencia.mensagemAoCliente.trim()}"`,
    'Em `resumo`, deixe para a equipe o que a pessoa quer e o que já foi combinado.',
  ];
  return `TRANSFERÊNCIA\n\n${linhas.join('\n')}`;
}

function secaoEstilo(): string {
  return (
    'ESTILO\n\n' +
    [
      '- Português do Brasil, sem emoji, sem markdown, sem lista com marcadores na mensagem ao lead.',
      '- Curto: até 3 frases por mensagem, como quem digita no WhatsApp.',
      '- Uma pergunta por vez. Nunca duas perguntas na mesma mensagem.',
      '- Não repita o que a pessoa acabou de dizer nem o que já está na memória.',
      '- Não prometa prazo, resultado ou desconto que não esteja nas informações acima.',
      '- Áudio não transcrito: peça para escrever.',
    ].join('\n')
  );
}

function secaoFollowup(spec: SpecV1): string {
  if (!spec.followup.ativo) return '';
  const f = spec.followup;
  const partes = ['FOLLOW-UP\n\n' + FOLLOWUP_PROMPT_HINT];
  if (f.mensagens.length > 0) {
    partes.push(
      'Mensagem de referência de cada toque (adapte ao contexto; onde estiver {{nome}}, use o nome do lead se souber, senão omita):\n' +
        f.mensagens.map((m, i) => `- Toque ${i + 1}: "${m.trim()}"`).join('\n')
    );
  } else {
    partes.push(
      `Mensagem de referência do follow-up (adapte ao contexto; onde estiver {{nome}}, use o nome do lead se souber, senão omita): "${f.mensagem.trim()}"`
    );
  }
  return partes.join('\n\n');
}

function secaoFormato(): string {
  return (
    'FORMATO DA RESPOSTA\n\n' +
    'Responda SEMPRE em JSON com estes campos:\n' +
    '- mensagem_de_resposta: o texto que vai para o lead. Com rota "humano", são as 1–2 frases de orientação enviadas antes da transferência.\n' +
    '- rota: "respondeu" quando você atendeu; "humano" quando a conversa precisa de uma pessoa.\n' +
    '- resumo: uma frase para a equipe com o que o lead quer e o estado da conversa.'
  );
}

/** Monta o prompt. Lança se passar do teto — o 400 explica o que encurtar. */
export function montarPrompt(spec: SpecV1): string {
  const secoes = [
    secaoIdentidade(spec),
    secaoNegocio(spec),
    secaoCatalogo(spec),
    secaoComoAtender(spec),
    secaoComoVender(spec),
    secaoAgenda(spec),
    secaoRegras(spec),
    secaoTransferencia(spec),
    secaoEstilo(),
    secaoFollowup(spec),
    secaoFormato(),
  ].filter((s) => s.trim() !== '');
  const prompt = secoes.join(SEPARADOR);
  if (prompt.length > LIMITE_PROMPT_CHARS) {
    throw new PromptLongoDemaisError(prompt.length);
  }
  return prompt;
}

export class PromptLongoDemaisError extends Error {
  readonly tamanho: number;
  constructor(tamanho: number) {
    super(
      `O prompt gerado tem ${tamanho.toLocaleString('pt-BR')} caracteres; o limite é ${LIMITE_PROMPT_CHARS.toLocaleString('pt-BR')}. ` +
        'Encurte negocio.sobre, regras, vendas ou a descrição dos serviços (o FAQ e os textos vão para a base, não para o prompt).'
    );
    this.tamanho = tamanho;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** O schema de saída do agente provisionado: rota fechada + resumo pra equipe. */
export function schemaDeSaida() {
  return {
    type: 'object',
    properties: {
      mensagem_de_resposta: {
        type: 'string',
        description:
          'O que responder ao lead, pronto para o WhatsApp. Com rota = humano: 1–2 frases de orientação, enviadas antes da transferência.',
      },
      rota: {
        type: 'string',
        enum: ['respondeu', 'humano'],
        description: '"respondeu" = você atendeu; "humano" = precisa de uma pessoa da equipe.',
      },
      resumo: {
        type: 'string',
        description: 'Uma frase para a equipe: o que o lead quer e onde a conversa está.',
      },
    },
    required: ['mensagem_de_resposta', 'rota'],
  };
}
