import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import { Sparkles, Send, Loader2, CheckCircle2, X, RotateCcw } from 'lucide-react';
import { emailService, type GeneratedEmail } from '@/services/email.service';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  email?: GeneratedEmail;
}

interface EmailAIChatProps {
  onApply: (email: GeneratedEmail) => void;
  onClose: () => void;
  context?: {
    leadName?: string;
    leadEmail?: string;
    stageName?: string;
    currentSubject?: string;
    currentBodyHtml?: string;
  };
}

export default function EmailAIChat({ onApply, onClose, context }: EmailAIChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastGenerated, setLastGenerated] = useState<GeneratedEmail | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const buildPrompt = (userMessage: string): string => {
    let prompt = userMessage;
    const parts: string[] = [];

    if (context?.leadName) parts.push(`Lead: ${context.leadName}`);
    if (context?.leadEmail) parts.push(`Email do lead: ${context.leadEmail}`);
    if (context?.stageName) parts.push(`Etapa do funil: ${context.stageName}`);

    if (context?.currentSubject || context?.currentBodyHtml) {
      parts.push(`\n--- E-mail atual (para referência/edição) ---`);
      if (context.currentSubject) parts.push(`Assunto: ${context.currentSubject}`);
      if (context.currentBodyHtml) parts.push(`HTML: ${context.currentBodyHtml}`);
    }

    if (lastGenerated) {
      parts.push(`\n--- Último e-mail gerado ---`);
      parts.push(`Assunto: ${lastGenerated.subject}`);
      parts.push(`HTML: ${lastGenerated.bodyHtml}`);
    }

    if (parts.length > 0) {
      prompt = `Contexto:\n${parts.join('\n')}\n\nInstrução do usuário: ${userMessage}`;
    }

    return prompt;
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
    };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const prompt = buildPrompt(text);
      const result = await emailService.generateEmail(prompt, {
        leadName: context?.leadName,
        leadEmail: context?.leadEmail,
        stageName: context?.stageName,
      });

      setLastGenerated(result);

      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Pronto! Gerei o e-mail com assunto: **"${result.subject}"**`,
        email: result,
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err: any) {
      const errorMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Erro ao gerar: ${err?.message || 'Verifique as configurações de IA.'}`,
      };
      setMessages(prev => [...prev, errorMsg]);
      toast.error('Erro ao gerar e-mail');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const quickPrompts = [
    'Reescreva mais curto e direto',
    'Torne o tom mais formal',
    'Adicione um CTA claro',
    'Mude para tom casual e amigável',
  ];

  return (
    <div className="flex flex-col h-full border-l border-border bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/20">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          <span className="font-semibold text-sm">Assistente de E-mail</span>
        </div>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-4" ref={scrollRef as any}>
        <div className="space-y-4">
          {messages.length === 0 && (
            <div className="text-center py-8">
              <Sparkles className="w-10 h-10 mx-auto mb-3 text-primary/40" />
              <p className="text-sm font-medium text-foreground">Como posso ajudar?</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-[250px] mx-auto">
                Descreva o e-mail que deseja criar e eu gero para você. Depois, peça ajustes até ficar perfeito.
              </p>
              <div className="mt-4 space-y-2">
                {[
                  'Crie um e-mail de apresentação para clínicas',
                  'E-mail de follow-up para lead que não respondeu',
                  'Convite para demonstração do produto',
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    className="block w-full text-left text-xs px-3 py-2 rounded-lg border border-border hover:bg-muted/50 transition-colors text-muted-foreground"
                    onClick={() => setInput(suggestion)}
                  >
                    "{suggestion}"
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[90%] rounded-xl px-3 py-2 text-sm ${
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/50 border border-border text-foreground'
              }`}>
                <p className="whitespace-pre-wrap">{msg.content}</p>

                {msg.email && (
                  <div className="mt-3 space-y-2">
                    {/* Email Preview Card */}
                    <div className="rounded-lg border border-border bg-background p-3 space-y-2">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium">Assunto:</span>
                        <span className="text-foreground">{msg.email.subject}</span>
                      </div>
                      <div
                        className="prose prose-sm max-w-none text-xs max-h-[150px] overflow-y-auto"
                        dangerouslySetInnerHTML={{ __html: msg.email.bodyHtml }}
                      />
                    </div>
                    <Button
                      size="sm"
                      className="w-full h-8 text-xs"
                      onClick={() => onApply(msg.email!)}
                    >
                      <CheckCircle2 className="w-3 h-3 mr-1" />
                      Aplicar este e-mail
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-muted/50 border border-border rounded-xl px-4 py-3">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Quick prompts */}
      {lastGenerated && !loading && (
        <div className="px-4 py-2 border-t border-border flex flex-wrap gap-1.5">
          {quickPrompts.map((p) => (
            <Badge
              key={p}
              variant="outline"
              className="cursor-pointer text-[10px] hover:bg-muted transition-colors"
              onClick={() => setInput(p)}
            >
              {p}
            </Badge>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="p-3 border-t border-border bg-muted/10">
        <div className="flex gap-2">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Descreva o e-mail ou peça alterações..."
            rows={2}
            className="resize-none text-sm flex-1"
          />
          <Button
            size="sm"
            className="self-end h-9 w-9 p-0"
            onClick={handleSend}
            disabled={loading || !input.trim()}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
