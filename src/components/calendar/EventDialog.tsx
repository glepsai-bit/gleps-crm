import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { format } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { Loader2, CalendarPlus } from 'lucide-react';
import { useCalendar } from '@/contexts/CalendarContext';
import { useBackend } from '@/config/backend.config';
import { financeBackendService } from '@/services/finance.backend.service';
import { useAuth } from '@/contexts/AuthContext';
import type { EventType, CreateEventDTO } from '@/types/calendar';

// Validacao: data >= hoje (apenas dia, ignora hora)
const formSchema = z
  .object({
    titulo: z.string().min(2, 'Titulo deve ter pelo menos 2 caracteres'),
    data: z.string().min(1, 'Data e obrigatoria'),
    horaInicio: z.string().min(1, 'Hora de inicio e obrigatoria'),
    horaFim: z.string().min(1, 'Hora de fim e obrigatoria'),
    type: z.enum(['meeting', 'appointment', 'block', 'other'] as const),
    descricao: z.string().optional(),
    atendente: z.string().optional(),
    contactId: z.string().optional(),
  })
  .superRefine((vals, ctx) => {
    // data >= hoje
    if (vals.data) {
      const [y, m, d] = vals.data.split('-').map(Number);
      const dataSelecionada = new Date(y, (m || 1) - 1, d || 1);
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      if (dataSelecionada < hoje) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['data'],
          message: 'A data deve ser hoje ou no futuro',
        });
      }
    }
    // horaFim > horaInicio
    if (vals.horaInicio && vals.horaFim && vals.horaFim <= vals.horaInicio) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['horaFim'],
        message: 'Hora final deve ser maior que a inicial',
      });
    }
  });

type FormValues = z.infer<typeof formSchema>;

interface EventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ContactOption {
  id: string;
  nome: string;
}

export function EventDialog({ open, onOpenChange }: EventDialogProps) {
  const { createEvent } = useCalendar();
  const { user } = useAuth();
  const accountId = (user as { account_id?: string; accountId?: string } | null)
    ?.account_id ?? (user as { accountId?: string } | null)?.accountId;

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [contacts, setContacts] = useState<ContactOption[]>([]);

  const today = useMemo(() => format(new Date(), 'yyyy-MM-dd'), []);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      titulo: '',
      data: today,
      horaInicio: '09:00',
      horaFim: '10:00',
      type: 'meeting',
      descricao: '',
      atendente: '',
      contactId: 'none',
    },
  });

  // Reset form ao abrir
  useEffect(() => {
    if (open) {
      form.reset({
        titulo: '',
        data: today,
        horaInicio: '09:00',
        horaFim: '10:00',
        type: 'meeting',
        descricao: '',
        atendente: '',
        contactId: 'none',
      });
    }
  }, [open, today, form]);

  // Carregar leads/contatos para o seletor (best-effort, opcional)
  useEffect(() => {
    if (!open || !useBackend || !accountId) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await financeBackendService.fetchContacts(accountId);
        if (!cancelled) {
          setContacts(
            list.map((c) => ({ id: c.id, nome: c.nome || 'Sem nome' }))
          );
        }
      } catch (err) {
        console.warn('[EventDialog] Falha ao carregar contatos', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, accountId]);

  const onSubmit = async (values: FormValues) => {
    if (!values.data) {
      toast.error('Selecione uma data');
      return;
    }
    setIsSubmitting(true);
    try {
      const startIso = new Date(`${values.data}T${values.horaInicio}:00`).toISOString();
      const endIso = new Date(`${values.data}T${values.horaFim}:00`).toISOString();

      const dto: CreateEventDTO = {
        title: values.titulo,
        start: startIso,
        end: endIso,
        type: values.type as EventType,
        meetingType: 'online',
        notes: values.descricao || undefined,
        contactId:
          values.contactId && values.contactId !== 'none'
            ? values.contactId
            : undefined,
        attendeeEmails: values.atendente
          ? values.atendente
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
      };

      await createEvent(dto);
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao criar evento';
      console.error('[EventDialog] erro createEvent:', err);
      toast.error(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="w-5 h-5 text-primary" />
            Novo Evento
          </DialogTitle>
          <DialogDescription>
            Crie um novo evento na agenda. Caso o Google Calendar esteja
            conectado, ele sera sincronizado automaticamente.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} autoComplete="off">
            <div className="space-y-4 max-h-[60dvh] overflow-y-auto px-1 py-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
              <FormField
                control={form.control}
                name="titulo"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Titulo *</FormLabel>
                    <FormControl>
                      <Input placeholder="Reuniao com cliente" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="data"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Data *</FormLabel>
                    <FormControl>
                      <Input type="date" min={today} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="horaInicio"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Inicio *</FormLabel>
                      <FormControl>
                        <Input type="time" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="horaFim"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Fim *</FormLabel>
                      <FormControl>
                        <Input type="time" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tipo</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Selecione o tipo" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="meeting">Reuniao</SelectItem>
                        <SelectItem value="appointment">Compromisso</SelectItem>
                        <SelectItem value="block">Bloqueio</SelectItem>
                        <SelectItem value="other">Outro</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="atendente"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Atendente(s)</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="email1@ex.com, email2@ex.com"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {contacts.length > 0 && (
                <FormField
                  control={form.control}
                  name="contactId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Lead</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value || 'none'}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Selecione o lead" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">Nenhum</SelectItem>
                          {contacts.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.nome}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="descricao"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Descricao</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Detalhes do evento"
                        rows={3}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter className="gap-3 sm:gap-3 pt-4 mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Criando...
                  </>
                ) : (
                  'Criar Evento'
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
