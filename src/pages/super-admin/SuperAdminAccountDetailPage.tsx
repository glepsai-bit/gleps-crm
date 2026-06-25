import { useParams, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { accountsCloudOrBackend } from '@/services';
import type { Account as CloudAccount } from '@/services/accounts.cloud.service';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  ArrowLeft,
  Building2,
  Settings,
  Trash2,
  Users,
  Calendar,
  Clock,
  MessageSquare,
  DollarSign,
  Globe,
  UserCircle,
  Languages,
  Play,
  Pause,
  RefreshCw,
  Loader2,
  QrCode,
  Smartphone,
  Key,
  ChevronRight,
  AlertTriangle,
  Save,
  PowerOff,
} from 'lucide-react';
import { safeFormatDateBR } from '@/utils/dateUtils';
import { toast } from 'sonner';
import { apiClient } from '@/api/client';

type AccountStatus = 'active' | 'paused' | 'cancelled';

interface EditFormData {
  nome: string;
  idioma: 'pt' | 'en';
  status: AccountStatus;
  googleEnabled: boolean;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  openaiEnabled: boolean;
  openaiApiKey: string;
  sendgridEnabled: boolean;
  sendgridApiKey: string;
  sendgridFromEmail: string;
  sendgridFromName: string;
}

// Password validation is now done server-side via the backend API

export default function SuperAdminAccountDetailPage() {
  const { accountId } = useParams<{ accountId: string }>();
  const navigate = useNavigate();
  
  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isControlOpen, setIsControlOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isPasswordConfirmOpen, setIsPasswordConfirmOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDisconnectingWhatsapp, setIsDisconnectingWhatsapp] = useState(false);
  const [isPollingQrConnection, setIsPollingQrConnection] = useState(false);
  const [updatePassword, setUpdatePassword] = useState('');
  const [isValidatingUpdate, setIsValidatingUpdate] = useState(false);
  const [editFormData, setEditFormData] = useState<EditFormData>({
    nome: '',
    idioma: 'pt',
    status: 'active',
    googleEnabled: false,
    googleClientId: '',
    googleClientSecret: '',
    googleRedirectUri: '',
    openaiEnabled: false,
    openaiApiKey: '',
    sendgridEnabled: false,
    sendgridApiKey: '',
    sendgridFromEmail: '',
    sendgridFromName: '',
  });

  // Evolution API (WhatsApp) states
  const [evolutionBaseUrl, setEvolutionBaseUrl] = useState('');
  const [evolutionApiKey, setEvolutionApiKey] = useState('');
  const [evolutionInstance, setEvolutionInstance] = useState('');
  const [qrCodeBase64, setQrCodeBase64] = useState<string | null>(null);
  const [evolutionStatus, setEvolutionStatus] = useState<string | null>(null);
  const [isCheckingEvolutionStatus, setIsCheckingEvolutionStatus] = useState(false);
  const [isGeneratingQrCode, setIsGeneratingQrCode] = useState(false);
  const [isSavingEvolution, setIsSavingEvolution] = useState(false);

  // Fetch account data from Supabase
  useEffect(() => {
    const fetchAccount = async () => {
      if (!accountId) {
        setError('ID da conta não fornecido');
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        const accountData = await accountsCloudOrBackend.getById(accountId);
        setAccount(accountData);
        if (accountData) {
          // BUG-020: client-side masking — não popular o state com a chave.
          // Apenas URL e instance (não-secretos) entram no state.
          // TODO: futuro: backend retornar mask + flag hasKey
          setEvolutionBaseUrl((accountData as any).evolution_base_url || '');
          setEvolutionApiKey(''); // sempre vazio: placeholder mostra "•••• configurado"
          setEvolutionInstance((accountData as any).evolution_instance || '');
        }
        setError(null);
      } catch (err: any) {
        console.error('Error fetching account:', err);
        setError(err.message || 'Erro ao carregar conta');
      } finally {
        setIsLoading(false);
      }
    };

    fetchAccount();
  }, [accountId]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <Loader2 className="w-12 h-12 animate-spin text-primary" />
        <p className="text-muted-foreground">Carregando conta...</p>
      </div>
    );
  }

  // Error or not found state
  if (error || !account) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <Building2 className="w-16 h-16 text-muted-foreground" />
        <h2 className="text-2xl font-bold">Conta não encontrada</h2>
        <p className="text-muted-foreground">{error || `A conta com ID ${accountId} não existe.`}</p>
        <Button onClick={() => navigate('/super-admin/accounts')}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Voltar para Contas
        </Button>
      </div>
    );
  }

  // Get account stats from the account object
  const usersCount = account.users_count || 0;
  const accountId8 = account.id.substring(0, 8);



  const handleOpenControl = () => {
    // BUG-020: client-side masking — NÃO popular state com valores secretos.
    // Inputs de chave permanecem vazios; placeholder indica "•••• configurado".
    // No save, se input vazio, NÃO envia o campo (mantém valor existente no backend).
    // TODO: futuro: backend retornar mask + flag hasKey
    setEditFormData({
      nome: account.nome,
      idioma: (account as any).idioma || 'pt',
      status: account.status,
      googleEnabled: !!(account.google_client_id || account.google_client_secret || account.google_redirect_uri),
      googleClientId: account.google_client_id || '',
      googleClientSecret: '', // masked
      googleRedirectUri: account.google_redirect_uri || '',
      openaiEnabled: !!(account as any).openai_api_key,
      openaiApiKey: '', // masked
      sendgridEnabled: !!((account as any).sendgrid_api_key),
      sendgridApiKey: '', // masked
      sendgridFromEmail: (account as any).sendgrid_from_email || '',
      sendgridFromName: (account as any).sendgrid_from_name || '',
    });
    setIsControlOpen(true);
  };

  const handleToggleStatus = async () => {
    const newStatus = account.status === 'active' ? 'paused' : 'active';
    try {
      await accountsCloudOrBackend.update(account.id, { status: newStatus });
      setAccount({ ...account, status: newStatus, updated_at: new Date().toISOString() });
      toast.success(`Status alterado para ${newStatus === 'active' ? 'Ativa' : 'Pausada'}!`);
    } catch (error: any) {
      toast.error('Erro ao alterar status: ' + (error.message || 'Erro desconhecido'));
    }
  };

  const handleRequestUpdate = () => {
    setUpdatePassword('');
    setIsPasswordConfirmOpen(true);
  };

  const handleConfirmUpdate = async () => {
    if (!updatePassword.trim()) {
      toast.error('Digite sua senha para confirmar');
      return;
    }

    setIsValidatingUpdate(true);
    try {
      // BUG-020: campos de chave vazios NÃO são enviados — preserva valor existente.
      // Helper local: retorna o valor se preenchido, ou undefined (drop do payload).
      const keepOrSkip = (v: string): string | undefined =>
        v && v.trim() !== '' ? v : undefined;

      const payload: Record<string, any> = {
        nome: editFormData.nome,
        status: editFormData.status,
        google_client_id: editFormData.googleEnabled ? editFormData.googleClientId : undefined,
        google_client_secret: editFormData.googleEnabled ? keepOrSkip(editFormData.googleClientSecret) : undefined,
        google_redirect_uri: editFormData.googleEnabled ? editFormData.googleRedirectUri : undefined,
        openai_api_key: editFormData.openaiEnabled ? keepOrSkip(editFormData.openaiApiKey) : undefined,
        sendgrid_api_key: editFormData.sendgridEnabled ? keepOrSkip(editFormData.sendgridApiKey) : undefined,
        sendgrid_from_email: editFormData.sendgridEnabled ? editFormData.sendgridFromEmail : undefined,
        sendgrid_from_name: editFormData.sendgridEnabled ? editFormData.sendgridFromName : undefined,
        evolution_base_url: evolutionBaseUrl,
        evolution_api_key: keepOrSkip(evolutionApiKey),
        evolution_instance: evolutionInstance,
      };
      // Remove undefined explicitamente para não sobrescrever no backend
      Object.keys(payload).forEach((k) => {
        if (payload[k] === undefined) delete payload[k];
      });

      await accountsCloudOrBackend.update(account.id, payload as any);
      setAccount({
        ...account,
        nome: editFormData.nome,
        status: editFormData.status,
        // Mantém valores existentes para campos secretos quando vazios no form
        google_client_id: editFormData.googleEnabled ? editFormData.googleClientId : undefined,
        google_client_secret: editFormData.googleEnabled
          ? (keepOrSkip(editFormData.googleClientSecret) ?? account.google_client_secret)
          : undefined,
        google_redirect_uri: editFormData.googleEnabled ? editFormData.googleRedirectUri : undefined,
        evolution_base_url: evolutionBaseUrl,
        evolution_api_key: keepOrSkip(evolutionApiKey) ?? (account as any).evolution_api_key,
        evolution_instance: evolutionInstance,
        updated_at: new Date().toISOString(),
      } as any);
      setIsPasswordConfirmOpen(false);
      setIsControlOpen(false);
      toast.success('Conta atualizada com sucesso!');
    } catch (error: any) {
      toast.error('Erro ao atualizar: ' + (error.message || 'Erro desconhecido'));
    } finally {
      setIsValidatingUpdate(false);
    }
  };

  const getIdiomaLabel = (idioma: string) => {
    return idioma === 'pt' ? 'Português' : 'English';
  };

  const handleCheckEvolutionStatus = async () => {
    if (!account) return;
    setIsCheckingEvolutionStatus(true);
    try {
      const response = await apiClient.get<any>(`/api/evolution/accounts/${account.id}/status`);
      const state = response?.state ?? response?.status ?? response?.data?.state ?? response?.data?.status ?? 'unknown';
      setEvolutionStatus(String(state));
      toast.success(`Status Evolution: ${state}`);
    } catch (error: any) {
      setEvolutionStatus('error');
      toast.error('Erro ao verificar status: ' + (error?.message || 'Erro desconhecido'));
    } finally {
      setIsCheckingEvolutionStatus(false);
    }
  };

  // BUG-078: faz polling do status até state==='open' OU timeout 60s.
  const pollEvolutionConnection = async () => {
    if (!account) return;
    setIsPollingQrConnection(true);
    const POLL_INTERVAL_MS = 3000;
    const TIMEOUT_MS = 60000;
    const startedAt = Date.now();
    try {
      while (Date.now() - startedAt < TIMEOUT_MS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        try {
          const response = await apiClient.get<any>(`/api/evolution/accounts/${account.id}/status`);
          const state = response?.state ?? response?.status ?? response?.data?.state ?? response?.data?.status ?? 'unknown';
          setEvolutionStatus(String(state));
          if (String(state) === 'open') {
            toast.success('Conectado!');
            setQrCodeBase64(null);
            return;
          }
        } catch {
          // Continua tentando enquanto não estourar o timeout
        }
      }
      toast.error('Tempo esgotado aguardando conexão. Tente gerar o QR novamente.');
    } finally {
      setIsPollingQrConnection(false);
    }
  };

  const handleGenerateQrCode = async () => {
    if (!account) return;
    setIsGeneratingQrCode(true);
    try {
      const response = await apiClient.get<any>(`/api/evolution/accounts/${account.id}/qrcode`);
      // Backend returns { data: { qrcodeBase64, code, raw } }
      const base64 =
        response?.data?.qrcodeBase64 ??
        response?.data?.base64 ??
        response?.data?.qrcode ??
        response?.base64 ??
        response?.qrcode ??
        response?.qrCode ??
        null;
      if (base64) {
        const clean = String(base64).replace(/^data:image\/[a-z]+;base64,/i, '');
        setQrCodeBase64(clean);
        toast.success('QR Code gerado. Escaneie no WhatsApp.');
        // BUG-078: dispara polling do status logo após gerar QR.
        void pollEvolutionConnection();
      } else {
        toast.error('Resposta sem QR Code.');
      }
    } catch (error: any) {
      toast.error('Erro ao gerar QR Code: ' + (error?.message || 'Erro desconhecido'));
    } finally {
      setIsGeneratingQrCode(false);
    }
  };

  // BUG-058: desconecta o WhatsApp da Evolution para esta conta.
  const handleDisconnectWhatsapp = async () => {
    if (!account) return;
    setIsDisconnectingWhatsapp(true);
    try {
      await apiClient.post(`/api/evolution/accounts/${account.id}/disconnect`, {});
      setEvolutionStatus('close');
      setQrCodeBase64(null);
      toast.success('WhatsApp desconectado.');
    } catch (error: any) {
      toast.error('Erro ao desconectar WhatsApp: ' + (error?.message || 'Erro desconhecido'));
    } finally {
      setIsDisconnectingWhatsapp(false);
    }
  };

  // BUG-019: salvar credenciais Evolution diretamente do card, sem precisar abrir Controle.
  const handleSaveEvolutionCredentials = async () => {
    if (!account) return;
    setIsSavingEvolution(true);
    try {
      // BUG-020: chave vazia NÃO é enviada (preserva valor existente no backend).
      const payload: Record<string, any> = {
        evolution_base_url: evolutionBaseUrl,
        evolution_instance: evolutionInstance,
      };
      if (evolutionApiKey && evolutionApiKey.trim() !== '') {
        payload.evolution_api_key = evolutionApiKey;
      }

      await accountsCloudOrBackend.update(account.id, payload as any);
      setAccount({
        ...account,
        evolution_base_url: evolutionBaseUrl,
        evolution_instance: evolutionInstance,
        evolution_api_key:
          evolutionApiKey && evolutionApiKey.trim() !== ''
            ? evolutionApiKey
            : (account as any).evolution_api_key,
        updated_at: new Date().toISOString(),
      } as any);
      // Limpa o input de chave após salvar (volta para o estado "•••• configurado")
      setEvolutionApiKey('');
      toast.success('Credenciais salvas');
    } catch (error: any) {
      toast.error('Erro ao salvar credenciais: ' + (error?.message || 'Erro desconhecido'));
    } finally {
      setIsSavingEvolution(false);
    }
  };

  // BUG-019: detecta divergência entre state local e valores persistidos.
  // Para evolution_api_key: divergência só quando o usuário digitou algo (state não-vazio).
  const accountEvolutionBaseUrl = (account as any)?.evolution_base_url || '';
  const accountEvolutionInstance = (account as any)?.evolution_instance || '';
  const hasAccountEvolutionApiKey = !!(account as any)?.evolution_api_key;
  const evolutionHasDivergence =
    evolutionBaseUrl !== accountEvolutionBaseUrl ||
    evolutionInstance !== accountEvolutionInstance ||
    (evolutionApiKey.trim() !== '' && hasAccountEvolutionApiKey) ||
    (evolutionApiKey.trim() !== '' && !hasAccountEvolutionApiKey);

  const getEvolutionStatusVariant = (status: string | null): 'default' | 'secondary' | 'destructive' | 'outline' => {
    if (!status) return 'outline';
    if (status === 'open') return 'default';
    if (status === 'connecting') return 'secondary';
    if (status === 'close' || status === 'error') return 'destructive';
    return 'outline';
  };

  const handleDelete = async () => {
    if (!deletePassword.trim()) {
      toast.error('Digite sua senha para confirmar!');
      return;
    }
    setIsDeleting(true);
    try {
      await accountsCloudOrBackend.delete(account.id, deletePassword);
      toast.success('Conta excluída com sucesso!');
      navigate('/super-admin/accounts');
    } catch (error: any) {
      toast.error('Erro ao excluir: ' + (error.message || 'Erro desconhecido'));
    } finally {
      setIsDeleting(false);
    }
  };

  const getStatusBadge = (status: AccountStatus) => {
    switch (status) {
      case 'active':
        return <span className="status-active">Ativa</span>;
      case 'paused':
        return <span className="status-paused">Pausada</span>;
      case 'cancelled':
        return <span className="status-cancelled">Cancelada</span>;
    }
  };

  return (
    <div className="page-container">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 sm:gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/super-admin/accounts')} className="flex-shrink-0">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 min-w-0">
            <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Building2 className="w-5 h-5 sm:w-6 sm:h-6 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl md:text-2xl font-bold text-foreground truncate">{account.nome}</h1>
              <div className="flex flex-wrap items-center gap-2 mt-1">
                <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                  ID: {accountId8}...
                </code>
                {getStatusBadge(account.status)}
              </div>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button 
            variant={account.status === 'active' ? 'outline' : 'default'}
            onClick={handleToggleStatus}
            className="flex-1 sm:flex-initial"
            size="sm"
          >
            {account.status === 'active' ? (
              <>
                <Pause className="w-4 h-4 mr-2" />
                <span className="hidden xs:inline">Pausar</span>
                <span className="xs:hidden">Pausar</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                <span className="hidden xs:inline">Ativar</span>
                <span className="xs:hidden">Ativar</span>
              </>
            )}
          </Button>
          <Button variant="outline" onClick={handleOpenControl} className="flex-1 sm:flex-initial" size="sm">
            <Settings className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Controle</span>
          </Button>
          <Button variant="destructive" onClick={() => setIsDeleteOpen(true)} className="flex-1 sm:flex-initial" size="sm">
            <Trash2 className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Excluir</span>
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="card-gradient border-border/50">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <Users className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold">{usersCount}</p>
                <p className="text-xs text-muted-foreground">Usuários</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="card-gradient border-border/50">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-cyan-500/10 flex items-center justify-center">
                <UserCircle className="w-5 h-5 text-cyan-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">-</p>
                <p className="text-xs text-muted-foreground">Leads</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="card-gradient border-border/50">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-violet-500/10 flex items-center justify-center">
                <MessageSquare className="w-5 h-5 text-violet-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">-</p>
                <p className="text-xs text-muted-foreground">Conversas</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="card-gradient border-border/50">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                <DollarSign className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">
                  R$ 0,00
                </p>
                <p className="text-xs text-muted-foreground">Faturamento</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Account Details */}
      <div className="grid md:grid-cols-2 gap-6">
        <Card className="card-gradient border-border/50">
          <CardHeader>
            <CardTitle className="text-lg">Informações da Conta</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground">ID</span>
              <code className="text-sm font-mono bg-muted px-2 py-1 rounded">{accountId8}...</code>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground">Nome</span>
              <span className="font-medium">{account.nome}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground">Status</span>
              {getStatusBadge(account.status)}
            </div>
            <div className="flex items-center justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground flex items-center gap-2">
                <Languages className="w-4 h-4" />
                Idioma
              </span>
              <span>{getIdiomaLabel((account as any).idioma || 'pt')}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground">Timezone</span>
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-muted-foreground" />
                <span>{account.timezone}</span>
              </div>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground">Limite de Usuários</span>
              <span>{account.limite_usuarios}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="card-gradient border-border/50">
          <CardHeader>
            <CardTitle className="text-lg">Datas e Timestamps</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground flex items-center gap-2">
                <Calendar className="w-4 h-4" />
                Criado em
              </span>
              <span className="font-medium">
                {safeFormatDateBR(account.created_at, "dd 'de' MMMM 'de' yyyy")}
              </span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground flex items-center gap-2">
                <Clock className="w-4 h-4" />
                Hora de criação
              </span>
              <span>{safeFormatDateBR(account.created_at, 'HH:mm:ss')}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground flex items-center gap-2">
                <Calendar className="w-4 h-4" />
                Última atualização
              </span>
              <span className="font-medium">
                {safeFormatDateBR(account.updated_at, "dd 'de' MMMM 'de' yyyy")}
              </span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground flex items-center gap-2">
                <Clock className="w-4 h-4" />
                Hora da atualização
              </span>
              <span>{safeFormatDateBR(account.updated_at, 'HH:mm:ss')}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* API Keys */}
      <Card className="card-gradient border-border/50">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Key className="w-5 h-5" />
            API Keys
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Gere e gerencie as chaves de API usadas por integrações externas
            desta conta.
          </p>
          <Button
            variant="outline"
            onClick={() => navigate(`/super-admin/accounts/${accountId}/api-keys`)}
            className="gap-2 flex-shrink-0"
          >
            Gerenciar API Keys
            <ChevronRight className="w-4 h-4" />
          </Button>
        </CardContent>
      </Card>

      {/* Evolution API (WhatsApp) Integration */}
      <Card className="card-gradient border-border/50">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Smartphone className="w-5 h-5" />
            Evolution API (WhatsApp)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Wave 3: Evolution agora é global. Este card é override per-account (enterprise). */}
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Configuração movida para Configurações Globais</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                Evolution agora é configurado globalmente em <strong>Configurações do Sistema</strong>.
                Este card é apenas pra <strong>OVERRIDE per-account</strong> (uso enterprise).
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate('/super-admin/system-settings')}
                className="gap-2"
              >
                Ir pra Configurações Globais
                <ChevronRight className="w-4 h-4" />
              </Button>
            </AlertDescription>
          </Alert>
          <div className="grid md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="evolution-base-url">URL Base</Label>
              <Input
                id="evolution-base-url"
                value={evolutionBaseUrl}
                onChange={(e) => setEvolutionBaseUrl(e.target.value)}
                placeholder="https://evolution.exemplo.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="evolution-api-key">API Key</Label>
              <Input
                id="evolution-api-key"
                type="password"
                value={evolutionApiKey}
                onChange={(e) => setEvolutionApiKey(e.target.value)}
                placeholder={hasAccountEvolutionApiKey ? '•••• configurado' : 'API Key da Evolution'}
              />
              {hasAccountEvolutionApiKey && (
                <p className="text-xs text-muted-foreground">
                  Deixe em branco para manter a chave atual.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="evolution-instance">Instance Name</Label>
              <Input
                id="evolution-instance"
                value={evolutionInstance}
                onChange={(e) => setEvolutionInstance(e.target.value)}
                placeholder="nome-da-instancia"
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Configure URL, API Key e instance, clique em <strong>Salvar credenciais Evolution</strong> e
            use os botões abaixo para conectar o WhatsApp.
          </p>

          {/* BUG-019: aviso de divergência entre form e dados salvos */}
          {evolutionHasDivergence && (
            <Alert variant="default" className="border-amber-500/50 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Alterações não salvas</AlertTitle>
              <AlertDescription>
                Os campos da Evolution foram alterados mas ainda não foram salvos.
                Clique em <strong>Salvar credenciais Evolution</strong> antes de gerar o QR Code.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-2">
            {/* BUG-019: botão dedicado para salvar credenciais Evolution sem abrir Controle */}
            <Button
              variant="default"
              size="sm"
              onClick={handleSaveEvolutionCredentials}
              disabled={isSavingEvolution}
              className="gap-2"
            >
              {isSavingEvolution ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              Salvar credenciais Evolution
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCheckEvolutionStatus}
              disabled={isCheckingEvolutionStatus}
              className="gap-2"
            >
              {isCheckingEvolutionStatus ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              Verificar Status
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleGenerateQrCode}
              disabled={isGeneratingQrCode || isPollingQrConnection}
              className="gap-2"
            >
              {isGeneratingQrCode ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <QrCode className="w-4 h-4" />
              )}
              Gerar QR Code
            </Button>
            {/* BUG-058: desconectar WhatsApp com confirmação */}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={isDisconnectingWhatsapp}
                  className="gap-2"
                >
                  {isDisconnectingWhatsapp ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <PowerOff className="w-4 h-4" />
                  )}
                  Desconectar WhatsApp
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Desconectar WhatsApp?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Esta ação encerra a sessão atual da instância no Evolution.
                    Será necessário escanear um novo QR Code para reconectar.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={isDisconnectingWhatsapp}>Cancelar</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleDisconnectWhatsapp}
                    disabled={isDisconnectingWhatsapp}
                  >
                    Desconectar
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {evolutionStatus && (
              <Badge variant={getEvolutionStatusVariant(evolutionStatus)}>
                {evolutionStatus}
              </Badge>
            )}
            {/* BUG-078: indicador de polling pós-QR */}
            {isPollingQrConnection && (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" />
                Aguardando conexão...
              </span>
            )}
          </div>

          {qrCodeBase64 && (
            <div className="flex flex-col items-start gap-2 pt-2">
              <Label>QR Code (escaneie no WhatsApp)</Label>
              <img
                src={`data:image/png;base64,${qrCodeBase64}`}
                alt="QR Code Evolution"
                className="w-64 h-64 rounded border border-border bg-white p-2"
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Users List */}
      <Card className="card-gradient border-border/50">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Users className="w-5 h-5" />
            Usuários da Conta ({usersCount})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {usersCount === 0 ? (
            <p className="text-muted-foreground text-center py-4">Nenhum usuário vinculado a esta conta.</p>
          ) : (
            <p className="text-muted-foreground text-center py-4">
              {usersCount} usuário(s) vinculado(s). Acesse a página de Usuários para gerenciar.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Control Dialog */}
      <Dialog open={isControlOpen} onOpenChange={setIsControlOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>Controle de Conta</DialogTitle>
            <DialogDescription>Atualize os dados da conta</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4 overflow-y-auto flex-1 px-1">
            <div className="space-y-2">
              <Label htmlFor="edit-nome">Nome da Conta</Label>
              <Input
                id="edit-nome"
                value={editFormData.nome}
                onChange={(e) => setEditFormData({ ...editFormData, nome: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-idioma">Idioma</Label>
              <Select
                value={editFormData.idioma}
                onValueChange={(v) => setEditFormData({ ...editFormData, idioma: v as 'pt' | 'en' })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pt">Português</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-status">Status</Label>
              <Select
                value={editFormData.status}
                onValueChange={(v) => setEditFormData({ ...editFormData, status: v as AccountStatus })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Ativa</SelectItem>
                  <SelectItem value="paused">Pausada</SelectItem>
                  <SelectItem value="cancelled">Cancelada</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* OpenAI Integration */}
            <div className="space-y-4 pt-4 border-t border-border/50">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="edit-openai">Integração OpenAI</Label>
                  <p className="text-xs text-muted-foreground">Assistente de IA para geração de e-mails</p>
                </div>
                <Switch
                  id="edit-openai"
                  checked={editFormData.openaiEnabled}
                  onCheckedChange={(checked) => setEditFormData({ ...editFormData, openaiEnabled: checked })}
                />
              </div>
              {editFormData.openaiEnabled && (
                <div className="space-y-2">
                  <Label htmlFor="edit-openai-key">API Key</Label>
                  <Input
                    id="edit-openai-key"
                    type="password"
                    value={editFormData.openaiApiKey}
                    onChange={(e) => setEditFormData({ ...editFormData, openaiApiKey: e.target.value })}
                    placeholder={(account as any).openai_api_key ? '•••• configurado' : 'sk-...'}
                  />
                  {(account as any).openai_api_key && (
                    <p className="text-xs text-muted-foreground">
                      Deixe em branco para manter a chave atual.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* SendGrid Integration */}
            <div className="space-y-4 pt-4 border-t border-border/50">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="edit-sendgrid">Integração SendGrid</Label>
                  <p className="text-xs text-muted-foreground">Disparo de e-mails com rastreamento</p>
                </div>
                <Switch
                  id="edit-sendgrid"
                  checked={editFormData.sendgridEnabled}
                  onCheckedChange={(checked) => setEditFormData({ ...editFormData, sendgridEnabled: checked })}
                />
              </div>
              {editFormData.sendgridEnabled && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="edit-sendgrid-key">API Key</Label>
                    <Input
                      id="edit-sendgrid-key"
                      type="password"
                      value={editFormData.sendgridApiKey}
                      onChange={(e) => setEditFormData({ ...editFormData, sendgridApiKey: e.target.value })}
                      placeholder={(account as any).sendgrid_api_key ? '•••• configurado' : 'SG....'}
                    />
                    {(account as any).sendgrid_api_key && (
                      <p className="text-xs text-muted-foreground">
                        Deixe em branco para manter a chave atual.
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-sendgrid-email">E-mail Remetente</Label>
                    <Input
                      id="edit-sendgrid-email"
                      value={editFormData.sendgridFromEmail}
                      onChange={(e) => setEditFormData({ ...editFormData, sendgridFromEmail: e.target.value })}
                      placeholder="contato@empresa.com"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-sendgrid-name">Nome Remetente</Label>
                    <Input
                      id="edit-sendgrid-name"
                      value={editFormData.sendgridFromName}
                      onChange={(e) => setEditFormData({ ...editFormData, sendgridFromName: e.target.value })}
                      placeholder="Minha Empresa"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Google Calendar Integration */}
            <div className="space-y-4 pt-4 border-t border-border/50">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="edit-google">Google Calendar</Label>
                  <p className="text-xs text-muted-foreground">Habilitar OAuth do Google Calendar para esta conta</p>
                </div>
                <Switch
                  id="edit-google"
                  checked={editFormData.googleEnabled}
                  onCheckedChange={(checked) => setEditFormData({ ...editFormData, googleEnabled: checked })}
                />
              </div>
              
              {editFormData.googleEnabled && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="edit-google-client-id">Client ID</Label>
                    <Input
                      id="edit-google-client-id"
                      value={editFormData.googleClientId}
                      onChange={(e) => setEditFormData({ ...editFormData, googleClientId: e.target.value })}
                      placeholder="xxxx.apps.googleusercontent.com"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-google-client-secret">Client Secret</Label>
                    <Input
                      id="edit-google-client-secret"
                      type="password"
                      value={editFormData.googleClientSecret}
                      onChange={(e) => setEditFormData({ ...editFormData, googleClientSecret: e.target.value })}
                      placeholder={account.google_client_secret ? '•••• configurado' : 'GOCSPX-...'}
                    />
                    {account.google_client_secret && (
                      <p className="text-xs text-muted-foreground">
                        Deixe em branco para manter a chave atual.
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-google-redirect-uri">Redirect URI</Label>
                    <Input
                      id="edit-google-redirect-uri"
                      value={editFormData.googleRedirectUri}
                      onChange={(e) => setEditFormData({ ...editFormData, googleRedirectUri: e.target.value })}
                      placeholder="https://seudominio.com/api/calendar/google/callback"
                    />
                    <p className="text-xs text-muted-foreground">
                      Deve corresponder ao URI autorizado no Google Cloud Console
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setIsControlOpen(false)} className="w-full sm:w-auto">
              Cancelar
            </Button>
            <Button onClick={handleRequestUpdate} className="w-full sm:w-auto">Salvar Alterações</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">Excluir Conta</DialogTitle>
            <DialogDescription>
              Esta ação é irreversível. Digite sua senha de Super Admin para confirmar.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">
              Você está prestes a excluir a conta:{' '}
              <strong className="text-foreground">{account.nome}</strong>
            </p>
            <div className="space-y-2">
              <Label htmlFor="delete-password">Senha do Super Admin</Label>
              <Input
                id="delete-password"
                type="password"
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                placeholder="Digite sua senha"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteOpen(false)} disabled={isDeleting}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting || !deletePassword.trim()}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Excluindo...
                </>
              ) : (
                'Excluir Permanentemente'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Password Confirmation Dialog for Update */}
      <Dialog open={isPasswordConfirmOpen} onOpenChange={setIsPasswordConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirmar Atualização</DialogTitle>
            <DialogDescription>
              Digite sua senha para confirmar as alterações na conta.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="p-3 rounded-lg bg-muted/50 border border-border/50">
              <p className="text-sm text-muted-foreground">
                Conta: <strong className="text-foreground">{account.nome}</strong>
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="update-password">Senha do Super Admin</Label>
              <Input
                id="update-password"
                type="password"
                value={updatePassword}
                onChange={(e) => setUpdatePassword(e.target.value)}
                placeholder="Digite sua senha"
                onKeyDown={(e) => e.key === 'Enter' && handleConfirmUpdate()}
                disabled={isValidatingUpdate}
              />
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button 
              variant="outline" 
              onClick={() => setIsPasswordConfirmOpen(false)}
              disabled={isValidatingUpdate}
              className="w-full sm:w-auto"
            >
              Cancelar
            </Button>
            <Button 
              onClick={handleConfirmUpdate}
              disabled={isValidatingUpdate || !updatePassword.trim()}
              className="w-full sm:w-auto"
            >
              {isValidatingUpdate ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Validando...
                </>
              ) : (
                'Confirmar Alterações'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
