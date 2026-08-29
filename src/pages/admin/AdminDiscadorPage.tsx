/**
 * T-029 — Discador.
 *
 * Ativo por enquanto: o operador disca, não recebe. Áudio pelo navegador via
 * WebRTC (headset), com histórico e resultado da ligação alimentando a ficha
 * do contato.
 */
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Phone,
  PhoneOff,
  Mic,
  MicOff,
  Delete,
  Settings,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Copy,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useDialer } from '@/hooks/useDialer';
import { voiceService, SENTINEL, type CallRecord } from '@/services/voice.backend.service';

const TECLAS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

const RESULTADOS = [
  'Agendou reunião',
  'Interessado — retornar',
  'Sem interesse',
  'Não atendeu',
  'Número errado',
  'Pediu para não ligar',
];

const formatarDuracao = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export default function AdminDiscadorPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [numero, setNumero] = useState('');
  const [configAberta, setConfigAberta] = useState(false);
  const [ligacaoParaMarcar, setLigacaoParaMarcar] = useState<string | null>(null);

  const { data: config } = useQuery({ queryKey: ['voice-config'], queryFn: voiceService.getConfig });
  const dialer = useDialer(config?.voiceProvider);
  const { data: ligacoes } = useQuery({
    queryKey: ['voice-calls'],
    queryFn: () => voiceService.listCalls({ limit: 50 }),
    // Status chega por webhook da operadora; sem poll a lista fica congelada.
    refetchInterval: 5000,
  });

  // Ao desligar, abre o resultado da ligação — é o dado que alimenta o funil.
  useEffect(() => {
    if (dialer.state === 'pronto' && dialer.callId && !ligacaoParaMarcar) {
      setLigacaoParaMarcar(dialer.callId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialer.state]);

  const emLigacao = ['discando', 'chamando', 'em_ligacao', 'encerrando'].includes(dialer.state);
  const configurado = (config?.pendencias?.length ?? 1) === 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Discador</h1>
          <p className="text-muted-foreground mt-1">
            Ligações pelo navegador com headset. Brasil e exterior.
          </p>
        </div>
        <Button variant="outline" onClick={() => setConfigAberta(true)}>
          <Settings className="w-4 h-4 mr-2" /> Configurar
        </Button>
      </div>

      {!configurado && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="py-4 flex gap-3 items-start">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-sm">
              <div className="font-medium">Discador ainda não configurado</div>
              <p className="text-muted-foreground mt-0.5">
                Falta preencher: {config?.pendencias.join(', ')}.
              </p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => setConfigAberta(true)}>
                Configurar agora
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[22rem_1fr] items-start">
        {/* Discador */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Ligar</CardTitle>
              <EstadoBadge state={dialer.state} />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              value={dialer.numeroAtual ?? numero}
              onChange={(e) => setNumero(e.target.value)}
              disabled={emLigacao}
              placeholder="11 99999-9999 ou +1 555..."
              className="text-lg h-12 text-center font-mono"
            />
            <p className="text-[11px] text-muted-foreground text-center">
              Sem o código do país, assume Brasil. Para o exterior, comece com{' '}
              <code>+</code>.
            </p>

            {dialer.state === 'em_ligacao' && (
              <div className="text-center text-2xl font-mono">{formatarDuracao(dialer.duracao)}</div>
            )}

            <div className="grid grid-cols-3 gap-2">
              {TECLAS.map((t) => (
                <Button
                  key={t}
                  variant="outline"
                  className="h-11 text-base font-mono"
                  onClick={() => {
                    if (dialer.state === 'em_ligacao') dialer.enviarDigito(t);
                    else setNumero((n) => n + t);
                  }}
                >
                  {t}
                </Button>
              ))}
            </div>

            <div className="flex gap-2">
              {!emLigacao ? (
                <>
                  <Button
                    className="flex-1 h-11 bg-emerald-600 hover:bg-emerald-700"
                    disabled={!numero.trim() || dialer.state !== 'pronto'}
                    onClick={() => dialer.ligar(numero)}
                  >
                    <Phone className="w-4 h-4 mr-2" /> Ligar
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11"
                    onClick={() => setNumero((n) => n.slice(0, -1))}
                    disabled={!numero}
                  >
                    <Delete className="w-4 h-4" />
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="destructive" className="flex-1 h-11" onClick={dialer.desligar}>
                    <PhoneOff className="w-4 h-4 mr-2" /> Desligar
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11"
                    onClick={dialer.alternarMudo}
                    disabled={dialer.state !== 'em_ligacao'}
                  >
                    {dialer.mudo ? <MicOff className="w-4 h-4 text-destructive" /> : <Mic className="w-4 h-4" />}
                  </Button>
                </>
              )}
            </div>

            {dialer.erro && (
              <p className="text-xs text-destructive text-center">{dialer.erro}</p>
            )}
            {config?.voiceRecording && (
              <p className="text-[11px] text-muted-foreground text-center">
                Gravação ativa — o aviso é reproduzido para o destinatário.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Histórico */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Ligações recentes</CardTitle>
            <CardDescription>Atualiza sozinho conforme a operadora informa o status.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {!ligacoes?.length && (
              <p className="text-sm text-muted-foreground py-6 text-center">
                Nenhuma ligação ainda.
              </p>
            )}
            {ligacoes?.map((c) => (
              <LinhaDeLigacao key={c.id} call={c} onMarcar={() => setLigacaoParaMarcar(c.id)} />
            ))}
          </CardContent>
        </Card>
      </div>

      <DialogConfig
        aberto={configAberta}
        onFechar={() => setConfigAberta(false)}
        config={config}
        onSalvo={() => {
          qc.invalidateQueries({ queryKey: ['voice-config'] });
          toast({ title: 'Discador configurado' });
        }}
      />

      <DialogResultado
        callId={ligacaoParaMarcar}
        onFechar={() => setLigacaoParaMarcar(null)}
        onSalvo={() => {
          qc.invalidateQueries({ queryKey: ['voice-calls'] });
          setLigacaoParaMarcar(null);
        }}
      />
    </div>
  );
}

function EstadoBadge({ state }: { state: string }) {
  const mapa: Record<string, { label: string; classe: string }> = {
    desconectado: { label: 'Conectando…', classe: 'bg-muted text-muted-foreground' },
    pronto: { label: 'Pronto', classe: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30' },
    discando: { label: 'Discando…', classe: 'bg-blue-500/15 text-blue-600 border-blue-500/30' },
    chamando: { label: 'Chamando…', classe: 'bg-blue-500/15 text-blue-600 border-blue-500/30' },
    em_ligacao: { label: 'Em ligação', classe: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30' },
    encerrando: { label: 'Encerrando…', classe: 'bg-muted text-muted-foreground' },
    erro: { label: 'Erro', classe: 'bg-destructive/15 text-destructive border-destructive/30' },
  };
  const i = mapa[state] ?? mapa.desconectado;
  return (
    <Badge variant="outline" className={i.classe}>
      {state === 'desconectado' && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
      {i.label}
    </Badge>
  );
}

function LinhaDeLigacao({ call, onMarcar }: { call: CallRecord; onMarcar: () => void }) {
  const atendida = call.status === 'completed' && (call.durationSec ?? 0) > 0;
  return (
    <div className="flex items-center gap-3 rounded-md border p-2.5 text-sm">
      {atendida ? (
        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
      ) : (
        <PhoneOff className="w-4 h-4 text-muted-foreground shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">
          {call.contact?.nome ?? call.toNumber}
          {call.contact && (
            <span className="text-muted-foreground font-normal ml-2 text-xs">{call.toNumber}</span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {new Date(call.createdAt).toLocaleString('pt-BR')} · {call.status}
          {call.durationSec ? ` · ${formatarDuracao(call.durationSec)}` : ''}
          {call.disposition ? ` · ${call.disposition}` : ''}
        </div>
      </div>
      {call.recordingUrl && (
        <a
          href={call.recordingUrl}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary hover:underline shrink-0"
        >
          gravação
        </a>
      )}
      <Button variant="ghost" size="sm" onClick={onMarcar} className="shrink-0">
        Resultado
      </Button>
    </div>
  );
}

function DialogResultado({
  callId,
  onFechar,
  onSalvo,
}: {
  callId: string | null;
  onFechar: () => void;
  onSalvo: () => void;
}) {
  const [disposition, setDisposition] = useState('');
  const [notes, setNotes] = useState('');

  const salvar = useMutation({
    mutationFn: () => voiceService.setOutcome(callId!, { disposition, notes }),
    onSuccess: () => {
      setDisposition('');
      setNotes('');
      onSalvo();
    },
  });

  return (
    <Dialog open={!!callId} onOpenChange={(o) => !o && onFechar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resultado da ligação</DialogTitle>
          <DialogDescription>
            É o que alimenta o funil — marque antes de partir pra próxima.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Resultado</Label>
            <Select value={disposition} onValueChange={setDisposition}>
              <SelectTrigger>
                <SelectValue placeholder="Escolha" />
              </SelectTrigger>
              <SelectContent>
                {RESULTADOS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Observações</Label>
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onFechar}>
            Pular
          </Button>
          <Button onClick={() => salvar.mutate()} disabled={salvar.isPending}>
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DialogConfig({
  aberto,
  onFechar,
  config,
  onSalvo,
}: {
  aberto: boolean;
  onFechar: () => void;
  config?: import('@/services/voice.backend.service').VoiceConfig;
  onSalvo: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<Record<string, string>>({});
  const [provider, setProvider] = useState<'sip' | 'twilio'>('sip');
  const [gravar, setGravar] = useState(false);

  useEffect(() => {
    if (!config) return;
    setProvider(config.voiceProvider);
    setForm({
      sipWsServer: config.sipWsServer ?? '',
      sipDomain: config.sipDomain ?? '',
      sipUsername: config.sipUsername ?? '',
      sipPassword: config.sipPassword ?? '',
      sipCallerId: config.sipCallerId ?? '',
      twilioAccountSid: config.twilioAccountSid ?? '',
      twilioAuthToken: config.twilioAuthToken ?? '',
      twilioApiKeySid: config.twilioApiKeySid ?? '',
      twilioApiKeySecret: config.twilioApiKeySecret ?? '',
      twilioTwimlAppSid: config.twilioTwimlAppSid ?? '',
      twilioCallerId: config.twilioCallerId ?? '',
    });
    setGravar(config.voiceRecording);
  }, [config]);

  const salvar = useMutation({
    mutationFn: () =>
      voiceService.updateConfig({ ...form, voiceProvider: provider, voiceRecording: gravar }),
    onSuccess: () => {
      onSalvo();
      onFechar();
    },
    onError: (e: Error) =>
      toast({ title: 'Não foi possível salvar', description: e.message, variant: 'destructive' }),
  });

  const campo = (chave: string, label: string, dica?: string, senha = false) => (
    <div className="space-y-1.5" key={chave}>
      <Label className="text-xs">{label}</Label>
      <Input
        type={senha ? 'password' : 'text'}
        className="h-8 font-mono text-xs"
        value={form[chave] ?? ''}
        onChange={(e) => setForm((f) => ({ ...f, [chave]: e.target.value }))}
        placeholder={form[chave] === SENTINEL ? 'já configurado' : undefined}
      />
      {dica && <p className="text-[11px] text-muted-foreground">{dica}</p>}
    </div>
  );

  return (
    <Dialog open={aberto} onOpenChange={(o) => !o && onFechar()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configurar discador</DialogTitle>
          <DialogDescription>
            Escolha a operadora e preencha os dados de acesso.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Operadora</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as 'sip' | 'twilio')}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sip">Provedor SIP (plano fechado)</SelectItem>
                <SelectItem value="twilio">Twilio (pago por minuto)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator />

          {provider === 'sip' ? (
            <>
              {campo(
                'sipWsServer',
                'Servidor WSS',
                'Endereço WebSocket do provedor. Ex: wss://sip.provedor.com.br:7443'
              )}
              {campo('sipDomain', 'Domínio SIP', 'A parte depois do @ no seu ramal.')}
              {campo('sipUsername', 'Usuário SIP', 'Normalmente o número do ramal.')}
              {campo('sipPassword', 'Senha SIP', undefined, true)}
              {campo(
                'sipCallerId',
                'Número de origem (opcional)',
                'Deixe vazio se o provedor já define o número que aparece.'
              )}

              <div className="rounded-md border p-3 bg-muted/30 text-[11px] text-muted-foreground space-y-1">
                <div className="font-medium text-foreground">Sobre a senha SIP</div>
                <p>
                  Ela chega ao navegador — é assim que todo webphone funciona, o registro é
                  feito pelo cliente. Só sai para usuário autenticado desta conta, e como o
                  plano é de 1 chamada por vez, uma credencial vazada vira linha ocupada e
                  visível no histórico, não call center clandestino. Trocar a senha invalida
                  na hora.
                </p>
              </div>
            </>
          ) : (
            <>
              {campo('twilioAccountSid', 'Account SID', 'Console da Twilio (começa com AC).')}
              {campo('twilioAuthToken', 'Auth Token', 'Valida os webhooks.', true)}
              {campo('twilioApiKeySid', 'API Key SID', 'Account → API keys (começa com SK).')}
              {campo('twilioApiKeySecret', 'API Key Secret', 'Só aparece na criação.', true)}
              {campo('twilioTwimlAppSid', 'TwiML App SID', 'Voice → TwiML Apps (começa com AP).')}
              {campo('twilioCallerId', 'Número de origem', 'Ex: +5511999999999')}

              <div className="rounded-md border p-3 space-y-1.5 bg-muted/30">
                <div className="text-xs font-medium">Cole esta URL no seu TwiML App</div>
                <div className="flex gap-2 items-center">
                  <code className="text-[11px] break-all flex-1">{config?.twimlVoiceUrl}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      navigator.clipboard.writeText(config?.twimlVoiceUrl ?? '');
                      toast({ title: 'URL copiada' });
                    }}
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Voice → TwiML Apps → seu app → Request URL (POST). Sem isso a chamada não sai.
                </p>
              </div>
            </>
          )}

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">Gravar ligações</div>
              <p className="text-[11px] text-muted-foreground">
                {provider === 'sip'
                  ? 'No SIP a gravação é feita pelo provedor — ative no painel dele.'
                  : 'Reproduz um aviso de gravação antes de conectar.'}
              </p>
            </div>
            <Switch checked={gravar} onCheckedChange={setGravar} disabled={provider === 'sip'} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onFechar}>
            Cancelar
          </Button>
          <Button onClick={() => salvar.mutate()} disabled={salvar.isPending}>
            {salvar.isPending ? 'Salvando…' : 'Salvar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
