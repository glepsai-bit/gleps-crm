// GLEPS CRM — Service Worker de Web Push Notifications
//
// Responsavel por:
//   1. Receber eventos "push" do servidor (payload cifrado via VAPID) e
//      renderizar a notificacao no browser.
//   2. Tratar clique na notificacao: abrir/foco na aba do CRM na URL passada.
//   3. Manter versao minima — o SW eh servido em '/sw-push.js' (scope root)
//      e nao intercepta requests de fetch (nao vira PWA offline). Push-only.
//
// Registrado pelo hook usePushNotifications no AdminLayout apos autenticacao.

self.addEventListener('install', (event) => {
  // Ativa este SW imediatamente sem esperar a proxima navegacao.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  // Assume controle das paginas ja abertas.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    // Payload em texto puro — fallback pra body simples.
    try {
      data = { title: 'Nova mensagem', body: event.data ? event.data.text() : '' };
    } catch (_) {
      data = { title: 'Nova mensagem', body: '' };
    }
  }

  const title = typeof data.title === 'string' && data.title.trim().length > 0
    ? data.title
    : 'Nova mensagem';
  const body = typeof data.body === 'string' ? data.body : '';
  const tag = typeof data.tag === 'string' && data.tag.length > 0 ? data.tag : undefined;
  const icon = typeof data.icon === 'string' && data.icon.length > 0
    ? data.icon
    : '/favicon-192.png';
  const url = typeof data.url === 'string' && data.url.length > 0 ? data.url : '/';

  const options = {
    body,
    icon,
    badge: '/favicon.png',
    tag,
    // renotify=true faz o browser tocar/vibrar mesmo quando a tag colapsa
    // uma notificacao anterior (evita silencio quando chega msg 2 na mesma conv).
    renotify: Boolean(tag),
    data: {
      url,
      payload: data.data || null,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // Tenta focar uma aba do CRM ja aberta e navegar pro conversationId.
      for (const client of allClients) {
        try {
          // Match por origem — evita abrir 2 abas quando ja tem o CRM aberto.
          const clientOrigin = new URL(client.url).origin;
          const targetOrigin = new URL(targetUrl, self.location.origin).origin;
          if (clientOrigin === targetOrigin) {
            await client.focus();
            if ('navigate' in client) {
              try {
                await client.navigate(targetUrl);
              } catch (_) {
                // Alguns browsers negam navigate em cross-navigation; ignora.
              }
            }
            return;
          }
        } catch (_) {
          // URL mal-formada — tenta o proximo.
        }
      }

      // Nenhuma aba compativel aberta — abre nova.
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })()
  );
});
