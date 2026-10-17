# docs/

B2BマルチテナントPaaS向け サーバレス・マイクロサービス テンプレートのドキュメント索引。

## 読み始める場所

| 立場                       | 最初に読む                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 新規サービスを作る         | [指針書](microservice-guidelines.md) の 1, 3, 4, 16, 20章 → `pnpm create-service --type api                 | worker | workflow` |
| プラットフォームを運用する | [指針書](microservice-guidelines.md) の 2, 3, 11, 17, 18章 → [アーキテクチャ概要](architecture/overview.md) |
| オンコールに入る           | [runbooks/](runbooks/) → 指針書 19, 12, 11, 21章                                                            |
| セキュリティ / 監査        | [threat-models/](threat-models/) → 指針書 5, 12, 13, 14, 21章                                               |
| アーキテクチャレビュー     | 指針書の「主要な初期判断」「優先ADR一覧」 → [adr/](adr/)                                                    |

## 文書一覧

### 指針

| 文書                                                                                             | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [microservice-guidelines.md](microservice-guidelines.md)                                         | 設計指針書本体。位置づけ、採用する実運用知見、全20章（目的 / 標準 / 必須ルール / 判断基準 / 禁止事項 / 検証方法 / 関連ADR）、主要な初期判断、優先ADR一覧、テンプレートリポジトリ構成、golden path、モック環境の最小スコープ、受入基準、実装ロードマップ、References                                                                                                                                                                                                                                                                                                                   |
| [microservice-guidelines-resilience-security.md](microservice-guidelines-resilience-security.md) | 第21章 破壊と再生・侵入耐性。chaos engineering（FIS の serverless 対応、simulation hook、game day シナリオ、再生手段）、影響範囲の限定（MITRE ATT&CK 対応、SCP / RCP、短命資格情報、MicroVM egress、tenant 単位の遮断）、侵入検出（GuardDuty / Security Hub / Detective / Config / Inspector / Access Analyzer とアプリ層検出、TTD / TTC SLO）、侵入トレーサビリティ（`correlationId` × CloudTrail `userIdentity`、log file validation、Log Archive account、chain-of-custody）、AI 時代の追加策（prompt injection、自動封じ込め、attack-surface スキャン）、ADR-0025 / 0026 起票候補 |

### アーキテクチャ

| 文書                                                                     | 内容                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [architecture/overview.md](architecture/overview.md)                     | 全体像：リクエストフロー（CloudFront/WAF → API Gateway → Lambda → DynamoDB → Streams → outbox relay → EventBridge → SQS → Lambda → Step Functions）、アカウント / セル トポロジ、相関ID伝播、CDK構成、パッケージ依存、サービス境界。MermaidとD2の2形式 |
| [architecture/diagrams/](architecture/diagrams/)                         | D2ソース（`request-flow.d2`、`account-cell-topology.d2`、`correlation-propagation.d2`、`service-boundaries.d2`）。`pnpm diagrams` がD2のTALA layout engineで `*.svg` へ描画する。D2ソースが正本                                                        |
| [architecture/workload-profile.md](architecture/workload-profile.md)     | 「1枚のworkload profile」記入テンプレート（RPS、tenant、burst、payload、SLO、データ分類、容量算出）と中規模B2B PaaSの記入例                                                                                                                            |
| [architecture/guidelines-outline.md](architecture/guidelines-outline.md) | 指針書の元となったアウトライン（参照用）                                                                                                                                                                                                               |

### 脅威モデル

| 文書                                                             | 内容                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [threat-models/order-service.md](threat-models/order-service.md) | `example-order-service` のSTRIDE脅威モデル。テナント境界越境、JWT / authorizer信頼、冪等キー悪用、イベント改ざんを重点に、緩和策を `@paas/constructs` / `@paas/*` のConstruct・パッケージへ対応付け。他サービスの雛形を兼ねる |

### Runbook

| 文書                                                                                   | 対象                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [runbooks/dlq-redrive.md](runbooks/dlq-redrive.md)                                     | 全SQS DLQの診断、原因分類、redrive（`start-message-move-task`）、poison message退避、業務補正                                                                                                                                           |
| [runbooks/order-service.md](runbooks/order-service.md)                                 | `example-order-service`：availability / latency / throttle / DynamoDB / outbox relay / 冪等テーブル / authorizer                                                                                                                        |
| [runbooks/worker-service.md](runbooks/worker-service.md)                               | `example-worker-service`：tier別queue age、エラー分類、`maxConcurrency`、rule DLQ、外部API障害、二重履行                                                                                                                                |
| [runbooks/workflow-service.md](runbooks/workflow-service.md)                           | `example-workflow-service`：失敗実行の特定、補償失敗時の手動介入、再要求、timeout、二重プロビジョニング                                                                                                                                 |
| [runbooks/lambda-concurrency-throttling.md](runbooks/lambda-concurrency-throttling.md) | account quota / unreserved / reserved / SQS maxConcurrency / scaling rate の切り分けと一時対応、quota申請                                                                                                                               |
| [runbooks/security-incident.md](runbooks/security-incident.md)                         | セキュリティインシデント：準備 → 検知 → 分析（Logs Insights / Athena / Detective、証跡保全）→ 封じ込め（tenant / 関数 / 資格情報単位）→ 根絶 → 復旧 → post-incident。AWS Security Incident Response Guide と NIST SP 800-61 Rev. 3 準拠 |

各runbookは共通構成：症状 → ダッシュボード / alarm → 診断手順（AWS CLI / Logs Insights）→ 復旧手順 → エスカレーション → post-incident。

### ADR

| 文書         | 内容                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------- |
| [adr/](adr/) | ADR-0001〜0020。一覧は指針書の「優先ADR一覧」を参照。ファイル名は `ADR-NNNN-<kebab-case-title>.md` |

### 意思決定ガイド（要件 → アーキテクチャ）

| 文書                                                                                               | 内容                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [decision/architecture-decision-questionnaire.md](decision/architecture-decision-questionnaire.md) | 要件引き出し質問票。回答ごとに標準選択と例外条件を示す                                                                                                                                                                                           |
| [decision/decision-trees.md](decision/decision-trees.md)                                           | 分割/統合、同期/非同期/ワークフロー、ランタイム、テナント分離、API Gateway 種別、キュー種別、DynamoDB/Aurora、Standard/Express の決定木                                                                                                          |
| [decision/technology-selection-rationale.md](decision/technology-selection-rationale.md)           | テンプレートが使う全 AWS サービス・ライブラリの採用理由、運用上の現実、不採用条件、代替                                                                                                                                                          |
| [decision/api-compute-selection.md](decision/api-compute-selection.md)                             | API 層の Lambda Event Functions / Web Functions / MicroVMs / Fargate 比較（8 軸、費用試算、ベンチマーク手順）                                                                                                                                    |
| [decision/latest-tech-reassessment.md](decision/latest-tech-reassessment.md)                       | 古い出典に依存しないための「本質 → 最新技術での再検証」: Bun vs Node.js、API Gateway 非経由（Web Functions / Function URL + CloudFront）、ログ集約・一本化（OTel / Application Signals）、ローカル仮想環境（LocalStack / docker-compose / k8s）  |
| [decision/template-defaults.md](decision/template-defaults.md)                                     | テンプレート既定値レジスタ。外部出典のない組織閾値（TD-NN: 値・根拠・影響範囲・調整方法・見直し契機）と、テンプレートの試験で確定する計測項目（M-NN: 取得方法・記録先・現在の値）の正本                                                          |
| [decision/diagram-as-code-tools.md](decision/diagram-as-code-tools.md)                             | AWS 構成図の diagram-as-code 候補を 2026-10-18 時点の一次資料で比較（awsdac、PDK CdkGraph、cdk-dia、D2 + TALA、Infrastructure Composer、Workload Discovery、agent skill）。cdk2d2 は 2023 年で更新停止、互換 shim の廃止判断材料と ADR-0024 候補 |

### レビューキット（既存リポジトリ・要求仕様書・設計指針書・設計書）

| 文書                                                                                         | 内容                                                                                                             |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [review/README.md](review/README.md)                                                         | 使い方、重大度、指摘記録テンプレート                                                                             |
| [review/requirements-spec-review-checklist.md](review/requirements-spec-review-checklist.md) | 要求仕様書のレビュー観点（テナント、RPS、SLO、RTO/RPO、データ分類、規制、コスト上限、所有）                      |
| [review/design-guideline-review-checklist.md](review/design-guideline-review-checklist.md)   | 他組織の設計指針書を評価する観点                                                                                 |
| [review/design-document-review-checklist.md](review/design-document-review-checklist.md)     | 個別サービス設計書の観点（境界、契約、冪等性、retry 所有、DLQ、partition key、SLO、runbook、脅威モデル、コスト） |
| [review/repository-review-checklist.md](review/repository-review-checklist.md)               | 既存コードの観点と grep 手順                                                                                     |
| [review/anti-patterns.md](review/anti-patterns.md)                                           | アンチパターン集（症状・運用上の害・検出・是正・根拠）                                                           |
| [review/evidence-register.md](review/evidence-register.md)                                   | レビューキットの出典台帳と監査ログ                                                                               |

## 文書の規約

- 日本語で書く。コード識別子、AWSサービス名、英語技術用語はそのまま。
- 規範語は RFC 2119（MUST / SHOULD / MAY / MUST NOT）。
- **エビデンス規約**：すべての規範的記述、数値、制限値、価格、「ベストプラクティス」主張は、名前のある出典（AWS公式文書、名前のある企業の公開実践、規格・仕様）に追跡可能でなければならない。指針書は各章に「根拠 / 準拠」行を持ち、末尾の[エビデンス台帳](microservice-guidelines.md#エビデンス台帳)に主張 / 出典 / URL / 確認日を記録する。他の文書は末尾の「出典」節で指針書のReferences番号を参照する。出典のない主張は「既定値（例示値）: 値 + 理由 + 調整: TD-NN」（組織が調整する閾値。正本は [decision/template-defaults.md](decision/template-defaults.md)）、「計測で確定: 取得方法（M-NN）」（本テンプレートの試験で得る値）、「公式ドキュメントに記載なし（確認日、URL）」のいずれかで明記する。旧「要検証」タグは 2026-10-18 の第 2 回監査で全廃し、新規に使わない。
- AWSのquota・価格・製品挙動は、記載時点（2026-10-17）のAWS公式文書で確認した値であり、四半期conformance reviewで再取得する。
- 規則を追加するときは、対応する自動検査（`@paas/constructs` の `PlatformGuardrails`、lint、policy test）を同時に追加する。文書だけの規則を増やさない。
- 指針書の改訂はPRで行い、末尾の変更履歴を更新する。
- 各サービスは `service.yaml` の `runbook` / `threatModel` / `adrs` から本ディレクトリの文書を参照する。`ServiceMetadata` がパスの存在をsynth時に検証する。

## 関連する生成物（リポジトリ内）

| パス                                           | 内容                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `schemas/openapi/`                             | API契約の正本（指針書6章）                                           |
| `schemas/events/`                              | イベントschema（指針書7章）                                          |
| `apps/<service>/service.yaml`                  | 所有メタデータ（指針書3章）                                          |
| `apps/<service>/docs/`                         | サービス固有のdata-model、workload-profile、power-tuning、cost-model |
| `apps/platform-cdk/docs/concurrency-budget.md` | 同時実行予算（指針書11章）                                           |
| `tests/`                                       | contract / integration / tenant-isolation / resiliency / performance |
