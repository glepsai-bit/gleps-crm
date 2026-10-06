import { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useModulos } from '@/hooks/useModulos';
import type { ModuloChave } from '@/config/modulos.config';

/**
 * Protege a rota de um módulo opcional. Desligado, volta pro Chat: o servidor
 * já recusa a API (403 MODULO_DESLIGADO), então abrir a tela só mostraria erros.
 */
export function RotaDeModulo({ modulo, children }: { modulo: ModuloChave; children: ReactNode }) {
  const { ligado } = useModulos();
  if (!ligado(modulo)) return <Navigate to="/admin/chat" replace />;
  return <>{children}</>;
}
