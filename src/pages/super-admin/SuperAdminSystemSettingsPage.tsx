import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Loader2, Plug, Save, Settings as SettingsIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  systemSettingsBackendService,
  MASKED_API_KEY,
  type SystemSettingsView,
  type UpdateSystemSettingsInput,
} from '@/services/system-settings.backend.service';

/**
 * Configurações globais do sistema — somente Super Admin.
 *
 * Hoje cobre as credenciais GLOBAIS da Evolution API (URL, API key, webhook).
 * Cada conta (admin) cria as próprias instâncias WhatsApp consumindo essas
 * credenciais — sem precisar configurar URL/API key por conta.
 *
 * Lógica de máscara da API key:
 *  - Backend devolve '***SET***' quando há chave salva.
 *  - Mantemos esse sentinel no input até o usuário digitar algo novo.
 *  - No PATCH, só enviamos `evolutionApiKey` se o usuário realmente editou.
 */
export default function SuperAdminSystemSettingsPage() {
  const queryClient = useQueryClient();

  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [apiKeyDirty, setApiKeyDirty] = useState(false);

  const {
    data: settings,
    isLoading,
    isError,
    error,
  } = useQuery<SystemSettingsView>({
    queryKey: ['system-settings'],
    queryFn: () => systemSettingsBackendService.getSettings(),
  });

  // Hidrata inputs quando a query resolve (ou re-resolve após save).
  useEffect(() => {
    if (!settings) return;
    setBaseUrl(settings.evolutionBaseUrl ?? '');
    setWebhookUrl(settings.evolutionWebhookUrl ?? '');
    setApiKey(settings.evolutionApiKey ?? '');
    setApiKeyDirty(false);
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: (payload: UpdateSystemSettingsInput) =>
      systemSettingsBackendService.updateSettings(payload),
    onSuccess: (data) => {
      queryClient.setQueryData(['system-settings'], data);
      toast.success('Configurações salvas com sucesso.');
      setApiKeyDirty(false);
    },
    onError: (err: any) => {
      toast.error(
        'Erro ao salvar configurações: ' + (err?.message || 'desconhecido')
      );
    },
  });

  const testMutation = useMutation({
    mutationFn: () => systemSettingsBackendService.testEvolution(),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(
          `${result.instanceCount ?? 0} instância(s) encontrada(s) na Evolution.`
        );
      } else {
        toast.error(
          'Falha ao conectar com a Evolution: ' +
            (result.error || 'erro desconhecido')
        );
      }
    },
    onError: (err: any) => {
      toast.error(
        'Erro ao testar conexão: ' + (err?.message || 'desconhecido')
      );
    },
  });

  const handleSave = () => {
    const payload: UpdateSystemSettingsInput = {
      evolutionBaseUrl: baseUrl.trim(),
      evolutionWebhookUrl: webhookUrl.trim(),
    };

    // Só envia apiKey se o usuário editou de fato. O service também
    // bloqueia o sentinel MASKED_API_KEY como defesa em profundidade.
    if (apiKeyDirty && apiKey !== MASKED_API_KEY) {
      payload.evolutionApiKey = apiKey.trim();
    }

    saveMutation.mutate(payload);
  };

  const handleApiKeyChange = (value: string) => {
    setApiKey(value);
    setApiKeyDirty(true);
  };

  // Habilita "Testar Conexão" apenas quando há credenciais persistidas.
  const canTest = !!settings?.hasEvolutionConfig && !testMutation.isPending;
  const isSaving = saveMutation.isPending;

  return (
    <div className="page-container space-y-6">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground flex items-center gap-2">
            <SettingsIcon className="w-6 h-6" />
            Configurações do Sistema
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Configurações globais aplicadas a todas as contas. Apenas Super
            Admin tem acesso.
          </p>
        </div>
      </div>

      {/* Card: Provedor Evolution */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                Provedor Evolution (WhatsApp)
              </CardTitle>
              <CardDescription>
                URL e API Key globais usadas por todas as contas para criar
                instâncias WhatsApp.
              </CardDescription>
            </div>
            {settings?.hasEvolutionConfig ? (
              <Badge
                variant="outline"
                className="bg-emerald-500/10 text-emerald-500 border-emerald-500/30 shrink-0"
              >
                Configurado
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="bg-amber-500/10 text-amber-500 border-amber-500/30 shrink-0"
              >
                Não configurado
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : isError ? (
            <div className="text-destructive text-sm">
              Erro ao carregar configurações:{' '}
              {(error as any)?.message || 'desconhecido'}
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="evolution-base-url">URL Base</Label>
                <Input
                  id="evolution-base-url"
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://evolution.exemplo.com"
                  autoComplete="off"
                  disabled={isSaving}
                />
                <p className="text-xs text-muted-foreground">
                  URL pública da sua instalação da Evolution API (sem barra no
                  final).
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="evolution-api-key">API Key</Label>
                <Input
                  id="evolution-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => handleApiKeyChange(e.target.value)}
                  onFocus={() => {
                    // Limpa o sentinel ao focar para o usuário não digitar
                    // por cima da string '***SET***'.
                    if (apiKey === MASKED_API_KEY) {
                      setApiKey('');
                      setApiKeyDirty(true);
                    }
                  }}
                  placeholder={
                    settings?.hasEvolutionConfig
                      ? '***SET*** (deixe em branco para manter)'
                      : '...'
                  }
                  autoComplete="off"
                  disabled={isSaving}
                />
                <p className="text-xs text-muted-foreground">
                  Chave global da Evolution. Já configurada? Deixe em branco
                  para manter a atual.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="evolution-webhook-url">
                  Webhook URL{' '}
                  <span className="text-muted-foreground font-normal">
                    (opcional)
                  </span>
                </Label>
                <Input
                  id="evolution-webhook-url"
                  type="url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://seu-crm.com"
                  autoComplete="off"
                  disabled={isSaving}
                />
                <p className="text-xs text-muted-foreground">
                  Endpoint público que recebe eventos da Evolution (mensagens,
                  status de conexão).
                </p>
              </div>

              <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => testMutation.mutate()}
                  disabled={!canTest}
                  className="gap-2"
                >
                  {testMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Plug className="w-4 h-4" />
                  )}
                  Testar Conexão
                </Button>
                <Button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaving}
                  className="gap-2"
                >
                  {isSaving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  Salvar
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Card: Como funciona */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Como funciona</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            Configure aqui a URL e API Key da sua Evolution. Todas as contas
            usarão esses dados.
          </p>
          <p>
            Admins de cada conta criarão suas próprias instâncias WhatsApp pela
            página de Inboxes da conta — sem precisar conhecer ou repetir
            essas credenciais.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
