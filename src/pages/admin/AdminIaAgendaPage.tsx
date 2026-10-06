/**
 * AdminIaAgendaPage — Regras que o agente segue pra marcar horário.
 *
 * A agenda em si é uma HABILIDADE do agente (seção "Agenda" em
 * `PainelAgente.tsx`), não uma tela de configuração cheia de passos. Esta
 * página é só o material bruto que essa seção consome: quem atende, em quais
 * dias/horas, com qual intervalo, e quais produtos têm duração — ou seja,
 * viraram "serviço".
 *
 * Serviço: src/services/agenda.backend.service.ts
 * Entrada: botão "Agenda" no cabeçalho de AdminIaFluxosPage.tsx
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, Loader2, RefreshCw, Search, X } from 'lucide-react';
import {
  agendaBackendService,
  DIAS_DA_SEMANA,
  DIAS_UTEIS,
  type ConfiguracaoDaAgenda,
  type FaixaDeHorario,
  type HorariosDaSemana,
  type HorariosDisponiveisResponse,
  type ProfissionalDaAgenda,
  type ServicoDaAgenda,
} from '@/services/agenda.backend.service';
import { SecaoServicos } from '@/components/agenda/SecaoServicos';
import { calendarBackendService } from '@/services/calendar.backend.service';
import { useAuth } from '@/contexts/AuthContext';
import { useEtapasDoFunil } from '@/components/flow/CamposDoNo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Valor do Select que significa "não aplicar etapa nenhuma" — Radix não aceita item vazio. */
const NAO_MEXER_NA_ETAPA = '__nao_mexer__';

function faixaPadrao(): FaixaDeHorario {
  return { inicio: '09:00', fim: '18:00' };
}

// ============================================
// Editor de horários por dia da semana
// ============================================

function EditorDeHorarios({
  horarios,
  onChange,
}: {
  horarios: HorariosDaSemana;
  onChange: (h: HorariosDaSemana) => void;
}) {
  const ligarDia = (dia: string, ligado: boolean) => {
    const novo = { ...horarios };
    if (ligado) novo[dia] = [faixaPadrao()];
    else delete novo[dia];
    onChange(novo);
  };

  const mudarFaixa = (dia: string, indice: number, campo: keyof FaixaDeHorario, valor: string) => {
    const faixas = (horarios[dia] ?? []).map((f, i) => (i === indice ? { ...f, [campo]: valor } : f));
    onChange({ ...horarios, [dia]: faixas });
  };

  const adicionarFaixa = (dia: string) => {
    const faixas = horarios[dia] ?? [];
    if (faixas.length >= 2) return;
    onChange({ ...horarios, [dia]: [...faixas, faixaPadrao()] });
  };

  const removerFaixa = (dia: string, indice: number) => {
    onChange({ ...horarios, [dia]: (horarios[dia] ?? []).filter((_, i) => i !== indice) });
  };

  const copiarParaDiasUteis = () => {
    const base = horarios['1'] ?? [faixaPadrao()];
    const novo = { ...horarios };
    for (const dia of DIAS_UTEIS) novo[dia] = base.map((f) => ({ ...f }));
    onChange(novo);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">Horários de atendimento</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-[11px]"
          onClick={copiarParaDiasUteis}
        >
          Copiar para os dias úteis
        </Button>
      </div>
      {DIAS_DA_SEMANA.map(({ dia, rotulo }) => {
        const faixas = horarios[dia] ?? [];
        const ligado = faixas.length > 0;
        return (
          <div key={dia} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
            <label className="flex w-32 shrink-0 items-center gap-2">
              <Switch checked={ligado} onCheckedChange={(v) => ligarDia(dia, v)} aria-label={rotulo} />
              <span className="text-xs">{rotulo}</span>
            </label>
            {ligado ? (
              <div className="flex flex-1 flex-wrap items-center gap-2">
                {faixas.map((f, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <Input
                      type="time"
                      className="h-8 w-[110px]"
                      aria-label={`${rotulo} — início ${i + 1}`}
                      value={f.inicio}
                      onChange={(e) => mudarFaixa(dia, i, 'inicio', e.target.value)}
                    />
                    <span className="text-xs text-muted-foreground">às</span>
                    <Input
                      type="time"
                      className="h-8 w-[110px]"
                      aria-label={`${rotulo} — fim ${i + 1}`}
                      value={f.fim}
                      onChange={(e) => mudarFaixa(dia, i, 'fim', e.target.value)}
                    />
                    {faixas.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        aria-label={`Remover faixa ${i + 1} de ${rotulo}`}
                        onClick={() => removerFaixa(dia, i)}
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
                {faixas.length < 2 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={() => adicionarFaixa(dia)}
                  >
                    + horário
                  </Button>
                )}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">Não atende</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================================
// Profissionais
// ============================================

function CardProfissional({
  profissional,
  meuUserId,
}: {
  profissional: ProfissionalDaAgenda;
  meuUserId: string | undefined;
}) {
  const qc = useQueryClient();
  const [ativo, setAtivo] = useState(profissional.ativo);
  const [intervalo, setIntervalo] = useState(String(profissional.intervaloMinutos));
  const [horarios, setHorarios] = useState<HorariosDaSemana>(profissional.horarios);

  const salvar = useMutation({
    mutationFn: () =>
      agendaBackendService.atualizarProfissional(profissional.userId, {
        ativo,
        intervaloMinutos: Number(intervalo) || profissional.intervaloMinutos,
        horarios,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agenda', 'configuracao'] });
      toast.success(`Agenda de ${profissional.nome} salva`);
    },
    onError: (e: Error) => toast.error(e.message || 'Não foi possível salvar'),
  });

  const reconectar = useMutation({
    mutationFn: () => calendarBackendService.connectGoogle(),
    onSuccess: ({ authUrl }) => {
      window.location.href = authUrl;
    },
    onError: (e: Error) => toast.error(e.message || 'Não foi possível iniciar a reconexão'),
  });

  const souEu = !!meuUserId && meuUserId === profissional.userId;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base">{profissional.nome}</CardTitle>
            <p className="text-xs text-muted-foreground truncate">{profissional.email}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {profissional.google.precisaReconectar ? (
              <Badge
                variant="outline"
                className="border-amber-500/60 text-amber-600 dark:text-amber-400"
              >
                precisa reconectar
              </Badge>
            ) : profissional.google.conectado ? (
              <Badge variant="outline">
                Google conectado{profissional.google.email ? ` · ${profissional.google.email}` : ''}
              </Badge>
            ) : (
              <Badge variant="outline">agenda do CRM</Badge>
            )}
            {profissional.google.precisaReconectar &&
              (souEu ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => reconectar.mutate()}
                  disabled={reconectar.isPending}
                >
                  {reconectar.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  Reconectar
                </Button>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  peça para {profissional.nome} reconectar em Agenda
                </span>
              ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <Switch
            checked={ativo}
            onCheckedChange={setAtivo}
            aria-label={`${profissional.nome} atende com hora marcada`}
          />
          <span className="text-sm">Atende com hora marcada</span>
        </label>

        {ativo && (
          <>
            <div className="max-w-[220px] space-y-1.5">
              <Label htmlFor={`intervalo-${profissional.userId}`} className="text-xs">
                Intervalo entre atendimentos (min)
              </Label>
              <Input
                id={`intervalo-${profissional.userId}`}
                type="number"
                min={0}
                className="h-8"
                value={intervalo}
                onChange={(e) => setIntervalo(e.target.value)}
              />
            </div>
            <EditorDeHorarios horarios={horarios} onChange={setHorarios} />
          </>
        )}

        <Button onClick={() => salvar.mutate()} disabled={salvar.isPending}>
          {salvar.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Salvar
        </Button>
      </CardContent>
    </Card>
  );
}

function SecaoProfissionais({ profissionais }: { profissionais: ProfissionalDaAgenda[] }) {
  const { user } = useAuth();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Profissionais</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {profissionais.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum usuário ativo nesta conta.</p>
        ) : (
          profissionais.map((p) => (
            <CardProfissional key={p.userId} profissional={p} meuUserId={user?.id} />
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ============================================
// Regras da conta
// ============================================

function SecaoRegrasDaConta({ configuracao }: { configuracao: ConfiguracaoDaAgenda }) {
  const qc = useQueryClient();
  const etapasQuery = useEtapasDoFunil();
  const [antecedencia, setAntecedencia] = useState(String(configuracao.antecedenciaMinimaMinutos));
  const [janela, setJanela] = useState(String(configuracao.janelaMaximaDias));
  const [passo, setPasso] = useState(String(configuracao.passoMinutos));
  const [hold, setHold] = useState(String(configuracao.holdMinutos));
  const [etapa, setEtapa] = useState(configuracao.etapaAoAgendar ?? NAO_MEXER_NA_ETAPA);

  const salvar = useMutation({
    mutationFn: () =>
      agendaBackendService.atualizarConfiguracao({
        antecedenciaMinimaMinutos: Number(antecedencia),
        janelaMaximaDias: Number(janela),
        passoMinutos: Number(passo),
        holdMinutos: Number(hold),
        etapaAoAgendar: etapa === NAO_MEXER_NA_ETAPA ? null : etapa,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agenda', 'configuracao'] });
      toast.success('Regras da conta salvas');
    },
    onError: (e: Error) => toast.error(e.message || 'Não foi possível salvar'),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Regras da conta</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="ag-antecedencia">Antecedência mínima (min)</Label>
            <Input
              id="ag-antecedencia"
              type="number"
              min={0}
              value={antecedencia}
              onChange={(e) => setAntecedencia(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ag-janela">Janela máxima (dias)</Label>
            <Input
              id="ag-janela"
              type="number"
              min={1}
              value={janela}
              onChange={(e) => setJanela(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ag-passo">Passo (min)</Label>
            <Input
              id="ag-passo"
              type="number"
              min={5}
              value={passo}
              onChange={(e) => setPasso(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ag-hold">Reserva (min)</Label>
            <Input
              id="ag-hold"
              type="number"
              min={1}
              value={hold}
              onChange={(e) => setHold(e.target.value)}
            />
          </div>
        </div>
        <div className="max-w-xs space-y-1.5">
          <Label htmlFor="ag-etapa">Etapa ao agendar</Label>
          <Select value={etapa} onValueChange={setEtapa}>
            <SelectTrigger id="ag-etapa" aria-label="Etapa ao agendar">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NAO_MEXER_NA_ETAPA}>Não mexer na etapa</SelectItem>
              {(etapasQuery.data ?? []).map((e) => (
                <SelectItem key={e.id} value={e.slug}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => salvar.mutate()} disabled={salvar.isPending}>
          {salvar.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Salvar
        </Button>
      </CardContent>
    </Card>
  );
}

// ============================================
// Testar
// ============================================

function SecaoTestar({
  profissionais,
  servicos,
}: {
  profissionais: ProfissionalDaAgenda[];
  servicos: ServicoDaAgenda[];
}) {
  const [profissionalId, setProfissionalId] = useState('');
  const [produtoId, setProdutoId] = useState('');
  const [resultado, setResultado] = useState<HorariosDisponiveisResponse | null>(null);

  const elegiveis = profissionais.filter((p) => p.ativo);

  const testar = useMutation({
    mutationFn: () => agendaBackendService.getHorarios({ profissionalId, produtoId, dias: 7 }),
    onSuccess: (r) => setResultado(r),
    onError: (e: Error) => toast.error(e.message || 'Não consegui consultar os horários'),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Testar</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="teste-profissional">Profissional</Label>
            <Select value={profissionalId} onValueChange={setProfissionalId}>
              <SelectTrigger id="teste-profissional" aria-label="Profissional">
                <SelectValue placeholder="Escolha" />
              </SelectTrigger>
              <SelectContent>
                {elegiveis.map((p) => (
                  <SelectItem key={p.userId} value={p.userId}>
                    {p.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="teste-servico">Serviço</Label>
            <Select value={produtoId} onValueChange={setProdutoId}>
              <SelectTrigger id="teste-servico" aria-label="Serviço">
                <SelectValue placeholder="Escolha" />
              </SelectTrigger>
              <SelectContent>
                {servicos.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={() => testar.mutate()}
            disabled={!profissionalId || !produtoId || testar.isPending}
          >
            {testar.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Search className="w-4 h-4 mr-2" />
            )}
            Ver horários
          </Button>
        </div>

        {resultado && (
          <div className="space-y-2">
            {resultado.aviso && (
              <p className="text-xs text-amber-600 dark:text-amber-500">{resultado.aviso}</p>
            )}
            {resultado.horarios.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum horário livre nos próximos dias.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {resultado.horarios.map((h) => (
                  <Badge key={h.id} variant="outline">
                    {h.rotulo}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================
// Página
// ============================================

export default function AdminIaAgendaPage() {
  const agendaQuery = useQuery({
    queryKey: ['agenda', 'configuracao'],
    queryFn: agendaBackendService.getConfiguracao,
  });

  return (
    <div className="max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <CalendarClock className="w-6 h-6" /> Agenda
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Regras que o agente segue pra marcar horário. O evento é criado no Google Calendar de
          quem atende; quem não conectou usa a agenda do CRM.
        </p>
      </div>

      {agendaQuery.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : agendaQuery.isError ? (
        <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
          Não consegui carregar a agenda. Recarregue a página para tentar de novo.
        </p>
      ) : (
        <>
          <SecaoProfissionais profissionais={agendaQuery.data.profissionais} />
          <SecaoServicos servicos={agendaQuery.data.servicos} />
          <SecaoRegrasDaConta configuracao={agendaQuery.data.configuracao} />
          <SecaoTestar
            profissionais={agendaQuery.data.profissionais}
            servicos={agendaQuery.data.servicos}
          />
        </>
      )}
    </div>
  );
}
