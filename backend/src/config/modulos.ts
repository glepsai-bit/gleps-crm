/**
 * Módulos opcionais por conta (ETAPA A da reestruturação, 06/10/2026).
 *
 * O super admin liga e desliga módulos por conta; o que não está aqui é
 * núcleo (chat, dashboard, kanban, leads, agenda, atendimento IA, tracking,
 * configurações) e não tem chave — está sempre ligado.
 *
 * As chaves são fixas e espelhadas no front em src/config/modulos.config.ts.
 * Mudar uma chave aqui sem mudar lá quebra o menu e o redirect do front.
 *
 * Mapa rota → módulo (aplicado via requireModulo em cada router):
 *   extracao    → /prospecting
 *   disparos    → /whatsapp-templates, /disparos
 *   emails      → /email, /email/audiences
 *   discador    → /voice (só o router JWT; webhooks da operadora são públicos)
 *   aquecimento → /aquecimento
 *
 * A chave 'vendas' existiu até a etapa C2-V (10/10/2026): Vendas e Financeiro
 * saíram do produto; a venda é registrada pelo Kanban (etapa Fechado), que é
 * núcleo. A migration 0074 tira a chave das contas que a tinham gravada.
 */
export const MODULOS_OPCIONAIS = [
  'extracao',
  'disparos',
  'emails',
  'discador',
  'aquecimento',
] as const;

export type ModuloOpcional = (typeof MODULOS_OPCIONAIS)[number];

/**
 * Conta nova nasce só com o funil de captação. O resto o super admin liga
 * conforme o plano. Contas que já existiam antes da migration 0068 ganharam
 * TODOS os módulos (não perdem nada que viam antes).
 */
export const MODULOS_PADRAO_CONTA_NOVA: ModuloOpcional[] = ['extracao', 'disparos'];

export function isModuloOpcional(valor: unknown): valor is ModuloOpcional {
  return typeof valor === 'string' && (MODULOS_OPCIONAIS as readonly string[]).includes(valor);
}
