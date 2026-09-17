/**
 * T-037 — campos de memória declarados pelo admin.
 *
 * O problema que isto resolve: `lembrar` recebia o nome do campo como texto
 * livre. A descrição sugeria "faturamento_mensal", mas sugestão não é
 * contrato — o mesmo fato virava `faturamento` numa conversa, `receita_mensal`
 * na outra. O resultado é memória que ninguém lê de volta: nem outro agente,
 * nem relatório, nem o próprio agente na conversa seguinte.
 *
 * A resposta não é escolher as chaves por ele. É deixar o admin DECLARAR quais
 * campos aquele agente mantém: com campos declarados, `campo` vira enum, e a
 * descrição de cada um é o que o modelo lê pra decidir o que vai ali.
 *
 * Mesma família do http-tool.ts — configuração do agente que vira forma de
 * ferramenta —, e por isso a mesma organização: tipo, parser tolerante,
 * validador estrito e a definição que o modelo enxerga.
 *
 * COMPATIBILIDADE: agente sem campos declarados continua com campo livre. A
 * lista vazia é o estado de toda a produção de hoje, e não pode mudar nada.
 */

import type { ChatToolDef } from './chat';

/**
 * Onde o fato mora, e é a distinção que faz a memória valer alguma coisa:
 *
 * `memoria` — fato sobre a PESSOA (Contact.customAttributes). Sobrevive à
 *   conversa: o lead que sumiu e voltou em março continua faturando o mesmo.
 * `sessao`  — estado DESTA conversa (Conversation.customAttributes). Morre com
 *   ela, e é isso que se quer: o roteiro recomeça, os fatos não.
 */
export type EscopoDeMemoria = 'memoria' | 'sessao';

export interface CampoDeMemoria {
  /** Nome estável da chave gravada. É o que um relatório vai procurar. */
  chave: string;
  /**
   * O campo que decide tudo: é o que o modelo lê pra saber o que guardar ali.
   * Descrição vaga vira campo nunca preenchido, ou preenchido com a coisa
   * errada — exatamente o problema que os campos declarados vieram resolver.
   */
  descricao: string;
  escopo: EscopoDeMemoria;
}

/** Teto de campos por agente. Acima disso o enum vira ruído no prompt. */
export const MAX_CAMPOS_DE_MEMORIA = 40;
const MAX_DESCRICAO = 400;

/**
 * Minúscula, sem espaço, começando por letra. O `_` inicial fica de fora pela
 * própria regex: é prefixo reservado ao controle interno (`_resumo_conversa`,
 * `_agente.<id>.*`), e um campo declarado que o sobrescrevesse apagaria estado
 * do motor.
 */
const CHAVE_VALIDA = /^[a-z][a-z0-9_]{1,48}$/;

/**
 * NOMES RESERVADOS AO ATENDIMENTO — a lista mora aqui, e só aqui.
 *
 * O `_` inicial não é a única reserva. Os `customAttributes` da conversa
 * carregam bandeiras operacionais SEM `_`, lidas por nome por código que não
 * tem nada a ver com IA. A pior delas é o circuit breaker:
 *
 *   `human_active` — quando um humano assume, vira `true` e CALA a IA
 *     (conversation.service.ts `markHumanActive`, e as checagens
 *     `attrs.human_active === true` em message.controller.ts e
 *     whatsapp-send.service.ts).
 *
 * Um campo declarado com essa chave e escopo `sessao` grava `{ v, por, em }`
 * por cima do `true`. A checagem `=== true` passa a dar falso e A IA VOLTA A
 * RESPONDER POR CIMA DO ATENDENTE — o pior resultado possível do sistema. As
 * outras bandeiras seguem o mesmo padrão (comparação por valor exato ou
 * `typeof === 'string'`), então todas falham do mesmo jeito: em silêncio.
 *
 * Em minúsculas porque a comparação é case-insensitive: `nodes.ts` lê o
 * camelCase `humanActiveAt` como alternativa ao `human_active_at`, e recusar
 * as duas grafias custa uma linha.
 */
const CHAVES_RESERVADAS_DO_ATENDIMENTO = new Set([
  'human_active', // circuit breaker: humano assumiu, IA calada
  'human_intervened',
  'human_intervened_at',
  'human_active_at', // janela de "humano ativo há pouco" (flow/nodes.ts)
  'humanactiveat', // a mesma, no camelCase que nodes.ts também aceita
  'handler_active', // quem está conduzindo, nas métricas de atendimento
  'ai_handled',
  'ai_handled_at',
  'resolved_by_attr', // quem resolveu, usado no relatório de resolução
]);

/** Reservado ao atendimento? Case-insensitive, pelas duas grafias do camelCase. */
export function ehChaveReservada(chave: string): boolean {
  return CHAVES_RESERVADAS_DO_ATENDIMENTO.has(chave.trim().toLowerCase());
}

function normalizar(bruto: unknown): CampoDeMemoria | null {
  const o = bruto as Partial<CampoDeMemoria> | null;
  if (!o || typeof o.chave !== 'string' || typeof o.descricao !== 'string') return null;
  const chave = o.chave.trim();
  const descricao = o.descricao.trim();
  if (!CHAVE_VALIDA.test(chave)) return null;
  // Também aqui, e não só na validação do cadastro: se uma chave reservada
  // entrou no banco antes desta guarda existir, ela não pode voltar a virar
  // campo gravável só porque a validação de hoje nunca mais roda sobre ela.
  if (ehChaveReservada(chave)) return null;
  if (!descricao || descricao.length > MAX_DESCRICAO) return null;
  return {
    chave,
    descricao,
    escopo: o.escopo === 'sessao' ? 'sessao' : 'memoria',
  };
}

/**
 * Leitura TOLERANTE — usada ao ler o agente já gravado.
 *
 * Descarta em silêncio o que não dá pra usar (e a chave repetida, ficando com a
 * primeira). Um registro antigo meio torto não pode derrubar o atendimento:
 * sem campo utilizável, o agente volta ao campo livre, que é o de hoje.
 */
export function lerCamposDeMemoria(bruto: unknown): CampoDeMemoria[] {
  if (!Array.isArray(bruto)) return [];
  const vistos = new Set<string>();
  const saida: CampoDeMemoria[] = [];
  for (const item of bruto) {
    const campo = normalizar(item);
    if (!campo || vistos.has(campo.chave)) continue;
    vistos.add(campo.chave);
    saida.push(campo);
    if (saida.length >= MAX_CAMPOS_DE_MEMORIA) break;
  }
  return saida;
}

/**
 * Validação ESTRITA — usada no create/update, onde o admin precisa saber o que
 * está errado em vez de ver o campo sumir sem explicação.
 */
export function validarCamposDeMemoria(bruto: unknown): {
  campos: CampoDeMemoria[];
  erros: string[];
} {
  if (bruto === null || bruto === undefined) return { campos: [], erros: [] };
  if (!Array.isArray(bruto)) {
    return { campos: [], erros: ['Os campos de memória precisam vir como lista.'] };
  }
  if (bruto.length > MAX_CAMPOS_DE_MEMORIA) {
    return {
      campos: [],
      erros: [`No máximo ${MAX_CAMPOS_DE_MEMORIA} campos de memória por agente.`],
    };
  }

  const erros: string[] = [];
  const campos: CampoDeMemoria[] = [];
  const vistos = new Set<string>();

  bruto.forEach((item, i) => {
    const posicao = `campo ${i + 1}`;
    const o = item as Partial<CampoDeMemoria> | null;
    const chaveBruta = typeof o?.chave === 'string' ? o.chave.trim() : '';
    const descricao = typeof o?.descricao === 'string' ? o.descricao.trim() : '';

    if (!chaveBruta) {
      erros.push(`${posicao}: informe a chave.`);
      return;
    }
    if (chaveBruta.startsWith('_')) {
      // Explícito, e não só "chave inválida": `_` é reservado ao controle
      // interno, e o admin merece saber por que o nome dele foi recusado.
      erros.push(`"${chaveBruta}": chave não pode começar com "_" (reservado ao sistema).`);
      return;
    }
    if (ehChaveReservada(chaveBruta)) {
      // Antes da checagem de formato: `humanActiveAt` também é reservado, e
      // "use minúsculas" seria a explicação errada pro nome errado.
      erros.push(
        `"${chaveBruta}": esse nome é usado pelo atendimento para controlar quando um ` +
          `humano assume a conversa — gravar nele faria a IA responder por cima do atendente. ` +
          `Escolha outro nome.`
      );
      return;
    }
    if (!CHAVE_VALIDA.test(chaveBruta)) {
      erros.push(
        `"${chaveBruta}": use minúsculas, sem espaço nem acento (ex: faturamento_mensal).`
      );
      return;
    }
    if (vistos.has(chaveBruta)) {
      // Duas declarações com a mesma chave são uma só memória com duas
      // descrições — o modelo leria as duas e gravaria qualquer uma das duas
      // coisas no mesmo lugar.
      erros.push(`"${chaveBruta}": chave repetida.`);
      return;
    }
    if (!descricao) {
      erros.push(`"${chaveBruta}": descreva o que guardar aqui — é o que o agente lê.`);
      return;
    }
    if (descricao.length > MAX_DESCRICAO) {
      erros.push(`"${chaveBruta}": descrição acima de ${MAX_DESCRICAO} caracteres.`);
      return;
    }
    if (o?.escopo !== undefined && o.escopo !== 'memoria' && o.escopo !== 'sessao') {
      erros.push(`"${chaveBruta}": escopo deve ser "memoria" ou "sessao".`);
      return;
    }

    vistos.add(chaveBruta);
    campos.push({
      chave: chaveBruta,
      descricao,
      escopo: o?.escopo === 'sessao' ? 'sessao' : 'memoria',
    });
  });

  return { campos, erros };
}

/** Onde gravar esta chave. `null` = não é campo declarado deste agente. */
export function escopoDaChave(campos: CampoDeMemoria[], chave: string): EscopoDeMemoria | null {
  return campos.find((c) => c.chave === chave)?.escopo ?? null;
}

/**
 * A ferramenta `lembrar` como o modelo a enxerga quando há campos declarados.
 *
 * Duas coisas mudam em relação à versão livre, e as duas importam:
 *   1. `campo` é enum — o modelo não consegue mais inventar a chave;
 *   2. a descrição LISTA cada chave com o que vai nela — sem isso o enum diz
 *      quais nomes existem, mas não quando usar cada um, e o modelo escolhe
 *      pelo nome, que é adivinhação.
 */
export function definicaoDoLembrarDeclarado(campos: CampoDeMemoria[]): ChatToolDef {
  const linhas = campos.map((c) => {
    const onde = c.escopo === 'sessao' ? 'só esta conversa' : 'vale entre conversas';
    return `- ${c.chave} (${onde}): ${c.descricao}`;
  });

  return {
    name: 'lembrar',
    description:
      'Guarda o que você apurou nos campos que este atendimento mantém. Use assim que ' +
      'o lead informar — não espere o fim da conversa. Um campo por chamada; chamando de ' +
      'novo no mesmo campo, o valor novo substitui o anterior.\n\nCampos:\n' +
      linhas.join('\n'),
    parameters: {
      type: 'object',
      properties: {
        campo: {
          type: 'string',
          enum: campos.map((c) => c.chave),
          description: 'Qual campo preencher.',
        },
        valor: { type: 'string', description: 'O que foi apurado, em poucas palavras.' },
      },
      required: ['campo', 'valor'],
    },
  };
}

/**
 * A ficha dos campos declarados para o prompt — COM os vazios.
 *
 * O vazio é metade do valor: o bloco de memória comum só mostra o que já se
 * sabe, então o agente nunca enxerga o buraco. Aqui ele vê a lista inteira e
 * sabe o que ainda falta descobrir.
 *
 * Devolve '' quando não há campo declarado, pra que o prompt de hoje siga
 * byte a byte igual.
 */
export function formatFichaDeMemoria(
  campos: CampoDeMemoria[],
  valores: { memoria?: Record<string, unknown>; sessao?: Record<string, unknown> },
  /** Desembrulha `{ v, por, em }`; injetado pra não duplicar a regra de autoria. */
  lerValor: (v: unknown) => unknown,
  /**
   * O agente REALMENTE tem a ferramenta `lembrar` nesta execução?
   *
   * Campos declarados e lista de ferramentas são telas diferentes, então
   * "declarou campos, mas tirou a ferramenta" está a um clique de distância.
   * Sem este parâmetro a ficha mandava usar uma ferramenta que não foi enviada
   * ao provider: o modelo alucina a chamada, ou promete ao lead que "vai
   * registrar", e nada é gravado — pior que não pedir nada.
   *
   * Obrigatório de propósito: quem monta o prompt tem que decidir, não herdar
   * um default.
   */
  podeGravar: boolean
): string {
  if (campos.length === 0) return '';

  const linhas: string[] = [];
  for (const c of campos) {
    // Procura no escopo declarado e, se não achar, no outro.
    //
    // O escopo diz onde GRAVAR, não onde o fato pode estar: o mesmo nome pode
    // ter sido anotado antes da declaração existir, ou por um bloco que grava
    // na conversa. Olhando só o escopo declarado, a ficha dizia "(ainda não
    // sei)" para um campo que o bloco logo acima mostrava preenchido — o
    // prompt se contradizia, e o agente perguntava o nome de quem ele já
    // conhecia. É a falha que esta ficha existe pra evitar.
    const declarado = c.escopo === 'sessao' ? valores.sessao : valores.memoria;
    const outro = c.escopo === 'sessao' ? valores.memoria : valores.sessao;
    const cru = lerValor(declarado?.[c.chave]) ?? lerValor(outro?.[c.chave]);
    const preenchido =
      cru !== null && cru !== undefined && String(cru).trim() !== ''
        ? typeof cru === 'string'
          ? cru
          : JSON.stringify(cru)
        : null;

    if (preenchido) {
      linhas.push(`- ${c.chave}: ${preenchido}`);
      continue;
    }
    // O buraco só entra na lista quando há como tapá-lo. Sem a ferramenta,
    // "(ainda não sei)" é só um convite a prometer o que não vai acontecer.
    if (podeGravar) linhas.push(`- ${c.chave}: (ainda não sei) — ${c.descricao}`);
  }

  // Sem ferramenta e sem nada preenchido não sobra bloco nenhum — e é o certo:
  // não há fato a mostrar nem ação a pedir.
  if (linhas.length === 0) return '';

  // A ESCOLHA, quando não há ferramenta: mantém o que o agente JÁ SABE e tira
  // só a instrução de registrar. O valor gravado continua útil sem a
  // ferramenta (evita perguntar de novo o que o lead já respondeu); a
  // instrução, não — ela só existe se houver como cumprir.
  if (!podeGravar) {
    return (
      'O QUE VOCÊ JÁ SABE DESTE ATENDIMENTO\n' +
      'Não pergunte de novo o que já está aqui. Você não tem como registrar nada agora, ' +
      'então não prometa anotar nem dizer que vai guardar.\n\n' +
      linhas.join('\n')
    );
  }

  return (
    'FICHA QUE VOCÊ MANTÉM\n' +
    'Use a ferramenta `lembrar` para preencher o que estiver marcado como "(ainda não sei)", ' +
    'assim que o lead informar. Não pergunte de novo o que já está preenchido, e não force ' +
    'a conversa só para preencher campo.\n\n' +
    linhas.join('\n')
  );
}

/**
 * As chaves declaradas de UM escopo, pra não repetir o mesmo fato em dois
 * blocos do prompt.
 *
 * O escopo é obrigatório, e esse é o ponto: um Set plano (todas as chaves,
 * sem escopo) usado como filtro nos dois blocos ESCONDE o valor gravado no
 * escopo oposto. Agente que declara `nome` como `sessao` num contato que tem
 * `nome: "João"` na memória longa perdia o "João" do prompt — e a ficha, que
 * olha só o escopo declarado, dizia "(ainda não sei)". O agente pergunta o
 * nome de quem ele já conhecia, que é exatamente o que esta feature veio
 * evitar. Filtrando por escopo, o bloco do outro escopo segue mostrando o
 * valor que existe.
 */
export function chavesDeclaradas(
  campos: CampoDeMemoria[],
  escopo: EscopoDeMemoria
): Set<string> {
  return new Set(campos.filter((c) => c.escopo === escopo).map((c) => c.chave));
}
