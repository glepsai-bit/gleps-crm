/**
 * AttendanceDialog — botoes inline para marcar presenca de agendamento (T-017)
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { marcarPresenca, type StatusPresenca } from '@/api/appointments';

interface AttendanceDialogProps {
  appointmentId: string;
  contactName: string;
  onCompareceu: () => void;
  onDone?: () => void;
}

// BUG-2: valores enviados à API são os enums uppercase do BE (ATTENDED/NO_SHOW/RESCHEDULED).
// Labels visíveis ao usuário continuam em PT-BR.
const opcoes: Array<{
  status: StatusPresenca;
  label: string;
  className: string;
  ariaLabel: string;
}> = [
  {
    status: 'ATTENDED',
    label: 'Compareceu',
    className: 'bg-success text-success-foreground hover:bg-success/90',
    ariaLabel: 'Marcar paciente como compareceu',
  },
  {
    status: 'NO_SHOW',
    label: 'Faltou',
    className: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
    ariaLabel: 'Marcar paciente como faltou',
  },
  {
    status: 'RESCHEDULED',
    label: 'Reagendou',
    className: 'bg-warning text-warning-foreground hover:bg-warning/90',
    ariaLabel: 'Marcar paciente como reagendou',
  },
];

export function AttendanceDialog({
  appointmentId,
  contactName,
  onCompareceu,
  onDone,
}: AttendanceDialogProps) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (status: StatusPresenca) => marcarPresenca(appointmentId, status),
    onMutate: async () => {
      // Optimistic update: remove o item da lista antes da resposta
      await queryClient.cancelQueries({ queryKey: ['pending-status'] });
      const previous = queryClient.getQueryData(['pending-status']);
      queryClient.setQueryData(
        ['pending-status'],
        // BUG-5: estrutura do cache agora usa pendingAttendance, nao items
        (old: { total: number; pendingAttendance: { id: string }[]; pendingOutcome: { id: string }[] } | undefined) => {
          if (!old) return old;
          const pendingAttendance = old.pendingAttendance.filter((p) => p.id !== appointmentId);
          return { ...old, pendingAttendance, total: Math.max(0, old.total - 1) };
        }
      );
      return { previous };
    },
    onSuccess: (_data, status) => {
      // BUG-2: comparacoes contra enums uppercase do BE
      if (status === 'ATTENDED') {
        onCompareceu();
      } else {
        toast.success(
          status === 'NO_SHOW'
            ? 'Falta registrada com sucesso.'
            : 'Reagendamento registrado com sucesso.'
        );
        onDone?.();
      }
    },
    onError: (_err, _status, ctx) => {
      // Reverte o optimistic update
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(['pending-status'], ctx.previous);
      }
      toast.error('Erro ao registrar presença. Tente novamente.');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['pending-status'] });
    },
  });

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-foreground">
        {contactName}
      </p>
      <p className="text-xs text-muted-foreground">
        Selecione o status de comparecimento:
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        {opcoes.map((opcao) => (
          <Button
            key={opcao.status}
            className={`flex-1 text-sm font-semibold ${opcao.className}`}
            aria-label={opcao.ariaLabel}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(opcao.status)}
          >
            {opcao.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
