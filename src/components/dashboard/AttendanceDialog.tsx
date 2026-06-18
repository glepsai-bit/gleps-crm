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

const opcoes: Array<{
  status: StatusPresenca;
  label: string;
  className: string;
  ariaLabel: string;
}> = [
  {
    status: 'compareceu',
    label: 'Compareceu',
    className: 'bg-success text-success-foreground hover:bg-success/90',
    ariaLabel: 'Marcar paciente como compareceu',
  },
  {
    status: 'falto',
    label: 'Faltou',
    className: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
    ariaLabel: 'Marcar paciente como faltou',
  },
  {
    status: 'reagendou',
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
        (old: { total: number; items: { id: string }[] } | undefined) => {
          if (!old) return old;
          const items = old.items.filter((p) => p.id !== appointmentId);
          return { ...old, items, total: Math.max(0, old.total - 1) };
        }
      );
      return { previous };
    },
    onSuccess: (_data, status) => {
      if (status === 'compareceu') {
        onCompareceu();
      } else {
        toast.success(
          status === 'falto'
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
