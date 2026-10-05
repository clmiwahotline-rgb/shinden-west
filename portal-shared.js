// =============================================
// portal-shared.js  新田西口商店会管理ポータル
// 全ページDCで共通利用するメソッド群
// =============================================
(function() {
  'use strict';
  // P0-CONFLICT-01 / P0-RESURRECT-01: 既知ID台帳と未同期新規項目の判定に使う配列キー
  const SYNC_ID_KEYS = ['proposals','archiveDocs','tasks','events','invoices','transactions','budgetItems','members','officers','memberChangeLogs','invoiceLogs','balanceLogs'];
  window.PortalMethods = {
  gen() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); },
  fmt(n) { return '¥' + Math.abs(n||0).toLocaleString('ja-JP'); },
  fmtD(d) { if (!d) return '—'; const [y,m,dd]=d.split('-'); return y+'.'+parseInt(m)+'.'+parseInt(dd); },

  // ===== P0-AUTH-01: 認証つき通信 =====
  // サーバー発行のセッションを本文に入れる（URLには載せない）。旧APIキーは使わない（v34 で互換も削除）
  _authBody() {
    const t = window.PortalAuth ? window.PortalAuth.token() : '';
    return t ? { session: t } : {};
  },
  _hasAuth() { return !!this._authBody().session; },
  // 読み込み（POST）。本文が届かない一時的な障害（authError:missing）は1回だけ再試行する
  _postLoad(url, ts) {
    window.__portalInstance = this;
    const send = () => fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'text/plain;charset=utf-8'},
      body: JSON.stringify(Object.assign({ action: 'load', ts: String(ts || '0') }, this._authBody())),
    }).then(r => r.text()).then(text => JSON.parse(text.trim().replace(/^\uFEFF/,'')));
    return send()
      .then(d => (d && d.authError === 'missing') ? send() : d)
      .then(d => {
        if (d && d.authError) {
          if (window.PortalAuth && window.PortalAuth.handleAuthError(d)) { const e = new Error('ログインが必要です'); e.authHandled = true; throw e; }
          throw new Error(d.error || 'ログインが必要です');
        }
        if (d && d.me && window.PortalAuth) window.PortalAuth.syncMe(d.me);
        return d;
      });
  },
  // P0-REPO-01: 角印の画像を、ログイン中のセッションでサーバー（GAS）から取得する。ページを開いている間だけメモリに保持
  _getHankoDataUrl() {
    if (this._hankoDataUrl) return Promise.resolve(this._hankoDataUrl);
    if (!window.PortalAuth || !window.PortalAuth.token()) { this.showToast('角印を使うにはログインが必要です'); return Promise.resolve(null); }
    return window.PortalAuth.post({ action: 'getHanko' })
      .then(r => {
        if (r && r.authError && window.PortalAuth.handleAuthError(r)) return null;
        if (!r || !r.ok || !/^data:image\/(png|jpeg);base64,/.test(r.dataUrl || '')) { this.showToast('角印を取得できませんでした' + (r && r.error ? '（' + r.error + '）' : '')); return null; }
        this._hankoDataUrl = r.dataUrl;
        return r.dataUrl;
      })
      .catch(() => { this.showToast('角印を取得できませんでした（通信エラー）'); return null; });
  },
  // 印刷の前に角印を押すか確認する。押さない（キャンセル）・取得できない場合は null（角印なしで印刷）
  _hankoForPrint() {
    if (!confirm('角印を押印しますか？\n（押さずに印刷する場合は「キャンセル」）')) return Promise.resolve(null);
    return this._getHankoDataUrl();
  },

  // 理事が変更できないデータ（画面での判定。サーバーでも必ず判定される）
  _readonlyKeys() { return window.PortalAuth ? window.PortalAuth.readonlyKeys() : []; },
  _canEdit(feature) {
    if (!window.PortalAuth || window.PortalAuth.canEdit(feature)) return true;
    this.showToast('理事の権限では変更できません（閲覧のみ）');
    return false;
  },
  // サーバーから取り込んだ時点・保存に成功した時点の、閲覧専用データの控え（理事のときだけ）
  _snapReadonly(data) {
    const keys = this._readonlyKeys();
    if (!keys.length) { this._roSnap = null; return; }
    const snap = {};
    keys.forEach(k => { snap[k] = JSON.stringify(data[k] === undefined ? null : data[k]); });
    this._roSnap = snap;
  },
  // 権限で拒否された保存からの復旧: 保留中の変更を破棄し、サーバーから全件を読み直す（自動復旧は連続3回まで）
  _recoverForbidden(res) {
    this._pendingPersist = false;
    this.showToast('⚠️ ' + ((res && res.error) || '権限のない変更は保存できません'));
    this._conflictRecoveries = (this._conflictRecoveries || 0) + 1;
    if (this._conflictRecoveries > 3) return;
    this._forceFullReload = true;
    if (this._reloadQueued) return;
    this._reloadQueued = true;
    setTimeout(() => { this._reloadQueued = false; this.refreshFromSS(true); }, 0);
  },

  // -----------------------------------------------
  // 既知ID台帳: 過去にGASから確認できたIDを記録する。
  // 「ローカルのみに存在する項目」を「未同期の新規作成」として復活させる際、
  // 実は他端末の古いキャッシュに残っていた『既に削除済みの項目』まで復活させてしまう
  // 事故が起きていた。この台帳と突き合わせることで、既知IDなのにGASから消えている
  // 項目は「削除された」と判断し、復活させないようにする。
  // -----------------------------------------------
  _loadKnownIds() {
    try { return JSON.parse(localStorage.getItem('nitta_known_ids')||'{}'); } catch(e) { return {}; }
  },
  _saveKnownIds(keys, dataObj) {
    // P0-RESURRECT-01: 台帳は「サーバーに存在したことが確認できたID」の和集合で持つ。
    // 置き換えにすると、他端末で削除されたIDを忘れ、古いキャッシュから「未同期の新規」と誤判定して復活させてしまう。
    const known = this._loadKnownIds();
    keys.forEach(k => {
      if (!Array.isArray(dataObj[k])) return;
      const ids = new Set(known[k] || []);
      dataObj[k].forEach(i => { if (i && i.id) ids.add(i.id); });
      known[k] = [...ids];
    });
    try { localStorage.setItem('nitta_known_ids', JSON.stringify(known)); } catch(e) {}
  },
  _mergeLocalOnly(keys, merged, silent) {
    // silentでない（明示的な手動更新）場合は復活ロジックを使わない
    let hasLocalOnly = false;
    if (!silent) return hasLocalOnly;
    const localRaw = localStorage.getItem('nitta_v5');
    if (!localRaw) return hasLocalOnly;
    try {
      const local = JSON.parse(localRaw);
      const known = this._loadKnownIds();
      const ro = this._readonlyKeys ? this._readonlyKeys() : []; // P0-AUTH-01: 理事は閲覧専用データの「未同期の新規」を持たない
      keys.forEach(k => {
        if (ro.indexOf(k) >= 0) return;
        if (!Array.isArray(local[k]) || !Array.isArray(merged[k])) return;
        const gasIds = new Set(merged[k].map(i=>i.id));
        const knownIds = new Set(known[k]||[]);
        // GASに無く、かつ「過去にGASで確認されたことがある」IDは削除済みとみなし復活させない
        const localOnly = local[k].filter(i=>i.id && !gasIds.has(i.id) && !knownIds.has(i.id));
        if (localOnly.length) { merged[k] = [...merged[k], ...localOnly]; hasLocalOnly = true; }
      });
    } catch(e) {}
    return hasLocalOnly;
  },

  migrate(d) {
    // 全会員に不足フィールドを補完
    const memberDefaults = {address:'',fax:'',email:'',joinDate:'',status:'在籍',statusDate:null,statusNote:''};
    const members = (d.members||[]).map(m=>({...memberDefaults,...m}));
    // 全請求書に不足フィールドを補完
    const invoiceDefaults = {description:'',paymentMethod:'',reminderNote:'',installment:null};
    const invoices = (d.invoices||[]).map(i=>({
      ...invoiceDefaults,...i,
      installment: typeof i.installment==='string'?JSON.parse(i.installment||'null'):(i.installment||null),
    }));
    // settlementsのcategoriesとauditをJSON解析
    const settlements = (d.settlements||[]).map(s=>({
      ...s,
      categories: Array.isArray(s.categories)?s.categories:
        (typeof s.categories==='string'?(() => { try{return JSON.parse(s.categories);}catch(e){return [];} })():[]),
      audit: s.audit&&typeof s.audit==='string'?(() => { try{return JSON.parse(s.audit);}catch(e){return null;} })():(s.audit||null),
    }));
    // P0-PARSE-01: シートには配列・オブジェクトが JSON 文字列で保存されるため、読み込み直すと文字列のまま届く。
    // 文字列になっている項目だけを元の形に戻す（文字列でない値はそのまま）。壊れたJSONは空として扱い、画面を止めない。
    const tasks = (d.tasks||[]).map(t=>(t && typeof t.comments==='string') ? {...t, comments:this._parseJsonField(t.comments, [], 'tasks.comments')} : t);
    const proposals = (d.proposals||[]).map(p=>(p && typeof p.attachments==='string') ? {...p, attachments:this._parseJsonField(p.attachments, [], 'proposals.attachments')} : p);
    const archiveDocs = (d.archiveDocs||[]).map(a=>(a && typeof a.file==='string') ? {...a, file:this._parseJsonField(a.file, null, 'archiveDocs.file')} : a);
    return {...d, members, invoices, settlements, tasks, proposals, archiveDocs};
  },

  // P0-PARSE-01: JSON 文字列を配列・オブジェクトに戻す。JSONでない文字列はそのまま、壊れたJSONは fallback。
  _parseJsonField(v, fallback, label) {
    if (typeof v !== 'string') return v;
    const s = v.trim();
    if (!s) return fallback;
    if (s[0] !== '[' && s[0] !== '{') return v;
    try { return JSON.parse(s); } catch(e) { console.warn(label + ' parse error:', e.message); return fallback; }
  },

  loadLocal() {
    try {
      const raw = localStorage.getItem('nitta_v5');
      if (raw) {
        const cached = JSON.parse(raw);
        // P0-TAB-01: キャッシュと一体で保存した「このデータの基準になった版番号」をタブの版番号にする。
        // __baseTs はキャッシュ専用のメタデータなので state には入れない（サーバーにも送らない）。
        // 古いキャッシュ（__baseTs なし）は版番号 '0' として、サーバーから全データを読み直させる（安全側）。
        this._tabTs = (cached && cached.__baseTs) ? String(cached.__baseTs) : '0';
        if (cached) delete cached.__baseTs;
        const d = this.migrate(cached);
        // 注意: ここでpersist()は呼ばない。起動直後はSS接続前(ssReady=false)のため
        // persist()は実際には送信されず「送信保留」フラグだけを立ててしまい、
        // 直後のSS読み込み時に「保留中のローカル変更あり」と誤認識される。
        // その結果、古いキャッシュを持ったタブがSSの最新データを取り込まず、
        // 逆に古いデータで上書き送信してしまう事故につながっていた。
        // 起動直後はキャッシュを画面に出すだけにとどめ、送信要否はfetchSheets側の
        // マージ判定（本当にローカルにしか無い変更があるか）に任せる。
        this.setState({...d, loading:false});
        return;
      }
    } catch(e) {}
    // P0-SEED-01: クラウド連携（URL・APIキー）が設定済みの端末ではデモデータを作らない。
    // seed() は persist() を呼び、接続前は「送信保留」となるため、直後の fetchSheets が
    // クラウドを取り込まずにデモデータを送信し、本番SSをデモデータで上書きしていた。
    // 連携済みの端末では空のまま待ち、fetchSheets の取り込みに任せる。
    // P0-AUTH-01: 連携先が設定された端末では、ログイン前（セッションなし）でもデモデータを作らない（ログイン後の取り込みで本番に混入するため）
    if (localStorage.getItem('nitta_script_url')) {
      this.setState({ loading: true });
      return;
    }
    this.seed();
  },

  parseSheets(d) {
    const n = v => parseFloat(v)||0;
    return {
      periods:       (d.periods||[]).map(p=>{
        let bankAccounts;
        try{bankAccounts=typeof p.bankAccounts==='string'?JSON.parse(p.bankAccounts||'[]'):(Array.isArray(p.bankAccounts)?p.bankAccounts:[]);}
        catch(e){console.warn('periods.bankAccounts parse error:',p.bankAccounts,e.message);bankAccounts=[];}
        return {...p, bankAccounts};
      }),
      members:       (d.members||[]).map(m=>({...m, fee:n(m.fee), no:n(m.no)})),
      officers:      (d.officers||[]).map(o=>({memo:'',...o})),
      invoices:      (d.invoices||[]).map(i=>{
        let inst=null;
        try{inst=typeof i.installment==='string'?JSON.parse(i.installment||'null'):(i.installment||null);}
        catch(e){console.warn('installment parse error:',e.message);inst=null;}
        return {...i,amount:n(i.amount),installment:inst};
      }),
      transactions:  (d.transactions||[]).map(t=>({...t, income:n(t.income), expense:n(t.expense)})),
      budgetItems:   (d.budgetItems||[]).map(b=>({...b, amount:n(b.amount)})),
      events:        d.events||[],
      memberChangeLogs: d.memberChangeLogs||[],
      invoiceLogs:   (d.invoiceLogs||[]).map(l=>({...l})),
      balanceLogs:   (d.balanceLogs||[]).map(l=>{
        let entries;
        try{entries=typeof l.entries==='string'?JSON.parse(l.entries||'null'):(l.entries||null);}
        catch(e){console.warn('balanceLogs.entries parse error:',l.entries,e.message);entries=null;}
        return {...l, entries};
      }),
      settlements:   (d.settlements||[]).map(s=>{
        let cats=[],aud=null;
        try{cats=typeof s.categories==='string'?JSON.parse(s.categories||'[]'):(s.categories||[]);}
        catch(e){console.warn('categories parse error:',s.categories,e.message);cats=[];}
        try{aud=typeof s.audit==='string'?JSON.parse(s.audit||'null'):(s.audit||null);}
        catch(e){console.warn('audit parse error:',s.audit,e.message);aud=null;}
        return {...s,categories:cats,audit:aud};
      }),
      authEmails:    d.authEmails||[],
      orgInfo:       (Array.isArray(d.orgInfo)?d.orgInfo[0]:d.orgInfo)||{},
      budgetDraft:   (()=>{try{return typeof d.budgetDraft==='string'?JSON.parse(d.budgetDraft||'null'):(d.budgetDraft||null);}catch(e){return null;}})(),
      assemblyDoc:   (()=>{try{return typeof d.assemblyDoc==='string'?JSON.parse(d.assemblyDoc||'null'):(d.assemblyDoc||null);}catch(e){return null;}})(),
      tasks:         d.tasks||[],
      proposals:     d.proposals||[],
      archiveDocs:   d.archiveDocs||[],
      currentPeriodId: d.currentPeriodId||null,
    };
  },

  fetchSheets(url, _unused, silent) {
    // P0-AUTH-01: 第2引数は旧APIキーの名残で使わない（呼び出し側は '' を渡す）。認証は _authBody（セッション）
    if (!this._hasAuth()) { this.setState({ loading: false }); return; }
    // ロック: ローカルデータが一切ない初回のみ、または手動同期
    const shouldLock = !localStorage.getItem('nitta_v5') || !silent;
    if (shouldLock) this._showSsLock();
    if (!silent) this.setState({ syncStatus: 'syncing' });
    this._installTabSync();
    // P0-TAB-01: 差分確認には、共有の版番号ではなく「このタブが表示しているデータの版番号」を使う
    const lastTs = this._tabTs || '0';
    this._postLoad(url, lastTs)
      .then(d => {
        if (d.error) throw new Error(d.error);
        this._lastSyncCheckAt = Date.now();
        const knownTs = this._tabTs || '0';
        // 変更なし → スキップ
        if (d.modified === false) {
          if (shouldLock) this._hideSsLock();
          console.log('fetchSheets: 変更なし(modified=false)。ssReady=trueに設定。_pendingPersist=', this._pendingPersist);
          this.setState({ syncStatus: 'ok', loading: false, ssReady: true, lastSyncAt: Date.now() }, () => {
            // サーバーの版が変わっていない（他端末の保存なし）ので、保留中の変更を送り直しても上書きにならない。送信中は二重送信しない
            if (this._pendingPersist && !this._persistInFlight) {
              console.log('自動リトライ(modified=false経由): 保留中の保存をクラウドに送信します');
              this.persist((status, detail) => console.log('自動リトライ結果:', status, detail));
            }
          });
          return;
        }
        // 応答が既知の最新版より古い場合は破棄する。送信中(または送信直後)の自分/他端末の保存の方が
        // 新しい状態を反映しているのに、遅れて届いた古いスナップショットで上書きすると
        // 削除・編集した項目が復活してしまう（実際に発生した事故の原因）。
        if (d.lastModified && knownTs !== '0' && Number(d.lastModified) < Number(knownTs)) {
          console.warn('fetchSheets: 応答が既知の最新版より古いため破棄します', d.lastModified, '<', knownTs);
          if (shouldLock) this._hideSsLock();
          this.setState({ syncStatus: 'ok', loading: false, ssReady: true, lastSyncAt: Date.now() }, () => {
            if (this._pendingPersist && !this._persistInFlight) this.persist((status, detail) => console.log('自動リトライ結果:', status, detail));
          });
          return;
        }
        // P0-CONFLICT-01: 保存の送信中に新しい版を受け取った場合は、取り込みも送信もせず、版番号も更新しない。
        // 保存完了後に最新を1回だけ読み直す（_afterPersistSettled）。
        if (this._persistInFlight) {
          console.log('fetchSheets: 保存の送信中に新しい版を受信。保存完了後に読み直します');
          this._reloadAfterPersist = true;
          if (shouldLock) this._hideSsLock();
          this.setState({ loading: false, ssReady: true });
          return;
        }
        if (d.lastModified) localStorage.setItem('nitta_last_modified', d.lastModified);
        const parsed = this.migrate(this.parseSheets(d));
        if (!parsed.periods || parsed.periods.length === 0) {
          if (shouldLock) this._hideSsLock();
          if (!silent) this.loadLocal();
          this.setState({ syncStatus: 'ok', loading: false });
          if (!silent) this.showToast('SSにデータが見つかりません。ローカルデータを使用中');
        } else {
          const assemblyDoc = this._restoreAssemblyDoc ? this._restoreAssemblyDoc(parsed) : parsed.assemblyDoc; // P0-ASM-01: 全データ(parsed)を assemblyDoc にしない
          const merged = {...parsed, assemblyDoc};
          // P0-CONFLICT-01: ここに来るのは「サーバーの方が新しい＝他の端末が保存した」場合だけ。
          // 保留中の変更があっても送り直さない（送り直すと他端末の変更を消す）。サーバーの内容を優先して取り込み、
          // 本当に未同期の新規項目だけを残して保存する。既存項目への編集・削除は反映せず、利用者に通知する。
          const discardedPending = !!this._pendingPersist;
          this._pendingPersist = false;
          // ローカル未反映アイテムをマージ（新規作成したがGAS未到達のデータを保護。既知ID台帳で保存済み・削除済みは除外）
          const MERGE_KEYS = SYNC_ID_KEYS;
          const hasLocalOnly = this._mergeLocalOnly(MERGE_KEYS, merged, silent || discardedPending);
          this._saveKnownIds(MERGE_KEYS, parsed);
          this._snapReadonly(merged);
          console.log('fetchSheets完了: hasLocalOnly=', hasLocalOnly, 'discardedPending=', discardedPending);
          if (d.lastModified) this._tabTs = String(d.lastModified); // このタブがサーバーのデータを取り込んだ
          this.setState({ ...merged, loading: false, syncStatus: 'ok', ssReady: true, lastSyncAt: Date.now() },
            () => {
              if (hasLocalOnly) {
                console.log('未同期の新規項目をクラウドに送信します');
                this.persist((status, detail) => console.log('自動リトライ結果:', status, detail));
              }
              if (discardedPending) this._notifyDiscardedPending(hasLocalOnly);
            }
          );
          this._writeCache(merged);
          if (shouldLock) this._hideSsLock();
          if (!silent) this.showToast('スプレッドシートから読み込みました');
        }
      })
      .catch(err => {
        console.warn('Sheets fetch failed:', err.message);
        if (shouldLock) this._hideSsLock();
        if (err && err.authHandled) return; // ログイン画面に戻る
        if (!silent) { this.loadLocal(); this.showToast('スプレッドシート接続失敗。ローカルデータを使用します'); }
        this.setState({ syncStatus: 'error', loading: false });
      });
  },

  saveOrgInfo() {
    const inp = this.state.orgInfoInput||{};
    this.setState(s=>({orgInfo:{...s.orgInfo,...inp},orgInfoInput:null}),()=>this.persist());
    this.showToast('代表者情報を保存しました');
  },

  refreshFromSS(silent) {
    const url = this.state.scriptUrl || localStorage.getItem('nitta_script_url') || '';
    if (!url || !this._hasAuth()) return; // P0-AUTH-01: セッションで読み込む
    this._installTabSync();
    if (!silent) this._showSsLock();
    // 手動更新(silent=false)は必ずts=0で送り、SS直接編集などでLAST_MODIFIEDが
    // 更新されないケースでもキャッシュ・差分チェックをバイパスして必ず最新を取得する。
    // 自動バックグラウンド更新(silent=true)のみ差分チェック(ts送信)で軽量化する。
    // P0-TAB-01: このタブの版番号で差分確認。P0-AUTH-01: 権限で拒否された後は全件を読み直す
    const lastTs = (silent && !this._forceFullReload) ? (this._tabTs || '0') : '0';
    this._forceFullReload = false;
    this._postLoad(url, lastTs)
      .then(d=>{ if(!d.ok) throw new Error(d.error||'エラー'); return d; })
      .then(d=>{
        this._lastSyncCheckAt = Date.now();
        const knownTs = this._tabTs || '0';
        if (d.modified === false) {
          if (!silent) this._hideSsLock();
          this.setState({ syncStatus: 'ok', ssReady: true }, () => {
            if (this._pendingPersist && !this._persistInFlight) this.persist();
          });
          return;
        }
        // fetchSheetsと同様: 既知の最新版より古い応答は破棄する（送信中/送信直後の保存の方が新しい）
        if (d.lastModified && knownTs !== '0' && Number(d.lastModified) < Number(knownTs)) {
          console.warn('refreshFromSS: 応答が既知の最新版より古いため破棄します', d.lastModified, '<', knownTs);
          if (!silent) this._hideSsLock();
          this.setState({ syncStatus: 'ok', ssReady: true }, () => {
            if (this._pendingPersist && !this._persistInFlight) this.persist();
          });
          return;
        }
        // P0-CONFLICT-01: 保存の送信中は取り込まず・版番号も更新せず、保存完了後に1回読み直す
        if (this._persistInFlight) {
          console.log('refreshFromSS: 保存の送信中に新しい版を受信。保存完了後に読み直します');
          this._reloadAfterPersist = true;
          if (!silent) this._hideSsLock();
          return;
        }
        if (d.lastModified) localStorage.setItem('nitta_last_modified', d.lastModified);
        const parsed = this.migrate(this.parseSheets(d));
        if (!parsed.periods || parsed.periods.length===0) { if(!silent){ this._hideSsLock(); this.showToast('SSにデータがありません');} return; }
        const assemblyDoc = this._restoreAssemblyDoc ? this._restoreAssemblyDoc(parsed) : parsed.assemblyDoc; // P0-ASM-01: 全データ(parsed)を assemblyDoc にしない
        const merged = {...parsed, assemblyDoc};
        // P0-CONFLICT-01: 保留中の変更があっても送り直さず、サーバー（新しい版）を優先して取り込む（fetchSheetsと同様）
        const discardedPending = !!this._pendingPersist;
        this._pendingPersist = false;
        // ローカル未反映アイテムを保護（新規作成したがGAS未到達のデータを上書きしない。既知ID台帳で保存済み・削除済みは除外）
        const MERGE_KEYS = SYNC_ID_KEYS;
        const hasLocalOnly = this._mergeLocalOnly(MERGE_KEYS, merged, true);
        this._saveKnownIds(MERGE_KEYS, parsed);
        this._snapReadonly(merged);
        if (d.lastModified) this._tabTs = String(d.lastModified); // このタブがサーバーのデータを取り込んだ
        this.setState({...merged, syncStatus:'ok', ssReady:true}, () => {
          if (hasLocalOnly) this.persist();
          if (discardedPending) this._notifyDiscardedPending(hasLocalOnly);
        });
        this._writeCache(merged);
        if (!silent) { this._hideSsLock(); this.showToast('SSから最新データを取得しました'); }
      })
      .catch(()=>{ if(!silent){ this._hideSsLock(); this.showToast('SS再読み込みに失敗しました'); } });
  },

  loadFromSS() {
    const url = this.state.scriptUrl || localStorage.getItem('nitta_script_url') || '';
    if (!url || !this._hasAuth()) { this.showToast('先にログインしてください'); return; } // P0-AUTH-01
    if (!confirm('SSのデータをローカルに上書き読み込みします。\nローカルの未同期データは上書きされます。よろしいですか？')) return;
    this.setState({ loading: true, syncStatus: 'syncing' });
    this._showSsLock();
    this._postLoad(url, '0')
      .then(d=>{ if(!d.ok) throw new Error(d.error||'エラー'); return d; })
      .then(d=>{
        const parsed = this.migrate(this.parseSheets(d));
        if (!parsed.periods || parsed.periods.length===0) throw new Error('SSにデータがありません');
        const assemblyDoc = this._restoreAssemblyDoc ? this._restoreAssemblyDoc(parsed) : parsed.assemblyDoc; // P0-ASM-01: 全データ(parsed)を assemblyDoc にしない
        const merged = {...parsed, assemblyDoc};
        const MERGE_KEYS_INIT = ['proposals','archiveDocs','tasks','events','invoices','transactions','budgetItems','members','officers','memberChangeLogs','invoiceLogs','balanceLogs'];
        this._saveKnownIds(MERGE_KEYS_INIT, parsed);
        this._snapReadonly(merged);
        if (d.lastModified) { this._tabTs = String(d.lastModified); localStorage.setItem('nitta_last_modified', d.lastModified); }
        this.setState({...merged, loading:false, syncStatus:'ok', ssReady:true});
        this._writeCache(merged);
        this._hideSsLock();
        this.showToast('SSからデータを読み込みました（ローカルに保存済み）');
      })
      .catch(err=>{
        this._hideSsLock();
        this.setState({loading:false, syncStatus:'error'});
        this.showToast('読み込み失敗：'+err.message);
      });
  },

  saveScriptUrl() {
    // P0-AUTH-01: APIキーは使わない（Googleでログインしたセッションで接続する）
    const url = (this.state.scriptUrlInput||'').trim();
    localStorage.setItem('nitta_script_url', url);
    if (!url) {
      this.setState({ scriptUrl: '', syncStatus: null });
      this.showToast('連携を解除しました');
      return;
    }
    this.setState({ scriptUrl: url, syncStatus: 'syncing', loading: true });
    this.fetchSheets(url, '');
  },

  persist(onResult) {
    const {page,modal,formData,toast,_tt,loading,syncStatus,syncPaused,scriptUrl,scriptUrlInput,orgInfoInput,gasUser,...d} = this.state;
    // P0-AUTH-01: 理事の閲覧専用データ（期・請求書・入出金・予算・決算）に変更があれば、送らずに元に戻す（サーバーでも拒否される）
    const roKeys = this._readonlyKeys();
    if (roKeys.length && this._roSnap) {
      const changed = roKeys.filter(k => this._roSnap[k] !== undefined && JSON.stringify(d[k] === undefined ? null : d[k]) !== this._roSnap[k]);
      if (changed.length) {
        const restore = {};
        changed.forEach(k => { restore[k] = JSON.parse(this._roSnap[k]); d[k] = restore[k]; });
        this.setState(restore);
        this.showToast('理事の権限では変更できない項目は、元に戻しました（閲覧のみ）');
      }
    }
    this._writeCache(d); // このタブの版番号を基準として、手元の変更を含むキャッシュを書く
    const auth = this._authBody(); // P0-AUTH-01: セッション（本文で送る）
    const hasSession = !!auth.session;
    const url = scriptUrl || localStorage.getItem('nitta_script_url') || '';
    // 配列内の行によってキー構成が違うと、GAS側が「先頭行のキー」だけを列見出しにする実装のため、
    // 後発フィールド（bankAccounts・accountName等、一部の行にしか無い項目）が保存時に列ごと欠落する。
    // 送信前に各配列を「全行キーの和集合」に揃えて、この事故を防ぐ（GAS側も同様に修正済みだが二重の保険）。
    const normalizeArrayKeys = (arr) => {
      if (!Array.isArray(arr) || arr.length === 0) return arr;
      const keySet = new Set();
      arr.forEach(row => { if (row && typeof row === 'object') Object.keys(row).forEach(k=>keySet.add(k)); });
      return arr.map(row => {
        const nr = {...row};
        keySet.forEach(k => { if (!(k in nr)) nr[k] = null; });
        return nr;
      });
    };
    const ARRAY_FIELDS = ['periods','members','officers','invoices','transactions','budgetItems','events',
      'memberChangeLogs','invoiceLogs','balanceLogs','settlements','tasks','proposals','archiveDocs'];
    const dataForSend = {...d};
    ARRAY_FIELDS.forEach(k => { if (Array.isArray(d[k])) dataForSend[k] = normalizeArrayKeys(d[k]); });
    // periodsのbankAccountsは未設定期でも空配列を明示する（既存の対策を維持）
    if (Array.isArray(dataForSend.periods)) {
      dataForSend.periods = dataForSend.periods.map(p => ({ bankAccounts: [], ...p }));
    }
    if (url && hasSession && this.state.ssReady) {
      // 注意: ここで_pendingPersistをfalseにしない。送信中(_persistInFlight)は別のフラグで表す。
      // 以前はここでfalseにしていたため、この送信が完了する前に自動更新等が届いた古い
      // スナップショットを「保留中の変更なし」と誤認識して取り込み、削除・編集した項目が
      // 復活する事故につながっていた。確定した結果を受け取ってから_pendingPersistを更新する。
      this._persistInFlight = true;
      this.setState({ syncStatus: 'syncing' });
      // P0-TAB-01: 共有の版番号ではなく、このタブが基準にしている版番号で競合判定する
      const clientLastModified = this._tabTs || '0';
      fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'text/plain;charset=utf-8'},
        body: JSON.stringify(Object.assign({ action: 'save', data: dataForSend, clientLastModified }, auth)),
      })
      .then(r => r.json())
      .then(res => {
        // P0-AUTH-01: 認証エラー。本文が届かなかっただけ（missing）なら保留にして後で送り直す
        if (res && res.authError) {
          this._persistInFlight = false;
          this._pendingPersist = true;
          this.setState({ syncStatus: 'error' });
          if (res.authError !== 'missing' && window.PortalAuth) window.PortalAuth.handleAuthError(res);
          if (onResult) onResult('authError', res.authError);
          if (res.authError === 'missing') this._afterPersistSettled(false);
          return;
        }
        // P0-AUTH-01: 権限で拒否された（理事が閲覧専用のデータを変更していた）→ 何も保存されていない。サーバーから読み直す
        if (res && res.forbidden) {
          this._persistInFlight = false;
          this.setState({ syncStatus: 'error' });
          this._recoverForbidden(res);
          if (onResult) onResult('forbidden', res.sheetErrors);
          return;
        }
        if (res.conflict) {
          this._persistInFlight = false;
          this.setState({ syncStatus: 'error' });
          this._pendingPersist = true; // 競合時は保留扱い（復旧の読み直しで、サーバーを優先して取り込む）
          this.showToast('⚠️ 他の端末で更新がありました。最新の内容を確認しています…');
          if (onResult) onResult('conflict');
          this._afterPersistSettled(true);
          return;
        }
        this._persistInFlight = false;
        if (res.lastModified) localStorage.setItem('nitta_last_modified', res.lastModified);
        this.setState({ syncStatus: res.ok ? 'ok' : 'error' });
        this._pendingPersist = !res.ok; // 成功時は解除、失敗時は保留扱いにして再送信できるようにする
        if (res.ok) {
          // P0-RESURRECT-01: 保存に成功した項目は既知ID台帳に登録する（以後、他端末で削除されても未同期の新規と誤判定しない）
          this._saveKnownIds(SYNC_ID_KEYS, dataForSend);
          this._conflictRecoveries = 0;
          this._snapReadonly(d); // P0-AUTH-01
          // P0-TAB-01: このタブ自身の保存が成功した → タブの版番号を更新し、キャッシュの基準も新しい版にする
          // （他のタブは storage イベントでこれを受け取り、自分より新しい版なら読み直す）
          if (res.lastModified) {
            this._tabTs = String(res.lastModified);
            const {page,modal,formData,toast,_tt,loading,syncStatus,syncPaused,scriptUrl,scriptUrlInput,orgInfoInput,gasUser,...cur} = this.state;
            this._writeCache(cur);
          }
        }
        this._afterPersistSettled(false);
        if (res.sheetErrors && res.sheetErrors.length) {
          console.warn('シート保存エラー:', res.sheetErrors);
          this.showToast('⚠️ 一部データの保存に失敗しました（添付ファイルが大きすぎる可能性）: ' + res.sheetErrors.join(', '));
          if (onResult) onResult('sheetError', res.sheetErrors);
          return;
        }
        if (onResult) onResult(res.ok ? 'ok' : 'error');
      })
      .catch((err) => { this._persistInFlight = false; this.setState({ syncStatus: 'error' }); this._pendingPersist = true; if (onResult) onResult('networkError', err); this._afterPersistSettled(false); });
    } else {
      // クラウド未接続 or SS未初期化 → ローカル保存のみ。SS準備でき次第、自動的に再送信する
      const reason = !url ? 'no-url' : !hasSession ? 'no-session' : 'not-ready';
      console.warn('persist(): クラウド送信スキップ:', reason);
      if (url && hasSession) this._pendingPersist = true; // URL/キーはあるが未接続 → 準備でき次第リトライ
      if (onResult) onResult('local-only', reason);
    }
  },

  // P0-TAB-01: データのキャッシュと「そのデータの基準になった版番号（__baseTs）」を1つのキーに一体で書く。
  // 別々のキーにすると、タブの書き込みが前後したときに「新しい版番号＋古いデータ」の組み合わせが残り、
  // そこから開いたタブが他のタブの変更を上書きしてしまう。
  _writeCache(data) {
    try { localStorage.setItem('nitta_v5', JSON.stringify(Object.assign({}, data, { __baseTs: this._tabTs || '0' }))); } catch(e) {}
    if (this._tabTs) { try { localStorage.setItem('nitta_last_modified', this._tabTs); } catch(e) {} } // 互換のため書く（競合判定には使わない）
  },

  // P0-TAB-01: 他のタブの保存（storage イベント）と、タブが前面に戻ったとき（visibilitychange）に最新化する。
  // ページごとに1回だけ登録する。タブの版番号（_tabTs）はここでは更新しない（実際に取り込んだ時だけ更新）。
  _installTabSync() {
    window.__portalInstance = this; // P0-AUTH-01: ログアウト時に未送信の変更を確認するため
    if (this._tabSyncInstalled || typeof window === 'undefined' || !window.addEventListener) return;
    this._tabSyncInstalled = true;
    window.addEventListener('storage', (e) => {
      if (!e || e.key !== 'nitta_v5' || !e.newValue) return;
      const m = /"__baseTs":"(\d+)"/.exec(e.newValue);
      if (!m) return;
      if (Number(m[1]) <= Number(this._tabTs || 0)) return; // 自分の版と同じか古い → 何もしない
      this._requestTabRefresh('storage');
    });
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (Date.now() - (this._lastSyncCheckAt || 0) < 30000) return; // 直近30秒以内に確認済み
        this._requestTabRefresh('visible');
      });
    }
  },

  // P0-TAB-01: 最新化の要求。保存の送信中・送信保留中は即時に取り込まず、既存の読み直し予約にまとめる。
  _requestTabRefresh(reason) {
    if (this._persistInFlight || this._pendingPersist) {
      console.log('最新化を予約（' + reason + '）: 保存の完了後に読み直します');
      this._reloadAfterPersist = true;
      return;
    }
    if (this._reloadQueued) return;
    this._reloadQueued = true;
    setTimeout(() => { this._reloadQueued = false; this.refreshFromSS(true); }, 0);
  },

  // P0-CONFLICT-01: 保存の終了後に、最新を1回だけ読み直す（競合時、または保存中に新しい版を受け取っていた時）。
  // 予約は1件にまとめ、競合からの自動復旧は連続3回までにする（無限リトライ防止。成功すると数え直す）。
  _afterPersistSettled(conflict) {
    if (!conflict && !this._reloadAfterPersist) return;
    this._reloadAfterPersist = false;
    if (conflict) {
      this._conflictRecoveries = (this._conflictRecoveries || 0) + 1;
      if (this._conflictRecoveries > 3) {
        console.warn('競合からの自動復旧が続いたため停止します');
        this.showToast('⚠️ 他の端末での更新が続いているため、自動での再保存を一時停止しました。少し待ってから「↻ 更新」を押してください');
        return;
      }
    }
    if (this._reloadQueued) return;
    this._reloadQueued = true;
    setTimeout(() => { this._reloadQueued = false; this.refreshFromSS(true); }, 0);
  },

  // P0-CONFLICT-01: 保留中の変更をサーバー優先で取り込んだことを利用者に知らせる
  _notifyDiscardedPending(hasLocalOnly) {
    this.showToast('他の端末で更新があったため、最新の内容を読み込みました。' +
      (hasLocalOnly ? '直前に追加した項目は保存します。' : '') +
      '編集・削除は反映されていない可能性があるので、確認して必要なら入力し直してください');
  },

  // P0-REPO-01: 接続先が無い端末だけで使うデモ用の架空データ（実在の人名・電話番号・金額は含めない）。
  // 接続先が設定されている端末では呼ばれない（loadLocal の P0-SEED-01 を参照）。
  seed() {
    const y = new Date().getFullYear();
    const p1 = this.gen();
    const periods = [{id:p1,name:'サンプル期',startDate:y+'-04-01',endDate:(y+1)+'-03-31'}];
    const members = [
      {no:1,name:'見本 太郎',store:'見本商店',fee:0,phone:''},
      {no:2,name:'見本 花子',store:'見本食堂',fee:0,phone:''},
    ].map(m=>({id:this.gen(),type:'正会員',email:'',...m}));
    const officers = [{id:this.gen(),periodId:p1,role:'会長',memberId:members[0].id,memo:''}];
    this.setState({
      periods, currentPeriodId:p1,
      officers, members,
      invoices:[], transactions:[], budgetItems:[], events:[],
    }, ()=>this.persist());
  },

  nav(id) {
    const myPages = this._myPages || [];
    if (myPages.includes(id)) {
      this.setState({page:id, modal:{show:false,type:null,editId:null}});
    } else {
      const map = {
        dashboard:  './',
        officers:   'officers.html',
        members:    'members.html',
        invoices:   'invoices.html',
        ledger:     'ledger.html',
        budget:     'budget.html',
        statements: 'statements.html',
        events:     'events.html',
        tasks:      'tasks.html',
        assembly:   'assembly.html',
        proposals:  'proposals.html',
        archive:    'archive.html',
        settings:   'settings.html',
        audit:      'audit.html',
      };
      window.location.href = map[id] || './';
    }
  },
  openModal(type,editId=null,fd={}) {
    // P0-AUTH-01: 理事は請求書・入出金・予算・期の入力画面を開けない（サーバーでも拒否される）
    const RO = {invoice:'invoices', transaction:'transactions', budget:'budgetItems', period:'periods'};
    if (RO[type] && this._canEdit && !this._canEdit(RO[type])) return;
    this.setState({modal:{show:true,type,editId},formData:{...fd}});
  },
  closeModal() { this.setState({modal:{show:false,type:null,editId:null},formData:{}}); },
  setField(k,v) { this.setState(s=>({formData:{...s.formData,[k]:v}})); },
  onInput(e) { this.setField(e.target.dataset.field, e.target.value); },

  showToast(msg) {
    if (this.state._tt) clearTimeout(this.state._tt);
    const t = setTimeout(()=>this.setState({toast:null,_tt:null}),3000);
    this.setState({toast:msg,_tt:t});
  },

  _openPrintWindow(bodyHtml, title, noPageNum) {
    let overlay = document.getElementById('_portal_print_overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = '_portal_print_overlay';
      document.body.appendChild(overlay);
    }
    // noPageNum=true のとき @bottom-center を非表示（スタイル注入で上書き）
    const pageStyle = noPageNum
      ? '<style>@page{@bottom-center{content:none;}@bottom-left{content:none;}@bottom-right{content:none;}}</style>'
      : '';
    overlay.innerHTML = pageStyle + bodyHtml;
    const prevTitle = document.title;
    document.title = title;
    setTimeout(() => {
      window.print();
      window.onafterprint = () => {
        overlay.innerHTML = '';
        document.title = prevTitle;
        window.onafterprint = null;
      };
    }, 300);
  },

  // ログイン中のユーザー情報を取得（P0-AUTH-01: サーバーが確認したログイン情報＝PortalAuth から）
  getLoginInfo() {
    const s = window.PortalAuth ? window.PortalAuth.session() : null;
    if (!s) return { email: '', name: '' };
    return { email: s.email || '', name: s.name || '' };
  },

  // ログイン名を役員名として取得（設定の emailMap を参照）
  getLoggedInName() {
    const auth = this.getLoginInfo();
    if (!auth.email) return '';
    const emailMap = (this.state.orgInfo || {}).emailMap || {};
    if (emailMap[auth.email]) return emailMap[auth.email];
    // フォールバック: 認証ユーザーに登録された名前
    return auth.name || '';
  },


  _buildOfficersAgendaHtml() {
    const pid=this.state.currentPeriodId;
    const officers=(this.state.officers||[]).filter(o=>o.periodId===pid);
    if(!officers.length) return '<p style="font-size:11pt;color:#555;">役員が登録されていません。</p>';
    const esc=str=>String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    let html='<table style="width:100%;border-collapse:collapse;font-size:10pt;"><tr style="border-bottom:1pt solid #000;"><th style="padding:4pt 8pt;text-align:left;font-weight:600;width:90pt;">役職</th><th style="padding:4pt 8pt;text-align:left;font-weight:600;">氏名</th><th style="padding:4pt 8pt;text-align:left;font-weight:600;">店舗名</th><th style="padding:4pt 8pt;text-align:left;font-weight:600;">備考</th></tr>';
    officers.forEach(o=>{const mb=(this.state.members||[]).find(m=>m.id===o.memberId)||{};html+='<tr style="border-bottom:0.5pt solid #ddd;"><td style="padding:4pt 8pt;">'+esc(o.role)+'</td><td style="padding:4pt 8pt;">'+esc(mb.name||'')+'</td><td style="padding:4pt 8pt;">'+esc(mb.store||'')+'</td><td style="padding:4pt 8pt;">'+esc(o.memo||'')+'</td></tr>';});
    return html+'</table>';
  },

  _buildMembersAgendaHtml() {
    const members=(this.state.members||[]).filter(m=>m.type!=='その他'&&(!m.status||m.status==='在籍'));
    if(!members.length) return '<p style="font-size:11pt;color:#555;">会員が登録されていません。</p>';
    const esc=str=>String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    let html='<table style="width:100%;border-collapse:collapse;font-size:10pt;"><tr style="border-bottom:1pt solid #000;"><th style="padding:4pt 8pt;text-align:center;font-weight:600;width:32pt;">No.</th><th style="padding:4pt 8pt;text-align:left;font-weight:600;">店舗名</th><th style="padding:4pt 8pt;text-align:left;font-weight:600;">氏名</th><th style="padding:4pt 8pt;text-align:left;font-weight:600;">会員種別</th><th style="padding:4pt 8pt;text-align:left;font-weight:600;">電話</th></tr>';
    [...members].sort((a,b)=>(a.no||999)-(b.no||999)).forEach((m,i)=>{html+='<tr style="border-bottom:0.5pt solid #ddd;"><td style="padding:4pt 8pt;text-align:center;">'+(m.no||i+1)+'</td><td style="padding:4pt 8pt;">'+esc(m.store)+'</td><td style="padding:4pt 8pt;">'+esc(m.name)+'</td><td style="padding:4pt 8pt;">'+esc(m.type)+'</td><td style="padding:4pt 8pt;">'+esc(m.phone||'')+'</td></tr>';});
    return html+'</table><div style="font-size:10pt;text-align:right;margin-top:6px;">計 '+members.length+'名</div>';
  },
  calcFiscalYear(dateStr) {
    const d = dateStr ? new Date(dateStr) : new Date();
    const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear()-1; // 4月以降が新年度
    const reiwa = y - 2018;
    return `令和${reiwa}年度`;
  },

  // -----------------------------------------------
  // スプラッシュ表示判定
  // localStorage にデータがない（= 初回ログイン or クリア後）場合のみ true
  // → showLoader: !!loading && _shouldShowSplash() で使用
  // -----------------------------------------------
  _shouldShowSplash() {
    return !localStorage.getItem('nitta_v5');
  },

  // -----------------------------------------------
  // SS操作ロック（fetch中の誤操作防止）
  // -----------------------------------------------
  _injectSsLockMask() {
    if (document.getElementById('_ss_lock')) return;
    if (!document.getElementById('_ss_lock_style')) {
      const s = document.createElement('style');
      s.id = '_ss_lock_style';
      s.textContent = '@keyframes _spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(s);
    }
    const el = document.createElement('div');
    el.id = '_ss_lock';
    el.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(245,246,248,0.85);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);z-index:9994;align-items:center;justify-content:center;flex-direction:column;gap:16px;pointer-events:all;';
    el.innerHTML = '<div style="width:38px;height:38px;border:3px solid #DDDEE2;border-top-color:#E7C15F;border-radius:50%;animation:_spin 0.8s linear infinite;"></div><div style="font-size:13px;color:#6B7280;font-family:sans-serif;font-weight:500;letter-spacing:0.04em;">\u30c7\u30fc\u30bf\u3092\u540c\u671f\u4e2d...</div>';
    document.body.appendChild(el);
  },
  _showSsLock() {
    this._injectSsLockMask();
    const el = document.getElementById('_ss_lock');
    if (el) el.style.display = 'flex';
  },
  _hideSsLock() {
    const el = document.getElementById('_ss_lock');
    if (el) el.style.display = 'none';
  },

  };
})();
