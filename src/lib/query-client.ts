/**
 * CRITICAL #3: QueryClient global com handlers default de erro.
 *
 * PROBLEMA original: erros de fetch (5xx, network down) iam SO pro console.
 * Nenhum toast, nenhum sinal visual — usuario achava que estava carregando
 * ou clicava botoes sem entender que o backend caiu.
 *
 * SOLUCAO: usar QueryCache/MutationCache.onError do TanStack Query v5 para
 * disparar um toast (sonner) sempre que uma query/mutation falhar, com
 * exceções controladas:
 *   - 404: silenciado (recursos opcionais frequentemente retornam 404 esperado)
 *   - 401: silenciado (interceptor de auth em src/api/client.ts já trata
 *          via 'auth:unauthorized' + redirect /login)
 *   - mutation.options.onError customizado: silenciado (o caller já cuida)
 *   - meta.silenceErrors === true: silenciado (escape hatch caso-a-caso)
 *
 * O shape do erro segue ApiError de src/api/client.ts: { status, message, ... }.
 */
import { QueryCache, QueryClient, MutationCache } from '@tanstack/react-query';
import { toast } from 'sonner';

interface MaybeApiError {
  status?: number;
  message?: string;
}

function shouldSilenceByStatus(err: unknown): boolean {
  const e = err as MaybeApiError | null | undefined;
  if (!e) return true;
  if (e.status === 404) return true;
  if (e.status === 401) return true;
  return false;
}

function extractMessage(err: unknown, fallback: string): string {
  const e = err as MaybeApiError | null | undefined;
  if (e && typeof e.message === 'string' && e.message.trim().length > 0) {
    return e.message;
  }
  return fallback;
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Mantemos retry default do v5 (3) — apenas suprimimos retry para
        // 4xx que nao adianta tentar de novo.
        retry: (failureCount, error) => {
          const status = (error as MaybeApiError)?.status;
          if (status && status >= 400 && status < 500) return false;
          return failureCount < 3;
        },
      },
    },
    queryCache: new QueryCache({
      onError: (error, query) => {
        // Escape hatch: query pode setar meta.silenceErrors=true
        if (query.meta?.silenceErrors === true) return;
        if (shouldSilenceByStatus(error)) return;
        toast.error('Erro ao carregar dados', {
          description: extractMessage(error, 'Verifique sua conexao e tente novamente'),
        });
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _vars, _context, mutation) => {
        // Se a mutation declarou seu proprio onError, NAO disparamos o
        // default — evita toast duplicado quando o caller ja exibe um
        // feedback customizado.
        if (mutation.options.onError) return;
        // Escape hatch via meta tambem disponivel pra mutations
        if (mutation.meta?.silenceErrors === true) return;
        if (shouldSilenceByStatus(error)) return;
        toast.error('Erro na operacao', {
          description: extractMessage(error, 'Tente novamente em instantes'),
        });
      },
    }),
  });
}
