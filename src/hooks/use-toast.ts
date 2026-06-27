// Compatibility shim — antes existiam 2 stacks de toast (Radix `<Toaster />`
// em `@/components/ui/toaster` + Sonner). Eram montados em paralelo no App.tsx,
// gerando DOIS landmarks `region` ("Notifications (F8)" do Radix e
// "Notifications alt+T" do Sonner), confundindo leitor de tela e duplicando
// pilhas visuais.
//
// Decisão: manter UMA única implementação (Sonner). Mas vários componentes
// já usam `const { toast } = useToast(); toast({ title, description, variant })`,
// então mantemos esse hook como **adapter** para o Sonner — sem precisar
// reescrever 20+ call sites.
//
// Mapeamento:
//   toast({ title, description })                  -> sonner.toast(title, { description })
//   toast({ title, description, variant: 'destructive' }) -> sonner.toast.error(...)
//
// O `<Toaster />` Radix foi removido do App.tsx. Só o `<Sonner />` permanece.
import * as React from "react";
import { toast as sonnerToast, type ExternalToast } from "sonner";

// Tipo aproximado — mantém compat com call sites antigos (`variant`,
// `action`, etc.) sem importar o ToastProps do Radix.
type ToastVariant = "default" | "destructive" | "success" | "warning";

type ToastInput = {
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  duration?: number;
  // Mantido por compat — não há mapping 1:1 trivial para o `action` do Radix
  // (que aceita um JSX ToastActionElement). Sonner usa `{ label, onClick }`.
  // Se algum call site passar `action`, ignoramos silenciosamente — comportamento
  // anterior também já era frequentemente quebrado em mobile.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  action?: any;
  // Outros campos opcionais que o Radix aceitava — toleramos sem erro.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

function renderTitle(title?: React.ReactNode): string | React.ReactNode {
  if (title === null || title === undefined) return "";
  return title;
}

function toast(input: ToastInput) {
  const { title, description, variant, duration } = input;

  const options: ExternalToast = {};
  if (description !== undefined) options.description = description as string;
  if (duration !== undefined) options.duration = duration;

  const titleNode = renderTitle(title);

  let id: string | number;
  switch (variant) {
    case "destructive":
      id = sonnerToast.error(titleNode as string, options);
      break;
    case "success":
      id = sonnerToast.success(titleNode as string, options);
      break;
    case "warning":
      id = sonnerToast.warning(titleNode as string, options);
      break;
    default:
      id = sonnerToast(titleNode as string, options);
  }

  return {
    id: String(id),
    dismiss: () => sonnerToast.dismiss(id),
    update: (next: ToastInput) => {
      // Sonner não tem update in-place 1:1 — emitimos novo toast com mesmo id.
      sonnerToast.dismiss(id);
      toast(next);
    },
  };
}

function useToast() {
  return {
    // `toasts` vazio mantém a forma esperada pelo `<Toaster />` Radix legado
    // (que ainda existe como arquivo mas não é montado). Componentes que
    // só desestruturam `toast`/`dismiss` continuam funcionando.
    toasts: [] as Array<{ id: string; [key: string]: unknown }>,
    toast,
    dismiss: (toastId?: string | number) => {
      if (toastId === undefined) sonnerToast.dismiss();
      else sonnerToast.dismiss(toastId);
    },
  };
}

export { useToast, toast };
