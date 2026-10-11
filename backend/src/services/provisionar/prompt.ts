/**
 * PROVISIONAMENTO — o systemPrompt montado por SEÇÕES a partir do spec.
 *
 * Seções fixas, nesta ordem: IDENTIDADE · SOBRE O NEGÓCIO · SERVIÇOS · COMO
 * ATENDER · AGENDA · REGRAS · TRANSFERÊNCIA · ESTILO · FORMATO DA RESPOSTA
 * (+ FOLLOW-UP quando a cadência está ligada). Uma seção sem conteúdo no spec
 * não entra — prompt curto é prompt obedecido.
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

const SEPARADOR = '\n\n---\n\n';

function lista(itens: string[]): string {
  return itens.map((i) => `- ${i.trim()}`).join('\n');
}

/** "R$ 250,00" com espaço comum — o Intl usa NBSP, que vira ruído no prompt. */
export function moeda(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(new RegExp(String.fromCharCode(160), 'g'), ' ');
}

function secaoIdentidade(spec: SpecV1): string {
  const { agente, negocio } = spec;
  const linhas = [
    `Você é ${agente.nome}, atendente virtual de ${negocio.nome} (${SEGMENTO[negocio.segmento]}), no WhatsApp.`,
    `Seu tom é ${TOM[agente.tom]}.`,
  ];
  if (agente.apresentacao?.trim()) {
    linhas.push(`Na primeira mensagem de uma conversa nova, apresente-se assim: "${agente.apresentacao.trim()}"`);
  } else {
    linhas.push('Apresente-se pelo nome na primeira mensagem de uma conversa nova; depois não repita.');
  }
  linhas.push('Você nunca diz que é humano. Se perguntarem, diz que é a assistente virtual da equipe.');
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

function secaoServicos(spec: SpecV1): string {
  if (spec.servicos.length === 0) return '';
  const linhas = spec.servicos.map((s) => {
    const preco = s.valorPadrao > 0 ? `, ${moeda(s.valorPadrao)}` : '';
    const desc = s.descricao?.trim() ? ` — ${s.descricao.trim()}` : '';
    return `- ${s.nome.trim()} (${s.duracaoMinutos} min${preco})${desc}`;
  });
  const semPreco = spec.servicos.some((s) => !(s.valorPadrao > 0));
  return (
    'SERVIÇOS\n\n' +
    linhas.join('\n') +
    (semPreco
      ? '\n\nServiço sem preço aqui: não invente valor. Diga que a equipe passa o valor e ofereça o agendamento ou a transferência.'
      : '')
  );
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
    'Se a pergunta for sobre o negócio (preço, horário, convênio, como funciona), consulte a base de conhecimento antes de responder. Não está na base? Diga que vai confirmar com a equipe — não invente.'
  );
  return `COMO ATENDER\n\n${blocos.join('\n\n')}`;
}

function secaoAgenda(spec: SpecV1): string {
  if (!spec.agenda.ativo) return '';
  const linhas = [
    'Você marca horário pelas ferramentas de agenda. Nunca invente, calcule ou prometa horário por conta própria.',
    'Roteiro: entenda o serviço → `consultar_horarios` → ofereça até 3 opções com dia da semana e data → o lead escolhe → `reservar` → pergunte "confirmo?" → só depois do sim explícito, `agendar`.',
    'Se a ferramenta disser que o horário acabou de ser ocupado, consulte de novo e ofereça outros — não diga que marcou.',
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
    `Ao transferir, não escreva despedida nem explicação longa — o sistema avisa o lead com: "${spec.transferencia.mensagemAoCliente.trim()}"`,
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
  return (
    'FOLLOW-UP\n\n' +
    FOLLOWUP_PROMPT_HINT +
    `\n\nMensagem de referência do follow-up (adapte ao contexto; onde estiver {{nome}}, use o nome do lead se souber, senão omita): "${spec.followup.mensagem.trim()}"`
  );
}

function secaoFormato(): string {
  return (
    'FORMATO DA RESPOSTA\n\n' +
    'Responda SEMPRE em JSON com estes campos:\n' +
    '- mensagem_de_resposta: o texto que vai para o lead (vazio só quando rota for "humano").\n' +
    '- rota: "respondeu" quando você atendeu; "humano" quando a conversa precisa de uma pessoa.\n' +
    '- resumo: uma frase para a equipe com o que o lead quer e o estado da conversa.'
  );
}

/** Monta o prompt. Lança se passar do teto — o 400 explica o que encurtar. */
export function montarPrompt(spec: SpecV1): string {
  const secoes = [
    secaoIdentidade(spec),
    secaoNegocio(spec),
    secaoServicos(spec),
    secaoComoAtender(spec),
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
        'Encurte negocio.sobre, regras ou a descrição dos serviços (o FAQ e os textos vão para a base, não para o prompt).'
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
        description: 'O que responder ao lead, pronto para o WhatsApp. Vazio só quando rota = humano.',
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
