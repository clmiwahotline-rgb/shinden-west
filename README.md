# 新田西口商店会 管理ポータル

商店会の運営管理ツール。Google Apps Script で動作するウェブアプリ。

## 機能

- 役員名簿・会員管理
- 請求書発行・入金確認
- 入出金管理（現金/口座）
- 予算管理・決算書
- 事業記録
- 総会資料自動生成
- Google スプレッドシートと自動同期

## ファイル構成

```
apps-script.js   ... GAS バックエンド（認証・データ読み書き）
portal.html      ... フロントエンド HTML（GASが配信）
appsscript.json  ... GAS プロジェクト設定
```

## セットアップ

### 1. clasp をインストール

```bash
npm install -g @google/clasp
clasp login
```

### 2. GAS プロジェクトと紐付け

```bash
cp .clasp.json.example .clasp.json
# .clasp.json の scriptId を実際のIDに書き換える
```

GASのスクリプトIDは Apps Script エディタの  
設定（歯車）→「スクリプト ID」で確認できます。

### 3. コードをGASにプッシュ

```bash
clasp push
```

### 4. GASでデプロイ

Apps Script エディタで  
「デプロイ」→「新しいデプロイ」→「ウェブアプリ」

### 5. 更新フロー

```bash
# コードを編集後
clasp push          # GASに反映
git add .
git commit -m "変更内容"
git push            # GitHubに保存
```

## アクセス制御

`apps-script.js` の `ALLOWED_EMAILS` 配列にアクセス許可するメールアドレスを追加。

```js
const ALLOWED_EMAILS = [
  'tantou@example.com',
];
```

## データ

全データはGASに紐づくGoogleスプレッドシートに保存。  
シート一覧: periods / members / officers / invoices / transactions / budgetItems / events / memberChangeLogs / invoiceLogs / orgInfo
