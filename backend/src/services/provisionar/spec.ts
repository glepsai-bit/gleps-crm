/**
 * PROVISIONAMENTO — a especificação (`spec`), versão 1.1.
 *
 * É o contrato entre o kit do operador (outra pasta, só fala pela API) e a
 * plataforma: um briefing estruturado que o provisionamento transforma em base
 * de conhecimento, serviços, agenda, etapas, prompt por seções e fluxo.
 *
 * v1.1 (ETAPA G, 14/10) é ADITIVA: todo campo novo tem default, e um spec v1
 * continua passando sem mudança. O que entrou:
 * - `agente.papel` (sdr | recepcao | suporte) e `agente.raciocinio` (esforço
 *   de raciocínio dos modelos que aceitam);
 * - bloco `vendas` (só com papel sdr) → seção COMO VENDER do prompt;
 * - `servicos[].unidade` e `servicos[].agendavel` (catálogo completo no
 *   prompt; só o agendável vira serviço de agenda); teto 200;
 * - `followup.tentativas` (intervalos por toque), `followup.janela` e
 *   `followup.mensagens` — `aposHoras`/`maxTentativas` seguem aceitos e viram
 *   tentativas iguais.
 *
 * Toda mensagem de erro em português, porque quem lê é o operador montando o
 * JSON — e a mensagem do zod volta no 400 como `field — message`.
 */

import { z } from 'zod';

export const SEGMENTOS = ['clinica', 'estetica', 'academia', 'servicos', 'outro'] as const;
export type Segmento = (typeof SEGMENTOS)[number];

export const TONS = ['acolhedor', 'direto', 'formal', 'descontraido'] as const;
export type Tom = (typeof TONS)[number];

/** v1.1 — o papel do agente muda a identidade e liga a seção COMO VENDER. */
export const PAPEIS = ['sdr', 'recepcao', 'suporte'] as const;
export type Papel = (typeof PAPEIS)[number];

/** v1.1 — esforço de raciocínio (só os modelos que aceitam; o motor ignora nos outros). */
export const RACIOCINIOS = ['minimal', 'low', 'medium', 'high'] as const;
export type Raciocinio = (typeof RACIOCINIOS)[number];

/** v1.1 — unidade de cobrança do item do catálogo. */
export const UNIDADES = ['sessao', 'mes', 'pacote', 'unidade', 'hora', 'avaliacao'] as const;
export type Unidade = (typeof UNIDADES)[number];

export const OBJETIVOS_DE_VENDA = ['agendar avaliacao', 'fechar', 'qualificar'] as const;
export type ObjetivoDeVenda = (typeof OBJETIVOS_DE_VENDA)[number];

export const MAX_SERVICOS = 200;
export const MAX_FAQ = 200;
export const MAX_TEXTOS = 60;
export const MAX_ROTEIRO = 12;
export const MAX_OBJECOES = 20;
export const MAX_TENTATIVAS = 5;
export const JANELA_PADRAO_FOLLOWUP = { inicio: '08:00', fim: '20:00' } as const;

const texto = (max: number, nome: string) =>
  z
    .string({ required_error: `${nome} é obrigatório`, invalid_type_error: `${nome} precisa ser texto` })
    .trim()
    .min(1, `${nome} é obrigatório`)
    .max(max, `${nome} passa de ${max.toLocaleString('pt-BR')} caracteres`);

const textoOpcional = (max: number, nome: string) =>
  z
    .string({ invalid_type_error: `${nome} precisa ser texto` })
    .trim()
    .max(max, `${nome} passa de ${max.toLocaleString('pt-BR')} caracteres`)
    .optional()
    .nullable();

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

const horarioSchema = z
  .object({
    dias: z
      .array(z.number().int().min(0, 'dia da semana vai de 0 a 6').max(6, 'dia da semana vai de 0 a 6'))
      .min(1, 'informe ao menos um dia da semana (0 = domingo … 6 = sábado)'),
    inicio: z.string().regex(HORA, 'inicio precisa ser HH:MM'),
    fim: z.string().regex(HORA, 'fim precisa ser HH:MM'),
  })
  .refine((h) => h.inicio < h.fim, { message: 'fim precisa vir depois de inicio', path: ['fim'] });

const janelaSchema = z
  .object({
    inicio: z.string().regex(HORA, 'janela.inicio precisa ser HH:MM'),
    fim: z.string().regex(HORA, 'janela.fim precisa ser HH:MM'),
  })
  .refine((j) => j.inicio < j.fim, { message: 'janela.fim precisa vir depois de janela.inicio', path: ['fim'] });

/**
 * v1.1 — item do catálogo. `duracaoMinutos` passou a ser opcional: plano
 * mensal e pacote têm preço mas não têm "duração de atendimento". Só o item
 * agendável (padrão: tem duração) vira serviço de agenda; TODOS entram na
 * seção CATÁLOGO do prompt.
 */
const servicoSchema = z
  .object({
    nome: texto(120, 'nome do serviço'),
    duracaoMinutos: z
      .number({ invalid_type_error: 'duracaoMinutos precisa ser número' })
      .int('duracaoMinutos precisa ser inteiro')
      .min(5, 'duracaoMinutos precisa ser entre 5 e 600')
      .max(600, 'duracaoMinutos precisa ser entre 5 e 600')
      .optional()
      .nullable(),
    // Ausente/null = "valor sob consulta" (o agente não inventa); 0 = gratuito.
    valorPadrao: z
      .number({ invalid_type_error: 'valorPadrao precisa ser número' })
      .min(0, 'valorPadrao não pode ser negativo')
      .max(9_999_999, 'valorPadrao alto demais')
      .optional()
      .nullable(),
    unidade: z
      .enum(UNIDADES, { errorMap: () => ({ message: `unidade precisa ser um de: ${UNIDADES.join(', ')}` }) })
      .optional()
      .nullable(),
    agendavel: z.boolean({ invalid_type_error: 'agendavel precisa ser true ou false' }).optional(),
    descricao: textoOpcional(600, 'descricao do serviço'),
  })
  .transform((s) => ({ ...s, valorPadrao: s.valorPadrao ?? null, agendavel: s.agendavel ?? s.duracaoMinutos != null }))
  .superRefine((s, ctx) => {
    if (s.agendavel && s.duracaoMinutos == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['duracaoMinutos'],
        message: 'serviço agendável precisa de duracaoMinutos (5 a 600) — ou marque agendavel: false',
      });
    }
  });

const campoMemoriaSchema = z.object({
  chave: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,48}$/, 'chave precisa ser minúscula, sem espaço, começando por letra (ex.: motivo_contato)'),
  descricao: texto(400, 'descricao do campo de memória'),
});

const linkSchema = z.object({
  rotulo: texto(80, 'rotulo do link'),
  url: z.string().trim().url('url precisa ser um endereço completo (https://…)').max(500),
});

const listaDeTextos = (max: number, maxCada: number, nome: string) =>
  z.array(texto(maxCada, nome)).max(max, `${nome}: no máximo ${max} itens`).optional().default([]);

/** v1.1 — o bloco de vendas (só com `agente.papel: "sdr"`). */
const vendasSchema = z.object({
  objetivo: z
    .enum(OBJETIVOS_DE_VENDA, {
      errorMap: () => ({ message: `vendas.objetivo precisa ser um de: ${OBJETIVOS_DE_VENDA.join(', ')}` }),
    })
    .optional()
    .default('agendar avaliacao'),
  roteiro: z
    .array(texto(300, 'etapa do roteiro'))
    .max(MAX_ROTEIRO, `vendas.roteiro: no máximo ${MAX_ROTEIRO} etapas`)
    .optional()
    .default([]),
  objecoes: z
    .array(z.object({ objecao: texto(300, 'objecao'), resposta: texto(600, 'resposta da objeção') }))
    .max(MAX_OBJECOES, `vendas.objecoes: no máximo ${MAX_OBJECOES}`)
    .optional()
    .default([]),
  gatilhos: listaDeTextos(12, 200, 'gatilho'),
  fechamento: textoOpcional(500, 'vendas.fechamento'),
});

// ---- Follow-up v1.1: intervalos por toque + compatibilidade com v1 ----

const INTERVALO = /^(\d{1,3})\s*([hd])$/i;

/** "2h" → 2, "1d" → 24, "3d" → 72. Lança se não for intervalo. */
export function horasDoIntervalo(intervalo: string): number {
  const m = INTERVALO.exec(intervalo.trim());
  if (!m) throw new Error(`intervalo inválido: ${intervalo}`);
  const n = Number(m[1]);
  return m[2].toLowerCase() === 'd' ? n * 24 : n;
}

/** "2h" e "1d" como o operador escreveu (sem espaço, minúsculo). */
function normalizarIntervalo(intervalo: string): string {
  const m = INTERVALO.exec(intervalo.trim())!;
  return `${Number(m[1])}${m[2].toLowerCase()}`;
}

const intervaloSchema = z
  .string({ invalid_type_error: 'intervalo precisa ser texto como "2h" ou "1d"' })
  .trim()
  .regex(INTERVALO, 'intervalo precisa ser como "2h", "1d" ou "3d"')
  .refine(
    (v) => {
      // O zod roda o refine mesmo quando o regex já falhou: formato inválido
      // passa aqui (o erro do regex é o que o operador precisa ler).
      if (!INTERVALO.test(v)) return true;
      const h = horasDoIntervalo(v);
      return h >= 1 && h <= 720;
    },
    'intervalo vai de 1h a 30d'
  );

const MENSAGEM_PADRAO_FOLLOWUP = 'Oi {{nome}}, ficou alguma dúvida? Posso ajudar.';

const followupSchema = z
  .object({
    ativo: z.boolean({ invalid_type_error: 'followup.ativo precisa ser true ou false' }),
    /** v1.1 — um intervalo por toque. Substitui aposHoras/maxTentativas. */
    tentativas: z
      .array(intervaloSchema)
      .max(MAX_TENTATIVAS, `followup.tentativas: no máximo ${MAX_TENTATIVAS}`)
      .optional()
      .nullable(),
    /** v1.1 — janela em que o toque pode sair (padrão 08:00–20:00). */
    janela: janelaSchema.optional().nullable(),
    /** v1.1 — mensagem de referência por toque (sem → `mensagem` para todos). */
    mensagens: z
      .array(texto(500, 'mensagem de follow-up'))
      .max(MAX_TENTATIVAS, `followup.mensagens: no máximo ${MAX_TENTATIVAS}`)
      .optional()
      .nullable(),
    /** v1 — compatibilidade: vira `tentativas` iguais. */
    aposHoras: z
      .number({ invalid_type_error: 'aposHoras precisa ser número' })
      .int('aposHoras precisa ser inteiro')
      .min(1, 'aposHoras vai de 1 a 720')
      .max(720, 'aposHoras vai de 1 a 720')
      .optional()
      .nullable(),
    /** v1 — compatibilidade: quantidade de toques quando não há `tentativas`. */
    maxTentativas: z
      .number({ invalid_type_error: 'maxTentativas precisa ser número' })
      .int('maxTentativas precisa ser inteiro')
      .min(1, `maxTentativas vai de 1 a ${MAX_TENTATIVAS}`)
      .max(MAX_TENTATIVAS, `maxTentativas vai de 1 a ${MAX_TENTATIVAS}`)
      .optional()
      .nullable(),
    mensagem: texto(500, 'followup.mensagem').default(MENSAGEM_PADRAO_FOLLOWUP),
  })
  .transform((f) => {
    const tentativas =
      f.tentativas && f.tentativas.length > 0
        ? f.tentativas.map(normalizarIntervalo)
        : Array.from({ length: f.maxTentativas ?? 2 }, () => `${f.aposHoras ?? 24}h`);
    return {
      ativo: f.ativo,
      tentativas,
      janela: f.janela ?? { ...JANELA_PADRAO_FOLLOWUP },
      mensagem: f.mensagem,
      mensagens: f.mensagens ?? [],
      // Derivados, sempre coerentes com `tentativas` — quem lia v1 continua lendo.
      aposHoras: horasDoIntervalo(tentativas[0]),
      maxTentativas: tentativas.length,
    };
  });

export const specSchema = z
  .object({
    versao: z
      .union([z.literal(1), z.literal(1.1), z.literal('1.1')], {
        errorMap: () => ({ message: 'versao precisa ser 1 ou 1.1' }),
      })
      .transform((v) => (v === '1.1' ? 1.1 : v)),
    negocio: z.object({
      nome: texto(120, 'negocio.nome'),
      segmento: z.enum(SEGMENTOS, {
        errorMap: () => ({ message: `segmento precisa ser um de: ${SEGMENTOS.join(', ')}` }),
      }),
      sobre: texto(8000, 'negocio.sobre'),
      endereco: textoOpcional(300, 'negocio.endereco'),
      contato: textoOpcional(300, 'negocio.contato'),
      diferenciais: listaDeTextos(20, 200, 'diferencial'),
    }),
    agente: z.object({
      nome: texto(60, 'agente.nome'),
      tom: z.enum(TONS, {
        errorMap: () => ({ message: `tom precisa ser um de: ${TONS.join(', ')}` }),
      }),
      papel: z
        .enum(PAPEIS, { errorMap: () => ({ message: `papel precisa ser um de: ${PAPEIS.join(', ')}` }) })
        .optional()
        .default('recepcao'),
      apresentacao: textoOpcional(300, 'agente.apresentacao'),
      provider: z
        .enum(['openai', 'anthropic'], {
          errorMap: () => ({ message: 'provider precisa ser openai ou anthropic' }),
        })
        .optional()
        .nullable(),
      model: textoOpcional(80, 'agente.model'),
      raciocinio: z
        .enum(RACIOCINIOS, {
          errorMap: () => ({ message: `raciocinio precisa ser um de: ${RACIOCINIOS.join(', ')}` }),
        })
        .optional()
        .nullable(),
      temperatura: z
        .number({ invalid_type_error: 'temperatura precisa ser número' })
        .min(0, 'temperatura vai de 0 a 2')
        .max(2, 'temperatura vai de 0 a 2')
        .optional()
        .nullable(),
    }),
    vendas: vendasSchema.optional().nullable(),
    servicos: z.array(servicoSchema).max(MAX_SERVICOS, `servicos: no máximo ${MAX_SERVICOS}`).optional().default([]),
    agenda: z
      .object({
        ativo: z.boolean({ invalid_type_error: 'agenda.ativo precisa ser true ou false' }),
        fuso: textoOpcional(60, 'agenda.fuso'),
        horarios: z.array(horarioSchema).max(14, 'agenda.horarios: no máximo 14 faixas').optional().default([]),
        profissionais: z
          .array(z.object({ email: z.string().trim().email('e-mail do profissional inválido') }))
          .max(50, 'agenda.profissionais: no máximo 50')
          .optional()
          .default([]),
        antecedenciaMinimaHoras: z
          .number({ invalid_type_error: 'antecedenciaMinimaHoras precisa ser número' })
          .min(0, 'antecedenciaMinimaHoras vai de 0 a 168')
          .max(168, 'antecedenciaMinimaHoras vai de 0 a 168')
          .optional()
          .default(2),
      })
      .optional()
      .default({ ativo: false, horarios: [], profissionais: [], antecedenciaMinimaHoras: 2 }),
    triagem: z
      .object({
        perguntas: listaDeTextos(12, 200, 'pergunta de triagem'),
        camposMemoria: z.array(campoMemoriaSchema).max(40, 'camposMemoria: no máximo 40').optional().default([]),
      })
      .optional()
      .default({ perguntas: [], camposMemoria: [] }),
    regras: z
      .object({
        nuncaResponder: listaDeTextos(30, 200, 'item de nuncaResponder'),
        sempreTransferir: listaDeTextos(30, 200, 'item de sempreTransferir'),
        limites: listaDeTextos(30, 300, 'limite'),
        linksUteis: z.array(linkSchema).max(20, 'linksUteis: no máximo 20').optional().default([]),
      })
      .optional()
      .default({ nuncaResponder: [], sempreTransferir: [], limites: [], linksUteis: [] }),
    funil: z
      .object({
        etapaAoAtender: texto(100, 'funil.etapaAoAtender').default('Em atendimento'),
        etapaAoAgendar: texto(100, 'funil.etapaAoAgendar').default('Agendado'),
        etapaAoTransferir: texto(100, 'funil.etapaAoTransferir').default('Com humano'),
      })
      .optional()
      .default({ etapaAoAtender: 'Em atendimento', etapaAoAgendar: 'Agendado', etapaAoTransferir: 'Com humano' }),
    transferencia: z
      .object({
        mensagemAoCliente: texto(500, 'transferencia.mensagemAoCliente').default(
          'Vou chamar alguém da equipe para te ajudar, um instante.'
        ),
      })
      .optional()
      .default({ mensagemAoCliente: 'Vou chamar alguém da equipe para te ajudar, um instante.' }),
    followup: followupSchema.optional().default({ ativo: false }),
    conhecimento: z
      .object({
        textos: z
          .array(z.object({ titulo: texto(300, 'titulo do texto'), conteudo: texto(100_000, 'conteudo do texto') }))
          .max(MAX_TEXTOS, `conhecimento.textos: no máximo ${MAX_TEXTOS}`)
          .optional()
          .default([]),
        faq: z
          .array(z.object({ pergunta: texto(500, 'pergunta do FAQ'), resposta: texto(2000, 'resposta do FAQ') }))
          .max(MAX_FAQ, `conhecimento.faq: no máximo ${MAX_FAQ}`)
          .optional()
          .default([]),
      })
      .optional()
      .default({ textos: [], faq: [] }),
    inboxIds: z.array(z.string().uuid('inboxIds precisa conter ids (uuid)')).max(50).optional().nullable(),
  })
  .superRefine((spec, ctx) => {
    // `vendas` descreve como vender; só faz sentido em quem vende.
    if (spec.vendas && spec.agente?.papel !== 'sdr') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['vendas'],
        message: 'vendas só é aceito com agente.papel = "sdr" (o padrão é "recepcao")',
      });
    }
  });

export type SpecV1 = z.infer<typeof specSchema>;
/** O que o operador manda (antes dos defaults). */
export type SpecV1Entrada = z.input<typeof specSchema>;

/**
 * Rede de segurança contra o "Required" em inglês do zod.
 *
 * Campo obrigatório ausente sem `required_error` próprio (um objeto inteiro,
 * como `negocio` ou `agente`) vira "<caminho> é obrigatório". Mensagem que o
 * schema já define em português tem precedência: este mapa só age quando o
 * texto que chegaria ao operador seria o padrão em inglês.
 */
export const mapaDeErrosEmPortugues: z.ZodErrorMap = (issue, ctx) => {
  if (issue.code === z.ZodIssueCode.invalid_type && issue.received === 'undefined' && ctx.defaultError === 'Required') {
    const caminho = issue.path.join('.');
    return { message: caminho ? `${caminho} é obrigatório` : 'corpo da requisição é obrigatório' };
  }
  return { message: ctx.defaultError };
};

/** `schema.parse` com o mapa acima — use em todo parse que recebe o spec. */
export function parseEmPortugues<T extends z.ZodTypeAny>(schema: T, bruto: unknown): z.infer<T> {
  return schema.parse(bruto, { errorMap: mapaDeErrosEmPortugues });
}

/**
 * Valida e normaliza. Lança o ZodError cru: o error.middleware já o transforma
 * em 400 com `fieldErrors` por caminho.
 */
export function validarSpec(bruto: unknown): SpecV1 {
  return parseEmPortugues(specSchema, bruto);
}

/** Os três nomes de etapa que o spec pede, sem repetição e sem vazio. */
export function etapasDoSpec(spec: SpecV1): string[] {
  const nomes = [spec.funil.etapaAoAtender, spec.funil.etapaAoAgendar, spec.funil.etapaAoTransferir]
    .map((n) => n.trim())
    .filter(Boolean);
  const vistos = new Set<string>();
  return nomes.filter((n) => {
    const k = n.toLowerCase();
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

/** Só os itens que viram serviço de agenda (Product com duração). */
export function servicosAgendaveis(spec: SpecV1): (SpecV1['servicos'][number] & { duracaoMinutos: number })[] {
  return spec.servicos.filter(
    (s): s is SpecV1['servicos'][number] & { duracaoMinutos: number } => s.agendavel && s.duracaoMinutos != null
  );
}
