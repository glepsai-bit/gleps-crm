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
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { safeFormatDateBR } from '@/utils/dateUtils';
import { toast } from 'sonner';

type AccountStatus = 'active' | 'paused' | 'cancelled';

interface EditFormData {
  nome: string;
  idioma: 'pt' | 'en';
  status: AccountStatus;
  chatwootEnabled: boolean;
  chatwootBaseUrl: string;
  chatwootAccountId: string;
  chatwootApiKey: string;
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

type ConnectionStatus = 'idle' | 'loading' | 'success' | 'error';

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
  const [updatePassword, setUpdatePassword] = useState('');
  const [isValidatingUpdate, setIsValidatingUpdate] = useState(false);
  const [editFormData, setEditFormData] = useState<EditFormData>({
    nome: '',
    idioma: 'pt',
    status: 'active',
    chatwootEnabled: false,
    chatwootBaseUrl: '',
    chatwootAccountId: '',
    chatwootApiKey: '',
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
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');

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
    setEditFormData({
      nome: account.nome,
      idioma: (account as any).idioma || 'pt',
      status: account.status,
      chatwootEnabled: !!(account.chatwoot_account_id || account.chatwoot_api_key || account.chatwoot_base_url),
      chatwootBaseUrl: account.chatwoot_base_url || '',
      chatwootAccountId: account.chatwoot_account_id || '',
      chatwootApiKey: account.chatwoot_api_key || '',
      googleEnabled: !!(account.google_client_id || account.google_client_secret || account.google_redirect_uri),
      googleClientId: account.google_client_id || '',
      googleClientSecret: account.google_client_secret || '',
      googleRedirectUri: account.google_redirect_uri || '',
      openaiEnabled: !!(account as any).openai_api_key,
      openaiApiKey: (account as any).openai_api_key || '',
      sendgridEnabled: !!((account as any).sendgrid_api_key),
      sendgridApiKey: (account as any).sendgrid_api_key || '',
      sendgridFromEmail: (account as any).sendgrid_from_email || '',
      sendgridFromName: (account as any).sendgrid_from_name || '',
    });
    setConnectionStatus('idle');
    setIsControlOpen(true);
  };

  const handleTestConnection = async () => {
    setConnectionStatus('loading');
    
    try {
      const result = await accountsCloudOrBackend.testChatwootConnection(
        editFormData.chatwootBaseUrl,
        editFormData.chatwootAccountId,
        editFormData.chatwootApiKey
      );
      
      if (result.success) {
        setConnectionStatus('success');
        const agentCount = result.agents?.length || 0;
        toast.success(`Conexão verificada! ${agentCount} agente(s) encontrado(s).`);
      } else {
        setConnectionStatus('error');
        toast.error(result.message || 'Falha na conexão com Chatwoot');
      }
    } catch (e: any) {
      setConnectionStatus('error');
      toast.error(e?.message || 'Erro inesperado ao testar conexão');
    }
  };

  const canTestConnection = editFormData.chatwootEnabled && 
    editFormData.chatwootBaseUrl.trim() !== '' &&
    editFormData.chatwootAccountId.trim() !== '' && 
    editFormData.chatwootApiKey.trim() !== '';

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
      await accountsCloudOrBackend.update(account.id, {
        nome: editFormData.nome,
        status: editFormData.status,
        chatwoot_base_url: editFormData.chatwootEnabled ? editFormData.chatwootBaseUrl : undefined,
        chatwoot_account_id: editFormData.chatwootEnabled ? editFormData.chatwootAccountId : undefined,
        chatwoot_api_key: editFormData.chatwootEnabled ? editFormData.chatwootApiKey : undefined,
        google_client_id: editFormData.googleEnabled ? editFormData.googleClientId : undefined,
        google_client_secret: editFormData.googleEnabled ? editFormData.googleClientSecret : undefined,
        google_redirect_uri: editFormData.googleEnabled ? editFormData.googleRedirectUri : undefined,
        openai_api_key: editFormData.openaiEnabled ? editFormData.openaiApiKey : undefined,
        sendgrid_api_key: editFormData.sendgridEnabled ? editFormData.sendgridApiKey : undefined,
        sendgrid_from_email: editFormData.sendgridEnabled ? editFormData.sendgridFromEmail : undefined,
        sendgrid_from_name: editFormData.sendgridEnabled ? editFormData.sendgridFromName : undefined,
      } as any);
      setAccount({
        ...account,
        nome: editFormData.nome,
        status: editFormData.status,
        chatwoot_base_url: editFormData.chatwootEnabled ? editFormData.chatwootBaseUrl : undefined,
        chatwoot_account_id: editFormData.chatwootEnabled ? editFormData.chatwootAccountId : undefined,
        chatwoot_api_key: editFormData.chatwootEnabled ? editFormData.chatwootApiKey : undefined,
        google_client_id: editFormData.googleEnabled ? editFormData.googleClientId : undefined,
        google_client_secret: editFormData.googleEnabled ? editFormData.googleClientSecret : undefined,
        google_redirect_uri: editFormData.googleEnabled ? editFormData.googleRedirectUri : undefined,
        updated_at: new Date().toISOString(),
      });
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

  const handleDelete = async () => {
    if (!deletePassword.trim()) {
      toast.error('Digite sua senha para confirmar!');
      return;
    }
    try {
      await accountsCloudOrBackend.delete(account.id, deletePassword);
      toast.success('Conta excluída com sucesso!');
      navigate('/super-admin/accounts');
    } catch (error: any) {
      toast.error('Erro ao excluir: ' + (error.message || 'Erro desconhecido'));
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
              <h1 className="text-lg sm:text-xl md:text-2xl font-bold text-foreground truncate">Conta + {account.nome}</h1>
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

      {/* Chatwoot Integration */}
      <Card className="card-gradient border-border/50">
        <CardHeader>
          <CardTitle className="text-lg">Integração Chatwoot</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="flex items-center justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground">Chatwoot Account ID</span>
              {account.chatwoot_account_id ? (
                <code className="text-sm font-mono bg-muted px-2 py-1 rounded">{account.chatwoot_account_id}</code>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">Não configurado</Badge>
              )}
            </div>
            <div className="flex items-center justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground">Chatwoot API Key</span>
              {account.chatwoot_api_key ? (
                <code className="text-sm font-mono bg-muted px-2 py-1 rounded">••••••••</code>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">Não configurado</Badge>
              )}
            </div>
          </div>
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
                    placeholder="sk-..."
                  />
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
                      placeholder="SG...."
                    />
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

            {/* Chatwoot Integration */}
            <div className="space-y-4 pt-4 border-t border-border/50">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="edit-chatwoot">Integração Chatwoot</Label>
                  <p className="text-xs text-muted-foreground">Habilitar para sincronizar agentes do Chatwoot</p>
                </div>
                <Switch
                  id="edit-chatwoot"
                  checked={editFormData.chatwootEnabled}
                  onCheckedChange={(checked) => {
                    setEditFormData({ ...editFormData, chatwootEnabled: checked });
                    if (!checked) setConnectionStatus('idle');
                  }}
                />
              </div>
              
              {editFormData.chatwootEnabled && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="edit-chatwoot-url">URL da Instância</Label>
                    <Input
                      id="edit-chatwoot-url"
                      value={editFormData.chatwootBaseUrl}
                      onChange={(e) => setEditFormData({ ...editFormData, chatwootBaseUrl: e.target.value })}
                      placeholder="https://app.chatwoot.com"
                    />
                    <p className="text-xs text-muted-foreground">
                      URL do Chatwoot Cloud ou da sua instância self-hosted
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-chatwoot-id">Account ID</Label>
                    <Input
                      id="edit-chatwoot-id"
                      value={editFormData.chatwootAccountId}
                      onChange={(e) => setEditFormData({ ...editFormData, chatwootAccountId: e.target.value })}
                      placeholder="ID da conta no Chatwoot"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-chatwoot-key">API Key</Label>
                    <Input
                      id="edit-chatwoot-key"
                      type="password"
                      value={editFormData.chatwootApiKey}
                      onChange={(e) => setEditFormData({ ...editFormData, chatwootApiKey: e.target.value })}
                      placeholder="Access Token do usuário"
                    />
                  </div>

                  {/* Test Connection Button */}
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full gap-2"
                    disabled={!canTestConnection || connectionStatus === 'loading'}
                    onClick={handleTestConnection}
                  >
                    {connectionStatus === 'loading' && (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    )}
                    {connectionStatus === 'success' && (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    )}
                    {connectionStatus === 'error' && (
                      <XCircle className="w-4 h-4 text-destructive" />
                    )}
                    {connectionStatus === 'idle' && (
                      <RefreshCw className="w-4 h-4" />
                    )}
                    {connectionStatus === 'loading' ? 'Testando...' : 'Testar Conexão e Buscar Agentes'}
                  </Button>
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
                      placeholder="GOCSPX-..."
                    />
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
            <Button variant="outline" onClick={() => setIsDeleteOpen(false)}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Excluir Permanentemente
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
