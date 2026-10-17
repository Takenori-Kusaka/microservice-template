# ADR-0018: Cost attribution

- Status: proposed
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0003, ADR-0004, ADR-0006, ADR-0009, ADR-0015, ADR-0016

## Context

B2B PaaS の収益性はテナント当たり原価で決まるが、サーバレスの請求は API Gateway request、Lambda request / duration / provisioned concurrency、Step Functions transition、EventBridge / SQS request、DynamoDB RCU / WCU / storage、CloudWatch log / trace といった細かい単価の合計であり、AWS の請求だけではテナント別・tier 別・サービス別の原価が分からない。

AWS の費用データと配賦手段（参照日 2026-10-17）:

- AWS Cost and Usage Report（CUR）は最も包括的な費用データで、時間 / 日 / 月、product、resource、ユーザー定義タグ別に line item を S3 へ配信し、Athena で照会できる。[^110]
- cost allocation tag はユーザー定義と AWS 生成の 2 種類があり、Billing console で **有効化** しなければ Cost Explorer にも CUR にも現れない。反映まで最大 24 時間かかる。[^111]
- アカウントは AWS 費用配賦の既定単位である。[^93]
- CloudWatch EMF で高 cardinality（`tenantId` 等）を dimension にすると組み合わせごとに custom metric が作られ、custom metric は最初の 10,000 が $0.30 / metric / 月で課金される。[^96][^98] SQS のドキュメントも、数千テナントの集計には高 cardinality metric ではなく Contributor Insights を推奨している。[^77]
- Lambda Event Functions は request $0.20 / 百万 + GB 秒（x86 $0.0000166667）、arm64 は duration 単価 20% 低い。Web Functions は request $0.30 / 百万 + active vCPU $0.0000276944 / vCPU 秒 + memory $0.0000036667 / GB 秒（US East、arm）。MicroVMs は稼働中の秒単位 compute + snapshot storage。[^51][^71][^23]
- API Gateway は HTTP API $1.00 / 百万、REST API $3.50 / 百万（US East 第 1 段階）。[^20]
- DynamoDB PITR はテーブルサイズで課金され、recovery period の長さでは変わらない。[^90]

pool モデル（ADR-0004）では複数テナントが同一リソースを共有するため、請求タグだけでは配賦できず、tenant activity を driver とした配賦が必要となる。ランタイムプロファイルごとに課金 driver が異なる。[^51]

本 ADR は配賦モデルを定めるが、配賦精度の検証（PoC）が未了のため `proposed` とする。

## Decision

準拠: AWS Cost and Usage Report[^110]、AWS cost allocation tags[^111]、AWS whitepaper「Organizing Your AWS Environment Using Multiple Accounts」（費用管理）[^93]、CloudWatch EMF 仕様と料金[^96][^98]、AWS Lambda / API Gateway 料金表[^51][^20]、AWS Serverless Applications Lens（cost and performance optimization）[^36]、Lambda Power Tuning[^103][^50]

### 管理単位

| 単位                 | 定義                                    | driver                                                                                               |
| -------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| request 当たり       | 同期 API 1 リクエストの原価             | API Gateway request[^20] + Lambda GB 秒[^51] + DynamoDB RCU/WCU + log                                |
| workflow 当たり      | Step Functions 1 execution の原価       | transition 数（Standard）または duration × memory（Express）[^55] + Task Lambda GB 秒 + 下流呼び出し |
| job 当たり           | 非同期 consumer の 1 メッセージ処理原価 | SQS request + Lambda GB 秒 + DynamoDB                                                                |
| tenant / tier 当たり | 上記を tenant / tier に集計したもの     | 下記配賦ルール                                                                                       |
| service 当たり       | Service Stack 単位の直接費              | cost allocation tag `ServiceId`[^111]                                                                |

### 配賦ルール

1. **直接費**: Service Stack の全リソースに `ServiceId`、`Environment`、`CellId`、`CostCenter` タグを付与し、Billing console で cost allocation tag として有効化し[^111]、CUR[^110]で service 別に集計する。silo テナント（ADR-0004）は `TenantId` タグも付与し、直接配賦する。
2. **pool の共有費**: サービス別の直接費を、そのサービスの tenant activity metric で按分する。driver は次のとおり。

| サービス種別                  | driver                                                  | 計測元                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同期 API（Event Functions）   | tenant 別 request 数 × operation 別平均 `Duration`[^75] | Powertools Metrics の `TenantRequests`（`tenantTier` dimension、`tenantId` は EMF property）[^96] + Logs Insights の tenant 別集計                                                                                     |
| worker                        | tenant 別処理メッセージ数 × 平均 duration               | `PavedQueueConsumer` の `TenantMessagesProcessed`                                                                                                                                                                      |
| workflow                      | tenant 別 execution 数 × 平均 transition 数             | `PavedWorkflow` の `TenantExecutions`                                                                                                                                                                                  |
| DynamoDB                      | tenant 別 item count と RCU/WCU（`pk` prefix 集計）     | 日次の `tools/cost-model/` job                                                                                                                                                                                         |
| Web Functions（experimental） | tenant 別 request 数 × active vCPU 秒                   | Web Functions の CPU metric（Lambda が publish する metric は request 結果と resource usage のみで tenant 次元を持たず[^v1]、revision dimension もない[^67]ため、tenant 別 CPU はアプリ側の EMF custom metric で取る） |

3. **プラットフォーム共有費**（shared-services、observability 集約、control plane）: 全テナントの request 数比で按分する。
4. 配賦結果は日次で `tools/cost-model/` が CUR と CloudWatch から算出し、`TenantCost` テーブル（control plane）に保存する。
5. tenant 別の高 cardinality データは CloudWatch Metrics dimension に入れず（ADR-0015）[^96]、Logs Insights / Contributor Insights[^77]と CUR で扱う。

### 最適化順序

1. 不要な処理・ログ・トレース・データ転送をなくす。[^36]
2. API Gateway から AWS サービスへの direct integration を検討する。
3. Lambda duration と memory を Power Tuning で実測する。[^103][^50]
4. arm64 対応を検証する（duration 単価 20% 減）。[^71][^36]
5. batch size と event filtering を最適化する。[^50]
6. Provisioned Concurrency は SLO 達成に必要な alias・時間帯だけに限定する。[^74]
7. Step Functions Standard / Express を実行特性で比較する。[^55]
8. 安定した高稼働ワークロードは ECS/Fargate 等との break-even を再評価する（ADR-0009）。

## Alternatives

### A. 請求タグのみで service 別に集計し、tenant 別配賦を行わない

- 長所: 実装が CDK のタグ付けと cost allocation tag の有効化[^111]だけで済む。
- 短所: pool モデルではテナント当たり原価が分からず、pricing と tier 設計の根拠が得られない。

### B. tenant ごとに全リソースを分離（silo）して請求タグで直接集計

- 長所: 配賦が不要で精度が最高。
- 短所: ADR-0004 の pool 標準と矛盾し、原価自体が上がる。silo テナントにのみ適用する。

### C. CloudWatch Metrics に `tenantId` dimension を付与して集計

- 長所: リアルタイムに tenant 別メトリクスが見える。
- 短所: テナント数 × operation 数の custom metric 課金（$0.30 / metric / 月）[^98]が発生し、EMF 仕様も高 cardinality dimension を警告している。[^96] Logs Insights / Contributor Insights と CUR による日次集計を採用する。[^77]

## Consequences

- **費用**: 日次集計 job と Logs Insights クエリの費用が発生する。CUR の S3 保存と Athena クエリも加わる。[^110]
- **性能**: Powertools Metrics の tenant 別 count は EMF でログに出力するため、Lambda の p99 への影響は無視できる（EMF は同期 API 呼出なしにログ経由で metric を出す方式で、Lambda の best practices でも遅延低減のために推奨されている[^v2]）。
- **運用**: platform-team が `tools/cost-model/` と配賦ルールを所有し、月次 cost レビューで tier 別原価と pricing を比較する。
- **Lock-in**: CUR と Cost Explorer は AWS 固有。配賦ロジックは TypeScript で書き、入力を CSV 化すれば他クラウドへも適用できる。
- **移行**: Web Functions や Fargate を採用したサービスは driver を切り替える必要があり、ランタイムプロファイルごとの driver 定義を `tools/cost-model/` に持たせる。[^51]

## Evidence

PoC protocol（Phase 3、`tools/cost-model/` と `tests/performance/cost-attribution/`）。合格閾値は本テンプレートの初期値。計測で確定: 初回 PoC の配賦精度（pool ±10%、silo ±2%、集計 job 費用 < 1%）を本 ADR に記録し、閾値を見直す（docs/decision/template-defaults.md#計測で確定する項目 M-19、現在は未計測・試験ディレクトリ未作成）。

1. staging で tenant 10 件（premium 2、standard 8）を作り、tenant 別に既知の比率（例: 40 / 20 / 5 × 8）で `POST /orders` と worker メッセージを 24 時間流す。
2. 日次集計 job で tenant 別配賦額を算出し、既知の投入比率と比較する。
3. silo テナントを 1 件追加し、直接配賦額が CUR の `TenantId` タグ集計[^110][^111]と一致することを確認する。
4. 合格条件: pool テナントの配賦比率が投入比率に対して ±10% 以内、silo テナントの直接費が請求タグ集計と ±2% 以内、集計 job の月額が総 AWS 費用の 1% 未満。
5. request 当たり、workflow 当たり、job 当たりの原価を算出し、`docs/architecture/cost-model.md` に記録する。
6. Lambda Web Functions を採用した API がある場合は、active vCPU 秒ベースの driver[^51]でも同じ精度を確認する。

合格後に本 ADR を `accepted` に変更し、受入基準「cost estimate を dashboard で確認できる」を満たす。

## Compliance / How it is enforced

- `PlatformGuardrails` が全 stack に `ServiceId`、`Environment`, `CellId`, `CostCenter` タグを付与し、`ServiceManifest.costCenter` 欠落で synth を失敗させる。silo テナントの stack には `TenantId` タグを必須化する。
- `apps/platform-cdk` の bootstrap 手順に cost allocation tag の有効化[^111]を含め、CI の `policy` ステップで有効化状態を検査する。
- `@paas/observability` の Metrics preset が `TenantRequests` / `TenantMessagesProcessed` / `TenantExecutions` を `tenantTier` dimension で EMF 出力し、`tenantId` は EMF の property（dimension ではない）として出力する。[^96]
- `ServiceObservability` の dashboard に service 別の日次推定費用（Cost Explorer API）を表示する。
- `tools/cost-model/` の日次 job を shared-services アカウントの EventBridge Scheduler で実行し、失敗時は platform-team に alarm する。
- 月次 cost / capacity レビューで tier 別原価と pricing の差を記録する。

## 参考

[^20]: [Amazon API Gateway Pricing](https://aws.amazon.com/api-gateway/pricing/)（参照日 2026-10-17）

[^23]: [AWS Lambda MicroVMs](https://aws.amazon.com/lambda/lambda-microvms/)（参照日 2026-10-17）

[^36]: [Lambda cost and performance optimization (Serverless Applications Lens)](https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/cost-and-performance-optimization.md)（指針書 References より）

[^50]: [Understanding techniques to reduce AWS Lambda costs in serverless applications](https://aws.amazon.com/blogs/compute/understanding-techniques-to-reduce-aws-lambda-costs-in-serverless-applications/)（指針書 References より）

[^51]: [AWS Lambda Pricing](https://aws.amazon.com/lambda/pricing/)（参照日 2026-10-17）

[^55]: [Choosing workflow type in Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html)（参照日 2026-10-17）

[^67]: [Deployment patterns (Lambda Web Functions)](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-deployment.html)（参照日 2026-10-17）

[^71]: [AWS Lambda Functions Powered by AWS Graviton2 Processor](https://aws.amazon.com/blogs/aws/aws-lambda-functions-powered-by-aws-graviton2-processor-run-your-functions-on-arm-and-get-up-to-34-better-price-performance/)（参照日 2026-10-17）

[^74]: [Configuring provisioned concurrency for an Event Function](https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html)（参照日 2026-10-17）

[^75]: [Types of metrics for Lambda Event Functions](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html)（参照日 2026-10-17）

[^77]: [Available CloudWatch metrics for Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html)（参照日 2026-10-17）

[^90]: [Enable point-in-time recovery in DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/PointInTimeRecovery_Howitworks.html)（参照日 2026-10-17）

[^93]: [Benefits of using multiple AWS accounts](https://docs.aws.amazon.com/whitepapers/latest/organizing-your-aws-environment/benefits-of-using-multiple-aws-accounts.html)（参照日 2026-10-17）

[^96]: [Specification: Embedded metric format (CloudWatch)](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html)（参照日 2026-10-17）

[^98]: [Amazon CloudWatch Pricing](https://aws.amazon.com/cloudwatch/pricing/)（参照日 2026-10-17）

[^103]: [AWS Lambda Power Tuning (GitHub)](https://github.com/alexcasalboni/aws-lambda-power-tuning)（参照日 2026-10-17）

[^110]: [What are AWS Cost and Usage Reports?](https://docs.aws.amazon.com/cur/latest/userguide/what-is-cur.html)（参照日 2026-10-17）

[^111]: [Organizing and tracking costs using AWS cost allocation tags](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/cost-alloc-tags.html)（参照日 2026-10-17）

[^v1]: [Publishing custom metrics with the embedded metric format - Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-emf.html)（参照日 2026-10-17。「The metrics that Lambda publishes describe only request outcomes and resource usage.」「No added request latency」）

[^v2]: [Best practices for working with AWS Lambda Event Functions](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html)（参照日 2026-10-17。「Emit custom metrics asynchronously using Embedded Metric Format (EMF). ... This approach reduces latency and improves performance.」）
