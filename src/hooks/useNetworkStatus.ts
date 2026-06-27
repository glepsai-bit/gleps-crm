/**
 * CRITICAL #3 (parte 2): detector global de status de conexao.
 *
 * Sem isso, quando o usuario perdia a conexao, as queries do TanStack
 * Query falhavam silenciosamente (ou ficavam pendentes ate timeout) e
 * nenhum aviso visual era exibido — o usuario ficava clicando botoes
 * sem entender por que nada respondia.
 *
 * Esta hook adiciona listeners aos eventos 'online'/'offline' do window
 * e dispara um toast sonner em cada transicao. Deve ser montada uma
 * unica vez no boot da app (em App.tsx), DENTRO do BrowserRouter e
 * AuthProvider, depois do Toaster Sonner.
 */
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

export function useNetworkStatus(): void {
  // toastIdRef garante que o toast de "Sem conexao" seja unico — sonner
  // permite dismiss/update via id, evitando empilhar mensagens duplicadas
  // se o navegador emitir multiplos 'offline' em sequencia.
  const offlineToastIdRef = useRef<string | number | null>(null);

  useEffect(() => {
    const handleOffline = () => {
      if (offlineToastIdRef.current !== null) return;
      offlineToastIdRef.current = toast.error('Sem conexao', {
        description: 'Verifique sua rede — operacoes podem falhar ate a conexao voltar',
        duration: Infinity,
      });
    };

    const handleOnline = () => {
      if (offlineToastIdRef.current !== null) {
        toast.dismiss(offlineToastIdRef.current);
        offlineToastIdRef.current = null;
      }
      toast.success('Conexao restaurada');
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    // Estado inicial: se a app foi aberta offline, sinaliza imediatamente.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      handleOffline();
    }

    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      if (offlineToastIdRef.current !== null) {
        toast.dismiss(offlineToastIdRef.current);
        offlineToastIdRef.current = null;
      }
    };
  }, []);
}
