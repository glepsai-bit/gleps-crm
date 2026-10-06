import { useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { moduloLigado, type ModuloChave } from '@/config/modulos.config';

/**
 * Quais módulos opcionais a conta logada tem ligados.
 * Sem `account.modulos` (cache antigo, sem conta) tudo conta como ligado.
 */
export function useModulos() {
  const { account } = useAuth();
  const modulos = account?.modulos;
  const ligado = useCallback(
    (modulo: ModuloChave) => moduloLigado(modulos, modulo),
    [modulos],
  );
  return { ligado, modulos };
}
