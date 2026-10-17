# ADR-0003: Multi-account topology

- Status: accepted
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0004, ADR-0017, ADR-0018, ADR-0020

## Context

AWS Well-Architected Security Pillar SEC01-BP01 は、production / development / test などの環境とワークロードをアカウントで分離することを「強く推奨」し、アカウントをセキュリティ・請求・アクセスの強い分離境界と位置づけている。[^92] AWS の whitepaper「Organizing Your AWS Environment Using Multiple Accounts」は、複数アカウントの利点として、環境別のセキュリティ統制、障害影響範囲の限定、費用管理、Service Quotas と API レート制限の分散を挙げている。[^93]

本 PaaS は sandbox / development / staging / production の 4 環境を持ち、production を他環境と同一アカウントに置くと、次のリスクが発生する。

- 開発者の IAM 権限が production データへ到達しうる。[^92]
- non-prod の負荷試験が production と同じ Lambda 同時実行上限（既定 1,000 / リージョン）を消費する。[^42] さらに新規 AWS アカウントは Lambda Functions / MicroVMs の同時実行・メモリ quota、Web Functions の vCPU・request rate quota が縮小された状態で開始され、利用実績に応じて自動的に引き上げられる。[^42]
- 費用が環境別に分離できず、ADR-0018 の cost attribution が成り立たない。アカウントは AWS 費用配賦の既定単位である。[^93]

ProGlove は数千 AWS アカウントでアカウント境界をセキュリティ、所有権、費用、Service Quotas の分離に利用している。[^3][^7] ただし本 PaaS は中規模であり、account-per-tenant を最初から強制するのは運用自動化が追いつかない。ガイドライン ch.5 の推奨段階に従い、Phase 1 は環境別アカウント、Phase 2 で cell 別、Phase 3 で規制・大口テナントのみ silo アカウントとする。

## Decision

準拠: AWS Well-Architected Security Pillar SEC01-BP01[^92]、AWS whitepaper「Organizing Your AWS Environment Using Multiple Accounts」[^93]、AWS Organizations SCP[^94]、AWS Well-Architected「Reducing scope of impact with cell-based architecture」[^14]、ProGlove の運用事例[^3][^7]

次のアカウント構成を初期標準とする。

| アカウント          | 用途                                                                           | Stage (CDK)                       | 備考                                                            |
| ------------------- | ------------------------------------------------------------------------------ | --------------------------------- | --------------------------------------------------------------- |
| `management`        | AWS Organizations、SCP、account vending                                        | なし                              | 人手運用のみ。SCP は management アカウントには適用されない[^94] |
| `shared-services`   | CI/CD pipeline、artifact bucket、ECR、集中 observability（monitoring account） | `PipelineStage`                   | 全環境へ cross-account deploy                                   |
| `sandbox`           | 開発者個人の ephemeral stack                                                   | `EnvironmentStage('sandbox')`     | whitepaper の sandbox account 相当[^93]。自動削除、quota 小     |
| `development`       | 共有開発環境、integration test                                                 | `EnvironmentStage('development')` |                                                                 |
| `staging`           | 本番相当、load test、chaos test                                                | `EnvironmentStage('staging')`     | production と同一構成                                           |
| `production`        | 本番 data plane + control plane                                                | `EnvironmentStage('production')`  | **別アカウント必須**[^92]                                       |
| `production-cell-N` | Phase 2 以降の cell 別アカウント                                               | `CellStage`                       | cell router は production に残す。cell は状態を共有しない[^14]  |
| `tenant-<id>`       | Phase 3 の silo テナント                                                       | `CellStage`                       | ADR-0004 の昇格条件を満たす場合のみ                             |

ルール:

- production は専用アカウントとし、`apps/platform-cdk` の `EnvironmentStage('production')` 以外から production アカウント ID を参照することを禁止する。
- control plane（tenant registry、onboarding、cell router）と data plane（サービス群）は同一アカウント内で別 stack とし、Phase 2 で data plane を cell アカウントへ分割できるようにする。
- アカウント追加は quota 迂回のために行わず、必ず cell / tenant isolation 境界と account factory（AWS Control Tower Account Factory または同等の自動化）による自動化を伴わせる。[^92][^3]
- 全アカウントに標準タグ（`Environment`, `CellId`, `ServiceId`, `CostCenter`）を `PlatformGuardrails` で付与し、cost allocation tag として有効化する。[^111] shared-services アカウントを CloudWatch cross-account observability の monitoring account とし、metrics / logs / traces / Application Signals を集約する。[^95]
- SCP で非 production アカウントからの production 操作と、production での stateful resource 削除を拒否する。SCP は権限を付与せず上限を定めるものであり、IAM policy と併用する。[^94]
- production アカウント作成直後に Lambda 同時実行 quota の引き上げを申請する。新規アカウントの quota は縮小されているため、負荷試験前に申請が必要である。[^42]
- リージョンは単一リージョンを標準とし、multi-region は事業要件とデータ整合性が許す場合だけ ADR を起票する。

## Alternatives

### A. 単一アカウント、環境は stack 名プレフィックスで分離

- 長所: セットアップが最も簡単で cross-account 権限が不要。
- 短所: IAM の誤設定 1 つで production データへ到達可能。SEC01-BP01 が「High」リスクとして挙げる anti-pattern（感度の異なるワークロードの同居）に該当する。[^92] Lambda 同時実行、API Gateway throttle（アカウント・リージョン当たり既定 10,000 RPS）[^62]などの quota を全環境で奪い合う。本 PaaS では採用しない。

### B. 最初から account-per-tenant

- 長所: テナント間のセキュリティ・quota・費用分離が最も明確。[^7]
- 短所: tenant 数 × 環境数のアカウントを vending し、StackSets と集中観測を自前で構築する必要がある。ProGlove はこれを 3 人で運用できるまで自動化に投資しているが、本 PaaS の初期規模では過剰。Phase 3 で上位 tier のみ適用する。

### C. 環境別アカウントのみで cell 分割を行わない

- 長所: 構成が単純。
- 短所: production 内の障害範囲と quota が全テナントで共有される。Phase 1 の標準としてはこれを採用し、Phase 2 で cell を導入できるよう `CellStage` の抽象を最初から用意する。

## Consequences

- **費用**: アカウント自体は無料だが、shared-services、observability 集約、cross-account デプロイロールの運用コストが発生する。cross-account observability は logs / metrics / Application Signals に追加費用がなく、trace は最初の 1 コピーが無料である。[^95] cost attribution は環境単位で自動的に成立する。[^93]
- **性能**: cross-account observability の集約による遅延は公式ドキュメントに記載がない（確認日 2026-10-17）。[^v1] logs / metrics の共有に追加費用はない。dashboard の体感遅延は Phase 1 の運用で観測し、問題があれば本 ADR を改訂する。
- **運用**: account factory、SCP、standard tag を platform-team が所有する。開発者は sandbox アカウントで `cdk deploy` し、production へは pipeline 経由のみ。
- **Lock-in**: AWS Organizations と CDK Pipelines の cross-account bootstrap に依存する。
- **移行**: Phase 2 で production data plane を cell アカウントへ移す際、tenant migration と cell router の切替手順が必要となる。ADR-0004 で定義する。

## Evidence

- Lambda の同時実行上限はアカウント × リージョン単位で既定 1,000、数万規模まで引き上げ可能。新規アカウントは縮小 quota で開始する。[^42]
- API Gateway のアカウント・リージョン当たり throttle は既定 10,000 RPS、burst 5,000（一部リージョンは 2,500 / 1,250）。[^62]
- ProGlove: アカウント境界が Lambda concurrency や API Gateway throttle も分離した事例。[^3]
- cell-based architecture の FAQ: cell は状態を共有せず自己完結させる。[^14]
- 受入基準「`cdk destroy` 時に stateful production resource を誤削除しない」を production アカウントの termination protection と SCP で検証する。

## Compliance / How it is enforced

- `apps/platform-cdk` の `EnvironmentStage` が環境名からアカウント ID を解決し、production 以外の Stage に production アカウント ID を渡すと synth で失敗する。
- `PlatformGuardrails` Aspect が全 stack に標準タグを付与し、欠落時に synth を失敗させる。
- SCP で non-prod アカウントからの production リソース参照、および production での `cdk destroy` による stateful resource 削除を拒否する。[^94]
- CI の `deploy` ステップは shared-services アカウントの pipeline role 経由でのみ production へ deploy する。開発者の IAM ユーザーには production への deploy 権限を与えない。
- 月次の cost/capacity/quota レビューで、アカウント別の `ClaimedAccountConcurrency` と quota 使用率を確認する。[^41][^75]

## 参考

[^3]: [Lessons learned from scaling to 1 million Lambda functions](https://aws.amazon.com/blogs/architecture/lessons-learned-from-scaling-to-1-million-lambda-functions/)（指針書 References より）

[^7]: [6000 AWS accounts, three people, one platform](https://aws.amazon.com/blogs/architecture/6000-aws-accounts-three-people-one-platform-lessons-learned/)（指針書 References より）

[^14]: [Reducing scope of impact with cell-based architecture - FAQ](https://docs.aws.amazon.com/wellarchitected/latest/reducing-scope-of-impact-with-cell-based-architecture/faq.md)（指針書 References より）

[^41]: [AWS Lambda supports additional concurrency metric for improved quota monitoring](https://aws.amazon.com/about-aws/whats-new/2023/12/aws-lambda-concurrency-metric-quota-monitoring/)（指針書 References より）

[^42]: [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)（参照日 2026-10-17）

[^62]: [Amazon API Gateway quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html)（参照日 2026-10-17）

[^75]: [Types of metrics for Lambda Event Functions](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html)（参照日 2026-10-17）

[^92]: [SEC01-BP01 Separate workloads using accounts](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/sec_securely_operate_multi_accounts.html)（参照日 2026-10-17）

[^93]: [Benefits of using multiple AWS accounts](https://docs.aws.amazon.com/whitepapers/latest/organizing-your-aws-environment/benefits-of-using-multiple-aws-accounts.html)（参照日 2026-10-17）

[^94]: [Service control policies (SCPs)](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)（参照日 2026-10-17）

[^95]: [CloudWatch cross-account observability](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Unified-Cross-Account.html)（参照日 2026-10-17）

[^111]: [Organizing and tracking costs using AWS cost allocation tags](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/cost-alloc-tags.html)（参照日 2026-10-17）

[^v1]: [CloudWatch cross-account observability](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Unified-Cross-Account.html)（参照日 2026-10-17。遅延に関する記述なし。logs・metrics・Application Signals は追加費用なし、trace は最初のコピーが無料）
