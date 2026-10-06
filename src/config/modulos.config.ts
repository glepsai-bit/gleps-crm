/**
 * Módulos opcionais por conta.
 *
 * As chaves são fixas e IDÊNTICAS às de backend/src/config/modulos.ts: o
 * servidor responde 403 MODULO_DESLIGADO nas rotas do módulo e o front só
 * esconde a porta. Mudar uma chave aqui sem mudar lá deixa a tela e a API
 * discordando.
 *
 * O núcleo (chat, dashboard, kanban, leads, agenda, atendimento IA, tracking,
 * configurações) não tem chave: está sempre ligado.
 */

export const MODULOS_OPCIONAIS = [
  'extracao',
  'disparos',
  'emails',
  'discador',
  'vendas',
  'aquecimento',
] as const;

export type ModuloChave = (typeof MODULOS_OPCIONAIS)[number];

/** O que uma conta nova recebe (o super admin liga o resto conta a conta). */
export const MODULOS_PADRAO_CONTA_NOVA: ModuloChave[] = ['extracao', 'disparos'];

export interface ModuloInfo {
  chave: ModuloChave;
  rotulo: string;
  descricao: string;
  /** Rotas do front que dependem do módulo (prefixo). */
  rotas: string[];
}

export const MODULOS: Record<ModuloChave, ModuloInfo> = {
  extracao: {
    chave: 'extracao',
    rotulo: 'Extração',
    descricao: 'Google Maps e audiências. Ligado por padrão; desliga só pra quem não capta.',
    rotas: ['/admin/prospeccao'],
  },
  disparos: {
    chave: 'disparos',
    rotulo: 'Disparos',
    descricao: 'Templates e campanhas em massa no WhatsApp. Ligado por padrão.',
    rotas: ['/admin/whatsapp-templates'],
  },
  vendas: {
    chave: 'vendas',
    rotulo: 'Vendas',
    descricao:
      'Lista de vendas, estornos, formas de pagamento e Financeiro. O fechamento no Kanban funciona sem isto.',
    rotas: ['/admin/sales', '/admin/finance'],
  },
  emails: {
    chave: 'emails',
    rotulo: 'E-mails',
    descricao: 'Cadências, templates, campanhas, caixa de entrada.',
    rotas: ['/admin/emails'],
  },
  discador: {
    chave: 'discador',
    rotulo: 'Discador',
    descricao: 'Ligações por Twilio ou SIP.',
    rotas: ['/admin/discador'],
  },
  aquecimento: {
    chave: 'aquecimento',
    rotulo: 'Aquecimento',
    descricao: 'Aquecimento de números de WhatsApp.',
    rotas: ['/admin/warmup'],
  },
};

/** Ordem em que o card do super admin lista os módulos (quadro aprovado). */
export const MODULOS_ORDEM_CARD: ModuloChave[] = [
  'extracao',
  'disparos',
  'vendas',
  'emails',
  'discador',
  'aquecimento',
];

/**
 * `modulos` ausente (cache de login antigo, preview Supabase, super admin sem
 * conta) significa TODOS ligados: esconder tela por causa de cache velho
 * deixaria o cliente sem acesso até o /auth/me hidratar.
 */
export function moduloLigado(
  modulos: readonly string[] | null | undefined,
  modulo: ModuloChave,
): boolean {
  if (!Array.isArray(modulos)) return true;
  return modulos.includes(modulo);
}
