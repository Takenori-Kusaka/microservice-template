# ADR-0015: Trace and correlation

- Status: accepted
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0005, ADR-0013, ADR-0014, ADR-0016, ADR-0019

## Context

1 つの業務リクエストは API Gateway → Lambda → DynamoDB → DynamoDB Streams → EventBridge → SQS → Lambda → Step Functions と複数の非同期境界をまたぐ。障害調査、テナント問い合わせ、監査のために、この経路を端から端まで追える必要がある。Netflix はエンドツーエンドトレースをバックエンド移行の判断に利用している。[^10]

X-Ray の制約（参照日 2026-10-17）は次のとおり。

- 既定のサンプリングは毎秒 1 リクエスト（reservoir）+ それ以降の 5%。サンプリング判断は parent-based で、上流が決めた判断を下流は引き継ぐ。[^60]
- SQS から Lambda への trace は自動リンクでき[^44][^46]、EventBridge は PutEvents 時に trace context が渡された場合だけ target へ伝播する。[^43] archive replay では元 trace header が保持されない。[^43][^78]
- Step Functions を SDK から開始するときは `traceHeader`（`Root={TRACE_ID};Sampled={1 or 0}`）を明示伝播する必要がある。[^49]
- HTTP API は API Gateway 側の X-Ray tracing を持たない（REST API のみ）。[^61] Lambda の active tracing で Lambda 以降の segment を取る。[^47]

CloudWatch EMF（Embedded Metric Format）は、ログ中の `Dimensions` に列挙した key だけを metric の次元にし、それ以外の root member はログに残るが metric にはならない。DimensionSet は最大 30 key で、高 cardinality（`requestId` など）を dimension にすると組み合わせごとに custom metric が作られ課金される。[^96] custom metric は最初の 10,000 metric が $0.30 / metric / 月である。[^98] CloudWatch Logs の retention は既定で無期限であり、log group ごとに設定する。[^97]

したがって、サンプリングされる分散トレースだけに依存せず、全リクエスト・イベントに業務相関 ID を持たせ、ログ、メトリクス、監査証跡と結合する。

## Decision

準拠: AWS X-Ray Developer Guide（sampling、SQS / EventBridge / Lambda 連携）[^60][^44][^46][^45][^47]、Amazon EventBridge User Guide（X-Ray、archive / replay）[^43][^78]、Step Functions X-Ray tracing[^49]、Powertools for AWS Lambda[^48][^26]、CloudWatch EMF 仕様[^96]、CloudWatch cross-account observability[^95]、Netflix の実践[^10]

### 識別子

| 識別子                                                            | 意味                                          | 生成場所                                                              | 伝播先                                                                                    |
| ----------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `requestId`                                                       | 各入口リクエスト固有                          | API Gateway（`requestContext.requestId`）[^64]                        | ログ、レスポンス header、problem details の `instance`[^85]                               |
| `traceId`                                                         | 分散トレースの技術的経路                      | X-Ray（`X-Amzn-Trace-Id` header）[^45]                                | X-Ray、ログの `xray_trace_id`                                                             |
| `correlationId`                                                   | 同期・非同期・再実行をまたぐ 1 つの業務フロー | 入口 API で `X-Correlation-Id` header を検証、なければ ULID 生成[^81] | envelope（ADR-0013）、SQS message attribute、Step Functions input、ログ、trace annotation |
| `eventId`                                                         | イベント重複排除                              | `@paas/event-contracts` の `createEvent()`                            | envelope `id`、consumer の idempotency key（ADR-0014）                                    |
| `causationId`                                                     | 当該イベントを起こした command / event        | producer                                                              | envelope                                                                                  |
| `idempotencyKey`                                                  | 同一副作用の重複防止                          | クライアント                                                          | `ExecutionContext`、ログ                                                                  |
| `tenantId`, `cellId`, `service`, `operation`, `deploymentVersion` | 絞り込み次元                                  | `ExecutionContext`、`ServiceManifest`、Lambda alias version           | ログ、trace annotation、（低 cardinality のみ）metric dimension[^96]                      |

### 標準実装

- Powertools for AWS Lambda TypeScript の Logger、Tracer、Metrics、Idempotency、Batch Processing を `@paas/observability` の共通 preset で使用する。[^48][^26]
- JSON 構造化ログのみ許可し、PII masking と field allowlist を共通 logger で実装する。
- API 入口（`PavedApiService` middleware）で `correlationId` を生成または検証する。外部入力の `X-Amzn-Trace-Id` や `X-Correlation-Id` は形式検証（ULID / UUID）を通過したものだけ受け入れ、無条件に信頼しない。
- `correlationId`、`eventId`、`causationId` をイベント payload の正式メタデータ（ADR-0013）として保存し、トレースとは独立に CloudWatch Logs Insights で検索可能にする。replay では trace が切れるため[^43][^78]、これが唯一の全件経路情報となる。
- Step Functions を Lambda / SDK から開始するときは `traceHeader` を明示的に渡し[^49]、`correlationId` を execution input の `meta` に含める。
- sampled trace（X-Ray）、全件 access log（API Gateway）[^61]、業務 audit log（重要操作、別 log group、別アクセス権）を別目的として扱う。
- dashboard は `service`、`operation`、`tenantTier`、`cellId`、`deploymentVersion` で絞り込めるようにする。高 cardinality の `tenantId` を CloudWatch Metrics の dimension に入れず[^96]、EMF の非 dimension property としてログに残し、Logs Insights または Contributor Insights で集計する。[^77]
- tracing backend は X-Ray + CloudWatch Application Signals を標準とし、OTel backend への標準化は別 ADR で判断する。ADOT の Lambda layer は既定で AWS SDK と HTTP の instrumentation だけを有効にして cold start を抑え、trace は Lambda 組込み agent 経由で X-Ray へ送る構成を「最高性能」としている。[^102] `@paas/observability` の API は Powertools Tracer を直接露出せず、OTel への切替を可能にする薄い wrapper を提供する。
- 環境別 log retention を設定する（既定値（例示値）: sandbox 7 日、production 90 日、audit log は 1 年以上。sandbox は PR 単位の使い捨て、production は四半期の障害分析に足る長さ、audit は一般的な監査要件の下限として置いた設計判断で、外部出典に基づかない。コードの現在値は `EnvironmentStage.logRetention` の sandbox `ONE_WEEK` / production `THREE_MONTHS`。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-15、監査要件の確定とログ費用の実測 M-22 で見直す）。）既定の無期限保持[^97]を使わない。
- shared-services アカウントを monitoring account とし、cross-account observability で metrics / logs / traces / Application Signals を集約する。[^95]

## Alternatives

### A. X-Ray トレースだけに依存（相関 ID なし）

- 長所: 実装が Powertools Tracer だけで済む。[^48]
- 短所: サンプリング（既定 1 req/s + 5%）[^60]で全件を追えず、archive replay や redrive で trace が切れる。[^43][^78] テナント問い合わせや監査では全件検索が必須なため不採用。

### B. 最初から OpenTelemetry（ADOT）+ 外部 APM に標準化

- 長所: ベンダー中立で、trace / metrics / logs の統一モデルを得られる。
- 短所: ADOT 自身が全 instrumentation 有効化による cold start 増を注意しており[^102]、Application Signals の SLO 機能[^99]を活用できない。初期は X-Ray + Application Signals を使い、wrapper で切替可能性を保つ。

### C. 相関 ID をログだけに出し、イベント payload には含めない

- 長所: envelope が小さい。
- 短所: consumer 側で相関 ID を復元できず、非同期境界で検索が途切れる。envelope のメタデータとして保存する（ADR-0013）。

## Consequences

- **費用**: 全件 access log と構造化ログの保存量が増える。環境別 retention で制御する。[^97] X-Ray は sampling rule で制御する。既定ルールは reservoir 1 req/秒 + 5%[^v1]で、本テンプレートは production で 5% を維持し error は 100% とする rule を初期値とする（既定値（例示値）: error 100% は障害分析に必要な trace を落とさないための設計判断。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-16）。計測で確定: 比率ごとの trace 費用は Cost Explorer で実測する（M-23、現在は未計測）。）[^60] EMF の dimension を低 cardinality に限定して custom metric 課金を抑える。[^96][^98]
- **性能**: Powertools Tracer は X-Ray SDK for Node.js の薄いラッパーで[^v2]、SDK は UDP 2000 で待ち受ける X-Ray daemon（Lambda が自動実行）に segment を渡し、daemon が X-Ray API へ中継する[^v3]。p99 への影響は slo-baseline 試験で計測する。
- **運用**: `correlationId` を入口のレスポンス header `X-Correlation-Id` に返し、サポート問い合わせ時にクライアントから提示してもらう。
- **Lock-in**: X-Ray と Application Signals は AWS 固有だが、相関 ID と構造化ログは backend 非依存。
- **移行**: OTel 化は `@paas/observability` の wrapper 内部を差し替えることで、サービス側コードを変えずに行う。

## Evidence

- X-Ray の context propagation と制約（EventBridge、SQS、Lambda、Step Functions、sampling）。[^43][^44][^45][^46][^47][^49][^60]
- Powertools の Logger / Tracer / Metrics。[^48][^26]
- Netflix: エンドツーエンドトレースを実運用の移行判断に利用。[^10]
- 受入基準「API → Lambda → DynamoDB → EventBridge → SQS → Lambda → Step Functions を `correlationId` で全件検索できる」を `tests/integration/correlation-search/` で検証する。100 件の `POST /orders` を送り、各 `correlationId` について Logs Insights で 7 つの経路すべてのログが見つかることを確認する（欠落率 0%）。
- 受入基準「X-Ray sampled trace でも同期・非同期経路を確認できる」を同テストで、sampling rate 100% の rule[^60]を設定した staging で trace map に全 7 ノードが現れることで確認する。
- 受入基準「tenant isolation」の非同期 event 改ざんテストで、`tenantId` を書き換えたイベントが consumer で拒否されログに記録されることを確認する。

## Compliance / How it is enforced

- `@paas/observability` の `createLogger()` / `createTracer()` / `createMetrics()` が `ExecutionContext` の全識別子を自動付与し、`console.log` の直接使用は eslint ルール `no-console`（@paas/eslint-config で有効） で禁止する。
- `PavedApiService` middleware が `correlationId` の生成・検証とレスポンス header 付与を行い、handler 側で省略できない。
- `ObservableFunction` が `tracing: Tracing.ACTIVE`[^47]、Powertools 環境変数（`POWERTOOLS_SERVICE_NAME`、`POWERTOOLS_METRICS_NAMESPACE`、`POWERTOOLS_LOGGER_LOG_EVENT=false`）、環境別 log retention[^97]を自動設定する。
- `@paas/event-contracts` の `createEvent()` が `correlationId` / `causationId` を必須にし、`PavedQueueConsumer` preset が envelope から `ExecutionContext` を復元して logger に注入する。
- `PavedWorkflow` が `StartExecution` 呼び出しの wrapper で `traceHeader`[^49]と `meta.correlationId` を必須化する。
- `ServiceObservability` が metric dimension を `service`、`operation`、`tenantTier`、`cellId`、`deploymentVersion` に制限し、`tenantId` を dimension に含めた場合は synth で失敗させる。[^96]
- CI の `integration` ステップで correlation-search テストを毎回実行する。

## 参考

[^10]: [Seamlessly Swapping the API backend of the Netflix Android app](https://netflixtechblog.com/seamlessly-swapping-the-api-backend-of-the-netflix-android-app-3d4317155187)（指針書 References より）

[^26]: [Powertools for AWS Lambda (TypeScript)](https://docs.aws.amazon.com/powertools/typescript/latest/)（指針書 References より）

[^43]: [Amazon EventBridge integration with AWS X-Ray](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-related-service-xray.html)（指針書 References より）

[^44]: [Amazon SQS and AWS X-Ray](https://docs.aws.amazon.com/xray/latest/devguide/xray-services-sqs.html)（指針書 References より）

[^45]: [AWS X-Ray concepts](https://docs.aws.amazon.com/xray/latest/devguide/xray-concepts.html)（指針書 References より）

[^46]: [AWS X-Ray Integrated Services](https://docs.aws.amazon.com/xray/latest/devguide/xray-services.html)（指針書 References より）

[^47]: [Visualize Lambda function invocations using AWS X-Ray](https://docs.aws.amazon.com/lambda/latest/dg/services-xray.html)（指針書 References より）

[^48]: [Powertools for AWS Lambda](https://aws.amazon.com/powertools-for-aws-lambda/)（指針書 References より）

[^49]: [Trace Step Functions request data in AWS X-Ray](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-xray-tracing.html)（指針書 References より）

[^60]: [Configuring sampling rules (AWS X-Ray)](https://docs.aws.amazon.com/xray/latest/devguide/xray-console-sampling.html)（参照日 2026-10-17）

[^61]: [Choose between REST APIs and HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html)（参照日 2026-10-17）

[^64]: [Control access to HTTP APIs with AWS Lambda authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html)（参照日 2026-10-17）

[^77]: [Available CloudWatch metrics for Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html)（参照日 2026-10-17。高 cardinality tenant 集計に Contributor Insights を推奨）

[^78]: [Archiving and replaying events in Amazon EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-archive.html)（参照日 2026-10-17）

[^81]: [ULID Specification (GitHub)](https://github.com/ulid/spec)（参照日 2026-10-17）

[^85]: [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html)（参照日 2026-10-17）

[^95]: [CloudWatch cross-account observability](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Unified-Cross-Account.html)（参照日 2026-10-17）

[^96]: [Specification: Embedded metric format (CloudWatch)](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html)（参照日 2026-10-17）

[^97]: [Working with log groups and log streams (CloudWatch Logs)](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/Working-with-log-groups-and-streams.html)（参照日 2026-10-17）

[^98]: [Amazon CloudWatch Pricing](https://aws.amazon.com/cloudwatch/pricing/)（参照日 2026-10-17。custom metric 最初の 10,000 は $0.30 / metric / 月、US East）

[^99]: [Service level objectives (SLOs) - CloudWatch Application Signals](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-ServiceLevelObjectives.html)（参照日 2026-10-17）

[^102]: [AWS Distro for OpenTelemetry Lambda](https://aws-otel.github.io/docs/getting-started/lambda)（参照日 2026-10-17）

[^v1]: [Configuring sampling rules - AWS X-Ray](https://docs.aws.amazon.com/xray/latest/devguide/xray-console-sampling.html)（参照日 2026-10-17。「By default, the SDK records the first request each second, and five percent of any additional requests.」）

[^v2]: [Tracer - Powertools for AWS Lambda (TypeScript)](https://docs.aws.amazon.com/powertools/typescript/latest/features/tracer/)（参照日 2026-10-17。「Tracer is an opinionated thin wrapper for AWS X-Ray SDK for Node.js.」）

[^v3]: [AWS X-Ray daemon](https://docs.aws.amazon.com/xray/latest/devguide/xray-daemon.html)（参照日 2026-10-17。「listens for traffic on UDP port 2000, gathers raw segment data, and relays it to the AWS X-Ray API」「Lambda runs the daemon automatically any time a function is invoked for a sampled request.」）
