// =============================================
// portal-shared.js  新田西口商店会管理ポータル
// 全ページDCで共通利用するメソッド群
// =============================================
(function() {
  'use strict';
  window.PortalMethods = {
  gen() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); },
  fmt(n) { return '¥' + Math.abs(n||0).toLocaleString('ja-JP'); },
  fmtD(d) { if (!d) return '—'; const [y,m,dd]=d.split('-'); return y+'.'+parseInt(m)+'.'+parseInt(dd); },

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
    return {...d, members, invoices, settlements};
  },

  loadLocal() {
    try {
      const raw = localStorage.getItem('nitta_v5');
      if (raw) {
        const d = this.migrate(JSON.parse(raw));
        this.setState({...d, loading:false}, ()=>this.persist());
        return;
      }
    } catch(e) {}
    this.seed();
  },

  parseSheets(d) {
    const n = v => parseFloat(v)||0;
    return {
      periods:       d.periods||[],
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
      balanceLogs:   (d.balanceLogs||[]).map(l=>({...l})),
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

  fetchSheets(url, apiKey, silent) {
    const key = apiKey || this.state.scriptApiKey || localStorage.getItem('nitta_api_key') || '';
    // ロック: 初回ロード(ssReady=false)または手動同期
    const shouldLock = !this.state.ssReady || !silent;
    if (shouldLock) this._showSsLock();
    if (!silent) this.setState({ syncStatus: 'syncing' });
    const lastTs = localStorage.getItem('nitta_last_modified') || '0';
    fetch(`${url}?action=load&key=${encodeURIComponent(key)}&ts=${lastTs}`)
      .then(r => r.text())
      .then(text => {
        const trimmed = text.trim().replace(/^\uFEFF/,'');
        try { return JSON.parse(trimmed); }
        catch(e) {
          const pos = parseInt((e.message.match(/position (\d+)/)||[])[1]||0);
          console.error('JSON parse error at pos', pos, ':', trimmed.slice(Math.max(0,pos-20),pos+50));
          throw e;
        }
      })
      .then(d => {
        if (d.error) throw new Error(d.error);
        // 変更なし → スキップ
        if (d.modified === false) {
          if (shouldLock) this._hideSsLock();
          this.setState({ syncStatus: 'ok', loading: false, lastSyncAt: Date.now() });
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
          const assemblyDoc = this._restoreAssemblyDoc ? this._restoreAssemblyDoc(parsed) : parsed;
          const merged = {...parsed, assemblyDoc};
          this.setState({ ...merged, loading: false, syncStatus: 'ok', ssReady: true, lastSyncAt: Date.now() });
          localStorage.setItem('nitta_v5', JSON.stringify(merged));
          if (shouldLock) this._hideSsLock();
          if (!silent) this.showToast('スプレッドシートから読み込みました');
        }
      })
      .catch(err => {
        console.warn('Sheets fetch failed:', err.message);
        if (shouldLock) this._hideSsLock();
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
    const apiKey = this.state.scriptApiKey || localStorage.getItem('nitta_api_key') || '';
    if (!url || !apiKey) return;
    if (!silent) this._showSsLock();
    // &ts= で lastModified を送ることで「変更なし→即スキップ」が効く
    const lastTs = localStorage.getItem('nitta_last_modified') || '0';
    fetch(`${url}?action=load&key=${encodeURIComponent(apiKey)}&ts=${lastTs}`)
      .then(r=>r.text())
      .then(text=>{ const d=JSON.parse(text.trim().replace(/^\uFEFF/,'')); if(!d.ok) throw new Error(d.error||'エラー'); return d; })
      .then(d=>{
        if (d.modified === false) { if (!silent) this._hideSsLock(); return; }
        if (d.lastModified) localStorage.setItem('nitta_last_modified', d.lastModified);
        const parsed = this.migrate(this.parseSheets(d));
        if (!parsed.periods || parsed.periods.length===0) { if(!silent){ this._hideSsLock(); this.showToast('SSにデータがありません');} return; }
        const assemblyDoc = this._restoreAssemblyDoc ? this._restoreAssemblyDoc(parsed) : parsed;
        const merged = {...parsed, assemblyDoc};
        this.setState({...merged, syncStatus:'ok', ssReady:true});
        localStorage.setItem('nitta_v5', JSON.stringify(merged));
        if (!silent) { this._hideSsLock(); this.showToast('SSから最新データを取得しました'); }
      })
      .catch(()=>{ if(!silent){ this._hideSsLock(); this.showToast('SS再読み込みに失敗しました'); } });
  },

  loadFromSS() {
    const url = this.state.scriptUrl || localStorage.getItem('nitta_script_url') || '';
    const apiKey = this.state.scriptApiKey || localStorage.getItem('nitta_api_key') || '';
    if (!url || !apiKey) { this.showToast('URLとAPIキーを先に設定してください'); return; }
    if (!confirm('SSのデータをローカルに上書き読み込みします。\nローカルの未同期データは上書きされます。よろしいですか？')) return;
    this.setState({ loading: true, syncStatus: 'syncing' });
    this._showSsLock();
    fetch(`${url}?action=load&key=${encodeURIComponent(apiKey)}&t=${Date.now()}`)
      .then(r=>r.text())
      .then(text=>{ const d=JSON.parse(text.trim().replace(/^\uFEFF/,'')); if(!d.ok) throw new Error(d.error||'エラー'); return d; })
      .then(d=>{
        const parsed = this.migrate(this.parseSheets(d));
        if (!parsed.periods || parsed.periods.length===0) throw new Error('SSにデータがありません');
        const assemblyDoc = this._restoreAssemblyDoc ? this._restoreAssemblyDoc(parsed) : parsed;
        const merged = {...parsed, assemblyDoc};
        this.setState({...merged, loading:false, syncStatus:'ok', ssReady:true});
        localStorage.setItem('nitta_v5', JSON.stringify(merged));
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
    const url = (this.state.scriptUrlInput||'').trim();
    const apiKey = (this.state.scriptApiKey||'').trim();
    localStorage.setItem('nitta_script_url', url);
    localStorage.setItem('nitta_api_key', apiKey);
    if (!url || !apiKey) {
      this.setState({ scriptUrl: '', syncStatus: null });
      this.showToast((!url && !apiKey) ? '連携を解除しました' : 'URLとAPIキーの両方を入力してください');
      return;
    }
    this.setState({ scriptUrl: url, scriptApiKey: apiKey, syncStatus: 'syncing', loading: true });
    this.fetchSheets(url, apiKey);
  },

  persist() {
    const {page,modal,formData,toast,_tt,loading,syncStatus,syncPaused,scriptUrl,scriptUrlInput,scriptApiKey,orgInfoInput,gasUser,...d} = this.state;
    try { localStorage.setItem('nitta_v5', JSON.stringify(d)); } catch(e){}
    const apiKey = this.state.scriptApiKey || localStorage.getItem('nitta_api_key') || '';
    const url = scriptUrl || localStorage.getItem('nitta_script_url') || '';
    if (url && apiKey && this.state.ssReady) {
      this.setState({ syncStatus: 'syncing' });
      const clientLastModified = localStorage.getItem('nitta_last_modified') || '0';
      fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'text/plain;charset=utf-8'},
        body: JSON.stringify({ action: 'save', key: apiKey, data: d, clientLastModified }),
      })
      .then(r => r.json())
      .then(res => {
        if (res.conflict) {
          this.setState({ syncStatus: 'error' });
          this.showToast('⚠️ 他のメンバーが更新中です。「↻ 更新」で最新を確認後、再度保存してください');
          return;
        }
        if (res.lastModified) localStorage.setItem('nitta_last_modified', res.lastModified);
        this.setState({ syncStatus: res.ok ? 'ok' : 'error' });
      })
      .catch(() => this.setState({ syncStatus: 'error' }));
    }
  },

  seed() {
    const p38 = this.gen();
    const p39 = this.gen();
    const periods = [
      {id:p38,name:'第38期',startDate:'2025-04-01',endDate:'2026-03-31'},
      {id:p39,name:'第39期',startDate:'2026-04-01',endDate:'2027-03-31'},
    ];
    // 会員名簿（令和8年6月19日現在）25名 + 役員代理1名
    const mb = [
      {no:1,name:'安斎 義憲',store:'(株)アンザイ',fee:24000,phone:'048-941-8326'},
      {no:2,name:'伊藤 浩',store:'ヘアーサロン ウイング',fee:24000,phone:'048-942-7993'},
      {no:3,name:'山中 利彦',store:'(株)カワチ薬品',fee:24000,phone:'048-941-4183'},
      {no:4,name:'奥住 公一',store:'(有)新田金寿司',fee:24000,phone:'048-942-5381'},
      {no:5,name:'小島 岳洋',store:'小島測量・土地家屋調査士事務所',fee:24000,phone:'048-941-8857'},
      {no:6,name:'横山 貞雄',store:'新田幼稚園',fee:24000,phone:'048-942-5516'},
      {no:7,name:'指田 泰三',store:'スポーツランド',fee:24000,phone:'048-944-2662'},
      {no:8,name:'岩波 秀一',store:'セブンイレブン草加金明通り店',fee:24000,phone:'048-944-2477'},
      {no:9,name:'中村 義弘',store:'草加建設(株)',fee:24000,phone:'048-943-7900'},
      {no:10,name:'高木 元一',store:'(株)高木商会',fee:24000,phone:'048-941-9941'},
      {no:11,name:'青柳 健',store:'(株)筑波',fee:24000,phone:'048-931-5832'},
      {no:12,name:'田中 一也',store:'ハートランドゴルフクラブ',fee:72000,phone:'048-942-7744'},
      {no:13,name:'中村 諭史',store:'(有)クリーニングみわ',fee:24000,phone:'048-943-2370'},
      {no:14,name:'広田 雅徳',store:'(株)広田',fee:24000,phone:'048-941-2165'},
      {no:15,name:'河野 文寿',store:'(株)山香煎餅本舗',fee:24000,phone:'048-941-1000'},
      {no:16,name:'青羽 吉治',store:'与志鮨',fee:24000,phone:'048-942-8144'},
      {no:17,name:'児玉 広行',store:'パンとケーキのお店 Asahido',fee:24000,phone:'048-942-1104'},
      {no:18,name:'(支店長)',store:'東京東信用金庫',fee:24000,phone:'048-931-1541'},
      {no:19,name:'石丸 妙子',store:'ビューティースタジオ モコ',fee:24000,phone:'048-943-0560'},
      {no:20,name:'小森 豊',store:'ざぼう',fee:24000,phone:'048-946-7278'},
      {no:21,name:'髙橋 利幸',store:'シンコースポーツ(株)',fee:24000,phone:'048-942-8181'},
      {no:22,name:'長沼 雅弘',store:'ドレミ薬局',fee:24000,phone:'048-931-5534'},
      {no:23,name:'新井 浩介',store:'セブンイレブン草加新田店',fee:24000,phone:'048-932-2770'},
      {no:24,name:'伊藤 博之',store:'広島お好み焼き 空島',fee:24000,phone:'048-944-7588'},
      {no:25,name:'(店長)',store:'ピーアーク',fee:72000,phone:'048-943-0061'},
      {no:26,name:'渡辺 強一',store:'草加建設(株)（役員代理）',type:'その他',fee:0,phone:'048-943-7900'},
    ].map(m=>({id:this.gen(),type:'正会員',email:'',...m}));
    const members = mb;

    // 役員（会員IDを参照）
    const od = [
      {role:'会長',memberId:mb[7].id},   // 岩波 秀一
      {role:'副会長',memberId:mb[10].id}, // 青柳 健（庶務）
      {role:'副会長',memberId:mb[0].id},  // 安斎 義憲（渉外）
      {role:'監事',memberId:mb[25].id},   // 渡辺 強一
      {role:'監事',memberId:mb[1].id},    // 伊藤 浩
      {role:'役員',memberId:mb[20].id},   // 髙橋 利幸
      {role:'役員',memberId:mb[12].id},   // 中村 諭史（会計）
      {role:'役員',memberId:mb[16].id},   // 児玉 広行
      {role:'相談役',memberId:mb[5].id},  // 横山 貞雄
    ];
    const officers = [
      ...od.map(o=>({id:this.gen(),periodId:p38,memo:'',...o})),
      ...od.map(o=>({id:this.gen(),periodId:p39,memo:'',...o})),
    ];

    // 請求書（第38期：済み / 第39期：未払い）
    const inv38 = mb.filter(m=>m.fee>0).map(m=>({
      id:this.gen(),periodId:p38,memberId:m.id,memberName:m.name,memberStore:m.store,
      type:'会費',amount:m.fee,status:'済み',issuedDate:'2025-04-01',paidDate:'2025-05-31',dueDate:'2025-04-30',
    }));
    const inv39 = mb.filter(m=>m.fee>0).map(m=>({
      id:this.gen(),periodId:p39,memberId:m.id,memberName:m.name,memberStore:m.store,
      type:'会費',amount:m.fee,status:'未払い',issuedDate:'2026-04-01',paidDate:null,dueDate:'2026-04-30',
    }));

    // 第38期 入出金（令和7年度 収支決算書より）
    const tx38 = [
      {id:this.gen(),periodId:p38,date:'2025-04-01',description:'前期繰越金',category:'繰越金',income:2175259,expense:0},
      {id:this.gen(),periodId:p38,date:'2025-05-31',description:'会費収入（全会員）',category:'会費収入',income:696000,expense:0},
      {id:this.gen(),periodId:p38,date:'2025-09-30',description:'草加市補助金・盆踊り手伝い・利息等',category:'雑収入',income:126270,expense:0},
      {id:this.gen(),periodId:p38,date:'2025-04-15',description:'草加市商店連合協同組合費',category:'諸会費',income:0,expense:15500},
      {id:this.gen(),periodId:p38,date:'2026-02-11',description:'シンサヤママーケット視察（研修）',category:'研修事業費',income:0,expense:62273},
      {id:this.gen(),periodId:p38,date:'2026-02-06',description:'新年会（於：与志鮨）',category:'親睦事業費',income:0,expense:72380},
      {id:this.gen(),periodId:p38,date:'2025-06-13',description:'定期総会費（於：ざぼう）',category:'総会費',income:0,expense:44080},
      {id:this.gen(),periodId:p38,date:'2025-07-01',description:'役員会等 会議費',category:'会議費',income:0,expense:10756},
      {id:this.gen(),periodId:p38,date:'2025-08-01',description:'切手代等 事務費',category:'事務費',income:0,expense:5040},
      {id:this.gen(),periodId:p38,date:'2025-07-26',description:'盆踊り・運動会祝い金等',category:'交際費',income:0,expense:44000},
      {id:this.gen(),periodId:p38,date:'2025-04-01',description:'レンタル倉庫賃料（通年）',category:'トランクルーム倉庫費',income:0,expense:123250},
      {id:this.gen(),periodId:p38,date:'2025-12-01',description:'証明手数料・振込手数料等',category:'雑費',income:0,expense:3655},
      {id:this.gen(),periodId:p38,date:'2025-11-23',description:'新田村TGF2025秋（地域活性化事業）',category:'地域活性化事業費',income:0,expense:350294},
    ];
    const tx39 = [
      {id:this.gen(),periodId:p39,date:'2026-04-01',description:'前期繰越金（第38期より）',category:'繰越金',income:2271301,expense:0},
    ];

    // 予算（第38期：令和7年度予算 / 第39期：令和8年度予算）
    const bg38 = [
      {id:this.gen(),periodId:p38,type:'収入',category:'繰越金',amount:2175259},
      {id:this.gen(),periodId:p38,type:'収入',category:'会費収入',amount:696000},
      {id:this.gen(),periodId:p38,type:'支出',category:'諸会費',amount:19500},
      {id:this.gen(),periodId:p38,type:'支出',category:'研修事業費',amount:20000},
      {id:this.gen(),periodId:p38,type:'支出',category:'親睦事業費',amount:50000},
      {id:this.gen(),periodId:p38,type:'支出',category:'会議費',amount:50000},
      {id:this.gen(),periodId:p38,type:'支出',category:'総会費',amount:80000},
      {id:this.gen(),periodId:p38,type:'支出',category:'事務費',amount:5000},
      {id:this.gen(),periodId:p38,type:'支出',category:'交際費',amount:40000},
      {id:this.gen(),periodId:p38,type:'支出',category:'慶弔費',amount:50000},
      {id:this.gen(),periodId:p38,type:'支出',category:'トランクルーム倉庫費',amount:123250},
      {id:this.gen(),periodId:p38,type:'支出',category:'雑費',amount:10000},
      {id:this.gen(),periodId:p38,type:'支出',category:'地域活性化事業費',amount:600000},
    ];
    const bg39 = [
      {id:this.gen(),periodId:p39,type:'収入',category:'会費収入',amount:696000},
      {id:this.gen(),periodId:p39,type:'支出',category:'諸会費',amount:71500},
      {id:this.gen(),periodId:p39,type:'支出',category:'研修事業費',amount:150000},
      {id:this.gen(),periodId:p39,type:'支出',category:'親睦事業費',amount:25000},
      {id:this.gen(),periodId:p39,type:'支出',category:'会議費',amount:20000},
      {id:this.gen(),periodId:p39,type:'支出',category:'総会費',amount:80000},
      {id:this.gen(),periodId:p39,type:'支出',category:'事務費',amount:5000},
      {id:this.gen(),periodId:p39,type:'支出',category:'交際費',amount:50000},
      {id:this.gen(),periodId:p39,type:'支出',category:'慶弔費',amount:50000},
      {id:this.gen(),periodId:p39,type:'支出',category:'レンタル倉庫',amount:123250},
      {id:this.gen(),periodId:p39,type:'支出',category:'雑費',amount:10000},
      {id:this.gen(),periodId:p39,type:'支出',category:'地域活性化事業費',amount:700000},
      {id:this.gen(),periodId:p39,type:'支出',category:'info.ボード準備金',amount:452183},
      {id:this.gen(),periodId:p39,type:'支出',category:'備品購入',amount:200000},
      {id:this.gen(),periodId:p39,type:'支出',category:'予備費',amount:535798},
    ];

    // 事業記録（第38期：令和7年度事業報告 / 第39期：令和8年度事業計画）
    const ev38 = [
      {id:this.gen(),periodId:p38,name:'草加市補助金制度説明会',type:'総会・会議',date:'2025-04-15',endDate:'',participants:'中村・岩波',notes:'草加市補助金制度の説明会に出席。'},
      {id:this.gen(),periodId:p38,name:'草加市商連総会',type:'総会・会議',date:'2025-05-22',endDate:'',participants:'横山・岩波',notes:'草加市商店連合協同組合総会に出席。'},
      {id:this.gen(),periodId:p38,name:'第38回定期総会',type:'総会・会議',date:'2025-06-13',endDate:'',participants:'全役員',notes:'於：ざぼう。令和6年度決算・令和7年度予算承認。'},
      {id:this.gen(),periodId:p38,name:'金明町夏祭りお手伝い',type:'お祭り・縁日',date:'2025-07-25',endDate:'2025-07-26',participants:'役員複数名',notes:'金明町夏祭りのお手伝い。'},
      {id:this.gen(),periodId:p38,name:'新田村TGF2025秋',type:'文化・交流',date:'2025-11-23',endDate:'',participants:'一般来場者多数',notes:'計5回の実行委員会を経て開催。12/4 西口反省会（於：アンザイ）。'},
      {id:this.gen(),periodId:p38,name:'新年会',type:'その他',date:'2026-02-06',endDate:'',participants:'役員',notes:'於：与志鮨。'},
      {id:this.gen(),periodId:p38,name:'シンサヤママーケット視察',type:'研修事業',date:'2026-02-11',endDate:'',participants:'役員',notes:'研修事業として視察を実施。'},
    ];
    const ev39 = [
      {id:this.gen(),periodId:p39,name:'SOKA新田村TGF2026春',type:'文化・交流',date:'2026-04-29',endDate:'',participants:'',notes:'於：新田幼稚園。3/30出店者説明会実施済み。'},
      {id:this.gen(),periodId:p39,name:'草加市商連総会',type:'総会・会議',date:'2026-05-25',endDate:'',participants:'横山・岩波',notes:'草加市商連総会に出席。'},
      {id:this.gen(),periodId:p39,name:'第39回定期総会',type:'総会・会議',date:'2026-06-19',endDate:'',participants:'',notes:'於：金寿司。'},
      {id:this.gen(),periodId:p39,name:'金明町夏祭りお手伝い',type:'お祭り・縁日',date:'2026-07-01',endDate:'',participants:'',notes:'日程未定。'},
      {id:this.gen(),periodId:p39,name:'研修・視察事業（第2回）',type:'研修事業',date:'2026-08-01',endDate:'',participants:'',notes:'日程・内容未定。'},
      {id:this.gen(),periodId:p39,name:'SOKA新田村TGF2026秋',type:'文化・交流',date:'2026-11-23',endDate:'',participants:'',notes:'於：新田幼稚園。6〜11月に準備会合を開催予定。'},
      {id:this.gen(),periodId:p39,name:'新年会',type:'その他',date:'2027-02-01',endDate:'',participants:'',notes:'会場未定。'},
      {id:this.gen(),periodId:p39,name:'研修・視察事業（第3回）',type:'研修事業',date:'2027-02-15',endDate:'',participants:'',notes:'日程・内容未定。'},
    ];

    this.setState({
      periods, currentPeriodId:p39,
      officers, members,
      invoices:[...inv38,...inv39],
      transactions:[...tx38,...tx39],
      budgetItems:[...bg38,...bg39],
      events:[...ev38,...ev39],
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
      };
      window.location.href = map[id] || './';
    }
  },
  openModal(type,editId=null,fd={}) { this.setState({modal:{show:true,type,editId},formData:{...fd}}); },
  closeModal() { this.setState({modal:{show:false,type:null,editId:null},formData:{}}); },
  setField(k,v) { this.setState(s=>({formData:{...s.formData,[k]:v}})); },
  onInput(e) { this.setField(e.target.dataset.field, e.target.value); },

  showToast(msg) {
    if (this.state._tt) clearTimeout(this.state._tt);
    const t = setTimeout(()=>this.setState({toast:null,_tt:null}),3000);
    this.setState({toast:msg,_tt:t});
  },

  _openPrintWindow(bodyHtml, title, noPageNum) {
    // DOMに印刷オーバーレイを注入（window.open不要）
    let overlay = document.getElementById('_portal_print_overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = '_portal_print_overlay';
      document.body.appendChild(overlay);
    }
    const pageFooterHtml = noPageNum ? '' :
      '<div style="position:fixed;bottom:8mm;left:0;right:0;text-align:center;font-size:9pt;font-family:serif;" class="_print_pnum"></div>';
    overlay.innerHTML = bodyHtml + pageFooterHtml;
    // タイトルを一時変更（ブラウザ印刷ダイアログのタイトル欄に表示）
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
    el.innerHTML = '<div style="width:38px;height:38px;border:3px solid #DDDEE2;border-top-color:#E7C15F;border-radius:50%;animation:_spin 0.8s linear infinite;"></div><div style="font-size:13px;color:#6B7280;font-family:'Noto Sans JP',sans-serif;font-weight:500;letter-spacing:0.04em;">データを同期中...</div>';
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
