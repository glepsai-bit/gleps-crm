/**
 * T-037 — os campos de configuração de cada bloco.
 *
 * Extraídos do painel lateral porque agora vivem em DOIS lugares: dentro do
 * bloco no canvas (o caminho normal) e no painel (que sobrevive para telas
 * estreitas). Duas cópias divergiriam no primeiro campo novo, e a divergência
 * apareceria como "no meu computador aparece diferente".
 *
 * É só o miolo: nome do passo, saídas e remover continuam no painel, porque no
 * bloco eles já existem de outra forma — o título é editável no próprio
 * cabeçalho e as saídas são as portas desenhadas.
 *
 * Dois blocos buscam dado da conta por conta própria (times e etapas do
 * funil): o chamador não precisa saber disso, e o cache do React Query faz o
 * segundo bloco do mesmo tipo não custar outra chamada.
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { tagsBackendService } from '@/services/tags.backend.service';
import { teamsBackendService } from '@/services/teams.backend.service';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface CamposDoNoProps {
  tipo: string;
  config: Record<string, unknown>;
  agentes: { id: string; name: string }[];
  bases?: { id: string; name: string }[];
  /** Grava uma chave da configuração. O chamador decide como persistir. */
  set: (chave: string, valor: unknown) => void;
}

/** Uma etapa do funil da conta — o que o Kanban tem, na ordem do Kanban. */
export interface EtapaDoFunil {
  id: string;
  slug: string;
  name: string;
}

/**
 * As etapas REAIS do funil desta conta, ativas e em ordem.
 *
 * É a única fonte de verdade para "etapa" em todo o editor: o motor aplica uma
 * etapa por slug ou nome entre estas e recusa qualquer outra — então uma lista
 * fixa aqui seria uma promessa que o backend não cumpre.
 */
// O backend escopa pelo JWT; o accountId vai só porque a assinatura do
// service pede. Sem sessão a chave da query muda e nada é reaproveitado.
// eslint-disable-next-line react-refresh/only-export-components
export function useEtapasDoFunil() {
  const { user, account } = useAuth();
  const accountId = user?.account_id || account?.id || '';
  return useQuery({
    queryKey: ['etapas-do-funil', accountId],
    queryFn: async (): Promise<EtapaDoFunil[]> => {
      const tags = await tagsBackendService.listStageTags(accountId);
      return tags
        .filter((t) => t.ativo !== false)
        .sort((a, b) => a.ordem - b.ordem)
        .map((t) => ({ id: t.id, slug: t.slug, name: t.name }));
    },
    staleTime: 60_000,
  });
}

/** Os times de atendimento da conta. Mesma chave da tela de times: cache compartilhado. */
// eslint-disable-next-line react-refresh/only-export-components
export function useTimesDaConta() {
  return useQuery({
    queryKey: ['teams'],
    queryFn: () => teamsBackendService.listTeams(),
    staleTime: 60_000,
  });
}

/** Valor do Select que significa "sem time" — o Radix não aceita item vazio. */
const QUALQUER_ATENDENTE = '__qualquer__';

/** O template que faz o passo usar a etapa que o agente devolveu. */
export const ETAPA_DO_AGENTE = '{{agente.etapa}}';

/**
 * Time da transferência. Sem time é o comportamento de sempre (sorteio entre
 * todos os online); com time, só quem é do time — é o que transforma uma rota
 * "financeiro" num departamento de verdade.
 */
function SeletorDeTime({ teamId, set }: { teamId: string; set: CamposDoNoProps['set'] }) {
  const times = useTimesDaConta();
  const lista = times.data ?? [];
  // O time salvo não está na lista: foi excluído, ou a lista não veio. Nos
  // dois casos o valor precisa continuar visível — sumir do Select seria
  // apagá-lo no próximo salvar sem ninguém ter pedido.
  const salvoForaDaLista = !!teamId && !times.isLoading && !lista.some((t) => t.id === teamId);

  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Time</Label>
      <Select
        value={teamId || QUALQUER_ATENDENTE}
        onValueChange={(v) => set('teamId', v === QUALQUER_ATENDENTE ? undefined : v)}
      >
        <SelectTrigger className="h-8" aria-label="Time">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={QUALQUER_ATENDENTE}>Qualquer atendente online</SelectItem>
          {lista.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              {t.name}
            </SelectItem>
          ))}
          {salvoForaDaLista && (
            <SelectItem value={teamId}>
              {times.isError ? 'Time salvo (lista indisponível)' : 'Time não encontrado — foi excluído?'}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
      {times.isError ? (
        <p className="text-[11px] text-destructive leading-relaxed">
          Não consegui carregar os times. O que já estava salvo continua valendo.
        </p>
      ) : times.isSuccess && lista.length === 0 ? (
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          A conta não tem time cadastrado — transfere para qualquer atendente online. Times
          são criados em <strong>Administração → Times</strong>.
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Sem time, sorteia entre todos os atendentes online. Com time, só quem é do time — e
          se ninguém dele estiver online, cai no rodízio do time. Sem ninguém, sai pela porta{' '}
          <strong>Ninguém disponível</strong>.
        </p>
      )}
    </div>
  );
}

/**
 * Etapa a aplicar — só uma do funil real, ou a que o agente decidiu.
 *
 * Era um textarea livre. Escrever "agendado" ali parecia funcionar e não fazia
 * nada: o motor não acha a etapa, não cria etiqueta e registra
 * "etapa desconhecida". Lista fechada é o que impede a promessa vazia.
 */
function SeletorDeEtapa({ etapa, set }: { etapa: string; set: CamposDoNoProps['set'] }) {
  const etapas = useEtapasDoFunil();
  const lista = etapas.data ?? [];
  const semEtapas = etapas.isSuccess && lista.length === 0;
  const valorConhecido =
    etapa === '' || etapa === ETAPA_DO_AGENTE || lista.some((e) => e.slug === etapa);

  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Etapa</Label>
      <Select value={etapa} onValueChange={(v) => set('etapa', v)}>
        <SelectTrigger className="h-8" aria-label="Etapa">
          <SelectValue placeholder="Escolha a etapa" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ETAPA_DO_AGENTE}>Usar a etapa que o agente decidiu</SelectItem>
          {lista.map((e) => (
            <SelectItem key={e.id} value={e.slug}>
              {e.name}
            </SelectItem>
          ))}
          {!valorConhecido && <SelectItem value={etapa}>Valor atual: {etapa}</SelectItem>}
        </SelectContent>
      </Select>
      {etapas.isError ? (
        <p className="text-[11px] text-destructive leading-relaxed">
          Não consegui carregar as etapas do funil. O que já estava salvo continua valendo.
        </p>
      ) : semEtapas ? (
        <p className="text-[11px] rounded-md border border-amber-500/60 bg-amber-500/10 p-2 leading-relaxed">
          Seu funil não tem etapa nenhuma — este passo não tem o que aplicar. Crie as etapas
          no Kanban primeiro.
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          As etapas vêm do seu funil do Kanban. Uma etapa que não existe lá não é aplicada — o
          passo registra "etapa desconhecida".
        </p>
      )}
      {!valorConhecido && !etapas.isLoading && !etapas.isError && (
        <p className="text-[11px] text-destructive leading-relaxed">
          O valor salvo (<code>{etapa}</code>) não é uma etapa do funil. Escolha uma da lista —
          do jeito que está, nada é aplicado.
        </p>
      )}
    </div>
  );
}

export function CamposDoNo({ tipo, config, agentes, bases = [], set }: CamposDoNoProps) {
  return (
    <>
      {tipo.startsWith('trigger.') && (
        <div className="space-y-1.5">
          <Label className="text-xs">Começa quando</Label>
          <Select
            value={tipo}
            onValueChange={(v) => set('__trocarTipo', v)}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="trigger.message_received">O lead escrever</SelectItem>
              <SelectItem value="trigger.webhook">Um sistema de fora chamar</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Um fluxo começa de um jeito só — por isso aqui se TROCA o gatilho, em vez de
            adicionar outro.
          </p>
        </div>
      )}

      {tipo === 'trigger.webhook' && (
        <div className="space-y-2">
          <div className="rounded-md border bg-muted/40 p-2.5 text-[11px] text-muted-foreground leading-relaxed">
            A configuração deste gatilho — endereço, segredo e qual campo é o telefone —
            mora na <strong>integração de entrada</strong>, não no bloco: a mesma URL pode
            servir a vários eventos.
          </div>
          <a
            href="/admin/integracoes"
            className="flex items-center justify-center h-8 rounded-md border text-xs hover:bg-muted/40 transition-colors"
          >
            Abrir integrações de entrada
          </a>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Crie uma integração com o tipo <strong>Iniciar atendimento</strong>, aponte para
            este fluxo e informe onde está o telefone no corpo enviado.
          </p>
        </div>
      )}

      {tipo === 'source.knowledge' && (
        <div className="space-y-1.5">
          <Label className="text-xs">Base</Label>
          <Select value={String(config.baseId ?? '')} onValueChange={(v) => set('baseId', v)}>
            <SelectTrigger className="h-8">
              <SelectValue placeholder="Escolha a base" />
            </SelectTrigger>
            <SelectContent>
              {bases.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            Puxe a bolinha de baixo deste bloco até a <strong>entrada tracejada da
            esquerda</strong> do bloco de atendimento — ou solte em cima do bloco, que ela
            mira sozinha. A base não é um passo do fluxo: é o material que o agente
            consulta. Cada agente com a sua base responde melhor e custa menos que um com
            tudo.
          </p>
        </div>
      )}

  {(tipo === 'ai.agent' || tipo === 'ai.atender') && (
    <div className="space-y-1.5">
      <Label className="text-xs">Agente</Label>
      <Select
        value={String(config.agentId ?? '')}
        onValueChange={(v) => set('agentId', v)}
      >
        <SelectTrigger className="h-8">
          <SelectValue placeholder="Escolha o agente" />
        </SelectTrigger>
        <SelectContent>
          {agentes.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] text-muted-foreground">
        A saída dele fica em <code>{'{{agente.*}}'}</code> para os passos seguintes.
      </p>
    </div>
  )}

  {tipo === 'buffer.debounce' && (
    <div className="space-y-1.5">
      <Label className="text-xs">Esperar (segundos)</Label>
      <Input
        type="number"
        min={0}
        max={300}
        className="h-8"
        value={Number(config.segundos ?? 15)}
        onChange={(e) => set('segundos', Number(e.target.value))}
      />
      <p className="text-[11px] text-muted-foreground">
        Mensagens que chegarem nesta janela entram na mesma resposta.
      </p>
    </div>
  )}

  {tipo === 'guard.conditions' && (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={config.humanoAssumiu !== false}
          onChange={(e) => set('humanoAssumiu', e.target.checked)}
        />
        Parar se um humano assumiu
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={config.conversaResolvida !== false}
          onChange={(e) => set('conversaResolvida', e.target.checked)}
        />
        Parar se a conversa já foi resolvida
      </label>
    </div>
  )}

  {/* ESPERA LONGA — o nó do follow-up. Estava sem nenhuma forma: dava pra
      arrastar o bloco e não havia como dizer quantos dias esperar. */}
  {tipo === 'flow.aguardar' && (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="space-y-1.5 w-20">
          <Label className="text-xs">Esperar</Label>
          <Input
            type="number"
            min={1}
            className="h-8"
            value={Number(config.valor ?? 1)}
            onChange={(e) => set('valor', Math.max(1, Number(e.target.value)))}
          />
        </div>
        <div className="space-y-1.5 flex-1">
          <Label className="text-xs">&nbsp;</Label>
          <Select
            value={String(config.unidade ?? 'dias')}
            onValueChange={(v) => set('unidade', v)}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="minutos">minutos</SelectItem>
              <SelectItem value="horas">horas</SelectItem>
              <SelectItem value="dias">dias</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        O atendimento é suspenso e retomado do passo seguinte. Teto de 60 dias — acima
        disso não é follow-up, é campanha de reativação.
      </p>

      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={Boolean(config.horarioComercial)}
          onChange={(e) =>
            set(
              'horarioComercial',
              e.target.checked
                ? { inicio: '09:00', fim: '18:00', dias: [1, 2, 3, 4, 5], timezone: 'America/Sao_Paulo' }
                : undefined
            )
          }
        />
        <span>
          Só em horário comercial
          <span className="block text-muted-foreground">
            Mensagem às 3h da manhã é pior que nenhuma mensagem.
          </span>
        </span>
      </label>

      {Boolean(config.horarioComercial) && (
        <div className="flex gap-2 pl-6">
          <div className="space-y-1.5 flex-1">
            <Label className="text-xs">Das</Label>
            <Input
              type="time"
              className="h-8"
              value={String((config.horarioComercial as Record<string, string>)?.inicio ?? '09:00')}
              onChange={(e) =>
                set('horarioComercial', {
                  ...(config.horarioComercial as Record<string, unknown>),
                  inicio: e.target.value,
                })
              }
            />
          </div>
          <div className="space-y-1.5 flex-1">
            <Label className="text-xs">Até</Label>
            <Input
              type="time"
              className="h-8"
              value={String((config.horarioComercial as Record<string, string>)?.fim ?? '18:00')}
              onChange={(e) =>
                set('horarioComercial', {
                  ...(config.horarioComercial as Record<string, unknown>),
                  fim: e.target.value,
                })
              }
            />
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label className="text-xs">Espalhar os envios em até (minutos)</Label>
        <Input
          type="number"
          min={0}
          max={120}
          className="h-8"
          value={Number(config.dispersaoMinutos ?? 12)}
          onChange={(e) => set('dispersaoMinutos', Number(e.target.value))}
        />
        <p className="text-[11px] text-muted-foreground">
          200 mensagens saindo às 9h em ponto é o padrão que marca o número como robô.
        </p>
      </div>
    </div>
  )}

  {tipo === 'flow.wait' && (
    <div className="space-y-1.5">
      <Label className="text-xs">Pausar (segundos)</Label>
      <Input
        type="number"
        min={1}
        max={60}
        className="h-8"
        value={Number(config.segundos ?? 5)}
        onChange={(e) => set('segundos', Number(e.target.value))}
      />
      <p className="text-[11px] text-muted-foreground">
        Pausa curta <strong>dentro</strong> da conversa, pra dar ritmo humano. Máximo 60s —
        para esperar horas ou dias use <strong>Aguardar</strong>.
      </p>
    </div>
  )}

  {tipo === 'media.transcribe' && (
    <div className="space-y-1.5">
      <Label className="text-xs">Idioma do áudio</Label>
      <Select value={String(config.idioma ?? 'pt')} onValueChange={(v) => set('idioma', v)}>
        <SelectTrigger className="h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="pt">Português</SelectItem>
          <SelectItem value="es">Espanhol</SelectItem>
          <SelectItem value="en">Inglês</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-[11px] text-muted-foreground">
        Dizer o idioma certo melhora bastante a transcrição de áudio curto e com ruído.
      </p>
    </div>
  )}

  {tipo === 'chat.resolve' && (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">Encerrar como</Label>
        <Select
          value={String(config.outcome ?? 'resolved')}
          onValueChange={(v) => set('outcome', v)}
        >
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="resolved">Resolvida</SelectItem>
            <SelectItem value="lost">Perdida</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Motivo (opcional)</Label>
        <Input
          className="h-8"
          placeholder="atendimento concluído pela IA"
          value={String(config.motivo ?? '')}
          onChange={(e) => set('motivo', e.target.value)}
        />
        <p className="text-[11px] text-muted-foreground">
          Fica no histórico da conversa — é o que explica o encerramento depois.
        </p>
      </div>

      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={Boolean(config.pedirCsat)}
          onChange={(e) => set('pedirCsat', e.target.checked)}
        />
        <span>
          Pedir avaliação ao encerrar
          <span className="block text-muted-foreground">
            Manda a pesquisa de satisfação depois da última mensagem.
          </span>
        </span>
      </label>
    </div>
  )}

  {/* Sem configuração — mas o painel não pode ficar vazio: o usuário precisa
      saber que não está faltando nada pra ele preencher. */}
  {tipo === 'trigger.message_received' && (
    <div className="rounded-md border bg-muted/40 p-2.5 text-[11px] text-muted-foreground leading-relaxed">
      Não tem o que configurar: dispara sempre que o lead escrever. Para limitar a certas
      caixas de entrada, use o campo de inboxes do fluxo.
    </div>
  )}

  {tipo === 'chat.assign_human' && (
    <SeletorDeTime teamId={String(config.teamId ?? '')} set={set} />
  )}

  {tipo === 'chat.reply' && (
    <div className="space-y-1.5">
      <Label className="text-xs">Texto da resposta</Label>
      <Textarea
        rows={4}
        value={String(config.texto ?? '')}
        onChange={(e) => set('texto', e.target.value)}
        className="text-xs font-mono"
      />
      <p className="text-[11px] text-muted-foreground">
        Use <code>{'{{agente.campo}}'}</code> para inserir a saída do agente.
      </p>
    </div>
  )}

  {tipo === 'crm.apply_stage' && (
    <SeletorDeEtapa etapa={String(config.etapa ?? '')} set={set} />
  )}

  {tipo === 'crm.update_contact' && (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label className="text-xs">Onde guardar</Label>
        <Select
          value={String(config.destino ?? 'lead')}
          onValueChange={(v) => set('destino', v)}
        >
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="lead">No lead — vale para sempre</SelectItem>
            <SelectItem value="conversa">Nesta conversa — some ao encerrar</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          No lead vira <code>{'{{memoria.campo}}'}</code> e sobrevive quando a conversa
          encerra. Na conversa vira <code>{'{{sessao.campo}}'}</code> e morre com ela.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Campos</Label>
        <Textarea
          rows={4}
          className="text-xs font-mono"
          value={JSON.stringify(config.campos ?? {}, null, 2)}
          onChange={(e) => {
            try {
              set('campos', JSON.parse(e.target.value || '{}'));
            } catch {
              /* mantém o último JSON válido enquanto o usuário digita */
            }
          }}
        />
        <p className="text-[11px] text-muted-foreground">
          Ex.: <code>{'{ "faturamento": "{{agente.faturamento}}" }'}</code>
        </p>
      </div>
    </div>
  )}

  {tipo === 'logic.switch' && (
    <div className="space-y-1.5">
      <Label className="text-xs">Variável</Label>
      <Input
        className="h-8 font-mono text-xs"
        value={String(config.variavel ?? '')}
        onChange={(e) => set('variavel', e.target.value)}
        placeholder="agente.transferir_para_humano"
      />
      <p className="text-[11px] text-muted-foreground">
        Ligue a saída <code>sim</code> ao caminho desejado; o resto segue pela saída padrão.
      </p>
    </div>
  )}

  {tipo === 'http.request' && (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label className="text-xs">URL</Label>
        <Input
          className="h-8 text-xs font-mono"
          value={String(config.url ?? '')}
          onChange={(e) => set('url', e.target.value)}
          placeholder="https://…"
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Método</Label>
        <Select value={String(config.metodo ?? 'POST')} onValueChange={(v) => set('metodo', v)}>
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {['GET', 'POST', 'PUT', 'PATCH'].map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )}
    </>
  );
}
