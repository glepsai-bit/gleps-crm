import type { DisparoResumo, NumeroDisparo, StatusDisparo, StatusEnvio, StatusNumero } from '@/services/disparos.backend.service';

export const FUSO_PADRAO = 'America/Sao_Paulo';
/** O contexto de auth ainda não carrega o fuso; quando carregar, este é o único ponto a mudar. */
export function fusoDaConta(account: unknown): string {
  const tz = (account as { timezone?: string } | null)?.timezone;
  return tz || FUSO_PADRAO;
}
export const SEGUNDOS_POR_MENSAGEM = 40; // meio do intervalo fixo de 20 a 60 s
export const JANELA_INICIO = 8;
export const JANELA_FIM = 20;

/** Variáveis que o backend entende na mensagem. */
export const VARIAVEIS = ['{{nome}}', '{{primeiro_nome}}', '{{empresa}}'] as const;

export function formatarDataHora(iso: string | null | undefined, fuso = FUSO_PADRAO): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d).replace(',', '');
}

export function formatarHora(iso: string | null | undefined, fuso = FUSO_PADRAO): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, hour: '2-digit', minute: '2-digit' }).format(d);
}

export function formatarDia(iso: string | null | undefined, fuso = FUSO_PADRAO): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit' }).format(new Date(iso));
}

export function formatarTelefone(tel: string | null | undefined): string {
  if (!tel) return '';
  const d = tel.replace(/\D/g, '');
  const m = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : tel;
}

/** Quantos ms o fuso está à frente/atrás de UTC naquele instante. */
function deslocamentoDoFuso(instante: Date, fuso: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instante);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const comoUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return comoUtc - Math.floor(instante.getTime() / 1000) * 1000;
}

/**
 * Converte "2026-10-08T09:00" (o que o input datetime-local entrega) para o
 * instante real no fuso da CONTA — não o do navegador de quem está agendando.
 */
export function dataNoFuso(local: string, fuso = FUSO_PADRAO): string | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const tentativa = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  const desloc = deslocamentoDoFuso(tentativa, fuso);
  return new Date(tentativa.getTime() - desloc).toISOString();
}

/** Estimativa de término: N × 40 s ÷ nº de números, andando só dentro da janela 08h–20h. */
export function estimarTermino(inicio: Date, mensagens: number, numeros: number, fuso = FUSO_PADRAO): Date {
  let restanteMs = (mensagens * SEGUNDOS_POR_MENSAGEM * 1000) / Math.max(1, numeros);
  let cursor = new Date(inicio);
  const horaLocal = (d: Date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: fuso, hourCycle: 'h23', hour: '2-digit' }).format(d));
  for (let guarda = 0; guarda < 400 && restanteMs > 0; guarda++) {
    const h = horaLocal(cursor);
    if (h < JANELA_INICIO || h >= JANELA_FIM) {
      // pula em passos de 30 min até a janela abrir (simples e correto para qualquer fuso)
      cursor = new Date(cursor.getTime() + 30 * 60 * 1000);
      continue;
    }
    const passo = Math.min(restanteMs, 30 * 60 * 1000);
    cursor = new Date(cursor.getTime() + passo);
    restanteMs -= passo;
  }
  return cursor;
}

/** Aplica variáveis na prévia; aceita o legado {nome}. */
export function renderizarTexto(texto: string, nome: string | null, empresa = ''): string {
  const completo = (nome ?? '').trim();
  const primeiro = completo.split(/\s+/)[0] ?? '';
  return texto
    .replace(/\{\{\s*primeiro_nome\s*\}\}/g, primeiro)
    .replace(/\{\{\s*nome\s*\}\}/g, completo)
    .replace(/\{\{\s*empresa\s*\}\}/g, empresa)
    .replace(/\{nome\}/g, completo);
}

export function formatarTamanho(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

interface Chip { rotulo: string; classe: string }

export const CHIP_STATUS_DISPARO: Record<StatusDisparo, Chip> = {
  enviando: { rotulo: 'Enviando', classe: 'bg-primary/10 text-primary' },
  agendado: { rotulo: 'Agendado', classe: 'bg-info/15 text-info' },
  pausado: { rotulo: 'Pausado', classe: 'bg-warning/15 text-warning' },
  concluido: { rotulo: 'Concluído', classe: 'bg-success/15 text-success' },
  cancelado: { rotulo: 'Cancelado', classe: 'bg-muted text-muted-foreground' },
};

export const CHIP_STATUS_ENVIO: Record<StatusEnvio, Chip> = {
  pendente: { rotulo: 'Na fila', classe: 'bg-muted text-muted-foreground' },
  enviando: { rotulo: 'Enviando', classe: 'bg-primary/10 text-primary' },
  enviada: { rotulo: 'Enviada', classe: 'bg-success/15 text-success' },
  entregue: { rotulo: 'Entregue', classe: 'bg-success/15 text-success' },
  lida: { rotulo: 'Lida', classe: 'bg-success/15 text-success' },
  respondeu: { rotulo: 'Respondeu', classe: 'bg-success/20 text-success font-semibold' },
  falhou: { rotulo: 'Falhou', classe: 'bg-warning/15 text-warning' },
  pulado_optout: { rotulo: 'Pediu para sair', classe: 'bg-muted text-muted-foreground' },
  pulado_invalido: { rotulo: 'Número inválido', classe: 'bg-muted text-muted-foreground' },
  pulado_duplicado: { rotulo: 'Repetido', classe: 'bg-muted text-muted-foreground' },
  cancelado: { rotulo: 'Cancelado', classe: 'bg-muted text-muted-foreground' },
};

export const CHIP_STATUS_NUMERO: Record<StatusNumero, Chip> = {
  pronto: { rotulo: 'pronto', classe: 'bg-success/15 text-success' },
  aquecendo: { rotulo: 'aquecendo', classe: 'bg-primary/10 text-primary' },
  pausado: { rotulo: 'pausado', classe: 'bg-warning/15 text-warning' },
  nao_aquecido: { rotulo: 'não aquecido', classe: 'bg-muted text-muted-foreground' },
};

export function rotuloChipNumero(num: NumeroDisparo): string {
  if (num.status === 'aquecendo' && num.dia) return `aquecendo · dia ${num.dia}`;
  return CHIP_STATUS_NUMERO[num.status].rotulo;
}

/** Linha de apoio do número, no diálogo e na faixa. */
export function descreverCapacidade(num: NumeroDisparo): string {
  switch (num.status) {
    case 'pronto':
      return `pronto · ${num.restantesHoje} de ${num.limiteDiario} restantes hoje`;
    case 'aquecendo':
      return `aquecendo, dia ${num.dia ?? '?'} · ${num.limiteDiario} por dia`;
    case 'pausado':
      return 'aquecimento pausado · não recomendado';
    default:
      return `não aquecido · limite ${num.limiteDiario || 50}/dia`;
  }
}

/** Dias para entregar N mensagens num número, pelo limite diário. */
export function diasNecessarios(mensagens: number, restantesHoje: number, limiteDiario: number): number {
  const limite = Math.max(1, limiteDiario);
  if (mensagens <= restantesHoje) return 1;
  return 1 + Math.ceil((mensagens - restantesHoje) / limite);
}

export function descreverLista(d: DisparoResumo, nomes: { publicos: Record<string, string>; etapas: Record<string, string>; tags: Record<string, string> }): string {
  if (d.listaRotulo) return d.listaRotulo;
  const l = d.lista;
  if (l.tipo === 'publico') return `Público "${nomes.publicos[l.audienceId] ?? 'salvo'}"`;
  if (l.tipo === 'leads') {
    const partes: string[] = [];
    if (l.etapaTagId) partes.push(`na etapa "${nomes.etapas[l.etapaTagId] ?? '—'}"`);
    if (l.tagIds?.length) partes.push(`com ${l.tagIds.length === 1 ? 'a tag' : 'as tags'} ${l.tagIds.map((t) => `"${nomes.tags[t] ?? '—'}"`).join(', ')}`);
    return `Leads ${partes.join(' e ') || 'do CRM'}`;
  }
  return 'Números colados';
}

export function nomesDosNumeros(d: DisparoResumo, numeros: NumeroDisparo[]): string {
  const nomes = d.inboxIds.map((id) => numeros.find((x) => x.inboxId === id)?.nome).filter(Boolean) as string[];
  return nomes.length ? nomes.join(', ') : '—';
}

export function percentual(parte: number, total: number): number {
  return total > 0 ? Math.round((parte / total) * 100) : 0;
}
