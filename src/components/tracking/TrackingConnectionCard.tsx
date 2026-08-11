/**
 * Conexão com a Meta: credenciais + toggles + diagnóstico por ativo.
 *
 * O diagnóstico existe porque a falha mais comum (usuário do sistema sem o
 * ativo atribuído na Business Manager) é invisível pela API — ela só devolve
 * lista vazia. Aqui cada ativo é testado isoladamente e mostra o erro real.
 */
import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Loader2,
  Save,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type {
  TrackingConfigInput,
  TrackingConfigView,
  TrackingConnectionCheck,
} from '@/services/tracking.backend.service';

interface Props {
  config: TrackingConfigView | null | undefined;
  checks: TrackingConnectionCheck[] | null;
  saving: boolean;
  verifying: boolean;
  onSave: (input: TrackingConfigInput) => void;
  onVerify: () => void;
}

const TOGGLES = [
  ['active', 'Tracking ativo'],
  ['sendLead', 'Enviar conversa real (Lead)'],
  ['sendSchedule', 'Enviar reunião agendada (Schedule)'],
  ['sendPurchase', 'Enviar venda (Purchase)'],
] as const;

export function TrackingConnectionCard({
  config,
  checks,
  saving,
  verifying,
  onSave,
  onVerify,
}: Props) {
  const [form, setForm] = useState<TrackingConfigInput>({});
  const [tokenInput, setTokenInput] = useState('');
  const [open, setOpen] = useState(false);

  // Hidrata o form quando a config chega
  useEffect(() => {
    if (!config) return;
    setForm({
      pixelId: config.pixelId ?? '',
      adAccountId: config.adAccountId ?? '',
      active: config.active,
      sendLead: config.sendLead,
      sendSchedule: config.sendSchedule,
      sendPurchase: config.sendPurchase,
    });
  }, [config]);

  // Conexão nunca configurada: já abre o formulário.
  useEffect(() => {
    if (config && !config.hasToken) setOpen(true);
  }, [config]);

  const handleSave = () => {
    const payload: TrackingConfigInput = { ...form };
    if (tokenInput.trim()) payload.accessToken = tokenInput.trim();
    onSave(payload);
    setTokenInput('');
  };

  const failing = checks?.filter((c) => !c.ok) ?? [];

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                Conexão com a Meta
                {config?.active ? (
                  <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">Ativo</Badge>
                ) : (
                  <Badge variant="outline">Inativo</Badge>
                )}
                {checks && failing.length > 0 && (
                  <Badge variant="outline" className="text-destructive border-destructive">
                    {failing.length} problema{failing.length > 1 ? 's' : ''}
                  </Badge>
                )}
                {checks && failing.length === 0 && (
                  <Badge variant="outline" className="text-emerald-600 border-emerald-600">
                    Tudo certo
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="mt-1">
                {config?.hasToken
                  ? `Token ····${config.tokenLast4} · pixel ${config.pixelId || '—'} · conta ${config.adAccountId || '—'}`
                  : 'Gere um token de usuário do sistema na Business Manager com permissões de anúncios.'}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={onVerify} disabled={verifying}>
                {verifying ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <ShieldCheck className="w-4 h-4 mr-1" />
                )}
                Testar conexão
              </Button>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Editar credenciais">
                  <ChevronDown
                    className={cn('w-4 h-4 transition-transform', open && 'rotate-180')}
                  />
                </Button>
              </CollapsibleTrigger>
            </div>
          </div>
        </CardHeader>

        {/* Diagnóstico por ativo — sempre visível quando existe */}
        {checks && checks.length > 0 && (
          <CardContent className="pt-0 pb-3">
            <div className="grid gap-2 sm:grid-cols-3">
              {checks.map((c) => (
                <div
                  key={c.key}
                  className={cn(
                    'rounded-md border p-2.5 text-xs',
                    c.ok ? 'border-emerald-600/30 bg-emerald-600/5' : 'border-destructive/40 bg-destructive/5'
                  )}
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    {c.ok ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
                    )}
                    {c.label}
                  </div>
                  <p className="text-muted-foreground mt-1 break-words">{c.detail}</p>
                  {c.hint && (
                    <p className="mt-1.5 text-[11px] text-foreground/80 break-words">
                      → {c.hint}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        )}

        <CollapsibleContent>
          <CardContent className="space-y-4 pt-0">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="tk-token">
                  Token de acesso{' '}
                  {config?.hasToken && (
                    <span className="text-muted-foreground font-normal">
                      (salvo ····{config.tokenLast4})
                    </span>
                  )}
                </Label>
                <Input
                  id="tk-token"
                  type="password"
                  autoComplete="off"
                  placeholder={config?.hasToken ? 'Preencher só para trocar' : 'EAAG...'}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tk-pixel">ID do Pixel / Dataset</Label>
                <Input
                  id="tk-pixel"
                  placeholder="ex.: 1234567890"
                  value={form.pixelId ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, pixelId: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tk-adacc">ID da Conta de Anúncios</Label>
                <Input
                  id="tk-adacc"
                  placeholder="ex.: act_123456 ou 123456"
                  value={form.adAccountId ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, adAccountId: e.target.value }))}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              {TOGGLES.map(([key, label]) => (
                <div key={key} className="flex items-center gap-2">
                  <Switch
                    id={`tk-${key}`}
                    checked={Boolean(form[key])}
                    onCheckedChange={(checked) => setForm((f) => ({ ...f, [key]: checked }))}
                  />
                  <Label htmlFor={`tk-${key}`} className="text-sm font-normal">
                    {label}
                  </Label>
                </div>
              ))}
            </div>

            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-1" />
              )}
              Salvar configuração
            </Button>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
