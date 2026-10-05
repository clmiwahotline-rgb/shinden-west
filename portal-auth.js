// =============================================
// portal-auth.js  新田西口商店会管理ポータル
// P0-AUTH-01: Googleログイン → サーバー（GAS）が ID token を検証してセッションを発行する。
// 権限（full / director）はサーバーが決める。ここでの role は画面の表示を切り替えるためだけに使う。
// セッショントークンは POST の本文でだけ送る（URL には載せない）。console にも出さない。
// =============================================
(function() {
  'use strict';
  var SESSION_KEY = 'nitta_session_v1';
  // 旧方式（v32 以前）が端末に残した値。起動時に削除するためだけに名前を持つ（読み込んで使うことはない）
  var LEGACY_LOCAL_KEYS = ['nitta_api_key', 'nitta_auth_v2'];
  var LEGACY_SESSION_KEYS = ['nitta_session'];
  // Google OAuth クライアントID（公開情報。秘密ではない）
  var CLIENT_ID = '367605623443-ahrthnavf0f09c63t6fcfa5hb1251s56.apps.googleusercontent.com';
  // 理事（director）が変更できない機能
  var DIRECTOR_READONLY = ['periods', 'invoices', 'invoiceLogs', 'transactions', 'balanceLogs', 'budgetItems', 'budgetDraft', 'settlements'];

  function read() {
    try {
      var raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
      var s = JSON.parse(raw || 'null');
      if (s && s.token && s.exp > Date.now()) return s;
    } catch (e) {}
    return null;
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    removeLegacy();
  }
  function removeLegacy() {
    LEGACY_LOCAL_KEYS.forEach(function(k) { try { localStorage.removeItem(k); } catch (e) {} });
    LEGACY_SESSION_KEYS.forEach(function(k) { try { sessionStorage.removeItem(k); } catch (e) {} });
  }
  function gasUrl() {
    return window.__GAS_URL__ || localStorage.getItem('nitta_script_url') || '';
  }
  function deviceLabel() {
    var ua = navigator.userAgent || '';
    var os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : 'Other';
    var br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'Browser';
    return os + ' ' + br;
  }
  function setRoleAttr(s) {
    var el = document.documentElement;
    if (s && s.role) el.setAttribute('data-role', s.role); else el.removeAttribute('data-role');
  }
  // 理事には変更ボタン（data-edit を付けたもの）を表示しない
  function injectStyle() {
    if (document.getElementById('portal-auth-style')) return;
    var st = document.createElement('style');
    st.id = 'portal-auth-style';
    st.textContent = 'html[data-role="director"] [data-edit]{display:none!important;}';
    (document.head || document.documentElement).appendChild(st);
  }

  // GAS への POST（本文にセッションを入れる）。本文が届かない一時的な障害（authError:missing）は1回だけ再試行する
  function post(body, opts) {
    opts = opts || {};
    var s = read();
    var payload = Object.assign({}, body);
    if (!opts.noSession && s) payload.session = s.token;
    var send = function() {
      return fetch(gasUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        keepalive: !!opts.keepalive,
      }).then(function(r) { return r.text(); }).then(function(t) { return JSON.parse(String(t).trim().replace(/^﻿/, '')); });
    };
    return send().then(function(res) {
      if (res && res.authError === 'missing' && !opts.noRetry) return send();
      return res;
    });
  }

  // 認証エラーの共通処理。true を返したら呼び出し元は処理を止める
  function handleAuthError(res) {
    if (!res || !res.authError || res.authError === 'missing' || res.authError === 'login_failed') return false;
    clearSession();
    setRoleAttr(null);
    try { if (window.__portalInstance && window.__portalInstance.showToast) window.__portalInstance.showToast('ログインの有効期限が切れたか、権限が変更されました。もう一度ログインしてください'); } catch (e) {}
    setTimeout(function() { location.reload(); }, 1200);
    return true;
  }

  function showPortal() {
    document.documentElement.setAttribute('data-authed', '1');
    document.documentElement.removeAttribute('data-needs-login');
    var ov = document.getElementById('auth-overlay');
    if (ov) ov.classList.add('hidden');
  }
  function setError(msg) {
    var el = document.getElementById('auth-error');
    if (el) el.textContent = msg || '';
  }

  // Google のログインボタンから呼ばれる
  function handleCredential(response) {
    var token = response && response.credential;
    if (!token) { setError('ログインできませんでした'); return; }
    if (!gasUrl()) { setError('接続先が設定されていません。トップページからログインしてください'); return; }
    setError('確認しています…');
    post({ action: 'login', idToken: token, ua: deviceLabel() }, { noSession: true, noRetry: true })
      .then(function(res) {
        if (!res || !res.ok || !res.session) { setError((res && res.error) || 'ログインできませんでした'); return; }
        var keep = true;
        var cb = document.getElementById('auto-login');
        if (cb) keep = !!cb.checked;
        var s = { token: res.session, exp: Number(res.exp), email: res.me.email, name: res.me.name || '', role: res.me.role };
        // 「ログイン状態を維持」が無ければ、このタブ（閉じるまで）だけに保存する
        (keep ? localStorage : sessionStorage).setItem(SESSION_KEY, JSON.stringify(s));
        setError('');
        showPortal();
        location.reload(); // ログイン後のデータ読み込みは画面の起動処理に任せる
      })
      .catch(function() { setError('通信に失敗しました。もう一度お試しください'); });
  }

  // ログアウト: サーバーのセッションを無効にし、この端末のデータ（キャッシュ）を消す
  function logout(opts) {
    opts = opts || {};
    var inst = window.__portalInstance;
    var pending = !!(inst && (inst._pendingPersist || inst._persistInFlight));
    if (pending && !opts.force) {
      if (!confirm('まだ送信されていない変更があります。ログアウトすると、この変更は失われます。ログアウトしますか？')) return;
    }
    var s = read();
    var done = function() {
      clearSession();
      ['nitta_v5', 'nitta_known_ids', 'nitta_last_modified'].forEach(function(k) { try { localStorage.removeItem(k); } catch (e) {} });
      setRoleAttr(null);
      location.href = opts.redirect || location.pathname;
    };
    if (!s) { done(); return; }
    post({ action: 'logout' }, { keepalive: true, noRetry: true }).then(done, done);
  }

  function initGsi() {
    if (read()) return;
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.id) return;
    if (initGsi._done) return;
    initGsi._done = true;
    google.accounts.id.initialize({ client_id: CLIENT_ID, callback: handleCredential, auto_select: false });
    var btn = document.getElementById('g_id_signin');
    if (btn) google.accounts.id.renderButton(btn, { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ja', width: 280 });
  }

  window.PortalAuth = {
    session: read,
    token: function() { var s = read(); return s ? s.token : ''; },
    email: function() { var s = read(); return s ? s.email : ''; },
    role: function() { var s = read(); return s ? s.role : ''; },
    isFull: function() { var s = read(); return !!s && s.role === 'full'; },
    // 画面上の判定（サーバーでも必ず判定される）
    canEdit: function(feature) { var s = read(); if (!s) return false; return s.role === 'full' || DIRECTOR_READONLY.indexOf(feature) < 0; },
    readonlyKeys: function() { var s = read(); return s && s.role === 'director' ? DIRECTOR_READONLY.slice() : []; },
    displayName: function(authEmails) {
      var s = read(); if (!s) return 'ゲスト';
      if (s.name) return s.name;
      var hit = (authEmails || []).filter(function(e) { return e && (e.email || e) === s.email; })[0];
      return (hit && hit.name) || s.email;
    },
    initial: function(authEmails) { var n = window.PortalAuth.displayName(authEmails); return n ? n.charAt(0) : '?'; },
    roleLabel: function() { var r = window.PortalAuth.role(); return r === 'full' ? '全権限' : r === 'director' ? '理事' : ''; },
    nav: function(list) {
      if (window.PortalAuth.isFull() && !list.some(function(n) { return n.id === 'audit'; })) list.push({ id: 'audit', label: '変更履歴' });
      return list;
    },
    post: post,
    handleAuthError: handleAuthError,
    logout: logout,
    // サーバーの応答の me（ロール）を画面に反映する
    syncMe: function(me) {
      var s = read(); if (!s || !me || me.email !== s.email) return;
      if (s.role !== me.role || s.name !== (me.name || '')) {
        s.role = me.role; s.name = me.name || '';
        var store = localStorage.getItem(SESSION_KEY) ? localStorage : sessionStorage;
        store.setItem(SESSION_KEY, JSON.stringify(s));
        setRoleAttr(s);
      }
    },
  };
  window.handleCredential = handleCredential;
  // 1時間無操作の自動ログアウト（各ページの既存タイマーから呼ばれる）
  window.__logout = function() { logout({ force: true }); };

  injectStyle();
  removeLegacy(); // v34: 旧APIキー・旧ログイン情報を端末から消す（ログインの有無に関係なく）
  var cur = read();
  setRoleAttr(cur);
  if (cur) {
    showPortal();
  } else {
    document.documentElement.removeAttribute('data-authed');
    document.documentElement.setAttribute('data-needs-login', '1');
    window.onGoogleLibraryLoad = initGsi;
    window.addEventListener('load', initGsi);
  }
  // 他のタブでログアウト・ログインした → この画面も合わせる
  window.addEventListener('storage', function(e) {
    if (!e || e.key !== SESSION_KEY) return;
    var had = !!cur, now = !!read();
    if (had !== now || (e.newValue && e.oldValue && JSON.parse(e.newValue).token !== JSON.parse(e.oldValue).token)) location.reload();
  });
})();
