# ADR-0012: Data ownership

- Status: accepted
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0001, ADR-0004, ADR-0010, ADR-0011, ADR-0013

## Context

ADR-0001 はマイクロサービスを「データ正本を所有する単位」と定義した。しかし、サーバレス環境では DynamoDB テーブルを複数の Lambda から読むことが技術的に簡単なため、意図せず共有 DB が生まれやすい。共有 DB は schema 変更の調整コスト、スケール競合、テナント越境の経路を生む。

AWS Prescriptive Guidance は database-per-service を推奨し、各データストアは外部サービスから直接アクセスせず、集約結果には API composition（CQRS で高速化可）、event sourcing を併用するとしている。[^17][^18][^32] 疎結合はマイクロサービスの中核特性であり、データストアの分散は polyglot persistence を可能にする一方、サービス横断クエリとトランザクションを複雑にする。[^17][^32]

DB 更新とイベント発行の二重書き込み問題に対して、AWS Prescriptive Guidance の transactional outbox パターンは、outbox table または CDC（DynamoDB Streams）で解決する実装を示している。DynamoDB Streams は item-level の変更を時系列順に捕捉し、consumer は冪等にする必要がある。[^86]

DynamoDB の保護機能（参照日 2026-10-17）: PITR は 1〜35 日の recovery period を設定でき、PITR 有効なテーブルを削除すると system backup が 35 日間無料で保持される。PITR の課金はテーブルサイズに基づき、recovery period の長さでは変わらない。[^90] `dynamodb:LeadingKeys` 条件は partition key によるアイテム単位の制御を提供するが、`Scan` は leading key に関係なく全アイテムを返す。[^89]

`apps/example-order-service` は `TenantAwareTable`（`pk=TENANT#<tenantId>`, `sk=ORDER#<orderId>`）を所有し、DynamoDB Streams による outbox relay で `order.created.v1` を EventBridge へ発行する。`apps/example-worker-service` は order データを API / イベント経由でのみ受け取る。

## Decision

準拠: AWS Prescriptive Guidance「Database-per-service pattern」[^18]、「Enabling data persistence in microservices」[^17][^32]、「Transactional outbox pattern」[^86]、「Database decomposition on AWS」[^53]、DynamoDB Developer Guide（PITR、fine-grained access control）[^90][^89]

**database-per-service を標準とする。** 各サービスは自分の Service Stack 内に datastore を所有し、他サービスは公開 API またはイベント経由でのみ参照する。[^18]

| 項目                  | 標準                                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DynamoDB              | 既定の datastore。`TenantAwareTable` で tenant 先頭キー、暗号化、PITR（35 日）[^90]、環境別 deletion policy を自動付与。アクセスパターン、partition key cardinality、hot partition 対策、GSI、条件付き書き込み、TTL を設計書（`apps/<service>/docs/data-model.md`）に明記 |
| Aurora / RDS          | 複雑な関係・制約・トランザクションが本質的な場合のみ。RDS Proxy で接続数を保護。schema はサービス専用                                                                                                                                                                     |
| S3                    | object ownership、prefix（`tenantId/` 先頭）、retention、versioning、malware scan、presigned URL を定義                                                                                                                                                                   |
| サービス横断参照      | read model / CQRS。[^18] 実行時の多段同期 join を避ける                                                                                                                                                                                                                   |
| 分散トランザクション  | Saga と補償（ADR-0010）。[^87] 整合性期待値を API 契約に含める                                                                                                                                                                                                            |
| DB 更新とイベント発行 | transactional outbox。DynamoDB では Streams（CDC）を使い、二重書き込みを禁止する[^86]                                                                                                                                                                                     |
| 移行設計              | tenant migration、cell migration、schema migration、backfill、reconciliation を設計対象に含める。schema 変更は expand / migrate / contract[^83]                                                                                                                           |

共有 DB の例外:

- 既存システムからの移行期に限り、共有 DB を **期限付き** で認める。AWS Prescriptive Guidance も、モノリスからの移行では段階的な database decomposition を前提としている。[^53]
- その場合もサービスごとの schema / table と IAM 分離を必須とし、他サービスの schema / table への権限を与えない。
- 例外 ADR に期限（最長 12 か月）、分離完了の判定基準、所有チームを記載する（既定値（例示値）: 12 か月。指針 §20 の例外 ADR 期限を四半期レビュー 4 回分に揃えた設計判断で、外部出典に基づかない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-10、半期レビューで例外 ADR の消化実績をもとに見直す）。）

## Alternatives

### A. 共有 DynamoDB テーブル（single-table design を複数サービスで共有）

- 長所: テーブル数が少なく、サービス横断クエリが 1 回で済む。
- 短所: key 設計の変更が全サービスに波及し、1 サービスの hot partition が他サービスを巻き込む。IAM でサービス境界を表現できず、テナント越境経路が増える。Prescriptive Guidance の database-per-service に反する。[^18] single-table design はサービス内でのみ採用する。

### B. 共有 Aurora cluster（schema per service）

- 長所: トランザクションと JOIN が使え、運用対象の cluster が 1 つ。
- 短所: cluster 障害と接続数上限が全サービスに波及する。schema 分離だけではサービス間の暗黙依存（cross-schema JOIN）を防げない。移行期の例外としてのみ認める。[^53]

### C. Data mesh / 共有データレイク経由の参照

- 長所: 分析用途のサービス横断参照に適する。
- 短所: 実行時の業務処理には遅延が大きすぎる。分析基盤（S3 + Athena 等）は本 ADR の対象外とし、各サービスがイベントまたは export で供給する構造を別 ADR で扱う。

## Consequences

- **費用**: サービス数分のテーブル・PITR 費用が生じる。PITR はテーブルサイズ課金のため[^90]、低負荷サービスの固定費は小さい。
- **性能**: サービス横断参照は read model の更新遅延（eventual consistency）を伴う。API 契約に整合性期待値を明記する。[^87]
- **運用**: 各サービスが自分の backup、PITR、migration を所有する。`TenantAwareTable` が PITR と deletion policy を環境別に自動設定する。
- **Lock-in**: DynamoDB の key 設計は AWS 固有。domain / ports / adapters の層分離により、repository adapter の差し替えで他ストアへ移行できる。
- **移行**: 共有 DB からの分離は expand / migrate / contract で行い[^83]、両書き期間の reconciliation job を必須とする（ADR-0020）。

## Evidence

- AWS Prescriptive Guidance: database-per-service の利点と、サービス横断クエリへの API composition / CQRS / event sourcing の併用。[^17][^18][^32]
- AWS Prescriptive Guidance: transactional outbox の DynamoDB Streams 実装。[^86]
- AWS Prescriptive Guidance（database decomposition）: 境界、データフロー、interface を最新化し、cross-service call に retry と circuit breaker を加える。[^53]
- 受入基準「tenant A の identity で tenant B のデータを取得・更新できない」を `tests/tenant-isolation/` で検証する。
- 受入基準「`cdk destroy` 時に stateful production resource を誤削除しない」を `TenantAwareTable` の `RemovalPolicy.RETAIN` + deletion protection の snapshot test で検証する。PITR 有効テーブルは削除時にも system backup が 35 日保持される。[^90]
- 四半期の conformance レビューで、Service Stack 外のテーブルへの IAM 権限件数（目標 0）と、期限付き共有 DB 例外の残数を報告する。

## Compliance / How it is enforced

- `TenantAwareTable` が partition key 規則、KMS 暗号化、PITR（`RecoveryPeriodInDays: 35`）[^90]、production での `RemovalPolicy.RETAIN` と deletion protection、standard tags を自動付与し、オプションで無効化できない。
- `PlatformGuardrails` Aspect が、Lambda / Step Functions / Fargate の execution role に自 Service Stack 外の DynamoDB テーブル、S3 bucket、RDS cluster への権限があれば synth を失敗させる。例外は `ServiceManifest.adrs` に共有 DB 例外 ADR の参照と期限があるときのみ通過し、期限超過で再び失敗する。
- `PlatformGuardrails` が pool テーブルへの `dynamodb:Scan` 許可を検出して拒否する。[^89]
- `PlatformGuardrails` が DynamoDB Streams の consumer が自 Service Stack 内であることを検査し、外部サービスによる直接購読を拒否する。
- `apps/<service>/docs/data-model.md` の存在を CI の `policy` ステップで必須化する。
- cdk-nag の AwsSolutions ルールパックで未暗号化ストレージと PITR 無効を拒否する。[^104]

## 参考

[^17]: [Enabling data persistence in microservices (Prescriptive Guidance)](https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/modernization-data-persistence/modernization-data-persistence.pdf)（指針書 References より）

[^18]: [Database-per-service pattern (Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-data-persistence/database-per-service.md)（指針書 References より）

[^32]: [Enabling data persistence in microservices - Introduction (日本語)](https://docs.aws.amazon.com/ja_jp/prescriptive-guidance/latest/modernization-data-persistence/introduction.html)（指針書 References より）

[^53]: [AWS Prescriptive Guidance - Database decomposition on AWS](https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/database-decomposition/database-decomposition.pdf)（指針書 References より）

[^83]: [ParallelChange (expand / contract) - Danilo Sato, martinfowler.com](https://martinfowler.com/bliki/ParallelChange.html)（参照日 2026-10-17）

[^86]: [Transactional outbox pattern (AWS Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)（参照日 2026-10-17）

[^87]: [Saga orchestration pattern (AWS Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga-orchestration.html)（参照日 2026-10-17）

[^89]: [Using IAM policy conditions for fine-grained access control (DynamoDB)](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html)（参照日 2026-10-17）

[^90]: [Enable point-in-time recovery in DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/PointInTimeRecovery_Howitworks.html)（参照日 2026-10-17）

[^104]: [cdk-nag (GitHub, cdklabs)](https://github.com/cdklabs/cdk-nag)（参照日 2026-10-17）
