# microservice-template

B2B マルチテナント PaaS 向け、**フルマネージド・サーバレスなマイクロサービス構成のシステムモックテンプレート**（TypeScript / Node.js 22 / AWS CDK v2）。

このリポジトリは 3 つの使い方を想定している。

1. **構築する** — `pnpm create-service` で golden path に沿ったサービスを生成し、`pnpm deploy:sandbox` でそのままデプロイできる。
2. **決める** — [docs/decision](docs/decision/) の質問票・決定木で、要件からアーキテクチャ（API compute、テナント分離、同期/非同期、ランタイム、データストア）を選ぶ。
3. **レビューする** — [docs/review](docs/review/) のチェックリストで、既存リポジトリ・要求仕様書・設計指針書・設計書をレビューし、マイクロサービス開発の課題を洗い出す。

すべての規範的な記述は出典（AWS Well-Architected / SaaS Lens / Builders' Library、各社の公開事例、CloudEvents・OpenAPI 等の規格）に紐づけている。出典のない主張は「既定値（例示値）: … 調整: TD-NN」「計測で確定: …（M-NN）」「公式ドキュメントに記載なし（確認日、URL）」のいずれかで明記する（[docs/microservice-guidelines.md](docs/microservice-guidelines.md) のエビデンス台帳、[docs/review/evidence-register.md](docs/review/evidence-register.md)）。

## 構成

```
apps/
  platform-cdk/                 CDK app: EnvironmentStage → PlatformStack(bus/alarms/KMS) → service stacks
  example-order-service/        同期API: API Gateway HTTP API + Lambda + DynamoDB + Idempotency + outbox → EventBridge
  example-worker-service/       非同期: EventBridge → tier別SQS → Lambda(partial batch, DLQ, 冪等consumer)
  example-workflow-service/     ワークフロー: Step Functions Standard saga(補償付き)
packages/
  constructs/                   paved-road L3: ObservableFunction, TenantAwareTable, PavedApiService,
                                PavedQueueConsumer, PavedWorkflow, EventSubscription, ServiceObservability,
                                ServiceManifest(service.yaml), PlatformGuardrails(cdk-nag + 独自Aspect)
  runtime-context/              ExecutionContext(tenant/correlation/deadline) + AsyncLocalStorage
  observability/                Powertools Logger/Tracer/Metrics preset, PII redaction
  event-contracts/              CloudEvents風 envelope, zod schema registry, EventBridge/SQS adapter
  api-contracts/                OpenAPI → 型生成, zod validation, 標準エラー形
  testing/                      fixtures, TenantIsolationProbe
schemas/openapi, schemas/events 契約の正本(生成物はCIで差分検査)
tests/contract|integration|tenant-isolation|resiliency|performance
tools/create-service|diagrams(cdk2d2 → D2+TALA)|cost-model|power-tuning
docs/microservice-guidelines.md 設計指針書(20章) / docs/adr ADR-0001..0020 / docs/review / docs/decision
```

## クイックスタート

```bash
pnpm install
pnpm verify                      # format → lint → typecheck → unit → contract → synth(policy)
pnpm synth --context env=sandbox
pnpm diagrams --synth            # cdk.out → docs/architecture/diagrams/generated/sandbox.svg (D2 + TALA, AWS 不要)
pnpm diagrams:deployed --stack paas-sandbox-paas-sandbox-cell-01-order-service  # 公式 cdk2d2 (要 AWS 認証 + デプロイ済み)
pnpm deploy:sandbox              # 要 AWS 認証 (CDK bootstrap 済みアカウント)
pnpm create-service --name invoice-service --type api --domain billing --owner billing-team
pnpm cost-model                  # 単位原価 (tier別 / request別)
```

デプロイ後の E2E:

```bash
export PAAS_API_URL=https://<api-id>.execute-api.ap-northeast-1.amazonaws.com
pnpm test:integration            # 冪等性(並行リトライ)、相関ID
pnpm test:tenant-isolation       # tenant A の identity で tenant B のデータに触れないこと
k6 run tests/performance/order-api.k6.js
```

### ADR-0006 ベンチマーク用: Lambda Web Functions（experimental）

同じ業務ロジックを Hono の HTTP サーバとして `apps/example-order-service/src/entrypoints/web/server.ts` に用意し、aws-cdk-lib 2.273 の L1（`AWS::Lambda::WebFunction` / `WebFunctionRevision` / `WebFunctionEndpoint`）で組んだ `ExperimentalWebFunction` construct からデプロイできる（sandbox / development / staging のみ。production は guardrail が拒否）。

```bash
pnpm --filter @paas/example-order-service dev:web        # ローカル: AWS_LAMBDA_HTTP_ENDPOINT と同じ起動経路
pnpm --filter @paas/example-order-service build:web      # esbuild → dist/web/index.mjs (Node.js 24 / arm64 前提)
pnpm synth --context env=sandbox --context experimentalWeb=true
```

### ADR-0026 検出基盤（opt-in）

`PlatformDetection` construct（`packages/constructs/src/platform-detection.ts`）は、ログファイル検証付き CloudTrail（management + DynamoDB / Lambda の data events、Object Lock 対応の専用 bucket）、GuardDuty（Lambda Protection）、Security Hub、GuardDuty High/Critical finding → alarm topic のルーティングを 1 構成で提供します。GuardDuty / Security Hub はアカウント単位のシングルトンで、CloudTrail data events はイベント課金のため、**既定では作成しません**（共有本番アカウントでの誤有効化を防ぐ）。

```bash
pnpm synth --context env=sandbox --context detection=true                       # CloudTrail + finding routing のみ
pnpm synth --context env=sandbox --context detection=true --context guardDuty=true --context securityHub=true
```

テナント越境の試み（`TenantIsolationViolationAttempt`、API / Web / consumer の拒否点で発行）は `ServiceObservability` のアラームで常時監視し、`docs/runbooks/security-incident.md` へ接続します。

`cdk synth` は新しいリソース型を知らないローカル validator の警告（`F3006 Unknown resource type 'AWS::Lambda::WebFunction'`）を出すが、CloudFormation 側の型は公開済みである（[docs/decision/api-compute-selection.md](docs/decision/api-compute-selection.md) §5.4）。比較の観点・合格条件・費用試算は同ドキュメントと ADR-0006 を参照。

sandbox / development では Lambda authorizer が `Authorization: Bearer <base64url({tenantId,tenantTier,sub})>` を受け付ける（staging / production では JWT authorizer が必須で、sandbox authorizer は synth 時に拒否される）。

## 設計上の主要判断（初期標準）

| 論点                            | 標準                                                                       | 根拠 / ADR                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| サービス粒度                    | bounded context + owner + data + SLO + deploy unit（1 Lambda ≠ 1 service） | AWS SaaS Lens, ProGlove 事例 / ADR-0001                                                              |
| API compute                     | API Gateway HTTP API + Lambda Event Functions（arm64 zip）                 | ADR-0005, ADR-0006, [docs/decision/api-compute-selection.md](docs/decision/api-compute-selection.md) |
| Lambda Web Functions / MicroVMs | experimental profile / 通常 API では禁止                                   | ADR-0006, ADR-0007                                                                                   |
| 非同期                          | EventBridge（サービス間）+ SQS（平準化・backpressure）                     | AWS Builders' Library / ADR-0011                                                                     |
| ワークフロー                    | Step Functions Standard、bounded context 内、補償付き saga                 | ADR-0010                                                                                             |
| データ                          | database-per-service、outbox（DynamoDB Streams）                           | AWS Prescriptive Guidance / ADR-0012                                                                 |
| テナント分離                    | pool 標準、tier 別 queue/concurrency、cell/account は段階導入              | AWS SaaS Lens / ADR-0003, ADR-0004                                                                   |
| 追跡                            | 全 request/event に tenantId・correlationId・causationId、X-Ray は補助     | ADR-0015                                                                                             |
| 同時実行                        | 計測 → 削減 → 保護(reserved) → 平準化(SQS) → 申請 → 隔離(cell)             | ADR-0017                                                                                             |

## 受入基準（v0.1）とその検証手段

| 基準                                                                                              | 検証                                                         |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| owner / SLO / runbook / contracts / ADR の欠落を CI が検出                                        | `ServiceManifest`（synth 失敗）+ ci.yml の metadata ステップ |
| tenant A で tenant B のデータを取得・更新できない                                                 | `tests/tenant-isolation`、repository の条件式テスト          |
| 同一 idempotency key の並行リクエストで副作用が一度だけ                                           | Powertools Idempotency（tenant+key）、`tests/integration`    |
| correlationId で API → Lambda → DynamoDB → EventBridge → SQS → Lambda → Step Functions を全件検索 | envelope に必須、logger が自動付与、access log に requestId  |
| timeout / throttle / poison / DLQ / 補償を試験できる                                              | `tests/resiliency`、worker の simulation hook、saga の Catch |
| reserved concurrency で critical API を保護                                                       | `PavedApiService` route の `reservedConcurrentExecutions`    |
| cdk-nag / policy が public exposure・wildcard IAM・暗号化漏れを拒否                               | `applyPlatformGuardrails`（synth で error）                  |
| `cdk destroy` で production の stateful resource を誤削除しない                                   | `StatefulRetainAspect` + termination protection              |

### デプロイ可能性の検証状況（2026-10-18 時点）

| 段階                                                                         | 状態                  | 証拠                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cdk synth`（sandbox / production / experimentalWeb）                        | 済                    | 5 スタック分の CloudFormation テンプレートと asset を生成。CDK CLI のテンプレート検証は新リソース型 `AWS::Lambda::WebFunction` を未知とする警告のみ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| cfn-lint（AWS 公式リソース仕様に対する静的検証、`--regions ap-northeast-1`） | 済                    | 全テンプレートでエラー 0。警告は CDK が生成する冗長 `DependsOn`（W3005）のみ。`AWS::Lambda::WebFunction*` も仕様として認識される                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cdk deploy` を実アカウント（ap-northeast-1、sandbox）へ                     | 済（2026-10-17）      | `pnpm deploy:sandbox` で platform / order / worker / workflow の4スタックが CREATE_COMPLETE（専用 bootstrap qualifier `paas` = `CDKToolkit-paas`。同一アカウントの他システムの bootstrap には触れない。1 回の full deploy は約 7 分）。初回デプロイで見つかり修正した実環境固有の問題: CloudWatch metric math の `MAX([...])` 非対応、HTTP API access log の `$context.xrayTraceId` 非対応、新規アカウントの Lambda 同時実行 quota 10（reserved concurrency を production 限定に）、API Gateway requestId（`=` を含む）が correlationId パターンに不一致                                                                                 |
| 実機 E2E（`tests/integration` 3件、`tests/tenant-isolation` 3件）            | 済（全件 pass、2 回） | 同一 Idempotency-Key の並行5リクエストで副作用1回、payload 差し替えは 409、tenant B は tenant A の order を取得不可（404）、偽装ヘッダ・他テナント cursor は拒否。2026-10-17 と 2026-10-18（再デプロイ後）の 2 回 pass                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 負荷試験（k6 2.3.0、`tests/performance/order-api.k6.js`）                    | 済（2026-10-17）      | steady 30 RPS × 3 分 + overload 30→150 RPS（計 25,200 req）。steady 失敗率 0.03%、client p50 63.4 / p95 73.6 / **p99 91.5 ms**（threshold `p(99)<500` pass）。overload では 28.5% が 429（stage throttle）/ 503（Lambda quota 10）で throttle されたが成功リクエストの latency は不変（goodput 維持）。アカウントの Lambda quota 10 下の値であり production の性能値ではない。`tests/performance/results/order-api-2026-10-18.*` と同ディレクトリの README                                                                                                                                                                               |
| Lambda Power Tuning（`ApiFnListOrders`、arm64）                              | 済（2026-10-18）      | SAR の power tuning state machine で 768〜3008 MB を各 30 回、`balanced` 推奨は **1536 MB**（avg 10.47 ms、2.448e-7 USD/inv。1024 MB は 12.98 ms / 1.904e-7）。256 / 512 MB は power tuning の log parser が JSON log を誤判定して失敗（ツール制約として記録）。`tools/power-tuning/results/*-1792277941831.json`                                                                                                                                                                                                                                                                                                                        |
| cold start / memory（`ApiFnCreateOrder`、Logs Insights）                     | 済（2026-10-17）      | k6 窓で 18,019 invocations 中 cold start 9 件（0.05%）、`Init Duration` p50 363 / p99 488 ms、warm p50 38.7 / p99 79.1 ms、max memory 203 MB / 1024 MB（bundle 約 0.94 MB）。この負荷では Provisioned Concurrency 不要。ADR-0008 / ADR-0016 の実測小節                                                                                                                                                                                                                                                                                                                                                                                   |
| Workflow game day（provisioning saga、補償 / transient retry）               | 済（2026-10-18）      | `tenant.provisioning-requested.v1` × 3: 正常 SUCCEEDED 3.9 秒、恒久失敗（`cell-full`）は補償 ReleaseTenantSlot → PublishFailed 経由で FAILED 3.5 秒・slot 削除、一時失敗（`cell-flaky`）は `TRANSIENT_RETRY` 4 回で SUCCEEDED 24.4 秒。ADR-0010 の実測小節                                                                                                                                                                                                                                                                                                                                                                               |
| end-to-end 整合性（負荷試験後）                                              | 済（2026-10-17）      | 作成された 18,014 件の order がすべて `FULFILLED`（CREATED 0 / FAILED 0）、OUTBOX 残 0、DLQ 8 本すべて 0 件、全 Lambda errors 0。throttle 3,728 件を SQS 再配信 + partial batch failure で吸収。発火した alarm は ThrottlesAlarm × 4（CreateOrder / OutboxRelay / FulfillPremiumConsumer / SandboxAuthorizer）                                                                                                                                                                                                                                                                                                                           |
| 公式 cdk2d2 によるデプロイ状態図                                             | 済（4スタック）       | `pnpm diagrams:deployed --stack <name>` → `docs/architecture/diagrams/deployed/*.svg`（CloudFormation の作成状態で色分け、`d2 --layout=tala` で描画）。cdk2d2 v0.2.0 は現行 CDK の nested assembly / 別ファイル metadata を読めないため、互換 assembly を生成して渡す                                                                                                                                                                                                                                                                                                                                                                    |
| 検証後の後始末                                                               | sandbox 常時稼働      | 2026-10-17 の初回検証後は `cdk destroy` + CDKToolkit 削除でゼロに戻したが、2026-10-18 に再デプロイし、**sandbox は稼働したまま維持する**（課金はユーザー承認済み、2026-10-18）。固定費の見積り: CloudWatch alarm 57 本 ≈ **$5.7/月**（$0.10 / alarm）、dashboard 3 枚は無料枠（3 枚まで）内、Lambda / DynamoDB on-demand / SQS / EventBridge / Step Functions は idle 時の課金なし（KMS CMK、Contributor Insights は sandbox から除外済み）。bootstrap は専用 qualifier の `CDKToolkit-paas`（専用 S3 bucket）で、他システムの `CDKToolkit` とは独立。撤去するときは `cdk destroy` の後に `CDKToolkit-paas` と その S3 bucket を削除する |

## ドキュメント

- [docs/microservice-guidelines.md](docs/microservice-guidelines.md) — 設計指針書（全 20 章、エビデンス台帳付き）
- [docs/microservice-guidelines-resilience-security.md](docs/microservice-guidelines-resilience-security.md) — 第21章 破壊と再生・侵入耐性（Chaos / FIS、影響範囲の限定、GuardDuty・CloudTrail による侵入検出、トレーサビリティ、AI 時代の攻撃への追加策）と [security-incident runbook](docs/runbooks/security-incident.md)
- [docs/adr/](docs/adr/README.md) — ADR-0001〜0020
- [docs/decision/](docs/decision/) — 要件→アーキテクチャの質問票、決定木、技術選定根拠、API compute 比較、[最新技術での再検討](docs/decision/latest-tech-reassessment.md)（Bun、API Gateway 非経由、ログ一本化、ローカル仮想環境）
- [docs/review/](docs/review/README.md) — 要求仕様書 / 設計指針書 / 設計書 / リポジトリのレビューチェックリスト、アンチパターン集
- [docs/architecture/](docs/architecture/overview.md) — 構成図（D2 ソースと生成 SVG）、workload profile
- [docs/runbooks/](docs/runbooks/)、[docs/threat-models/](docs/threat-models/)

## ライセンス / 出典

テンプレート自体は MIT。引用している AWS ドキュメント・各社技術ブログの著作権は各社に帰属する。出典一覧は指針書末尾の References と各 ADR の「参考」を参照。
