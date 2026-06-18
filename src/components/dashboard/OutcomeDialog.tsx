/**
 * OutcomeDialog — modal shadcn/ui para registrar resultado da consulta (T-017)
 * So aparece apos attendance = 'compareceu'.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { marcarOutcome, type ResultadoConsulta } from '@/api/appointments';

interface OutcomeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointmentId: string;
  contactName: string;
  onDone?: () => void;
}

// BUG-3: valores enviados à API são os enums uppercase do BE.
// Labels visíveis ao usuário continuam em PT-BR.
const opcoes: Array<{
  outcome: ResultadoConsulta;
  label: string;
  className: string;
  ariaLabel: string;
  pedirValor: boolean;
}> = [
  {
    outcome: 'CLOSED',
    label: 'Fechou tratamento',
    className: 'bg-success text-success-foreground hover:bg-success/90',
    ariaLabel: 'Registrar que o paciente fechou o tratamento',
    pedirValor: true,
  },
  {
    outcome: 'CONSIDERING',
    label: 'Vai pensar',
    className: 'bg-warning text-warning-foreground hover:bg-warning/90',
    ariaLabel: 'Registrar que o paciente vai pensar',
    pedirValor: false,
  },
  {
    outcome: 'NOT_INTERESTED',
    label: 'Sem interesse',
    className: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
    ariaLabel: 'Registrar que o paciente nao tem interesse',
    pedirValor: false,
  },
  {
    outcome: 'RETURN_REQUESTED',
    label: 'Pediu retorno',
    className: 'bg-primary text-primary-foreground hover:bg-primary/90',
    ariaLabel: 'Registrar que o paciente pediu retorno',
    pedirValor: false,
  },
];

// BUG-4: BE espera { value: number } em BRL real (ex: 500.00), NAO centavos.
// O campo do input já é digitado em R$ pelo usuário (ex: "3500,00" → 3500.00).
// Prisma faz new Prisma.Decimal(body.value), portanto float BRL é o correto.
function parsearValorBRL(valor: string): number | undefined {
  if (!valor.trim()) return undefined;
  const numerico = parseFloat(valor.replace(',', '.'));
  if (isNaN(numerico) || numerico <= 0) return undefined;
  // Retorna diretamente em reais (ex: 3500.00), sem multiplicar por 100
  return numerico;
}

export function OutcomeDialog({
  open,
  onOpenChange,
  appointmentId,
  contactName,
  onDone,
}: OutcomeDialogProps) {
  const queryClient = useQueryClient();
  const [outcomeSelecionado, setOutcomeSelecionado] =
    useState<ResultadoConsulta | null>(null);
  const [valor, setValor] = useState('');
  const [notas, setNotas] = useState('');

  const opcaoSelecionada = opcoes.find((o) => o.outcome === outcomeSelecionado);

  const mutation = useMutation({
    mutationFn: () => {
      if (!outcomeSelecionado) throw new Error('Selecione um resultado');
      // BUG-4: value em BRL real, campo renomeado para refletir contrato do BE
      const value = parsearValorBRL(valor);
      return marcarOutcome(
        appointmentId,
        outcomeSelecionado,
        value,
        notas.trim() || undefined
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pending-status'] });
      queryClient.invalidateQueries({ queryKey: ['dinheiro-mesa'] });
      toast.success('Resultado da consulta registrado com sucesso.');
      // Reset de estado ANTES de fechar/chamar onDone para evitar no-op apos desmontagem
      setOutcomeSelecionado(null);
      setValor('');
      setNotas('');
      onOpenChange(false);
      onDone?.();
    },
    onError: () => {
      toast.error('Erro ao registrar resultado. Tente novamente.');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">
            Resultado da consulta — {contactName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-xs text-muted-foreground">
            Selecione o resultado da consulta:
          </p>

          {/* Botoes de outcome */}
          <div className="grid grid-cols-2 gap-2">
            {opcoes.map((opcao) => (
              <Button
                key={opcao.outcome}
                variant="outline"
                aria-label={opcao.ariaLabel}
                aria-pressed={outcomeSelecionado === opcao.outcome}
                className={
                  outcomeSelecionado === opcao.outcome
                    ? `${opcao.className} border-transparent`
                    : 'border-border'
                }
                onClick={() => {
                  setOutcomeSelecionado(opcao.outcome);
                  if (!opcao.pedirValor) setValor('');
                }}
              >
                {opcao.label}
              </Button>
            ))}
          </div>

          {/* Campo valor — so se CLOSED (fechou tratamento) */}
          {outcomeSelecionado === 'CLOSED' && (
            <div className="space-y-1">
              <Label htmlFor="outcome-valor" className="text-xs">
                Valor do tratamento (R$) — opcional
              </Label>
              <Input
                id="outcome-valor"
                type="number"
                min="0"
                step="0.01"
                placeholder="Ex: 3500,00"
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                className="text-sm"
              />
            </div>
          )}

          {/* Notas — sempre visivel apos selecao */}
          {outcomeSelecionado && (
            <div className="space-y-1">
              <Label htmlFor="outcome-notas" className="text-xs">
                Observacoes — opcional
              </Label>
              <Textarea
                id="outcome-notas"
                placeholder="Anotacoes sobre a consulta..."
                value={notas}
                onChange={(e) => setNotas(e.target.value)}
                className="text-sm resize-none"
                rows={3}
              />
            </div>
          )}

          <Button
            className="w-full"
            disabled={!outcomeSelecionado || mutation.isPending}
            aria-label="Confirmar resultado da consulta"
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Salvando...' : 'Confirmar resultado'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
