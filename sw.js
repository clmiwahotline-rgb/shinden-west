/**
 * 新田西口商店会 管理ポータル — Service Worker
 * 戦略: Stale-While-Revalidate
 *   - キャッシュがあれば即座に返す（50ms以下）
 *   - バックグラウンドで最新版を取得してキャッシュを更新
 *   - 次のアクセスで更新版が表示される
 */

const CACHE = 'nitta-portal-v12'; // v12: auth-overlay inline display:none（CSS非依存）

const HTML_ASSETS = [
  'index.html', 'officers.html', 'members.html', 'invoices.html',
  'ledger.html', 'budget.html', 'statements.html', 'events.html',
  'tasks.html', 'assembly.html', 'settings.html', 'proposals.html',
  'archive.html',
];

const STATIC_ASSETS = [
  'portal-shared.js', 'support.js',
];

// ===== インストール: 全ページを事前キャッシュ =====
self.addEventListener('install', event => {
  self.skipWaiting(); // 即時アクティベート
  event.waitUntil(
    caches.open(CACHE).then(cache => {
      // HTMLとJSを事前キャッシュ（失敗しても続行）
      return Promise.allSettled(
        [...HTML_ASSETS, ...STATIC_ASSETS].map(url =>
          cache.add(url).catch(e => console.warn('SW precache failed:', url, e.message))
        )
      );
    })
  );
});

// ===== アクティベート: 古いキャッシュを削除 =====
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ===== フェッチ: Stale-While-Revalidate =====
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // GAS API → 絶対にキャッシュしない
  if (url.hostname.includes('script.google.com')) return;

  // GET リクエストのみ
  if (req.method !== 'GET') return;

  // 同一オリジンのHTML/JSのみ対象
  const isLocal = url.origin === self.location.origin;
  const isAsset =
    HTML_ASSETS.some(a => url.pathname.endsWith('/' + a) || url.pathname.endsWith(a)) ||
    STATIC_ASSETS.some(a => url.pathname.endsWith('/' + a) || url.pathname.endsWith(a)) ||
    url.pathname === '/' || url.pathname === '';

  if (!isLocal || !isAsset) return;

  event.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(req).then(cached => {
        // バックグラウンドで最新版を取得してキャッシュ更新
        const networkFetch = fetch(req).then(res => {
          if (res && res.ok && res.status === 200) {
            cache.put(req, res.clone());
          }
          return res;
        }).catch(() => null);

        // キャッシュがあれば即返す（Stale-While-Revalidate）
        // なければネットワークを待つ
        return cached || networkFetch;
      })
    )
  );
});
