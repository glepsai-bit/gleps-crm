/**
 * Normalização de telefone brasileiro para o formato que o WhatsApp usa:
 * só dígitos, com DDI 55, sem "+" — "5511987654321".
 *
 * Por que existe: cada entrada do sistema normalizava de um jeito (consent
 * só tirava não-dígitos, Evolution prefixava 55 só em 11 dígitos, listas
 * coladas vinham com "0" de operadora e "+55" repetido). Resultado: o mesmo
 * contato aparecia como dois, o opt-out de um não valia pro outro, e número
 * fixo entrava na fila do WhatsApp. Uma regra só, usada na criação dos
 * envios, no consent e no inbound.
 *
 * Regras:
 * - só dígitos; zeros à esquerda caem (discagem "0 11 9...", "0055...");
 * - DDI duplicado ("55 55 11 9...") perde um 55;
 * - 11 dígitos = DDD + celular com 9: ganha 55;
 * - 12–13 dígitos começando com 55 e DDD válido: mantém (quem já mandou
 *   com DDI sabe o que mandou — fixo com WhatsApp Business existe);
 * - 10 dígitos sem DDI (fixo ou celular sem o 9) → null: é ambíguo demais
 *   pra inventar um 9;
 * - qualquer outro tamanho → null.
 */
const MAX_ENTRADA = 40;

function dddValido(ddd: string): boolean {
  // DDDs brasileiros vão de 11 a 99 e nenhum tem zero.
  return /^[1-9][1-9]$/.test(ddd);
}

export function normalizarTelefoneBR(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > MAX_ENTRADA) return null;

  let d = raw.replace(/\D+/g, '');
  if (!d) return null;

  d = d.replace(/^0+/, '');

  // "5555 11 9...": DDI digitado duas vezes (colagem de "+55" em cima de
  // um número que já tinha 55). Só quando o tamanho denuncia a duplicata.
  if (d.startsWith('5555') && (d.length === 14 || d.length === 15)) {
    d = d.slice(2);
  }

  if (d.length === 11) {
    if (!dddValido(d.slice(0, 2)) || d[2] !== '9') return null;
    return `55${d}`;
  }

  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) {
    if (!dddValido(d.slice(2, 4))) return null;
    // 13 dígitos = celular: o 9º dígito tem que estar lá.
    if (d.length === 13 && d[4] !== '9') return null;
    return d;
  }

  return null;
}

/**
 * Primeiro nome de um nome completo, para a variável {{primeiro_nome}}.
 * "Maria da Silva" → "Maria". Vazio continua vazio.
 */
export function primeiroNome(nome: string | null | undefined): string {
  const limpo = (nome ?? '').trim();
  if (!limpo) return '';
  return limpo.split(/\s+/)[0];
}
