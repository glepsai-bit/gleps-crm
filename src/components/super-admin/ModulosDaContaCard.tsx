import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { accountsCloudOrBackend } from '@/services';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  MODULOS,
  MODULOS_ORDEM_CARD,
  moduloLigado,
  type ModuloChave,
} from '@/config/modulos.config';

interface ModulosDaContaCardProps {
  accountId: string;
  /** Módulos hoje ligados na conta. Ausente = todos (servidor sem o recurso). */
  modulos?: string[];
  onSalvo?: (modulos: string[]) => void;
}

/**
 * Liga/desliga os módulos opcionais de uma conta. O núcleo aparece só como
 * linha informativa: não dá pra desligar o que o agente precisa.
 */
export function ModulosDaContaCard({ accountId, modulos, onSalvo }: ModulosDaContaCardProps) {
  const inicial = () =>
    new Set<ModuloChave>(MODULOS_ORDEM_CARD.filter((m) => moduloLigado(modulos, m)));
  const [ligados, setLigados] = useState<Set<ModuloChave>>(inicial);
  const [salvando, setSalvando] = useState(false);

  // Se a conta recarregar com outra lista (ex.: depois de salvar), o card acompanha.
  useEffect(() => {
    setLigados(inicial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modulos?.join('|') ?? null]);

  const alterado =
    MODULOS_ORDEM_CARD.some((m) => ligados.has(m) !== moduloLigado(modulos, m));

  const alternar = (m: ModuloChave, valor: boolean) => {
    setLigados((atual) => {
      const novo = new Set(atual);
      if (valor) novo.add(m);
      else novo.delete(m);
      return novo;
    });
  };

  const salvar = async () => {
    // Na ordem do card, sem repetição: o backend recusa chave repetida.
    const lista = MODULOS_ORDEM_CARD.filter((m) => ligados.has(m));
    setSalvando(true);
    try {
      await accountsCloudOrBackend.update(accountId, { modulos: lista });
      toast.success('Módulos salvos');
      onSalvo?.(lista);
    } catch (e) {
      const msg = e instanceof Error ? e.message : (e as { message?: string })?.message;
      toast.error('Erro ao salvar módulos: ' + (msg || 'Erro desconhecido'));
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Card className="card-gradient border-border/50" data-testid="card-modulos">
      <CardHeader>
        <CardTitle className="text-lg">Módulos da conta</CardTitle>
        <p className="text-sm text-muted-foreground">
          O que esta conta vê no menu. Desligado, a rota responde 403 no servidor e some da tela.
          Dados não são apagados.
        </p>
      </CardHeader>
      <CardContent className="space-y-1">
        <div className="flex items-center gap-3 py-3 border-b border-border/50">
          <span className="font-medium min-w-[120px]">Atendimento</span>
          <span className="text-sm text-muted-foreground flex-1">
            Chat, Dashboard, Kanban, Leads, Agenda, Atendimento IA, Tracking Ads, Configurações
          </span>
          <Badge variant="secondary">núcleo · sempre ligado</Badge>
        </div>
        {MODULOS_ORDEM_CARD.map((m) => {
          const info = MODULOS[m];
          const on = ligados.has(m);
          return (
            <div key={m} className="flex items-center gap-3 py-3 border-b border-border/50 last:border-0">
              <span className="font-medium min-w-[120px]">{info.rotulo}</span>
              <span className="text-sm text-muted-foreground flex-1">{info.descricao}</span>
              <Badge variant={on ? 'default' : 'outline'}>{on ? 'ligado' : 'desligado'}</Badge>
              <Switch
                checked={on}
                onCheckedChange={(v) => alternar(m, v)}
                aria-label={`Módulo ${info.rotulo}`}
              />
            </div>
          );
        })}
        <div className="flex justify-end pt-3">
          <Button onClick={salvar} disabled={!alterado || salvando}>
            {salvando && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Salvar módulos
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
