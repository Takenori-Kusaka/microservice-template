# ADR-0016: SLO and performance budgets

- Status: accepted
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0005, ADR-0006, ADR-0008, ADR-0014, ADR-0017, ADR-0020

## Context

「一貫した性能」は「常にウォームにすること」ではなく、API ごとの p95/p99 SLO、同時実行予算、下流容量、負荷制御、コールドスタート対策を一体で設計することで得られる。設計原則「Evidence over defaults」は、メモリ、タイムアウト、同時実行数、Provisioned Concurrency を負荷試験結果で決めることを求める。

根拠となる外部文献（参照日 2026-10-17）:

- AWS DevOps Guidance O.SI.5 は、SLO の定義には平均値ではなく percentile を使うことを推奨している。[^35]
- CloudWatch Application Signals は、発見した全 service / operation について `Latency` と `Availability` を自動収集し、それらまたは任意の CloudWatch metric を SLI として period-based / request-based の SLO を作成できる。[^99][^33][^34]
- Google SRE Workbook は、99.9% SLO に対する multiwindow multi-burn-rate alert の出発点として、1 時間窓で burn rate 14.4（予算 2% 消費、page）、6 時間窓で 6（5%、page）、3 日窓で 1（10%、ticket）、短窓は長窓の 1/12 を示している。[^100] error budget は SLO と実測の差であり、残量が製品側のリリース速度を自律的に制御する。[^101]
- Lambda の必要同時実行数は `Concurrency = (average requests per second) × (average request duration in seconds)` で見積もれる。[^40] Provisioned Concurrency は version / alias にのみ設定でき（`$LATEST` 不可）、AWS は必要量に 10% のバッファを推奨し、割り当てはアカウント上限を消費する。[^74]
- Amazon は過負荷時の一貫した goodput のために load shedding と rate limiting を組み合わせている。[^38]
- API Gateway の `Latency` は受信から応答まで、`IntegrationLatency` はバックエンド往復の時間で、差分が API Gateway overhead である。[^65] アカウント・リージョン当たり throttle は既定 10,000 RPS / burst 5,000。[^62]
- Lambda の `Duration` は cold start（init）を含まず、percentile 統計を使える。[^75] Lambda Power Tuning は Step Functions で複数メモリ設定を実行し、cost / speed / balanced の 3 戦略で最適値を示す。[^103][^50]
- AWS Serverless Applications Lens は arm64 への変更を負荷試験で検証するよう推奨している。[^36][^37]

## Decision

準拠: AWS DevOps Guidance O.SI.5[^35]、CloudWatch Application Signals SLO[^99][^33][^34]、Google SRE Workbook「Alerting on SLOs」[^100]、Google SRE Book「Embracing Risk」[^101]、AWS Lambda Developer Guide（concurrency、provisioned concurrency）[^40][^74]、Amazon Builders' Library「Resilience lessons from the lunch rush」[^38]

### SLO-first

すべての同期 API に、`ServiceManifest.slo` として次を必須定義する。既定値（例示値）: 下記の値。SRE Workbook の SLO / error budget[^100][^101]の形式に従い、DynamoDB 往復 2 回 + cold start を含む API として到達可能な水準に置いた設計判断で、外部出典に基づかない（`apps/example-order-service/service.yaml` は p99 500 ms）。調整: `service.yaml` の `slo` → docs/decision/template-defaults.md#既定値レジスタ（TD-17）。計測で確定: サービスごとに `tests/performance/order-api.k6.js` の steady シナリオ結果をもとに所有チームが見直す（M-17。2026-10-17 sandbox 実測は steady 30 RPS で p99 91.5 ms、Evidence 節の「実測」小節）。

```yaml
slo:
  - operation: POST /orders
    availability: 99.9 # 成功率（5xx と timeout を失敗とみなす）
    latencyP50Ms: 120
    latencyP95Ms: 300
    latencyP99Ms: 600
    window: 30d
    exclusions: [planned-maintenance]
```

- 非同期 consumer は `ApproximateAgeOfOldestMessage`[^77] の p99（例: 60 秒）と処理成功率を SLO とする。
- workflow は execution 成功率と完了時間 p99 を SLO とする。
- error budget（1 − availability）[^101]の burn rate alarm を `ServiceObservability` が Application Signals SLO[^99]上に生成し、SRE Workbook の出発点[^100]に従い、1 時間窓（短窓 5 分）で 14.4 倍、6 時間窓（短窓 30 分）で 6 倍を超えたら on-call に page、3 日窓で 1 倍を超えたら ticket を起票する。

### 性能予算（p99 配賦）

入口 API の p99 目標を各段へ配賦し、`apps/<service>/docs/performance-budget.md` に記録する。`POST /orders` の例（既定値（例示値）: 配賦値は TD-17 の p99 600 ms を計測可能な段に按分した設計判断で、外部出典に基づかない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-18）。計測で確定: slo-baseline の段別 latency（`Latency` − `IntegrationLatency`、`Init Duration`、X-Ray subsegment）をもとに所有チームが見直す（M-17。段別の分離計測は未実施、2026-10-17 の合算値は Evidence 節の「実測」小節）。）:

| 段                                                      | 配賦 (ms)                               | 計測方法                                      |
| ------------------------------------------------------- | --------------------------------------- | --------------------------------------------- |
| CloudFront / WAF                                        | 20                                      | CloudFront `OriginLatency` との差分           |
| API Gateway + Lambda authorizer                         | 50                                      | `Latency` − `IntegrationLatency`[^65]         |
| Lambda init（cold start、Provisioned Concurrency なし） | 100（p99 のうち cold 比率を 2% 以下に） | `platform-initReport` の `Init Duration`[^74] |
| business logic + Idempotency lookup                     | 80                                      | Powertools Metrics の custom segment          |
| DynamoDB（条件付き書き込み 2 回）                       | 40                                      | X-Ray subsegment                              |
| downstream（なし）                                      | 0                                       |                                               |
| network / 余裕                                          | 310                                     | 残差                                          |
| **合計**                                                | **600**                                 |                                               |

同期依存先の SLO が上位 SLO を満たせない場合、cache、read model、非同期化を選ぶ。

### 一貫性能の手段

- latency-sensitive な少数 API だけ Provisioned Concurrency を検証する。採用は負荷試験で cold start が p99 を破る証拠がある場合のみ。設定は alias に対して行い、必要量 + 10% とする。[^74]
- reserved concurrency で重要機能を保護し、同時に下流 DB を守る上限として使う（ADR-0017）。[^40]
- API Gateway stage throttle / tenant tier で rate limit し、過負荷時は早く 429 / 503 を返す。[^63][^38]
- 非同期処理は SQS event source の `maxConcurrency`、batch size、visibility timeout を設定する。[^58][^57]
- memory は CPU・network にも影響するため、Lambda Power Tuning と実トラフィック相当データで決める。[^103][^50]
- arm64 を標準候補にし、native 依存がある場合だけ x86 へ戻す。[^36][^37]
- コールドスタートだけでなく warm p99、downstream saturation、goodput を測る。
- overload test で tipping point を超え、load shedding 後も goodput が維持されることを確認する。[^38]

必要同時実行数の基礎見積りは `Concurrency ≈ RequestsPerSecond × AverageDurationSeconds`[^40]とするが、容量試験では p95/p99 duration、burst、retry、tenant skew、downstream limit を含める。

## Alternatives

### A. 平均 latency と error rate のみを監視

- 長所: 設定が簡単。
- 短所: p99 の劣化（特定テナントや cold start）が平均に埋もれ、顧客影響を検出できない。AWS DevOps Guidance も percentile を推奨している。[^35]

### B. 全 Lambda に Provisioned Concurrency を設定して cold start をなくす

- 長所: cold start が消え、p99 が安定する。[^74]
- 短所: 費用が常時発生し、割り当てがアカウント同時実行上限を消費する。[^74] burst 時は結局 on-demand（`ProvisionedConcurrencySpilloverInvocations`[^75]）にあふれる。AWS 自身も非同期ワークロードには通常不要としている。[^74] 測定結果がある API だけに限定する。

### C. SLO をサービス全体で 1 つにする（operation 別にしない）

- 長所: 管理対象が少ない。
- 短所: 読み取りと書き込み、軽い API と重い API で妥当な目標が異なり、1 つの SLO では alarm が無意味になる。Application Signals は operation 単位で SLO を設定できる。[^99] operation 別を必須とする。

## Consequences

- **費用**: Provisioned Concurrency を証拠ベースに限定することで常時費用を抑える。負荷試験の staging 費用が発生する。
- **性能**: budget 配賦により、どの段が p99 を消費しているかが明確になり、Power Tuning と bundle 最小化の優先順位が決まる。
- **運用**: 週次で SLO / error budget をレビューし、error budget を使い切ったサービスは機能リリースより信頼性改善を優先する。[^101]
- **Lock-in**: Application Signals は AWS 固有だが、SLO 定義は `ServiceManifest` にあり backend 非依存。
- **移行**: SLO 値の変更は `ServiceManifest` の PR で行い、変更理由を ADR または PR に記録する。

## Evidence

- Application Signals による Lambda の SLO。[^33][^34][^99]
- AWS DevOps Guidance: percentile による SLO。[^35]
- SRE Workbook / SRE Book: burn rate alert と error budget。[^100][^101]
- Builders' Library: load shedding と rate limiting による goodput 維持。[^38]
- 受入基準「p99 latency、availability、queue age、throttles、concurrency、cost estimate を dashboard で確認できる」を `ServiceObservability` の snapshot test で検証する。
- `tests/performance/slo-baseline/` で各 example service に対し、定常 50 RPS 10 分、burst 200 RPS 2 分、overload 1,000 RPS 2 分の 3 シナリオを k6 で実行し、p50/p95/p99、`Throttles`[^75]、goodput を記録する。合格条件は定常と burst で SLO 達成、overload で 429 が返り始めた後も成功リクエストの p99 が SLO の 1.5 倍以内であること（負荷値・閾値は本テンプレートの初期値であり外部出典に基づかない。計測で確定: `tests/performance/order-api.k6.js` の結果を `tests/performance/results/` に保存し本 ADR に記録する。現行スクリプトは steady 50 RPS 5 分 + overload 50 → 400 RPS 5 分で、burst 200 RPS / overload 1,000 RPS シナリオは未実装。docs/decision/template-defaults.md#計測で確定する項目 M-17。初回実測は下記）。
- Power Tuning（`tools/power-tuning/`）の結果を `apps/<service>/docs/performance-budget.md` に添付し、memory 設定の根拠とする。[^103]

### 実測（2026-10-17/18 sandbox）

対象は ap-northeast-1 の `paas-sandbox-cell-01`（4 stacks）、アカウントの Lambda 同時実行 quota は **10**（新規アカウント既定）。この quota 下の値は production の性能値ではなく、「負荷制御が設計どおりに働くこと」の確認値として読む。結果ファイルと読み方は `tests/performance/results/README.md`。

| 項目                              | 値                                                                                                                                                          | 出典                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 負荷プロファイル                  | k6 2.3.0、steady 30 RPS × 3 分 → overload 30→150 RPS ramp 2 分 + 150 RPS hold 1 分、合計 25,200 req（2026-10-17T22:46:45Z〜22:52:46Z）                      | `tests/performance/results/order-api-2026-10-18.log`                   |
| steady の失敗率                   | 0.03%（2 / 5,401）                                                                                                                                          | `order-api-2026-10-18.summary.json` `http_req_failed{scenario:steady}` |
| client latency（`POST /orders`）  | p50 63.4 ms / p95 73.6 ms / **p99 91.5 ms** / max 343.6 ms。threshold `p(99)<500` pass（service.yaml の p99 500 ms、TD-17 の例 600 ms のいずれも達成）      | 同上 `create_order_latency`                                            |
| overload の throttle              | 28.5%（7,189 / 25,200）。stage throttle（sandbox: rate 100 / burst 200、TD-19）の 429 と Lambda quota 10 の 503。**成功リクエストの p99 は 91.5 ms のまま** | 同上 `throttled`                                                       |
| API Gateway（最悪 1 分）          | Latency p50 60 ms / p95 89 ms / p99 982 ms、4xx 3,973、5xx 3,223                                                                                            | `order-api-2026-10-18.cloudwatch.json`                                 |
| CreateOrder Lambda                | 18,019 invocations、errors 0、throttles 3,220、Duration p50 44 ms / p99 189 ms（1024 MB arm64）                                                             | 同上                                                                   |
| 非同期経路の Duration p99         | OutboxRelay 1,160 ms（3,018 inv）/ FulfillStandard 811 ms（1,045）/ FulfillPremium 1,450 ms（730）/ FulfillmentOutcomes 613 ms（1,551）、errors 0           | 同上                                                                   |
| end-to-end 整合性                 | 18,014 件すべて `FULFILLED`（CREATED 0 / FAILED 0）、OUTBOX 残 0、DLQ 8 本 0 件                                                                             | DynamoDB scan + `sqs get-queue-attributes`（run 直後）                 |
| Power Tuning（`ApiFnListOrders`） | `balanced` 推奨 **1536 MB**（avg 10.47 ms / 2.448e-7 USD per inv）。768 MB 13.80 ms、1024 MB 12.98 ms、2048 MB 11.72 ms、3008 MB 12.26 ms                   | `tools/power-tuning/results/*-1792277941831.json`                      |

読み方:

- 合格条件「定常で SLO 達成、overload で 429 が返り始めた後も成功リクエストの p99 が SLO の 1.5 倍以内」は、steady 30 RPS / overload 150 RPS の範囲で満たした（成功 p99 91.5 ms ≪ 750 ms）。Builders' Library の goodput 維持[^38]を実機で確認した。
- API Gateway 側の p99 982 ms は throttle された 429 / 503 を含む全リクエストの値で、client 側の成功リクエスト p99（91.5 ms）とは母集団が異なる。
- TD-18 の段別配賦（authorizer ≤ 50 ms、Lambda ≤ 80 ms、DynamoDB ≤ 40 ms）に対し、CreateOrder の Duration p50 44 ms / p99 189 ms は Lambda + Idempotency + DynamoDB の合算で p99 が配賦（80 + 40 = 120 ms）を超えている。cold start 混在（p99）のため、Provisioned Concurrency の要否は M-10 / M-11 で `Init Duration` を分離してから判断する。
- quota 10 では burst 200 RPS / overload 1,000 RPS のシナリオは全件 throttle になり意味を持たないため未実施。quota 増枠後（ADR-0017）に再計測する。

## Compliance / How it is enforced

- `ServiceManifest.slo` を必須化し、`availability` と `latencyP99Ms` が欠落した operation があれば synth で失敗させる。
- `ServiceObservability` が `ServiceManifest.slo` から Application Signals SLO[^99]、p99 latency alarm、availability alarm、burn rate alarm（14.4 / 6 / 1）[^100]、dashboard を自動生成する。
- `ObservableFunction` の `memorySize` は Power Tuning 結果ファイル（`apps/<service>/power-tuning/<function>.json`）の参照を要求し、未指定時は 1024 MB 既定で警告を出す。`provisionedConcurrentExecutions` の指定には負荷試験レポートへの参照（`evidence` プロパティ）を必須とし、alias にのみ適用する。[^74] `PlatformGuardrails` が参照なしを拒否する。
- `PavedApiService` が stage level throttle（既定値（例示値）: burst 500 / rate 200 RPS。アカウント既定の 10,000 RPS / burst 5,000[^63] の内側で 1 stage が quota を使い切らないようにする設計判断で、外部出典に基づかない。コードの現在値は `EnvironmentStage.apiThrottle` の sandbox rate 100 / burst 200、production rate 1,000 / burst 2,000。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-19、workload profile と overload 計測 M-17 で見直す）。）[^63]と tier 別 rate limit を設定し、無制限を許さない。
- CI の `load smoke` ステップで、ephemeral 環境に対する 1 分間の smoke（10 RPS）を実行し、p99 が SLO の 2 倍を超えたら promote を止める。
- 週次 SLO レビューの議事録を `docs/runbooks/slo-review.md` に追記することを運用ルールとする。

## 参考

[^33]: [Track performance of serverless applications built using AWS Lambda with Application Signals](https://aws.amazon.com/jp/blogs/aws/track-performance-of-serverless-applications-built-using-aws-lambda-with-application-signals/)（指針書 References より）

[^34]: [Monitoring Lambda with Application Signals](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-application-signals.md)（指針書 References より）

[^35]: [[O.SI.5] Set and monitor service level objectives against performance standards](https://docs.aws.amazon.com/wellarchitected/latest/devops-guidance/o.si.5-set-and-monitor-service-level-objectives-against-performance-standards.html)（指針書 References より）

[^36]: [Lambda cost and performance optimization (Serverless Applications Lens)](https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/cost-and-performance-optimization.md)（指針書 References より）

[^37]: [Lambda cost and performance optimization (日本語)](https://docs.aws.amazon.com/ja_jp/wellarchitected/latest/serverless-applications-lens/cost-and-performance-optimization.html)（指針書 References より）

[^38]: [Resilience lessons from the lunch rush](https://aws.amazon.com/it/builders-library/resilience-lessons-from-the-lunch-rush/)（指針書 References より）

[^40]: [Configuring reserved concurrency for an Event Function](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)（参照日 2026-10-17）

[^50]: [Understanding techniques to reduce AWS Lambda costs in serverless applications](https://aws.amazon.com/blogs/compute/understanding-techniques-to-reduce-aws-lambda-costs-in-serverless-applications/)（指針書 References より）

[^57]: [Creating and configuring an Amazon SQS event source mapping](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html)（参照日 2026-10-17）

[^58]: [Configuring scaling behavior for SQS event source mappings](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html)（参照日 2026-10-17）

[^62]: [Amazon API Gateway quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html)（参照日 2026-10-17）

[^63]: [Throttle requests to your REST APIs (API Gateway)](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html)（参照日 2026-10-17）

[^65]: [Amazon API Gateway dimensions and metrics](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-metrics-and-dimensions.html)（参照日 2026-10-17）

[^74]: [Configuring provisioned concurrency for an Event Function](https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html)（参照日 2026-10-17）

[^75]: [Types of metrics for Lambda Event Functions](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html)（参照日 2026-10-17）

[^77]: [Available CloudWatch metrics for Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html)（参照日 2026-10-17）

[^99]: [Service level objectives (SLOs) - CloudWatch Application Signals](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-ServiceLevelObjectives.html)（参照日 2026-10-17）

[^100]: [Alerting on SLOs - Google SRE Workbook](https://sre.google/workbook/alerting-on-slos/)（参照日 2026-10-17）

[^101]: [Embracing Risk - Google SRE Book](https://sre.google/sre-book/embracing-risk/)（参照日 2026-10-17）

[^103]: [AWS Lambda Power Tuning (GitHub)](https://github.com/alexcasalboni/aws-lambda-power-tuning)（参照日 2026-10-17）
