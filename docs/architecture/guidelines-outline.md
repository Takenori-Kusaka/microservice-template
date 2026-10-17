# B2BマルチテナントPaaS向け サーバレス・マイクロサービス設計指針書アウトライン

## 位置づけ

本書は、B2Bマルチテナント・中規模トラフィックのPaaSを、TypeScript、Node.js、AWS CDK、AWSマネージドサービス中心で構築するための「マイクロサービス設計指針書」のアウトラインである。単なる章立てではなく、各章で確定すべき判断基準、標準アーキテクチャ、禁止事項、検証方法、Architecture Decision Record（ADR）候補までを示す。

結論として、初期の標準形は次のように置くのが妥当である。

- **マイクロサービスの単位**はLambda関数ではなく、単一の業務能力・所有チーム・データ所有権・SLO・独立デプロイ境界を共有する単位とする。
- **同期API**はAPI GatewayとLambda Event Functionsを第一選択とし、Lambda Web Functionsは互換性・同時リクエスト・ストリーミングに価値があるAPIで比較検証する。
- **非同期処理**はEventBridgeでサービス間イベントを配信し、SQSで負荷平準化とバックプレッシャーを作り、Lambdaで処理する。
- **ワークフロー**はStep Functionsを許容する。ただし原則はサービス境界内、または明示的な「業務プロセス所有サービス」に置き、他サービスのデータストアを直接操作しない。
- **処理ランタイム**はzip形式Lambdaを標準とし、Lambdaコンテナイメージ、ECS/Fargate、Lambda MicroVMsを例外プロファイルとして選ぶ。
- **テナント分離**はpoolを標準に、bridge/siloをサービス単位で選択できるようにする。負荷・障害・クォータの隔離にはセル型・マルチアカウントを段階導入する。
- **一貫した性能**は「常にウォームにすること」ではなく、APIごとのp95/p99 SLO、同時実行予算、下流容量、負荷制御、コールドスタート対策を一体で設計する。
- **トレーサビリティ**はサンプリングされる分散トレースだけに依存せず、全リクエスト・イベントに業務相関IDを持たせ、ログ、メトリクス、監査証跡と結合する。

この方針は、AWS SaaS Lensが示す「各マイクロサービスによるデータ所有」「サービスごとにpool/siloを選ぶ」という構造、Amazonの運用知見、実運用事例に整合する。たとえばProGloveの大規模サーバレスSaaSでは、1マイクロサービスを5〜15個のLambda、Step Functions、EventBridge、DynamoDBを束ねたCloudFormationスタックとして運用しており、「1 Lambda＝1マイクロサービス」ではない。[^1][^2][^3]

## 採用する実運用知見

### Amazon/AWS

Amazon Builders’ Libraryは、タイムアウト、限定された再試行、指数バックオフ、ジッター、冪等性を分散システムの基本としている。再試行は障害中の下流負荷を増幅し得るため、回数・総時間を制限し、APIを安全に再試行可能にする必要がある。[^4][^5]

またAmazonのマルチテナント非同期システムでは、キュー滞留時間の監視、ワークロード別の同時実行制限、超過トラフィックの退避、上流へのバックプレッシャーなどを組み合わせている。これは「Lambdaが自動スケールするから容量設計不要」という考えを否定し、下流データストアを含むエンドツーエンドの容量制御を要求する。[^6]

### ProGlove

ProGloveはサーバレスSaaSを数千AWSアカウント、40マイクロサービス、約100万Lambda規模で運用し、アカウント境界をセキュリティ、所有権、費用、サービスクォータの分離に利用している。本指針では中規模PaaSにそのままaccount-per-tenantを強制せず、まずpool、次にtenant tier/cell単位のアカウント分割、必要テナントのみsiloという段階モデルに落とす。[^3][^7]

### Evertz.io

マルチテナントSaaSのevertz.ioは、Lambda、Step Functions、DynamoDB、EventBridgeを中心とするserverless-firstを採用しつつ、長時間実行や特定ハードウェア要件では別の計算基盤を選んでいる。したがって本指針も「すべてをLambdaに載せる」のではなく、ワークロード特性からランタイムを選ぶ。[^8]

### SpotifyとNetflix

Spotifyは標準テンプレートにベストプラクティスを組み込み、新サービス作成時にリポジトリ、デプロイ、所有者情報を自動生成することで開発者負担を下げている。Netflixは、API所有チームと下流呼び出しの耐障害ロジックを分離し、エンドツーエンドトレースを実運用の移行判断に利用している。公開CDKテンプレートでは、この「golden path」と所有情報をコード生成・CIで強制する。[^9][^10]

## 指針書の全体構成

| 章 | 主目的 | 章で確定するもの |
|---|---|---|
| 1. 目的と適用範囲 | 指針の対象と非対象を固定 | PaaS特性、規模、リージョン、RTO/RPO、対象チーム |
| 2. 設計原則 | 判断の優先順位を統一 | serverless-first、managed-first、独立性、単純性、計測可能性 |
| 3. 用語と責任境界 | 「サービス」「関数」「プラットフォーム」の混同を防ぐ | 境界モデル、RACI、所有メタデータ |
| 4. サービス分割 | 過剰分割と分散モノリスを防ぐ | bounded context、分割・統合判定、依存ルール |
| 5. マルチテナンシー | 分離・負荷・費用の方針を統一 | tenant context、pool/bridge/silo、セル設計 |
| 6. API設計 | 同期インターフェースを標準化 | API Gateway種別、契約、認証認可、冪等性、エラー |
| 7. イベント設計 | 非同期連携を安全にする | イベント包絡、EventBridge/SQS、順序、重複、DLQ |
| 8. 処理・ワークフロー | Lambda/Step Functions/コンテナを選定 | compute decision tree、ワークフロー境界 |
| 9. データ設計 | データ所有権と整合性を確立 | database-per-service、CQRS、Saga、移行、暗号化 |
| 10. 性能・容量 | 一貫した性能を設計可能にする | SLO、同時実行予算、負荷試験、過負荷制御 |
| 11. 信頼性 | 障害を局所化し復旧可能にする | timeout/retry、DLQ、re-drive、セル、DR |
| 12. セキュリティ | テナント越境を構造的に防ぐ | IAM、ABAC、秘密、監査、脅威モデル |
| 13. 可観測性 | 1リクエストを端から追えるようにする | trace/correlation、構造化ログ、メトリクス、監査ログ |
| 14. コスト | 単価でなく業務単位原価を管理 | cost model、tenant attribution、予算、最適化ループ |
| 15. 開発標準 | 実装工数とばらつきを減らす | TypeScript規約、共通SDK、ローカル開発、テスト |
| 16. CDK/IaC | 再現可能な構築単位を定義 | construct境界、stack構成、環境分離、policy-as-code |
| 17. CI/CD | 安全かつ小さくリリース | quality gates、canary、rollback、schema compatibility |
| 18. 運用 | 誰が何を運用するか確定 | runbook、on-call、SLOレビュー、インシデント管理 |
| 19. ガバナンス | 例外を管理可能にする | ADR、適合性チェック、例外期限、技術標準更新 |
| 20. テンプレート仕様 | 公開リポジトリへ接続 | ディレクトリ、生成物、サンプル、受入条件 |

## 各章の詳細アウトライン

### 1. 目的と適用範囲

- 背景：B2B PaaS、マルチテナント、中規模、TypeScript/Node.js、AWS CDK。
- 目標：責任境界、低い開発工数、一貫した性能、テナント分離、追跡可能性、原価可視化。
- 非目標：全サービスの極小分割、全処理のLambda化、強整合性の全面保証、無制限スケール。
- 対象環境：sandbox、development、staging、production。productionは別AWSアカウントを必須とする。
- 品質属性の優先順位：セキュリティとデータ保全、可用性、運用可能性、開発速度、性能、コストの順を基本とし、サービスごとの差分はADR化する。
- 成功指標：リードタイム、デプロイ頻度、変更失敗率、MTTR、SLO達成率、テナント当たり原価、テンプレート逸脱率。

### 2. 設計原則

- **Managed-first**：差別化にならない運用はAWSマネージドサービスへ寄せる。AWS Well-Architectedも、可能な限りマネージドサービスを使用して運用負担を減らすことを推奨している。[^11]
- **Serverless-first, not serverless-only**：Lambdaへの適合性ではなく、実行時間、CPU、メモリ、状態、隔離、レイテンシ、単価で判断する。
- **One owner, one contract, one data authority**：各サービスに単一の運用所有者、公開契約、正本データを定める。
- **Independent where valuable**：独立デプロイ・独立スケール・障害隔離に価値がない分割は行わない。
- **Async by reason, not fashion**：遅延許容、バッファ、ファンアウト、独立障害が必要な箇所だけ非同期化する。
- **Paved road**：セキュリティ、テナント文脈、ログ、トレース、アラームを共通Construct/ライブラリで自動付与する。AWS SaaS Lensも、テナント文脈を共通ライブラリへ隠蔽し、開発者が日常コードで意識する量を減らす方針を示している。[^12][^13]
- **Evidence over defaults**：メモリ、タイムアウト、同時実行数、Provisioned Concurrencyは負荷試験結果で決める。

### 3. 用語と責任境界

#### 定義

- **Platform**：認証、tenant registry、アカウント/セル管理、監査、可観測性、CI/CD、共通CDK Constructを提供する基盤。
- **Microservice**：単一業務能力を所有し、API/イベント契約、データ、SLO、ランブック、デプロイ単位をまとめたもの。
- **Function**：サービス内部の計算・イベント処理単位。マイクロサービスと同義ではない。
- **Workflow**：複数ステップの状態遷移と補償を所有するサービス内部資源、または独立した業務プロセスサービス。
- **Cell**：ルーティング、計算、状態を可能な範囲で自己完結させた障害隔離単位。セルは状態を共有しないことが原則である。[^14]
- **Control plane**：tenant onboarding、設定、配置、運用管理。
- **Data plane**：テナントの通常業務リクエストとイベント処理。

#### 必須所有メタデータ

各サービスの`service.yaml`またはBackstage互換`catalog-info.yaml`に以下を必須化する。

- `serviceId`、`domain`、`ownerTeam`、`onCall`、`repository`
- `dataClassification`、`tenantIsolationModel`
- `syncContracts`、`publishedEvents`、`consumedEvents`
- `slo`、`rto`、`rpo`、`costCenter`
- `runtimeProfile`、`awsAccounts`、`regions`
- `runbook`、`dashboard`、`threatModel`、`adrs`

AWS Operational Excellence Pillarは、アプリケーション、ワークロード、プラットフォーム、インフラ、手順ごとに所有者を特定することを求めている。所有者不明のサービスはデプロイ不可とする。[^11]

#### RACIの基準

| 対象 | サービスチーム | プラットフォームチーム | セキュリティ/運用 |
|---|---|---|---|
| 業務契約・データ | A/R | C | C |
| Lambda/Step Functions実装 | A/R | C | I |
| 共通CDK Construct | C | A/R | C |
| テナント文脈SDK | C | A/R | C |
| サービスSLO・ランブック | A/R | C | C |
| 組織共通ポリシー | C | R | A |
| インシデント一次対応 | A/R | C | C |
| 共通基盤障害 | C | A/R | C |

### 4. サービス分割

#### 分割軸

サービス候補は次の6軸で評価する。

1. 業務能力とbounded context。
2. データの正本所有者。
3. 変更頻度と独立リリースの必要性。
4. スケール、レイテンシ、可用性、隔離要件。
5. セキュリティ・コンプライアンス境界。
6. 単一チームが理解・運用できる認知負荷。

マイクロサービスは技術層ではなく業務上のbounded contextで分け、明確な契約を介して連携する。[^15][^16]

#### 分割判定

以下のうち2つ以上に明確な差がある場合、分割候補とする。

- 所有チーム
- データライフサイクル
- スケール特性
- セキュリティ区分
- 可用性/SLO
- リリース頻度
- 障害波及範囲

逆に、常に同時変更される、同期チャットが多い、同じトランザクションとデータを共有する、個別SLOを定義できない場合は統合を優先する。

#### 必須ルール

- 他サービスのDB、DynamoDBテーブル、S3プレフィックスを直接読むことを禁止する。
- 共有DBを恒久標準にしない。移行期はサービスごとのschema/tableとIAM分離を必須化する。
- 同期呼び出しチェーンは原則3ホップ以内。超過はAPI composition、read model、非同期化を検討する。
- 共通ライブラリに業務ロジックを置かない。共通化対象は観測、認証認可、tenant context、エラー、契約生成など横断関心に限定する。
- 「1エンドポイント＝1リポジトリ」「1関数＝1サービス」を標準にしない。

Database-per-serviceは疎結合と独立スケールをもたらす一方、サービス横断クエリ・トランザクションを複雑にするため、API composition、CQRS、イベント、Sagaを併用する。[^17][^18]

### 5. マルチテナンシー

#### テナント文脈

認証済みJWTまたは信頼できるauthorizer contextから次を生成し、各処理の`ExecutionContext`へ格納する。

```ts
interface ExecutionContext {
  tenantId: string;
  tenantTier: string;
  subjectId?: string;
  requestId: string;
  correlationId: string;
  traceId?: string;
  idempotencyKey?: string;
  cellId: string;
}
```

クライアントが自由入力した`tenantId`をデータアクセスに使用してはならない。tenant contextの解決、IAM scope、ログ付与、メトリクス付与は共通SDKへ隠蔽する。AWS SaaS Lensも、token manager、isolation manager、logging/metrics wrapperをサービス内の再利用コードとして実装し、それ自体を別ネットワークサービスに分解して余分な遅延を増やさないよう説明している。[^12]

#### 分離モデル

| モデル | 標準用途 | 長所 | 注意点 |
|---|---|---|---|
| Pool | 通常テナント | 低コスト、運用集約 | partition key、IAM、noisy neighbor対策が必須 |
| Bridge | 高負荷/規制差がある一部機能 | 選択的な分離 | 構成分岐と移行手順が必要 |
| Silo | 規制、専有性能、個別鍵、障害隔離 | 強い境界 | 配備数と更新コストが増える |
| Account-per-tenant | 最上位tierまたは強い委譲 | クォータ・費用・セキュリティ境界が明確 | account vending、StackSets、集中観測が必要 |

サービスごとに分離モデルを選び、PaaS全体で一律にしない。AWS SaaS Lensも、multi-tenant負荷、tier、分離要件をサービス単位で判断すべきとしている。[^2]

#### 推奨段階

- Phase 1：環境別アカウント、リージョン内pool、DynamoDBの`tenantId`先頭キー、API tier別スロットリング。
- Phase 2：複数cellへtenantを固定配置し、cell別アカウントまたはstackで障害範囲とクォータを分離。
- Phase 3：規制・大口テナントのみsilo/account-per-tenant。

### 6. API設計

#### API層の標準

標準経路は`CloudFront/WAF → API Gateway → Lambda → service-owned datastore`とする。API Gatewayは認証、ルーティング、スロットリング、契約境界を担い、業務認可はサービス側がtenant contextとresource ownershipを用いて実施する。

API GatewayのREST APIとHTTP APIは、機能要件と総費用で選ぶ。HTTP APIは薄いJWT APIの標準候補、REST APIはusage plan、API key、詳細な変換・検証、キャッシュなどが必要な場合の候補とし、採用時点のAWS機能表をADRへ固定する。料金体系はHTTP APIの方が低いが、単価だけでなくauthorizer、WAF、ログ、データ転送、下流呼び出しを含めて比較する。[^19][^20]

#### Lambda選択表

| 選択肢 | 推奨判断 | 本PaaSでの位置づけ |
|---|---|---|
| Lambda Event Functions | 短時間、1リクエスト1 invocation、イベント連携、細かなIAM/スケール境界 | **同期APIと非同期処理の標準** |
| Lambda Web Functions | Node.js HTTPサーバ互換、1環境で複数同時HTTP、streaming、framework portability | **API層の検証候補** |
| Lambda MicroVMs | VM級隔離、状態を持つ対話セッション、任意コード、最大8時間 | **通常APIには不採用。sandbox/agent/tenant code専用** |
| Lambda container image | 大きな依存、native binary、既存Docker build | **Lambdaの包装方式。別の実行基盤ではない** |
| ECS/Fargate | 長時間、継続高負荷、常駐server、柔軟なCPU/メモリ/ネットワーク | **例外的な処理層** |

Lambda Web FunctionsはNode.js HTTPサーバを直接実行し、単一環境で複数リクエストを処理し、ゼロまでスケールできる。一方、2026年10月公開直後で、ランタイムやリージョン等の選択肢がEvent Functionsより狭いため、初期テンプレートでは`experimental`プロファイルとし、Event Functionsと同一負荷でp50/p95/p99、コールドスタート、費用、障害隔離、デプロイ時間を比較する。[^21][^22]

Lambda MicroVMsはFirecrackerによるVM級隔離、メモリ・ディスク状態の保持、最大8時間の実行を狙う別プリミティブであり、通常の短いREST APIを置き換えるものではない。テナント提供コード、AIエージェントsandbox、対話型開発環境など、隔離とセッション状態に価値がある機能だけでADRを起票する。[^23][^24]

#### API契約

- OpenAPIを正本とし、型、validation、SDK、contract testを生成する。
- 破壊的変更は新version、またはconsumer移行期間を設ける。
- HTTP status、安定した`error.code`、`requestId`、再試行可能性を返す。
- 書き込みAPIは`Idempotency-Key`を受け、tenant、operation、keyの組で重複を防ぐ。Powertools for AWS Lambda TypeScriptは入力の一部を冪等キーとして安全な再試行を実装できる。[^25][^26]
- deadline/timeout budgetを入口から下流へ伝播する。
- paginationはcursor方式を標準とし、無制限一覧取得を禁止する。

### 7. イベント設計

#### 役割分担

- **EventBridge**：サービス間の業務イベント、複数購読、疎結合ルーティング。
- **SQS Standard**：バッファ、バックプレッシャー、再試行、consumer scaling。
- **SQS FIFO**：業務上、本当に同一group内の順序が必要な場合だけ。
- **SNS**：単純なpush fan-outが適切な場合。
- **DynamoDB Streams**：サービス内部のデータ変更捕捉。外部公開契約に直接しない。

#### イベント包絡

```json
{
  "specversion": "1.0",
  "id": "event-id",
  "type": "order.created.v1",
  "source": "order-service",
  "time": "2026-10-17T00:00:00Z",
  "tenantId": "tenant-id",
  "correlationId": "business-flow-id",
  "causationId": "parent-command-or-event-id",
  "subject": "order/order-id",
  "datacontenttype": "application/json",
  "data": {}
}
```

- イベントは過去形の事実とし、commandと混同しない。
- `eventId`でconsumer冪等性を確保する。
- PII・秘密・巨大payloadをイベントへ載せず、必要に応じてS3 object referenceを渡す。
- schema registryと互換性テストをCIへ入れる。
- DLQは終着点ではなく、所有者、alarm、診断、redrive手順、最大保持期間を必須化する。
- queue depthだけでなく`ApproximateAgeOfOldestMessage`相当の滞留時間をSLO化する。Amazonも非同期システムの遅延把握にメッセージ年齢を重視している。[^6]

### 8. 処理・ワークフロー

#### Step Functionsの許容方針

Step Functionsは**許容するのではなく、明示的オーケストレーションの標準候補**とする。ただし次を満たすことを条件にする。

- 状態遷移、分岐、待機、再試行、補償が業務上可視化すべき概念である。
- Lambdaを単なるオーケストレータとして使わない。
- native service integrationで済む処理にwrapper Lambdaを作らない。
- state machineは原則1 bounded context内に置く。
- 複数サービスをまたぐSagaは「業務プロセス所有サービス」が所有し、各サービスの公開API/command/eventだけを使う。
- workflowから他サービスのDBを直接更新しない。
- 実行履歴に載せてよいデータ分類を定め、秘密・不要なPIIを渡さない。
- Standard/Expressは実行時間、exactly-once相当の実行モデル要件、監査、スループット、料金で選ぶ。

AWSは、複雑なエラー・再試行ロジックをStep Functionsへ移し、Lambdaには業務ロジックを残すことでカスタムコードを減らすことを推奨している。分散トランザクションには、Step FunctionsでSagaと補償処理を実装できる。[^27][^28][^29]

#### 処理ランタイム決定木

1. AWSサービス統合だけで完結するか：完結するならStep Functions/EventBridge Pipes/API Gateway direct integration。
2. 15分以内、stateless、イベント単位か：zip Lambda。
3. 大規模native dependencyまたは既存OCI buildが必要か：Lambda container imageを比較。
4. 継続高CPU、長時間、daemon、特殊network、予測可能な高稼働率か：ECS/Fargate。
5. VM級隔離、状態保持、対話セッション、テナント任意コードか：Lambda MicroVMs。
6. バッチで大量並列か：Step Functions Distributed Map、AWS Batch、ECS/Fargateを処理時間と単価で比較。

LambdaコンテナイメージとzipはLambdaのデプロイ形式の違いであり、実行上限や同時実行モデルを変えない。コンテナは最大10GBの依存を扱える一方、単純な関数はzipが扱いやすく、イメージサイズとlayer構造を含め実測すべきである。[^30][^31]

### 9. データ設計

- サービスがデータを所有し、他サービスはAPI/イベント経由で参照する。
- DynamoDBはアクセスパターン、partition key cardinality、hot partition、GSI、条件付き書き込み、TTLを設計書に明記する。
- Aurora/RDSは複雑な関係・制約・トランザクションが本質的な場合に選び、接続数をRDS Proxy等で保護する。
- S3はobject ownership、prefix、retention、versioning、malware scan、presigned URLを定義する。
- サービス横断参照はread model/CQRSを使い、実行時の多段同期joinを避ける。
- distributed transactionはSagaと補償を使い、整合性期待値をAPI契約に含める。
- outbox/inboxまたはDynamoDB Streamsを使い、DB更新とイベント発行の不整合を制御する。
- tenant migration、cell migration、schema migration、backfill、reconciliationを設計対象に含める。

AWSのdatabase-per-service指針でも、各データストアは外部サービスから直接アクセスせず、集約結果にはAPI composition、CQRS、event sourcing等を併用する。[^32][^17]

### 10. 性能・容量

#### SLO-first

すべての同期APIに、成功率、p50/p95/p99 latency、対象window、除外条件を定める。平均値ではなくpercentileを用いることが推奨される。CloudWatch Application SignalsはLambdaのrequest volume、availability、latency、fault、errorを収集し、SLOを設定できる。[^33][^34][^35]

#### 性能予算

入口APIのp99目標を、API Gateway、authorizer、Lambda init、business logic、datastore、downstream、networkへ配賦する。同期依存先のSLOが上位SLOを満たせない場合、cache/read model/async化を選ぶ。

Lambda必要同時実行数の基礎見積りは次とする。

\[
Concurrency \approx RequestsPerSecond \times AverageDurationSeconds
\]

ただし容量試験では平均だけでなく、p95/p99 duration、burst、retry、tenant skew、downstream limitを含める。

#### 一貫性能の手段

- latency-sensitiveな少数APIだけProvisioned Concurrencyを検証する。
- reserved concurrencyで重要機能を保護し、同時に下流DBを守る上限として使う。
- API Gateway/tenant tierでrate limitし、過負荷時は早く429/503を返す。
- 非同期処理はSQS event sourceの最大同時実行数、batch size、visibility timeoutを設定する。
- memoryはCPU・networkにも影響するため、Lambda Power Tuningと実トラフィック相当データで決める。
- arm64を標準候補にし、native依存がある場合だけx86へ戻す。AWSはGravitonへの変更を負荷試験で検証するよう推奨している。[^36][^37]
- コールドスタートだけでなく、warm p99、downstream saturation、goodputを測る。
- overload testでtipping pointを超え、load shedding後もgoodputが維持されることを確認する。Amazonも過負荷時の一貫したgoodputのためload sheddingとrate limitingを組み合わせている。[^38]

### 11. Lambda同時実行数とクォータ

デフォルトのリージョン当たり同時実行上限は1,000で、Service Quotasから引き上げ可能である。reserved/provisioned concurrencyは同じアカウント上限を消費し、未予約関数用に100が保持される。[^39][^40]

「制限をどう超えるか」は回避策ではなく次の順序で扱う。

1. **計測**：`ConcurrentExecutions`、`UnreservedConcurrentExecutions`、`ClaimedAccountConcurrency`、`Throttles`を監視する。`ClaimedAccountConcurrency`は予約・プロビジョニングを含む利用可能量の把握に使える。[^41]
2. **削減**：duration短縮、batch化、direct integration、不要なfan-out削減、I/O並列化。
3. **保護**：重要関数へreserved concurrency、非重要処理へ上限、tenant別rate limit。
4. **平準化**：SQSでburstを吸収し、consumer concurrencyを下流容量に合わせる。
5. **申請**：需要予測と負荷試験結果を添えて、リージョンquotaを事前増枠する。上限は数万規模まで引き上げ可能とされる。[^42]
6. **隔離**：prod/non-prod、control/data plane、cell、tenant tierをアカウント分割し、障害・セキュリティ・費用・quotaをまとめて分離する。
7. **地域分散**：事業要件とデータ整合性が許す場合のみmulti-regionへ展開する。
8. **ランタイム変更**：常時高負荷や非常に高い同時実行でLambda単価・quotaが不利ならECS/Fargate等を比較する。

アカウント追加を単なるquota迂回として行わず、明確なcell/tenant isolation境界と運用自動化を伴わせる。ProGloveの事例ではaccount-per-tenantにより各アカウント固有のLambda concurrencyやAPI Gateway throttleも分離しているが、それを支えるaccount factoryと集中展開を構築している。[^3]

### 12. 信頼性

- すべてのnetwork callにconnection timeoutとrequest timeoutを設定する。
- retryはtransient errorだけ、指数backoff、full jitter、最大回数/総時間を定義する。
- retryするoperationは冪等にする。
- retryを複数layerで重ねない。原則として呼び出しチェーンの一箇所が所有する。
- async consumerはpartial batch failure、DLQ、redrive、poison message隔離を実装する。
- visibility timeoutは処理時間と再試行戦略から算出する。
- queue backlogに上限とbackpressureを設ける。
- control plane障害中もdata planeの既存tenant処理を継続できるようstatic stabilityを志向する。
- 障害範囲が大きくなったらcellを導入し、routing情報以外の状態共有を避ける。
- chaos/fault injection、dependency timeout、throttle、partial outageをstagingで定期試験する。

### 13. セキュリティ

- 認証と認可を分離し、認証済みでもtenant/resource単位の認可を必須化する。
- Lambda execution roleはfunction/task単位の最小権限。CDKでwildcard IAMをlintする。
- poolデータは`tenantId`をpartition keyへ含め、条件式とrepository wrapperで強制する。
- 重要操作はapplication audit logへ記録し、通常ログと保存・アクセス権を分ける。
- KMS keyの粒度はdata classとtenant tierで決める。
- Secrets Manager/Parameter Storeを使い、秘密を環境変数やイベントに埋め込まない。
- public endpoint、Function URL、Web Function endpointの認証・WAF・rate limit・egressを脅威モデルで確認する。
- tenant isolation testとして、異なるtenant token、改ざんtenant ID、推測ID、非同期event改ざんをCI/E2Eへ入れる。

### 14. リクエストトレーサビリティ

#### 識別子

- `requestId`：各入口リクエスト固有。
- `traceId`：分散トレースの技術的な実行経路。
- `correlationId`：同期・非同期・再実行をまたぐ一つの業務フロー。
- `eventId`：イベント重複排除。
- `causationId`：当該イベントを起こしたcommand/event。
- `idempotencyKey`：同一副作用の重複防止。
- `tenantId`、`cellId`、`service`、`operation`、`deploymentVersion`。

X-Rayはtrace IDでサービス間経路を結合し、API Gateway、Lambda、SQS、EventBridge等が異なる水準でcontext propagationを支援する。SQSからLambdaへのtraceは自動リンクでき、EventBridgeもPutEvents時にtrace contextが渡された場合はtargetへ伝播できる。[^43][^44][^45][^46]

ただしX-Rayはサンプリングされ、EventBridge archive replayでは元trace headerが保持されないなどの制約がある。そのため`correlationId`、`eventId`、`causationId`をイベントpayloadの正式なメタデータとして保存し、トレースとは独立して検索可能にする。[^47][^43]

#### 標準実装

- Powertools for AWS Lambda TypeScriptのLogger、Tracer、Metrics、Idempotency、Batch Processingを共通presetで使用する。[^48][^26]
- JSON構造化ログのみ許可し、PII maskingとfield allowlistを共通loggerで実装する。
- API入口で相関IDを生成または検証し、外部入力のtrace headerを無条件に信頼しない。
- Step FunctionsをLambda/SDKから開始するときはtrace headerを明示伝播する。API Gateway HTTP APIからの連携では自動化される場合がある。[^49]
- sampled trace、全件access log、業務audit logを別目的として扱う。
- ダッシュボードはservice、operation、tenant tier、cell、deployment versionで絞り込めるようにする。高cardinalityのtenant IDを通常CloudWatch Metrics dimensionへ無制限投入せず、ログ/traceまたは制御された集計基盤で扱う。

### 15. コスト

#### 管理単位

- request当たり、workflow当たり、job当たり、tenant/tier当たりの単位原価を定義する。
- API Gateway request、Lambda request/duration/provisioned concurrency、Step Functions transition、EventBridge/SQS request、DynamoDB RCU/WCU/storage、CloudWatch log/traceを含める。
- shared costはtenant activity、request、storage、workflow execution等の合理的driverで配賦する。

#### 最適化順序

1. 不要な処理・ログ・トレース・データ転送をなくす。
2. API GatewayからAWSサービスへのdirect integrationを検討する。
3. Lambda durationとmemoryをPower Tuningで実測する。Power Tuningはmemoryと実行時間・費用のtrade-offを比較できる。[^50]
4. arm64対応を検証する。
5. batch sizeとevent filteringを最適化する。
6. Provisioned ConcurrencyはSLO達成に必要なalias・時間帯だけに限定する。
7. Step Functions Standard/Expressを実行特性で比較する。
8. 安定した高稼働ワークロードはECS/Fargate等とのbreak-evenを再評価する。

Lambda Web Functionsはactive CPUと環境存続中memoryで課金され、Event Functionsはrequestと実行時間を基に課金されるため、I/O待ちが長いだけで必ずWeb Functionsが安いとは限らない。API候補ごとに本番相当traceからCPU active ratio、environment utilization、request durationを測定する。[^51][^21]

### 16. 開発標準

#### サービス内部構造

```text
src/
  entrypoints/       # http, event, queue, schedule
  application/       # use cases, commands, queries
  domain/            # entities, policies, domain events
  ports/             # repository/client interfaces
  adapters/          # DynamoDB, SQS, external API
  contracts/         # generated API/event types
  observability/     # service-local telemetry definitions
```

- handler内に業務ロジックを書かない。
- AWS SDK clientは再利用し、adapterで包む。
- tenant contextを引数で明示するかrequest-scoped contextから安全に取得する。
- service間clientはOpenAPI/AsyncAPI等から生成し、手書きHTTP呼び出しを避ける。
- unit testはdomain/application、contract testはprovider/consumer、integration testは実AWS managed serviceで実施する。
- LocalStack等は高速フィードバック用とし、AWS固有挙動の最終保証には使わない。

### 17. CDK/IaC

#### Construct階層

- **L1/L2 Construct**：AWS resource表現。
- **Platform L3 Construct**：`PavedApiService`、`PavedQueueConsumer`、`PavedWorkflow`、`TenantAwareTable`、`ObservableFunction`。
- **Service Stack**：1マイクロサービスのAPI、functions、workflow、queues、datastore、alarmsを所有。
- **Cell Stage**：複数service stackを特定cellへ配置。
- **Environment Stage**：account/region、shared control plane、cells、observabilityを構成。

共通Constructが自動付与するものは、暗号化、log retention、tracing、standard tags、alarms、DLQ、IAM boundary、tenant context middleware、deployment strategy、dashboard linkとする。業務要件を隠す過剰抽象化は避け、escape hatchと期限付き例外ADRを用意する。

#### スタック境界

- service stack間の直接resource referenceを避け、SSM parameter、CloudFormation exportの乱用も避ける。
- 契約はendpoint/event schemaとservice discovery情報で連携する。
- stateful resourceはtermination protection、retain/snapshot policyを環境別に設定する。
- bootstrap、pipeline、observability、control plane、data planeを分離する。
- CDK synth時にcdk-nag、IAM wildcard、public exposure、unencrypted storage、missing alarmsを検査する。

### 18. CI/CD

- `format → lint → typecheck → unit → contract → synth → policy → deploy ephemeral → integration → load smoke → canary → promote`を標準pipelineとする。
- OpenAPI/event schemaのbreaking changeを検出する。
- Lambda artifactとCDK assetを一度buildし、環境間で同一artifactをpromoteする。
- Lambda aliasとweighted routing、Web Function revision weight、API stage等、ランタイムに合うprogressive deliveryを使う。
- DB migrationはexpand/migrate/contractで後方互換を保つ。
- rollback不能なstate changeにはroll-forwardとreconciliation手順を用意する。
- security、load、tenant isolation testをpipelineへ組み込む。Amazonの継続的デリバリーでも、可用性を速度より優先し、load/security testをpipelineへ入れている。[^52]

### 19. 運用

- サービスごとにSLO、dashboard、alarm、runbook、on-call、dependency mapを必須化する。
- alarmは原因候補ではなく顧客影響に近いSLIを上位に置く。
- low-traffic alarm、queue age、throttles、concurrency、DLQ、error budget burnを標準化する。
- deployment markerをlogs/metrics/tracesへ付与する。
- 週次でSLO/error budget、月次でcost/capacity/quota、四半期でarchitecture/conformanceをレビューする。
- インシデント後は責任追及ではなく、検知、封じ込め、復旧、自動化、再発防止を更新する。

### 20. 例外とADR

指針から外れること自体を禁止せず、次を記録する。

- Context：負荷、データ、SLO、規制、チーム条件。
- Decision：選択と適用範囲。
- Alternatives：少なくとも2案。
- Consequences：費用、性能、運用、lock-in、移行。
- Evidence：負荷試験、見積り、PoC結果。
- Expiry/Review date：再評価日。
- Owner：意思決定と見直し責任者。

AWS Prescriptive Guidanceも、境界、データフロー、interfaceを最新化し、主要技術判断をADRへ残すことを推奨している。[^53]

## 主要な初期判断

| 論点 | 初期標準 | 例外に必要な根拠 |
|---|---|---|
| サービス粒度 | bounded context + owner + data + SLO + deploy unit | 独立scale/security/changeの証拠 |
| API compute | API Gateway + Lambda Event Functions | Web互換、streaming、active CPU比、p99/費用実測 |
| Lambda Web Functions | experimental profile | Event Functionsより良いSLO/TCO、制約受容 |
| Lambda MicroVMs | 通常APIでは禁止 | tenant code、agent sandbox、状態保持、VM隔離 |
| Lambda package | esbuildしたzip、arm64 | native/large dependencies、OCI supply chain |
| workflow | Step Functions可 | 単純処理なら不要。境界とownerを明記 |
| service間連携 | EventBridge + 必要箇所SQS | 即時応答が必要なら同期API |
| datastore | database-per-service | 移行期共有DBは期限・IAM/schema分離 |
| tenant model | pool、サービス単位でbridge/silo | 規制、noisy neighbor、性能、費用 |
| observability | Powertools + X-Ray/Application Signals + correlation envelope | OTel backend等への標準化ADR |
| concurrency | quota増枠 + reserved budgets + queues + cells | account分割は隔離モデルと自動化を必須化 |
| performance | API別p99 SLOと負荷試験 | Provisioned Concurrency等は測定結果必須 |

## 優先ADR一覧

最初の公開リポジトリには、次のADRを`proposed`または`accepted`で含める。

1. **ADR-0001 Microservice boundary definition**：業務能力、owner、data、SLO、deploy unit。
2. **ADR-0002 Repository strategy**：初期はmonorepo、サービス単位の独立pipeline/ownershipを維持。
3. **ADR-0003 Multi-account topology**：security、prod分離、control/data plane、cell拡張。
4. **ADR-0004 Tenant isolation models**：pool標準、bridge/silo昇格条件。
5. **ADR-0005 API Gateway HTTP vs REST API**：必要機能と費用。
6. **ADR-0006 Event Functions vs Web Functions**：benchmark protocolと採用条件。
7. **ADR-0007 Lambda MicroVM usage policy**：sandbox専用、通常API禁止。
8. **ADR-0008 zip vs Lambda container image**：native依存、size、build、起動試験。
9. **ADR-0009 Lambda vs ECS/Fargate**：実行時間、稼働率、CPU、memory、network。
10. **ADR-0010 Step Functions policy**：bounded context、Saga owner、Standard/Express。
11. **ADR-0011 Service communication**：sync、EventBridge、SQSの選択。
12. **ADR-0012 Data ownership**：database-per-service、shared DB移行例外。
13. **ADR-0013 Event envelope/versioning**：CloudEvents準拠範囲、PII禁止。
14. **ADR-0014 Idempotency and retry**：key、保存期間、retry owner。
15. **ADR-0015 Trace and correlation**：X-Ray/OTel、correlationId、replay。
16. **ADR-0016 SLO and performance budgets**：p99、error budget、load test。
17. **ADR-0017 Lambda concurrency governance**：reserved budget、quota alarm、cell分割。
18. **ADR-0018 Cost attribution**：tenant/tier/service配賦。
19. **ADR-0019 CDK construct boundaries**：L3の責務とescape hatch。
20. **ADR-0020 Deployment strategy**：alias/revision、canary、rollback。

## テンプレートリポジトリ案

```text
.
├── apps/
│   ├── platform-cdk/             # environment/cell/control-plane composition
│   ├── example-order-service/    # sync API + DynamoDB + events
│   ├── example-worker-service/   # SQS + Lambda + DLQ/redrive
│   └── example-workflow-service/ # Step Functions + compensation
├── packages/
│   ├── constructs/               # paved-road CDK L3 constructs
│   ├── runtime-context/          # tenant/correlation/deadline context
│   ├── observability/            # Powertools presets, redaction
│   ├── api-contracts/            # OpenAPI generated types/clients
│   ├── event-contracts/          # event envelope and schemas
│   ├── testing/                  # fixtures, contract and isolation helpers
│   └── eslint-config/
├── docs/
│   ├── microservice-guidelines.md
│   ├── architecture/
│   ├── threat-models/
│   ├── runbooks/
│   └── adr/
├── schemas/
│   ├── openapi/
│   └── events/
├── tests/
│   ├── contract/
│   ├── integration/
│   ├── tenant-isolation/
│   ├── resiliency/
│   └── performance/
├── tools/
│   ├── create-service/
│   ├── power-tuning/
│   └── cost-model/
├── .github/
│   ├── workflows/
│   ├── CODEOWNERS
│   └── pull_request_template.md
├── cdk.json
├── pnpm-workspace.yaml
├── nx.json or turbo.json
└── catalog-info.yaml
```

### 提供するgolden path

- `pnpm create-service --type api|worker|workflow`でservice metadata、CDK stack、handler、tests、dashboard、runbook、ADRを生成。
- `PavedApiService`：API Gateway、Lambda、authorizer連携、structured logs、tracing、SLO alarm、deployment alias。
- `PavedQueueConsumer`：SQS、DLQ、partial batch response、concurrency、age alarm、redrive runbook。
- `PavedWorkflow`：Step Functions logging/tracing、timeout、retry preset、execution alarm。
- `TenantAwareTable`：tenant key規則、encryption、PITR、deletion policy、repository adapter。
- `ServiceObservability`：Application Signals、X-Ray、dashboard、error budget alarm。

Spotifyの事例のように、新サービス作成時点でbest practice、repository、deployment、ownershipを組み込むことが、文書だけで統制するより有効である。[^9]

## モック環境の最小スコープ

最初のCDKモックは機能を広げすぎず、指針の重要仮説を検証できる3サービスに絞る。

### Order API Service

- API Gateway HTTP API
- JWT authorizerまたはmock authorizer
- Lambda Event Functions
- DynamoDB tenant-partitioned table
- idempotent create API
- order-created eventのoutbox/stream発行

### Fulfillment Worker Service

- EventBridge subscription
- SQS buffer + DLQ
- Lambda consumer
- tenant tier別concurrency制御のサンプル
- partial batch failure、redrive、queue age alarm

### Provisioning Workflow Service

- Step Functions Standard
- service APIsまたはcommandsの呼び出し
- retry/backoff/timeout
- compensating action
- execution traceとcorrelation metadata

### 比較用experimental API

同じ業務ロジックをLambda Web FunctionsのHono/Fastify等で公開し、Event Functions版と次を比較する。

- cold/warm p50、p95、p99
- burst時のscale-outとthrottle
- request当たり費用
- streaming/long I/O時のCPU active ratio
- deployment artifact size/time
- trace/logの一貫性
- failure isolationとmemory pressure

Lambda Web Functionsは標準HTTPサーバ、複数同時リクエスト、native streamingを提供するため、Node.js PaaSのAPI層として将来性がある。ただし新規サービスである以上、最初から全面標準化せず、上記benchmarkの結果をADR-0006へ残す。[^54][^22]

## 受入基準

テンプレートのv0.1は以下を満たしたとき完成とする。

- 新規サービスが15分以内に生成され、sandboxへ自動デプロイできる。
- owner、SLO、runbook、contracts、ADRの欠落をCIが検出する。
- tenant Aのidentityでtenant Bのデータを取得・更新できないE2E testがある。
- 同一idempotency keyの並行リクエストで副作用が一度だけ発生する。
- API → Lambda → DynamoDB → EventBridge → SQS → Lambda → Step Functionsを`correlationId`で全件検索できる。
- X-Ray sampled traceでも同期・非同期経路を確認できる。
- dependency timeout、throttle、poison message、DLQ、workflow compensationを試験できる。
- p99 latency、availability、queue age、throttles、concurrency、cost estimateをdashboardで確認できる。
- reserved concurrencyによりcritical APIがworker burstから保護される。
- cdk-nag/policy testがpublic exposure、wildcard IAM、暗号化漏れを拒否する。
- `cdk destroy`時にstateful production resourceを誤削除しない。

## 実装ロードマップ

### Phase 0：意思決定

- ADR-0001〜0017のうち、境界、tenant、API、workflow、data、trace、concurrencyを先に確定。
- 想定RPS、tenant数、burst、payload、SLO、データ分類を1枚のworkload profileへ記録。

### Phase 1：最小golden path

- monorepo、CDK app、API Service、DynamoDB、Powertools、OpenAPI、CI。
- prod/non-prod account分離と標準tagging。
- service catalog metadataとCODEOWNERS。

### Phase 2：非同期とワークフロー

- EventBridge、SQS、DLQ、Step Functions、event schema、correlation envelope。
- timeout/retry/idempotency/resiliency tests。

### Phase 3：性能と費用

- Lambda Power Tuning、load test、Application Signals SLO、concurrency dashboard。
- Event Functions対Web Functionsの比較。
- tenant/tier別cost attributionのPoC。

### Phase 4：セルと分離

- tenant registry、cell router、cell deployment stage。
- quota、blast radius、tenant migrationのgame day。
- 必要なtierだけsilo/account-per-tenantを実証。

この順序なら、新しいAWSプリミティブに設計全体を依存させず、責任境界、開発速度、トレーサビリティを先に固めたうえで、計測結果に基づいてWeb Functions、MicroVMs、Fargate、cell構成へ拡張できる。

---

## References

1. [Serverless SaaS - SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/serverless-saas.html) - authorizer), it maps each tenant’s requests to microservices, and

2. [SaaS Lens - AWS Well-Architected Framework](https://docs.aws.amazon.com/ja_jp/wellarchitected/latest/saas-lens/wellarchitected-saas-lens.pdf) - Finally, we’ve also highlighted a collection of microservices that represent the shared services tha...

3. [Lessons learned from scaling to 1 million Lambda functions](https://aws.amazon.com/blogs/architecture/lessons-learned-from-scaling-to-1-million-lambda-functions/) - In this post, we share our journey and the lessons learned from building and running a fully serverl...

4. [REL05-BP03 Control and limit retry calls - AWS Well- ...](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_mitigate_interaction_failure_limit_retries.html) - Introduce jitter between retries to randomize retry intervals.
...
Jitter avoids alignment of reques...

5. [Timeouts, retries, and backoff with jitter](https://d1.awsstatic.com/builderslibrary/pdfs/timeouts-retries-and-backoff-with-jitter.pdf) - Instead of retrying immediately and aggressively, the client waits some amount of time between tries...

6. [Avoiding insurmountable queue backlogs](https://aws.amazon.com/builders-library/avoiding-insurmountable-queue-backlogs/?did=ba_card&trk=ba_card) - This quickly catches cases where the systems are behind, or are frequently erroring out and causing ...

7. [6000 AWS accounts, three people, one platform](https://aws.amazon.com/blogs/architecture/6000-aws-accounts-three-people-one-platform-lessons-learned/) - This post describes why we chose a account-per-tenant approach for our serverless SaaS architecture ...

8. [Stream with Evertz SaaS playout platform evertz.io](https://aws.amazon.com/blogs/media/stream-with-evertz-saas-playout-platform-evertz-io/) - To offload the undifferentiated heavy-lifting of managing infrastructure, our approach has been serv...

9. [What the Heck is Backstage Anyway? | Spotify Engineering](https://engineering.atspotify.com/2020/3/what-the-heck-is-backstage-anyway) - Ownership information is automatically captured in our service/software catalog and users can see a ...

10. [Seamlessly Swapping the API backend of the Netflix ...](https://netflixtechblog.com/seamlessly-swapping-the-api-backend-of-the-netflix-android-app-3d4317155187) - With the rich end-to-end tracing instrumented in the Netflix microservice ecosystem and made easily ...

11. [docs.aws.amazon.com › pdfs › wellarchitectedOperational Excellence Pillar - AWS Well-Architected Framework](https://docs.aws.amazon.com/pdfs/wellarchitected/latest/operational-excellence-pillar/wellarchitected-operational-excellence-pillar.pdf) - Verify that there are identified owners for each application, workload, platform, and infrastructure...

12. [Multi-tenant microservices - SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/multi-tenant-microservices.html) - To achieve this goal, SaaS microservices—regardless of their
compute model—should introduce librarie...

13. [Building Serverless SaaS Microservices with AWS Lambda Layers](https://aws.amazon.com/blogs/apn/building-serverless-saas-microservices-with-aws-lambda-layers/) - The general strategy that is applied in this post is to move the common code that accesses and appli...

14. [faq.md](https://docs.aws.amazon.com/wellarchitected/latest/reducing-scope-of-impact-with-cell-based-architecture/faq.md) - In a cell-based architecture, a cell should be self-contained, not share its state.

15. [[PDF] micro-frontends-aws.pdf](https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/micro-frontends-aws/micro-frontends-aws.pdf) - In a microservices architecture, the backend is decomposed into small services, each addressing a pa...

16. [docs.aws.amazon.com › pdfs › prescriptive-guidanceDecomposing monoliths into microservices AWS Prescriptive ...](https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/modernization-decomposing-monoliths/modernization-decomposing-monoliths.pdf) - Each subdomain has a model, and the scope of that model is called a bounded context.

17. [docs.aws.amazon.com › modernization-data-persistenceEnabling data persistence in microservices AWS Prescriptive...](https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/modernization-data-persistence/modernization-data-persistence.pdf) - Loose coupling is the core characteristic of a microservices architecture, because each individual m...

18. [AWS Documentation](https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-data-persistence/database-per-service.md) - You can use the API composition pattern (which you can speed up with the CQRS pattern) or the event ...

19. [Cost optimization - Best Practices for Designing Amazon API ...](https://docs.aws.amazon.com/whitepapers/latest/best-practices-api-gateway-private-apis-integration/cost-optimization.html) - First 333 million requests (per month): $3.50 (per million) 2.

20. [Amazon API Gateway Pricing](https://aws.amazon.com/api-gateway/pricing/) - For HTTP APIs and REST APIs, you pay only for the API calls you receive and the amount of data trans...

21. [What is AWS Lambda?](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html) - Your Node.js code listens on a port and handles HTTP requests directly, using web frameworks such as...

22. [AWS Lambda announces Lambda Web Functions - AWS](https://aws.amazon.com/jp/about-aws/whats-new/2026/10/aws-lambda-web-functions/) - Lambda Web Function は、こうしたニーズを実現します。現在、Lambda Web Function では Node.js ランタイムがサポートされています。1 つのウォーム実行環境で...

23. [AWS Lambda MicroVMs - Amazon.com](https://aws.amazon.com/lambda/lambda-microvms/) - Launch your own isolated Firecracker-powered sandbox that starts near-instantly and preserves full m...

24. [docs.aws.amazon.com › lambda › latestAWS Documentation](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.md) - Lambda sets quotas for the amount of compute and storage resources that you can use to run and store...

25. [Implementing idempotent AWS Lambda functions with ...](https://aws.amazon.com/blogs/compute/implementing-idempotent-aws-lambda-functions-with-powertools-for-aws-lambda-typescript/) - Use the `X-Idempotency-Key` header for your idempotency key.

26. [Support Powertools For Aws](https://docs.aws.amazon.com/powertools/typescript/latest/) - |Tracer|Decorators and utilities to trace Lambda function handlers, and both synchronous and asynchr...

27. [From AWS Lambda orchestration to AWS Step Functions](https://aws.amazon.com/blogs/compute/streamlining-aws-serverless-workflows-from-aws-lambda-orchestration-to-aws-step-functions/) - Step Functions is a serverless workflow service that you can use to build distributed applications, ...

28. [Operating Lambda: Anti-patterns in event-driven architectures – Part 3](https://aws.amazon.com/blogs/compute/operating-lambda-anti-patterns-in-event-driven-architectures-part-3/) - The alternative is to decompose the monolithic Lambda function into individual microservices, mappin...

29. [Building a serverless distributed application using a saga ...](https://aws.amazon.com/blogs/compute/building-a-serverless-distributed-application-using-a-saga-orchestration-pattern/) - When a customer calls the API, the invocation occurs, and pre-processing occurs in the Lambda functi...

30. [Using Container Images with AWS Lambda](https://builder.aws.com/content/3JqgZrVEL3fiHe3XF6SPMAtK6OD/using-container-images-with-aws-lambda) - Container image cold starts were historically slower due to image-loading overhead, but Lambda cache...

31. [Create a Lambda function using a container image](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html) - - For optimal performance, keep your image manifest size under 25,400 bytes.

32. [Enabling data persistence in microservices - AWS Documentation](https://docs.aws.amazon.com/ja_jp/prescriptive-guidance/latest/modernization-data-persistence/introduction.html) - By choosing to decentralize your data stores, you promote polyglot persistence among your microservi...

33. [Track performance of serverless applications built using AWS Lambda with Application Signals | Amazon Web Services](https://aws.amazon.com/jp/blogs/aws/track-performance-of-serverless-applications-built-using-aws-lambda-with-application-signals/) - In addition, you can define Service Level Objectives (SLOs) on your applications to monitor specific...

34. [monitoring-application-signals.md](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-application-signals.md) - For example, you can create latency SLOs to ensure your application responds quickly to user request...

35. [[O.SI.5] Set and monitor service level objectives against ...](https://docs.aws.amazon.com/wellarchitected/latest/devops-guidance/o.si.5-set-and-monitor-service-level-objectives-against-performance-standards.html) - When defining SLOs, rather than using averages, it is
preferable to use percentiles for measurement.

36. [cost-and-performance-optimization.md](https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/cost-and-performance-optimization.md) - In addition, consider configuring new and existing functions to run on ARM or Graviton processors.

37. [Lambda cost and performance optimization](https://docs.aws.amazon.com/ja_jp/wellarchitected/latest/serverless-applications-lens/cost-and-performance-optimization.html) - In addition, consider configuring new and existing functions to run on ARM or Graviton

38. [Resilience lessons from the lunch rush](https://aws.amazon.com/it/builders-library/resilience-lessons-from-the-lunch-rush/) - It can protect a service from becoming overwhelmed during transient spikes in load and give us time ...

39. [Understanding Lambda function scaling](https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html) - - **At the account level**, your Event Functions can have up to 1,000 units of concurrency by defaul...

40. [Configuring reserved concurrency for a function](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html) - You can reserve up to the **Unreserved account concurrency** value minus 100.

41. [AWS Lambda supports additional concurrency metric for improved quota monitoring - AWS](https://aws.amazon.com/about-aws/whats-new/2023/12/aws-lambda-concurrency-metric-quota-monitoring/) - Customers can now use ClaimedAccountConcurrency metric to track their overall account concurrency av...

42. [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) - |Concurrent executions|1,000|Tens of thousands|
...
|Function concurrency scaling limit|For each fun...

43. [Amazon EventBridge integration with AWS X-Ray](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-related-service-xray.html) - EventBridge can pass a trace header for an event only if the event came from a

44. [Amazon SQS and AWS X-Ray](https://docs.aws.amazon.com/xray/latest/devguide/xray-services-sqs.html) - AWS X-Ray supports tracing event-driven applications using Amazon SQS and AWS Lambda.

45. [AWS X-Ray concepts](https://docs.aws.amazon.com/xray/latest/devguide/xray-concepts.html) - The sampling decision and trace ID are added to HTTP requests in **tracing headers** named `X-Amzn-T...

46. [Integrated Services](https://docs.aws.amazon.com/xray/latest/devguide/xray-services.html) - If a service traces requests by using the X-Ray SDK, Amazon SQS can send the tracing header and cont...

47. [Visualize Lambda function invocations using AWS X-Ray](https://docs.aws.amazon.com/lambda/latest/dg/services-xray.html) - Amazon EC2 that is instrumented with the X-Ray SDK, decides whether incoming requests should be

48. [aws.amazon.com › powertools-for-aws-lambdaPowertools for AWS Lambda](https://aws.amazon.com/powertools-for-aws-lambda/) - Distributed tracing with AWS X-Ray integration, automatic metadata capture, and custom annotations s...

49. [docs.aws.amazon.com · step-functions · latestTrace Step Functions request data in AWS X-Ray](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-xray-tracing.html) - `Root={TRACE_ID};Sampled={1 or 0}`.

50. [Filtering Incoming Events](https://aws.amazon.com/blogs/compute/understanding-techniques-to-reduce-aws-lambda-costs-in-serverless-applications/) - AWS Lambda Power Tuning is an open-source tool that can be used to empirically find the optimal memo...

51. [AWS Lambda Pricing](https://aws.amazon.com/lambda/pricing/) - 1. Request charges: $0.20 per million requests · 2. Compute management fee: 15% premium on the EC2 o...

52. [Going faster with continuous delivery](https://aws.amazon.com/builders-library/going-faster-with-continuous-delivery/?did=ba_card&trk=ba_card) - Software teams at Amazon have a high bar for testing, and spend a lot of effort on it, because ownin...

53. [AWS Prescriptive Guidance - Database decomposition on AWS](https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/database-decomposition/database-decomposition.pdf) - Build resilient systems by adding retry logic for cross-service calls and implementing appropriate c...

54. [lambda-web¶](https://docs.aws.amazon.com/cli/latest/reference/lambda-web/) - You can use familiar Node.js web frameworks such as Express, Hono, or React Router with no Lambda-sp...

