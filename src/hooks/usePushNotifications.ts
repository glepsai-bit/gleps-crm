/**
 * usePushNotifications — registra o service worker de push (`/sw-push.js`),
 * pede permissao Notification e envia a subscription VAPID pro backend.
 *
 * Chamado no AdminLayout apos autenticacao. Guarda internamente contra:
 *   - Ausencia de suporte a Notification / ServiceWorker / PushManager.
 *   - Permissao ja negada anteriormente pelo usuario.
 *   - VAPID nao configurada no backend (endpoint devolve { enabled:false }).
 *   - Chamada duplicada com mesma userId (executa uma vez por mount).
 *
 * NAO force o usuario. Se o usuario negou o prompt uma vez, nao insistimos —
 * evita ficar batendo em request permission a cada F5 (browser rejeita mesmo).
 */

import { useEffect, useRef } from 'react';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

interface VapidResponse {
  enabled: boolean;
  publicKey: string | null;
}

interface SubscribeResponse {
  id: string;
}

/**
 * Converte a chave publica VAPID (base64url) em Uint8Array — formato exigido
 * pelo pushManager.subscribe({ applicationServerKey }).
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/**
 * Extrai { p256dh, auth } de uma PushSubscription (base64url).
 * Retorna null quando alguma chave nao existe (subscription malformada).
 */
function extractKeys(sub: PushSubscription): { p256dh: string; auth: string } | null {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!p256dh || !auth) return null;
  return { p256dh, auth };
}

async function registerPush(userId: string): Promise<void> {
  // Feature detection basica.
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  if (!('PushManager' in window)) return;
  if (!('Notification' in window)) return;

  // Se ja foi negado antes, nao reprompt — respeita a escolha.
  if (Notification.permission === 'denied') return;

  // 1) Busca VAPID publicKey. Se backend nao configurou, sai silencioso.
  let vapid: VapidResponse;
  try {
    vapid = await apiClient.get<VapidResponse>(API_ENDPOINTS.PUSH.VAPID_PUBLIC);
  } catch {
    return;
  }
  if (!vapid?.enabled || !vapid.publicKey) return;

  // 2) Registra o service worker (scope root).
  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register('/sw-push.js', { scope: '/' });
  } catch {
    return;
  }

  // Aguarda o SW ficar pronto — evita corrida com o pushManager em browsers
  // que ainda nao ativaram o worker recem-instalado.
  if (!registration.active) {
    try {
      await navigator.serviceWorker.ready;
    } catch {
      /* segue mesmo assim */
    }
  }

  // 3) Se ainda nao tem permissao, pede uma unica vez.
  // Tipar permission como NotificationPermission garante que o reatribuir
  // com retorno de requestPermission() (que pode ser 'default'|'granted'|'denied')
  // nao quebre o narrow do TS na verificacao final. Sem essa anotacao explicita,
  // o TS narrow `Notification.permission` para 'default'|'granted' apos o early
  // return 'denied' na linha 63, e o await Notification.requestPermission() nao
  // encaixa nesse tipo estreitado.
  let permission: NotificationPermission = Notification.permission;
  if (permission === 'default') {
    try {
      permission = await Notification.requestPermission();
    } catch {
      return;
    }
  }
  if (permission !== 'granted') return;

  // 4) Assina o pushManager (reutiliza subscription existente se ja houver).
  let subscription: PushSubscription | null;
  try {
    subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const applicationServerKey = urlBase64ToUint8Array(vapid.publicKey);
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }
  } catch {
    return;
  }
  if (!subscription) return;

  const keys = extractKeys(subscription);
  if (!keys) return;

  // 5) Persiste no backend — idempotente por endpoint.
  try {
    await apiClient.post<SubscribeResponse>(API_ENDPOINTS.PUSH.SUBSCRIBE, {
      endpoint: subscription.endpoint,
      keys,
    });
    // Marca no sessionStorage pra debug/observabilidade — nao afeta logica.
    try {
      sessionStorage.setItem('push:lastSubscribedUser', userId);
    } catch {
      /* storage cheio / privacy mode — ignora */
    }
  } catch {
    // Erro persistindo — nao dispara alerta, o usuario nao pediu isso.
  }
}

/**
 * Hook: dispara o registro do push assim que o usuario autenticado for
 * conhecido. Rebindings do mesmo user (StrictMode, re-render) sao dedupados
 * pelo lastRunFor.
 */
export function usePushNotifications(userId: string | null | undefined): void {
  const lastRunFor = useRef<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    if (lastRunFor.current === userId) return;
    lastRunFor.current = userId;
    // Fire-and-forget: qualquer erro interno vira no-op silencioso.
    void registerPush(userId);
  }, [userId]);
}

export default usePushNotifications;
