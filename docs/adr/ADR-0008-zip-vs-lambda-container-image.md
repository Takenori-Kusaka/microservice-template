# ADR-0008: zip vs Lambda container image

- Status: proposed
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0002, ADR-0006, ADR-0009, ADR-0016, ADR-0020

## Context

Lambda のデプロイ形式には zip アーカイブとコンテナイメージがある。AWS のドキュメントでは、どちらも「deployment package」の種別であり、既存関数の package type は変更できない（新しい関数を作る必要がある）。[^31] 実行上限（タイムアウト 15 分、メモリ 128〜10,240 MB）や同時実行モデルは形式に依存しない。[^42]

Lambda quotas と container image ドキュメントの数値（参照日 2026-10-17）は次のとおり。[^42][^31]

| 項目                                       | 値                                                        |
| ------------------------------------------ | --------------------------------------------------------- |
| zip（API / SDK / console 経由）            | 50 MB（圧縮時）                                           |
| zip 展開後（layer と custom runtime 含む） | 250 MB                                                    |
| layer 数                                   | 関数当たり 5                                              |
| container image                            | 10 GB（非圧縮、全 layer 含む）                            |
| image manifest                             | 25,400 バイト未満を推奨（layer 数と annotation を減らす） |
| メモリ                                     | 128〜10,240 MB、1,769 MB で 1 vCPU 相当                   |
| `/tmp`                                     | 512〜10,240 MB                                            |

コンテナイメージは upload 後に Lambda が最適化を行い `Pending` → `Active` に遷移する。数週間 invoke されないと最適化版が回収され `Inactive` になり、再 invoke 時に `Pending` を経る。[^31] AWS Builder Center の記事は、コンテナイメージの cold start は歴史的に遅かったが Lambda のキャッシュで改善したとしている。[^30]

本テンプレートは TypeScript を esbuild で bundle し、arm64 の zip として `ObservableFunction` がデプロイする。CDK の `NodejsFunction` は esbuild でバンドルし、`minify` / `sourceMap` は既定 false、`format` は既定 CJS（ESM は Node.js 14 以上）、`externalModules` の既定はランタイム依存（Node.js 18 以上では `@aws-sdk/*` を除外）である。[^72] Graviton2（arm64）は x86 比で duration 単価が 20% 低く、最大 34% の price performance 改善と AWS は述べている。[^71] AWS Serverless Applications Lens は arm64 への変更を負荷試験で検証するよう推奨している。[^36][^37] 全サポートランタイムは x86_64 と arm64 の両方に対応する。[^70]

Node.js 22 ランタイム（`nodejs22.x`）は 2027-04-30 に deprecation 予定で、Node.js 24 は 2028-04-30 まで、Node.js 26 は 2026 年 11 月提供予定（現在 public preview）である。[^70] 本テンプレートの Review date（2027-04-17）は Node.js 22 deprecation の直前であり、レビュー時に Node.js 24 への移行を判断する。

## Decision

準拠: AWS Lambda Developer Guide「Create a Lambda Event Function using a container image」[^31]、Lambda quotas[^42]、Lambda runtimes[^70]、AWS CDK `aws_lambda_nodejs`[^72]、AWS Serverless Applications Lens（arm64 の負荷試験）[^36][^37]、AWS Graviton2 Lambda 発表[^71]

- **esbuild で bundle した zip、arm64、Node.js 22（`nodejs22.x`）を Lambda パッケージの標準とする。** Review date までに Node.js 24 へ移行する。[^70]
- **Lambda コンテナイメージは次のいずれかを満たす関数にのみ、`runtimeProfile: 'event-image-arm64'` として許可する。**
  1. native binary または OS パッケージ（例: ImageMagick、LibreOffice、ML ランタイム）が必要で、layer を含めた展開上限 250 MB を超える[^42]
  2. 既存の OCI build pipeline と supply chain 検査（SBOM、署名）をそのまま使う契約上の要件がある
  3. bundle サイズが zip 上限（250 MB 展開）を超え、依存分割で解決できない[^42]
- native 依存のために x86_64 へ戻す場合も、arm64 で build できないことを根拠として `ServiceManifest.runtimeProfile` に記載する。[^36]
- 本 ADR を `accepted` とするには、Evidence 節の起動試験を `apps/example-order-service` の `POST /orders` 関数で zip / image 両方について実施し、標準 zip 構成の数値を記録する。

| 項目         | zip (esbuild, arm64)                                                                                                       | container image                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| サイズ上限   | 50 MB (zip) / 250 MB 展開[^42]                                                                                             | 10 GB[^42][^31]                                                                                  |
| build        | `NodejsFunction`（esbuild、`format: ESM`, `minify: true`, `sourceMap: true`）[^72]                                         | Docker build + ECR push、AWS base image（AL2023）または任意 base + runtime interface client[^31] |
| cold start   | package サイズに依存（Lambda は download / unpack 時間を減らすため package の最小化を推奨[^v1]。比例定数は起動試験で計測） | イメージキャッシュに依存、初回と `Inactive` 復帰時に `Pending`[^31][^30]                         |
| deploy 時間  | 秒単位の見込み（計測で確定: `tests/performance/package-format/` で `cdk deploy` 所要時間を計測。M-10、未計測）             | ECR push と最適化で分単位の見込み（計測で確定: 同試験で計測。M-10、未計測）                      |
| supply chain | pnpm lockfile + `npm audit`                                                                                                | SBOM、イメージ署名、ECR scan                                                                     |
| 観測性       | 同じ                                                                                                                       | 同じ                                                                                             |

## Alternatives

### A. 全 Lambda をコンテナイメージに統一

- 長所: ローカル実行と本番が同一イメージで、native 依存を気にせず済む。AWS base image は runtime interface client と emulator を同梱する。[^31]
- 短所: 単純な関数でも ECR push と最適化を伴い、`Inactive` 状態からの復帰で `Pending` を経る。[^31] イメージの更新・脆弱性 scan を全関数で運用する負担が増え、container image には deprecation 通知が提供されない。[^70]

### B. zip + Lambda layer で native 依存を共有

- 長所: zip の速さを保ちつつ共通 native 依存を再利用できる。
- 短所: layer を含めた展開上限 250 MB、layer 数 5 を超えられない。[^42] layer のバージョン管理が各サービスに波及する。小〜中規模の native 依存ではこれを container image より先に試す。

### C. bundle せず `node_modules` を zip に同梱

- 長所: build が単純で、source map とスタックトレースが読みやすい。
- 短所: zip サイズが数十 MB になり、download / unpack 時間が延びて cold start が悪化する。[^v1]esbuild bundle を標準とする。[^72]

## Consequences

- **費用**: zip + arm64 は x86_64 比で duration 単価が 20% 低い。[^71] cold start が短ければ同一 SLO での Provisioned Concurrency 必要量も減る（計測で確定: 起動試験の cold start 分布（M-10）と slo-baseline の RPS（M-17）から必要 PC 数を算出する。docs/decision/template-defaults.md#計測で確定する項目 M-11、現在は未計測）。
- **性能**: bundle サイズを `ObservableFunction` が計測し、5 MB 超で警告、20 MB 超で例外を投げる（検査は未実装・予定）。既定値（例示値）: 5 MB / 20 MB。esbuild で tree-shake した API handler は通常 1 MB 未満のため、5 MB は依存混入の兆候、20 MB は cold start 悪化が確実な水準として置いた設計判断で、外部出典に基づかない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-06）。計測で確定: bundle サイズと cold start の関係は起動試験で記録する（M-12、現在は未計測）。
- **運用**: container image を採用するサービスは ECR リポジトリ、scan、イメージ署名、base image の再ビルドを自前で運用する。[^70] platform-team は `event-image-arm64` プロファイル向けの `ObservableFunction` オプションを保守する。
- **Lock-in**: esbuild 設定と Lambda zip は AWS 固有だが、application 層は影響を受けない。container image の方が他基盤（Fargate）への移植は容易。
- **移行**: zip → image への切替は package type の変更ができないため新しい関数リソースの作成を伴う。[^31] `ObservableFunction` の `code` 差し替えと alias の付け替えを runbook 化する。

## Evidence

起動試験 protocol（`tests/performance/package-format/`）。合格閾値は本テンプレートの初期値。計測で確定: 初回起動試験の `Init Duration` p50 / p95 / p99、warm p99、`cdk deploy` 所要時間、artifact サイズ、Power Tuning 結果を本 ADR に記録し、閾値を見直す（docs/decision/template-defaults.md#計測で確定する項目 M-10。起動試験は未実施・試験ディレクトリ未作成、Power Tuning のみ 2026-10-18 に実施、下記「実測」小節）。

1. `POST /orders` 関数を (a) esbuild zip arm64、(b) esbuild zip x86_64、(c) container image arm64（AWS base image `nodejs22` AL2023）[^31]、(d) container image arm64 + 200 MB native 依存の 4 構成でデプロイする。
2. 各構成で cold start を 100 回強制（環境変数更新で再デプロイ）し、`platform-initReport` の `Init Duration`[^74]の p50/p95/p99 を記録する。
3. warm p99 を 50 RPS 10 分で記録する（`Duration` は init を含まない）。[^75]
4. `cdk deploy` 所要時間と artifact サイズを記録する。
5. Lambda Power Tuning（`tools/power-tuning/`）で各構成の最適メモリと費用を測る。[^50][^103]
6. 合格条件: 標準 (a) の `Init Duration` p95 が 300 ms 未満、warm p99 が ADR-0016 の Lambda 配賦 budget 内。container image の採用は、(c) または (d) が (a) に対して cold start p95 で 2 倍以内かつ native 依存が layer で解決できない場合に限る。

結果を本 ADR に追記し `accepted` へ変更する。arm64 → x86_64 の判断も同じ試験で記録する。[^36][^37]

### 実測（2026-10-18 sandbox、手順 5 の Power Tuning のみ）

起動試験 1〜4 と 6（zip / image の比較、`Init Duration`、artifact サイズ）は未実施。手順 5 の Lambda Power Tuning を標準構成 (a) esbuild zip arm64 の `ApiFnListOrders`（`GET /orders?limit=20`、payload `tools/power-tuning/payloads/list-orders.json`）に対して実行した。各 memory 30 invocations、strategy `balanced`、2026-10-18 07:58 JST。結果: `tools/power-tuning/results/function-paas-sandbox-paas-sandbox-ApiFnListOrdersFunctionE-4n8nidHEe4EJ-1792277941831.json`、可視化は `tests/performance/results/README.md` §2。

| Memory  | avg duration | USD / invocation | 備考                                    |
| ------- | ------------ | ---------------- | --------------------------------------- |
| 768 MB  | 13.80 ms     | 1.530e-7         |                                         |
| 1024 MB | 12.98 ms     | 1.904e-7         | `ObservableFunction` 既定値（警告付き） |
| 1536 MB | **10.47 ms** | 2.448e-7         | **`balanced` 推奨**                     |
| 2048 MB | 11.72 ms     | 3.536e-7         |                                         |
| 3008 MB | 12.26 ms     | 5.194e-7         |                                         |

- コードの現在値は CreateOrder **1024 MB**、ListOrders / GetOrder **512 MB**（`apps/example-order-service/infra/order-service-stack.ts`）。ListOrders の 512 MB は本 run で計測できなかった（256 / 512 MB の executor が `Invalid JSON log does not contain platform.report` で失敗。power tuning の log parser が Powertools の JSON log 行を先頭に見て JSON 形式と誤判定するツール制約、2026-10-18 観測）。
- 推奨: read 系（ListOrders / GetOrder）は 512 → **1536 MB** への変更を候補とし、CreateOrder も同じ payload（`payloads/create-order.json`）で tuning してから決める。確定は M-10 の起動試験（`Init Duration` を含む）と TD-06 の bundle サイズ検査を揃えてから行い、`ObservableFunction` の `memorySize` に結果ファイルを参照させる（Compliance 節）。1536 MB 超は duration が改善せず費用だけ増えるため上限の目安。
- ツール運用: 関数 ARN は alias なしで渡す（`:live` 付きは `Invalid ARN`）。tuning 1 回の費用は Step Functions 5.3e-4 USD + Lambda 4.69e-5 USD。
- **cold start（標準構成 (a) の実測、2026-10-17）**: `ApiFnCreateOrder`（esbuild ESM bundle 約 **0.94 MB** / 関数、arm64、Node.js 22、Powertools + AWS SDK v3 同梱、1024 MB）を k6 窓（22:46–22:54Z）で CloudWatch Logs Insights（`filter @type="REPORT" | stats count(*), count(@initDuration), pct(@initDuration,50), pct(@initDuration,99), max(@initDuration), pct(@duration,50), pct(@duration,99), max(@maxMemoryUsed)`）で集計: 18,019 invocations、cold start 9 件（0.05%）、`Init Duration` **p50 363.2 ms / p99 488.3 ms / max 488.3 ms**、warm `@duration` p50 38.7 / p99 79.1 ms、`@maxMemoryUsed` max **203 MB**。手順 6 の合格条件「Init p95 < 300 ms」は bundle 1 MB 未満でも未達で、Node.js の runtime init + Powertools / SDK の module load が支配的と推定する（sample 9 件のため分布は参考値）。閾値の見直しと image 構成との比較は手順 1〜4 の起動試験で行う。memory headroom は 1024 MB に対し 203 MB で、memory 削減ではなく CPU 配分（Power Tuning）で決める。

## Compliance / How it is enforced

- `ObservableFunction` の既定が `architecture: ARM_64`、`runtime: NODEJS_22_X`、esbuild bundle（`NodejsFunction`、`format: ESM`, `minify: true`, `sourceMap: true`, `externalModules: ['@aws-sdk/*']`）。[^72]
- `runtimeProfile: 'event-image-arm64'` または x86_64 は `ServiceManifest.runtimeProfile` との一致と ADR 参照を要求し、`PlatformGuardrails` が参照のない構成を synth で拒否する。
- `ObservableFunction` が bundle サイズを計測し、5 MB 超で警告、20 MB 超で synth 失敗。
- CI の `synth` ステップで esbuild の `metafile` を出力し、bundle 内の依存一覧を artifact として保存する。
- container image を使う stack は CI の `policy` ステップで ECR scan 結果と SBOM の添付を必須とする。
- CI の `policy` ステップで Lambda ランタイムの deprecation 日[^70]を検査し、180 日前に警告、deprecation 後は synth を失敗させる。

## 参考

[^30]: [Using Container Images with AWS Lambda (AWS Builder Center)](https://builder.aws.com/content/3JqgZrVEL3fiHe3XF6SPMAtK6OD/using-container-images-with-aws-lambda)（指針書 References より）

[^31]: [Create a Lambda Event Function using a container image](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)（参照日 2026-10-17）

[^36]: [Lambda cost and performance optimization (Serverless Applications Lens)](https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/cost-and-performance-optimization.md)（指針書 References より）

[^37]: [Lambda cost and performance optimization (日本語)](https://docs.aws.amazon.com/ja_jp/wellarchitected/latest/serverless-applications-lens/cost-and-performance-optimization.html)（指針書 References より）

[^42]: [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)（参照日 2026-10-17）

[^50]: [Understanding techniques to reduce AWS Lambda costs in serverless applications](https://aws.amazon.com/blogs/compute/understanding-techniques-to-reduce-aws-lambda-costs-in-serverless-applications/)（指針書 References より）

[^70]: [Lambda Event Function runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html)（参照日 2026-10-17）

[^71]: [AWS Lambda Functions Powered by AWS Graviton2 Processor](https://aws.amazon.com/blogs/aws/aws-lambda-functions-powered-by-aws-graviton2-processor-run-your-functions-on-arm-and-get-up-to-34-better-price-performance/)（参照日 2026-10-17）

[^72]: [aws-cdk-lib.aws_lambda_nodejs module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda_nodejs-readme.html)（参照日 2026-10-17）

[^74]: [Configuring provisioned concurrency for an Event Function](https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html)（参照日 2026-10-17。`Init Duration` は `platform-initReport` に記録される）

[^75]: [Types of metrics for Lambda Event Functions](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html)（参照日 2026-10-17）

[^103]: [AWS Lambda Power Tuning (GitHub)](https://github.com/alexcasalboni/aws-lambda-power-tuning)（参照日 2026-10-17）

[^v1]: [Define Lambda Event Function handler in Node.js - Code best practices](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-handler.html#nodejs-best-practices)（参照日 2026-10-17。「Minimize your deployment package size to its runtime necessities. This will reduce the amount of time that it takes for your deployment package to be downloaded and unpacked ahead of invocation.」）
