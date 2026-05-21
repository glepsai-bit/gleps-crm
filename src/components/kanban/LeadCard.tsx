import { useMemo } from 'react';
import { useFinance } from '@/contexts/FinanceContext';
import { Contact, Tag, SaleStatus } from '@/types/crm';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  GripVertical,
  Phone,
  Clock,
  DollarSign,
  AlertCircle,
  Check,
  RotateCcw,
  MessageSquare,
} from 'lucide-react';
import { safeFormatDateBR } from '@/utils/dateUtils';
import { cn } from '@/lib/utils';

interface KanbanLead extends Contact {
  stage_id: string | null;
  last_message?: string;
}

interface LeadCardProps {
  lead: KanbanLead;
  stage: Tag; // Tag de etapa (Chatwoot) = coluna do Kanban
  isDragging?: boolean;
  isNew?: boolean; // Indicates if this is a newly added lead
  onClick: () => void;
  onDragStart: () => void;
  onDragEnd?: () => void;
}

export function LeadCard({ lead, stage, isDragging, isNew, onClick, onDragStart, onDragEnd }: LeadCardProps) {
  const { getContactSales } = useFinance();

  const sales = useMemo(() => getContactSales(lead.id), [lead.id, getContactSales]);

  const saleIndicator = useMemo(() => {
    if (sales.length === 0) return null;

    const hasPaid = sales.some((s) => s.status === 'paid');
    const hasPending = sales.some((s) => s.status === 'pending');
    const hasRefunded = sales.some((s) => s.status === 'refunded');

    if (hasPaid) return { status: 'paid' as SaleStatus, label: 'Paga', color: 'bg-green-500' };
    if (hasPending) return { status: 'pending' as SaleStatus, label: 'Pendente', color: 'bg-yellow-500' };
    if (hasRefunded) return { status: 'refunded' as SaleStatus, label: 'Estornada', color: 'bg-red-500' };

    return null;
  }, [sales]);

  const getInitials = (name: string | null) => {
    if (!name) return '??';
    return name
      .split(' ')
      .map((n) => n[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  };

  const getOriginBadge = (origem: string | null) => {
    switch (origem) {
      case 'whatsapp':
        return <Badge variant="secondary" className="text-xs bg-green-500/10 text-green-500">WhatsApp</Badge>;
      case 'instagram':
        return <Badge variant="secondary" className="text-xs bg-pink-500/10 text-pink-500">Instagram</Badge>;
      case 'site':
        return <Badge variant="secondary" className="text-xs bg-blue-500/10 text-blue-500">Site</Badge>;
      default:
        return <Badge variant="secondary" className="text-xs">Manual</Badge>;
    }
  };

  const getSaleStatusIcon = (status: SaleStatus) => {
    switch (status) {
      case 'paid':
        return <Check className="w-3 h-3" />;
      case 'pending':
        return <AlertCircle className="w-3 h-3" />;
      case 'refunded':
        return <RotateCcw className="w-3 h-3" />;
    }
  };

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', lead.id);
        // Small delay to allow the drag image to be captured before opacity changes
        requestAnimationFrame(() => onDragStart());
      }}
      onDragEnd={() => {
        onDragEnd?.();
      }}
      onClick={onClick}
      className={cn(
        'kanban-card p-3 rounded-lg bg-card border border-border cursor-grab active:cursor-grabbing',
        'transition-[transform,opacity,box-shadow] duration-200 ease-out',
        'hover:shadow-md hover:border-primary/30 hover:-translate-y-0.5',
        isDragging && 'opacity-40 scale-[0.98] shadow-lg',
        isNew && 'kanban-card-new'
      )}
      style={{ borderLeftColor: stage.color, borderLeftWidth: 3 }}
    >
      <div className="flex items-start gap-2">
        <div className="flex-shrink-0 mt-1">
          <GripVertical className="w-4 h-4 text-muted-foreground/40" />
        </div>
        <Avatar className="h-7 w-7 flex-shrink-0">
          <AvatarFallback className="text-[10px] font-semibold bg-primary/10 text-primary">
            {getInitials(lead.nome)}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="flex items-start gap-1.5 flex-wrap">
            <span className="font-medium text-sm leading-snug break-words">{lead.nome || 'Sem nome'}</span>
            {saleIndicator && (
              <div
                className={cn(
                  'flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] font-medium text-white flex-shrink-0',
                  saleIndicator.color
                )}
                title={`Venda: ${saleIndicator.label}`}
              >
                {getSaleStatusIcon(saleIndicator.status)}
                <DollarSign className="w-2.5 h-2.5" />
              </div>
            )}
            {(lead.followup_count ?? 0) > 0 && (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] font-medium bg-amber-500 text-white flex-shrink-0">
                      <MessageSquare className="w-2.5 h-2.5" />
                      <span>{lead.followup_count}x</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    <p>Follow-up {lead.followup_count} • Último: {lead.last_followup_at ? safeFormatDateBR(lead.last_followup_at, 'dd/MM HH:mm') : '—'}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          {lead.telefone && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
              <Phone className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{lead.telefone}</span>
            </p>
          )}

          <div className="flex items-center justify-between mt-1.5 gap-2">
            {getOriginBadge(lead.origem)}
            <span className="text-[11px] text-muted-foreground flex items-center gap-1 flex-shrink-0">
              <Clock className="w-3 h-3" />
              {safeFormatDateBR(lead.updated_at, 'dd/MM')}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
