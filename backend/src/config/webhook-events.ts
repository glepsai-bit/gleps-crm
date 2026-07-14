/**
 * CATÁLOGO ÚNICO de eventos de webhook outbound — fonte da verdade.
 *
 * O frontend (src/services/webhooks.backend.service.ts) espelha esta lista.
 * Antes cada lado tinha a sua: a UI oferecia 5 eventos que o backend nunca
 * emitia (fantasmas) e NÃO oferecia message.created/sla.breached, que o
 * backend emite — era impossível criar pela tela a automação principal
 * ("chegou mensagem → dispara IA/n8n").
 */
export const WEBHOOK_EVENTS = [
  { value: 'message.created',       label: 'Mensagem recebida',    group: 'Atendimento' },
  { value: 'conversation.created',  label: 'Conversa criada',      group: 'Atendimento' },
  { value: 'conversation.resolved', label: 'Conversa resolvida',   group: 'Atendimento' },
  { value: 'contact.created',       label: 'Contato criado',       group: 'CRM' },
  { value: 'contact.updated',       label: 'Contato atualizado',   group: 'CRM' },
  { value: 'sale.paid',             label: 'Venda paga',           group: 'Vendas' },
  { value: 'sla.breached',          label: 'SLA estourado',        group: 'Atendimento' },
  { value: 'optout.created',        label: 'Opt-out recebido',     group: 'WhatsApp' },
  { value: 'campaign.completed',    label: 'Campanha concluída',   group: 'WhatsApp' },
  { value: 'campaign.cancelled',    label: 'Campanha cancelada',   group: 'WhatsApp' },
] as const;

export type WebhookEventValue = (typeof WEBHOOK_EVENTS)[number]['value'];

export const WEBHOOK_EVENT_VALUES = WEBHOOK_EVENTS.map((e) => e.value) as [
  WebhookEventValue,
  ...WebhookEventValue[],
];
