/**
 * 新田西口商店会 管理ポータル — Google Apps Script Web App
 *
 * ===== デプロイ設定 =====
 * 1. スプレッドシートを開く → 拡張機能 → Apps Script
 * 2. このコードを貼り付けて保存
 * 3. 「デプロイ」→「新しいデプロイ」
 *    - 種類: ウェブアプリ
 *    - 次のユーザーとして実行: 自分
 *    ★ アクセスできるユーザー: 全員（匿名ユーザーを含む）← ここが重要！
 * 4. デプロイ → URLをコピー
 * 5. ポータルの設定ページに貼り付け
 *
 * ===== セキュリティ =====
 * APIキーで保護します。初回アクセス時にスクリプトプロパティへ自動設定されます。
 * ポータルの設定ページでAPIキーを確認・変更できます。
 *
 * ===== APIキー確認方法 =====
 * Apps Script エディタ → プロジェクトの設定 → スクリプトプロパティ
 * → API_KEY の値を確認してポータルに入力
 */

const SHEETS = [
  'periods','members','officers','invoices',
  'transactions','budgetItems','events',
  'memberChangeLogs','invoiceLogs','orgInfo',
  'balanceLogs','settlements','authEmails','tasks'
];

// ===== CORS ヘッダー =====
function corsHeaders() {
  return ContentService.createTextOutput()
    .setMimeType(ContentService.MimeType.JSON);
}

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
    // 初回：ランダムキーを自動生成
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    props.setProperty('API_KEY', key);
  }
  return key;
}

function checkApiKey(key) {
  if (!key) return false;
  return key === getApiKey();
}

// ===== GETリクエスト（データ読み込み） =====
function doGet(e) {
  try {
    const params = e.parameter || {};
    const action = params.action || 'load';
    const key = params.key || '';

    // APIキー確認
    if (!checkApiKey(key)) {
      return jsonErr('APIキーが無効です');
    }

    if (action === 'load') {
      return jsonOk(loadAllData());
    } else if (action === 'getKey') {
      return jsonOk({ key: getApiKey() });
    }

    return jsonErr('不明なアクション: ' + action);
  } catch (err) {
    return jsonErr('doGetエラー: ' + err.toString());
  }
}

// ===== POSTリクエスト（データ保存） =====
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const key = body.key || '';

    if (!checkApiKey(key)) {
      return jsonErr('APIキーが無効です');
    }

    const action = body.action || 'save';

    if (action === 'save') {
      return jsonOk(saveAllData(body.data || {}));
    } else if (action === 'resetKey') {
      const newKey = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
      PropertiesService.getScriptProperties().setProperty('API_KEY', newKey);
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

  // meta → currentPeriodId
  const meta = readSheet(ss, 'meta');
  result.currentPeriodId = (meta.length > 0 && meta[0].currentPeriodId)
    ? String(meta[0].currentPeriodId) : null;

  // orgInfo: 配列→オブジェクト
  result.orgInfo = (result.orgInfo && result.orgInfo.length > 0)
    ? result.orgInfo[0] : {};

  // budgetDraft
  const draft = props.getProperty('BUDGET_DRAFT');
  result.budgetDraft = draft ? JSON.parse(draft) : null;

  // assemblyDoc（総会資料 — 複雑なJSONのためScriptPropertyに保存）
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

  // assemblyDoc（総会資料）
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
          // JST基準でYYYY-MM-DD形式に変換（UTC変換しない）
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
      // ネストされた配列・オブジェクトはJSON文字列として保存
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    });
  }));
  sheet.getRange(1, 1, data.length, headers.length).setValues(data);
}
