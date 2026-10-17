# 技術選定根拠

本テンプレートで採用した AWS サービスとライブラリについて、**採用理由 / 運用実態（quota、障害モード、費用形状、on-call 負荷）/ 使わない条件 / 代替 / 指針参照 / 出典** を記す。「最新だから」ではなく、中規模 B2B マルチテナント PaaS を少人数で運用できるかを基準にしている（指針 §2 Managed-first、Serverless-first not serverless-only、Evidence over defaults）。

**数値の扱い**：quota・料金・上限はすべて `docs/review/evidence-register.md` の出典に基づき、確認日は 2026-10-17 である。ADR へ転記する際は必ず最新の AWS ドキュメントで再確認する。出典で確認できなかった事項は「既定値（例示値）: … 調整: TD-NN」または「計測で確定: … M-NN」（`docs/decision/template-defaults.md`）と明記し、仮定として扱う。

---

## 1. API 層

### API Gateway HTTP API

- **採用理由**：JWT authorizer、ルーティング、CORS、自動デプロイ、Lambda 統合が揃い、REST API より request 単価が低い。薄い JWT API という本 PaaS の標準形に過不足がない。
- **運用実態**：アカウント throttle は既定 10,000 RPS / burst 5,000 で、HTTP API・REST API・WebSocket が同一リージョンで共有する（増枠可）。per-client throttling と usage plan は REST API 専用なので、tier 別制御は authorizer / サービス側で行う。WAF 直接統合と X-Ray も REST API 専用で、HTTP API は CloudFront 経由で WAF を前段に置く。integration timeout は HTTP API が 30 秒で増枠不可、REST API は 29 秒で Regional / private のみ増枠可（throttle quota とのトレードオフがある。E-03、E-95）。access log は明示的に有効化する。
- **使わない条件**：API key / usage plan / per-client throttling、request validation、body 変換、キャッシュ、private API、canary release、response streaming が必要な場合。
- **代替**：REST API（上記機能が必要なとき）。Lambda Web Functions + 独自 endpoint は認証・WAF・rate limit の脅威モデルが別途必要なため、API 層の標準にはしない。
- **指針参照**：§6、ADR-0005、DT-5
- **出典**：E-04、E-02、E-03、E-93

### Lambda Event Functions（arm64、zip、esbuild）

- **採用理由**：1リクエスト 1 invocation の明確な実行モデルが、関数単位の IAM・同時実行境界・SLO 計測と整合する。arm64 は duration 課金が x86 比 20% 低く、最大 34% の価格性能向上が公表されている。zip + esbuild は bundle が小さく、OCI supply chain 管理が不要。
- **運用実態**：アカウント同時実行 quota は既定 1,000（新規アカウントは縮小値から自動引き上げ、申請で数万まで）。reserved / provisioned concurrency はこの quota を消費し、未予約用に 100 が残る。関数ごとのスケールは 1,000 環境 / 10 秒。timeout 上限 900 秒、payload 同期 6 MB / 非同期 1 MB / streaming 200 MB、zip 50 MB（圧縮）/ 250 MB（展開）、環境変数 4 KB。throttle は 429 として上流に返るため、`Throttles`・`ConcurrentExecutions`・`ClaimedAccountConcurrency` の alarm が必須。料金は $0.20/100 万リクエスト + GB-秒（x86 $0.0000166667、arm はその 80%）。on-call の典型対応は throttle 時の reserved 調整と quota 申請。
- **使わない条件**：15 分超、継続高稼働（Lambda 単価が Fargate を上回る）、daemon、特殊 network、native 依存が arm64 非対応（x86_64 に戻す）。
- **代替**：container image（大規模 native 依存）、ECS/Fargate（長時間・高稼働）、Web Functions（複数同時 HTTP・streaming。experimental で比較）、MicroVMs（sandbox 専用）。
- **指針参照**：§6、§8、§10、§11、ADR-0006/0007/0008/0009/0017、DT-3
- **出典**：E-01、E-30、E-31、E-29、E-84、E-32

## 2. データとイベント

### DynamoDB（`TenantAwareTable`）

- **採用理由**：pool モデルで `tenantId` を partition key 先頭に置けば、条件式と IAM（`dynamodb:LeadingKeys`）でテナント境界を構造的に強制できる。サーバレスでスケールし、接続数管理が不要で Lambda と相性がよい。PITR、TTL、Streams、KMS が組み込み。
- **運用実態**：1 partition の上限は 3,000 RCU / 1,000 WCU で、tenant skew が大きいと特定テナントが partition を占有し throttle する。テーブル単位の既定 quota は 40,000 RCU/WCU（on-demand も同じ、増枠可）。on-demand は前回ピークの 2 倍まで即時対応するが、30 分以内に 2 倍超を受けると throttle しうる。GSI は 20/テーブルで、`Scan` は `LeadingKeys` 条件を無視するため許可しない。費用は RCU/WCU/storage と GSI の write amplification で決まる。item size 上限は 400 KB（属性名を含む。E-96）。
- **使わない条件**：ad hoc クエリ、複雑な JOIN、多表トランザクション、外部キー制約が本質的な場合。
- **代替**：Aurora/RDS + RDS Proxy（関係モデルが本質）。横断クエリは read model / CQRS。
- **指針参照**：§5、§9、§13、ADR-0012、DT-7
- **出典**：E-06、E-05、E-07、E-08、E-62

### DynamoDB Streams による outbox

- **採用理由**：DB 更新とイベント発行の dual write 問題を、別途 outbox テーブルを polling するより単純に解決できる（AWS Prescriptive Guidance が CDC 実装として DynamoDB Streams を示す）。Lambda event source として partial batch failure と on-failure destination を使える。
- **運用実態**：retention 24 時間。consumer が 24 時間以上止まるとイベントが失われるため、iterator age alarm が必須。順序は同一 item 単位で保証され、shard 間は保証されない。失敗 batch は既定で shard を止めて retry するため、`BisectBatchOnFunctionError`、`MaximumRetryAttempts`、`MaximumRecordAgeInSeconds`、DLQ 宛先で poison record を隔離する。同一 shard の同時読取は 2 process まで。
- **使わない条件**：外部サービスへの公開契約として（内部データモデルが露出する）。Streams を介さず直接 PutEvents してよいのは、欠落と重複を契約で許容できる場合のみ。
- **代替**：outbox テーブル + polling（Aurora 利用時）、EventBridge Pipes（Streams → EventBridge を Lambda なしで変換できる場合）。
- **指針参照**：§7、§9、AP-16
- **出典**：E-48、E-09、E-10、E-05、E-14

### EventBridge

- **採用理由**：サービス間の業務イベントを schema registry、rule によるルーティング、archive/replay 付きで配信でき、producer が consumer を知らずに済む。target ごとの DLQ と retry を持つ。
- **運用実態**：PutEvents は 1 リクエスト合計 1 MB で、超える場合は S3 に置いて Object URL を渡す。PutEvents TPS はリージョン別（us-east-1 10,000、その他は数百〜数千、増枠可）。rule あたり target は 5 まで、rule は bus あたり 300。配信は at-least-once で target 側の冪等性が前提。target の Lambda 直結は fan-out を制御できないため、各購読者は SQS で受ける。archive 済みイベントと replay には trace header が含まれず、envelope の `correlationId` が唯一の追跡手段になる。retry は最大 185 回・24 時間（custom bus v2）。
- **使わない条件**：1対1のバッファ用途（SQS で十分）、順序保証が必要な場合、ミリ秒級の応答が必要な場合。
- **代替**：SQS Standard（1対1）、Pipes（point-to-point + enrichment）、SNS（単純 push fan-out）、同期 API（即時性）。
- **指針参照**：§7、§14、ADR-0011/0013/0015、DT-6
- **出典**：E-12、E-11、E-13、E-14、E-59

### SQS Standard（`PavedQueueConsumer`）

- **採用理由**：バッファ、バックプレッシャー、再試行（redelivery）、DLQ、consumer scaling を最も単純に提供する。Lambda event source の `maxConcurrency`（2〜1,000）で下流容量に合わせた平準化ができる。標準キューに `MessageGroupId` を付けるだけで fair queues が有効になり、multi-tenant の noisy neighbor を自動緩和できる。
- **運用実態**：at-least-once・順序なし。visibility timeout は関数 timeout の 6 倍以上（+ batch window）に設定し、関数 timeout が visibility timeout を超えると event source mapping の作成が失敗する。既定では batch 内 1 件失敗で全件が再可視化されるため `ReportBatchItemFailures` が必須。`ApproximateNumberOfMessagesVisible` だけでは遅延に気づけず、`ApproximateAgeOfOldestMessage` の alarm が必須。DLQ は retention を元キューより長くしないと移動後すぐ失効する。メッセージ 1 MiB 上限、保持既定 4 日・最大 14 日、visibility timeout 最大 12 時間。consumer は 5 並列から +300/分で最大 1,250。
- **使わない条件**：複数購読者への配信（EventBridge）、順序必須（FIFO、ただし 300 TPS/partition と DLQ での順序崩れ）、遅延許容がない処理。
- **代替**：SQS FIFO（順序）、EventBridge（fan-out）、Pipes（enrichment）、Kinesis（高スループット順序付きストリーム。本テンプレートの規模では過剰）。
- **指針参照**：§7、§10、§12、AP-08/13、DT-6
- **出典**：E-15、E-16、E-17、E-18、E-19、E-20、E-54

### Step Functions Standard（`PavedWorkflow`）

- **採用理由**：状態遷移・分岐・待機・再試行・補償を宣言的に書け、実行履歴が監査証跡になる。native service integration で wrapper Lambda を減らせる。Saga orchestration の実装先として AWS Prescriptive Guidance が示す。Standard は exactly-once で、同名実行に冪等応答を返す。
- **運用実態**：Standard は transition 課金（$0.000025/transition）で、ループの多いワークフローは高くつく。実行履歴 25,000 events 上限で、長いループは Distributed Map か子実行に分割する。state 入出力 256 KiB 上限（超える場合は S3 ARN）。履歴は 90 日保持、redrive は 14 日以内。Task に `TimeoutSeconds` がないと実行が stuck する。Lambda の一時エラー（`Lambda.ServiceException` 等）は `Retry` で処理する。実行履歴に PII が残ると削除できないため、データ分類を先に決める。
- **使わない条件**：単純な直列処理（Lambda 1 関数で足りる）、高スループット短時間で冪等（Express）、他サービスの DB を直接更新したくなる場合（設計違反）。
- **代替**：Express（5 分以内、at-least-once、$1/M + GB-秒。`.sync` / `.waitForTaskToken` / Distributed Map 非対応）、SQS chain、EventBridge Pipes。
- **指針参照**：§8、§15、ADR-0010、AP-03/04/18、DT-2/DT-8
- **出典**：E-21、E-22、E-23、E-24、E-49

## 3. セキュリティ

### KMS

- **採用理由**：DynamoDB、SQS、S3、Logs、Secrets の暗号化を customer managed key で統一し、data class と tenant tier ごとに鍵の粒度を変えられる。鍵ポリシーがテナント境界の一部になる。
- **運用実態**：$1.00/key/月と対称鍵 API $0.03/10,000 リクエストの課金がある。鍵の削除は 7〜30 日（既定 30 日）の待機期間があり、削除後は復旧不能なので `RemovalPolicy.RETAIN` が必須。silo テナントの個別鍵は鍵数と rotation 管理が増える。
- **使わない条件**：AWS managed key で要件を満たす非機密データ（ただし `dataClassification` が internal 以上は CMK を標準とする）。
- **代替**：AWS managed key（低分類データ）、external key store（規制要件、silo）。
- **指針参照**：§13、§17
- **出典**：E-25、E-26、E-36

### Secrets Manager

- **採用理由**：rotation、バージョニング、IAM による取得制御があり、環境変数・イベント・Step Functions state への秘密埋め込みを避けられる。
- **運用実態**：$0.40/secret/月と $0.05/10,000 API calls の課金があるため、Lambda では Powertools Parameters で既定 5 秒キャッシュする。
- **使わない条件**：秘密でない設定値（Parameter Store）。
- **代替**：SSM Parameter Store SecureString（rotation 不要な秘密、Powertools Parameters で同様に扱える）。
- **指針参照**：§13
- **出典**：E-27、E-41、E-24

## 4. 可観測性

### CloudWatch Logs / Metrics / X-Ray / Application Signals

- **採用理由**：Lambda・API Gateway・SQS・Step Functions と追加設定なしに統合され、Application Signals で SLO（availability、latency）を宣言的に定義できる。少人数運用で別基盤を持たない。
- **運用実態**：Logs 取り込み $0.50/GB が最大のコスト要因になりやすく、retention と log level を `ObservableFunction` で既定化する。custom metric は $0.30/metric/月（最初の 10,000）で、dimension の一意な組合せごとに別メトリクスになるため tenant ID を dimension にしない（EMF 仕様も `requestId` 等の高 cardinality を警告）。X-Ray は既定で毎秒 1 件 + 5% のサンプリングで、サンプリング判断は parent-based（入口で決まる）。$5/100 万 traces。EventBridge の archive replay では trace header が失われる。ログ保持は 3 か月〜1 年を即時検索可能、最長 7 年が Well-Architected の目安。
- **使わない条件**：組織が既に OTel backend を標準化している場合は ADR-0015 で統一先を決める。
- **代替**：OpenTelemetry + 外部 backend。ただし correlation envelope と構造化ログの要件は変わらない。
- **指針参照**：§10、§14、§19、ADR-0015/0016、AP-10/14
- **出典**：E-42、E-43、E-28、E-13、E-44、E-81

### Powertools for AWS Lambda (TypeScript)（`@paas/observability`）

- **採用理由**：Logger（常に JSON、相関 ID 注入）、Tracer、Metrics（EMF）、Idempotency（DynamoDB persistence）、Batch Processing（partial batch failure）、Parameters を AWS が保守しており、独自実装を避けられる。Lambda の公式ベストプラクティスが構造化ログ・EMF・冪等性・batch 処理の実装先として名指ししている。
- **運用実態**：Idempotency は DynamoDB テーブルと TTL を要し、key は event 全体または `eventKeyJmesPath` の hash で既定 1 時間失効。異なる JMESPath を同一 persistence で共有すると stale result を返しうるため、tenant + operation + key を key に含める。`payloadValidationJmesPath` で改ざんを検知できる。Logger の `logEvent` は機密防止のため既定無効で、本番で有効にしない。Tracer は X-Ray サンプリングに従う。Parameters は既定 5 秒キャッシュ。
- **使わない条件**：Fargate 等の非 Lambda ランタイム（OTel SDK を使う）。
- **代替**：pino + OTel SDK（独自 preset の保守コストが乗る）。
- **指針参照**：§14、§6、§12、ADR-0014/0015
- **出典**：E-32、E-39、E-40、E-41、E-18

## 5. IaC と開発基盤

### AWS CDK v2（`@paas/constructs`）

- **採用理由**：TypeScript で L3 Construct（`PavedApiService` 等）を定義し、暗号化・log retention・tracing・tags・alarms・DLQ・IAM boundary を自動付与する「paved road」を型で強制できる。アプリと同じ言語・同じ monorepo で管理でき、Aspects で policy-as-code を synth 時に適用できる。
- **運用実態**：stateful resource の logical ID を変えると置換されるため、`cdk diff` の確認、`RemovalPolicy.RETAIN`、別 stack + termination protection、logical ID の unit test が必須。CloudFormation の stack あたり 500 resource 上限。物理名の固定は置換不能を招くため生成名を使う。`cdk.context.json` をコミットして synth を決定的に保つ。CDK 公式が「Construct だけでは compliance を強制できない」とし、SCP / permission boundary / Aspects / cfn-guard の併用を求めている。
- **使わない条件**：既に Terraform / Pulumi を全社標準としている場合（ADR-0019 で判断）。
- **代替**：Terraform、SAM、Pulumi。
- **指針参照**：§17、ADR-0019、受入基準
- **出典**：E-36、E-35

### cdk-nag（`PlatformGuardrails`）

- **採用理由**：synth 時に wildcard IAM、public exposure、未暗号化、ログ未設定を機械的に拒否でき、レビュアの目視に依存しない。AWS Solutions / HIPAA / NIST 800-53 / PCI DSS / Serverless の rule pack が保守されている。
- **運用実態**：false positive があり、suppress の `reason` が形骸化しやすい。テンプレートは v2 系（`NagSuppressions`）を使うが、v3 では `Validations.of(construct).acknowledge({ id, reason })` に置き換わるため、バージョン固定と移行計画が要る。suppress には ADR 番号または具体的理由を必須にし、CI で「TODO」「暫定」を含む reason を拒否する。
- **使わない条件**：なし（テンプレートでは必須）。
- **代替**：CloudFormation Guard、OPA（組織標準がある場合に併用）。
- **指針参照**：§17、受入基準、AP-25
- **出典**：E-38、E-36

### esbuild（`NodejsFunction` bundling）

- **採用理由**：tree-shaking で bundle を小さくし、コールドスタートを短縮する。SDK v3 同梱 runtime では `@aws-sdk/*` が既定で external になる。TypeScript を型チェックなしで高速にトランスパイルする。
- **運用実態**：型チェックは別 step（`tsc --noEmit`）で行わないと型エラーが本番に出る。native module は bundle できず `nodeModules` 指定か `forceDockerBundling`、または container image が必要。zip 上限は 50 MB（圧縮）/ 250 MB（展開）。
- **使わない条件**：native 依存が多い、bundle 後に zip 上限を超える。
- **代替**：Lambda container image、Lambda layer（共通依存の分離）。
- **指針参照**：主要な初期判断 Lambda package、ADR-0008
- **出典**：E-37、E-01、E-90

### pnpm + turbo（monorepo）

- **採用理由**：サービスと共通パッケージを1リポジトリで管理し、`@paas/*` の変更を同一 PR で検証できる。pnpm の厳密な依存解決で phantom dependency を防ぎ、turbo のキャッシュで CI 時間を抑える。サービス単位の pipeline と CODEOWNERS を維持できる。
- **運用実態**：共通パッケージの変更が全サービスの再ビルド・再テストを誘発し、ライブラリ経由の分散モノリス（AP-21）になりやすい。`packages/` に業務ロジックを置かないルールと、contract test による影響範囲の明示が前提。CDK 公式は「1 CDK app = 1 package = 1 repository」を推奨し、複数 app を同一 repository に置くと blast radius が広がると警告しているため、サービス単位の独立 pipeline が条件になる。肥大化したら polyrepo 分割を ADR-0002 で再評価する。
- **使わない条件**：チームが組織的に分離され、リリース権限が完全に独立している場合（polyrepo）。
- **代替**：nx、polyrepo + 共通パッケージの registry 配布（CodeArtifact 等）。
- **指針参照**：§4 必須ルール、§16、ADR-0002
- **出典**：E-36、E-46、E-63

### vitest（`@paas/testing`）

- **採用理由**：ESM と TypeScript をネイティブに扱い、高速。unit、contract、integration、tenant-isolation、resiliency の各テストを同一ランナーで書ける。
- **運用実態**：integration test は実 AWS（ephemeral stack）に対して実行するため、AWS 認証情報と stack ライフサイクルの管理が必要。LocalStack は高速フィードバック用に留め、AWS 固有挙動（IAM 条件、Streams の順序、throttle）の最終保証には使わない。Amazon の継続的デリバリーでも load / security test を pipeline に入れている。並列実行で DynamoDB の test データが衝突しないよう `@paas/testing` の fixture でテナント ID を分離する。
- **使わない条件**：なし。
- **代替**：jest（既存資産がある場合）。
- **指針参照**：§16、§13、受入基準
- **出典**：E-88、E-36（synth の決定性と unit test）、E-47

### zod（`@paas/api-contracts`、`@paas/event-contracts`）

- **採用理由**：OpenAPI / event schema から生成した型と実行時 validation を同じ定義から得られ、handler 入口での検証と envelope の parse を統一できる。`tenantId` 等の必須フィールド欠落を実行時に拒否する。
- **運用実態**：巨大 schema の parse はコールドスタートと duration に影響するため、生成コードを bundle に含めつつ不要な deep validation を避ける。生成ツールのバージョン差で生成結果が変わるため、生成物をコミットし diff をレビューする。
- **使わない条件**：なし（軽量な代替へ切り替える場合は ADR）。
- **代替**：ajv（JSON Schema 直接）、typebox。
- **指針参照**：§6、§7、§16
- **出典**：E-59、E-60、E-32（入力検証と冪等コード）

### OpenAPI 3.1（`schemas/openapi/`）と CloudEvents 1.0

- **採用理由**：同期 API 契約の正本として、型・validation・SDK・contract test・ドキュメントを単一ソースから生成できる。イベント包絡は CloudEvents 1.0.2 の必須属性（`id`、`source`、`specversion`、`type`）に拡張属性（`tenantId`、`correlationId`、`causationId`）を加える形で、独自仕様を増やさない。エラー応答は RFC 9457 の構造に揃える。
- **運用実態**：手書き YAML が実装と乖離しやすいため、生成物のコミットと contract test を必須にする。version 戦略（path / header）と expand/migrate/contract を最初に決めないと破壊的変更の扱いが場当たりになる。API Gateway の定義は CDK 側で持ち、OpenAPI は契約専用とする。
- **使わない条件**：なし。
- **代替**：AsyncAPI（イベント契約の文書化）、GraphQL schema（AppSync を採用する場合。本テンプレートでは未採用）。
- **指針参照**：§6、§7、§16、§18、ADR-0013
- **出典**：E-60、E-59、E-58、E-65

---

## 最新技術での再検討

本書の出典が古くなった選定（出典 24 か月超、リリースノート 12 か月無更新、EOL 18 か月以内）は、本質を取り出して最新技術で検証し直す。2026-10-17 時点の検証は [latest-tech-reassessment.md](latest-tech-reassessment.md) にある: Node.js 24 標準化と Bun 不採用（§A、ADR-0021 候補）、HTTP API の停滞と Web Functions 直接経路の昇格条件（§B）、X-Ray SDK 終了（2027-02-25）に伴う OTel 移行と中央集約（§C、ADR-0022 候補）、compose L1 / LocalStack L2 の 2 層ローカル環境（§D、ADR-0023 候補）。

---

## 不採用・保留とした選択肢

| 選択肢                            | 判断             | 理由                                                                                                                                                          | 再評価条件                                           | 出典                                  |
| --------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------- |
| Lambda Web Functions              | experimental     | 2026 年 10 月公開直後でランタイム・リージョンの選択肢が狭い。active CPU 課金の費用形状が未実測                                                                | Event Functions との同一負荷ベンチマーク（ADR-0006） | E-85、E-01                            |
| Lambda MicroVMs                   | sandbox 専用     | VM 級隔離と状態保持（最大 8 時間）は通常 REST API に不要。費用と運用モデルが別物                                                                              | tenant code / agent sandbox の要件発生（ADR-0007）   | E-86、E-01                            |
| ECS/Fargate                       | 例外プロファイル | 間欠負荷では Lambda の方が安く運用が軽い                                                                                                                      | 常時高稼働・長時間・daemon（ADR-0009）               | E-31                                  |
| Aurora/RDS                        | 例外             | 接続数管理と schema migration の運用負荷                                                                                                                      | 関係モデルが本質（ADR-0012）                         | E-69、E-62                            |
| SQS FIFO                          | 限定             | 300 TPS/partition と group 設計の複雑さ。DLQ で順序が崩れる                                                                                                   | 業務上の順序要件（ADR-0011）                         | E-15、E-19                            |
| Kinesis Data Streams              | 未採用           | 本 PaaS の規模では shard 管理が過剰（既定値（例示値）：想定ピークが EventBridge PutEvents quota の 50% 未満なら EventBridge + SQS。調整: TD-09）              | 高スループット順序付きストリーム要件                 | E-32（Kinesis は shard 数でスケール） |
| AppSync / GraphQL                 | 未採用           | REST + OpenAPI で契約生成が完結する                                                                                                                           | クライアント主導の柔軟なクエリ要件                   | E-60                                  |
| account-per-tenant 全面           | 未採用           | account factory と集中観測なしでは運用不能                                                                                                                    | 最上位 tier・規制要件（ADR-0003/0004）               | E-75、E-45                            |
| LocalStack を最終保証に           | 不採用           | AWS 固有挙動を再現しない（計測で確定：差異は `tests/` の LocalStack 実行と sandbox 実行の結果差分として記録する。M-24、sandbox 側は 2026-10-17 に 6 件 pass） | なし（高速フィードバック用途のみ）                   | E-88                                  |
| 独自ロガー / 独自 retry           | 不採用           | Powertools と SDK 標準で足りる。保守負荷                                                                                                                      | なし                                                 | E-32、E-53                            |
| CloudWatch dimension に tenant ID | 不採用           | 組合せごとに課金され高 cardinality を警告されている                                                                                                           | なし                                                 | E-42、E-43                            |
