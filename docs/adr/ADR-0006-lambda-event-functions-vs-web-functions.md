# ADR-0006: Lambda Event Functions vs Web Functions

- Status: proposed
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0005, ADR-0007, ADR-0008, ADR-0009, ADR-0016, ADR-0018, ADR-0020

## Context

AWS Lambda は 2026-10-12 に Lambda Web Functions を発表した。[^22] AWS の定義では、Lambda は 3 つの compute primitive を提供する。[^21]

- **Event Functions**: 従来の Lambda 関数。1 実行環境が同時に 1 リクエストを処理し、request 数 + GB 秒で課金。
- **Web Functions**: Node.js の HTTP サーバをポートで待ち受ける形でそのまま実行し、Express / Hono / React Router をアダプタなしで使える。1 実行環境が複数リクエストを同時処理し、ゼロまでスケールし、リージョン間レプリケーションが可能。課金は request 数 + active CPU 時間（1 ms 単位）+ 実行環境の存続期間中の memory。
- **MicroVMs**: ADR-0007 の対象。

Web Functions の制約（参照日 2026-10-17）は次のとおり。[^42][^22][^66][^67]

| 項目                  | 値                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| ランタイム            | Node.js のみ[^21][^22]                                                                                                                               |
| 提供リージョン        | US East (N. Virginia)、US East (Ohio)、US West (Oregon)、Asia Pacific (Tokyo)、Europe (Ireland)[^22]                                                 |
| 実行環境              | 2 vCPU / 2 GB 固定、`/tmp` 512 MB[^42]                                                                                                               |
| 同時リクエスト / 環境 | `maxConcurrencyPerEnvironment` 既定 64（1〜128）[^42][^66]                                                                                           |
| request timeout       | 既定 30 秒（3〜900 秒）[^42][^66]                                                                                                                    |
| deployment package    | 512 MB（unzipped）、S3 versioned bucket 経由[^42][^66]                                                                                               |
| endpoint rate limit   | 任意設定、未設定時は endpoint 当たり 10,000 RPS[^42]                                                                                                 |
| progressive delivery  | endpoint の `revisionWeights`（最大 2 revision、重み 1〜100）、`autoDeploymentMode` Disabled で canary / blue-green / rollback[^67]                  |
| metrics               | revision dimension がないため、canary のエラーを revision 別に分離できない。アプリ側でログ / custom metric に revision 識別子を含める必要がある[^67] |
| 料金（US East、arm）  | $0.30 / 百万 request + active vCPU $0.0000276944 / vCPU 秒 + memory $0.0000036667 / GB 秒[^51]                                                       |

Event Functions は request $0.20 / 百万 + duration $0.0000166667 / GB 秒（x86）で、arm64 は duration 単価が 20% 低い。[^51][^71] 課金モデルが異なるため、I/O 待ちが長いだけで Web Functions が安いとは限らず、CPU active ratio を計測する必要がある。

既存の paved road（Powertools Idempotency、Batch Processing、CodeDeploy alias weighted routing、API Gateway 連携）は Event Functions を前提としている。

## Decision

準拠: AWS Lambda Developer Guide「What is AWS Lambda?」（3 primitive の比較表）[^21]、Lambda quotas[^42]、Lambda 料金表[^51]、Lambda Web Functions の What's New[^22]、Web Functions の deployment patterns[^67]

- **API Gateway + Lambda Event Functions を同期 API と非同期処理の標準とする。**
- **Lambda Web Functions は `runtimeProfile: 'experimental-web'` として扱い、Evidence 節の benchmark protocol に合格した API だけに採用を認める。**
- `apps/example-order-service` の同一業務ロジック（application / domain 層）を Hono で包んだ Web Functions 版を `apps/example-order-service/src/entrypoints/web/` に用意し、比較専用の stack として sandbox / staging にのみデプロイする。production への Web Functions デプロイは本 ADR が `accepted` になるまで禁止する。
- Web Functions 版でも `@paas/runtime-context` の `ExecutionContext` 解決、`@paas/observability` の構造化ログ、`@paas/api-contracts` の生成型を Hono middleware として同一に適用し、比較対象を「実行モデルの差」だけに限定する。
- 非同期 consumer（SQS、EventBridge）と Step Functions Task には Web Functions を使わない。これらは event source mapping を前提とする Event Functions のモデルであり[^21]、`PavedQueueConsumer` / `PavedWorkflow` は Event Functions のみを受け付ける。
- 採用条件は「Event Functions より良い SLO または TCO」かつ「ランタイム・リージョン・観測性（revision dimension なし[^67]）の制約を受容できる」ことであり、両方を満たす API ごとに個別 ADR を起票する。
- 提供リージョンが 5 つに限られるため[^22]、本 PaaS の標準リージョンが対象外の場合は benchmark 自体を延期する。

## Alternatives

### A. Lambda Event Functions（標準）

- 長所: 1 リクエスト 1 invocation で障害隔離と IAM 境界が細かい。[^21] Powertools（Logger / Tracer / Metrics / Idempotency）[^26]、alias weighted routing[^107]、reserved concurrency[^40]が成熟している。esbuild zip + arm64 でデプロイが速い。response streaming は Function URL / `InvokeWithResponseStream` / API Gateway REST proxy で利用できる。[^69]
- 短所: I/O 待ちが長い API で duration 課金が無駄になる。[^51] Node.js framework 互換がない。

### B. Lambda Web Functions（experimental）

- 長所: Hono / Express をそのまま動かせ、1 環境で最大 128 同時リクエストを処理するため I/O bound API では費用と cold start 回数が下がる可能性がある。[^21][^66] revision weight による progressive delivery と多リージョン routing。[^67][^22]
- 短所: Node.js のみ、5 リージョンのみ。[^22] 1 環境で複数リクエストを処理するため memory pressure と failure isolation が Event Functions より弱い。metrics に revision dimension がない。[^67] Powertools は「AWS Lambda only」を tenet とし、Web framework / 非 Lambda 環境は非公式サポートと明記しており、Web Functions 向けの案内は Idempotency / Batch を含め公式ドキュメントにない（確認日 2026-10-17）。[^v1]課金モデルが異なり、CPU active ratio を測らないと安いかどうか分からない。[^51]

### C. ECS/Fargate 上の Node.js HTTP サーバ

- 長所: framework 互換とストリーミングは Web Functions と同等で、常時高負荷では単価が最も低い（計測で確定: 稼働率ごとの費用は `pnpm cost-model` に Fargate 単価を追加した break-even 試算で比較する。docs/decision/template-defaults.md#計測で確定する項目 M-07、現在は未計測・Fargate 単価未登録）。
- 短所: ゼロスケールできず、中規模トラフィックの多くの API では固定費が不利。ADR-0009 の対象。

## Consequences

- **費用**: Event Functions 標準により既存の cost model（request + GB 秒）が維持される。[^51] Web Functions 採用 API は request + active vCPU + memory の別モデルで cost attribution を行う必要がある（ADR-0018）。
- **性能**: Event Functions は cold start を Provisioned Concurrency[^74]と esbuild bundle 最小化で管理する。Web Functions は 2 vCPU / 2 GB 固定[^42]のため memory による CPU 調整ができず、CPU bound API では `maxConcurrencyPerEnvironment` を下げる必要がある。[^66]
- **運用**: 2 つのランタイムプロファイルを `ObservableFunction` が扱う必要があり、platform-team が `experimental-web` 用の observability preset（revision 識別子のログ付与）を保守する。[^67]
- **Lock-in**: Web Functions は Lambda 固有の deploy 形態だが、アプリケーションは標準 HTTP サーバのため ECS/Fargate への移植性は高い。
- **移行**: benchmark 合格後は API 単位で切り替え、API Gateway のルート単位で Event / Web を混在させる。

## Evidence

benchmark protocol（`tests/performance/event-vs-web.k6.js`、`TARGET=event|web` で同一 workload を両 compute に送る）。同一業務ロジック、同一 DynamoDB テーブル（`OrderWebExperimentalStack` は `OrderServiceStack` の table を参照）で実施する。負荷値と合格閾値は本テンプレートの初期値。計測で確定: 初回 benchmark の結果（cold / warm p99、throttle 率、request 当たり費用、CPU active ratio）を本 ADR に記録し、閾値を見直す（docs/decision/template-defaults.md#計測で確定する項目 M-06、2026-10-21 に縮小プロファイルで初回実測、下記「実測」）。

ハーネス作成時に一次情報で確認した Web Functions の制約（2026-10-21）:

- `IamAuth` endpoint は SigV4（service 名 `lambda`、endpoint の Region）で署名し、body の有無にかかわらず `X-Amz-Content-SHA256` header が必須。Lambda は署名検証後に `Authorization` header を**削除してから**アプリへ転送するため、アプリ層の bearer token 認証は CloudFront OAC 経由でしか成立しない。[^267] benchmark では sandbox claims を署名対象の `x-paas-sandbox-claims` header で運ぶ（`server.ts`）。
- Web Functions の request metrics（`ExecutedRequests`、`HTTPResponseStatusClass4XX/5XX`）は home Region に集約され、環境 metrics は `EnvironmentActiveTime` / `EnvironmentCPUTime`（ms、Sum）、`EnvironmentMaxMemoryUsage`、`EnvironmentConcurrentRequests`。throttle は `AWS/Lambda/Web/Usage` 名前空間に Region 別・原因別（account RPS / endpoint rateLimit / account arm64 vCPU / endpoint maxEnvironments）で出るが、`EndpointConcurrentInitThrottle` の 429 はどの throttle metric にも計上されない。metrics に revision dimension はない。[^268] `collect-web-metrics.mjs` はこの表に従って収集し、CPU active ratio = `EnvironmentCPUTime / EnvironmentActiveTime` を算出する。
- Web Functions のコードは S3 の .zip のみで、bucket は **versioning 必須**、bucket policy で `lambda.amazonaws.com` に `s3:GetObject` / `s3:GetObjectVersion` を `aws:SourceArn` = `web-function/<name>/revision/*` 条件付きで許可する必要がある。Lambda は revision 作成時にこのアクセスを検査し、revision は object version に pin される。object version か bucket policy を後から失うと revision は永続的な `Failed` になり、endpoint は 409 `Platform.RevisionNotActive` を返す。Lambda は server が listen を始めたかを検証しないため、deploy 後の test request が必須。[^269] 実デプロイ（2026-10-21）では CDK bootstrap の assets bucket をそのまま参照して `CreateWebFunctionRevision` が `ValidationException`（service principal に GetObject 権限なし）で失敗したため、`ExperimentalWebFunction` は専用の versioned bucket を持ち、`BucketDeployment`（`extract: false`、`prune: false`）で zip を複製する。bootstrap bucket の policy は CDKToolkit の所有物であり、template からは変更しない。 続く初回 request は 502 `Runtime.ImportCodeError`（`/var/task/index.js` が無い）で失敗した。runtime は既定で `index.js` を読み、ES module の `index.mjs` は `AWS_LAMBDA_NODEJS_ENTRYPOINT` で指定する必要がある（同 [^269]）。`lambda-web-error-type` response header と `.local` log group の `platform.initReport` で原因を特定できた。

| 項目                                 | 計測方法                                                              | 合格条件（Web Functions 採用）                              |
| ------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| cold / warm p50, p95, p99            | k6 で 50 RPS 10 分 + 0 → 200 RPS ramp 2 分、各 3 回                   | warm p99 が Event 版以下、cold p99 が Event 版の 1.2 倍以内 |
| burst 時 scale-out と throttle       | 0 → 500 RPS step、Event 版は `Throttles`[^75]、Web 版は 429 を記録    | throttle 率が Event 版以下                                  |
| request 当たり費用                   | 料金表[^51]と計測値から月間 1,000 万 request へ換算                   | Event 版比 20% 以上の削減                                   |
| CPU active ratio                     | Web 版の active vCPU 秒 / 環境存続秒、Event 版の `Duration`[^75]      | I/O bound API で active ratio < 40% なら Web が有利と判定   |
| deployment artifact size / time      | zip サイズと deploy 所要時間                                          | Event 版の 1.5 倍以内                                       |
| trace / log 一貫性                   | `correlationId` で全 request を検索、revision 識別子のログ付与率      | 欠落 0%                                                     |
| failure isolation と memory pressure | 1 リクエストで OOM / 例外を注入し、同環境の他リクエストへの影響を計測 | 他リクエストのエラー率増加が 1% 未満                        |

### 実測（2026-10-21、sandbox ap-northeast-1、縮小プロファイル）

詳細と出典ファイルは `tests/performance/results/README.md` §4（E-280〜E-283）。同一 workload 14,400 req（POST / GET 1:1、steady 30 RPS 3 分 + burst 0→100 RPS 2 分、48 req/s）。Event 側はアカウント Lambda 同時実行 quota 10 の制約下。

| 合格条件                                        | Event Functions                                     | Web Functions                                | 判定                                                                                            |
| ----------------------------------------------- | --------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| warm p99 が Event 版以下                        | create p99 107.0 ms / list 85.2 ms                  | create **56.0 ms** / list **35.1 ms**        | 合格                                                                                            |
| cold p99 が Event 版の 1.2 倍以内               | Init p50 ≈ 390 ms、max 512 ms（10 回 / 12,978 inv） | 環境 init 434〜536 ms（3 回 / 14,401 req）   | 合格（max 比 1.05 倍）                                                                          |
| throttle 率が Event 版以下                      | 6.83%（burst 時 503、quota 10）                     | 0%（環境 max 3、throttle metric 0）          | 合格（Event 側は quota 制約。引き上げ後に再計測）                                               |
| request 当たり費用 Event 版比 20% 以上削減      | $1.61 / 1M（API Gateway 込み）、Lambda のみ $0.52   | $0.49〜0.56 / 1M（消費 memory の下限〜上限） | front door 込みでは合格、Lambda 単体比では同水準。48 req/s の値で、低負荷では環境生存課金が効く |
| CPU active ratio < 40% なら Web 有利            | （`Duration` 課金）                                 | **7.9%**（CPU 66.5 s / active 841.3 s）      | Web 有利                                                                                        |
| artifact size / deploy 時間 Event の 1.5 倍以内 | 0.94 MB / full deploy ≈ 7 分                        | 2.86 MB / 77 秒（更新 26 秒）                | **不合格**（size 3 倍。AWS SDK を同梱するため）。deploy 時間は合格                              |
| trace / log 一貫性                              | —                                                   | —                                            | 未計測（M-06 残項目）                                                                           |
| failure isolation / memory pressure             | —                                                   | —                                            | 未計測（M-06 残項目）                                                                           |

実測で確定した運用上の差分: Web Functions には request latency の CloudWatch metric がなく（client 側か application metric で測る）、`Authorization` header は `IamAuth` で剥がされ、コードは専用 versioned bucket と `AWS_LAMBDA_NODEJS_ENTRYPOINT` が必要だった（上記）。本 ADR は bundle size と未計測 2 項目が残るため `proposed` のまま。次の run は quota 引き上げ後の ADR 既定プロファイル（50 RPS 10 分 + 0→200 RPS）で、2 回目以降の値（Lambda が学習した dynamic concurrency）を採用する。

合格した API は結果を本 ADR へ追記し、個別 ADR で採用範囲を固定する。不合格または制約受容不可の場合は本 ADR を「Event Functions 固定」として `accepted` に変更する。

## Compliance / How it is enforced

- `ObservableFunction` の `runtimeProfile` 既定値は `'event-zip-arm64'`。`'experimental-web'` は `ServiceManifest.runtimeProfile` との一致と ADR 参照を要求し、`PlatformGuardrails` が production Stage での `'experimental-web'` を synth で拒否する。
- `PavedApiService` は Event Functions 向けの alias / CodeDeploy weighted routing を既定で設定し[^106]、Web Functions には `autoDeploymentMode: Disabled` と `revisionWeights` を設定する。[^67]
- CI の `load smoke` ステップで、`experimental-web` を含む stack に対して benchmark の縮小版（p99 と throttle のみ）を毎回実行する。
- `@paas/observability` の Powertools preset が両プロファイルで `correlationId` / `tenantId` / revision 識別子をログへ付与することを `@paas/testing` の contract test で検証する。

## 参考

[^21]: [What is AWS Lambda?](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html)（参照日 2026-10-17）

[^22]: [AWS Lambda announces Lambda Web Functions](https://aws.amazon.com/about-aws/whats-new/2026/10/aws-lambda-web-functions/)（参照日 2026-10-17。発表日 2026-10-12）

[^26]: [Powertools for AWS Lambda (TypeScript)](https://docs.aws.amazon.com/powertools/typescript/latest/)（指針書 References より）

[^40]: [Configuring reserved concurrency for an Event Function](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)（参照日 2026-10-17）

[^42]: [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)（参照日 2026-10-17）

[^51]: [AWS Lambda Pricing](https://aws.amazon.com/lambda/pricing/)（参照日 2026-10-17）

[^66]: [Managing Web Function revisions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-revisions.html)（参照日 2026-10-17）

[^67]: [Deployment patterns (Lambda Web Functions)](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-deployment.html)（参照日 2026-10-17）

[^69]: [Response streaming for Lambda Event Functions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)（参照日 2026-10-17）

[^71]: [AWS Lambda Functions Powered by AWS Graviton2 Processor](https://aws.amazon.com/blogs/aws/aws-lambda-functions-powered-by-aws-graviton2-processor-run-your-functions-on-arm-and-get-up-to-34-better-price-performance/)（参照日 2026-10-17）

[^74]: [Configuring provisioned concurrency for an Event Function](https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html)（参照日 2026-10-17）

[^75]: [Types of metrics for Lambda Event Functions](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html)（参照日 2026-10-17）

[^267]: [Lambda Web Function endpoint access control — Signing requests](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-endpoint-access-control.html)（参照日 2026-10-21。「sign them yourself with SigV4 or SigV4a, using the service name `lambda`」「Every signed request must include the `X-Amz-Content-SHA256` header」「After Lambda validates the SigV4 or SigV4a signature, it removes the `Authorization` header before forwarding the request to your function」）

[^268]: [Using CloudWatch metrics with Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-monitoring-metrics.html)（参照日 2026-10-21）

[^269]: [Deploying Web Function code from Amazon S3](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-code-s3.html)（参照日 2026-10-21。「The bucket must have S3 versioning enabled」「The bucket policy must grant the Lambda service principal (`lambda.amazonaws.com`) `s3:GetObject` and `s3:GetObjectVersion` permissions. Scope the policy with an `aws:SourceArn` condition that matches the revision ARN pattern」「The `Failed` state is permanent」「Lambda does not verify that your server starts listening」）

[^106]: [aws-cdk-lib.aws_codedeploy.LambdaDeploymentConfig](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_codedeploy.LambdaDeploymentConfig.html)（参照日 2026-10-17）

[^107]: [Create an alias for a Lambda Event Function](https://docs.aws.amazon.com/lambda/latest/dg/configuration-aliases.html)（参照日 2026-10-17）

[^v1]: [Powertools for AWS Lambda (TypeScript)](https://docs.aws.amazon.com/powertools/typescript/latest/)（参照日 2026-10-17。Tenets「AWS Lambda only. We optimise for AWS Lambda function environments and supported runtimes only. Utilities might work with web frameworks and non-Lambda environments, though they are not officially supported.」）
