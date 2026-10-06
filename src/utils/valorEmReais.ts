/**
 * Converte o que o usuário digitou ("1.500,50", "1500.5", "R$ 300") em número.
 * Devolve null se não der pra entender — o botão Registrar fica desabilitado.
 */
export function lerValorEmReais(texto: string): number | null {
  const limpo = texto.replace(/[^\d.,]/g, '');
  if (!limpo) return null;
  // Se tem vírgula, ela é o decimal e os pontos são milhar ("1.500,50").
  // Sem vírgula, um ponto seguido de 1-2 dígitos finais é decimal ("1500.5").
  let normalizado: string;
  if (limpo.includes(',')) {
    normalizado = limpo.replace(/\./g, '').replace(',', '.');
  } else if (/\.\d{1,2}$/.test(limpo)) {
    normalizado = limpo.replace(/\.(?=.*\.)/g, '');
  } else {
    normalizado = limpo.replace(/\./g, '');
  }
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}
