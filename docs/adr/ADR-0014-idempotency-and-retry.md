# ADR-0014: Idempotency and retry

- Status: accepted
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0010, ADR-0011, ADR-0013, ADR-0016

## Context

Amazon Builders' Library は、タイムアウト、限定された再試行、指数バックオフ、ジッター、冪等性を分散システムの基本としている。再試行は障害中の下流負荷を増幅し得るため、回数・総時間を制限し、API を安全に再試行可能にする必要がある。[^5] AWS Well-Architected REL05-BP03 も再試行回数の制限とジッターの導入を求めている。[^4]

サーバレス構成では再試行が複数の層に存在し、各層の既定値（参照日 2026-10-17）は次のとおりである。

- EventBridge target: 既定 24 時間、最大 185 回、指数 backoff + jitter。[^56]
- Lambda SQS event source mapping: at-least-once。失敗 batch は visibility timeout 後に再可視化され、`maxReceiveCount` 到達で DLQ へ。推奨 `maxReceiveCount` は 5 以上。[^113][^57]
- Step Functions Standard: exactly-once（`Retry` 指定時を除く）。Express 非同期: at-least-once。[^55]
- DynamoDB Streams 経由の outbox: consumer は重複を前提に冪等にする。[^86]

Powertools for AWS Lambda TypeScript の Idempotency utility（参照日 2026-10-17）は、イベントの一部（`eventKeyJmesPath`）から冪等キーを作り、DynamoDB に `functionName#hashOfPayload` をキーとするレコードを保存する。既定の有効期限は 3,600 秒（`expiresAfterSeconds`）。実行中は `INPROGRESS` 状態でロックされ、同一 payload の並行呼び出しには `IdempotencyAlreadyInProgressError` を投げる（安全に再試行可能）。`payloadValidationJmesPath` を設定すると、同一キーで payload が異なる場合に `IdempotencyValidationError` を投げる。DynamoDB TTL の削除は期限から最大 48 時間遅れるため、Powertools はレコード内のタイムスタンプで期限を判定する。[^84][^25]

`apps/example-order-service` の `POST /orders` は `tenantId` + `Idempotency-Key` header をキーに Powertools Idempotency を適用している。

## Decision

準拠: Amazon Builders' Library「Timeouts, retries, and backoff with jitter」[^5]、AWS Well-Architected REL05-BP03[^4]、Powertools for AWS Lambda (TypeScript) Idempotency[^84][^25]、AWS Lambda Developer Guide（SQS event source）[^57][^113]、Amazon EventBridge User Guide（retry policy）[^56]、RFC 9457（エラー応答形式）[^85]

### 冪等性

| 対象                                        | キー                                                              | 保存先                                                                                     | 保存期間（`expiresAfterSeconds`）                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 書き込み API（POST / PUT / PATCH / DELETE） | `tenantId` + `operation` + `Idempotency-Key` header               | Powertools Idempotency の DynamoDB table（Service Stack 内、`IdempotencyTable` Construct） | 86,400 秒（24 時間。Powertools 既定 3,600 秒[^84]より長く、クライアント再送の猶予を確保。既定値（例示値）: 24 時間は日次バッチ再送を吸収する長さとして置いた設計判断。調整: docs/decision/template-defaults.md#既定値レジスタ TD-12、client 再送間隔の実績で見直す）                              |
| イベント consumer                           | `tenantId` + `eventId`（envelope の `id`）                        | 同上                                                                                       | 7 日（EventBridge archive は既定で無期限保持[^78]、SQS の message retention は既定 4 日・最大 14 日[^v1]。既定値（例示値）: 7 日は retention と DLQ redrive の猶予を覆う長さとして置いた設計判断。調整: docs/decision/template-defaults.md#既定値レジスタ TD-13、DLQ redrive の運用実績で見直す） |
| Step Functions Task                         | `tenantId` + `executionId` + `stepName`                           | 同上                                                                                       | execution の最大時間 + 7 日                                                                                                                                                                                                                                                                       |
| 外部 API 呼び出し                           | 下流が受け付けるキー（例: payment provider の `idempotency_key`） | 下流                                                                                       | 下流の仕様に従う                                                                                                                                                                                                                                                                                  |

- `Idempotency-Key` header のない書き込み API は 400 を返す。クライアントは ULID を生成する。[^81]
- 同一キーで payload が異なる場合（`IdempotencyValidationError`[^84]）は 422 を返し、RFC 9457 の problem details（`type`, `title`, `status`, `detail`, `instance`、`application/problem+json`）[^85]で `error.code = IDEMPOTENCY_PAYLOAD_MISMATCH` を返す。
- 同一キーの並行リクエストは、Powertools の `INPROGRESS` ロックにより 2 件目が `IdempotencyAlreadyInProgressError` となり[^84]、409 を返す。
- `@paas/runtime-context` の `ExecutionContext.idempotencyKey` に格納し、ログと trace の annotation に付与する。

### 再試行

- **retry owner を呼び出しチェーンの一箇所に限定する。** Builders' Library は、複数層での再試行が障害中の負荷を乗算することを警告している。[^5] 原則は次のとおり。

| 経路                                | retry owner                                                                                   | 他層の設定                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| クライアント → API Gateway → Lambda | クライアント SDK（最大 3 回、full jitter、総時間 10 秒）                                      | Lambda 内の AWS SDK は `maxAttempts: 2`、API Gateway は再試行しない                          |
| EventBridge → SQS → Lambda          | SQS（`maxReceiveCount: 5`[^57]、visibility timeout = Lambda timeout × 6 + batch window[^57]） | EventBridge target retry は既定（24 時間 / 185 回[^56]）のまま、Lambda 内で業務 retry しない |
| Step Functions Task                 | state machine の `Retry`（指数 backoff、`BackoffRate: 2`、`MaxAttempts: 3`、jitter）          | Task 内 Lambda は retry しない                                                               |
| Lambda → 外部 API                   | adapter 内の retry（transient error のみ、最大 3 回、full jitter、総時間 ≤ deadline 残り）    | 呼び出し元は retry しない                                                                    |

既定値（例示値）: 上表の回数・時間。方向性は Builders' Library の「retry owner を 1 層に限定、full jitter」[^5]で、回数は障害中の負荷増幅を 3 倍以内に抑えるための設計判断であり、外部文献に基づく数値ではない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-14）。計測で確定: `tests/resiliency/fault-injection.test.ts` の retry-storm 試験と sandbox での `tests/resiliency` 実行結果で見直す（M-16、ローカル試験は実装済み、sandbox 実行は未実施）。

- retry 対象は transient error（5xx、429、timeout、connection reset）のみ。4xx（429 除く）は retry しない。[^5]
- すべての network call に connection timeout（1 秒）と request timeout（`deadline` 残り時間と上限の小さい方）を設定する。[^5][^112]
- retry は指数 backoff + full jitter。最大回数と総時間の両方を設定する。[^5][^4]
- SQS consumer は partial batch response（`ReportBatchItemFailures`）で成功メッセージを再処理させない。[^59] poison message は `maxReceiveCount` 到達後 DLQ へ隔離し、redrive runbook に従う。[^76]

## Alternatives

### A. 冪等性を DynamoDB の条件付き書き込みだけで実現（Powertools Idempotency なし）

- 長所: 追加テーブルが不要。
- 短所: 「同一リクエストに対して同一レスポンスを返す」「並行リクエストの 2 件目を拒否する」を各 handler が手書きすることになり、実装のばらつきが生じる。Powertools はこれらを `INPROGRESS` ロックと保存レスポンスで提供する。[^84] 条件付き書き込みは domain の不変条件のために併用する。

### B. 全層で再試行を有効にする（既定のまま）

- 長所: 設定が不要。
- 短所: 一時障害で再試行が乗算され、下流を押し潰す。Builders' Library と REL05-BP03 が明確に否定している。[^5][^4]

### C. 再試行をすべて禁止し、失敗はクライアントへ即返す

- 長所: 副作用の重複が起きない。
- 短所: 一時障害で成功率が下がり、SLO を達成できない。限定された再試行と冪等性の組み合わせが正しい解である。[^5]

## Consequences

- **費用**: Idempotency table の書き込み（1 リクエストあたり `INPROGRESS` と `COMPLETE` の 2 回）[^84]と storage が加わる。TTL で自動削除する。
- **性能**: Idempotency の lookup で DynamoDB の読み書き（公称 single-digit millisecond[^v2]）が加わる。実測値は slo-baseline 試験で計測する。p99 budget（ADR-0016）の Lambda 配賦に含める。
- **運用**: `IDEMPOTENCY_PAYLOAD_MISMATCH` と 409 の件数を dashboard に出し、クライアント実装の誤りを検出する。
- **Lock-in**: Powertools Idempotency は Lambda 固有だが、persistence layer は差し替え可能。[^84]
- **移行**: 保存期間の変更は `expiresAfterSeconds` で行い、既存レコードには影響しない。冪等キー生成規則の変更は既存レコードを無効化するため[^84]、移行期間を設ける。

## Evidence

- Builders' Library / REL05-BP03: タイムアウト、限定された再試行、backoff + jitter。[^5][^4]
- Powertools Idempotency の仕様（既定 3,600 秒、`INPROGRESS`、payload validation、TTL 48 時間遅延）。[^84][^25]
- Lambda SQS event source は at-least-once。[^113]
- 受入基準「同一 idempotency key の並行リクエストで副作用が一度だけ発生する」を `tests/integration/idempotency/` で検証する。同一 `Idempotency-Key` で `POST /orders` を 20 並列で送り、DynamoDB の order レコードと `order.created.v1` イベントがそれぞれ 1 件であることを確認する。
- `tests/resiliency/retry-storm/` で下流 API に 30 秒の 503 を注入し、再試行の総数がチェーン全体で 3 回 × クライアント数以内であることを確認する。

## Compliance / How it is enforced

- `PavedApiService` の書き込みルートは Powertools `makeHandlerIdempotent` middleware（Middy）[^84]を自動適用し、`Idempotency-Key` header 欠落で 400 を返す。`eventKeyJmesPath` は `ExecutionContext.tenantId` + route + header から構成し、`payloadValidationJmesPath` に body を設定する。
- `PavedQueueConsumer` の preset が `eventId` ベースの idempotency を `BatchProcessor` の record handler に適用する。
- `PavedWorkflow` が全 Task に retry preset を適用し、Task 内 Lambda の AWS SDK retry を `maxAttempts: 1` に設定する環境変数を注入する。
- `@paas/observability` の AWS SDK client factory が `maxAttempts: 2`、connection timeout 1 秒、request timeout を `deadline` から算出して設定する。手書きの `new DynamoDBClient()` は eslint ルール `paas/use-client-factory`（未実装・予定。現状は各サービスの adapters/clients.ts に集約） で禁止する。
- `PlatformGuardrails` が SQS queue に DLQ と `maxReceiveCount`（5 以上[^57]）が設定されていることを検査する。
- エラー応答は `@paas/api-contracts` の problem details 型（RFC 9457）[^85]に統一し、`requestId` と再試行可能性（`retryable: boolean`）を extension member として含める。
- CI の `integration` ステップで idempotency と retry-storm のテストを毎回実行する。

## 参考

[^4]: [REL05-BP03 Control and limit retry calls](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_mitigate_interaction_failure_limit_retries.html)（指針書 References より）

[^5]: [Timeouts, retries, and backoff with jitter](https://d1.awsstatic.com/builderslibrary/pdfs/timeouts-retries-and-backoff-with-jitter.pdf)（指針書 References より）

[^25]: [Implementing idempotent AWS Lambda functions with Powertools for AWS Lambda (TypeScript)](https://aws.amazon.com/blogs/compute/implementing-idempotent-aws-lambda-functions-with-powertools-for-aws-lambda-typescript/)（指針書 References より）

[^55]: [Choosing workflow type in Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html)（参照日 2026-10-17）

[^56]: [How EventBridge retries delivering events](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-retry-policy.html)（参照日 2026-10-17）

[^57]: [Creating and configuring an Amazon SQS event source mapping](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html)（参照日 2026-10-17）

[^59]: [Handling errors for an SQS event source in Lambda](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html)（参照日 2026-10-17）

[^76]: [Using dead-letter queues in Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)（参照日 2026-10-17）

[^78]: [Archiving and replaying events in Amazon EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-archive.html)（参照日 2026-10-17）

[^81]: [ULID Specification (GitHub)](https://github.com/ulid/spec)（参照日 2026-10-17）

[^84]: [Idempotency - Powertools for AWS Lambda (TypeScript)](https://docs.aws.amazon.com/powertools/typescript/latest/features/idempotency/)（参照日 2026-10-17）

[^85]: [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html)（参照日 2026-10-17。RFC 7807 を廃止）

[^86]: [Transactional outbox pattern (AWS Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)（参照日 2026-10-17）

[^112]: [Deadlines - gRPC](https://grpc.io/docs/guides/deadlines/)（参照日 2026-10-17）

[^113]: [Using Lambda with Amazon SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)（参照日 2026-10-17）

[^v1]: [Amazon SQS message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)（参照日 2026-10-17。「By default, a message is retained for 4 days. The minimum is 60 seconds (1 minute). The maximum is 1,209,600 seconds (14 days).」）

[^v2]: [Amazon DynamoDB](https://aws.amazon.com/dynamodb/)（参照日 2026-10-17。「single-digit millisecond performance at any scale」）
