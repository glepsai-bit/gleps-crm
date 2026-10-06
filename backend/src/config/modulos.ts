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
 *   disparos    → /whatsapp-templates, /whatsapp/campaigns, /dispatch
 *   emails      → /email, /email/audiences
 *   discador    → /voice (só o router JWT; webhooks da operadora são públicos)
 *   vendas      → /sales, /finance
 *   aquecimento → /warmup
 */
export const MODULOS_OPCIONAIS = [
  'extracao',
  'disparos',
  'emails',
  'discador',
  'vendas',
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
