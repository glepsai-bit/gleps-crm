/**
 * PendenciasHoje — badge no header com dropdown de agendamentos pendentes (T-017)
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bell, Clock } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { listarPendentes, type AgendamentoPendente } from '@/api/appointments';
import { AttendanceDialog } from './AttendanceDialog';
import { OutcomeDialog } from './OutcomeDialog';

interface EstadoDialog {
  tipo: 'attendance' | 'outcome' | null;
  agendamento: AgendamentoPendente | null;
}

export function PendenciasHoje() {
  const [popoverAberto, setPopoverAberto] = useState(false);
  const [estado, setEstado] = useState<EstadoDialog>({
    tipo: null,
    agendamento: null,
  });
  const [outcomeAberto, setOutcomeAberto] = useState(false);

  const hoje = format(new Date(), 'yyyy-MM-dd');

  const { data, isLoading } = useQuery({
    queryKey: ['pending-status', hoje],
    queryFn: () => listarPendentes(hoje, 20),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const total = data?.total ?? 0;
  const itens = data?.items ?? [];

  function abrirAttendance(ag: AgendamentoPendente) {
    setEstado({ tipo: 'attendance', agendamento: ag });
    setPopoverAberto(false);
  }

  function abrirOutcome(ag: AgendamentoPendente) {
    setEstado({ tipo: 'outcome', agendamento: ag });
    setOutcomeAberto(true);
    setPopoverAberto(false);
  }

  function aoClicarItem(ag: AgendamentoPendente) {
    if (ag.needs === 'attendance') {
      abrirAttendance(ag);
    } else {
      abrirOutcome(ag);
    }
  }

  function formatarHora(iso: string) {
    try {
      return format(parseISO(iso), 'HH:mm', { locale: ptBR });
    } catch {
      return '--:--';
    }
  }

  return (
    <>
      <Popover open={popoverAberto} onOpenChange={setPopoverAberto}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            aria-label={
              total > 0
                ? `${total} agendamento(s) pendente(s) de confirmacao`
                : 'Sem pendencias de agendamento'
            }
          >
            <Bell className="w-5 h-5 text-muted-foreground" />
            {total > 0 && (
              <Badge
                className="absolute -top-1 -right-1 h-4 min-w-[16px] px-1 text-[10px] font-bold bg-destructive text-destructive-foreground border-0"
                aria-hidden="true"
              >
                {total > 99 ? '99+' : total}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>

        <PopoverContent
          align="end"
          className="w-80 p-0"
          aria-label="Pendencias de agendamento"
        >
          <div className="px-4 py-3 border-b border-border">
            <p className="text-sm font-semibold text-foreground">
              Pendencias de hoje
            </p>
            <p className="text-xs text-muted-foreground">
              {isLoading
                ? 'Carregando...'
                : total === 0
                ? 'Nenhuma pendencia no momento.'
                : `${total} agendamento(s) aguardando confirmacao`}
            </p>
          </div>

          {itens.length > 0 && (
            <ScrollArea className="max-h-72">
              <div className="divide-y divide-border">
                {itens.map((ag) => (
                  <div
                    key={ag.id}
                    className="px-4 py-3 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate">
                          {ag.contactName}
                        </p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <Clock className="w-3 h-3 shrink-0" />
                          {formatarHora(ag.startTime)} – {formatarHora(ag.endTime)}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className="text-[10px] shrink-0"
                      >
                        {ag.needs === 'attendance' ? 'Presenca' : 'Resultado'}
                      </Badge>
                    </div>

                    {ag.needs === 'attendance' ? (
                      <AttendanceDialog
                        appointmentId={ag.id}
                        contactName={ag.contactName}
                        onCompareceu={() => {
                          setEstado({ tipo: 'outcome', agendamento: ag });
                          setOutcomeAberto(true);
                        }}
                        onDone={() => setPopoverAberto(false)}
                      />
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full text-xs"
                        aria-label={`Registrar resultado da consulta de ${ag.contactName}`}
                        onClick={() => aoClicarItem(ag)}
                      >
                        Registrar resultado
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}

          {!isLoading && itens.length === 0 && (
            <div
              role="status"
              className="px-4 py-6 text-center text-xs text-muted-foreground"
            >
              Nenhuma pendencia no momento.
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* Modal de outcome quando abre fora do popover */}
      {estado.agendamento && (
        <OutcomeDialog
          open={outcomeAberto}
          onOpenChange={(v) => {
            setOutcomeAberto(v);
            if (!v) setEstado({ tipo: null, agendamento: null });
          }}
          appointmentId={estado.agendamento.id}
          contactName={estado.agendamento.contactName}
          onDone={() => setEstado({ tipo: null, agendamento: null })}
        />
      )}
    </>
  );
}
