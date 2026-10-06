/**
 * Serviços da Agenda — o que o agente pode marcar.
 *
 * Um serviço é um produto com duração. O produto continua sendo o mesmo
 * registro de `/api/products` (por isso o fechamento do Kanban também o
 * oferece), só que aqui o admin cria/renomeia/desativa sem passar pela antiga
 * tela de Produtos, que agora redireciona pra cá.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, Plus } from 'lucide-react';
import { agendaBackendService, type ServicoDaAgenda } from '@/services/agenda.backend.service';
import { productsService } from '@/services/products.service';
import { lerValorEmReais } from '@/utils/valorEmReais';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const DURACAO_MIN = 5;
const DURACAO_MAX = 600;

/** Valida a duração digitada. Devolve o número, ou uma mensagem de erro. */
function lerDuracao(bruto: string): { valor: number } | { erro: string } {
  const numero = Number(bruto.trim().replace(',', '.'));
  if (!Number.isFinite(numero) || numero < DURACAO_MIN || numero > DURACAO_MAX) {
    return { erro: `A duração precisa estar entre ${DURACAO_MIN} e ${DURACAO_MAX} minutos` };
  }
  return { valor: Math.round(numero) };
}

function formatarValor(v: number | null | undefined): string {
  return v == null ? '' : String(v).replace('.', ',');
}

function LinhaServico({ servico }: { servico: ServicoDaAgenda }) {
  const qc = useQueryClient();
  const [nome, setNome] = useState(servico.nome);
  const [duracao, setDuracao] = useState(
    servico.duracaoMinutos != null ? String(servico.duracaoMinutos) : ''
  );
  const [valor, setValor] = useState(formatarValor(servico.valorPadrao));

  const recarregar = () => qc.invalidateQueries({ queryKey: ['agenda', 'configuracao'] });
  const falhou = (e: Error) => toast.error(e.message || 'Não foi possível salvar');

  const salvarDuracao = useMutation({
    mutationFn: (v: number | null) => agendaBackendService.atualizarServico(servico.id, v),
    onSuccess: (atualizado) => {
      setDuracao(atualizado.duracaoMinutos != null ? String(atualizado.duracaoMinutos) : '');
      recarregar();
    },
    onError: falhou,
  });

  const salvarProduto = useMutation({
    mutationFn: (dados: { nome?: string; valorPadrao?: number; ativo?: boolean }) =>
      productsService.update(servico.id, dados),
    onSuccess: recarregar,
    onError: falhou,
  });

  const aplicarDuracao = () => {
    const bruto = duracao.trim();
    if (!bruto) {
      // Sem duração o produto deixa de ser agendável ("só venda").
      salvarDuracao.mutate(null);
      return;
    }
    const lida = lerDuracao(bruto);
    if ('erro' in lida) {
      toast.error(lida.erro);
      return;
    }
    salvarDuracao.mutate(lida.valor);
  };

  const aplicarNome = () => {
    const limpo = nome.trim();
    if (limpo.length < 2) {
      toast.error('O nome precisa ter pelo menos 2 letras');
      setNome(servico.nome);
      return;
    }
    if (limpo !== servico.nome) salvarProduto.mutate({ nome: limpo });
  };

  const aplicarValor = () => {
    if (!valor.trim()) return;
    const lido = lerValorEmReais(valor);
    if (lido == null || lido < 0) {
      toast.error('Valor inválido');
      return;
    }
    if (lido !== servico.valorPadrao) salvarProduto.mutate({ valorPadrao: lido });
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
      <Input
        className="h-8 min-w-[10rem] flex-1 text-sm font-medium"
        aria-label={`Nome do serviço ${servico.nome}`}
        value={nome}
        onChange={(e) => setNome(e.target.value)}
        onBlur={aplicarNome}
      />
      <Input
        type="number"
        min={DURACAO_MIN}
        max={DURACAO_MAX}
        className="h-8 w-24"
        placeholder="min"
        aria-label={`Duração de ${servico.nome}`}
        value={duracao}
        onChange={(e) => setDuracao(e.target.value)}
        onBlur={aplicarDuracao}
      />
      <Input
        inputMode="decimal"
        className="h-8 w-28"
        placeholder="R$ padrão"
        aria-label={`Valor padrão de ${servico.nome}`}
        value={valor}
        onChange={(e) => setValor(e.target.value)}
        onBlur={aplicarValor}
      />
      <Button
        size="sm"
        variant="outline"
        onClick={aplicarDuracao}
        disabled={salvarDuracao.isPending}
      >
        {salvarDuracao.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Salvar'}
      </Button>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          checked={servico.ativo}
          onCheckedChange={(ativo) => salvarProduto.mutate({ ativo })}
          aria-label={`${servico.ativo ? 'Desativar' : 'Ativar'} ${servico.nome}`}
        />
        {servico.ativo ? 'Ativo' : 'Desativado'}
      </label>
    </div>
  );
}

function NovoServico({ onFechar }: { onFechar: () => void }) {
  const qc = useQueryClient();
  const [nome, setNome] = useState('');
  const [duracao, setDuracao] = useState('30');
  const [valor, setValor] = useState('');

  const criar = useMutation({
    mutationFn: (dados: { nome: string; duracaoMinutos: number; valorPadrao: number }) =>
      productsService.create(dados),
    onSuccess: () => {
      toast.success('Serviço criado');
      qc.invalidateQueries({ queryKey: ['agenda', 'configuracao'] });
      onFechar();
    },
    onError: (e: Error) => toast.error(e.message || 'Não foi possível criar o serviço'),
  });

  const enviar = (e: React.FormEvent) => {
    e.preventDefault();
    if (nome.trim().length < 2) {
      toast.error('Dê um nome ao serviço');
      return;
    }
    const d = lerDuracao(duracao);
    if ('erro' in d) {
      toast.error(d.erro);
      return;
    }
    // Preço é opcional: serviço sem preço fixo vale 0 (o valor real entra no fechamento).
    const v = valor.trim() ? lerValorEmReais(valor) : 0;
    if (v == null || v < 0) {
      toast.error('Valor inválido');
      return;
    }
    criar.mutate({ nome: nome.trim(), duracaoMinutos: d.valor, valorPadrao: v });
  };

  return (
    <form onSubmit={enviar} className="grid gap-3 rounded-md border border-dashed p-3 sm:grid-cols-[1fr_7rem_9rem_auto]">
      <div className="space-y-1.5">
        <Label htmlFor="novo-servico-nome">Nome</Label>
        <Input
          id="novo-servico-nome"
          placeholder="Ex.: Consulta de avaliação"
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          autoFocus
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="novo-servico-duracao">Duração (min)</Label>
        <Input
          id="novo-servico-duracao"
          type="number"
          min={DURACAO_MIN}
          max={DURACAO_MAX}
          value={duracao}
          onChange={(e) => setDuracao(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="novo-servico-valor">Valor (opcional)</Label>
        <Input
          id="novo-servico-valor"
          inputMode="decimal"
          placeholder="0,00"
          value={valor}
          onChange={(e) => setValor(e.target.value)}
        />
      </div>
      <div className="flex items-end gap-2">
        <Button type="submit" disabled={criar.isPending}>
          {criar.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Criar serviço
        </Button>
        <Button type="button" variant="ghost" onClick={onFechar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

export function SecaoServicos({ servicos }: { servicos: ServicoDaAgenda[] }) {
  const [criando, setCriando] = useState(false);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Serviços</CardTitle>
        {!criando && (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setCriando(true)}>
            <Plus className="w-4 h-4" />
            Novo serviço
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Serviços com duração são os que o agente pode marcar. Sem duração, é só venda.
        </p>
        {criando && <NovoServico onFechar={() => setCriando(false)} />}
        {servicos.length === 0 && !criando ? (
          <p className="text-sm text-muted-foreground">Nenhum serviço cadastrado ainda.</p>
        ) : (
          <div className="space-y-2">
            {servicos.map((s) => (
              <LinhaServico key={s.id} servico={s} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
