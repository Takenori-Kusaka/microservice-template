# ADR-0001: Microservice boundary definition

- Status: accepted
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0002, ADR-0010, ADR-0011, ADR-0012, ADR-0019

## Context

本テンプレートは B2B マルチテナント PaaS を TypeScript / Node.js 22 / AWS CDK v2 で構築するための golden path である。サーバレスでは「Lambda 関数 1 つ」を安易にマイクロサービスと呼びがちで、その結果として次の問題が繰り返し起きる。

- 関数単位でリポジトリ・パイプライン・ダッシュボードが分裂し、所有者が不明になる。AWS Operational Excellence Pillar は、アプリケーション、ワークロード、プラットフォーム、インフラごとに所有者を特定することを求めている。[^11]
- 関数同士が同じ DynamoDB テーブルを直接読み書きし、データの正本が曖昧になる。AWS Prescriptive Guidance の database-per-service パターンは、各データストアを外部サービスから直接アクセスさせないことを前提とする。[^18]
- SLO を定義できる単位がなく、アラームが「関数のエラー率」止まりになる。
- 同期呼び出しチェーンが深くなり、分散モノリスになる。

ProGlove の大規模サーバレス SaaS では、1 マイクロサービスを 5〜15 個の Lambda、Step Functions、EventBridge、DynamoDB を束ねた CloudFormation スタックとして運用しており、「1 Lambda = 1 マイクロサービス」ではない。[^3] AWS SaaS Lens も「各マイクロサービスによるデータ所有」を前提としている。[^1][^2] AWS Prescriptive Guidance は、マイクロサービスを技術層ではなく業務上の bounded context で分け、明確な契約を介して連携することを推奨している。[^15][^16]

## Decision

準拠: AWS Well-Architected Operational Excellence Pillar（所有者の特定）[^11]、AWS SaaS Lens（サービス単位のデータ所有）[^1][^2]、AWS Prescriptive Guidance「Decomposing monoliths into microservices」（bounded context）[^16]、ProGlove の運用事例（スタック = サービス）[^3]

マイクロサービスの単位を、次の 5 要素を **すべて共有する** 単位として定義する。

| 要素                       | 定義                                     | 根拠                                                                                             | テンプレートでの表現                            |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| 業務能力 (bounded context) | 単一のサブドメインとそのモデル           | Prescriptive Guidance: 「各サブドメインはモデルを持ち、そのモデルの範囲が bounded context」[^16] | `apps/<service>/src/domain/`                    |
| 所有チーム                 | 単一の運用所有者と on-call               | OpEx Pillar: ワークロードごとの所有者特定[^11]                                                   | `ServiceManifest` の `ownerTeam`, `onCall`      |
| データ正本                 | サービスだけが書き込める datastore       | database-per-service[^18]                                                                        | `TenantAwareTable` を service stack 内に所有    |
| SLO                        | 成功率と p50/p95/p99 latency の目標      | AWS DevOps Guidance: percentile による SLO[^35]                                                  | `ServiceManifest.slo` と `ServiceObservability` |
| デプロイ単位               | 独立して synth / deploy できる CDK stack | ProGlove: 1 サービス = 1 CloudFormation スタック[^3]                                             | `apps/<service>/cdk/` の Service Stack          |

Function はサービス内部の計算・イベント処理単位であり、マイクロサービスと同義ではない。`apps/example-order-service` は HTTP API 用 Lambda、JWT authorizer、outbox relay Lambda、DynamoDB テーブルを 1 つの Service Stack に持つ。これが「サービス」の最小例である。

サービス候補は、ガイドライン ch.4 の 6 軸（業務能力、データ正本、変更頻度、スケール/隔離要件、セキュリティ境界、認知負荷）で評価し、所有チーム、データライフサイクル、スケール特性、セキュリティ区分、SLO、リリース頻度、障害波及範囲のうち **2 つ以上に明確な差** がある場合のみ分割候補とする。逆に常に同時変更される、同じトランザクションとデータを共有する、個別 SLO を定義できない場合は統合を優先する。既定値（例示値）: 「2 軸以上」。1 軸だけの差で分割すると分散トランザクションと同期チェーンが増えるため 2 軸を下限とした設計判断で、外部文献に基づく数値ではない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-01、四半期レビューで分割・統合の判断履歴から見直す）。

必須ルール:

- 他サービスの DynamoDB テーブル、S3 プレフィックス、DB を直接読まない。[^18]
- 同期呼び出しチェーンは 3 ホップ以内。超過時は API composition、read model、非同期化を検討する。[^17][^18] 既定値（例示値）: 3 ホップ。ADR-0016 の入口 p99 600 ms を 4 段以上に配賦すると段当たり予算が 100 ms 台になるため 3 を上限とした設計判断で、外部出典に数値はない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-02、slo-baseline 計測 M-17 の段別 latency をもとに次回レビューで見直す）。
- 共通ライブラリ（`@paas/runtime-context`, `@paas/observability` など）に業務ロジックを置かない。SaaS Lens は共通ライブラリの対象を tenant context、logging、metrics などの横断関心に限定している。[^12]
- 「1 エンドポイント = 1 リポジトリ」「1 関数 = 1 サービス」を標準にしない。[^3]

## Alternatives

### A. Function-as-a-service 境界（1 Lambda = 1 サービス）

- 長所: デプロイが極小で、関数ごとの IAM とスケールが明確。
- 短所: 所有者・SLO・データ所有権を関数単位で管理できない。数十関数で catalog と dashboard が破綻し、関数間でテーブルを共有しやすい。ProGlove は約 100 万 Lambda を 40 マイクロサービスとして運用しており、関数単位の境界は採っていない。[^3]

### B. 技術層による分割（API 層サービス、DB 層サービス、通知層サービス）

- 長所: 技術スキルごとにチームを分けやすい。
- 短所: 1 つの業務変更が全層に波及し、独立リリースできない。AWS Prescriptive Guidance はマイクロサービスをビジネス機能（サブドメイン）で分けることを推奨しており、技術層での分割はその構造に反する。[^15][^16]

### C. モジュラーモノリス（単一 Service Stack に全ドメイン）

- 長所: 初期開発が最速で、トランザクション境界が単純。
- 短所: 独立スケール・障害隔離・チーム別デプロイができない。中規模 PaaS で複数チームが並行開発する前提に合わない。ただし単一チーム・単一ドメインの初期フェーズでは本案を選び、分割判定を満たした時点で分割することを認める。

## Consequences

- **費用**: サービスごとに API Gateway、テーブル、アラーム、dashboard が生じるため、極小サービスの乱立は固定費を増やす。分割判定の「2 軸以上」ルールで抑制する。
- **性能**: サービス間は API/イベント経由となり、直接テーブル参照より遅延が増える。3 ホップ制限と read model で緩和する。[^17]
- **運用**: `ServiceManifest` の必須項目（`serviceId`, `ownerTeam`, `onCall`, `slo`, `runbook` など）が揃わないサービスはデプロイできない。所有者不明サービスが生まれない。[^11]
- **Lock-in**: 境界定義自体は AWS 非依存。Service Stack の実装は CDK に依存する。
- **移行**: 既存モノリスからの移行時は、まずデータ正本と所有者を決め、次に契約を切り出す順序を取る。AWS Prescriptive Guidance の database decomposition も、境界・データフロー・interface の明確化を先行させることを推奨する。[^53]

## Evidence

- ProGlove 事例: 40 マイクロサービス、約 100 万 Lambda を「スタック = サービス」で運用。[^3][^7]
- AWS SaaS Lens: サービスごとにデータ所有と isolation model を決める構造。[^1][^2]
- 成功指標は DORA の指標（deployment frequency、change lead time、change fail rate、failed deployment recovery time）を採用する。[^108]
- 本テンプレートの受入基準「新規サービスが 15 分以内に生成され sandbox へ自動デプロイできる」は、Service Stack を単位として `pnpm create-service` で生成することで検証する（既定値（例示値）: 15 分。1 回の PR サイクルで終わる長さとして置いた目標値で外部出典に基づかない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-03）。計測で確定: 所要時間は GitHub Actions の `deploy ephemeral` job duration で取得する（M-01、2026-10-17 時点は未計測）。）
- 四半期の architecture/conformance レビューで、3 ホップ超過と他サービステーブル直接参照の件数を計測し、ゼロを維持する。

## Compliance / How it is enforced

- `@paas/constructs` の `ServiceManifest` が `serviceId`, `domain`, `ownerTeam`, `onCall`, `repository`, `dataClassification`, `tenantIsolationModel`, `slo`, `runbook`, `costCenter` を必須プロパティとし、欠落時は synth で例外を投げる。
- `PlatformGuardrails` Aspect が、Service Stack 外の DynamoDB テーブル ARN を参照する IAM policy を検出して synth を失敗させる。
- CI の `policy` ステップで `catalog-info.yaml` と `ServiceManifest` の整合を検査する。
- `CODEOWNERS` で `apps/<service>/` を `ownerTeam` に対応付け、所有者外の変更にはレビューを必須化する。[^114]
- 四半期レビューで本 ADR の分割判定基準を再評価する。

## 参考

[^1]: [Serverless SaaS - SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/serverless-saas.html)（指針書 References より）

[^2]: [SaaS Lens - AWS Well-Architected Framework](https://docs.aws.amazon.com/ja_jp/wellarchitected/latest/saas-lens/wellarchitected-saas-lens.pdf)（指針書 References より）

[^3]: [Lessons learned from scaling to 1 million Lambda functions](https://aws.amazon.com/blogs/architecture/lessons-learned-from-scaling-to-1-million-lambda-functions/)（指針書 References より）

[^7]: [6000 AWS accounts, three people, one platform](https://aws.amazon.com/blogs/architecture/6000-aws-accounts-three-people-one-platform-lessons-learned/)（指針書 References より）

[^11]: [Operational Excellence Pillar - AWS Well-Architected Framework](https://docs.aws.amazon.com/pdfs/wellarchitected/latest/operational-excellence-pillar/wellarchitected-operational-excellence-pillar.pdf)（指針書 References より）

[^12]: [Multi-tenant microservices - SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/multi-tenant-microservices.html)（指針書 References より）

[^15]: [Micro-frontends on AWS (Prescriptive Guidance)](https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/micro-frontends-aws/micro-frontends-aws.pdf)（指針書 References より）

[^16]: [Decomposing monoliths into microservices (Prescriptive Guidance)](https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/modernization-decomposing-monoliths/modernization-decomposing-monoliths.pdf)（指針書 References より）

[^17]: [Enabling data persistence in microservices (Prescriptive Guidance)](https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/modernization-data-persistence/modernization-data-persistence.pdf)（指針書 References より）

[^18]: [Database-per-service pattern (Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-data-persistence/database-per-service.md)（指針書 References より）

[^35]: [[O.SI.5] Set and monitor service level objectives against performance standards](https://docs.aws.amazon.com/wellarchitected/latest/devops-guidance/o.si.5-set-and-monitor-service-level-objectives-against-performance-standards.html)（指針書 References より）

[^53]: [AWS Prescriptive Guidance - Database decomposition on AWS](https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/database-decomposition/database-decomposition.pdf)（指針書 References より）

[^108]: [DORA's software delivery metrics: the four keys](https://dora.dev/guides/dora-metrics-four-keys/)（参照日 2026-10-17。現行版は deployment rework rate を加えた 5 指標、MTTR は failed deployment recovery time に置換）

[^114]: [About code owners - GitHub Docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)（参照日 2026-10-17。本文確認済み: CODEOWNERS は `.github/`、リポジトリルート、`docs/` のいずれかに置き、PR 作成時に code owner へ自動でレビュー依頼され、branch protection の「Require review from Code Owners」で承認を必須化できる）
