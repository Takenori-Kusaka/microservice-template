# ADR-0011: Service communication

- Status: accepted
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0001, ADR-0010, ADR-0012, ADR-0013, ADR-0014, ADR-0017

## Context

サービス間の連携方式を統一しないと、同期呼び出しチェーンが深くなって障害が波及し、あるいは「非同期が流行だから」という理由で即時応答が必要な処理まで非同期化されて UX と整合性が壊れる。設計原則「Async by reason, not fashion」は、遅延許容、バッファ、ファンアウト、独立障害が必要な箇所だけ非同期化することを求める。

Amazon Builders' Library「Avoiding insurmountable queue backlogs」は、マルチテナント非同期システムで、キュー滞留時間の監視、ワークロード別の同時実行制限、超過トラフィックの退避、上流へのバックプレッシャーを組み合わせており、「Lambda が自動スケールするから容量設計不要」という考えを否定している。[^6]

EventBridge と SQS → Lambda の挙動（参照日 2026-10-17）は次のとおり。

- EventBridge は target への配信失敗時、既定で 24 時間・最大 185 回、指数 backoff + jitter で再試行し、使い切ると event を破棄する。DLQ を設定すれば失敗 event を受け取れる。[^56]
- Lambda の SQS event source mapping は at-least-once で、重複処理が起こりうるため関数は冪等でなければならない。[^113] 標準 queue では 5 並列から開始し、1 分当たり最大 300 並列ずつ増え、event source mapping 当たり最大 1,250 並列。`maxConcurrency`（2〜1,000）で上限を設定できる。[^58]
- queue の visibility timeout は関数 timeout の 6 倍以上（batch window を使う場合はその値を加算）を推奨。`maxReceiveCount` は 5 以上を推奨。[^57]
- partial batch response（`ReportBatchItemFailures`）で失敗したメッセージだけを再可視化でき、Powertools の Batch Processor が実装を担う。[^59]
- `ApproximateAgeOfOldestMessage` は queue 内の最古の未処理メッセージの経過秒数で、3 回以上受信されたメッセージは標準 queue で後方へ移動し、この metric から除外される。[^77]

本テンプレートでは、`apps/example-order-service` が DynamoDB Streams → outbox relay → EventBridge で `order.created.v1` を発行し、`apps/example-worker-service` が EventBridge → tier 別 SQS → Lambda BatchProcessor で消費する。`apps/example-workflow-service` は各サービスの公開 API / command を同期呼び出しする。

## Decision

準拠: Amazon Builders' Library「Avoiding insurmountable queue backlogs」[^6]、「Timeouts, retries, and backoff with jitter」[^5]、AWS Well-Architected REL05-BP03[^4]、AWS Lambda Developer Guide（SQS event source mapping）[^57][^58][^59][^113]、Amazon EventBridge User Guide（retry policy）[^56]、AWS Prescriptive Guidance「Transactional outbox」[^86]

連携方式を次の表で選ぶ。既定は **EventBridge によるイベント配信 + 必要箇所で SQS によるバッファ** とし、即時応答が必要な場合のみ同期 API を使う。

| 方式                             | 使う条件                                                                              | 使わない条件                                                              | 本テンプレートの例                           |
| -------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------- |
| 同期 API（API Gateway + Lambda） | 呼び出し元が結果を即時に必要とする。クライアント向け API。saga のステップ呼び出し     | 遅延許容で fan-out が必要。呼び出し先の障害を呼び出し元に波及させたくない | workflow-service → order-service の command  |
| EventBridge                      | サービス間の業務イベント、複数購読、疎結合ルーティング、schema registry[^79]          | 順序保証や consumer 側の同時実行制御が必要                                | order-service → `order.created.v1`           |
| SQS Standard                     | バッファ、バックプレッシャー、再試行、consumer scaling、tier 別 `maxConcurrency`[^58] | 同一 group 内の順序が業務上必要                                           | worker-service の tier 別 queue              |
| SQS FIFO                         | 同一 group 内の順序が **業務上本当に** 必要。並列度は message group 数で頭打ち[^58]   | スループットのみが理由                                                    | 例外 ADR 必須                                |
| SNS                              | 単純な push fan-out（メール、webhook）                                                | content-based routing が必要                                              | 通知系                                       |
| DynamoDB Streams                 | サービス内部のデータ変更捕捉（outbox / CDC）[^86]                                     | 外部公開契約として直接購読させる                                          | order-service の outbox relay                |
| EventBridge Pipes                | source → target をコードなしで接続                                                    | 変換が業務ロジックを含む                                                  | DynamoDB Streams → EventBridge の relay 候補 |

ルール:

- 同期呼び出しチェーンは 3 ホップ以内（ADR-0001）。超過は API composition、read model、非同期化で解消する。[^17]
- EventBridge の consumer は、自分の Service Stack 内に SQS queue を置き、`EventSubscription` Construct で rule → queue を接続する。EventBridge → Lambda 直結は、EventBridge 側の retry（24 時間 / 185 回）[^56]はあるものの consumer 側の同時実行制御とバッチ処理ができないため、標準では禁止する。
- SQS consumer は `PavedQueueConsumer` で partial batch failure[^59]、DLQ（`maxReceiveCount` 5 以上[^57]）、redrive、`ApproximateAgeOfOldestMessage` alarm[^77]、`maxConcurrency`[^58]を必須設定する。visibility timeout は関数 timeout × 6 + batch window とする。[^57]
- 他サービスの SQS queue へ直接 `SendMessage` しない。サービス間は必ず EventBridge または公開 API 経由とする。
- deadline / timeout budget を同期呼び出しの入口から下流へ伝播する（`@paas/runtime-context` の `deadline`）。gRPC の deadline propagation と同じ考え方で、残り時間を timeout として下流へ渡す。[^112]
- queue depth だけでなく滞留時間（`ApproximateAgeOfOldestMessage`）を SLO 化する。[^6][^77]
- DLQ の retention は元 queue より長く設定する。標準 queue では DLQ 移動後も元の enqueue 時刻で expiration が計算されるためである。[^76]

## Alternatives

### A. すべて同期 API（REST / gRPC）で連携

- 長所: 整合性が即時で、デバッグが直線的。
- 短所: 呼び出し先の障害・遅延が呼び出し元へ波及し、burst が下流 DB を直撃する。Builders' Library が示すバックプレッシャーと負荷平準化の手段がない。[^6] fan-out は呼び出し元がすべての購読者を知る必要があり、結合が強くなる。

### B. SQS のみ（EventBridge なし、producer が各 consumer queue へ送信）

- 長所: バッファと再試行が単純で、EventBridge の料金が不要。
- 短所: producer が consumer の queue を知る必要があり、購読者追加のたびに producer を変更する。schema registry[^79]と content-based routing がない。

### C. Kafka（Amazon MSK）によるイベントストリーム

- 長所: 順序保証、再読、高スループット、長期保持。
- 短所: cluster 運用と consumer group 管理が managed-first 原則[^11]に対して重い。中規模 PaaS のイベント量では EventBridge + SQS で十分。既定値（例示値）: 想定ピークが EventBridge の PutEvents quota（ap-northeast-1 既定 1,200 TPS、増枠可[^v1]）の 50% 未満なら EventBridge + SQS を使い、超えるなら Kinesis / MSK と比較する。quota の半分を超えると増枠申請が常態化するため、その前に比較する設計判断。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-09、workload profile の想定イベント量で見直す）。イベントの長期保持は EventBridge archive（既定で無期限保持、replay 可）[^78]で代替する。

## Consequences

- **費用**: EventBridge（PutEvents 単価）+ SQS（request 単価）が各イベントに加わる。batch size と event filtering で request 数を減らす（ADR-0018）。
- **性能**: 非同期経路は秒単位の遅延があるため、API 契約に整合性期待値（eventual、通常 N 秒以内）を明記する。
- **運用**: queue ごとに DLQ、redrive runbook、age alarm が増えるが、`PavedQueueConsumer` が自動生成する。
- **Lock-in**: EventBridge / SQS は AWS 固有だが、`@paas/event-contracts` の envelope（ADR-0013）は CloudEvents 準拠で他基盤へ移植できる。[^80]
- **移行**: 同期 → 非同期への変更は契約変更を伴うため、consumer 移行期間を設ける（ADR-0013）。

## Evidence

- Amazon Builders' Library: queue backlog と message age による遅延把握、ワークロード別同時実行制限。[^6]
- Amazon Builders' Library / Well-Architected: タイムアウト、限定された再試行、backoff + jitter。[^4][^5]
- Lambda SQS event source mapping の推奨設定（visibility timeout 6 倍、`maxReceiveCount` 5 以上、partial batch response）。[^57][^59]
- 受入基準「reserved concurrency により critical API が worker burst から保護される」を `tests/performance/burst-isolation/` で検証する。worker queue に 10,000 msg を投入した状態で `POST /orders` の p99 が ADR-0016 の SLO 内に収まることを確認する（負荷値は本テンプレートの初期値であり外部出典に基づかない。計測で確定: 初回試験の p99 と `Throttles` を本 ADR に記録し、負荷値を見直す。docs/decision/template-defaults.md#計測で確定する項目 M-14、現在は未計測・試験ディレクトリ未作成）。
- 受入基準「API → Lambda → DynamoDB → EventBridge → SQS → Lambda → Step Functions を `correlationId` で全件検索できる」を ADR-0015 で検証する。

## Compliance / How it is enforced

- `EventSubscription` Construct は rule の target として自 Service Stack 内の SQS queue のみを受け付け、Lambda 直結を型で排除する。rule target には DLQ を必須設定する。[^56]
- `PavedQueueConsumer` が DLQ（`maxReceiveCount: 5` 既定[^57]）、partial batch response（Powertools `BatchProcessor`）[^59]、`maxConcurrency`[^58]、visibility timeout（Lambda timeout × 6 + batch window）[^57]、`ApproximateAgeOfOldestMessage` alarm[^77]を自動設定し、欠落を許さない。DLQ の retention を元 queue より長く設定する。[^76]
- `PlatformGuardrails` が Lambda execution role に他 Service Stack の SQS queue への `sqs:SendMessage` 権限がある場合に synth を失敗させる。
- `PlatformGuardrails` が SQS FIFO queue を検出し、ADR 参照がなければ拒否する。
- `@paas/api-contracts` の生成 client は `deadline` を伝播し[^112]、`@paas/testing` の contract test で 3 ホップ超過を検出する（`X-Hop-Count` header を `PavedApiService` middleware が増分し、4 以上で 508 を返す）。

## 参考

[^4]: [REL05-BP03 Control and limit retry calls](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_mitigate_interaction_failure_limit_retries.html)（指針書 References より）

[^5]: [Timeouts, retries, and backoff with jitter](https://d1.awsstatic.com/builderslibrary/pdfs/timeouts-retries-and-backoff-with-jitter.pdf)（指針書 References より）

[^6]: [Avoiding insurmountable queue backlogs](https://aws.amazon.com/builders-library/avoiding-insurmountable-queue-backlogs/)（指針書 References より）

[^11]: [Operational Excellence Pillar - AWS Well-Architected Framework](https://docs.aws.amazon.com/pdfs/wellarchitected/latest/operational-excellence-pillar/wellarchitected-operational-excellence-pillar.pdf)（指針書 References より）

[^17]: [Enabling data persistence in microservices (Prescriptive Guidance)](https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/modernization-data-persistence/modernization-data-persistence.pdf)（指針書 References より）

[^56]: [How EventBridge retries delivering events](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-retry-policy.html)（参照日 2026-10-17）

[^57]: [Creating and configuring an Amazon SQS event source mapping](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html)（参照日 2026-10-17）

[^58]: [Configuring scaling behavior for SQS event source mappings](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html)（参照日 2026-10-17）

[^59]: [Handling errors for an SQS event source in Lambda](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html)（参照日 2026-10-17）

[^76]: [Using dead-letter queues in Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)（参照日 2026-10-17）

[^77]: [Available CloudWatch metrics for Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html)（参照日 2026-10-17）

[^78]: [Archiving and replaying events in Amazon EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-archive.html)（参照日 2026-10-17）

[^79]: [Amazon EventBridge schemas](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-schema.html)（参照日 2026-10-17）

[^80]: [CloudEvents Specification v1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md)（参照日 2026-10-17）

[^86]: [Transactional outbox pattern (AWS Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)（参照日 2026-10-17）

[^112]: [Deadlines - gRPC](https://grpc.io/docs/guides/deadlines/)（参照日 2026-10-17）

[^113]: [Using Lambda with Amazon SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)（参照日 2026-10-17）

[^v1]: [Amazon EventBridge quotas](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-quota.html)（参照日 2026-10-17。PutEvents throttle limit: ap-northeast-1 1,200 per second、調整可）
