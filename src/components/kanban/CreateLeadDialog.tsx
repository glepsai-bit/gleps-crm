import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { Loader2, UserPlus } from 'lucide-react';
import { useBackend } from '@/config/backend.config';
import { contactsBackendService } from '@/services/contacts.backend.service';
import { contactsCloudService } from '@/services/contacts.cloud.service';
import type { ContactOrigin } from '@/types/crm';
import type { Tag as CloudTag } from '@/services/tags.cloud.service';

const formSchema = z.object({
  nome: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  telefone: z
    .string()
    .min(10, 'Telefone deve ter pelo menos 10 dígitos')
    .regex(/^[\d\s\-\+\(\)]+$/, 'Telefone inválido'),
  email: z.string().email('Email inválido').optional().or(z.literal('')),
  origem: z.enum(['whatsapp', 'instagram', 'site', 'indicacao', 'outro'] as const),
  initial_stage_id: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

interface CreateLeadDialogProps {
  accountId: string;
  stages: CloudTag[];
  trigger?: React.ReactNode;
  onLeadCreated?: () => void;
}

export function CreateLeadDialog({
  accountId,
  stages,
  trigger,
  onLeadCreated,
}: CreateLeadDialogProps) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Get the first stage ID when stages are available
  const defaultStageId = stages.length > 0 ? stages[0].id : undefined;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      nome: '',
      telefone: '',
      email: '',
      origem: 'whatsapp',
      initial_stage_id: defaultStageId,
    },
  });

  // Reset form with correct initial_stage_id when dialog opens
  useEffect(() => {
    if (open && stages.length > 0) {
      form.reset({
        nome: '',
        telefone: '',
        email: '',
        origem: 'whatsapp',
        initial_stage_id: stages[0].id,
      });
    }
  }, [open, stages, form]);

  const onSubmit = async (values: FormValues) => {
    setIsSubmitting(true);

    try {
      const service = useBackend ? contactsBackendService : contactsCloudService;
      const result = await service.createContact({
        account_id: accountId,
        nome: values.nome,
        telefone: values.telefone,
        email: values.email || undefined,
        origem: values.origem as ContactOrigin,
      });

      if (!result.success) {
        toast.error(result.error || 'Erro ao criar lead');
        return;
      }

      // Apply initial stage tag if selected
      if (values.initial_stage_id && result.contact_id) {
        await service.applyStageTagToContact(
          result.contact_id,
          values.initial_stage_id,
          'kanban'
        );
      }

      toast.success('Lead criado com sucesso!');

      // Reset form and close
      form.reset();
      setOpen(false);
      onLeadCreated?.();
    } catch (error: any) {
      console.error('[CreateLeadDialog] Error:', error);
      toast.error(error.message || 'Erro ao criar lead');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="default" size="sm" className="gap-2">
            <UserPlus className="w-4 h-4" />
            Novo Lead
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adicionar Novo Lead</DialogTitle>
          <DialogDescription>
            Cadastre um novo lead no CRM.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            autoComplete="off"
            className="flex flex-col flex-1 min-h-0 gap-4"
          >
            <div className="space-y-4 flex-1 overflow-y-auto pr-2 -mr-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            <FormField
              control={form.control}
              name="nome"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nome *</FormLabel>
                  <FormControl>
                    <Input placeholder="Nome do cliente" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="telefone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Telefone *</FormLabel>
                  <FormControl>
                    <Input placeholder="+55 11 99999-9999" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input type="email" placeholder="email@exemplo.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="origem"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Origem</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Selecione a origem" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="whatsapp">WhatsApp</SelectItem>
                      <SelectItem value="instagram">Instagram</SelectItem>
                      <SelectItem value="site">Site</SelectItem>
                      <SelectItem value="indicacao">Indicação</SelectItem>
                      <SelectItem value="outro">Outro</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {stages.length > 0 && (
              <FormField
                control={form.control}
                name="initial_stage_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Etapa Inicial</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Selecione a etapa" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {stages.map((stage) => (
                          <SelectItem key={stage.id} value={stage.id}>
                            <div className="flex items-center gap-2">
                              <div
                                className="w-3 h-3 rounded-full"
                                style={{ backgroundColor: stage.color }}
                              />
                              {stage.name}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            </div>

            <DialogFooter className="gap-3 sm:gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
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
                  'Adicionar Lead'
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
