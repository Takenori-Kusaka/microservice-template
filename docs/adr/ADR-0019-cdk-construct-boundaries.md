# ADR-0019: CDK construct boundaries

- Status: accepted
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0001, ADR-0002, ADR-0003, ADR-0012, ADR-0015, ADR-0020

## Context

設計原則「Paved road」は、セキュリティ、テナント文脈、ログ、トレース、アラームを共通 Construct / ライブラリで自動付与することを求める。AWS SaaS Lens もテナント文脈を共通ライブラリへ隠蔽し、開発者が日常コードで意識する量を減らす方針を示している。[^12][^13] Spotify は golden path をテンプレートで強制することで文書による統制より高い効果を得ている。[^9] AWS Operational Excellence Pillar は所有者の特定を求めており[^11]、本テンプレートでは所有メタデータを Construct で必須化する。

AWS CDK は、L2 Construct が公開しないプロパティに到達するための escape hatch（`node.defaultChild` で L1 を取得、`addPropertyOverride` / `addOverride` で CloudFormation プロパティを上書き）を提供する。[^105] cdk-nag は CDK アプリまたは CloudFormation テンプレートをルールパック（AWS Solutions、HIPAA Security、NIST 800-53 rev 4 / rev 5、PCI DSS 3.2.1、Serverless）で検査する。[^104]

一方で、L3 Construct が業務要件を隠す過剰抽象化になると、サービスチームが必要な設定を変えられず、Construct の fork や手書き L1 への逸脱が増える。L3 の責務境界と escape hatch を明確に定める必要がある。

対象は `@paas/constructs`（aws-cdk-lib 2.273、cdk-nag 2.38）の `ObservableFunction`、`TenantAwareTable`、`IdempotencyTable`、`PavedApiService`、`PavedQueueConsumer`、`PavedWorkflow`、`EventSubscription`、`ServiceObservability`、`ServiceManifest`（`service-manifest`）、`PlatformGuardrails`、`ServiceStack` である。

## Decision

準拠: AWS SaaS Lens（共通ライブラリによる横断関心の隠蔽）[^12][^13]、Spotify Backstage（golden path）[^9]、AWS CDK Developer Guide（escape hatches）[^105]、cdk-nag[^104]、AWS Operational Excellence Pillar[^11]

### Construct 階層

| 階層              | 責務                                                                            | 所有者         | 例                                                 |
| ----------------- | ------------------------------------------------------------------------------- | -------------- | -------------------------------------------------- |
| L1 / L2           | AWS resource 表現                                                               | AWS CDK        | `aws_lambda.Function`, `aws_dynamodb.TableV2`      |
| Platform L3       | paved road の自動付与と guardrail                                               | platform-team  | `@paas/constructs` の各 Construct                  |
| Service Stack     | 1 マイクロサービスの API、functions、workflow、queues、datastore、alarms を所有 | サービスチーム | `apps/example-order-service/cdk/OrderServiceStack` |
| Cell Stage        | 複数 Service Stack を特定 cell へ配置                                           | platform-team  | `apps/platform-cdk` の `CellStage`                 |
| Environment Stage | account / region、shared control plane、cells、observability を構成             | platform-team  | `apps/platform-cdk` の `EnvironmentStage`          |

### L3 が自動付与するもの（サービス側で無効化不可）

| Construct              | 自動付与                                                                                                                                                                                                                                                                               | 根拠 ADR                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `ObservableFunction`   | Node.js 22、arm64、esbuild bundle[^72]、X-Ray active tracing[^47]、Powertools 環境変数、log retention（環境別）[^97]、standard tags、IAM permissions boundary、`deploymentVersion` 環境変数、bundle size 検査                                                                          | ADR-0008, 0015                   |
| `TenantAwareTable`     | `pk` / `sk` 規則、KMS 暗号化、PITR 35 日[^90]、production での RETAIN + deletion protection、standard tags、Streams（outbox 用、任意）                                                                                                                                                 | ADR-0004, 0012                   |
| `IdempotencyTable`     | Powertools Idempotency 用テーブル（`id` partition key、`expiration` TTL）[^84]                                                                                                                                                                                                         | ADR-0014                         |
| `PavedApiService`      | API Gateway（HTTP 既定）[^61]、Lambda authorizer（payload 2.0）[^64]、`correlationId` / tenant context middleware、Idempotency middleware（書き込み）、access log、stage throttle、tier 別 rate limit、SLO alarm、deployment alias + CodeDeploy weighted routing[^106]、dashboard link | ADR-0005, 0014, 0015, 0016, 0020 |
| `PavedQueueConsumer`   | SQS + DLQ（`maxReceiveCount` 5）[^57]、partial batch response preset[^59]、`maxConcurrency`[^58]、visibility timeout 算出[^57]、age alarm[^77]、redrive runbook link、envelope parse + tenant context 復元                                                                             | ADR-0011, 0014                   |
| `PavedWorkflow`        | Step Functions logging / tracing[^49]、Task timeout、retry preset、execution alarm、`traceHeader` 伝播 wrapper                                                                                                                                                                         | ADR-0010                         |
| `EventSubscription`    | EventBridge rule（`type` + `tenantId` filter 必須）→ 自 Stack 内 SQS、rule target DLQ[^56]                                                                                                                                                                                             | ADR-0011, 0013                   |
| `ServiceObservability` | Application Signals SLO[^99]、X-Ray group、dashboard、burn rate alarm[^100]、dimension 制限[^96]                                                                                                                                                                                       | ADR-0015, 0016                   |
| `ServiceManifest`      | 必須所有メタデータの検証と `catalog-info.yaml` 出力[^9]                                                                                                                                                                                                                                | ADR-0001                         |
| `PlatformGuardrails`   | Aspect として cdk-nag（AwsSolutions + Serverless ルールパック）[^104]、IAM wildcard、public exposure、未暗号化、missing alarm、cross-stack resource 参照、escape hatch 期限、ADR 参照の検査                                                                                            | 全 ADR                           |

### 責務境界のルール

- L3 は **横断関心** だけを扱う。[^12] 業務ロジック、データモデルの意味、API のルート定義は Service Stack と application 層に置く。
- L3 のプロパティは「安全側の既定値 + 明示的な上書き」とし、上書きできる範囲を型で表現する。セキュリティ・観測性に関わる既定値は上書き不可。
- Service Stack 間の直接 resource reference を禁止する。SSM parameter と CloudFormation export の乱用も避け、契約は endpoint / event schema と service discovery 情報（control plane の registry）で連携する。
- stateful resource は termination protection、retain / snapshot policy を環境別に設定する。[^90]
- bootstrap、pipeline、observability、control plane、data plane を別 stack に分離する。

### Escape hatch

- 各 L3 Construct は内部の L2 resource を `readonly` プロパティ（例: `ObservableFunction.function`, `TenantAwareTable.table`）として公開し、CDK 標準の escape hatch（`node.defaultChild`、`addPropertyOverride`）[^105]による L1 変更を可能にする。
- escape hatch を使う場合は `applyPlatformGuardrails({ suppressions: [{ id, reason, expires }] })` と `suppressNag()`（期限超過は synth 失敗） を呼んで理由・ADR 参照・期限を宣言し、`PlatformGuardrails` が期限超過を synth 失敗にする。宣言のない L1 変更は `PlatformGuardrails` が検出して失敗させる。
- L3 で表現できない要件が 2 サービス以上で繰り返されたら、escape hatch ではなく L3 の拡張を platform-team に起票する（既定値（例示値）: 2 サービス。1 件は例外、2 件目で共通要件と判断する最小値として置いた設計判断で、外部出典に基づかない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-23、`PlatformGuardrails` の suppressions 起票実績を四半期で確認）。）

## Alternatives

### A. L2 のみを使い、共通設定はドキュメントとレビューで統制

- 長所: 抽象化が薄く、サービスチームの自由度が最大。
- 短所: 暗号化、ログ、トレース、アラームの漏れがレビュー依存になり、サービス数に比例して逸脱が増える。Spotify の知見のとおり、文書だけの統制は効果が低い。[^9]

### B. 単一の巨大 `PavedService` Construct に API / worker / workflow をすべて包含

- 長所: 1 つの Construct で全サービスを生成できる。
- 短所: プロパティが肥大化し、サービス種別ごとの差分を表現しにくい。部分的な利用（API だけ）ができず、過剰抽象化になる。役割別 L3 に分割する。

### C. CDK ではなく Terraform module / CloudFormation template で paved road を提供

- 長所: 言語非依存。
- 短所: TypeScript monorepo で型による制約（上書き不可プロパティ、必須 ADR 参照）を表現できず、Aspect による synth 時検査（cdk-nag を含む）[^104]も使えない。CDK を採用する。

## Consequences

- **費用**: L3 が自動付与する alarm、log、trace、PITR により、サービスごとの固定費がわずかに増える。sandbox では retention と alarm を軽量化する。[^97]
- **性能**: 影響なし。
- **運用**: platform-team が `@paas/constructs` の変更に全サービスの synth を伴う責任を負う（ADR-0002）。escape hatch の期限管理が四半期レビューの対象になる。
- **Lock-in**: aws-cdk-lib 2.x に依存する。major upgrade は platform-team が一括で行う。
- **移行**: Construct の breaking change は deprecation 期間（2 リリース）を設け、`PlatformGuardrails` が deprecated プロパティの使用を警告する。

## Evidence

- SaaS Lens: tenant context を共通ライブラリへ隠蔽する方針。[^12][^13]
- Spotify: golden path をテンプレートで強制する効果。[^9]
- CDK escape hatch と cdk-nag ルールパックの存在。[^105][^104]
- 受入基準「cdk-nag / policy test が public exposure、wildcard IAM、暗号化漏れを拒否する」を `packages/constructs/test/guardrails.test.ts` で検証する。意図的に違反した stack を synth し、`PlatformGuardrails` が失敗することを vitest で確認する。
- 受入基準「`cdk destroy` 時に stateful production resource を誤削除しない」を `TenantAwareTable` の snapshot test で検証する。
- 四半期レビューで escape hatch の件数と期限超過件数を報告し、2 件以上の同種 escape hatch があれば L3 拡張を起票する。

## Compliance / How it is enforced

- `@paas/constructs` の各 Construct は、セキュリティ・観測性に関わるプロパティを型から除外し、上書き不可にする。
- `PlatformGuardrails` Aspect を `EnvironmentStage` が全 stack に自動適用し、サービス側で除外できない。検査項目は cdk-nag AwsSolutions / Serverless ルールパック[^104]、IAM wildcard（`Resource: '*'` と `Action: '*'`）、public exposure（Function URL、public S3、0.0.0.0/0 ingress）、未暗号化ストレージ、missing alarm、cross-stack resource 参照、escape hatch 宣言と期限、ADR 参照。
- `packages/constructs/test/` の snapshot test と guardrails test を CI の `unit` ステップで実行する。
- `ServiceManifest` が `catalog-info.yaml` を synth 時に生成し、手書きとの差分を CI の `policy` ステップで検出する。
- `pnpm create-service` が L3 を使った Service Stack の雛形を生成し、L2 の直接使用は eslint ルール `paas/prefer-paved-constructs`（未実装・予定。現状は create-service の雛形と code review で担保） で警告する。

## 参考

[^9]: [What the Heck is Backstage Anyway? | Spotify Engineering](https://engineering.atspotify.com/2020/3/what-the-heck-is-backstage-anyway)（指針書 References より）

[^11]: [Operational Excellence Pillar - AWS Well-Architected Framework](https://docs.aws.amazon.com/pdfs/wellarchitected/latest/operational-excellence-pillar/wellarchitected-operational-excellence-pillar.pdf)（指針書 References より）

[^12]: [Multi-tenant microservices - SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/multi-tenant-microservices.html)（指針書 References より）

[^13]: [Building Serverless SaaS Microservices with AWS Lambda Layers](https://aws.amazon.com/blogs/apn/building-serverless-saas-microservices-with-aws-lambda-layers/)（指針書 References より）

[^47]: [Visualize Lambda function invocations using AWS X-Ray](https://docs.aws.amazon.com/lambda/latest/dg/services-xray.html)（指針書 References より）

[^49]: [Trace Step Functions request data in AWS X-Ray](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-xray-tracing.html)（指針書 References より）

[^56]: [How EventBridge retries delivering events](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-retry-policy.html)（参照日 2026-10-17）

[^57]: [Creating and configuring an Amazon SQS event source mapping](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html)（参照日 2026-10-17）

[^58]: [Configuring scaling behavior for SQS event source mappings](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html)（参照日 2026-10-17）

[^59]: [Handling errors for an SQS event source in Lambda](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html)（参照日 2026-10-17）

[^61]: [Choose between REST APIs and HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html)（参照日 2026-10-17）

[^64]: [Control access to HTTP APIs with AWS Lambda authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html)（参照日 2026-10-17）

[^72]: [aws-cdk-lib.aws_lambda_nodejs module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda_nodejs-readme.html)（参照日 2026-10-17）

[^77]: [Available CloudWatch metrics for Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html)（参照日 2026-10-17）

[^84]: [Idempotency - Powertools for AWS Lambda (TypeScript)](https://docs.aws.amazon.com/powertools/typescript/latest/features/idempotency/)（参照日 2026-10-17）

[^90]: [Enable point-in-time recovery in DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/PointInTimeRecovery_Howitworks.html)（参照日 2026-10-17）

[^96]: [Specification: Embedded metric format (CloudWatch)](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html)（参照日 2026-10-17）

[^97]: [Working with log groups and log streams (CloudWatch Logs)](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/Working-with-log-groups-and-streams.html)（参照日 2026-10-17）

[^99]: [Service level objectives (SLOs) - CloudWatch Application Signals](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-ServiceLevelObjectives.html)（参照日 2026-10-17）

[^100]: [Alerting on SLOs - Google SRE Workbook](https://sre.google/workbook/alerting-on-slos/)（参照日 2026-10-17）

[^104]: [cdk-nag (GitHub, cdklabs)](https://github.com/cdklabs/cdk-nag)（参照日 2026-10-17）

[^105]: [Escape hatches - AWS CDK Developer Guide](https://docs.aws.amazon.com/cdk/v2/guide/cfn-layer.html)（参照日 2026-10-17。本文確認済み: `construct.node.defaultChild` で L2 内の L1 を取得し、`addOverride` / `addPropertyOverride` / `addDeletionOverride` で raw override できる。URL は `cfn_layer.html` から `cfn-layer.html` に変更）

[^106]: [aws-cdk-lib.aws_codedeploy.LambdaDeploymentConfig](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_codedeploy.LambdaDeploymentConfig.html)（参照日 2026-10-17）
