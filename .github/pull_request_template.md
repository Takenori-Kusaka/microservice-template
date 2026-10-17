## 変更内容

<!-- 何を・なぜ。関連 ADR / issue -->

## 指針チェック（該当するものにチェック。根拠: docs/microservice-guidelines.md）

- [ ] **境界** 変更は 1 つのサービス境界に閉じている。他サービスの DB/テーブル/S3 prefix に直接アクセスしていない（§4, ADR-0012）
- [ ] **契約** OpenAPI / event schema を更新し、`pnpm schemas:check` と contract test が通る。破壊的変更は新 version（§6, §7, ADR-0013）
- [ ] **テナント** tenantId は authorizer claims / envelope からのみ取得。キーは `TENANT#` prefix（§5, §13）
- [ ] **冪等性・再試行** 書き込み API は Idempotency-Key、consumer は eventId で重複排除。retry は transient のみ、1 層で所有（§12, ADR-0014）
- [ ] **観測** 構造化ログに correlationId が載る。新しいアラームは顧客影響に紐づく。tenantId を metrics dimension にしていない（§14, §19）
- [ ] **性能・容量** 同時実行・メモリ・タイムアウトの変更は負荷試験 / power tuning の結果を添付（§10, §11）
- [ ] **IaC** paved-road construct を使用。`pnpm synth` が cdk-nag / wildcard IAM / retain policy で失敗しない。抑止（suppression）には理由と期限（§17）
- [ ] **所有** service.yaml / CODEOWNERS / runbook / threat model を更新（§3）
- [ ] **ADR** 指針から外れる判断は ADR（Context / Decision / Alternatives / Consequences / Evidence / Review date）を追加（§20）

## エビデンス

<!-- テスト結果、負荷試験、cost-model 出力、ダッシュボードのスクリーンショット -->

## ロールバック手順

<!-- alias の前バージョン / DB migration の contract 段階 など -->
