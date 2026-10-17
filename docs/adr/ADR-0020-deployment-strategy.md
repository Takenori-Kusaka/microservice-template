# ADR-0020: Deployment strategy

- Status: accepted
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0002, ADR-0003, ADR-0006, ADR-0012, ADR-0013, ADR-0016, ADR-0019

## Context

Amazon の継続的デリバリーでは、サービスを所有するチームがテストに高い基準を置き、可用性を速度より優先し、load / security test をパイプラインへ入れ、段階的に本番へ展開している。[^52] DORA は deployment frequency、change lead time、change fail rate、failed deployment recovery time（旧 MTTR）を配信性能の指標としている。[^108]

本 PaaS では、複数サービスが独立にデプロイされ、production は別アカウント（ADR-0003）にある。デプロイ戦略を統一しないと、サービスごとに rollback 手順が異なり、契約の breaking change が consumer を壊し、DB migration が後方互換を失う。

ランタイム別の progressive delivery 手段（参照日 2026-10-17）:

- Lambda Event Functions: alias は version へのポインタで、2 version 間の重み付き routing ができる。[^107] CodeDeploy の `LambdaDeploymentConfig` には `CANARY_10PERCENT_5MINUTES`（10% を先行、5 分後に残り 90%）、`LINEAR_10PERCENT_EVERY_1MINUTE` などの既定構成がある。[^106] Provisioned Concurrency は alias / version にのみ設定できる。[^74]
- Lambda Web Functions: endpoint の `autoDeploymentMode` を `Disabled` にし、`revisionWeights`（最大 2 revision、重み合計 100）で canary / blue-green / rollback を行う。AWS は production では `Disabled`、development / staging では `LatestRevision` を推奨している。metrics に revision dimension がないため、canary の判定はアプリ側のログ / custom metric に revision 識別子を含めて行う。[^67]
- API Gateway: canary release deployment は REST API のみ。HTTP API は automatic deployment を持つ。[^61]

schema 変更の後方互換は expand / migrate / contract（Parallel Change）で保つ。[^83]

## Decision

準拠: Amazon Builders' Library「Going faster with continuous delivery」[^52]、DORA metrics[^108]、AWS Lambda Developer Guide（alias、provisioned concurrency）[^107][^74]、AWS CDK `LambdaDeploymentConfig`[^106]、Lambda Web Functions deployment patterns[^67]、AWS Organizations SCP[^94]、Danilo Sato「ParallelChange」[^83]

### 標準 pipeline

```text
format → lint → typecheck → unit → contract → synth → policy → deploy ephemeral → integration → load smoke → canary → promote
```

| ステップ                  | 内容                                                                                                                                                                               | 失敗時        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| format / lint / typecheck | prettier、eslint（`paas/*` ルール含む）、tsc                                                                                                                                       | PR をブロック |
| unit                      | vitest（domain / application、Construct snapshot、guardrails）                                                                                                                     | PR をブロック |
| contract                  | OpenAPI 3.1[^109] / event schema の breaking change 検出、provider / consumer contract test                                                                                        | PR をブロック |
| synth                     | 全対象 stack の `cdk synth`、esbuild metafile 出力                                                                                                                                 | PR をブロック |
| policy                    | `PlatformGuardrails`、cdk-nag[^104]、`ServiceManifest` / `catalog-info.yaml` 整合、ADR 参照、quota 予算、ランタイム deprecation[^70]                                               | PR をブロック |
| deploy ephemeral          | sandbox アカウントへ PR 単位の ephemeral stack をデプロイ                                                                                                                          | PR をブロック |
| integration               | 実 AWS managed service に対する integration、tenant isolation、idempotency、correlation-search、resiliency test[^52]                                                               | PR をブロック |
| load smoke                | 1 分 10 RPS、p99 が SLO の 2 倍以内（既定値（例示値）: cold start 混在でも退行を検出する最小負荷として置いた設計判断。調整: TD-24。計測で確定: 初回 smoke 結果 M-20、未計測）[^52] | PR をブロック |
| canary                    | development → staging → production の順に alias weighted routing で 10% → 100%（`CANARY_10PERCENT_5MINUTES` 既定）[^106]、各段で SLO alarm を監視                                  | 自動 rollback |
| promote                   | 同一 artifact を次環境へ昇格                                                                                                                                                       | 停止          |

### ルール

- Lambda artifact と CDK asset を **一度だけ build** し、環境間で同一 artifact（同一 asset hash）を promote する。環境ごとの再 build を禁止する。
- progressive delivery はランタイムに合わせる。Event Functions は Lambda alias + CodeDeploy weighted routing（`PavedApiService` / `PavedQueueConsumer` / `PavedWorkflow` が自動設定）[^107][^106]、Web Functions は `autoDeploymentMode: Disabled` + `revisionWeights`[^67]、API Gateway HTTP API は stage variable で alias を参照する。
- canary 中の自動 rollback 条件は、`ServiceObservability` の SLO alarm（availability、p99 latency、burn rate）と `Throttles` alarm[^75]とする。
- DB / schema migration は expand / migrate / contract で後方互換を保つ。[^83] 1 回のデプロイで expand と contract を同時に行わない。
- rollback 不能な state change（データ変換、イベント version 切替）には roll-forward と reconciliation 手順を用意し、runbook に記載する。
- OpenAPI / event schema の breaking change は新 version + consumer 移行期間（ADR-0013）で扱い、pipeline が breaking change を検出したら ADR 参照なしには通さない。
- security（cdk-nag、dependency audit）、load（smoke）、tenant isolation test を pipeline に組み込む。[^52]
- production への deploy は shared-services アカウントの pipeline role 経由のみ。手動 `cdk deploy` は sandbox に限る。SCP で production アカウントの CloudFormation 操作を pipeline role に限定する。[^94]
- deployment marker（`deploymentVersion` = git SHA + alias version または Web Functions revision ID[^67]）を logs / metrics / traces へ付与し、dashboard に deploy イベントを表示する。
- DORA 指標（deployment frequency、change lead time、change fail rate、failed deployment recovery time）[^108]を deployment marker と rollback イベントから算出し、月次で記録する。

## Alternatives

### A. 全環境へ一括 deploy（canary なし）

- 長所: pipeline が短く、デプロイが速い。
- 短所: 不具合が全テナントへ即時波及する。Amazon の CD 実践（段階的展開と可用性優先）に反する。[^52]

### B. blue / green（stack 全体を複製して切替）

- 長所: rollback が DNS / stage 切替だけで即時。
- 短所: stateful resource（DynamoDB）を複製できず、サーバレス stack では alias weighted routing[^107]の方が安価で細かい。stack 複製は cell 分割（ADR-0003）の手段として別途使う。Web Functions では revision weight による blue-green が AWS の公式パターンとして用意されている。[^67]

### C. feature flag のみで段階公開し、デプロイは一括

- 長所: コードパスの切替が細かく、デプロイ回数を減らせる。
- 短所: インフラ変更（IAM、テーブル、queue）は flag で守れない。feature flag は alias canary の補完として使う。

## Consequences

- **費用**: ephemeral stack と staging の load smoke で CI 費用が増える。ephemeral stack は PR close 時に自動削除する。
- **性能**: canary 中は 2 version が共存するため、alias 切替の数分間は warm 環境が分散し cold start がわずかに増える見込み（公式ドキュメントに記載なし（確認日 2026-10-17）。計測で確定: `tests/resiliency/canary-rollback/` で `Init Duration` の件数を記録する。docs/decision/template-defaults.md#計測で確定する項目 M-21、現在は未計測）。Provisioned Concurrency は alias に設定されているため新 version にも適用される。[^74]
- **運用**: 自動 rollback により on-call の初動が「rollback 済みの原因調査」になる。roll-forward 専用の変更は runbook 記載と承認が必要。
- **Lock-in**: CodeDeploy と Lambda alias は AWS 固有。pipeline 定義は GitHub Actions で、CDK Pipelines への移行も可能。
- **移行**: 既存サービスを本 pipeline へ乗せる際は、まず contract と policy を通し、次に canary を有効化する。

## Evidence

- Builders' Library: 継続的デリバリーにおける test の重視と段階的展開。[^52]
- Spotify: テンプレートでデプロイと所有情報を自動生成。[^9]
- CodeDeploy の Lambda canary 構成と alias routing。[^106][^107]
- Web Functions の canary / rollback パターンと revision dimension の制約。[^67]
- 受入基準「owner、SLO、runbook、contracts、ADR の欠落を CI が検出する」を `policy` ステップの test で検証する。
- 受入基準「新規サービスが 15 分以内に生成され、sandbox へ自動デプロイできる」を `pnpm create-service` → PR → `deploy ephemeral` の所要時間で計測する（既定値（例示値）: 15 分。1 回の PR サイクルで終わる長さとして置いた目標値で外部出典に基づかない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-03）。計測で確定: GitHub Actions の `deploy ephemeral` job duration で取得する（M-01、2026-10-17 は手動 `pnpm deploy:sandbox` で 4 stacks をデプロイしたが所要時間は未記録）。）
- `tests/resiliency/canary-rollback/` で、意図的に 5xx を 20% 返す version を canary deploy し、10% 段階で alarm が発火して自動 rollback され、全体の成功率が 99% を下回らないことを staging で確認する（既定値（例示値）: 5xx 20% / 10% 段階 / 成功率 99%。`CANARY_10PERCENT_5MINUTES` の 10% 段階で 10% × 20% = 2% の失敗が alarm を発火させ、全体で 99% を維持できることを確認する設計で、外部出典に基づかない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-25）。計測で確定: staging での初回試験結果 M-21、現在は未計測・試験ディレクトリ未作成。）
- change fail rate と failed deployment recovery time を deployment marker から算出し、月次で記録する。[^108]

## Compliance / How it is enforced

- `.github/workflows/service-pipeline.yml` を `pnpm create-service` が生成し、ステップの削除は CI の `policy` ステップ（workflow lint）で検出する。
- `PavedApiService` / `PavedQueueConsumer` / `PavedWorkflow` が Lambda alias[^107]、CodeDeploy deployment group（`LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES` 既定）[^106]、rollback alarm を自動設定し、production Stage で無効化できない。
- `PlatformGuardrails` が production Stage で alias なしの `$LATEST` 参照を検出して synth を失敗させる。Provisioned Concurrency は `$LATEST` に設定できないため[^74]、この検査は同時に Provisioned Concurrency の前提も保証する。
- Web Functions を含む stack では、production Stage の endpoint が `autoDeploymentMode: Disabled` であることを `PlatformGuardrails` が検査する。[^67]
- CI の `contract` ステップで `schemas/openapi/` と `schemas/events/` の breaking change を検出し、ADR 参照のない PR を失敗させる。
- `ObservableFunction` が `deploymentVersion` 環境変数を注入し、`@paas/observability` がログ / metric / trace annotation に付与する。
- SCP で production アカウントへの pipeline role 以外からの `cloudformation:CreateStack` / `UpdateStack` を拒否する。[^94]
- migration script は `apps/<service>/migrations/` に expand / contract を別ファイルで置き、同一 PR に両方が含まれる場合は `policy` ステップで失敗させる。[^83]

## 参考

[^9]: [What the Heck is Backstage Anyway? | Spotify Engineering](https://engineering.atspotify.com/2020/3/what-the-heck-is-backstage-anyway)（指針書 References より）

[^52]: [Going faster with continuous delivery](https://aws.amazon.com/builders-library/going-faster-with-continuous-delivery/)（指針書 References より）

[^61]: [Choose between REST APIs and HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html)（参照日 2026-10-17）

[^67]: [Deployment patterns (Lambda Web Functions)](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-deployment.html)（参照日 2026-10-17）

[^70]: [Lambda Event Function runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html)（参照日 2026-10-17）

[^74]: [Configuring provisioned concurrency for an Event Function](https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html)（参照日 2026-10-17）

[^75]: [Types of metrics for Lambda Event Functions](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html)（参照日 2026-10-17）

[^83]: [ParallelChange (expand / contract) - Danilo Sato, martinfowler.com](https://martinfowler.com/bliki/ParallelChange.html)（参照日 2026-10-17）

[^94]: [Service control policies (SCPs)](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)（参照日 2026-10-17）

[^104]: [cdk-nag (GitHub, cdklabs)](https://github.com/cdklabs/cdk-nag)（参照日 2026-10-17）

[^106]: [aws-cdk-lib.aws_codedeploy.LambdaDeploymentConfig](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_codedeploy.LambdaDeploymentConfig.html)（参照日 2026-10-17）

[^107]: [Create an alias for a Lambda Event Function](https://docs.aws.amazon.com/lambda/latest/dg/configuration-aliases.html)（参照日 2026-10-17）

[^108]: [DORA's software delivery metrics: the four keys](https://dora.dev/guides/dora-metrics-four-keys/)（参照日 2026-10-17）

[^109]: [OpenAPI Specification v3.1.0](https://spec.openapis.org/oas/v3.1.0)（参照日 2026-10-17）
