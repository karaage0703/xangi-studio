# 開発者向け検証手順

この文書はxangi-studioの開発・修正を確認するための手順です。テストが保存するスクリーンショットはローカルの検証記録で、Notionに保存するレビューや資料画像とは別です。Notionへの実際の保存操作は[使い方ガイド](usage.md#notion保存任意)を参照してください。

ブラウザ検証にはChromiumが必要です。PlaywrightのChromiumを用意するか、対応スクリプトでは`BROWSER_EXECUTABLE`で既存の実行ファイルを指定します。

## README用スクリーンショット

`npm ci`後に`node scripts/readme-screenshots.mjs`で、実UIのPR差分・レビュー、スライドレビュー、Markdown原稿の編集画面を1440×960pxで撮影し、`docs/images/pr-review.png`・`docs/images/slide-review.png`・`docs/images/draft-editor.png`を更新します。Chromiumの既定パスは`/snap/bin/chromium`で、`BROWSER_EXECUTABLE`で変更できます。

APIはスクリプト内の架空のノートアプリのデータに置き換えます。レビュー文も固定のダミーで、AIは実行しません。スライドはコードで描いたページ画像をAPIへ渡しており、PPTXの取り込み・変換は検証しません。外部通信・APIへの書き込み・未定義APIは拒否し、ブラウザエラーがあれば失敗します。稼働中のxangiや保存済みの原稿、認証情報は使いません。

## チャット用スキル

`node --test tests/skill-install.test.mjs tests/artifact-requests.test.mjs` は、一時workspaceへのスキル導入・発見用エントリ・再実行・既存スキルの保護と、実サーバーへの原稿保存・再取得・受付重複防止・再起動後の保持を確認します。保存のみではAIが開始されず、明示した依頼だけが実行されることを確認します。AIホストを模擬し、稼働workspace・既存の草案・外部APIは変更しません。

## 資料レビューとNotion連携の検証

Office変換・Notion APIの回帰は`npm test`で確認します。`scripts/browser_document_check.py`は旧自動レビューUIを前提としているため、現行UIの合否判定には使いません。

## コードの範囲選択

コードの範囲選択の回帰検証: `node scripts/browser_selection_check.mjs`。`BROWSER_EXECUTABLE`でChromiumを指定できます。明暗テーマの編集・閲覧・左右差分・モバイル差分で、同一行の選択表示、コピー、Shift選択と複数行選択を確認します。バックエンドは不要で、スクリーンショットは`artifacts/selection/`へ保存します。

## 一覧の更新とレビュー結果の自動復旧

この経路のブラウザ検証はビルド後に `uv run --with playwright python scripts/browser_refresh_check.py` で実行できます。ヘッダーを制限する模擬中継を通し、変更なし応答、非表示タブの休止・復帰、モバイル幅、復旧ボタンが不要な画面を確認します。自動復旧・再処理抑止・版検証は `tests/review-jobs.test.mjs` で確認します。

## ページスクロール中のエディタ描画

`node scripts/browser_editor_render_check.mjs` は実際の画面とCodeMirrorをViteで起動し、1500行の文書をページスクロールして、画面内の行が描画され続けることを確認します。PC・スマホ幅の編集・閲覧・比較表示と、スクロール先の編集保存を検証します。APIは模擬し、外部への保存は行いません。画像と描画範囲の記録は `artifacts/editor-render/`（`EDITOR_ARTIFACTS` で変更可）へ出力します。`BROWSER_EXECUTABLE` でChromiumを指定できます。この検証は本番の保存応答時間を測定するものではありません。

## 概要と分割並列レビュー

概要・図解のブラウザ検証: `uv run --with playwright python scripts/browser_software_overview_check.py`。AI/GitHubを模擬し、PRとリポジトリの概要生成・図・根拠移動・戻る・再読込・既存ファイル表示・HTML文字列の非実行を1440px/390pxで確認します。証拠は`OVERVIEW_ARTIFACTS`（既定`/tmp/studio-software-overview`）へ保存します。

概要とレビューの独立実行・分割並列レビュー: build後に `uv run --with playwright python scripts/browser_review_pipeline_check.py`。1440px/390pxのPR・リポジトリで、概要のみ、担当1人の3組並列、担当2人の6会話、概要とレビューの同時実行、一部失敗時の成功分保持、画面閉鎖後の回収、再実行・再読込を模擬サービスで確認します。外部のAI・GitHub・Notionへの送信はありません。証拠は`PIPELINE_ARTIFACTS`（既定`/tmp/studio-review-pipeline`）へ保存します。保存・再起動・割当範囲・版と指示の検証は`tests/review-pipeline.test.mjs`で確認します。

## 下書きの自動保存

`uv run --with playwright python scripts/browser_draft_check.py`は隔離した実サーバーとエディタで、ブラウザ復旧本文を含む下書き復元、複数タブの後の保存採用、保存中の追加入力、通信失敗と再試行、下書き通信失敗時の明示保存、元ファイルとの分離、外部変更後の保存と履歴保持、保存失敗からの再試行、空本文・日本語・絵文字の文字数、PC幅の下部固定表示とスマホ幅の本文末尾配置を検証します。`DRAFT_ARTIFACTS`で画像保存先を指定できます。AIや外部APIは実行しません。`tests/drafts.test.mjs`は再起動後の読み戻し、後の保存採用・認証・閲覧専用・本文制限を確認します。

応答のない保存は `uv run --with playwright python scripts/browser_draft_timeout_check.py` で別に確認します。隔離サーバーの応答を遅らせ、15秒で失敗表示になることと本文・復旧コピーの保持を検証します。

## xangiへの依頼のブラウザ検証

`npm run build` → `node scripts/browser_request_check.mjs` で1440px/390pxの依頼・再読込・回答・会話リンク・下書きガード・一覧移動を確認します。AIは模擬し、外部送信しません。REQUEST_ARTIFACTSで証拠保存先を指定できます。

`npm run build` → `node scripts/browser_keyboard_check.mjs` で390px・768pxの本文末尾への非固定配置、長文編集中の非重複、縮小・ズーム時の配置と末尾からの保存、1440pxでの固定表示を検証します。`KEYBOARD_ARTIFACTS`で画像保存先を指定できます。iOS実機のキーボード挙動は別途確認が必要です。

下書きブラウザ検証は、サーバーと版が食い違う復旧本文を保持した再読込、複数タブでの後の保存採用、下書きの通信失敗から明示保存できることを確認します。

`npm run build` → `node scripts/browser_editable_imports_check.mjs` で取り込みテキスト3種類の編集、差分の変更前保護、下書き復元、保存失敗・再試行、保存後の再読込と閲覧専用ファイルを1440px/390pxで確認します。実サーバーは一時ディレクトリを使用し、GitHub説明は模擬します。`EDITABLE_ARTIFACTS`で画像と結果の保存先を指定できます。

## HTMLプレビュー

build後に `node scripts/browser_html_preview_check.mjs`。1440px/390pxでHTML描画、相対CSS/通常JS/SVG、下書きの表示・保存・再読込、リポジトリの表示/ソース切替、失敗からの再試行、既存Markdownを確認します。ホストのCSPとopaque-origin要求の拒否を模擬し、親DOM・localStorageへのアクセスと通信が遮断されること、単独起動のCSPでも動作することを確認します。`HTML_PREVIEW_ARTIFACTS`で画像と結果の保存先を指定できます。任意の`HTML_PREVIEW_SAMPLE`に`{"content":"..."}`形式の単体ゲームHTMLのJSONパスを渡すと、実際の攻撃操作も隔離環境で検証します。外部AIや稼働データへの書き込みはありません。API認証・同一取り込みと版の境界・本文保持・CSP・上限・失効は`tests/html-previews.test.mjs`で確認します。
