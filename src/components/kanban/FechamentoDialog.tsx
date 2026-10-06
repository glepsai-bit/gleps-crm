import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import type { Product } from '@/types/crm';
import { lerValorEmReais } from '@/utils/valorEmReais';

/** Radix Select não aceita item com valor vazio. */
const SEM_SERVICO = '__sem_servico__';

interface FechamentoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Nome do lead, só para o texto de apoio. */
  nomeDoLead?: string | null;
  /** Serviços/produtos ativos oferecidos como atalho de valor. */
  servicos: Product[];
  /** "Registrar": deve lançar erro se falhar (o diálogo continua aberto). */
  onRegistrar: (dados: { valor: number; productId?: string }) => Promise<void>;
  /** "Fechou sem valor": a venda fica pendente; nada é enviado. */
  onSemValor: () => void;
}

export function FechamentoDialog({
  open,
  onOpenChange,
  nomeDoLead,
  servicos,
  onRegistrar,
  onSemValor,
}: FechamentoDialogProps) {
  const [valor, setValor] = useState('');
  const [servicoId, setServicoId] = useState(SEM_SERVICO);
  const [salvando, setSalvando] = useState(false);

  // Cada abertura começa limpa — o mesmo diálogo serve a leads diferentes.
  useEffect(() => {
    if (open) {
      setValor('');
      setServicoId(SEM_SERVICO);
      setSalvando(false);
    }
  }, [open]);

  const valorNumerico = lerValorEmReais(valor);
  const podeRegistrar = valorNumerico != null && valorNumerico > 0 && !salvando;

  const escolherServico = (id: string) => {
    setServicoId(id);
    if (id === SEM_SERVICO) return;
    // Só sugere o preço se o usuário ainda não digitou nada.
    const servico = servicos.find((s) => s.id === id);
    if (servico && !valor.trim() && servico.valor_padrao > 0) {
      setValor(String(servico.valor_padrao).replace('.', ','));
    }
  };

  const registrar = async () => {
    if (valorNumerico == null || valorNumerico <= 0) return;
    setSalvando(true);
    try {
      await onRegistrar({
        valor: valorNumerico,
        ...(servicoId !== SEM_SERVICO ? { productId: servicoId } : {}),
      });
    } catch {
      // quem chamou já avisou o erro; mantém o diálogo aberto pra tentar de novo
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Quanto fechou?</DialogTitle>
          <DialogDescription>
            {nomeDoLead ? `${nomeDoLead} entrou em Fechado.` : 'O lead entrou em Fechado.'} Informe o
            valor para a receita entrar no Dashboard.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void registrar();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="fechamento-valor">Valor (R$)</Label>
            <Input
              id="fechamento-valor"
              inputMode="decimal"
              placeholder="0,00"
              autoFocus
              value={valor}
              onChange={(e) => setValor(e.target.value)}
            />
          </div>

          {servicos.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="fechamento-servico">Serviço (opcional)</Label>
              <Select value={servicoId} onValueChange={escolherServico}>
                <SelectTrigger id="fechamento-servico" aria-label="Serviço">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SEM_SERVICO}>Nenhum</SelectItem>
                  {servicos.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={salvando}
              onClick={onSemValor}
            >
              Fechou sem valor
            </Button>
            <Button type="submit" disabled={!podeRegistrar}>
              {salvando && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Registrar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
