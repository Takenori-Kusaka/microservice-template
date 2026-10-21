# ADR-0022: Observability pipeline (OTel migration, central aggregation)

- Status: accepted
- Date: 2026-10-21
- Owner: platform-team
- Review date: 2027-04-21
- Related: ADR-0003（monitoring account）, ADR-0006, ADR-0013, ADR-0015（trace backend と集約先の節を本 ADR が置き換える。識別子・相関 ID の設計は ADR-0015 のまま有効）, ADR-0016, ADR-0018, ADR-0021, ADR-0026, [最新技術での再検討 §C](../decision/latest-tech-reassessment.md), [第21章 21.5](../microservice-guidelines-resilience-security.md)

## Context

ADR-0015 は「全リクエスト・イベントを `correlationId` / `tenantId` で横断検索できること」を目的に、Powertools（Logger / Tracer / Metrics）+ X-Ray + Application Signals を標準とし、OTel 化は別 ADR とした。2026-10-17 の再検討で次の事実が確認され、trace 経路と集約先を決め直す必要が生じた。

| 事実（参照日）                                                                                                                                                                                                                                                                                                                                                          | 影響                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| X-Ray SDK / Daemon は 2026-02-25 に maintenance mode、**2027-02-25 にサポート終了**。AWS は OpenTelemetry への移行を推奨（2026-10-21）[^137]                                                                                                                                                                                                                            | Powertools Tracer は X-Ray SDK の薄い wrapper（ADR-0015）で、2027-02 までに trace 経路を替える必要がある |
| Web Functions は Lambda segment を生成せず、Extensions / Telemetry API の記載がない。X-Ray へはアプリから ADOT 等で直接送る（2026-10-17）[^141]                                                                                                                                                                                                                         | Event / Web で trace 送信経路が異なる                                                                    |
| Web Functions のログは `console.*` を JSON で包み `requestId` / `endpointName` / `region` を付与、log group は `/aws/lambda/web/{fn}` と `.local` の 2 系統で両方に Logs 課金。EMF は `process.stdout.write` で出す（2026-10-17）[^140][^142]                                                                                                                           | ログのデータモデルを runtime profile 非依存に固定する必要がある                                          |
| CloudWatch OTLP endpoint: logs（`x-aws-log-group` / `x-aws-log-stream` ヘッダ必須）、metrics、traces（SigV4）。HTTP のみ、gRPC 非対応（2026-10-17）[^148]。X-Ray OTLP は 2024-11-22[^149]、HTTP log collector は 2026-03-16[^150]、OTel metrics は 2026-04-02 に preview[^151]                                                                                          | Lambda / Fargate から Collector なしで CloudWatch へ OTLP 送信できる                                     |
| CloudWatch Logs field index: log group あたり 20 フィールド、Standard class の取り込み料金に含まれる。Logs Insights は最大 10,000 log group を横断（2026-10-17）[^143]                                                                                                                                                                                                  | `correlationId` / `tenantId` の全件検索を index で高速化できる                                           |
| data protection policy は取り込み時に PII をマスクし、`logs:Unmask` 権限者のみ閲覧可。スキャン $0.12 / GB（2026-10-17）[^146][^98]                                                                                                                                                                                                                                      | `@paas/observability` の redaction の後段の保険                                                          |
| cross-account observability: monitoring account は最大 100,000 source account、logs / metrics / Application Signals は追加費用なし、trace は最初のコピー無料（2026-10-17）[^95]                                                                                                                                                                                         | monitoring account への集約に追加費用がない                                                              |
| CloudTrail Lake は **2026-05-31 以降、新規顧客に開放されない**。既存 event data store は継続、AWS は CloudWatch（pipelines、OCSF）への移行を推奨（2026-10-18）[^160][^161]                                                                                                                                                                                              | 監査証跡の分析基盤を CloudTrail Lake に置けない                                                          |
| Application Signals for Lambda は layer + `AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-instrument`。公式ドキュメントの対応ランタイムは Node.js 18 / 20 / 22 で **Node.js 24 は公式ドキュメントに記載なし**（確認日 2026-10-18、https://docs.aws.amazon.com/lambda/latest/dg/monitoring-application-signals.html ）。ADOT の Lambda layer は「Node.JS v18+」とのみ記載[^153][^154] | Node.js 24（ADR-0021）移行時に layer の動作確認が必要                                                    |
| OpenTelemetry JS は traces / metrics が Stable、logs は Development（2026-10-17）[^155]                                                                                                                                                                                                                                                                                 | logs の OTLP 化は時期尚早                                                                                |
| Powertools の OpenTelemetry 対応は RFC #4184（Tracer のみ）が open（2026-10-17）[^156]                                                                                                                                                                                                                                                                                  | Powertools 側の対応を待たずに adapter で切り替える                                                       |

一本化の単位は「転送先」ではなく「ログのデータモデル」である。転送先の選択肢は増えたが、構造化 JSON と必須フィールドを不変にし、転送先を差し替え可能にすることが本テンプレートの一本化の定義になる。

## Decision

準拠: AWS X-Ray Developer Guide「Document history」（SDK / Daemon サポート終了）[^137]、CloudWatch「OTLP Endpoints」[^148]、CloudWatch Logs field index[^143] / data protection[^146] / log classes[^145]、CloudWatch cross-account observability[^95]、Lambda JSON log format[^138]、Web Functions logging / monitoring / EMF[^140][^141][^142]、AWS SRA Log Archive account[^162]、CloudTrail Lake availability change[^161]

### 1. データモデル固定（2026-12 まで）

- 指針 §14 の必須フィールド（`timestamp`、`level`、`service`、`operation`、`requestId`、`correlationId`、`tenantId`、`cellId`、`deploymentVersion`、`message`）を `@paas/observability` の zod schema `LogRecordSchema` として公開し、Event / Web / Fargate の全 preset が同じ schema を出すことを contract test で保証する。
- Event Functions は Lambda の JSON log format を有効化し、Powertools Logger を使う。[^138][^139] Web preset は `console.*` の自動 JSON 包装を前提に[^140]、EMF は `process.stdout.write` で出す。[^142] Web Functions の `requestId` は Lambda 付与の値と衝突するため、アプリ側の API Gateway `requestId` と区別して `lambdaRequestId` に rename する（Transformer で統一）。[^144]
- `ObservableFunction` / `ServiceObservability` が全 log group に field index（`correlationId`、`tenantId`、`requestId`、`eventId`）と account-level data protection policy を自動設定する。[^143][^146]
- `tenantId` を CloudWatch Metrics dimension にしない原則（ADR-0015）は維持する。[^96] テナント別のログ量は Logs Insights の `messageSize(@message)` で月次集計し ADR-0018 に渡す（`estimate` はクエリ費用の事前見積り専用）。[^158][^159]
- Web Functions の `.local` log group は retention を短くする（既定値（例示値）: 3 日。home region と二重課金されるため[^140]、デバッグに必要な最小限として置いた設計判断。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-34））。

### 2. trace の OTel 化（2027-01 まで、X-Ray SDK 終了 2027-02-25 より前）[^137]

| profile             | 経路                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event Functions     | Application Signals layer（ADOT、`AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-instrument`）→ X-Ray OTLP[^153][^102]。`EnvironmentConfig.applicationSignalsLayerArn` で有効化（既存） |
| Web Functions       | `@opentelemetry/sdk-node` → CloudWatch OTLP traces endpoint（SigV4）[^148][^141]。flush は request 完了後に非同期で行う                                                    |
| Fargate（ADR-0009） | `@opentelemetry/sdk-node` → OTLP[^148]                                                                                                                                     |

- Powertools Tracer への依存は `@paas/observability/trace` の adapter に閉じ込め、サービス側コードは adapter の API のみを使う（ADR-0015 の wrapper 方針）。Powertools の OTel 対応[^156]が出たら adapter 内で差し替える。
- sampling は ADR-0015 の TD-16（既定 5%、error 100%）を OTel sampler で再現する。[^60] Transaction Search（100% span を `aws/spans` に取り込み、既定 1% を無料 index、取り込み $0.35 / GB）は staging で有効化し、production は計測で確定: span 量と費用を M-23 で実測して判断する。[^152][^98]
- Node.js 24 で Application Signals layer が動くことは公式に明示がないため[^153][^154]、ADR-0021 の移行 PR で staging の trace map に全ノードが現れることを確認してから production に適用する。

### 3. 中央集約（2027-03 まで）

- shared-services アカウントを monitoring account とし（ADR-0003）、cross-account observability で logs / metrics / traces / Application Signals を集約する。[^95] 第三者 backend（Datadog / Grafana 等）を使う場合は monitoring account の OTel Collector から OTLP で転送し、関数側は CloudWatch 固定のまま backend を変更できるようにする。Lambda Extension 型や in-layer collector 型は Event 専用で Web Functions に使えないため標準にしない。[^141][^164][^165]
- **監査証跡（forensic record）の正本は CloudTrail trail → S3（Log Archive account、Object Lock）→ Athena とする。** CloudTrail Lake は新規開放終了（2026-05-31）のため採用しない。[^160][^161] Log Archive は storage sink であり、分析は Athena と monitoring account で行う（SRA）。[^162] 詳細は ADR-0026。
- CloudWatch pipelines（CloudTrail → OCSF 変換）は AWS の推奨移行先であるが[^161]、本テンプレートでは Athena を正本に置き、pipelines は Review date で再評価する。

### 4. 見送り

- logs の OTLP 直接送信は見送る。OTel JS logs は Development で[^155]、Lambda からの直接送信は egress / flush 設計が必要で stdout → CloudWatch より利点がない。
- CloudWatch Logs Infrequent Access class は EMF / metric filter / field index が使えず作成後に class 変更不可のため[^145]、audit log（EMF 不要）の別 log group にのみ使う。

## Alternatives

### A. Powertools Tracer + X-Ray SDK を維持（ADR-0015 の現状）

- 長所: 変更なし。
- 短所: 2027-02-25 にサポート終了で、以後はセキュリティ修正も止まる。[^137] Web Functions に Lambda segment がなく経路が成立しない。[^141]

### B. 最初から第三者 backend（Datadog Extension / Honeycomb ADOT layer）へ関数から直接送信

- 長所: 1 つの UI で trace / log / metric を見られる。
- 短所: Extension / layer 型は Event Functions 専用で、Web Functions は Extensions API の記載がない。[^141][^164] ADOT 自身が in-layer collector を「legacy」とし、CloudWatch 以外へ送る場合以外は非推奨としている。[^102] backend 変更が全関数の再デプロイを伴う。monitoring account の Collector から転送する案（Decision 3）が runtime profile 非依存。

### C. テナント単位の log group に分離

- 長所: retention / アクセス権をテナント別に設定できる。
- 短所: log group は 1 アカウント 100 万まで作れるが[^147]、retention / data protection / subscription の設定数がテナント数に比例して増える。Lambda の tenant isolation 機能と SaaS Lens はフィールド（`tenantId`）での分離を示す。[^157][^12] premium tier の「ログ分離契約」がある場合のみ subscription filter → tenant 専用 S3 で分離する。

### D. CloudTrail Lake を監査証跡の正本にする

- 長所: SQL で直接クエリでき、保持 7 年オプションがある。[^160]
- 短所: 2026-05-31 以降は新規顧客に開放されず、既存 event data store も重要バグ修正とセキュリティ更新のみ。[^160][^161] 本テンプレートを新規アカウントへ展開できない。

## Consequences

- **費用**: field index は Standard class の取り込み料金に含まれ追加費用なし。[^143] data protection はスキャン $0.12 / GB、Transaction Search は取り込み $0.35 / GB + index $0.75 / 100 万 span、Application Signals は $1.50 / 100 万 signals（最初の 1 億）。[^98] cross-account 集約は logs / metrics / Application Signals が追加費用なし、trace は最初のコピー無料。[^95] Web Functions の `.local` 二重課金は短い retention で抑える。[^140] 計測で確定: ログ・メトリクス費用の総費用比（M-22）と trace 費用（M-23）を Cost Explorer で実測する（現在は未計測。参考: sandbox の固定費は alarm 57 本 ≈ $5.7 / 月のみ、E-103）。
- **性能**: Application Signals layer は Init を増やす。ADOT は全 instrumentation 有効化による cold start 増を注意している。[^102] 計測で確定: layer 付与前後の `Init Duration` p95 を M-10 の手順で比較する（現在の値は layer なしで p50 363 ms、E-178）。
- **運用**: platform-team が `@paas/observability` の 3 preset（event / web / fargate）と adapter を保守する。field index は log group あたり 20 フィールドの上限内で 4 つを使う。[^143] monitoring account の新設は ADR-0003 の改訂を伴う。
- **Lock-in**: OTel SDK と OTLP は標準。CloudWatch OTLP endpoint は HTTP のみで gRPC 非対応[^148]のため、Collector を挟む構成への移行時に exporter 設定の変更が要る。X-Ray 固有の trace header は Step Functions（ADR-0015 の `traceHeader`）に残るが、X-Ray は W3C Trace Context の trace ID を受け付ける。[^137]
- **移行**: フェーズ 1（データモデル、2026-12）→ 2（trace、2027-01）→ 3（集約、2027-03）の順。各フェーズは `@paas/observability` の内部変更で、サービス側コードの変更を伴わない（ADR-0015 の wrapper 方針）。

## Evidence

- X-Ray SDK / Daemon の maintenance mode（2026-02-25）とサポート終了（2027-02-25）。[^137]
- Web Functions の logging / monitoring / EMF 仕様。[^140][^141][^142]
- CloudWatch の OTLP endpoint と What's New（X-Ray OTLP 2024-11-22、HTTP log collector 2026-03-16、OTel metrics preview 2026-04-02）。[^148][^149][^150][^151]
- field index、Transformers、log classes、data protection、cross-account observability。[^143][^144][^145][^146][^95]
- CloudTrail Lake の新規開放終了と移行推奨。[^160][^161]
- 受入基準（ADR-0015 から継承）: `tests/integration/correlation-search/` で 100 件の `POST /orders` の `correlationId` について 7 経路すべてのログが見つかる（欠落 0%）。フェーズ 2 完了時は OTel 経路で sampling 100% の staging の trace map に全 7 ノードが現れる。
- 受入基準（新規）: `tests/contract` の log schema test で event / web preset の出力が `LogRecordSchema` に合致する。field index と data protection policy が `cdk synth` の template に存在することを `packages/constructs/test` で検証する。
- 計測で確定: ログ・メトリクス費用（M-22）、trace 費用（M-23）、layer overhead（M-10 の手順で再計測）。

## Compliance / How it is enforced

- `@paas/observability` が `LogRecordSchema` と `createLogger()` / `createTracer()` / `createMetrics()` を提供し、`console.log` の直接使用は eslint `no-console` で禁止（ADR-0015）。
- `ObservableFunction` が JSON log format、field index、data protection policy、retention、Application Signals layer（`applicationSignalsLayerArn` 設定時）を自動設定する。[^138][^143][^146][^153]
- `ServiceObservability` が metric dimension を `service` / `operation` / `tenantTier` / `cellId` / `deploymentVersion` に制限し、`tenantId` を dimension に含めた場合は synth で失敗させる（ADR-0015）。[^96]
- `PlatformGuardrails` が X-Ray SDK（`aws-xray-sdk-core`）を直接 import する bundle を 2027-01-31 以降 synth で警告し、2027-02-25 以降エラーにする（移行 PR で追加）。[^137]
- `tests/contract` に log schema test、`tests/integration` に correlation-search test を置き、CI の `contract` / `integration` ステップで毎回実行する。
- 月次 cost レビューで M-22 / M-23 を確認し、四半期 architecture review で Application Signals の Node.js 24 対応と Powertools RFC #4184 の状態を確認する。[^153][^156]

## Expiry / Review date

| 日付       | 評価者        | 結果                                                     |
| ---------- | ------------- | -------------------------------------------------------- |
| 2026-10-21 | platform-team | 初版。フェーズ 1〜3 の期限を設定、CloudTrail Lake 不採用 |

## 参考

[^12]: [Multi-tenant microservices - SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/multi-tenant-microservices.html)（指針書 References より）

[^60]: [Configuring sampling rules (AWS X-Ray)](https://docs.aws.amazon.com/xray/latest/devguide/xray-console-sampling.html)（参照日 2026-10-17）

[^95]: [CloudWatch cross-account observability](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Unified-Cross-Account.html)（参照日 2026-10-17。monitoring account 最大 100,000 source、logs / metrics / Application Signals は追加費用なし、trace は最初のコピー無料）

[^96]: [Specification: Embedded metric format (CloudWatch)](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html)（参照日 2026-10-17）

[^98]: [Amazon CloudWatch Pricing](https://aws.amazon.com/cloudwatch/pricing/)（参照日 2026-10-17。data protection $0.12 / GB、Transaction Search $0.35 / GB + $0.75 / 100 万 span、Application Signals $1.50 / 100 万 signals）

[^102]: [AWS Distro for OpenTelemetry Lambda](https://aws-otel.github.io/docs/getting-started/lambda)（参照日 2026-10-17。in-layer collector は legacy、全 instrumentation 有効化の cold start 注意）

[^137]: [Document History for AWS X-Ray](https://docs.aws.amazon.com/xray/latest/devguide/document-history.html)（参照日 2026-10-21。「On February 25th, 2026, the AWS X-Ray SDKs/Daemon will enter maintenance mode」「On February 25th, 2027, AWS X-Ray will discontinue support for AWS X-Ray SDKs and Daemon」「We recommend to migrate to OpenTelemetry」、W3C Trace Context 対応 2023-10-25）

[^138]: [Configuring JSON and plain text log formats (Lambda)](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs-logformat.html)（参照日 2026-10-17）

[^139]: [Configuring log level filtering (Lambda)](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs-log-level.html)（参照日 2026-10-17）

[^140]: [Web Function logs in Amazon CloudWatch Logs](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-logging.html)（参照日 2026-10-17。`console.*` の JSON 包装、`/aws/lambda/web/{fn}` と `.local` の二重課金）

[^141]: [Monitoring Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-monitoring.html)（参照日 2026-10-17。Lambda segment なし、Extensions / Telemetry API の記載なし、X-Ray へはアプリから直接送信）

[^142]: [Embedded metric format for Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-emf.html)（参照日 2026-10-17。`process.stdout.write`）

[^143]: [Amazon CloudWatch Logs launches field indexes and enhanced log group selection](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-cloudwatch-logs-field-indexes-log-group-selection-log-insights/)（参照日 2026-10-17。2024-11-21。log group あたり 20 フィールド、追加費用なし、10,000 log group 横断）

[^144]: [Transform logs during ingestion (CloudWatch Logs)](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CloudWatch-Logs-Transformation.html)（参照日 2026-10-17）

[^145]: [Log classes (CloudWatch Logs)](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CloudWatch_Logs_Log_Classes.html)（参照日 2026-10-17。Infrequent Access は EMF / metric filter / field index 不可、class 変更不可）

[^146]: [Help protect sensitive log data with masking (CloudWatch Logs)](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/mask-sensitive-log-data.html)（参照日 2026-10-17）

[^147]: [CloudWatch Logs quotas](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/cloudwatch_limits_cwl.html)（参照日 2026-10-17。log group 100 万 / account）

[^148]: [OTLP Endpoints (CloudWatch)](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html)（参照日 2026-10-17。logs / metrics / traces endpoint、HTTP のみ）

[^149]: [Application Signals now supports OpenTelemetry traces via X-Ray OTLP endpoint](https://aws.amazon.com/about-aws/whats-new/2024/11/application-signals-otel-x-ray-otlp-endpoint-traces)（参照日 2026-10-17。2024-11-22）

[^150]: [Amazon CloudWatch Logs launches HTTP log collector](https://aws.amazon.com/about-aws/whats-new/2026/03/cloudwatch-http-log-collector/)（参照日 2026-10-17。2026-03-16、OTLP logs 含む）

[^151]: [Amazon CloudWatch now supports native OpenTelemetry metrics (preview)](https://aws.amazon.com/about-aws/whats-new/2026/04/amazon-cloudwatch-opentelemetry-metrics/)（参照日 2026-10-17。2026-04-02）

[^152]: [Transaction Search (CloudWatch)](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Transaction-Search.html)（参照日 2026-10-17）

[^153]: [Monitor application performance with Amazon CloudWatch Application Signals (Lambda)](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-application-signals.html)（参照日 2026-10-17。Node.js 18 / 20 / 22、layer + `AWS_LAMBDA_EXEC_WRAPPER`。Node.js 24 の記載なし）

[^154]: [AWS Distro for OpenTelemetry Lambda Support For JavaScript](https://aws-otel.github.io/docs/getting-started/lambda/lambda-js)（参照日 2026-10-18。「The Lambda layer supports Node.JS v18+ Lambda runtimes」）

[^155]: [OpenTelemetry JavaScript status](https://opentelemetry.io/docs/languages/js/)（参照日 2026-10-17。Traces / Metrics Stable、Logs Development）

[^156]: [aws-powertools/powertools-lambda-typescript issue #4184 "Feature request: OpenTelemetry Support"](https://github.com/aws-powertools/powertools-lambda-typescript/issues/4184)（参照日 2026-10-17。open）

[^157]: [Monitoring tenant isolation (Lambda)](https://docs.aws.amazon.com/lambda/latest/dg/tenant-isolation-monitor.html)（参照日 2026-10-17。JSON logging で `tenantId` を自動付与）

[^158]: [CloudWatch Logs Insights language query syntax](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax.html)（参照日 2026-10-18。`estimate`）

[^159]: [Boolean, comparison, numeric, datetime, and other functions (Logs Insights)](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax-operations-functions.html)（参照日 2026-10-18。`messageSize` は byte 長）

[^160]: [Working with AWS CloudTrail Lake](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-lake.html)（参照日 2026-10-18。2026-05-31 以降は新規顧客に非開放）

[^161]: [CloudTrail Lake availability change](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-lake-service-availability-change.html)（参照日 2026-10-18。CloudWatch pipelines / OCSF への移行推奨）

[^162]: [Security OU – Log Archive account - AWS SRA](https://docs.aws.amazon.com/prescriptive-guidance/latest/security-reference-architecture/log-archive.html)（参照日 2026-10-18。Log Archive は storage sink）

[^164]: [Datadog Docs: AWS Lambda / Datadog Lambda Extension](https://docs.datadoghq.com/serverless/aws_lambda/)（参照日 2026-10-17。Extension 型、Web Functions の記載なし）

[^165]: [AWS Lambda, OpenTelemetry, and Grafana Cloud - Grafana Labs Blog](https://grafana.com/blog/aws-lambda-opentelemetry-and-grafana-cloud-a-guide-to-serverless-observability-considerations/)（参照日 2026-10-17。2025-04-16。ADOT → Alloy gateway → Grafana Cloud）
