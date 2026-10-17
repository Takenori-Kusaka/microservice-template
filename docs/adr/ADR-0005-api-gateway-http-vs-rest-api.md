# ADR-0005: API Gateway HTTP API vs REST API

- Status: proposed
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0006, ADR-0014, ADR-0015, ADR-0016, ADR-0018

## Context

同期 API の標準経路は `CloudFront/WAF → API Gateway → Lambda → service-owned datastore` である。API Gateway は認証、ルーティング、スロットリング、契約境界を担い、業務認可はサービス側が tenant context と resource ownership で行う。API Gateway には REST API と HTTP API の 2 種類があり、AWS は「REST API はより多くの機能を持ち、HTTP API は最小機能で低価格に設計されている。API key、per-client throttling、request validation、AWS WAF 連携、private endpoint が必要なら REST API を選ぶ」と説明している。[^61]

AWS の機能比較表（参照日 2026-10-17）によれば、HTTP API が持たない主な機能は次のとおりである。[^61]

- API key、usage plan、per-client rate limiting / usage throttling
- request validation、request body transformation、custom gateway responses
- caching、canary release deployments、mock integration、response streaming
- AWS WAF の直接関連付け、resource policy、private endpoint
- API Gateway 側の AWS X-Ray tracing、execution logs、Firehose への access log

HTTP API のみが持つ機能は、ネイティブ JWT authorizer、automatic deployments、AWS Cloud Map との private integration である。[^61]

料金は US East で HTTP API が最初の 3 億 request まで $1.00 / 百万、REST API が最初の 3.33 億 call まで $3.50 / 百万である。[^20][^19] ただし authorizer 呼び出し、WAF、access log、データ転送、下流 Lambda 呼び出しを含めて比較する必要がある。アカウント・リージョン当たりの throttle は既定 10,000 RPS、burst 5,000 で、HTTP API / REST API / WebSocket API をまたいで共有される。[^62]

`apps/example-order-service` は HTTP API + Lambda authorizer（payload format 2.0、simple response、`context` で tenant context を enrich）[^64]で実装されており、本 ADR の標準案の実証対象である。

## Decision

準拠: AWS API Gateway Developer Guide「Choose between REST APIs and HTTP APIs」[^61]、API Gateway 料金表[^20]、API Gateway quotas[^62]、AWS whitepaper「Best Practices for Designing Amazon API Gateway Private APIs」のコスト最適化[^19]

**HTTP API を薄い JWT API の標準候補とし、REST API は次の機能が必要なサービスの候補とする。** 採用時点の AWS 機能比較表を本 ADR に固定し、次回レビューで更新する。

| 要件                                       | HTTP API                                                            | REST API                    | 本 PaaS での扱い                                                             |
| ------------------------------------------ | ------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| JWT authorizer（Cognito / OIDC）           | ネイティブ[^61]                                                     | Lambda authorizer 経由[^61] | HTTP API で十分                                                              |
| Lambda authorizer（tenant context enrich） | 対応（payload 2.0 simple response、`context`、TTL キャッシュ）[^64] | 対応                        | 両方可                                                                       |
| usage plan / API key による tier 別 quota  | 非対応[^61]                                                         | 対応                        | tier 別 quota が契約要件なら REST                                            |
| request validation（JSON Schema）          | 非対応[^61]                                                         | 対応                        | HTTP API では Lambda 内で zod validation                                     |
| レスポンスキャッシュ                       | 非対応[^61]                                                         | 対応                        | 読み取り系で p99 達成に必要なら REST を検討                                  |
| WAF 直接関連付け                           | 非対応（CloudFront 経由）[^61]                                      | 対応                        | 標準経路は CloudFront 前段のため差なし                                       |
| private API（VPC endpoint）                | 非対応[^61]                                                         | 対応                        | 内部管理 API のみ                                                            |
| API Gateway 側 X-Ray tracing               | 非対応[^61]                                                         | 対応                        | HTTP API では Lambda の active tracing と `correlationId` で補う（ADR-0015） |
| access log                                 | 対応（CloudWatch Logs）[^61]                                        | 対応                        | `PavedApiService` が両方設定                                                 |
| canary release deployment                  | 非対応[^61]                                                         | 対応                        | HTTP API では Lambda alias weighted routing で代替（ADR-0020）               |
| response streaming                         | 非対応[^61]                                                         | 対応[^69]                   | streaming が必要な API は REST または Function URL を検討                    |
| 料金（request 単価、US East 第 1 段階）    | $1.00 / 百万[^20]                                                   | $3.50 / 百万[^20]           | 単価だけで決めない                                                           |

`PavedApiService` は `apiType: 'http' | 'rest'` を受け取り、既定を `'http'` とする。`'rest'` を指定する場合は `justification` プロパティに上表の機能名と ADR 参照を必須とする。

本 ADR を `accepted` へ変更する条件は、Evidence 節の benchmark を `apps/example-order-service` で実施し、HTTP API 構成が SLO と費用目標を満たすことを記録することである。

## Alternatives

### A. REST API を全サービスの標準にする

- 長所: 機能が最も多く、usage plan による tier 別 quota、request validation、caching、API Gateway 側 X-Ray が標準機能で実現できる。[^61]
- 短所: request 単価が HTTP API の 3.5 倍で[^20]、JWT 検証に Lambda authorizer が必須となり authorizer 呼び出し費用と遅延が加わる。多くの PaaS API は JWT 検証とルーティングだけで足りるため過剰。

### B. Application Load Balancer + Lambda

- 長所: 固定料金で高トラフィック時に request 単価が下がる（計測で確定: ALB の時間課金 + LCU 課金と HTTP API の request 課金の break-even RPS は、`tools/cost-model/src/prices.ts` に ALB 単価を追加して `pnpm cost-model` で試算する。docs/decision/template-defaults.md#計測で確定する項目 M-03、現在は未計測）。
- 短所: JWT authorizer、throttling、usage plan がなく、認証と rate limit を Lambda 側で実装する必要がある。中規模トラフィックでは ALB の固定費が不利。Lambda Web Functions の endpoint と比較する場合に ADR-0006 で再検討する。

### C. Lambda Function URL + CloudFront

- 長所: API Gateway 費用がゼロで、最も安価。Node.js の response streaming を利用できる。[^69]
- 短所: throttling、authorizer、stage、access log が API Gateway 相当に揃わず、契約境界とセキュリティ制御を自前で作ることになる。公開 API には採用しない。内部 webhook など限定用途で例外 ADR を認める。

## Consequences

- **費用**: HTTP API 標準により API 層の request 費用は REST 比で大幅に下がる。[^20] REST を選ぶサービスは usage plan の運用コストも負う。
- **性能**: HTTP API は API Gateway 側の X-Ray segment を持たないため[^61]、API Gateway の `Latency` と `IntegrationLatency` の差分で API Gateway overhead を計測する。[^65] レスポンスキャッシュが必要な場合は DynamoDB DAX や read model で代替するか REST を選ぶ。
- **運用**: tier 別 quota を HTTP API で実現する場合、authorizer context の `tenantTier` を使った `PavedApiService` 内のレート制御（DynamoDB token bucket）が必要で、platform-team が所有する（計測で確定: token bucket の精度（±5%）と DynamoDB 費用は `tests/performance/api-gateway-comparison/` の benchmark で tier 別に 429 率と消費 capacity を記録して確定する。docs/decision/template-defaults.md#計測で確定する項目 M-04、現在は未計測）。
- **Lock-in**: OpenAPI 3.1 を正本とするため[^109]、API Gateway 種別の切替は CDK 側の変更で済む。
- **移行**: HTTP → REST の切替は同一 OpenAPI から再生成するが、custom domain とステージ URL が変わるため consumer への移行期間を設ける（ADR-0013 の versioning と同じ expand / contract）。[^83]

## Evidence

benchmark protocol（`tests/performance/api-gateway-comparison/`）。負荷値と合格閾値は本テンプレートの初期値であり、外部文献に基づくものではない。計測で確定: 初回 benchmark の `Latency` − `IntegrationLatency`、p99、Cost Explorer の結果を本 ADR 末尾に記録し、閾値を見直す（docs/decision/template-defaults.md#計測で確定する項目 M-04 / M-05、現在は未計測・試験ディレクトリ未作成）。

1. `apps/example-order-service` の `POST /orders` と `GET /orders/{id}` を HTTP API と REST API の両方で同一 Lambda alias に接続する。
2. 負荷: 50 RPS 定常 10 分、200 RPS burst 2 分、tenant skew（上位 1 tenant が 40%）を含める。アカウント throttle（10,000 RPS / burst 5,000）[^62]を超えないことを確認する。
3. 計測: API Gateway `Latency` と `IntegrationLatency` の差分[^65]、authorizer 遅延、p50/p95/p99、`4XXError` / `5XXError`[^65]、throttle 件数、Cost Explorer の API Gateway + Lambda + CloudWatch Logs の合計。
4. 合格条件: HTTP API 構成で p99 latency が ADR-0016 の budget 内（API Gateway + authorizer の配賦 ≤ 50 ms）であり、月間 1,000 万 request 試算での API 層費用が REST 比で 50% 以下。
5. tier 別 quota が必要な場合の HTTP API + DynamoDB token bucket 方式が、REST usage plan と同等の精度（±5%）で制御できることを確認する。

結果を本 ADR の末尾に追記し、`accepted` へ変更する。

## Compliance / How it is enforced

- `PavedApiService` の既定 `apiType` が `'http'`。`'rest'` は `justification` 必須で、`PlatformGuardrails` が ADR 参照のない `'rest'` を synth で拒否する。
- `PavedApiService` が access log、Lambda 側 X-Ray active tracing、stage throttle、CloudFront 前段の WAF 関連付けを自動設定する。
- `PavedApiService` の Lambda authorizer は payload format 2.0 + simple response を既定とし、`authorizerResultTtlInSeconds` と identity source（`$request.header.Authorization`）を必須設定する。[^64]
- `schemas/openapi/` の OpenAPI 3.1 を正本とし[^109]、CI の `contract` ステップで `@paas/api-contracts` の生成物と差分がないことを検査する。
- Function URL を公開する Lambda は `PlatformGuardrails` が検出し、例外 ADR 参照がなければ拒否する。

## 参考

[^19]: [Cost optimization - Best Practices for Designing Amazon API Gateway Private APIs](https://docs.aws.amazon.com/whitepapers/latest/best-practices-api-gateway-private-apis-integration/cost-optimization.html)（指針書 References より）

[^20]: [Amazon API Gateway Pricing](https://aws.amazon.com/api-gateway/pricing/)（参照日 2026-10-17。US East: HTTP API $1.00 / 百万（最初の 3 億）、REST API $3.50 / 百万（最初の 3.33 億））

[^61]: [Choose between REST APIs and HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html)（参照日 2026-10-17）

[^62]: [Amazon API Gateway quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html)（参照日 2026-10-17）

[^64]: [Control access to HTTP APIs with AWS Lambda authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html)（参照日 2026-10-17）

[^65]: [Amazon API Gateway dimensions and metrics](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-metrics-and-dimensions.html)（参照日 2026-10-17）

[^69]: [Response streaming for Lambda Event Functions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)（参照日 2026-10-17）

[^83]: [ParallelChange (expand / contract) - Danilo Sato, martinfowler.com](https://martinfowler.com/bliki/ParallelChange.html)（参照日 2026-10-17）

[^109]: [OpenAPI Specification v3.1.0](https://spec.openapis.org/oas/v3.1.0)（参照日 2026-10-17）
