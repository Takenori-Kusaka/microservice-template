# ADR-0004: Tenant isolation models

- Status: accepted
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0003, ADR-0012, ADR-0017, ADR-0018

## Context

B2B マルチテナント PaaS では、テナント間のデータ越境を構造的に防ぎつつ、テナント当たり原価を低く保つ必要がある。AWS SaaS Lens は silo（テナント専用リソース）、pool（テナント間でリソースを共有）、bridge（一部を silo、一部を pool にする混合）の 3 モデルを定義し、「あるマイクロサービスは silo、別のマイクロサービスは pool」のようにサービス単位で選ぶことを明示している。規制プロファイルや noisy neighbor 特性が silo を、俊敏性やコストプロファイルが pool を指向する。[^91][^2]

SaaS Lens はまた、tenant context の解決、IAM scope、ログ付与を共通ライブラリへ隠蔽し、それ自体を別ネットワークサービスに分解して遅延を増やさないよう説明している。[^12][^13] DynamoDB の IAM 条件キー `dynamodb:LeadingKeys` は partition key の値でアイテム単位のアクセスを制限でき、`ForAllValues` 修飾子が必須である。ただし `Scan` は leading key に関係なく全アイテムを返すため、許可アクションから除外しなければならない。[^89]

本テンプレートの `apps/example-order-service` は、DynamoDB を `pk=TENANT#<tenantId>` / `sk=ORDER#<orderId>` で分割する pool モデルの実装例である。`@paas/runtime-context` の `ExecutionContext` が JWT authorizer context から `tenantId` と `tenantTier` を解決し、クライアント入力の `tenantId` をデータアクセスに使わせない。HTTP API の Lambda authorizer は payload format 2.0 の `context` オブジェクトで任意の値を integration に渡せる。[^64]

## Decision

準拠: AWS Well-Architected SaaS Lens（silo / pool / bridge、サービス単位の選択、共通ライブラリによる tenant context）[^91][^2][^12]、DynamoDB fine-grained access control（`dynamodb:LeadingKeys`）[^89]、AWS Security Pillar SEC01-BP01（アカウント境界）[^92]

**pool を標準とし、サービス単位で bridge / silo / account-per-tenant へ昇格できるようにする。** PaaS 全体で一律のモデルは採らない。[^91]

| モデル             | 標準用途                              | 実装                                                                                         | 昇格条件                                                                                         |
| ------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Pool               | 通常テナント（既定）                  | `TenantAwareTable` の `tenantId` 先頭キー、IAM `LeadingKeys` 条件[^89]、tier 別 API throttle | なし（既定）                                                                                     |
| Bridge             | 高負荷または規制差がある一部機能      | 同一サービス内で特定テーブル / queue だけ tenant 専用に分岐[^91]                             | noisy neighbor が tier 別 throttle で解決しない、または特定機能のみ規制対象                      |
| Silo               | 規制、専有性能、個別 KMS 鍵、障害隔離 | Service Stack を tenant 専用にデプロイ（同一アカウント、別 stack）[^91]                      | 規制要件で専有 datastore が必要、個別鍵が契約上必要、p99 SLO が pool で達成不能                  |
| Account-per-tenant | 最上位 tier または強い委譲            | ADR-0003 の `tenant-<id>` アカウント + `CellStage`                                           | quota・費用・セキュリティ境界を契約上分離する必要があり[^93]、account factory が稼働している[^3] |

各サービスの `ServiceManifest.tenantIsolationModel` に採用モデルを必須記載する。

tenant context の規則:

```ts
interface ExecutionContext {
  tenantId: string;
  tenantTier: string;
  subjectId?: string;
  requestId: string;
  correlationId: string;
  traceId?: string;
  idempotencyKey?: string;
  cellId: string;
}
```

- `tenantId` は認証済み JWT claim または信頼できる authorizer context からのみ生成する。[^64][^12]
- repository adapter は `ExecutionContext.tenantId` を partition key prefix に強制し、呼び出し側が `pk` を自由指定できる API を公開しない。
- Lambda execution role には DynamoDB の `ForAllValues:StringEquals` + `dynamodb:LeadingKeys` 条件を付与し、`dynamodb:Scan` を許可アクションから除外する。[^89] pool では条件値に `TENANT#${aws:PrincipalTag/tenantId}` のような変数を使う設計を候補とするが、request ごとに tenant scope の一時クレデンシャルを STS で生成する方式（dynamic policy generation / token vending machine）は AWS の SaaS Tenant Isolation Strategies whitepaper に記載がある[^v1]が、遅延の数値は公式に示されていないため Phase 2 の PoC で計測してから採用を判断する（それまでは silo / bridge では tenant 固定値、pool では repository wrapper の条件式を一次防御とする）。
- tier 別 throttle は REST API の usage plan（HTTP API には usage plan / API key / per-client throttling がない[^61]）、または authorizer context を使った `PavedApiService` のレート制御で行い、worker 側は tier 別 SQS queue と event source の `maxConcurrency`（2〜1,000）で concurrency を分ける（`apps/example-worker-service`）。[^58] 単一 queue 内で noisy neighbor を検出する手段として SQS fair queues の `ApproximateNumberOfNoisyGroups` / `ApproximateNumberOfMessagesVisibleInQuietGroups` 等のメトリクスが公式に提供されている（確認日 2026-10-17）。[^77] tier 別 queue との使い分けは Phase 2 で比較する。

推奨段階は Phase 1（環境別アカウント、リージョン内 pool、tier 別スロットリング）、Phase 2（複数 cell へ tenant を固定配置）、Phase 3（規制・大口テナントのみ silo / account-per-tenant）とする。

## Alternatives

### A. 全サービス silo（テナントごとに全 stack を複製）

- 長所: 越境リスクが最小で、テナント別の費用・性能が完全に分離される。[^91]
- 短所: 配備数がテナント数 × サービス数になり、更新・観測・quota 管理の負担が中規模 PaaS では維持できない。原価も pool より大幅に高い。SaaS Lens は silo でも共有の identity / onboarding / 運用基盤が必要としている。[^91]

### B. 全サービス pool（昇格を許さない）

- 長所: 最も安価で運用が集約される。[^91]
- 短所: 規制対象テナントや noisy neighbor を受け入れられず、契約上の制約で失注する。SaaS Lens はサービス単位の判断を推奨している。[^91][^2]

### C. テナント ID をアプリケーションコードの条件式だけで分離（IAM 条件なし）

- 長所: 実装が簡単。
- 短所: コードのバグ 1 つで越境が起きる。IAM `LeadingKeys` 条件[^89]と repository wrapper の二重防御を必須とする。

## Consequences

- **費用**: pool 標準によりテナント当たり原価は最小。silo 昇格テナントは専用 stack の固定費を tenant 別 cost center へ配賦する（ADR-0018）。
- **性能**: IAM condition（`LeadingKeys`）の評価コストは公式ドキュメントに数値がない（確認日 2026-10-17）。計測で確定: 条件あり / なしの 2 構成で `tests/performance/order-api.k6.js` の steady シナリオを実行し p99 差分を記録する（docs/decision/template-defaults.md#計測で確定する項目 M-02。2026-10-17 の `tests/tenant-isolation` 3 件 pass は機能確認のみで、差分は未計測）。有意差があれば本 ADR を改訂する。hot partition は tenant skew の負荷試験で検出する。
- **運用**: 昇格時は tenant migration（データコピー、cell router 更新、reconciliation）が必要であり、runbook を `docs/runbooks/tenant-migration.md` に置く。
- **Lock-in**: DynamoDB の key 設計と IAM 条件に依存する。Aurora 採用サービスでは schema / row-level security を同等に設計する。
- **移行**: pool → silo の移行は expand / migrate / contract で行い[^83]、両方に書き込む期間の整合性を reconciliation で確認する。

## Evidence

- AWS SaaS Lens: silo / pool / bridge はサービス単位で選ぶ。tenant context は共通ライブラリに隠蔽する。[^91][^2][^12][^13]
- DynamoDB: `dynamodb:LeadingKeys` によるアイテム単位制御。`Scan` は除外が必要。[^89]
- ProGlove: account-per-tenant は account factory と集中展開があって初めて成り立つ。[^3][^7]
- 受入基準「tenant A の identity で tenant B のデータを取得・更新できない E2E test」を `tests/tenant-isolation/` で実施し、異なる tenant token、改ざん tenant ID、推測 ID、非同期 event 改ざんの 4 ケースを CI で毎回実行する。
- Phase 4 の game day で tenant migration と cell 障害時の blast radius を計測する。

## Compliance / How it is enforced

- `TenantAwareTable` が partition key を `pk` 固定、`tenantId` prefix 規則、暗号化、PITR[^90]、環境別 deletion policy を自動付与し、prefix なしの `PutItem` を repository adapter が拒否する。
- `@paas/runtime-context` の `resolveExecutionContext()` だけが `tenantId` を生成でき、HTTP body / query から `tenantId` を読む関数を eslint ルール `paas/no-client-tenant-id`（eslint ルールは未実装・予定。現状は `contextFromHttpApiEvent` の単体テストと `tests/tenant-isolation` で検証） で禁止する。
- `PlatformGuardrails` が Lambda execution role の DynamoDB アクセス権限に `LeadingKeys` 条件が含まれているか、および `dynamodb:Scan` が pool テーブルに対して許可されていないかを検査する。[^89]
- `ServiceManifest.tenantIsolationModel` を必須化し、silo / account-per-tenant を宣言したサービスには昇格条件を満たす ADR 参照を要求する。
- `tests/tenant-isolation/` の E2E test を CI の `integration` ステップで毎回実行する。

## 参考

[^2]: [SaaS Lens - AWS Well-Architected Framework](https://docs.aws.amazon.com/ja_jp/wellarchitected/latest/saas-lens/wellarchitected-saas-lens.pdf)（指針書 References より）

[^3]: [Lessons learned from scaling to 1 million Lambda functions](https://aws.amazon.com/blogs/architecture/lessons-learned-from-scaling-to-1-million-lambda-functions/)（指針書 References より）

[^7]: [6000 AWS accounts, three people, one platform](https://aws.amazon.com/blogs/architecture/6000-aws-accounts-three-people-one-platform-lessons-learned/)（指針書 References より）

[^12]: [Multi-tenant microservices - SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/multi-tenant-microservices.html)（指針書 References より）

[^13]: [Building Serverless SaaS Microservices with AWS Lambda Layers](https://aws.amazon.com/blogs/apn/building-serverless-saas-microservices-with-aws-lambda-layers/)（指針書 References より）

[^58]: [Configuring scaling behavior for SQS event source mappings](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html)（参照日 2026-10-17）

[^61]: [Choose between REST APIs and HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html)（参照日 2026-10-17）

[^64]: [Control access to HTTP APIs with AWS Lambda authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html)（参照日 2026-10-17）

[^77]: [Available CloudWatch metrics for Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html)（参照日 2026-10-17）

[^83]: [ParallelChange (expand / contract) - Danilo Sato, martinfowler.com](https://martinfowler.com/bliki/ParallelChange.html)（参照日 2026-10-17）

[^89]: [Using IAM policy conditions for fine-grained access control (DynamoDB)](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html)（参照日 2026-10-17）

[^90]: [Enable point-in-time recovery in DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/PointInTimeRecovery_Howitworks.html)（参照日 2026-10-17）

[^91]: [Silo, Pool, and Bridge Models - SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/silo-pool-and-bridge-models.html)（参照日 2026-10-17）

[^92]: [SEC01-BP01 Separate workloads using accounts](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/sec_securely_operate_multi_accounts.html)（参照日 2026-10-17）

[^93]: [Benefits of using multiple AWS accounts](https://docs.aws.amazon.com/whitepapers/latest/organizing-your-aws-environment/benefits-of-using-multiple-aws-accounts.html)（参照日 2026-10-17）

[^v1]: [Scaling and managing pool isolation policies - SaaS Tenant Isolation Strategies (AWS Whitepaper)](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/scaling-and-managing-pool-isolation-policies.html)（参照日 2026-10-17。whitepaper には「historical reference only」の注記がある。token vending machine が template に tenant 文脈を埋めて IAM policy を生成し、その policy で scope した token を返す流れを記載。遅延・費用の数値は記載なし）
