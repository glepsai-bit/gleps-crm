import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { accountsCloudOrBackend, usersCloudOrBackend } from '@/services';
import type { Account } from '@/services/accounts.cloud.service';
import { ChatwootAgent, User } from '@/types/crm';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Building2,
  Plus,
  Search,
  MoreHorizontal,
  Edit,
  Trash2,
  Users,
  Pause,
  Play,
  Eye,
  Loader2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  ArrowRight,
  ArrowLeft,
} from 'lucide-react';
import { safeFormatDateBR } from '@/utils/dateUtils';
import { toast } from 'sonner';
import { Skeleton } from '@/components/ui/skeleton';
import { ChatwootAgentImport, EmbeddedUserCreationForm, UserCreationData } from '@/components/chatwoot';

type AccountStatus = 'active' | 'paused' | 'cancelled';
type Language = 'pt' | 'en';
type ConnectionStatus = 'idle' | 'loading' | 'success' | 'error';
type WizardStep = 'form' | 'select-agents' | 'create-users';

interface ChatwootConnectionResult {
  agents: ChatwootAgent[];
  inboxes: Array<{ id: number; name: string; channel_type: string }>;
  labels: Array<{ id: number; title: string; color: string }>;
}

interface CreateFormData {
  nome: string;
  idioma: Language;
  status: AccountStatus;
  limiteAgentes: number;
  chatwootEnabled: boolean;
  chatwootBaseUrl: string;
  chatwootAccountId: string;
   chatwootApiKey: string;
   monthly_extraction_limit: number;
   monthly_email_limit: number;
   daily_email_limit: number;
   openaiEnabled: boolean;
   openaiApiKey: string;
   sendgridEnabled: boolean;
  sendgridApiKey: string;
  sendgridFromEmail: string;
  sendgridFromName: string;
}

const initialFormData: CreateFormData = {
  nome: '',
  idioma: 'pt',
  status: 'active',
  limiteAgentes: 10,
  chatwootEnabled: false,
  chatwootBaseUrl: 'https://app.chatwoot.com',
   chatwootAccountId: '',
   chatwootApiKey: '',
   monthly_extraction_limit: 100,
   monthly_email_limit: 3000,
   daily_email_limit: 100,
   openaiEnabled: false,
   openaiApiKey: '',
   sendgridEnabled: false,
  sendgridApiKey: '',
  sendgridFromEmail: '',
  sendgridFromName: '',
};

export default function SuperAdminAccountsPage() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<AccountStatus | 'all'>('all');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [deleteAccount, setDeleteAccount] = useState<Account | null>(null);
  const [deletePassword, setDeletePassword] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Form state
  const [formData, setFormData] = useState<CreateFormData>(initialFormData);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionResult, setConnectionResult] = useState<ChatwootConnectionResult | null>(null);

  // Edit modal connection state
  const [editConnectionStatus, setEditConnectionStatus] = useState<ConnectionStatus>('idle');
  const [editConnectionError, setEditConnectionError] = useState<string | null>(null);

  // Wizard state
  const [wizardStep, setWizardStep] = useState<WizardStep>('form');
  const [selectedAgentIds, setSelectedAgentIds] = useState<number[]>([]);
  const [createdAccountId, setCreatedAccountId] = useState<string | null>(null);
  const [currentAgentIndex, setCurrentAgentIndex] = useState(0);
  const [createdUsers, setCreatedUsers] = useState<User[]>([]);

  // Load accounts from database
  useEffect(() => {
    loadAccounts();
  }, []);

  const loadAccounts = async () => {
    try {
      setIsLoading(true);
      const data = await accountsCloudOrBackend.list();
      setAccounts(data);
    } catch (error: any) {
      toast.error('Erro ao carregar contas: ' + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  const filteredAccounts = accounts.filter((account) => {
    const term = searchTerm.toLowerCase();
    const matchesSearch = !term || 
      account.nome.toLowerCase().includes(term) ||
      account.id.toLowerCase().includes(term) ||
      (account.plano || '').toLowerCase().includes(term) ||
      (account.chatwoot_base_url || '').toLowerCase().includes(term);
    if (statusFilter === 'all') {
      return matchesSearch && account.status !== 'cancelled';
    }
    return matchesSearch && account.status === statusFilter;
  });

  const handleTestConnection = async () => {
    setConnectionStatus('loading');
    setConnectionError(null);
    setConnectionResult(null);
    setSelectedAgentIds([]);

    try {
      const result = await accountsCloudOrBackend.testChatwootConnection(
        formData.chatwootBaseUrl,
        formData.chatwootAccountId,
        formData.chatwootApiKey
      );

      if (result.success) {
        setConnectionStatus('success');
        // Map agents to ChatwootAgent type with proper role typing
        const agents: ChatwootAgent[] = (result.agents || []).map((a: any) => ({
          id: a.id,
          name: a.name,
          email: a.email,
          role: (a.role === 'administrator' ? 'administrator' : 'agent') as 'administrator' | 'agent',
          availability_status: a.availability_status as 'online' | 'busy' | 'offline' | undefined,
        }));
        setConnectionResult({
          agents,
          inboxes: result.inboxes || [],
          labels: result.labels || [],
        });
        toast.success(result.message);
      } else {
        setConnectionStatus('error');
        setConnectionError(result.message);
        toast.error(result.message);
      }
    } catch (e: any) {
      const msg = e?.message || 'Erro inesperado ao testar conexão';
      setConnectionStatus('error');
      setConnectionError(msg);
      toast.error(msg);
    }
  };

  // Step 1: Create account and move to agent selection
  const handleProceedToAgentImport = async () => {
    if (!formData.nome.trim()) {
      toast.error('Nome é obrigatório');
      return;
    }

    try {
      setIsSaving(true);
      
      // Create the account first
      const newAccount = await accountsCloudOrBackend.create({
        nome: formData.nome,
        chatwoot_base_url: formData.chatwootEnabled ? formData.chatwootBaseUrl : undefined,
       chatwoot_account_id: formData.chatwootEnabled ? formData.chatwootAccountId : undefined,
       chatwoot_api_key: formData.chatwootEnabled ? formData.chatwootApiKey : undefined,
       monthly_extraction_limit: formData.monthly_extraction_limit,
       monthly_email_limit: formData.monthly_email_limit,
       daily_email_limit: formData.daily_email_limit,
       openai_api_key: formData.openaiEnabled ? formData.openaiApiKey : undefined,
       sendgrid_api_key: formData.sendgridEnabled ? formData.sendgridApiKey : undefined,
        sendgrid_from_email: formData.sendgridEnabled ? formData.sendgridFromEmail : undefined,
        sendgrid_from_name: formData.sendgridEnabled ? formData.sendgridFromName : undefined,
      });
      
      setCreatedAccountId(newAccount.id);
      
      // If agents found, go to selection step
      if (connectionResult?.agents && connectionResult.agents.length > 0) {
        setWizardStep('select-agents');
        // Pre-select all agents
        setSelectedAgentIds(connectionResult.agents.map(a => a.id));
      } else {
        // No agents, finish
        await loadAccounts();
        closeAndReset();
        toast.success('Conta criada com sucesso!');
      }
    } catch (error: any) {
      toast.error('Erro ao criar conta: ' + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  // Step 1 alternative: Create account without agents
  const handleCreateWithoutAgents = async () => {
    if (!formData.nome.trim()) {
      toast.error('Nome é obrigatório');
      return;
    }

    try {
      setIsSaving(true);
      
      await accountsCloudOrBackend.create({
        nome: formData.nome,
        chatwoot_base_url: formData.chatwootEnabled ? formData.chatwootBaseUrl : undefined,
       chatwoot_account_id: formData.chatwootEnabled ? formData.chatwootAccountId : undefined,
       chatwoot_api_key: formData.chatwootEnabled ? formData.chatwootApiKey : undefined,
       monthly_extraction_limit: formData.monthly_extraction_limit,
       monthly_email_limit: formData.monthly_email_limit,
       daily_email_limit: formData.daily_email_limit,
       openai_api_key: formData.openaiEnabled ? formData.openaiApiKey : undefined,
       sendgrid_api_key: formData.sendgridEnabled ? formData.sendgridApiKey : undefined,
        sendgrid_from_email: formData.sendgridEnabled ? formData.sendgridFromEmail : undefined,
        sendgrid_from_name: formData.sendgridEnabled ? formData.sendgridFromName : undefined,
      });
      
      await loadAccounts();
      closeAndReset();
      toast.success('Conta criada com sucesso!');
    } catch (error: any) {
      toast.error('Erro ao criar conta: ' + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  // Step 2: Agent selection handlers
  const handleAgentSelectionProceed = () => {
    if (selectedAgentIds.length === 0) {
      toast.error('Selecione pelo menos um agente');
      return;
    }
    setCurrentAgentIndex(0);
    setCreatedUsers([]);
    setWizardStep('create-users');
  };

  const handleSkipAgentImport = async () => {
    // Account already created, just finish
    await loadAccounts();
    closeAndReset();
    toast.success('Conta criada com sucesso!');
  };

  // Step 3: User creation handlers
  const getSelectedAgents = (): ChatwootAgent[] => {
    if (!connectionResult?.agents) return [];
    return connectionResult.agents.filter(a => selectedAgentIds.includes(a.id));
  };

  const getCurrentAgent = (): ChatwootAgent | null => {
    const selectedAgents = getSelectedAgents();
    return selectedAgents[currentAgentIndex] || null;
  };

  const handleUserCreated = async (data: UserCreationData) => {
    const currentAgent = getCurrentAgent();
    if (!currentAgent || !createdAccountId) return;

    try {
      // Use the password provided by the user in the form
      await usersCloudOrBackend.create({
        email: currentAgent.email,
        nome: currentAgent.name,
        password: data.password,
        role: data.user.role,
        account_id: createdAccountId,
        chatwoot_agent_id: currentAgent.id,
        permissions: data.user.permissions || ['dashboard'],
      });
      
      setCreatedUsers(prev => [...prev, data.user]);
      
      // Move to next agent or finish
      const selectedAgents = getSelectedAgents();
      if (currentAgentIndex + 1 < selectedAgents.length) {
        setCurrentAgentIndex(currentAgentIndex + 1);
      } else {
        // All done
        await loadAccounts();
        toast.success(`${createdUsers.length + 1} usuário(s) criado(s) com sucesso!`);
        closeAndReset();
      }
    } catch (error: any) {
      const status = error?.status || error?.response?.status;
      if (status === 409) {
        toast.warning('Este email já está cadastrado. Pulando para o próximo agente.');
        handleSkipCurrentAgent();
        return;
      }
      toast.error(`Erro ao criar usuário: ${error.message}`);
    }
  };

  const handleSkipCurrentAgent = () => {
    const selectedAgents = getSelectedAgents();
    if (currentAgentIndex + 1 < selectedAgents.length) {
      setCurrentAgentIndex(currentAgentIndex + 1);
    } else {
      // All done
      loadAccounts();
      if (createdUsers.length > 0) {
        toast.success(`${createdUsers.length} usuário(s) criado(s) com sucesso!`);
      } else {
        toast.success('Conta criada com sucesso!');
      }
      closeAndReset();
    }
  };

  const closeAndReset = () => {
    setIsCreateOpen(false);
    resetForm();
  };

  const resetForm = () => {
    setFormData(initialFormData);
    setConnectionStatus('idle');
    setConnectionError(null);
    setConnectionResult(null);
    setSelectedAgentIds([]);
    setWizardStep('form');
    setCreatedAccountId(null);
    setCurrentAgentIndex(0);
    setCreatedUsers([]);
  };

  const handleUpdate = async () => {
    if (!editingAccount) return;

    try {
      setIsSaving(true);
      await accountsCloudOrBackend.update(editingAccount.id, {
        nome: editingAccount.nome,
        status: editingAccount.status,
        chatwoot_base_url: editingAccount.chatwoot_base_url,
         chatwoot_account_id: editingAccount.chatwoot_account_id,
         chatwoot_api_key: editingAccount.chatwoot_api_key,
         monthly_extraction_limit: (editingAccount as any).monthly_extraction_limit,
        monthly_email_limit: (editingAccount as any).monthly_email_limit,
        daily_email_limit: (editingAccount as any).daily_email_limit,
         openai_api_key: (editingAccount as any).openai_api_key,
         sendgrid_api_key: (editingAccount as any).sendgrid_api_key,
        sendgrid_from_email: (editingAccount as any).sendgrid_from_email,
        sendgrid_from_name: (editingAccount as any).sendgrid_from_name,
      });
      
      await loadAccounts();
      setEditingAccount(null);
      toast.success('Conta atualizada com sucesso!');
    } catch (error: any) {
      toast.error('Erro ao atualizar conta: ' + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteAccount || !deletePassword) {
      toast.error('Digite sua senha para confirmar!');
      return;
    }

    try {
      setIsSaving(true);
      await accountsCloudOrBackend.delete(deleteAccount.id, deletePassword);
      await loadAccounts();
      setDeleteAccount(null);
      setDeletePassword('');
      toast.success('Conta excluída com sucesso!');
    } catch (error: any) {
      toast.error('Erro ao excluir conta: ' + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleStatus = async (account: Account) => {
    const newStatus = account.status === 'active' ? 'paused' : 'active';
    
    try {
      await accountsCloudOrBackend.update(account.id, { status: newStatus });
      await loadAccounts();
      toast.success(`Conta ${newStatus === 'active' ? 'reativada' : 'pausada'} com sucesso!`);
    } catch (error: any) {
      toast.error('Erro ao alterar status: ' + error.message);
    }
  };

  const handleEditTestConnection = async () => {
    if (!editingAccount) return;
    
    setEditConnectionStatus('loading');
    setEditConnectionError(null);
    
    try {
      const result = await accountsCloudOrBackend.testChatwootConnection(
        editingAccount.chatwoot_base_url || '',
        editingAccount.chatwoot_account_id || '',
        editingAccount.chatwoot_api_key || ''
      );
      
      if (result.success) {
        setEditConnectionStatus('success');
        toast.success(result.message);
      } else {
        setEditConnectionStatus('error');
        setEditConnectionError(result.message);
        toast.error(result.message);
      }
    } catch (e: any) {
      setEditConnectionStatus('error');
      setEditConnectionError(e?.message || 'Erro inesperado');
      toast.error(e?.message || 'Erro ao testar conexão');
    }
  };

  const canTestEditConnection = editingAccount &&
    (editingAccount.chatwoot_base_url || '').trim() !== '' &&
    (editingAccount.chatwoot_account_id || '').trim() !== '' &&
    (editingAccount.chatwoot_api_key || '').trim() !== '';

  const canTestConnection = formData.chatwootEnabled && 
    formData.chatwootBaseUrl.trim() !== '' &&
    formData.chatwootAccountId.trim() !== '' && 
    formData.chatwootApiKey.trim() !== '';

  const currentAgent = getCurrentAgent();
  const selectedAgents = getSelectedAgents();

  return (
    <div className="page-container">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground">Contas</h1>
          <p className="text-xs sm:text-sm text-muted-foreground">Gerencie todas as contas do sistema</p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={(open) => {
          if (!open) resetForm();
          setIsCreateOpen(open);
        }}>
          <DialogTrigger asChild>
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2">
              <Plus className="w-4 h-4" />
              Nova Conta
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
            {/* Step 1: Account Form */}
            {wizardStep === 'form' && (
              <>
                <DialogHeader className="flex-shrink-0">
                  <DialogTitle>Criar Nova Conta</DialogTitle>
                  <DialogDescription>Adicione uma nova conta ao sistema</DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4 overflow-y-auto flex-1 px-1 py-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                  {/* Status */}
                  <div className="space-y-2">
                    <Label htmlFor="status">Status</Label>
                    <Select
                      value={formData.status}
                      onValueChange={(v) => setFormData({ ...formData, status: v as AccountStatus })}
                    >
                      <SelectTrigger id="status">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Ativa</SelectItem>
                        <SelectItem value="paused">Pausada</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                   <div className="grid grid-cols-2 gap-4">
                     {/* Limite de Agentes */}
                     <div className="space-y-2">
                       <Label htmlFor="limite">Limite de Agentes</Label>
                       <Input
                         id="limite"
                         type="number"
                         value={formData.limiteAgentes}
                         onChange={(e) => setFormData({ ...formData, limiteAgentes: parseInt(e.target.value) || 10 })}
                         min={1}
                       />
                     </div>

                     {/* Limite de Extrações */}
                     <div className="space-y-2">
                       <Label htmlFor="limite_extracao">Limite de Extrações</Label>
                       <Input
                         id="limite_extracao"
                         type="number"
                         value={formData.monthly_extraction_limit}
                         onChange={(e) => setFormData({ ...formData, monthly_extraction_limit: parseInt(e.target.value) || 0 })}
                         min={0}
                       />
                     </div>
                   </div>

                   {/* Limites de E-mail */}
                   <div className="grid grid-cols-2 gap-4">
                     <div className="space-y-2">
                       <Label htmlFor="limite_email_mensal">Limite de E-mails (mês)</Label>
                       <Input
                         id="limite_email_mensal"
                         type="number"
                         value={formData.monthly_email_limit}
                         onChange={(e) => setFormData({ ...formData, monthly_email_limit: parseInt(e.target.value) || 0 })}
                         min={0}
                       />
                       <p className="text-xs text-muted-foreground">Padrão: 3.000 e-mails/mês</p>
                     </div>
                     <div className="space-y-2">
                       <Label htmlFor="limite_email_diario">Limite de E-mails (dia)</Label>
                       <Input
                         id="limite_email_diario"
                         type="number"
                         value={formData.daily_email_limit}
                         onChange={(e) => setFormData({ ...formData, daily_email_limit: parseInt(e.target.value) || 0 })}
                         min={0}
                       />
                       <p className="text-xs text-muted-foreground">Padrão: 100 e-mails/dia</p>
                     </div>
                   </div>

                  {/* Nome - moved below for layout match */}
                  <div className="space-y-2">
                    <Label htmlFor="nome">Nome da Conta</Label>
                    <Input
                      id="nome"
                      value={formData.nome}
                      onChange={(e) => setFormData({ ...formData, nome: e.target.value })}
                      placeholder="Ex: Clínica Exemplo"
                    />
                  </div>

                  {/* Chatwoot Integration */}
                  <div className="space-y-4 rounded-lg border p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <Label htmlFor="chatwoot-toggle" className="text-sm font-medium">
                          Integração Chatwoot
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          Habilitar para sincronizar agentes do Chatwoot
                        </p>
                      </div>
                      <Switch
                        id="chatwoot-toggle"
                        checked={formData.chatwootEnabled}
                        onCheckedChange={(checked) => {
                          setFormData({ ...formData, chatwootEnabled: checked });
                          if (!checked) {
                            setConnectionStatus('idle');
                            setConnectionError(null);
                            setConnectionResult(null);
                          }
                        }}
                      />
                    </div>

                    {formData.chatwootEnabled && (
                      <div className="space-y-3 pt-2">
                        <div className="space-y-2">
                          <Label htmlFor="chatwootBaseUrl">URL da Instância</Label>
                          <Input
                            id="chatwootBaseUrl"
                            value={formData.chatwootBaseUrl}
                            onChange={(e) => {
                              setFormData({ ...formData, chatwootBaseUrl: e.target.value });
                              if (connectionStatus !== 'idle') {
                                setConnectionStatus('idle');
                                setConnectionError(null);
                                setConnectionResult(null);
                              }
                            }}
                            placeholder="https://app.chatwoot.com"
                          />
                          <p className="text-xs text-muted-foreground">
                            URL do Chatwoot Cloud ou da sua instância self-hosted
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="chatwootAccountId">Account ID</Label>
                          <Input
                            id="chatwootAccountId"
                            value={formData.chatwootAccountId}
                            onChange={(e) => {
                              setFormData({ ...formData, chatwootAccountId: e.target.value });
                              if (connectionStatus !== 'idle') {
                                setConnectionStatus('idle');
                                setConnectionError(null);
                                setConnectionResult(null);
                              }
                            }}
                            placeholder="ID da conta no Chatwoot"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="chatwootApiKey">API Key</Label>
                          <Input
                            id="chatwootApiKey"
                            type="password"
                            value={formData.chatwootApiKey}
                            onChange={(e) => {
                              setFormData({ ...formData, chatwootApiKey: e.target.value });
                              if (connectionStatus !== 'idle') {
                                setConnectionStatus('idle');
                                setConnectionError(null);
                                setConnectionResult(null);
                              }
                            }}
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
                          {connectionStatus === 'idle' && <RefreshCw className="w-4 h-4" />}
                          {connectionStatus === 'loading' ? 'Testando...' : 'Testar Conexão'}
                        </Button>

                        {connectionStatus === 'error' && connectionError && (
                          <p className="text-xs text-destructive">{connectionError}</p>
                        )}
                        
                        {connectionStatus === 'success' && connectionResult && (
                          <div className="space-y-2">
                            {/* Agents count indicator */}
                            <div className="flex items-center justify-center gap-2 p-2 rounded-md bg-muted/50 border">
                              <CheckCircle2 className="w-4 h-4 text-primary" />
                              <span className="text-sm font-medium">
                                {connectionResult.agents.length} agentes encontrados
                              </span>
                            </div>
                            
                            {/* Success message */}
                            <div className="rounded-md bg-emerald-500/10 border border-emerald-500/20 p-3">
                              <p className="text-sm font-medium text-emerald-600 flex items-center gap-2">
                                <CheckCircle2 className="w-4 h-4" />
                                Conexão estabelecida!
                              </p>
                              <p className="text-xs text-muted-foreground mt-1">
                                {connectionResult.agents.length} agentes encontrados no Chatwoot
                              </p>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* OpenAI Integration */}
                  <div className="space-y-4 rounded-lg border p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <Label htmlFor="create-openai-toggle" className="text-sm font-medium">
                          Integração OpenAI
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          Assistente de IA para geração de e-mails
                        </p>
                      </div>
                      <Switch
                        id="create-openai-toggle"
                        checked={formData.openaiEnabled}
                        onCheckedChange={(checked) => setFormData({ ...formData, openaiEnabled: checked })}
                      />
                    </div>
                    {formData.openaiEnabled && (
                      <div className="space-y-2">
                        <Label htmlFor="create-openai-key">API Key</Label>
                        <Input
                          id="create-openai-key"
                          type="password"
                          value={formData.openaiApiKey}
                          onChange={(e) => setFormData({ ...formData, openaiApiKey: e.target.value })}
                          placeholder="sk-..."
                        />
                      </div>
                    )}
                  </div>

                  {/* SendGrid Integration */}
                  <div className="space-y-4 rounded-lg border p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <Label htmlFor="create-sendgrid-toggle" className="text-sm font-medium">
                          Integração E-mail de Saída
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          Disparo de e-mails com rastreamento
                        </p>
                      </div>
                      <Switch
                        id="create-sendgrid-toggle"
                        checked={formData.sendgridEnabled}
                        onCheckedChange={(checked) => setFormData({ ...formData, sendgridEnabled: checked })}
                      />
                    </div>
                    {formData.sendgridEnabled && (
                      <div className="space-y-3">
                        <div className="space-y-2">
                          <Label htmlFor="create-sendgrid-key">API Key</Label>
                          <Input
                            id="create-sendgrid-key"
                            type="password"
                            value={formData.sendgridApiKey}
                            onChange={(e) => setFormData({ ...formData, sendgridApiKey: e.target.value })}
                            placeholder="SG...."
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="create-sendgrid-email">E-mail Remetente</Label>
                          <Input
                            id="create-sendgrid-email"
                            value={formData.sendgridFromEmail}
                            onChange={(e) => setFormData({ ...formData, sendgridFromEmail: e.target.value })}
                            placeholder="contato@empresa.com"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="create-sendgrid-name">Nome Remetente</Label>
                          <Input
                            id="create-sendgrid-name"
                            value={formData.sendgridFromName}
                            onChange={(e) => setFormData({ ...formData, sendgridFromName: e.target.value })}
                            placeholder="Minha Empresa"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <DialogFooter className="flex-shrink-0 gap-3">
                  <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
                    Cancelar
                  </Button>
                  
                  {connectionStatus === 'success' && connectionResult && connectionResult.agents.length > 0 ? (
                    <Button 
                      onClick={handleProceedToAgentImport} 
                      disabled={!formData.nome.trim() || isSaving}
                      className="gap-2"
                    >
                      {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                      Próximo: Importar Agentes
                      <ArrowRight className="w-4 h-4" />
                    </Button>
                  ) : (
                    <Button 
                      onClick={handleCreateWithoutAgents} 
                      disabled={!formData.nome.trim() || isSaving}
                    >
                      {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                      Criar Conta
                    </Button>
                  )}
                </DialogFooter>
              </>
            )}

            {/* Step 2: Agent Selection */}
            {wizardStep === 'select-agents' && connectionResult?.agents && (
              <>
                <DialogHeader className="flex-shrink-0">
                  <DialogTitle>Importar Agentes do Chatwoot</DialogTitle>
                  <DialogDescription>Selecione os agentes que deseja criar no CRM</DialogDescription>
                </DialogHeader>

                <div className="py-4 flex-1 overflow-hidden">
                  {/* Back button */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-2 mb-4"
                    onClick={() => setWizardStep('form')}
                  >
                    <ArrowLeft className="w-4 h-4" />
                    Voltar
                  </Button>

                  <ChatwootAgentImport
                    agents={connectionResult.agents}
                    selectedAgentIds={selectedAgentIds}
                    onSelectionChange={setSelectedAgentIds}
                    onProceed={handleAgentSelectionProceed}
                    onSkip={handleSkipAgentImport}
                  />
                </div>
              </>
            )}

            {/* Step 3: Create Users One by One */}
            {wizardStep === 'create-users' && currentAgent && createdAccountId && (
              <EmbeddedUserCreationForm
                agent={currentAgent}
                currentIndex={currentAgentIndex}
                totalAgents={selectedAgents.length}
                accountId={createdAccountId}
                onUserCreated={handleUserCreated}
                onSkip={handleSkipCurrentAgent}
              />
            )}
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as AccountStatus | 'all')}
            >
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="active">Ativas</SelectItem>
                <SelectItem value="paused">Pausadas</SelectItem>
                <SelectItem value="cancelled">Canceladas</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={loadAccounts} disabled={isLoading}>
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Accounts Table */}
      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center space-x-4">
                  <Skeleton className="h-12 w-12 rounded-full" />
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-4 w-[200px]" />
                    <Skeleton className="h-4 w-[150px]" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Conta</TableHead>
                  <TableHead>Usuários</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Chatwoot</TableHead>
                  <TableHead>Criado em</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAccounts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      Nenhuma conta encontrada
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredAccounts.map((account) => (
                    <TableRow key={account.id}>
                      <TableCell className="font-mono text-xs">
                        {account.id.substring(0, 8)}...
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                            <Building2 className="w-5 h-5 text-primary" />
                          </div>
                          <span className="font-medium">{account.nome}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Users className="w-4 h-4 text-muted-foreground" />
                          {account.users_count || 0}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={account.status === 'active' ? 'default' : account.status === 'cancelled' ? 'destructive' : 'secondary'}
                          className={
                            account.status === 'active'
                              ? 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20'
                              : account.status === 'cancelled'
                              ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20'
                              : 'bg-amber-500/10 text-amber-500 hover:bg-amber-500/20'
                          }
                        >
                          {account.status === 'active' ? 'Ativa' : account.status === 'cancelled' ? 'Cancelada' : 'Pausada'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {account.chatwoot_account_id ? (
                          <Badge variant="outline" className="text-xs">
                            ID: {account.chatwoot_account_id}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">Não configurado</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {safeFormatDateBR(account.created_at, "dd/MM/yyyy")}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Ações</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => navigate(`/super-admin/accounts/${account.id}`)}>
                              <Eye className="w-4 h-4 mr-2" />
                              Ver Detalhes
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setEditingAccount(account)}>
                              <Edit className="w-4 h-4 mr-2" />
                              Editar
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleToggleStatus(account)}>
                              {account.status === 'active' ? (
                                <>
                                  <Pause className="w-4 h-4 mr-2" />
                                  Pausar
                                </>
                              ) : (
                                <>
                                  <Play className="w-4 h-4 mr-2" />
                                  Reativar
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => setDeleteAccount(account)}
                              className="text-destructive"
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Excluir
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={!!editingAccount} onOpenChange={(open) => {
        if (!open) {
          setEditingAccount(null);
          setEditConnectionStatus('idle');
          setEditConnectionError(null);
        }
      }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>Editar Conta</DialogTitle>
            <DialogDescription>Atualize as informações da conta</DialogDescription>
          </DialogHeader>
          {editingAccount && (
            <div className="space-y-4 py-4 overflow-y-auto flex-1 px-1 py-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
              <div className="space-y-2">
                <Label htmlFor="edit-nome">Nome</Label>
                <Input
                  id="edit-nome"
                  value={editingAccount.nome}
                  onChange={(e) => setEditingAccount({ ...editingAccount, nome: e.target.value })}
                />
              </div>
               <div className="grid grid-cols-2 gap-4">
                 <div className="space-y-2">
                   <Label htmlFor="edit-status">Status</Label>
                   <Select
                     value={editingAccount.status}
                     onValueChange={(v) => setEditingAccount({ ...editingAccount, status: v as AccountStatus })}
                   >
                     <SelectTrigger id="edit-status">
                       <SelectValue />
                     </SelectTrigger>
                     <SelectContent>
                       <SelectItem value="active">Ativa</SelectItem>
                       <SelectItem value="paused">Pausada</SelectItem>
                     </SelectContent>
                   </Select>
                 </div>

                 <div className="space-y-2">
                   <Label htmlFor="edit-limite-extracao">Limite de Extrações</Label>
                   <Input
                     id="edit-limite-extracao"
                     type="number"
                     value={(editingAccount as any).monthly_extraction_limit ?? 100}
                     onChange={(e) => setEditingAccount({ ...editingAccount, monthly_extraction_limit: parseInt(e.target.value) || 0 } as any)}
                     min={0}
                   />
                 </div>
               </div>

              {/* Limites de E-mail */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-email-mensal">Limite de E-mails (mês)</Label>
                  <Input
                    id="edit-email-mensal"
                    type="number"
                    value={(editingAccount as any).monthly_email_limit ?? 3000}
                    onChange={(e) => setEditingAccount({ ...editingAccount, monthly_email_limit: parseInt(e.target.value) || 0 } as any)}
                    min={0}
                  />
                  <p className="text-xs text-muted-foreground">Padrão: 3.000/mês</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-email-diario">Limite de E-mails (dia)</Label>
                  <Input
                    id="edit-email-diario"
                    type="number"
                    value={(editingAccount as any).daily_email_limit ?? 100}
                    onChange={(e) => setEditingAccount({ ...editingAccount, daily_email_limit: parseInt(e.target.value) || 0 } as any)}
                    min={0}
                  />
                  <p className="text-xs text-muted-foreground">Padrão: 100/dia. Bloqueia se qualquer um dos dois limites estourar.</p>
                </div>
              </div>

              {/* Chatwoot Integration Section */}
              <div className="space-y-4 rounded-lg border p-4">
                <h4 className="text-sm font-medium">Integração Chatwoot</h4>
                
                <div className="space-y-2">
                  <Label htmlFor="edit-chatwoot-url">URL da Instância</Label>
                  <Input
                    id="edit-chatwoot-url"
                    value={editingAccount.chatwoot_base_url || ''}
                    onChange={(e) => setEditingAccount({ ...editingAccount, chatwoot_base_url: e.target.value })}
                    placeholder="https://app.chatwoot.com"
                  />
                  <p className="text-xs text-muted-foreground">URL do Chatwoot Cloud ou self-hosted</p>
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="edit-chatwoot-id">Account ID</Label>
                  <Input
                    id="edit-chatwoot-id"
                    value={editingAccount.chatwoot_account_id || ''}
                    onChange={(e) => setEditingAccount({ ...editingAccount, chatwoot_account_id: e.target.value })}
                    placeholder="Ex: 1"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="edit-chatwoot-api-key">API Key</Label>
                  <Input
                    id="edit-chatwoot-api-key"
                    type="password"
                    value={editingAccount.chatwoot_api_key || ''}
                    onChange={(e) => setEditingAccount({ ...editingAccount, chatwoot_api_key: e.target.value })}
                    placeholder="Cole sua API Key aqui"
                  />
                  <p className="text-xs text-muted-foreground">
                    Encontre em Configurações → Conta → Token de Acesso
                  </p>
                </div>
                
                {/* Test Connection Button */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleEditTestConnection}
                  disabled={!canTestEditConnection || editConnectionStatus === 'loading'}
                  className="w-full"
                >
                  {editConnectionStatus === 'loading' ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Testando...
                    </>
                  ) : editConnectionStatus === 'success' ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 mr-2 text-green-500" />
                      Conexão verificada!
                    </>
                  ) : editConnectionStatus === 'error' ? (
                    <>
                      <XCircle className="w-4 h-4 mr-2 text-red-500" />
                      Testar novamente
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2" />
                      Testar Conexão
                    </>
                  )}
                </Button>
                
                {/* Connection Status Feedback */}
                {editConnectionStatus === 'success' && (
                  <p className="text-sm text-green-600 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4" />
                    Conexão estabelecida com sucesso!
                  </p>
                )}
                {editConnectionStatus === 'error' && editConnectionError && (
                  <p className="text-sm text-red-600 flex items-center gap-2">
                    <XCircle className="w-4 h-4" />
                    {editConnectionError}
                  </p>
                )}
              </div>

              {/* OpenAI Integration */}
              <div className="space-y-4 rounded-lg border p-4">
                <h4 className="text-sm font-medium">Integração OpenAI</h4>
                <p className="text-xs text-muted-foreground">Assistente de IA para geração de e-mails</p>
                <div className="space-y-2">
                  <Label htmlFor="edit-openai-key">API Key</Label>
                  <Input
                    id="edit-openai-key"
                    type="password"
                    value={(editingAccount as any)?.openai_api_key || ''}
                    onChange={(e) => setEditingAccount({ ...editingAccount!, openai_api_key: e.target.value } as any)}
                    placeholder="sk-..."
                  />
                </div>
              </div>

              {/* SendGrid Integration */}
              <div className="space-y-4 rounded-lg border p-4">
                <h4 className="text-sm font-medium">E-mail de Saída</h4>
                <p className="text-xs text-muted-foreground">Disparo de e-mails com rastreamento</p>
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="edit-sendgrid-key">API Key</Label>
                    <Input
                      id="edit-sendgrid-key"
                      type="password"
                      value={(editingAccount as any)?.sendgrid_api_key || ''}
                      onChange={(e) => setEditingAccount({ ...editingAccount!, sendgrid_api_key: e.target.value } as any)}
                      placeholder="SG...."
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-sendgrid-email">E-mail Remetente</Label>
                    <Input
                      id="edit-sendgrid-email"
                      value={(editingAccount as any)?.sendgrid_from_email || ''}
                      onChange={(e) => setEditingAccount({ ...editingAccount!, sendgrid_from_email: e.target.value } as any)}
                      placeholder="contato@empresa.com"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-sendgrid-name">Nome Remetente</Label>
                    <Input
                      id="edit-sendgrid-name"
                      value={(editingAccount as any)?.sendgrid_from_name || ''}
                      onChange={(e) => setEditingAccount({ ...editingAccount!, sendgrid_from_name: e.target.value } as any)}
                      placeholder="Minha Empresa"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter className="flex-shrink-0 gap-3">
            <Button variant="outline" onClick={() => {
              setEditingAccount(null);
              setEditConnectionStatus('idle');
              setEditConnectionError(null);
            }}>
              Cancelar
            </Button>
            <Button onClick={handleUpdate} disabled={isSaving}>
              {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteAccount} onOpenChange={(open) => !open && setDeleteAccount(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir Conta</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir a conta "{deleteAccount?.nome}"? Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Label htmlFor="delete-password">Digite sua senha para confirmar</Label>
            <Input
              id="delete-password"
              type="password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              placeholder="Sua senha"
              className="mt-2"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeletePassword('')}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isSaving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
