/**
 * 新田西口商店会 管理ポータル — Google Apps Script Web App
 * [最適化版 2026-06]
 *
 * 主な改善点:
 * 1. CacheService をチャンク分割（100KB制限を回避） → キャッシュヒット時 0.2〜0.5秒
 * 2. PropertiesService を getProperties() で1回読み → ラウンドトリップ削減
 * 3. getSheets() で全シート一括取得 → getSheetByName() の繰り返し廃止
 * 4. putAll / getAll でキャッシュ操作をバッチ化
 */

const SHEETS = [
  'periods','members','officers','invoices',
  'transactions','budgetItems','events',
  'memberChangeLogs','invoiceLogs','orgInfo',
  'balanceLogs','settlements','authEmails','tasks','proposals','archiveDocs'
];

// キャッシュキープレフィックス（チャンク分割用）
const CACHE_PFX   = 'PD_V2_';   // バージョン変えたい時はここだけ変更
const CACHE_TTL   = 3600;        // 1時間
const CHUNK_SIZE  = 88000;       // 88KB / chunk（GAS 100KB上限に余裕を持たせる）

// ===== レスポンス =====
function jsonOk(data) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, ...data }))
    .setMimeType(ContentService.MimeType.JSON);
}
function jsonErr(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: false, error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== APIキー・タイムスタンプ（バッチ読み） =====
function getAllProps() {
  // PropertiesService を1回だけ呼ぶ（4回→1回）
  return PropertiesService.getScriptProperties().getProperties();
}

function checkApiKey(key, props) {
  const stored = props['API_KEY'];
  if (!stored) {
    // 初回: 引数のkeyをそのまま採用して保存
    PropertiesService.getScriptProperties().setProperty('API_KEY', key);
    return !!key;
  }
  return key === stored;
}

function getLastModified(props) {
  return props['LAST_MODIFIED'] || '0';
}

function updateLastModified() {
  const ts = String(Date.now());
  PropertiesService.getScriptProperties().setProperty('LAST_MODIFIED', ts);
  return ts;
}

// ===== チャンク分割キャッシュ =====
function getCachedData() {
  try {
    const cache = CacheService.getScriptCache();
    const head  = cache.get(CACHE_PFX + 'meta');
    if (!head) return null;

    const { count } = JSON.parse(head);
    if (!count || count < 1) return null;

    // 全チャンクをまとめて取得（getAll: 1回のAPI呼び出し）
    const keys   = Array.from({ length: count }, (_, i) => CACHE_PFX + i);
    const chunks = cache.getAll(keys);

    let json = '';
    for (let i = 0; i < count; i++) {
      const chunk = chunks[CACHE_PFX + i];
      if (chunk === null || chunk === undefined) return null; // 期限切れ
      json += chunk;
    }
    return JSON.parse(json);
  } catch(e) {
    console.warn('getCachedData error:', e.message);
    return null;
  }
}

function setCachedData(data) {
  try {
    const cache = CacheService.getScriptCache();
    const json  = JSON.stringify(data);

    // チャンクに分割
    const chunks = [];
    for (let i = 0; i < json.length; i += CHUNK_SIZE) {
      chunks.push(json.slice(i, i + CHUNK_SIZE));
    }

    // putAll で一括書き込み（1回のAPI呼び出し）
    const batch = { [CACHE_PFX + 'meta']: JSON.stringify({ count: chunks.length }) };
    chunks.forEach((chunk, i) => { batch[CACHE_PFX + i] = chunk; });
    cache.putAll(batch, CACHE_TTL);

    console.log('Cache set: ' + chunks.length + ' chunks, ' + json.length + ' bytes');
  } catch(e) {
    console.warn('setCachedData error:', e.message);
  }
}

function invalidateCache() {
  try {
    const cache = CacheService.getScriptCache();
    const head  = cache.get(CACHE_PFX + 'meta');
    if (!head) return;
    const { count } = JSON.parse(head);
    const keys = [CACHE_PFX + 'meta', ...Array.from({ length: count || 0 }, (_, i) => CACHE_PFX + i)];
    cache.removeAll(keys);
  } catch(e) {}
}

// ===== GETリクエスト =====
function doGet(e) {
  try {
    const params   = e.parameter || {};
    const action   = params.action || 'load';
    const key      = params.key || '';
    const clientTs = params.ts || '0';

    // プロパティを1回だけ読む
    const props = getAllProps();
    if (!checkApiKey(key, props)) return jsonErr('APIキーが無効です');

    if (action === 'load') {
      const serverTs = getLastModified(props);

      // 変更なし → 即返却
      if (clientTs !== '0' && clientTs === serverTs) {
        return jsonOk({ modified: false, lastModified: serverTs });
      }

      // キャッシュヒット
      const cached = getCachedData();
      if (cached) {
        return jsonOk({ ...cached, lastModified: serverTs, fromCache: true });
      }

      // キャッシュミス → SS全読込
      const data = loadAllData(props);
      setCachedData(data);
      return jsonOk({ ...data, lastModified: serverTs });

    } else if (action === 'getKey') {
      return jsonOk({ key: props['API_KEY'] || '' });
    }

    return jsonErr('不明なアクション: ' + action);
  } catch (err) {
    return jsonErr('doGetエラー: ' + err.toString());
  }
}

// ===== POSTリクエスト =====
function doPost(e) {
  try {
    const body   = JSON.parse(e.postData.contents || '{}');
    const key    = body.key || '';
    const props  = getAllProps();

    if (!checkApiKey(key, props)) return jsonErr('APIキーが無効です');

    const action = body.action || 'save';

    if (action === 'save') {
      // ===== 楽観的ロック: 競合チェック =====
      const clientTs = body.clientLastModified || '0';
      const serverTs = getLastModified(props);
      if (clientTs !== '0' && serverTs !== '0' && clientTs !== serverTs) {
        // 他のメンバーが更新済み → 競合エラーを返す（保存しない）
        return jsonOk({ ok: false, conflict: true, serverLastModified: serverTs });
      }
      const result = saveAllData(body.data || {}, props);
      invalidateCache();
      const newTs = updateLastModified();
      return jsonOk({ ...result, lastModified: newTs });

    } else if (action === 'resetKey') {
      const newKey = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
      PropertiesService.getScriptProperties().setProperty('API_KEY', newKey);
      invalidateCache();
      return jsonOk({ newKey });
    }

    return jsonErr('不明なアクション: ' + action);
  } catch (err) {
    return jsonErr(err.toString());
  }
}

// ===== データ読み込み =====
function loadAllData(props) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ★ getSheets() で全シートを一括取得 → getSheetByName() の繰り返し廃止
  const sheetMap = {};
  ss.getSheets().forEach(function(s) { sheetMap[s.getName()] = s; });

  const result = {};

  SHEETS.forEach(function(name) {
    result[name] = readSheetObj(sheetMap[name]);
  });

  // meta シート
  const metaRows = readSheetObj(sheetMap['meta']);
  result.currentPeriodId = (metaRows.length > 0 && metaRows[0].currentPeriodId)
    ? String(metaRows[0].currentPeriodId) : null;

  result.orgInfo = (result.orgInfo && result.orgInfo.length > 0)
    ? result.orgInfo[0] : {};

  // props はすでに取得済み（引数で受け取る）
  const draft = props ? props['BUDGET_DRAFT'] : null;
  result.budgetDraft = draft ? JSON.parse(draft) : null;

  const aDoc = props ? props['ASSEMBLY_DOC'] : null;
  result.assemblyDoc = aDoc ? JSON.parse(aDoc) : null;

  return result;
}

// ===== データ保存 =====
function saveAllData(data, props) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 保存対象シートをまとめて取得
  const sheetMap = {};
  ss.getSheets().forEach(function(s) { sheetMap[s.getName()] = s; });

  const sheetErrors = [];
  SHEETS.forEach(function(name) {
    try {
      if (name === 'orgInfo') {
        writeSheet(ss, sheetMap, name, data[name] ? [data[name]] : []);
      } else if (name === 'authEmails') {
        const emails = (data[name] || []).map(function(e) {
          return typeof e === 'string' ? { email: e, name: '' } : e;
        });
        writeSheet(ss, sheetMap, name, emails);
      } else if (Array.isArray(data[name])) {
        writeSheet(ss, sheetMap, name, data[name]);
      }
    } catch (sheetErr) {
      // 1シートの失敗が他シートの保存を巻き込まないようにする（例: 添付ファイルが巨大でセル上限超過）
      console.error('シート保存失敗:', name, sheetErr.message);
      sheetErrors.push(name + ': ' + sheetErr.message);
    }
  });

  if (data.currentPeriodId !== undefined) {
    writeSheet(ss, sheetMap, 'meta', [{ currentPeriodId: data.currentPeriodId }]);
  }

  // budgetDraft / assemblyDoc をまとめて書く
  const sp = PropertiesService.getScriptProperties();
  if (data.budgetDraft !== undefined) {
    data.budgetDraft
      ? sp.setProperty('BUDGET_DRAFT', JSON.stringify(data.budgetDraft))
      : sp.deleteProperty('BUDGET_DRAFT');
  }
  if (data.assemblyDoc !== undefined) {
    data.assemblyDoc
      ? sp.setProperty('ASSEMBLY_DOC', JSON.stringify(data.assemblyDoc))
      : sp.deleteProperty('ASSEMBLY_DOC');
  }

  return { saved: true, sheetErrors: sheetErrors.length ? sheetErrors : undefined };
}

// ===== シート読み込み（シートオブジェクト直接受け取り版） =====
function readSheetObj(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values  = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  return values.slice(1)
    .filter(function(row) { return row.some(function(v) { return v !== ''; }); })
    .map(function(row) {
      const obj = {};
      headers.forEach(function(h, i) {
        const v = row[i];
        if (v === '' || v === null || v === undefined) {
          obj[h] = null;
        } else if (v instanceof Date) {
          // JSTに変換してYYYY-MM-DD文字列化
          const jst = new Date(v.getTime() + 9 * 60 * 60 * 1000);
          obj[h] = jst.toISOString().slice(0, 10);
        } else {
          obj[h] = v;
        }
      });
      return obj;
    });
}

// ===== シート書き込み =====
function writeSheet(ss, sheetMap, name, rows) {
  let sheet = sheetMap[name];
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheetMap[name] = sheet; // キャッシュ更新
  }
  sheet.clearContents();
  if (!rows || rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const CELL_LIMIT = 45000; // Sheetsのセル上限(50,000)より安全マージン
  const data = [headers].concat(rows.map(function(r) {
    return headers.map(function(h) {
      const v = r[h];
      if (v === null || v === undefined) return '';
      let out = (typeof v === 'object') ? JSON.stringify(v) : String(v);
      if (out.length > CELL_LIMIT) {
        // 添付ファイル等の巨大データはセル上限超過でシート全体を巻き込むため間引く
        if (typeof v === 'object' && Array.isArray(v)) {
          // 配列（例: attachments）: dataUrlを間引いて再構築を試みる
          const trimmed = v.map(function(item) {
            if (item && typeof item === 'object' && item.dataUrl) {
              return { name: item.name, type: item.type, mimeType: item.mimeType, _tooLarge: true };
            }
            return item;
          });
          out = JSON.stringify(trimmed);
        }
        if (out.length > CELL_LIMIT) out = out.slice(0, CELL_LIMIT); // それでも超える場合は切り詰め
      }
      return typeof v === 'object' ? out : v;
    });
  }));
  sheet.getRange(1, 1, data.length, headers.length).setValues(data);
}
