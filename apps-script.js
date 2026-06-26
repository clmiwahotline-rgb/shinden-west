/**
 * 新田西口商店会 管理ポータル — Google Apps Script Web App
 *
 * 【デプロイ手順】
 * 1. スプレッドシートを開く
 * 2. 拡張機能 → Apps Script
 * 3. このコードを貼り付けて保存（Ctrl+S）
 * 4. 「デプロイ」→「新しいデプロイ」
 *    - 種類: ウェブアプリ
 *    - 次のユーザーとして実行: 自分
 *    - アクセスできるユーザー: 組織内のユーザー全員（または特定ユーザー）
 * 5. デプロイしてURLを取得 → そのURLにアクセスするとポータルが開く
 *
 * 【アクセス制御】
 * ALLOWED_EMAILS にアクセスを許可するGmailアドレスを追加。
 * 空配列にすると組織内全員がアクセス可能。
 */

const ALLOWED_EMAILS = [
  // 例: 'taro@example.com',
  // 空配列にすると組織内全員許可
];

const SHEETS = [
  'periods','members','officers','invoices',
  'transactions','budgetItems','events',
  'memberChangeLogs','invoiceLogs','orgInfo'
];

// ===== 認証チェック =====
function checkAuth() {
  const email = Session.getActiveUser().getEmail();
  if (ALLOWED_EMAILS.length > 0 && !ALLOWED_EMAILS.includes(email)) {
    throw new Error('アクセス権限がありません: ' + email);
  }
  return email;
}

// ===== HTMLアプリを配信 =====
function doGet(e) {
  try {
    const email = checkAuth();
    const html = HtmlService.createHtmlOutputFromFile('portal')
      .setTitle('新田西口商店会 管理ポータル')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    return html;
  } catch(err) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:40px;text-align:center;">' +
      '<h2>🔒 アクセス拒否</h2><p>' + err.message + '</p>' +
      '<p><a href="https://accounts.google.com/signout">別アカウントでログイン</a></p></div>'
    );
  }
}

// ===== クライアントから呼び出す関数群 =====

/** 現在のログインユーザー情報を返す */
function getUserInfo() {
  const email = checkAuth();
  return { email, name: Session.getActiveUser().getEmail() };
}

/** 全データを読み込む */
function loadData() {
  checkAuth();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = { currentPeriodId: null };
  SHEETS.forEach(function(name) {
    result[name] = readSheet(ss, name);
  });
  // meta から currentPeriodId を取得
  const meta = readSheet(ss, 'meta');
  if (meta.length > 0 && meta[0].currentPeriodId) {
    result.currentPeriodId = String(meta[0].currentPeriodId);
  }
  // orgInfo は配列→オブジェクトに変換
  if (result.orgInfo && result.orgInfo.length > 0) {
    result.orgInfo = result.orgInfo[0];
  } else {
    result.orgInfo = {};
  }
  return result;
}

/** 全データを保存する */
function saveData(dataJson) {
  checkAuth();
  const data = JSON.parse(dataJson);
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  SHEETS.forEach(function(name) {
    if (name === 'orgInfo') {
      // orgInfoはオブジェクト→配列として保存
      writeSheet(ss, name, data[name] ? [data[name]] : []);
    } else if (Array.isArray(data[name])) {
      writeSheet(ss, name, data[name]);
    }
  });

  if (data.currentPeriodId !== undefined) {
    writeSheet(ss, 'meta', [{ currentPeriodId: data.currentPeriodId }]);
  }
  return { ok: true };
}

// ===== シート読み書きユーティリティ =====

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
        obj[h] = (v === '' || v === null || v === undefined) ? null : v;
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
      return (v === null || v === undefined) ? '' : v;
    });
  }));
  sheet.getRange(1, 1, data.length, headers.length).setValues(data);
}
