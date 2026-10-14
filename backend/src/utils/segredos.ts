/**
 * ETAPA G (P0-6) — máscara de segredos em TODA leitura de conta.
 *
 * A conta guarda chaves de IA, Evolution, SendGrid, Google, Twilio e SIP em
 * texto puro (o serviço precisa do valor real para chamar o provedor). O que
 * NÃO pode acontecer é esse valor voltar numa resposta da API: `GET /accounts`,
 * `GET /accounts/:id`, `PUT /accounts/:id`, `/auth/me`, telas do super admin,
 * logs de rede do navegador, export de relatório — qualquer um deles vira
 * vazamento.
 *
 * Regra: todo campo sensível sai como `••••` + 4 últimos caracteres (o
 * suficiente para o operador reconhecer QUAL chave está lá sem poder usá-la)
 * — só quando o valor tem 12 caracteres ou mais; segredo curto sai `••••`.
 * O cliente pode mandar esse valor mascarado de volta no PUT (é o que um
 * formulário faz ao salvar sem mexer no campo): o valor mascarado é IGNORADO,
 * nunca gravado por cima do real.
 *
 * Módulo neutro (sem prisma, sem logger) de propósito: é importado por
 * services que os testes mockam, e um helper que vive dentro de um módulo
 * mockado chega `undefined` no teste.
 */

/** Campos nomeados explicitamente (os que existem hoje no model Account). */
export const CAMPOS_SENSIVEIS: readonly string[] = [
  'openaiApiKey',
  'anthropicApiKey',
  'evolutionApiKey',
  'evolutionWebhookSecret',
  'sendgridApiKey',
  'googleClientSecret',
  'twilioAuthToken',
  'twilioAccountSid',
  'twilioApiKeySid',
  'twilioApiKeySecret',
  'sipPassword',
];

/** Rede de segurança para campo novo: *Secret, *Token, *Password, *ApiKey, *Senha. */
const PADRAO_SENSIVEL = /(secret|token|password|apikey|senha)$/i;

export const MASCARA = '••••';
/** Sentinela antiga que telas mais velhas (integrações, voz) ainda mandam de volta. */
const SENTINELA_ANTIGA = '***SET***';

export function ehCampoSensivel(chave: string): boolean {
  return CAMPOS_SENSIVEIS.includes(chave) || PADRAO_SENSIVEL.test(chave);
}

/** Abaixo disto os 4 últimos entregariam boa parte do segredo (senha de 8 caracteres: metade dela). */
const TAMANHO_MINIMO_PARA_MOSTRAR_FIM = 12;

/** `••••` + 4 últimos. Segredo curto (< 12 caracteres) vira só `••••` — não entrega o que não pode. */
export function mascararValor(valor: string): string {
  const v = valor.trim();
  if (v.length < TAMANHO_MINIMO_PARA_MOSTRAR_FIM) return MASCARA;
  return `${MASCARA}${v.slice(-4)}`;
}

/** O valor veio mascarado por nós (ou pela sentinela antiga)? Então não é um valor novo. */
export function ehValorMascarado(valor: unknown): boolean {
  if (typeof valor !== 'string') return false;
  const v = valor.trim();
  return v === SENTINELA_ANTIGA || v.startsWith(MASCARA);
}

export interface FlagsDeChave {
  temChaveOpenai: boolean;
  temChaveAnthropic: boolean;
}

/**
 * Cópia do objeto com os campos sensíveis mascarados e as flags de chave de
 * IA. Campo nulo/vazio continua `null`. Não entra em objetos aninhados de
 * propósito: a conta é plana, e `_count`/relações não carregam segredo.
 */
export function mascararSegredos<T extends object>(obj: T): T & FlagsDeChave {
  const bruto = obj as Record<string, unknown>;
  const saida: Record<string, unknown> = { ...bruto };
  for (const chave of Object.keys(saida)) {
    if (!ehCampoSensivel(chave)) continue;
    const valor = saida[chave];
    if (typeof valor === 'string' && valor.trim() !== '') {
      saida[chave] = mascararValor(valor);
    } else if (valor !== undefined) {
      saida[chave] = null;
    }
  }
  const temChave = (v: unknown) => typeof v === 'string' && v.trim() !== '';
  saida.temChaveOpenai = temChave(bruto.openaiApiKey);
  saida.temChaveAnthropic = temChave(bruto.anthropicApiKey);
  return saida as T & FlagsDeChave;
}

/**
 * Entrada de escrita sem os campos sensíveis cujo valor é uma máscara: o
 * formulário devolveu o que leu, não quer trocar nada. Campo ausente ou com
 * valor real fica como veio.
 */
export function semValoresMascarados<T extends object>(input: T): T {
  const saida: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const chave of Object.keys(saida)) {
    if (ehCampoSensivel(chave) && ehValorMascarado(saida[chave])) delete saida[chave];
  }
  return saida as T;
}
