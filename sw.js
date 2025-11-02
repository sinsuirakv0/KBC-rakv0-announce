/* sw.js - Service Worker
  注意:
  - Service Worker から localStorage は読めないため、クライアント（ページ）からpostMessageで通知リストを渡してもらう必要があります。
  - ここでは「可能ならPeriodic Syncを使う」「ページからリクエストがあればshowNotificationする」などのベストエフォート実装を行います。
  - より確実にブラウザ閉じても通知を出すなら、サーバー側でWeb Pushを用意する必要があります。
*/

const CACHE_NAME = 'ns-cache-v1';
self.addEventListener('install', (e) => {
  self.skipWaiting();
  console.log('[SW] installed');
});

self.addEventListener('activate', (e) => {
  clients.claim();
  console.log('[SW] activated');
});

// store last delivered list in-memory (best-effort)
let notificationsCache = [];

// receive messages from client
self.addEventListener('message', (e) => {
  const data = e.data;
  if (!data) return;
  if (data.type === 'updateNotifications') {
    // ask client to send us the full list
    e.source?.postMessage({type:'requestNotifications'});
  } else if (data.type === 'deliverNotifications') {
    notificationsCache = data.payload || [];
  } else if (data.type === 'showNotification') {
    // client asked to show notification via SW
    const item = data.payload;
    showSWNotification(item);
  }
});

// Try Periodic Sync (if browser supports periodicSync event)
self.addEventListener('periodicsync', event => {
  if (event.tag === 'ns-periodic-sync') {
    event.waitUntil(handlePeriodicSync());
  }
});

async function handlePeriodicSync(){
  // For each notification in notificationsCache, check if nextTime <= now and show
  const now = Date.now();
  for (const item of notificationsCache) {
    if (!item.enabled) continue;
    if (item.nextTime && item.nextTime <= now + 5000) { // allowance
      await showSWNotification(item);
      // We cannot update localStorage from SW; request client to update storage
      // send message to all clients to indicate we triggered this item
      const allClients = await clients.matchAll({includeUncontrolled: true});
      for (const c of allClients) {
        c.postMessage({type:'triggeredBySW', id: item.id});
      }
    }
  }
}

// show notification helper
function showSWNotification(item) {
  const title = item.message || '通知';
  const options = {
    body: new Date(item.nextTime || Date.now()).toLocaleString(),
    tag: item.id,
    renotify: true,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: {id: item.id}
  };
  return self.registration.showNotification(title, options);
}

// respond to click on notification
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then( windowClients => {
      // Focus first client if exists, otherwise open new
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});