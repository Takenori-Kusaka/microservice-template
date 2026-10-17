# マイクロサービス・アンチパターン集

指針（`docs/architecture/guidelines-outline.md`）が明示的に警告する、または必須ルールの裏返しとして禁止されるアンチパターンを集めた。レビュー時は各チェックリストと併用し、該当したら findings 表の「指針参照」にここの番号（AP-NN）も併記する。

各項目は **症状 / 運用上なぜ困るか / 検出方法 / 是正策 / 指針参照 / 出典** で構成する。出典の `E-NN` は [evidence-register.md](./evidence-register.md) を参照。

---

## AP-01 分散モノリス

- **症状**：サービスは分かれているが、常に複数サービスを同時にリリースしないと動かない。1機能の変更で3つ以上の PR が必要。同期呼出が多段に連なる。
- **運用上なぜ困るか**：独立デプロイ・独立スケール・障害隔離という分割の利点が消え、ネットワーク遅延と部分障害というコストだけが残る。1サービスの遅延が全体の p99 を押し上げ、カスケード障害が起きる。
- **検出方法**：`service.yaml` の `syncContracts` から依存グラフを描き、最長パスが指針の上限を超える。過去3か月の PR で複数 `apps/*` を同時変更しているものの割合が高い。個別 SLO が定義できない。
- **是正策**：指針 §4 の統合判定に該当するサービスを統合する。残る横断参照は API composition / read model / 非同期化へ置換。
- **指針参照**：§4、§2 Independent where valuable、ADR-0001
- **出典**：E-63（独立デプロイ可能であることが microservice の定義）、E-64、E-56（cascading failure）

## AP-02 「1 Lambda = 1 マイクロサービス」

- **症状**：Lambda 関数ごとにリポジトリ、`service.yaml`、パイプラインがある。数百の「サービス」が存在し、所有チームは数個。
- **運用上なぜ困るか**：所有メタデータ、SLO、runbook、alarm を関数単位で維持できず、形骸化する。データ所有権が関数間で曖昧になり、同じテーブルを複数「サービス」が書く。
- **検出方法**：`find apps -name service.yaml | wc -l` と実際の bounded context 数の乖離。複数の `service.yaml` が同じ DynamoDB テーブル名を参照している。
- **是正策**：指針 §3 の定義に従い、単一業務能力・所有チーム・データ所有権・SLO・デプロイ単位を共有する関数群を1サービス（1 service stack）にまとめる。
- **指針参照**：§3 定義、§4 必須ルール、ADR-0001/0002
- **出典**：E-74（ProGlove は 1 microservice = 5〜15 Lambda の stack）、E-73

## AP-03 Lambda をオーケストレータにする

- **症状**：1つの Lambda が他の Lambda を順番に `Invoke` し、`setTimeout` で待機し、失敗時に独自の補償ロジックを持つ。timeout が 15 分近い。
- **運用上なぜ困るか**：状態遷移が実行履歴として残らず、途中失敗時にどこまで進んだか分からない。待機中も課金される。再試行・補償のカスタムコードが肥大化しバグの温床になる。
- **検出方法**：`rg -n "InvokeCommand|lambda\.invoke" apps/*/src` が entrypoint 以外にある。`rg -n "setTimeout\(" apps/*/src` で待機ループ。Lambda timeout が 5 分超。
- **是正策**：状態遷移・分岐・待機・再試行・補償を Step Functions（`PavedWorkflow`）へ移し、Lambda には業務ロジックだけを残す。
- **指針参照**：§8、ADR-0010
- **出典**：E-50（「Lambda as orchestrator」「Lambda calling Lambda」「関数内の直列待機」）、E-49

## AP-04 ネイティブ統合を包む wrapper Lambda

- **症状**：Step Functions / EventBridge から DynamoDB put、SQS send、SNS publish、別 state machine 起動をするためだけの Lambda がある。中身は SDK 呼出1行。
- **運用上なぜ困るか**：コールドスタート、同時実行枠の消費、IAM role、ログ、alarm がすべて1つ増える。業務ロジックのない関数に on-call が対応する。
- **検出方法**：handler の行数が 30 行未満で、`application/` の use case を呼んでいない。Step Functions 定義で `LambdaInvoke` の後続が SDK 操作だけ。
- **是正策**：Step Functions の SDK integration、EventBridge Pipes（source→filter→enrichment→target）、API Gateway direct integration に置換。
- **指針参照**：§8 決定木1、§15 最適化順序2
- **出典**：E-14（Pipes）、E-49（Saga を Step Functions で直接実装）、E-50

## AP-05 共有データベース

- **症状**：複数サービスが同じ DynamoDB テーブル / RDS schema / S3 prefix を読み書きする。「移行期」が1年以上続いている。
- **運用上なぜ困るか**：schema 変更が全サービスの同時リリースを強制する。テーブルの hot partition や throttle が無関係なサービスに波及する。IAM で越境を防げない。
- **検出方法**：`rg -n "TableName|TABLE_NAME" apps/*/src` の値を CDK 定義と突合し、他サービスのテーブルを参照している。`cdk synth` 後の IAM policy に他 stack のテーブル ARN がある。
- **是正策**：database-per-service へ移行。移行期は schema/table 分離と IAM 分離を必須にし、期限付き ADR（ADR-0012 の例外）を起票。横断参照は API / イベント / read model。
- **指針参照**：§4 必須ルール、§9、ADR-0012
- **出典**：E-62（Shared Database はアンチパターン）、E-80、E-64（Decentralized Data Management）、E-06（partition 上限の共有）

## AP-06 多層 retry（retry storm）

- **症状**：SDK の `maxAttempts: 3`、Lambda 非同期 retry 2 回、SQS `maxReceiveCount: 5`、Step Functions `Retry` 3 回、EventBridge retry（最大 185 回・24 時間）、クライアント retry 3 回が同じ呼出に重なる。下流障害時に負荷が数十倍になる。
- **運用上なぜ困るか**：下流が回復しようとした瞬間に retry の波が押し寄せ、障害が長引く（metastable failure）。非冪等な操作が重複実行される。
- **検出方法**：`rg -n "maxAttempts|retryAttempts|maxReceiveCount|addRetry|Retry:" apps packages` を1つの呼出チェーンに沿って並べ、2層以上で retry している。障害時の下流 RPS が平常時の数倍。
- **是正策**：呼出チェーンごとに retry 所有者を1箇所に決め（通常は SQS redelivery か Step Functions Retry）、他層は `maxAttempts: 1` または即時失敗。transient error のみ、指数 backoff + full jitter、総時間上限または retry budget を設定。
- **指針参照**：§12、ADR-0014
- **出典**：E-56（「複数階層での retry 増幅を避ける」「retry budget」）、E-53、E-55、E-11（EventBridge retry 上限）、E-67（定義文は 2026-10-17 に本文で確認済み）

## AP-07 無制限 fan-out

- **症状**：1イベントが N テナント × M 処理の Lambda を一斉起動する。バッチ開始時に `Throttles` が急増し、無関係な API が 429 を返す。
- **運用上なぜ困るか**：アカウント同時実行 quota（既定 1,000）を一つの処理が食い尽くし、critical API が巻き添えになる。下流 DynamoDB（1 partition 1,000 WCU）/ 外部 API が throttle する。
- **検出方法**：`ConcurrentExecutions` が特定時刻に quota 近くまで跳ねる。EventBridge → Lambda 直結（SQS なし）の target が多い。`maxConcurrency` 未設定の SQS event source。
- **是正策**：fan-out の間に SQS を挟み `maxConcurrency`（2〜1,000）で下流容量に合わせる。critical API に reserved concurrency。tenant tier 別に concurrency を分けるか fair queues を使う。
- **指針参照**：§10、§11、ADR-0017
- **出典**：E-01、E-17（maxConcurrency は reserved を守るための設定）、E-32（上下流の throughput 制約）、E-06、E-20、E-54

## AP-08 DLQ を墓場にする

- **症状**：DLQ にメッセージが数千件溜まっているが alarm がなく、誰も見ていない。保持期間満了で消えている。redrive 手順がない。
- **運用上なぜ困るか**：業務データ（注文、課金イベント）が静かに失われる。標準キューでは enqueue timestamp が引き継がれるため、DLQ の retention が元キューと同じだと移動後すぐ失効する。障害の兆候を検知できない。
- **検出方法**：`rg -n "deadLetterQueue" apps packages` に対応する alarm（`ApproximateNumberOfMessagesVisible > 0`）がない。DLQ の `retentionPeriod` が元キュー以下。`docs/runbooks/` に「redrive」の記述がない。
- **是正策**：`PavedQueueConsumer` の既定（DLQ + alarm + age alarm + redrive runbook、retention 14 日）を適用。DLQ ごとに所有者、alarm、診断手順、redrive 手順を必須化。
- **指針参照**：§7、§12、§19
- **出典**：E-19（DLQ retention は元キューより長く、redrive で戻す）、E-15、E-16（`maxReceiveCount ≥ 5`）

## AP-09 クライアント入力の tenantId を信頼する

- **症状**：`event.body.tenantId`、`event.queryStringParameters.tenantId`、カスタムヘッダの tenant ID をそのままデータアクセスに使う。
- **運用上なぜ困るか**：認証済みユーザが tenant ID を書き換えるだけで他テナントのデータを読み書きできる。SaaS Lens はテナント越境を「重大で回復不能になりうる事象」としている。
- **検出方法**：`rg -n "tenantId" apps/*/src/entrypoints` で `event.body`、`queryStringParameters`、`headers` 由来の参照。tenant isolation test が存在しない。
- **是正策**：`@paas/runtime-context` が JWT / authorizer context から解決した `ExecutionContext.tenantId` のみを使用。`TenantAwareTable` の repository adapter で条件式に自動付与し、IAM `dynamodb:LeadingKeys` を併用。CI に改ざん tenant ID テストを追加。
- **指針参照**：§5、§13、受入基準
- **出典**：E-47、E-46（Token Manager / Isolation Manager を共通コードで）、E-08

## AP-10 高カーディナリティのメトリクス dimension

- **症状**：CloudWatch Metrics の dimension に `tenantId`、`userId`、`orderId` を入れている。メトリクス費用が月ごとに増え、ダッシュボードが重い。
- **運用上なぜ困るか**：dimension の一意な組合せごとに別メトリクスとして課金される（最初の 10,000 metric で $0.30/metric/月）。数千テナント × 数十 operation で数十万メトリクスになる。
- **検出方法**：`rg -n "addDimension\(|setDefaultDimensions\(" apps packages/observability` の引数に tenant/user/order 系の値。CloudWatch の請求で `Metrics` が急増。
- **是正策**：dimension は service / operation / tenant tier / cell / deployment version に限定。tenant 単位の分析は EMF の非 dimension フィールド（ログ）、trace、または制御された集計基盤で行う。
- **指針参照**：§14
- **出典**：E-43（`requestId` 等の高 cardinality dimension は組合せごとに metric を生成）、E-42

## AP-11 すべての関数に Provisioned Concurrency

- **症状**：「コールドスタートをゼロにする」ために全関数に Provisioned Concurrency を設定。Lambda 費用の大半が PC で、利用率は数%。
- **運用上なぜ困るか**：PC はアカウント同時実行 quota を消費し、設定中は継続課金される。AWS 自身が「非同期ワークロードは通常 PC を必要としない」としている。SLO に無関係な関数まで固定費化する。
- **検出方法**：`rg -n "provisionedConcurrentExecutions" apps packages` の件数。`ProvisionedConcurrencyUtilization` が低い。負荷試験の結果がない。
- **是正策**：latency-sensitive な対話型 API だけに限定し、alias と時間帯（Application Auto Scaling の scheduled scaling）で絞る。先に Power Tuning、arm64、bundle サイズ削減、SDK client 再利用でコールドスタートを縮める。
- **指針参照**：§2、§10、§15 最適化順序6、ADR-0016
- **出典**：E-33、E-68、E-32

## AP-12 Lambda は自動スケールするから容量設計不要

- **症状**：RPS・burst・tenant skew の見積りがない。下流 DynamoDB が on-demand でも throttle し、外部 API の rate limit を超える。
- **運用上なぜ困るか**：Lambda がスケールするほど下流が先に死ぬ。DynamoDB on-demand でも前回ピークの 2 倍超を 30 分以内に受けると throttle しうる。quota 増枠申請の根拠がなく、障害時に申請しても間に合わない。
- **検出方法**：設計書に `RPS × duration` の見積りがない。`service.yaml` の `slo` はあるが負荷試験結果がない。`maxConcurrency` / `reservedConcurrentExecutions` が未設定。
- **是正策**：同時実行見積りに p99、burst、retry、tenant skew、downstream limit を含める。SQS で平準化し consumer concurrency を下流容量に合わせる。overload test で tipping point を測る。
- **指針参照**：§10、§11
- **出典**：E-32（「上下流の throughput 制約を把握し reserved concurrency で制限」）、E-84、E-07、E-52、E-54

## AP-13 queue depth だけを監視する

- **症状**：alarm が `ApproximateNumberOfMessagesVisible` だけ。少量でも古いメッセージが滞留し、SLO 違反に気づかない。
- **運用上なぜ困るか**：消費速度がわずかに生産速度を下回る状態が続くと、depth は緩やかに増えるだけで alarm が鳴らず、遅延は無限に伸びる。
- **検出方法**：`rg -n "ApproximateAgeOfOldestMessage" apps packages` が 0 件。
- **是正策**：message age を SLO 化し alarm を追加。`PavedQueueConsumer` の age alarm を既定で使う。backlog 上限と backpressure を設計。
- **指針参照**：§7、§12、§19
- **出典**：E-54（Amazon はメッセージ年齢で遅延を把握）、E-18（`ApproximateAgeOfOldestMessage` の急増は失敗報告の不備を示す）

## AP-14 サンプリングされた trace だけに依存する

- **症状**：障害調査で「X-Ray にその request が出てこない」。EventBridge archive replay 後の処理が追跡できない。
- **運用上なぜ困るか**：X-Ray は既定で毎秒 1 件 + 5% しか記録せず、archive 済みイベントと replay には trace header が含まれない。顧客からの問い合わせ（特定 request）を追えない。
- **検出方法**：イベント envelope に `correlationId` / `causationId` がない。`rg -n "correlationId" apps/*/src` が entrypoint でしか使われていない。Logs Insights で `correlationId` 横断検索ができない。
- **是正策**：`correlationId`、`eventId`、`causationId` をイベント payload の正式メタデータ（CloudEvents 拡張属性）として保存し、全ログに付与。sampled trace、全件 access log、audit log を別目的として扱う。
- **指針参照**：§14、ADR-0015、受入基準
- **出典**：E-28、E-13、E-59、E-77（Netflix は end-to-end tracing を移行判断に利用）

## AP-15 イベントに PII・巨大 payload を載せる

- **症状**：`order.created` イベントに顧客氏名・メール・住所が含まれる。PutEvents の 1 MB、SQS の 1 MiB、Step Functions の 256 KiB を超えて失敗する。
- **運用上なぜ困るか**：イベントバス・SQS・DLQ・archive・ログのすべてに PII が複製され、削除要求に応えられない。consumer の IAM だけで PII アクセスが広がる。
- **検出方法**：`rg -n "email|phone|address" schemas/events -i`。`dataClassification` と envelope の `data` フィールドを突合。
- **是正策**：イベントは ID と状態変化の事実だけを運び、詳細は所有サービスの API で取得。巨大 payload は S3 object reference（AWS 自身が推奨）。
- **指針参照**：§7、ADR-0013
- **出典**：E-12、E-15、E-21、E-24、E-44

## AP-16 DynamoDB Streams を外部契約にする

- **症状**：他サービスが自サービスのテーブルの Streams を直接購読している。テーブル設計変更で他サービスが壊れる。
- **運用上なぜ困るか**：内部データモデルが公開契約になり、schema 変更不能になる。Streams の保持（24 時間）を超える障害で欠落する。同一 shard の同時読取は 2 process までで、購読者を増やせない。
- **検出方法**：`rg -n "DynamoEventSource|StreamArn" apps` で他サービスのテーブルを参照。
- **是正策**：Streams は outbox（CDC）として自サービス内で消費し、envelope 準拠のイベントを EventBridge へ発行。
- **指針参照**：§7、§9
- **出典**：E-09、E-05、E-48

## AP-17 command をイベントとして流す

- **症状**：`send-invoice`、`process-order` のような命令形のイベント。consumer が「やるべきこと」を押し付けられ、producer が consumer の存在に依存する。
- **運用上なぜ困るか**：producer と consumer が結合し、fan-out 先の追加・削除が producer 変更になる。失敗時に「誰が責任を持つか」が曖昧。
- **検出方法**：`schemas/events/` の `type` が動詞原形。envelope の `type` が `<entity>.<past-tense>.v<N>` 形式でない。
- **是正策**：イベントは過去形の事実（`order.created.v1`）。命令が必要なら所有サービスの同期 API または command queue（SQS）を使い、契約として明示。
- **指針参照**：§7、ADR-0013
- **出典**：E-48（outbox は「起きた変更」を通知する）、E-59（`type` は発生した event の種別）

## AP-18 ワークフローが他サービスの DB を直接更新する

- **症状**：Step Functions の SDK integration で他サービスの DynamoDB テーブルに `PutItem`。補償処理も他サービスのテーブルを直接 rollback。
- **運用上なぜ困るか**：他サービスの不変条件（条件式、冪等性、監査ログ）を迂回する。所有サービスが schema を変えるとワークフローが壊れる。
- **検出方法**：`rg -n "DynamoPutItem|DynamoUpdateItem" apps/example-workflow-service` 等で、テーブルが自サービス以外。
- **是正策**：Saga は「業務プロセス所有サービス」が所有し、各サービスの公開 API / command / event だけを使う。参加者は冪等にする。
- **指針参照**：§8、ADR-0010
- **出典**：E-49（orchestrator は各サービスを呼び、参加者は冪等）、E-62

## AP-19 handler に業務ロジック

- **症状**：`entrypoints/` の handler が 200 行を超え、DynamoDB 呼出、条件分岐、イベント発行を直接行う。unit test が Lambda event のモックから始まる。
- **運用上なぜ困るか**：テストが遅く不安定になり、ロジックが入口種別（HTTP / SQS / Step Functions）ごとに重複する。Web Functions や Fargate へ移行できない。
- **検出方法**：`rg -n "new \w+Client\(|\.send\(" apps/*/src/entrypoints`。`application/` と `domain/` が空。
- **是正策**：指針 §16 の構造（entrypoints / application / domain / ports / adapters）に分離。handler は変換と委譲のみ。
- **指針参照**：§16
- **出典**：E-50（Lambda monolith）、E-32

## AP-20 handler 内で SDK client を毎回生成

- **症状**：`new DynamoDBClient({})` が handler 関数の中にある。warm 実行でも接続確立とクレデンシャル取得を繰り返す。
- **運用上なぜ困るか**：レイテンシと duration 課金が増え、接続数が下流を圧迫する。timeout 設定も毎回ばらつく。
- **検出方法**：`rg -n "new (DynamoDBClient|SQSClient|EventBridgeClient|SFNClient)\(" apps/*/src/entrypoints`。
- **是正策**：adapter で module scope に1度生成し、timeout と retry 設定を集中管理。keep-alive を使う。
- **指針参照**：§16、§12
- **出典**：E-32（「SDK client と DB 接続は handler の外で初期化」「keep-alive」）

## AP-21 共通ライブラリに業務ロジック

- **症状**：`packages/` に `Order` エンティティや価格計算がある。共通ライブラリの更新で複数サービスが同時にデプロイ必要になる。
- **運用上なぜ困るか**：ライブラリ経由の分散モノリス。所有権が不明確になり、変更のたびに全サービスの回帰試験が要る。
- **検出方法**：`rg -n "class \w+|export function" packages --glob '!**/constructs/**' --glob '!**/observability/**'` で業務語彙を含むもの。
- **是正策**：共通化は観測、認証認可、tenant context、エラー、契約生成に限定。業務ロジックは所有サービスへ戻し、必要なら API で公開。
- **指針参照**：§4 必須ルール
- **出典**：E-46（共通化対象は tenant context 等の横断関心）、E-36（共有 construct は独自のライフサイクルとテスト戦略を持つ）

## AP-22 同期 API チェーンの多段化

- **症状**：API → service A → service B → service C → service D と同期呼出が続く。各段の timeout が独立に設定され、合計が API Gateway の 29 秒を超える。
- **運用上なぜ困るか**：p99 は各段の p99 の積み重ねで悪化し、最下流の部分障害が入口の全面障害になる。deadline budget がないため下流が完了しても上流は既に timeout。
- **検出方法**：依存グラフの最長パスが指針の上限（既定値（例示値）：3 ホップ。調整: docs/decision/template-defaults.md#既定値レジスタ TD-02）を超える。設計書に timeout 配賦表がない。
- **是正策**：ホップ数を抑え、超過は API composition / read model / 非同期化。deadline budget を入口から伝播。
- **指針参照**：§4、§6、§10
- **出典**：E-56（deadline propagation、cascading failure）、E-50（Lambda calling Lambda）、E-03

## AP-23 quota 回避のためのアカウント乱立

- **症状**：Lambda 同時実行上限にぶつかるたびに AWS アカウントを増やす。account factory も集中観測もなく、どのアカウントに何があるか分からない。
- **運用上なぜ困るか**：セキュリティ境界・費用・観測が分断され、インシデント対応が遅れる。quota は増えたが障害隔離の意味を持たない。
- **検出方法**：`service.yaml` の `awsAccounts` が増えているのに `cellId` 設計や tenant registry がない。アカウント分割の ADR に隔離境界の記述がない。
- **是正策**：同時実行統制の順序（計測→削減→保護→平準化→申請→隔離）に従い、アカウント分割は cell / tenant tier の隔離境界と自動化を伴わせる。
- **指針参照**：§11、ADR-0003/0017
- **出典**：E-75（ProGlove は account factory と集中展開を構築）、E-78、E-01（quota は数万まで増枠可）

## AP-24 新プリミティブの根拠なき全面採用

- **症状**：Lambda Web Functions、MicroVMs、新リリースのサービスを「最新だから」で標準化。ベンチマークも ADR もない。
- **運用上なぜ困るか**：ランタイム・リージョン・機能の制約が後から発覚し、設計全体が新プリミティブの成熟に依存する。費用形状（active CPU 課金等）を測らず採用すると想定外のコストになる。
- **検出方法**：`runtimeProfile` が `experimental` 相当なのに benchmark 結果（`tests/performance/`）や ADR-0006/0007 の Evidence がない。
- **是正策**：Event Functions 標準との同一負荷比較（p50/p95/p99、cold start、費用、障害隔離、deploy 時間）を ADR に残してから採用範囲を決める。
- **指針参照**：§2、§6、ADR-0006/0007/0008
- **出典**：E-85、E-86、E-29（alias routing で x86 と arm を比較する手順）、E-89

## AP-25 期限のない例外

- **症状**：「移行期の共有 DB」「暫定の wildcard IAM」「一時的な Provisioned Concurrency」が ADR なし、または Expiry なしで1年以上残る。
- **運用上なぜ困るか**：指針が「守られないもの」になり、新規参加者が例外を標準と誤解する。技術的負債の棚卸しができない。
- **検出方法**：`rg -L "Expiry|Review date" docs/adr/*.md`。`NagSuppressions` / `acknowledge()` の `reason` が「TODO」「暫定」。
- **是正策**：すべての逸脱に ADR（Context / Decision / Alternatives / Consequences / Evidence / Expiry / Owner）を要求し、四半期 conformance review で期限切れを棚卸し。
- **指針参照**：§19、§20
- **出典**：E-89、E-38

## AP-26 本番の stateful resource が `cdk destroy` で消える

- **症状**：DynamoDB / S3 / KMS / Secrets に `RemovalPolicy.DESTROY`、termination protection なし、PITR なし。リファクタで stateful resource の logical ID が変わる。
- **運用上なぜ困るか**：誤った stack 削除や論理 ID 変更でテナントデータが消失する。KMS key は削除待機期間（7〜30 日）後に復旧不能。RPO が守れない。
- **検出方法**：`rg -n "RemovalPolicy\.DESTROY|removalPolicy: .*DESTROY" apps packages/constructs` が production stage に適用されうる。`cdk synth` 後に `"DeletionPolicy": "Delete"` が stateful resource にある。
- **是正策**：`TenantAwareTable` の既定（RETAIN、PITR、deletion protection）を使い、環境別に policy を切り替える。stateful resource を別 stack に置き termination protection。logical ID を固定する unit test。
- **指針参照**：§17、受入基準
- **出典**：E-36（「stateful resource の logical ID を変えない」「別 stack + termination protection」）、E-25

---

## 利用上の注意

- アンチパターンへの該当は、即「不合格」ではなく、指針 §20 の例外プロセスを経ているかで判断する。期限と Owner のある例外は Major 以下に留める。
- ここに載っていない問題を見つけた場合、指針と台帳に根拠があるか確認したうえで本ファイルへ追加提案する。根拠がなければ指針側の改訂提案として扱う。
- 「既定値（例示値）」と記した閾値（例：3 ホップ、TD-02）は、組織が `docs/decision/template-defaults.md` と ADR で決める値であり、出典は方向性のみを裏付ける。
