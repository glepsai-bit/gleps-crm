import { useEffect, useState, useCallback } from 'react';
import { Loader2, Mail, Eye, MousePointer, AlertTriangle, Send, Clock, RefreshCw, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { emailService, type EmailEnrollment, type EmailSend } from '@/services/email.service';

interface Props {
  cadenceId: string;
  stepId: string;
  stepDayNumber: number;
  cadenceStartDate?: string | null;
  cadenceSendAtTime?: string | null;
}

interface RecipientRow {
  contactId: string;
  contactName: string;
  contactEmail: string;
  status:
    | 'pending'
    | 'sent'
    | 'delivered'
    | 'opened'
    | 'clicked'
    | 'bounced'
    | 'failed'
    | 'queued';
  scheduledAt?: string | null; // ISO — when this step is expected to fire
  sentAt?: string | null;
  openedAt?: string | null;
  clickedAt?: string | null;
  errorMessage?: string | null;
}

const STATUS_META: Record<string, { label: string; className: string; icon: any }> = {
  pending:   { label: 'Aguardando',  className: 'bg-amber-500/10 text-amber-400 border-amber-500/30', icon: Clock },
  queued:    { label: 'Na fila',     className: 'bg-amber-500/10 text-amber-400 border-amber-500/30', icon: Clock },
  sent:      { label: 'Enviado',     className: 'bg-blue-500/10 text-blue-400 border-blue-500/30',   icon: Send },
  delivered: { label: 'Entregue',    className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', icon: Mail },
  opened:    { label: 'Aberto',      className: 'bg-violet-500/10 text-violet-400 border-violet-500/30', icon: Eye },
  clicked:   { label: 'Clicado',     className: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',   icon: MousePointer },
  bounced:   { label: 'Bounce',      className: 'bg-orange-500/10 text-orange-400 border-orange-500/30', icon: AlertTriangle },
  failed:    { label: 'Falhou',      className: 'bg-destructive/10 text-destructive border-destructive/30', icon: AlertTriangle },
};

function formatDateTime(iso?: string | null) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

/**
 * Computes the expected send date for a given step:
 *   max(cadenceStartDate, enrolledAt) + (dayNumber - 1) days at sendAtTime
 */
function computeScheduledDate(
  enrolledAt: string,
  dayNumber: number,
  cadenceStartDate?: string | null,
  cadenceSendAtTime?: string | null,
): string {
  const enrolled = new Date(enrolledAt);
  let base = enrolled;
  if (cadenceStartDate) {
    const start = new Date(`${cadenceStartDate}T00:00:00`);
    if (start.getTime() > enrolled.getTime()) base = start;
  }
  const target = new Date(base);
  target.setDate(target.getDate() + Math.max(0, dayNumber - 1));
  if (cadenceSendAtTime) {
    const [h, m] = cadenceSendAtTime.split(':').map(Number);
    target.setHours(h || 9, m || 0, 0, 0);
  }
  return target.toISOString();
}

export default function StepRecipientsPanel({
  cadenceId, stepId, stepDayNumber, cadenceStartDate, cadenceSendAtTime,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<RecipientRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [enrollments, sends] = await Promise.all([
        emailService.listEnrollments(cadenceId),
        emailService.listSends({ cadenceId, limit: 500 }),
      ]);

      // Build a map: contactId -> latest send for THIS step
      const sendsForStep = new Map<string, EmailSend>();
      for (const s of (sends as EmailSend[])) {
        if ((s as any).step_id !== stepId && (s as any).step?.id !== stepId) continue;
        const existing = sendsForStep.get(s.contact_id);
        if (!existing || new Date(s.created_at).getTime() > new Date(existing.created_at).getTime()) {
          sendsForStep.set(s.contact_id, s);
        }
      }

      const result: RecipientRow[] = (enrollments as EmailEnrollment[]).map(en => {
        const send = sendsForStep.get(en.contact_id);
        const baseRow = {
          contactId: en.contact_id,
          contactName: en.contact?.nome || en.contact?.email || 'Sem nome',
          contactEmail: en.contact?.email || '—',
        };

        if (send) {
          return {
            ...baseRow,
            status: (send.status as any) || 'sent',
            sentAt: send.sent_at,
            openedAt: send.opened_at,
            clickedAt: send.clicked_at,
            errorMessage: send.error_message,
          };
        }

        // Not yet sent for this step
        // Skip if enrollment is no longer active and step hasn't fired
        if (en.status !== 'active' && en.status !== 'paused') {
          return null as any;
        }

        return {
          ...baseRow,
          status: 'pending' as const,
          scheduledAt: computeScheduledDate(en.enrolled_at, stepDayNumber, cadenceStartDate, cadenceSendAtTime),
        };
      }).filter(Boolean);

      // Sort: pending first by scheduledAt asc, then sent by sentAt desc
      result.sort((a, b) => {
        const ap = a.status === 'pending' || a.status === 'queued';
        const bp = b.status === 'pending' || b.status === 'queued';
        if (ap && !bp) return -1;
        if (!ap && bp) return 1;
        if (ap && bp) {
          return (a.scheduledAt || '').localeCompare(b.scheduledAt || '');
        }
        return (b.sentAt || '').localeCompare(a.sentAt || '');
      });

      setRows(result);
    } catch (err) {
      console.error('[StepRecipientsPanel] load error', err);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [cadenceId, stepId, stepDayNumber, cadenceStartDate, cadenceSendAtTime]);

  useEffect(() => { load(); }, [load]);

  const counts = rows.reduce((acc, r) => {
    const key = r.status === 'queued' ? 'pending' : r.status;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const filtered = statusFilter === 'all'
    ? rows
    : rows.filter(r => (statusFilter === 'pending' ? (r.status === 'pending' || r.status === 'queued') : r.status === statusFilter));

  return (
    <div className="space-y-3">
      {/* Header: counts + filter + refresh */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap text-xs">
          <Badge variant="outline" className="gap-1"><Users className="w-3 h-3" /> {rows.length} total</Badge>
          {counts.pending ? <Badge variant="outline" className={STATUS_META.pending.className}>{counts.pending} aguardando</Badge> : null}
          {counts.sent ? <Badge variant="outline" className={STATUS_META.sent.className}>{counts.sent} enviados</Badge> : null}
          {counts.delivered ? <Badge variant="outline" className={STATUS_META.delivered.className}>{counts.delivered} entregues</Badge> : null}
          {counts.opened ? <Badge variant="outline" className={STATUS_META.opened.className}>{counts.opened} abertos</Badge> : null}
          {counts.clicked ? <Badge variant="outline" className={STATUS_META.clicked.className}>{counts.clicked} clicados</Badge> : null}
          {counts.bounced ? <Badge variant="outline" className={STATUS_META.bounced.className}>{counts.bounced} bounce</Badge> : null}
          {counts.failed ? <Badge variant="outline" className={STATUS_META.failed.className}>{counts.failed} falhas</Badge> : null}
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[150px] h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os status</SelectItem>
              <SelectItem value="pending">Aguardando</SelectItem>
              <SelectItem value="sent">Enviado</SelectItem>
              <SelectItem value="delivered">Entregue</SelectItem>
              <SelectItem value="opened">Aberto</SelectItem>
              <SelectItem value="clicked">Clicado</SelectItem>
              <SelectItem value="bounced">Bounce</SelectItem>
              <SelectItem value="failed">Falhou</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </Button>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-6 text-xs text-muted-foreground border border-dashed border-border rounded-md">
          {rows.length === 0 ? 'Nenhum contato inscrito nesta cadência ainda.' : 'Nenhum contato com este filtro.'}
        </div>
      ) : (
        <div className="border border-border/50 rounded-md overflow-hidden max-h-[300px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 sticky top-0">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Contato</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium">Quando</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const meta = STATUS_META[r.status] || STATUS_META.pending;
                const Icon = meta.icon;
                const whenLabel =
                  r.status === 'pending' || r.status === 'queued'
                    ? `Previsto: ${formatDateTime(r.scheduledAt)}`
                    : r.clickedAt ? `Clicou: ${formatDateTime(r.clickedAt)}`
                    : r.openedAt ? `Abriu: ${formatDateTime(r.openedAt)}`
                    : r.sentAt ? `Enviado: ${formatDateTime(r.sentAt)}`
                    : '—';
                return (
                  <tr key={r.contactId} className="border-t border-border/30 hover:bg-muted/20">
                    <td className="px-3 py-2">
                      <div className="font-medium truncate max-w-[180px]">{r.contactName}</div>
                      <div className="text-[10px] text-muted-foreground truncate max-w-[180px]">{r.contactEmail}</div>
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className={`${meta.className} gap-1 text-[10px]`}>
                        <Icon className="w-2.5 h-2.5" />
                        {meta.label}
                      </Badge>
                      {r.errorMessage && (
                        <div className="text-[10px] text-destructive mt-0.5 truncate max-w-[200px]" title={r.errorMessage}>
                          {r.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{whenLabel}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}