# xangi-studioの登録

導入・更新は[使い方ガイド](docs/usage.md#準備と登録)、PDF・Office・Google資料とNotionの設定は同ガイドの各節を参照してください。

## チャット用スキルの導入

拡張の登録と、チャット担当が使うスキルの導入は別です。チャットから「原稿をxangi-studioへ渡して」「AIで編集して」「このPRを取り込んで」と依頼する場合は、同梱の [xs-xangi-studio](skills/xs-xangi-studio/SKILL.md) を利用する各workspaceへ導入します。xangi-studioはホスト内の拡張であり、別インスタンスの送信先登録は不要です。

このcheckoutを維持する場所に配置したうえで、対象workspaceの絶対パスを指定して実行します。`--workspace` は拡張のcheckoutではなく、会話を実行する作業場所です。

```bash
node scripts/install-skill.mjs --help
node scripts/install-skill.mjs --workspace /absolute/workspace
node scripts/install-skill.mjs --workspace /absolute/workspace --check
```

スクリプトは `skills/xs-xangi-studio` と `.claude/skills/xs-xangi-studio` に製品同梱版へのリンク、`.agents/skills/xs-xangi-studio/SKILL.md` にCodex向けの転送エントリを作ります。新規依存やホスト設定の変更、サービス再起動はありません。`--check` は読み取りのみで、全エントリが同梱版を参照すれば `ready: true` と終了コード0を返します。不足は終了コード1です。

同名の既存スキル・異なるリンク・旧 `.codex/skills` の競合があれば、導入前に停止します。既存のPR専用スキルなどを自動上書きせず、内容と呼び出し元を確認してから統合してください。既存workspaceの同期スクリプトが索引を管理している場合も、その管理方法に合わせます。checkout移動時は参照先の更新が必要です。

導入後、新しい会話で `xs-xangi-studio` の名前・説明がスキル一覧に出ることを確認します。既存会話のスキル一覧へ自動反映されるとは限りません。CLI呼び出しは対象ホストの実行環境で指定された絶対パスを `XANGI_CLI` に設定し、同ホストの `XANGI_TOOL_SERVER` を引き継いで確認します。別ホストのCLIやtool serverを推測して補いません。

```bash
"$XANGI_CLI" tool help extension_request
"$XANGI_CLI" extension status xangi-studio
"$XANGI_CLI" tool extension_request --id xangi-studio --capability review.changes --path /health --method GET
```

動作確認では、利用者が保存を依頼した短い原稿を保存のみで登録し、同じ内容を再取得して画面リンクを返せることを確認します。AI編集・レビュー・Notion送信・公開は個別の依頼時に実行します。APIの入力と結果確認は[スキルのAPI手順](skills/xs-xangi-studio/references/api.md)、開発時の隔離検証は[検証ガイド](docs/testing.md#チャット用スキル)を参照してください。

## xangiへの依頼

ホストにはManaged Extensionの`XANGI_EXTENSION_HOST_URL`と、通常のAgent Run・projects・agents・runtime-settings APIへの対応が必要です。操作は[使い方ガイド](docs/usage.md#xangiへ依頼する)を参照してください。
