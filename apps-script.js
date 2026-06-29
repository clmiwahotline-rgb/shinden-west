/**
 * 新田西口商店会 管理ポータル — Google Apps Script Web App
 *
 * ===== デプロイ設定 =====
 * 1. スプレッドシートを開く → 拡張機能 → Apps Script
 * 2. このコードを貼り付けて保存
 * 3. 「デプロイ」→「既存のデプロイを管理」→ バージョン更新
 *
 * ===== キャッシュ設計 =====
 * - CacheService（スクリプトキャッシュ）でデータを最大1時間キャッシュ
 * - 保存時にキャッシュを無効化 + lastModifiedタイムスタンプを更新
 * - Portal側は lastModified を比較し、変更なければ処理をスキップ
 * - 効果: GASレスポンス 2〜4秒 → キャッシュヒット時 0.2〜0.5秒
 */

const SHEETS = [
  'periods','members','officers','invoices',
  'transactions','budgetItems','events',
  'memberChangeLogs','invoiceLogs','orgInfo',
  'balanceLogs','settlements','authEmails','tasks'
];

const CACHE_KEY = 'PORTAL_DATA_V1';
const CACHE_TTL = 3600; // 1時間

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

// ===== APIキー管理 =====
function getApiKey() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('API_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    props.setProperty('API_KEY', key);
  }
  return key;
}
function checkApiKey(key) {
  if (!key) return false;
  return key === getApiKey();
}

// ===== lastModified管理 =====
function getLastModified() {
  return PropertiesService.getScriptProperties().getProperty('LAST_MODIFIED') || '0';
}
function updateLastModified() {
  const ts = String(Date.now());
  PropertiesService.getScriptProperties().setProperty('LAST_MODIFIED', ts);
  return ts;
}

// ===== キャッシュ管理 =====
function getCachedData() {
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get(CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch(e) {}
  return null;
}
function setCachedData(data) {
  try {
    const cache = CacheService.getScriptCache();
    const json = JSON.stringify(data);
    // CacheServiceの上限は100KB。超えたらキャッシュしない
    if (json.length < 95000) {
      cache.put(CACHE_KEY, json, CACHE_TTL);
    }
  } catch(e) {}
}
function invalidateCache() {
  try {
    CacheService.getScriptCache().remove(CACHE_KEY);
  } catch(e) {}
}

// ===== GETリクエスト =====
function doGet(e) {
  try {
    const params = e.parameter || {};
    const action = params.action || 'load';
    const key = params.key || '';
    const clientTs = params.ts || '0';

    if (!checkApiKey(key)) return jsonErr('APIキーが無効です');

    if (action === 'load') {
      const serverTs = getLastModified();

      // クライアントが持っているtsと一致 → 変更なし
      if (clientTs !== '0' && clientTs === serverTs) {
        return jsonOk({ modified: false, lastModified: serverTs });
      }

      // キャッシュヒット確認
      const cached = getCachedData();
      if (cached) {
        return jsonOk({ ...cached, lastModified: serverTs, fromCache: true });
      }

      // キャッシュミス → SSから全読込
      const data = loadAllData();
      setCachedData(data);
      return jsonOk({ ...data, lastModified: serverTs });

    } else if (action === 'getKey') {
      return jsonOk({ key: getApiKey() });
    }

    return jsonErr('不明なアクション: ' + action);
  } catch (err) {
    return jsonErr('doGetエラー: ' + err.toString());
  }
}

// ===== POSTリクエスト =====
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const key = body.key || '';
    if (!checkApiKey(key)) return jsonErr('APIキーが無効です');

    const action = body.action || 'save';

    if (action === 'save') {
      const result = saveAllData(body.data || {});
      // キャッシュ無効化 + lastModified更新
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
function loadAllData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  const result = {};

  SHEETS.forEach(function(name) {
    result[name] = readSheet(ss, name);
  });

  const meta = readSheet(ss, 'meta');
  result.currentPeriodId = (meta.length > 0 && meta[0].currentPeriodId)
    ? String(meta[0].currentPeriodId) : null;

  result.orgInfo = (result.orgInfo && result.orgInfo.length > 0)
    ? result.orgInfo[0] : {};

  const draft = props.getProperty('BUDGET_DRAFT');
  result.budgetDraft = draft ? JSON.parse(draft) : null;

  const aDoc = props.getProperty('ASSEMBLY_DOC');
  result.assemblyDoc = aDoc ? JSON.parse(aDoc) : null;

  return result;
}

// ===== データ保存 =====
function saveAllData(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();

  SHEETS.forEach(function(name) {
    if (name === 'orgInfo') {
      writeSheet(ss, name, data[name] ? [data[name]] : []);
    } else if (name === 'authEmails') {
      var emails = (data[name] || []).map(function(e) {
        return typeof e === 'string' ? {email: e, name: ''} : e;
      });
      writeSheet(ss, name, emails);
    } else if (Array.isArray(data[name])) {
      writeSheet(ss, name, data[name]);
    }
  });

  if (data.currentPeriodId !== undefined) {
    writeSheet(ss, 'meta', [{ currentPeriodId: data.currentPeriodId }]);
  }

  if (data.budgetDraft !== undefined) {
    if (data.budgetDraft) {
      props.setProperty('BUDGET_DRAFT', JSON.stringify(data.budgetDraft));
    } else {
      props.deleteProperty('BUDGET_DRAFT');
    }
  }

  if (data.assemblyDoc !== undefined) {
    if (data.assemblyDoc) {
      props.setProperty('ASSEMBLY_DOC', JSON.stringify(data.assemblyDoc));
    } else {
      props.deleteProperty('ASSEMBLY_DOC');
    }
  }

  return { saved: true };
}

// ===== シート読み書き =====
function readSheet(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues();
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
          const jst = new Date(v.getTime() + 9 * 60 * 60 * 1000);
          obj[h] = jst.toISOString().slice(0, 10);
        } else {
          obj[h] = v;
        }
      });
      return obj;
    });
}

function writeSheet(ss, name, rows) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.clearContents();
  if (!rows || rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const data = [headers].concat(rows.map(function(r) {
    return headers.map(function(h) {
      const v = r[h];
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    });
  }));
  sheet.getRange(1, 1, data.length, headers.length).setValues(data);
}
