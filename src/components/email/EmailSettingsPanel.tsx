import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Settings, CheckCircle, XCircle, Eye, EyeOff, Loader2, Play } from 'lucide-react';
import { emailService } from '@/services/email.service';

interface EmailSettings {
  hasOpenaiKey: boolean;
  hasSendgridKey: boolean;
  sendgridFromEmail: string;
  sendgridFromName: string;
}

export default function EmailSettingsPanel() {
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [processing, setProcessing] = useState(false);

  // Form
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [sendgridApiKey, setSendgridApiKey] = useState('');
  const [sendgridFromEmail, setSendgridFromEmail] = useState('');
  const [sendgridFromName, setSendgridFromName] = useState('');
  const [showOpenaiKey, setShowOpenaiKey] = useState(false);
  const [showSendgridKey, setShowSendgridKey] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const data = await emailService.getSettings();
      setSettings(data);
      setSendgridFromEmail(data.sendgridFromEmail);
      setSendgridFromName(data.sendgridFromName);
    } catch (err) {
      console.error('Erro ao carregar configurações:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const data: any = {
        sendgridFromEmail,
        sendgridFromName,
      };
      if (openaiApiKey) data.openaiApiKey = openaiApiKey;
      if (sendgridApiKey) data.sendgridApiKey = sendgridApiKey;

      await emailService.updateSettings(data);
      await loadSettings();
      setOpenaiApiKey('');
      setSendgridApiKey('');
      toast.success('Configurações salvas com sucesso!');
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao salvar configurações');
    } finally {
      setSaving(false);
    }
  };

  const handleTestSendgrid = async () => {
    const key = sendgridApiKey || (settings?.hasSendgridKey ? '__existing__' : '');
    if (!key || key === '__existing__') {
      toast.info('Insira a chave do SendGrid para testar.');
      return;
    }
    try {
      const result = await emailService.testSendgrid(key);
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (err: any) {
      toast.error('Erro ao testar conexão');
    }
  };

  const handleTestOpenai = async () => {
    const key = openaiApiKey;
    if (!key) {
      toast.info('Insira a chave da OpenAI para testar.');
      return;
    }
    try {
      const result = await emailService.testOpenai(key);
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (err: any) {
      toast.error('Erro ao testar conexão');
    }
  };

  const handleProcessQueue = async () => {
    setProcessing(true);
    try {
      const result = await emailService.processQueue();
      toast.success(`Fila processada! ${result.processed} enrollment(s) processado(s).`);
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao processar fila');
    } finally {
      setProcessing(false);
    }
  };

  if (loading) return null;

  return (
    <Card className="card-gradient border-border/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Settings className="w-5 h-5" />
            Configurações de E-mail
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={settings?.hasSendgridKey ? 'default' : 'destructive'} className="text-xs">
              {settings?.hasSendgridKey ? <CheckCircle className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
              SendGrid
            </Badge>
            <Badge variant={settings?.hasOpenaiKey ? 'default' : 'secondary'} className="text-xs">
              {settings?.hasOpenaiKey ? <CheckCircle className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
              OpenAI
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* SendGrid */}
        <div className="space-y-2">
          <label className="text-sm font-medium">SendGrid API Key</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showSendgridKey ? 'text' : 'password'}
                value={sendgridApiKey}
                onChange={(e) => setSendgridApiKey(e.target.value)}
                placeholder={settings?.hasSendgridKey ? '••••••••••• (configurada)' : 'SG.xxxx...'}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                onClick={() => setShowSendgridKey(!showSendgridKey)}
              >
                {showSendgridKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <Button variant="outline" size="sm" onClick={handleTestSendgrid} disabled={!sendgridApiKey}>
              Testar
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium">E-mail remetente</label>
            <Input
              value={sendgridFromEmail}
              onChange={(e) => setSendgridFromEmail(e.target.value)}
              placeholder="noreply@suaempresa.com"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Nome remetente</label>
            <Input
              value={sendgridFromName}
              onChange={(e) => setSendgridFromName(e.target.value)}
              placeholder="Sua Empresa"
            />
          </div>
        </div>

        {/* OpenAI */}
        <div className="space-y-2">
          <label className="text-sm font-medium">OpenAI API Key <span className="text-muted-foreground">(para IA)</span></label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showOpenaiKey ? 'text' : 'password'}
                value={openaiApiKey}
                onChange={(e) => setOpenaiApiKey(e.target.value)}
                placeholder={settings?.hasOpenaiKey ? '••••••••••• (configurada)' : 'sk-xxxx...'}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                onClick={() => setShowOpenaiKey(!showOpenaiKey)}
              >
                {showOpenaiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <Button variant="outline" size="sm" onClick={handleTestOpenai} disabled={!openaiApiKey}>
              Testar
            </Button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <Button onClick={handleSave} disabled={saving} className="flex-1">
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Salvar Configurações
          </Button>
          <Button variant="outline" onClick={handleProcessQueue} disabled={processing}>
            {processing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
            Processar Fila
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}