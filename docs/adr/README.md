# Architecture Decision Records

本ディレクトリは、B2B マルチテナント PaaS 向けサーバレス・マイクロサービステンプレートの Architecture Decision Record（ADR）を管理する。各 ADR の背景は `docs/architecture/guidelines-outline.md` の各章に対応する。

## 記述ルール

- 新しい ADR は `template.md` をコピーし、次の連番で `ADR-XXXX-<kebab-case-english-title>.md` として作成する。
- **出典の必須化**: 規範的な記述、数値、上限、料金、「ベストプラクティス」の主張は、すべて名前のある出典に遡れなければならない。出典は AWS 文書（Well-Architected / SaaS Lens / Serverless Lens / Builders' Library / Prescriptive Guidance / サービスドキュメント / What's New）、企業の公開された実践（Amazon、ProGlove、Evertz、Spotify、Netflix など）、または標準・仕様（CloudEvents 1.0、OpenAPI 3.1、RFC 9457、DORA、Google SRE など）とする。
- Context / Decision では番号付き脚注 `[^n]` と URL で出典を示す。脚注番号は `docs/architecture/guidelines-outline.md` の References（1〜54）を共有し、新規出典は 55 以降を全 ADR で共通に使う。各 ADR の「参考」節に、その ADR で使う脚注の定義を置く。
- quota、料金、上限、製品挙動は、記載前に現行の AWS ドキュメントで検証し、脚注に参照日を記す。指針書の References から転記したものは「指針書 References より」と記す。
- 出典が見つからない数値や判断は、事実として書かず、「既定値（例示値）: 値 + 設計判断の理由 + 調整: docs/decision/template-defaults.md#既定値レジスタ（TD-NN）」（組織が調整する閾値）、「計測で確定: 取得方法（M-NN）」（本テンプレートの試験で得る値）、「公式ドキュメントに記載なし（確認日、URL）」（外部事実）のいずれかの形で書く。裸のタグだけを置かない。
- Decision 節の冒頭に「準拠: <組織 / 標準>」の行を置く。
- `proposed` の ADR は、Evidence 節に記載した benchmark / PoC を完了し、結果を追記してから `accepted` へ変更する。
- すべての ADR は Review date に再評価し、変更がなくても Review date を更新する。
- 指針から外れる場合は ADR を禁止するのではなく、例外 ADR として Context / Decision / Alternatives / Consequences / Evidence / Expiry を記録する。

## 一覧

| 番号                                                            | タイトル                                                                                      | Status   | Review date |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------- | ----------- |
| [ADR-0001](ADR-0001-microservice-boundary-definition.md)        | Microservice boundary definition                                                              | accepted | 2027-04-17  |
| [ADR-0002](ADR-0002-repository-strategy.md)                     | Repository strategy                                                                           | accepted | 2027-04-17  |
| [ADR-0003](ADR-0003-multi-account-topology.md)                  | Multi-account topology                                                                        | accepted | 2027-04-17  |
| [ADR-0004](ADR-0004-tenant-isolation-models.md)                 | Tenant isolation models                                                                       | accepted | 2027-04-17  |
| [ADR-0005](ADR-0005-api-gateway-http-vs-rest-api.md)            | API Gateway HTTP API vs REST API                                                              | proposed | 2027-04-17  |
| [ADR-0006](ADR-0006-lambda-event-functions-vs-web-functions.md) | Lambda Event Functions vs Web Functions                                                       | proposed | 2027-04-17  |
| [ADR-0007](ADR-0007-lambda-microvm-usage-policy.md)             | Lambda MicroVM usage policy                                                                   | proposed | 2027-04-17  |
| [ADR-0008](ADR-0008-zip-vs-lambda-container-image.md)           | zip vs Lambda container image                                                                 | proposed | 2027-04-17  |
| [ADR-0009](ADR-0009-lambda-vs-ecs-fargate.md)                   | Lambda vs ECS/Fargate                                                                         | proposed | 2027-04-17  |
| [ADR-0010](ADR-0010-step-functions-policy.md)                   | Step Functions policy                                                                         | accepted | 2027-04-17  |
| [ADR-0011](ADR-0011-service-communication.md)                   | Service communication                                                                         | accepted | 2027-04-17  |
| [ADR-0012](ADR-0012-data-ownership.md)                          | Data ownership                                                                                | accepted | 2027-04-17  |
| [ADR-0013](ADR-0013-event-envelope-and-versioning.md)           | Event envelope and versioning                                                                 | accepted | 2027-04-17  |
| [ADR-0014](ADR-0014-idempotency-and-retry.md)                   | Idempotency and retry                                                                         | accepted | 2027-04-17  |
| [ADR-0015](ADR-0015-trace-and-correlation.md)                   | Trace and correlation                                                                         | accepted | 2027-04-17  |
| [ADR-0016](ADR-0016-slo-and-performance-budgets.md)             | SLO and performance budgets                                                                   | accepted | 2027-04-17  |
| [ADR-0017](ADR-0017-lambda-concurrency-governance.md)           | Lambda concurrency governance                                                                 | accepted | 2027-04-17  |
| [ADR-0018](ADR-0018-cost-attribution.md)                        | Cost attribution                                                                              | proposed | 2027-04-17  |
| [ADR-0019](ADR-0019-cdk-construct-boundaries.md)                | CDK construct boundaries                                                                      | accepted | 2027-04-17  |
| [ADR-0020](ADR-0020-deployment-strategy.md)                     | Deployment strategy                                                                           | accepted | 2027-04-17  |
| [ADR-0021](ADR-0021-runtime-nodejs24-vs-bun.md)                 | Runtime: Node.js 24 standard, Bun not adopted                                                 | accepted | 2027-04-21  |
| [ADR-0022](ADR-0022-observability-pipeline.md)                  | Observability pipeline (OTel migration, central aggregation)                                  | accepted | 2027-04-21  |
| [ADR-0023](ADR-0023-local-virtual-environment.md)               | Local virtual environment (compose L1 / LocalStack L2)                                        | accepted | 2027-04-21  |
| [ADR-0024](ADR-0024-diagram-as-code-toolchain.md)               | Diagram-as-code toolchain (cloud assembly → D2 as source of truth)                            | accepted | 2027-04-21  |
| [ADR-0025](ADR-0025-chaos-and-resilience-testing.md)            | Chaos and resilience testing (FIS, game days, Resilience Hub)                                 | accepted | 2027-04-21  |
| [ADR-0026](ADR-0026-detection-and-response.md)                  | Detection and response (GuardDuty / Security Hub / CloudTrail, auto-containment, log archive) | proposed | 2027-04-21  |

## Status の意味

| Status     | 意味                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------- |
| proposed   | 決定内容は記載済みだが、Evidence 節の benchmark / PoC が未完了。production 適用前に完了が必要 |
| accepted   | 決定が有効で、Compliance 節の仕組みで強制されている                                           |
| superseded | 新しい ADR に置き換えられた。置き換え先を Related に記載                                      |
| deprecated | 対象の構成要素が廃止された                                                                    |

## ガイドライン章との対応

| ADR              | 主な章                                                |
| ---------------- | ----------------------------------------------------- |
| 0001, 0002       | 3. 用語と責任境界、4. サービス分割                    |
| 0003, 0004       | 5. マルチテナンシー、11. Lambda 同時実行数とクォータ  |
| 0005, 0006, 0007 | 6. API 設計                                           |
| 0008, 0009, 0010 | 8. 処理・ワークフロー                                 |
| 0011, 0013       | 7. イベント設計                                       |
| 0012             | 9. データ設計                                         |
| 0014             | 6. API 設計、12. 信頼性                               |
| 0015             | 14. リクエストトレーサビリティ                        |
| 0016             | 10. 性能・容量                                        |
| 0017             | 11. Lambda 同時実行数とクォータ                       |
| 0018             | 15. コスト                                            |
| 0019             | 17. CDK/IaC                                           |
| 0020             | 18. CI/CD                                             |
| 0021             | 16. 開発プロセス、8. 処理・ワークフロー（ランタイム） |
| 0022             | 14. リクエストトレーサビリティ、19. 運用              |
| 0023             | 16. 開発プロセス（ローカル環境と最終保証）            |
| 0024             | 17. CDK/IaC（構成図の生成）                           |
| 0025, 0026       | 21. 破壊と再生・侵入耐性（別ファイル）                |

## 2026-10-17 の検証で判明した要注意事項

ADR 作成時に現行 AWS ドキュメントで確認し、ガイドラインや実装の前提に影響するものを記録する。

- Lambda Node.js 22 ランタイムは 2027-04-30 に deprecation 予定（ADR-0002 / 0008）。
- 新規 AWS アカウントは Lambda の同時実行・メモリ quota が縮小された状態で開始する（ADR-0003 / 0017）。
- HTTP API は API Gateway 側の X-Ray tracing、WAF 直接関連付け、caching、request validation、usage plan、canary release を持たない（ADR-0005）。
- Lambda Web Functions は Node.js のみ、5 リージョン、request + active vCPU + memory 課金、metrics に revision dimension なし（ADR-0006 / 0018 / 0020）。
- Lambda MicroVMs は最大 8 時間（引き上げ不可）、ARM64 のみ、`RunMicrovm` 5 TPS（ADR-0007）。
- Lambda SQS event source の推奨 `maxReceiveCount` は 5 以上、visibility timeout は関数 timeout の 6 倍 + batch window（ADR-0011 / 0014）。
- EventBridge Schema Registry は OpenAPI 3 と JSONSchema Draft4 のみ対応（ADR-0013）。
- DynamoDB `dynamodb:LeadingKeys` 条件は `Scan` を制限できないため、pool テーブルでは `Scan` を許可しない（ADR-0004 / 0012）。

## 2026-10-21 の検証で判明した要注意事項

- Lambda Web Functions のランタイムは `nodejs24.x` のみで runtime management control なし。Node.js 24 を Event / Web 共通の標準にする（ADR-0021）。
- X-Ray SDK / Daemon は 2026-02-25 に maintenance mode、2027-02-25 にサポート終了。trace 経路を OTel へ切り替える（ADR-0022）。
- CloudTrail Lake は 2026-05-31 以降、新規顧客に開放されない。監査証跡の正本は CloudTrail trail → S3 → Athena（ADR-0022 / 0026）。
- FIS の Lambda action は Event Functions のみ。SQS / EventBridge / DynamoDB テーブル / Web Functions への fault 注入 action はない（ADR-0025）。
- GuardDuty detector と Security Hub は account / region singleton。template は `--context detection=true` の opt-in でのみ作る（ADR-0026）。
