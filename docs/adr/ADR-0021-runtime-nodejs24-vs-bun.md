# ADR-0021: Runtime: Node.js 24 standard, Bun not adopted

- Status: accepted
- Date: 2026-10-21
- Owner: platform-team
- Review date: 2027-04-21
- Related: ADR-0006, ADR-0008（Node.js 22 標準の記述を本 ADR が置き換える）, ADR-0009, ADR-0019, ADR-0020, ADR-0022, [最新技術での再検討 §A](../decision/latest-tech-reassessment.md)

## Context

本テンプレートは TypeScript を esbuild で bundle し、`ObservableFunction` が `nodejs22.x` / arm64 の zip としてデプロイする（ADR-0008）。owner から「Bun はスクリプト言語の実行性能が最速に近く、API 中継の多いマイクロサービスで最速の可能性がある」という仮説が出され、[最新技術での再検討 §A](../decision/latest-tech-reassessment.md) で一次資料により検証した。本 ADR はその判定を固定する。

本質は「リクエストあたりの CPU 時間と起動時間を最小化したい」である。これを Lambda の実行モデルで満たせるかが論点になる。

Lambda ランタイムの事実（参照日 2026-10-21）は次のとおり。[^70][^116]

| 項目                          | 値                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nodejs22.x`                  | deprecation 2027-04-30、block function create 2027-07-29、block function update 2027-08-31[^70]                                                                                                                                             |
| `nodejs24.x`                  | deprecation 2028-04-30、block function create 2028-06-01、block function update 2028-07-01[^70]                                                                                                                                             |
| `nodejs26.x`                  | public preview。SLA / Technical Support 対象外で production 利用不可。GA 目標 2026-11[^70]                                                                                                                                                  |
| managed runtime の提供方針    | 「Lambda provides managed runtimes for new language versions only when the release reaches the long-term support (LTS) phase」「Lambda doesn't provide managed runtimes for language versions which aren't scheduled for LTS release」[^70] |
| deprecation 通知              | 少なくとも 180 日前に email / Health Dashboard / Trusted Advisor で通知[^70]                                                                                                                                                                |
| Web Functions のランタイム    | `nodejs24.x` のみ。runtime management control なし、custom runtime / container image 不可[^116]                                                                                                                                             |
| Bun / Deno の managed runtime | なし。Bun は custom runtime layer（`bun-lambda`、README は Amazon Linux 2 前提）[^119]または container image + Lambda Web Adapter（公式ガイドは `linux/amd64` のみ）[^118] で動かす                                                         |

公開ベンチマーク（方法論付きのもののみ）は次のとおり。

| 計測                                                                                        | 結果                                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| maxday/lambda-perf（us-east-1、日次、10 cold start、2026-10-16、512 MB、arm64）[^127]       | `nodejs24.x` zip 平均 cold start 117.6 ms、`nodejs22.x` 124.6 ms、bun zip（provided.al2）290.2 ms（Node の約 2.3 倍）、bun container 259.2 ms、llrt 75.4 ms |
| Jason Butz（2025-05-22、SQS トリガ、各 70 cold start）[^128]                                | 平均 init: Node.js 22 152.0 ms、Deno 267.5 ms、Bun（layer）547.7 ms                                                                                         |
| bun.sh（ベンダー計測、hello-world Express over HTTPS、`bombardier -c 50`、Linux x64）[^129] | Bun v1.4 48,243 req/s、Node.js v26.7.0 25,181 req/s（約 1.9 倍）。warm な常駐プロセスの値                                                                   |
| TechEmpower Framework Benchmarks[^130]                                                      | 2026-03-24 に sunset。方法論付きの独立 warm ベンチマークは 2026-10-18 時点で見つからない                                                                    |

Bun の運用上の事実（参照日 2026-10-17）: LTS ポリシーがなく endoflife.date は「明確なサポートポリシーがない」と記載[^121]、SemVer / LTS 要望 issue #6438 は 2023-10 から open[^122]、GitHub Security Advisories の公開実績ゼロ[^123]、`node:async_hooks` の一部が stub で AsyncLocalStorage の伝播に制限があり `node:crypto` の一部アルゴリズムと `perf_hooks.eventLoopUtilization()` が未実装[^124]、HTTPS リクエストが hang する regression issue #26066 が 2026-01-14 から open で AWS SDK v3 での再現報告がある[^125]、AWS SDK チームは Bun を公式ドキュメントに含める計画がない[^126]。Powertools for AWS Lambda は Tenets で「AWS Lambda only」と明記し、非対応ランタイムは非公式サポートである[^26]。

Node.js 24 の事実: 24.x は 2025-10-28 に Active LTS、2026-10-20 に Maintenance、EOL 2028-04-30[^131][^132]。24.0.0 から `AsyncLocalStorage` が `AsyncContextFrame` 実装を既定とする[^132]。Lambda の Node.js 24 ランタイムは callback 形式の handler をサポートしない[^117]。

## Decision

準拠: AWS Lambda Developer Guide「Lambda Event Function runtimes」（LTS 方針、deprecation 日程）[^70]、「Lambda Web Function runtimes」[^116]、AWS Compute Blog「Node.js 24 runtime now available in AWS Lambda」[^117]、Powertools for AWS Lambda Tenets[^26]、maxday/lambda-perf[^127]

- **Node.js 24（`nodejs24.x`）を Event Functions / Web Functions 両プロファイルの標準ランタイムとする。** 理由は (1) Web Functions が `nodejs24.x` 固定[^116]、(2) `nodejs22.x` の deprecation が 2027-04-30[^70]、(3) request-scoped context の前提である `AsyncContextFrame` が 24.0.0 から既定[^132]。ADR-0008 の「Node.js 22 標準、Review date までに 24 へ移行」は本 ADR で「Node.js 24 標準」に置き換える。
- **移行の期限は 2026-11-30**（[再検討 §E #1](../decision/latest-tech-reassessment.md)）。`ObservableFunction` の `runtime` を `NODEJS_24_X`、esbuild `target` を `node24`、`@types/node` を 24 系へ更新し、全 unit / contract / synth を通す。callback 形式 handler は eslint ルールで検出する。[^117]
- **`nodejs26.x` は public preview の間は禁止**し、GA 後に本 ADR の Review で判断する。[^70]
- **Bun を Lambda ランタイムとして採用しない。** managed runtime がなく[^70]、Web Functions に載らず[^116]、Lambda の cold start が Node の 2〜3 倍[^127][^128]、LTS / セキュリティポリシーがなく[^121][^122][^123]、AWS SDK v3 の HTTPS hang が open[^125]、Powertools が非対象[^26]。owner の仮説の本質（リクエストあたり CPU 最小化）は「arm64 + esbuild bundle 最小化 + Node.js 24」で満たす（ADR-0008）。
- **Bun を開発ツール（package manager / test runner / bundler）として使うことも当面見送る。** pnpm + vitest + esbuild で CI が成立しており、2 系統化の保守費を上回る根拠がない。`tools/` 配下での `bun test` 互換実験は許可する（成果物はコミットしない）。
- **LLRT は不採用。** AWS Labs 自身が「experimental。評価目的のみ」と明記している。[^133]
- **ECS/Fargate プロファイル（ADR-0009）では Bun container を benchmark 候補に含める。** 常駐サーバでは warm 性能の差が出る可能性があるため[^129]、ADR-0009 の benchmark で独立再現する。
- 再検討トリガー: AWS が Bun を managed runtime または Web Functions runtime に追加、Bun が LTS ポリシーを公開、issue #26066 の修正、`nodejs26.x` の GA。

## Alternatives

### A. Node.js 24 managed runtime（採用）

- 長所: managed runtime にセキュリティパッチが自動適用され、deprecation の 180 日前通知がある。[^70] Web Functions と同一ランタイム。[^116] cold start は公開計測で最速級（llrt を除く）。[^127] Powertools / AWS SDK v3 / CDK `NodejsFunction` が公式サポート。[^26][^72]
- 短所: warm な hello-world スループットはベンダー計測で Bun の約 1/2。[^129] ただし本テンプレートの API は DynamoDB 往復が duration の大半を占める I/O bound で、JS エンジン差がレイテンシに出る余地は小さい（計測で確定: ADR-0006 benchmark で `EnvironmentCPUTime / EnvironmentActiveTime` を計測する。docs/decision/template-defaults.md#計測で確定する項目 M-06、現在は未計測）。

### B. Bun（custom runtime layer または container + Lambda Web Adapter）

- 長所: TypeScript をネイティブ実行でき、warm 常駐サーバでは高スループット。[^129] `bun build --target=node` で Node 互換の bundle も作れる。
- 短所: managed runtime なし[^70]、`bun-lambda` layer は Amazon Linux 2 前提で `provided.al2` は 2026-07-31 に deprecated[^119][^70]、公式 container ガイドは `linux/amd64` のみで arm64 標準（ADR-0008）と合わない[^118]、cold start 2〜3 倍[^127][^128]、LTS なし[^121][^122]、HTTPS hang issue open[^125]、Powertools 非対象[^26]。

### C. LLRT（AWS Labs の低レイテンシランタイム）

- 長所: cold start 75.4 ms、duration 1.60 ms と公開計測で最速。[^127]
- 短所: 「experimental、評価目的のみ」で production 向けの保証がない。[^133] Node.js API 互換も部分的。

### D. Node.js 22 を維持し Review date（2027-04）で判断

- 長所: 変更なし。
- 短所: deprecation 2027-04-30 の直前になり、block function update（2027-08-31）までの猶予が短い。[^70] Web Functions（`experimental-web`、ADR-0006）と Event で異なるランタイムを保守することになる。[^116]

## Consequences

- **費用**: 変化なし。ランタイム種別で Lambda 料金は変わらない。[^51] lambda-perf の 512 MB 計測では `nodejs24.x` の平均 duration（4.92 ms）が `nodejs22.x`（5.50 ms）より短く、費用は同等以下と見込む。[^127] 計測で確定: 移行前後の `Duration` p50 / p99 を `tests/performance/order-api.k6.js` で比較する（M-17、移行後に再計測）。
- **性能**: cold start は `nodejs24.x` 117.6 ms vs `nodejs22.x` 124.6 ms（lambda-perf、512 MB、arm64）。[^127] 本テンプレートの実測（`ApiFnCreateOrder`、Node.js 22、1024 MB）は `Init Duration` p50 363 ms で、bundle 内の Powertools / AWS SDK v3 初期化が支配的と推定される（M-10、E-178）。ランタイム更新だけで Init が大きく改善する根拠はなく、改善は bundle 最小化（TD-06）で行う。
- **運用**: `RuntimeDeprecationAspect` が `nodejs22.x` の deprecation（2027-04-30）の 180 日前、すなわち 2026-11-01 から synth 時に警告を出す。移行期限（2026-11-30）はこの警告開始直後に置いている。Node.js 24 は callback handler を受け付けないため[^117]、lint で検出する。
- **Lock-in**: managed runtime に依存するが、標準 Node.js API のみを使うコードは ECS/Fargate（ADR-0009）へそのまま移植できる。Bun を採用しないことで runtime 固有 API への依存を作らない。
- **移行**: `ObservableFunction` の定数変更（`runtime` / `target`）1 箇所で全関数が切り替わる（ADR-0019 の構造）。alias / version による段階デプロイ（ADR-0020）で rollback 可能。

## Evidence

- Lambda runtimes ページの deprecation 日程と LTS 方針（2026-10-21 に再確認）。[^70]
- Web Functions が `nodejs24.x` のみ（2026-10-21 に再確認）。[^116]
- cold start 比較: lambda-perf 2026-10-16 データ[^127]、Jason Butz 2025-05-22[^128]。
- warm スループット: bun.sh ベンダー計測のみで、独立計測は TechEmpower sunset 後に存在しない。[^129][^130] 本テンプレートの API に効く数値は計測で確定: ADR-0006 の event-vs-web benchmark で CPU active ratio を得る（M-06、未計測）。
- Bun の運用リスク: endoflife.date[^121]、issue #6438[^122]、Security Advisories[^123]、Node.js 互換表[^124]、issue #26066[^125]、aws-sdk-js-v3 issue #6734[^126]。
- 受入基準（`accepted` を維持する条件）: 2026-11-30 までに `nodejs24.x` で `pnpm typecheck` / `pnpm test` / `pnpm synth` / `tests/contract` が通り、sandbox の `tests/integration` 3 件と `tests/tenant-isolation` 3 件が pass する（E-102 と同じ手順）。結果は本 ADR の Expiry 表に追記する。

## Compliance / How it is enforced

- `ObservableFunction`（`packages/constructs/src/observable-function.ts`）が `runtime` と esbuild `target` を定数で持ち、サービス側で上書きできない。移行 PR でこの定数を `NODEJS_24_X` / `node24` に変更する。
- `RuntimeDeprecationAspect`（`packages/constructs/src/guardrails.ts`）が `LAMBDA_RUNTIME_DEPRECATION` 表（`nodejs20.x` 2026-04-30、`nodejs22.x` 2027-04-30）を持ち、deprecation の 180 日前から synth 警告、経過後は synth エラーにする。`nodejs24.x`（2028-04-30）の行を移行 PR で追加する。[^70]
- `PlatformGuardrails` が `provided.*` / container image を `runtimeProfile` の宣言なしに使う関数を cdk-nag と合わせて拒否する（ADR-0008）。[^104]
- `@paas/eslint-config` に callback 形式 handler（第 3 引数 `callback` を持つ handler export）を禁止するルールを追加する（移行 PR）。[^117]
- CI の `synth` ステップで `--context env=production` の synth が警告ゼロで通ることを確認する。
- ADR-0008 の Review（2027-04-17）で `nodejs26.x` GA の有無と本 ADR の整合を確認する。

## Expiry / Review date

| 日付       | 評価者        | 結果                                                          |
| ---------- | ------------- | ------------------------------------------------------------- |
| 2026-10-21 | platform-team | 初版。Node.js 24 標準、Bun / LLRT 不採用。移行期限 2026-11-30 |

## 参考

[^26]: [Powertools for AWS Lambda (TypeScript)](https://docs.aws.amazon.com/powertools/typescript/latest/)（参照日 2026-10-17。Tenets「AWS Lambda only. We optimise for AWS Lambda function environments and supported runtimes only.」）

[^51]: [AWS Lambda Pricing](https://aws.amazon.com/lambda/pricing/)（参照日 2026-10-17）

[^70]: [Lambda Event Function runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html)（参照日 2026-10-21。`nodejs24.x` deprecation 2028-04-30、`nodejs22.x` 2027-04-30、`nodejs26.x` public preview、LTS 方針、180 日前通知）

[^72]: [aws-cdk-lib.aws_lambda_nodejs module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda_nodejs-readme.html)（参照日 2026-10-17）

[^104]: [cdk-nag (GitHub, cdklabs)](https://github.com/cdklabs/cdk-nag)（参照日 2026-10-17）

[^116]: [Lambda Web Function runtimes](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-runtimes.html)（参照日 2026-10-21。「Lambda Web Functions currently support Node.js」、表は `nodejs24.x` のみ、「Runtime management controls are not supported for Web Functions」）

[^117]: [Node.js 24 runtime now available in AWS Lambda - AWS Compute Blog](https://aws.amazon.com/blogs/compute/node-js-24-runtime-now-available-in-aws-lambda/)（参照日 2026-10-17。2025-11-25 公開。callback 形式 handler 非対応）

[^118]: [Deploy a Bun application on AWS Lambda - Bun Guides](https://bun.com/guides/deployment/aws-lambda)（参照日 2026-10-17。container image + Lambda Web Adapter、`linux/amd64`）

[^119]: [oven-sh/bun packages/bun-lambda README](https://github.com/oven-sh/bun/tree/main/packages/bun-lambda)（参照日 2026-10-17。Amazon Linux 2 前提の custom runtime layer）

[^121]: [Bun - endoflife.date](https://endoflife.date/bun)（参照日 2026-10-17。「明確なサポートポリシーがない」）

[^122]: [oven-sh/bun issue #6438 "SemVer / LTS"](https://github.com/oven-sh/bun/issues/6438)（参照日 2026-10-17。2023-10 から open）

[^123]: [oven-sh/bun Security](https://github.com/oven-sh/bun/security)（参照日 2026-10-17。公開 advisory ゼロ、サポート対象「1.x.x」）

[^124]: [Node.js compatibility - Bun Docs](https://bun.sh/docs/runtime/nodejs-apis)（参照日 2026-10-17。`node:async_hooks` stub、`node:crypto` 欠落アルゴリズム、`eventLoopUtilization()` が 0）

[^125]: [oven-sh/bun issue #26066 "HTTPS requests hanging (regression 1.2.23 -> 1.3.x)"](https://github.com/oven-sh/bun/issues/26066)（参照日 2026-10-17。2026-01-14 から open）

[^126]: [aws/aws-sdk-js-v3 issue #6734 "Missing Installation code for bun"](https://github.com/aws/aws-sdk-js-v3/issues/6734)（参照日 2026-10-17）

[^127]: [maxday/lambda-perf](https://github.com/maxday/lambda-perf)、[2026-10-16 データ](https://raw.githubusercontent.com/maxday/lambda-perf/main/data/2026-10-16.json)（参照日 2026-10-17。日次 10 cold start、us-east-1）

[^128]: [JavaScript Lambda Runtime Benchmarking - Jason Butz](https://jasonbutz.info/2025/05/javascript-lambda-runtime-benchmarking/)（参照日 2026-10-17。2025-05-22）

[^129]: [bun.sh トップページ benchmark](https://bun.sh/)（参照日 2026-10-17。ベンダー計測）

[^130]: [TechEmpower/FrameworkBenchmarks issue #10932](https://github.com/TechEmpower/FrameworkBenchmarks/issues/10932)（参照日 2026-10-17。2026-03-24 sunset）

[^131]: [nodejs/Release schedule](https://github.com/nodejs/Release)（参照日 2026-10-17）

[^132]: [Node.js 24.0.0](https://nodejs.org/en/blog/release/v24.0.0)、[v24.11.0（LTS 昇格）](https://nodejs.org/en/blog/release/v24.11.0)（参照日 2026-10-17。`AsyncContextFrame` 既定化）

[^133]: [awslabs/llrt README](https://github.com/awslabs/llrt)（参照日 2026-10-17。「experimental」）
