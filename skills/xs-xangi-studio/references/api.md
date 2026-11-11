# チャットから使うAPI

対象ホストの `extension_request --id xangi-studio --capability review.changes` 経由で呼ぶ。CLIは実行環境で指定された絶対パスを使い、引数はhelpで確認する。

## 原稿の保存

`POST /api/reviews` に `{ "file": "drafts/example.md", "title": "原稿", "content": "本文", "before": "" }` を送る。返ったidで `GET /api/reviews/<id>` を取得し、保存内容を照合する。保存だけではAIは動かない。既存の原稿は `PUT /api/reviews/<id>` へ `{ "content": "更新後の本文" }` を送る。最後の保存を採用し、保存前の本文は履歴へ残す。閲覧専用の取り込み原本は変更しない。

## xangiへの依頼

`GET /api/request-options` のprojects/agentsから選ぶ。`POST /api/reviews/<id>/requests` へ以下を送る。

```json
{
  "requestId": "受付ごとの一意なID",
  "instruction": "結論を先にして、説明を短くしてください",
  "expectedVersion": "取得したversion",
  "agentId": "選択したエージェントID"
}
```

agentIdの代わりにprojectIdを指定できる。両方省略するとホストの既定設定。指示は必須、4,000文字以内。同じ受付の再確認は同じrequestIdと同じbodyを使う。異なる内容で同じIDを使うと409。同じ成果物の実行中も409。

`GET /api/reviews/<id>/requests` で状態・result・error・sessionIdを再取得する。queued/runningは未完了、succeededはホスト実行の完了、failedは失敗、interruptedは受付の成否未確認。受付未確認を新しいIDで自動再送しない。xangiの実行履歴を確認する。結果は原稿へ自動反映しない。追加指示は会話で続け、出力先と実際の変更内容を確認する。

## PR・リポジトリ・資料

`POST /api/import/github` にPR/リポジトリURLを渡し、`GET /api/import/github/jobs/<id>` で取り込み結果とskippedを確認する。PDF・Office・Google資料の入力は [利用ガイド](../../../docs/usage.md) と server/http.mjs を確認する。取り込みだけではAIを開始しない。PRの明示的レビューと概要生成は src/main.tsx / shared/review-plan.mjs / server/review-jobs.mjs の経路を使う。

## 結果のリンク

対象ホストで `web_status` のhelpを確認して実行し、URL候補から利用者の端末で開ける接続先を確認する。確認できなければ、保存結果と「Extensions → xangi-studio → 対象成果物」の経路を返し、直リンクは未確認と添える。URLの推測や転送・公開設定の変更はしない。

画面は `/api/extensions/xangi-studio/ui?review=<id>`、一覧は `/api/extensions/xangi-studio/ui`、依頼の会話は `/chat/<sessionId>`。IDはURLエンコードする。認証値や拡張内部の待受URLをリンクに含めない。

旧 `/api/studio/*`、独立した制作画面、採用版・書き出し・公開APIは廃止。互換処理や旧タスクの移行はない。
