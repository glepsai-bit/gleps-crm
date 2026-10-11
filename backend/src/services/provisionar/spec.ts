/**
 * PROVISIONAMENTO — a especificação v1 (`spec`).
 *
 * É o contrato entre o kit do operador (outra pasta, só fala pela API) e a
 * plataforma: um briefing estruturado que o provisionamento transforma em base
 * de conhecimento, serviços, agenda, etapas, prompt por seções e fluxo.
 *
 * Toda mensagem de erro em português, porque quem lê é o operador montando o
 * JSON — e a mensagem do zod volta no 400 como `field — message`.
 */

import { z } from 'zod';

export const SEGMENTOS = ['clinica', 'estetica', 'academia', 'servicos', 'outro'] as const;
export type Segmento = (typeof SEGMENTOS)[number];

export const TONS = ['acolhedor', 'direto', 'formal', 'descontraido'] as const;
export type Tom = (typeof TONS)[number];

export const MAX_SERVICOS = 50;
export const MAX_FAQ = 200;
export const MAX_TEXTOS = 60;

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

const servicoSchema = z.object({
  nome: texto(120, 'nome do serviço'),
  duracaoMinutos: z
    .number({ invalid_type_error: 'duracaoMinutos precisa ser número' })
    .int('duracaoMinutos precisa ser inteiro')
    .min(5, 'duracaoMinutos precisa ser entre 5 e 600')
    .max(600, 'duracaoMinutos precisa ser entre 5 e 600'),
  valorPadrao: z
    .number({ invalid_type_error: 'valorPadrao precisa ser número' })
    .min(0, 'valorPadrao não pode ser negativo')
    .max(9_999_999, 'valorPadrao alto demais')
    .optional()
    .default(0),
  descricao: textoOpcional(600, 'descricao do serviço'),
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

export const specSchema = z.object({
  versao: z.literal(1, {
    errorMap: () => ({ message: 'versao precisa ser 1 (única versão suportada)' }),
  }),
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
    apresentacao: textoOpcional(300, 'agente.apresentacao'),
    provider: z
      .enum(['openai', 'anthropic'], {
        errorMap: () => ({ message: 'provider precisa ser openai ou anthropic' }),
      })
      .optional()
      .nullable(),
    model: textoOpcional(80, 'agente.model'),
    temperatura: z
      .number({ invalid_type_error: 'temperatura precisa ser número' })
      .min(0, 'temperatura vai de 0 a 2')
      .max(2, 'temperatura vai de 0 a 2')
      .optional()
      .nullable(),
  }),
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
  followup: z
    .object({
      ativo: z.boolean({ invalid_type_error: 'followup.ativo precisa ser true ou false' }),
      aposHoras: z
        .number({ invalid_type_error: 'aposHoras precisa ser número' })
        .int('aposHoras precisa ser inteiro')
        .min(1, 'aposHoras vai de 1 a 720')
        .max(720, 'aposHoras vai de 1 a 720')
        .optional()
        .default(24),
      mensagem: texto(500, 'followup.mensagem').default('Oi {{nome}}, ficou alguma dúvida? Posso ajudar.'),
      maxTentativas: z
        .number({ invalid_type_error: 'maxTentativas precisa ser número' })
        .int('maxTentativas precisa ser inteiro')
        .min(1, 'maxTentativas vai de 1 a 3')
        .max(3, 'maxTentativas vai de 1 a 3')
        .optional()
        .default(2),
    })
    .optional()
    .default({ ativo: false, aposHoras: 24, mensagem: 'Oi {{nome}}, ficou alguma dúvida? Posso ajudar.', maxTentativas: 2 }),
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
