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
    onSuccess: (data, status) => {
      queryClient.invalidateQueries({ queryKey: ['pending-status'] });
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
    onError: () => {
      toast.error('Erro ao registrar presença. Tente novamente.');
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
