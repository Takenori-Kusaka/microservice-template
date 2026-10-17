# アーキテクチャ判断質問票

目的：要求仕様からアーキテクチャ選択へ辿り着くための質問票。各質問の回答が、指針（`docs/architecture/guidelines-outline.md`）の「主要な初期判断」表における **標準** を選ぶか、**例外** として ADR を起票するかを決める。
使い方：1サービスにつき1部。回答を `service.yaml` と `docs/adr/` に転記する。回答できない質問は `docs/review/requirements-spec-review-checklist.md` の該当項目として要求仕様書へ差し戻す。
記法：各質問は **選択肢 → 含意（標準 / 例外）** の形式。「例外」は該当 ADR 番号を伴う。各質問末尾の **出典** は `docs/review/evidence-register.md` の `E-NN`。数値閾値のうち出典で裏付けられないものは「既定値（例示値）」とし、`docs/decision/template-defaults.md` の `TD-NN` を併記する。

---

## 1. ワークロードプロファイル

**Q1-1. 平常時 RPS と burst の比率は？**

- (a) 平常 < 50 RPS、burst ≤ 3倍 → 標準：zip Lambda、on-demand、reserved concurrency なし（§10、§11）
- (b) 平常 50〜500 RPS、burst ≤ 5倍 → 標準：zip Lambda + critical API に reserved concurrency + SQS 平準化（§11 保護・平準化）
- (c) 平常 > 500 RPS または burst > 10倍 → 標準 + quota 事前増枠申請（§11 申請）。常時高稼働なら ADR-0009 で Fargate break-even 比較（§15 最適化順序8）
- (d) 不明 → 要求仕様へ差し戻し（Phase 0 workload profile）
- 出典：E-01（既定 1,000、関数ごと 1,000 環境/10 秒、新規アカウントは縮小）、E-02（API Gateway 10,000 RPS）、E-84。区分の RPS 閾値は既定値（例示値）：50 / 500 RPS と burst 倍率は、Lambda 既定同時実行と API Gateway quota の内側で reserved concurrency と quota 増枠が必要になる境目として置いた設計判断。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-26、workload profile の実測 RPS をもとに ADR-0017 改訂時に見直す）

**Q1-2. 1リクエスト/1イベントの処理時間（p99）は？**

- (a) < 1 秒 → 標準：Lambda Event Functions（§6 Lambda 選択表）
- (b) 1〜15 分 → 標準：Lambda。ただし SQS consumer なら visibility timeout ≥ 関数 timeout × 6（§12）
- (c) > 15 分、または継続稼働 → 例外：Step Functions 分割、または ECS/Fargate（§8 決定木4、ADR-0009）
- (d) 対話セッション・状態保持が必要 → 例外：Lambda MicroVMs（最大 8 時間）は tenant code / agent sandbox に限る（§6、ADR-0007）
- 出典：E-01（timeout 900 秒、MicroVMs 8 時間）、E-16、E-86

**Q1-3. 処理の性質は？**

- (a) 1リクエスト → 1応答、stateless → 標準：Event Functions（§6）
- (b) 複数同時 HTTP、streaming、既存 Node.js framework の移植 → 検証候補：Web Functions を `experimental` プロファイルでベンチマーク（§6、ADR-0006）
- (c) AWS サービス統合だけで完結（put/send/publish/transform） → 標準：direct integration / Step Functions native / EventBridge Pipes。Lambda を作らない（§8 決定木1）
- (d) 大量並列バッチ → Step Functions Distributed Map / AWS Batch / Fargate を処理時間と単価で比較（§8 決定木6）
- 出典：E-85、E-14、E-24（Distributed Map）、E-50

**Q1-4. payload の最大サイズは？**

- (a) < 256 KiB → 標準：Step Functions state にも直接載せられる（§7、§8）
- (b) 256 KiB 〜 1 MB → EventBridge（1 リクエスト 1 MB）/ SQS（1 MiB）/ Lambda 非同期（1 MB）に直接可。Step Functions は S3 ARN
- (c) 1 MB 〜 6 MB → 同期 API のみ直接可。イベントは S3 object reference（§7 イベント包絡）
- (d) > 6 MB → presigned URL でアップロード、非同期処理。同期応答は streaming（200 MB）を検討（§9 S3）
- 出典：E-21、E-12、E-15、E-01、E-24、E-70

## 2. テナンシー

**Q2-1. テナント数と tier 構成は？**

- (a) 数十〜数百、tier 差は rate limit と SLO のみ → 標準：pool、Phase 1（§5 推奨段階）
- (b) 数百〜数千、上位 tier に障害隔離・quota 分離の要求 → 標準 + Phase 2：cell 固定配置、cell 別 stack/account（§5 Phase 2、§11 隔離）
- (c) 規制・専有性能・個別鍵を要求するテナントがいる → 例外：該当テナントのみ silo / account-per-tenant（§5 Phase 3、ADR-0004）
- 出典：E-45、E-75、E-78。テナント数の区分は既定値（例示値）：SaaS Lens の pool / cell / silo 段階に対し、DynamoDB の tenant partition と cell 当たりの quota 消費から置いた設計判断。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-27、tenant 数の実績をもとに ADR-0004 改訂時に見直す）

**Q2-2. tenant skew（最大テナントの負荷占有率）は？**

- (a) 小さい → 標準：pool + tier 別 throttling（§5、§10）
- (b) 中程度 → 標準 + SQS fair queues（`MessageGroupId` に tenant ID）、tier 別 consumer concurrency、reserved concurrency（§10、§11）
- (c) 大きい（単一テナントが partition 上限 3,000 RCU / 1,000 WCU に迫る） → bridge（該当テナントの該当機能だけ分離）または write sharding を ADR-0004 で検討（§5 Bridge）
- 出典：E-20、E-06、E-17、E-45。占有率の区分は既定値（例示値）：小 < 10%、中 10〜40%、大 > 40%。40% は 1 tenant が predominant になり fair queue の効果が出る境目として置いた設計判断。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-28、`ClaimedAccountConcurrency` と tenant 別 metric の実績をもとに ADR-0017 改訂時に見直す）

**Q2-3. tenant 識別の信頼源は？**

- (a) JWT claim または API Gateway authorizer context → 標準：`@paas/runtime-context` で `ExecutionContext` 生成（§5 テナント文脈）
- (b) リクエスト body / query / カスタムヘッダ → **禁止**。authorizer 経由に設計し直す（§5、AP-09）
- (c) 内部バッチ（人間のリクエストなし） → 標準：実行 role と envelope の `tenantId` を信頼源にし、1実行1テナントに固定（§5、§13）
- 出典：E-46、E-47、E-08

**Q2-4. 暗号鍵の要件は？**

- (a) 共通 KMS key（data class 別） → 標準（§13 KMS 粒度）
- (b) tenant tier 別 key → 標準の範囲（§13）。鍵数 × $1/月と API 課金を試算
- (c) テナント管理鍵（BYOK / external key store） → 例外：silo + ADR-0004（§5 Silo）
- 出典：E-25、E-26

**Q2-5. テナントのライフサイクル操作は？**

- (a) onboarding/offboarding のみ → 標準：control plane（tenant registry）で管理（§3）
- (b) tenant migration / cell migration が必要 → 設計対象に含める（§9）。Phase 4 game day で検証（実装ロードマップ）
- 出典：E-78、E-51

## 3. 同期 API

**Q3-1. 即時応答が業務上必要か？**

- (a) はい（ユーザが結果を待つ、外部システムが同期応答を要求） → 標準：API Gateway HTTP API + Lambda（§6）
- (b) いいえ（受付応答だけでよい） → 標準：202 Accepted + 非同期処理（§2 Async by reason）。Q4 へ
- (c) 一部のみ → 受付は同期、処理は非同期の分離設計
- 出典：E-50（Lambda calling Lambda の回避）、E-14

**Q3-2. API Gateway に必要な機能は？**

- (a) JWT 認証、ルーティング、アカウント throttling、CORS、自動デプロイ → 標準：HTTP API（§6、ADR-0005）
- (b) API key、usage plan、per-client throttling、request validation、キャッシュ、WAF 直接統合、private API、canary release、X-Ray、response streaming → 例外：REST API。採用時点の機能表を ADR-0005 に固定（§6）
- (c) 不明 → HTTP API から開始し、機能不足が証明されたら REST API へ
- 出典：E-04、E-93

**Q3-3. 書き込み API の重複実行は許容できるか？**

- (a) いいえ（注文・課金・状態遷移） → 標準：`Idempotency-Key` 必須、Powertools Idempotency、tenant + operation + key を `eventKeyJmesPath` に含める。既定の 1 時間失効を業務要件で見直す（§6、ADR-0014）
- (b) はい（自然冪等な PUT） → 条件付き書き込みで担保。ヘッダは任意
- 出典：E-39、E-91、E-32

**Q3-4. 同期依存先の数と SLO は？**

- (a) 依存なし、または1ホップで依存先 SLO が上位 SLO を満たす → 標準
- (b) 2〜3ホップ → 標準の上限（既定値（例示値）：3 ホップ。ADR-0016 の入口 p99 を 4 段以上に配賦すると段当たり予算が足りなくなるため置いた設計判断。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-02、slo-baseline 計測 M-17 で妥当性を確認し ADR-0001 改訂時に見直す））。deadline budget 配賦表を設計書に必須（§4、§6、§10）
- (c) 上限超、または依存先 SLO が不足 → 例外禁止。API composition / read model / 非同期化へ設計変更（§4 必須ルール）
- 出典：E-56（deadline propagation）、E-50、E-03（REST API 29 秒）

**Q3-5. 一覧取得の最大件数は？**

- (a) ページング前提 → 標準：cursor（opaque token）方式（§6）
- (b) 全件エクスポート → 非同期 job + S3 presigned URL（§6 無制限一覧禁止、§9）
- 出典：E-57、E-70

## 4. 非同期連携

**Q4-1. 連携の形は？**

- (a) 1 producer → 複数 consumer、疎結合 → 標準：EventBridge（§7 役割分担、ADR-0011）。rule あたり target は 5 まで
- (b) 1 producer → 1 consumer、バッファ・バックプレッシャー・再試行が必要 → 標準：SQS Standard（§7）。enrichment が要るなら Pipes
- (c) 単純 push fan-out（メール、webhook） → SNS（§7）
- (d) サービス内部のデータ変更捕捉 → DynamoDB Streams（outbox）。外部契約にしない（§7、AP-16）
- 出典：E-11、E-14、E-09、E-48

**Q4-2. 順序保証は業務上必須か？**

- (a) 不要、または consumer 側で version/timestamp により解決可能 → 標準：SQS Standard / EventBridge（§7）
- (b) 同一 key 内の順序が本当に必要（残高、状態機械） → SQS FIFO。group ID の設計と 300 TPS/partition（high throughput mode で拡張）を ADR-0011 に記録。DLQ を付けると順序が崩れる点に注意（§7 SQS FIFO）
- 出典：E-15、E-17、E-19

**Q4-3. 重複配信は許容できるか？**

- (a) consumer が冪等（`eventId` 重複排除） → 標準（§7、ADR-0014）
- (b) 冪等化できない → 設計見直し。event source mapping は at-least-once が前提のため、冪等化なしの非同期は不可
- 出典：E-32（「event source mapping は各 event を最低 1 回処理」）、E-48

**Q4-4. イベントに含めるデータは？**

- (a) ID と状態変化の事実のみ → 標準：CloudEvents 準拠 envelope（§7、ADR-0013）
- (b) 詳細データ（顧客情報等）を含めたい → PII は禁止。詳細は所有サービス API 参照、1 MB 超は S3 reference（§7、AP-15）
- 出典：E-59、E-12、E-44

**Q4-5. consumer の失敗時に必要なものは？**

- 必ず：partial batch failure、DLQ（retention を元キューより長く）、alarm、redrive 手順、message age SLO → 標準：`PavedQueueConsumer`（§7、§12）
- DLQ 所有者が決まらない → 設計不備。`service.yaml` の `onCall` を所有者にする
- 出典：E-18、E-19、E-54

**Q4-6. 遅延許容時間は？**

- (a) 秒〜分 → 標準：EventBridge → SQS → Lambda
- (b) ミリ秒 → 非同期が不適。同期 API または read model（§2 Async by reason）
- (c) 時間〜日 → スケジュール/バッチ。Step Functions Wait（Standard は最大 1 年）または EventBridge Scheduler
- 出典：E-16（SQS consumer の立ち上がり 5 → +300/分）、E-21

## 5. ワークフロー

**Q5-1. 処理は複数ステップの状態遷移・分岐・待機・補償を持つか？**

- (a) いいえ（直列の短い処理） → 標準：Lambda 1 関数、または SQS chain。Step Functions 不要（§8、主要な初期判断 workflow）
- (b) はい → 標準：Step Functions（`PavedWorkflow`）。Lambda をオーケストレータにしない（§8、ADR-0010、AP-03）
- 出典：E-50、E-49

**Q5-2. ワークフローが跨ぐ範囲は？**

- (a) 1 bounded context 内 → 標準：サービス内部資源として所有（§8）
- (b) 複数サービス（Saga） → 「業務プロセス所有サービス」を明示し、他サービスの公開 API / command / event のみ使用。他サービス DB 直接更新は禁止。参加者は冪等（§8、AP-18）
- 出典：E-49、E-62

**Q5-3. 実行時間と実行モデルは？**

- (a) 5 分超、人手待機（`.waitForTaskToken`）、`.sync`、Distributed Map、監査用の実行履歴（90 日）、exactly-once → 標準：Standard（§8）
- (b) 5 分以内、高スループット、at-least-once でよい、冪等、履歴は CloudWatch Logs で十分 → Express。ADR-0010 に根拠（§8、§15 最適化順序7）
- (c) 混在 → Standard の親に Express の子を nest（非冪等処理は親、冪等処理は子）
- 出典：E-21、E-22、E-23、E-24

**Q5-4. 各ステップは Lambda が必要か？**

- (a) SDK 操作のみ → native service integration。wrapper Lambda 禁止（§8、AP-04）
- (b) 業務ロジックあり → Lambda。ただし retry/catch は Step Functions 側が所有し、`Lambda.ServiceException` 等の一時エラーを `Retry`（§8、§12）
- 出典：E-24、E-50

**Q5-5. state に載せるデータは？**

- (a) ID と最小限の状態（256 KiB 以内） → 標準
- (b) 秘密・PII → 禁止。参照 ID に置換（§8 実行履歴のデータ分類）
- (c) 256 KiB 超 → S3 ARN を渡す
- 出典：E-21、E-24、E-44

## 6. 処理ランタイム（§8 決定木に対応）

**Q6-1. AWS サービス統合だけで完結するか？** → はい：direct integration / Pipes。Lambda を作らない。いいえ：Q6-2（出典：E-14、E-50）

**Q6-2. 15 分以内、stateless、イベント単位か？** → はい：標準 zip Lambda、esbuild、arm64、Node.js 22（主要な初期判断 Lambda package）。いいえ：Q6-4（出典：E-01、E-37、E-30）

**Q6-3. 大規模 native dependency（展開後 250 MB 超）、または既存 OCI build が必要か？**

- はい → Lambda container image（10 GB）を比較。image size、cold start、supply chain を ADR-0008 に記録（§8 決定木3）
- いいえ → zip のまま。native module は `nodeModules` で同梱
- 出典：E-01、E-90、E-37

**Q6-4. 継続高 CPU、長時間、daemon、特殊 network、予測可能な高稼働率か？**

- はい → ECS/Fargate。実行時間・稼働率・CPU・memory・network の実測と Lambda 単価（$0.20/M + GB-秒）との break-even を ADR-0009 に（§8 決定木4、§15 最適化順序8）
- いいえ → Q6-5
- 出典：E-31、E-01

**Q6-5. VM 級隔離、状態保持、対話セッション、テナント任意コードか？**

- はい → Lambda MicroVMs（最大 8 時間）。sandbox / agent / tenant code 専用。通常 API では禁止（§6、ADR-0007）
- いいえ → 設計を見直し Q6-2 へ戻る
- 出典：E-86、E-01

**Q6-6. バッチで大量並列か？** → Step Functions Distributed Map（子実行 10,000 並列）/ AWS Batch / Fargate を処理時間と単価で比較（§8 決定木6）（出典：E-21、E-24）

**Q6-7. arm64 で動くか？**

- はい → 標準 arm64（duration 課金 20% 低、最大 34% 価格性能向上）（§10）
- native 依存で不可 → x86_64。理由を `service.yaml` の `runtimeProfile` 近傍に記録。alias routing で両者を比較
- 出典：E-29、E-30、E-83

## 7. データ

**Q7-1. アクセスパターンは事前に列挙できるか？**

- (a) はい、key-value / 単純クエリ中心 → 標準：DynamoDB（`TenantAwareTable`）。partition key 先頭 `tenantId`、`LeadingKeys` 条件（§5 Phase 1、§9）
- (b) 複雑な関係・制約・トランザクション・ad hoc クエリが本質的 → Aurora/RDS + RDS Proxy。ADR-0012 に根拠（§9）
- (c) 不明 → 要求仕様へ差し戻し（データ量・アクセスパターン）
- 出典：E-06、E-08、E-69

**Q7-2. 他サービスのデータを参照する必要があるか？**

- (a) いいえ → 標準
- (b) 読み取りのみ、遅延許容 → read model / CQRS（イベント購読で複製）（§9）
- (c) 読み取りのみ、即時性必要 → 同期 API（ホップ上限内）
- (d) 書き込み → 所有サービスの API / command。DB 直接は禁止（§4、ADR-0012）
- 出典：E-62、E-80

**Q7-3. DB 更新とイベント発行の整合は？**

- (a) 必要（イベント欠落不可） → 標準：outbox（DynamoDB Streams CDC → EventBridge）（§9）
- (b) 不要（再送で補える） → 直接 PutEvents 可。ただし重複と欠落の挙動を契約に明記
- 出典：E-48、E-09

**Q7-4. 既存共有 DB があるか？**

- (a) いいえ → 標準 database-per-service
- (b) はい → 期限付き例外 ADR-0012。schema/table 分離、IAM 分離、expand/migrate/contract の移行計画を必須（§4、§9）
- 出典：E-62、E-65、E-89

**Q7-5. 保持・削除要件は？**

- TTL、retention、テナント退会時削除、法的保持を `dataClassification` ごとに決める（§9、§13）。未定なら要求仕様へ差し戻し
- 出典：E-44、E-70

## 8. 性能

**Q8-1. 各 API の p99 目標は？** → 必ず数値。平均は不可（§10 SLO-first、ADR-0016）。未定なら要求仕様へ差し戻し（出典：E-82、E-81）

**Q8-2. コールドスタートは SLO 違反になるか？**

- (a) いいえ（p99 予算内） → 標準：Provisioned Concurrency なし
- (b) はい、特定 API のみ → その API だけ Provisioned Concurrency（alias、必要量 +10%、scheduled scaling）を負荷試験で検証（§10、§15 最適化順序6）
- (c) 全 API で許容不可 → 要求の妥当性を疑う。先に Power Tuning、bundle 縮小、arm64（AP-11）
- 出典：E-33、E-68

**Q8-3. memory / timeout の決め方は？**

- (a) Power Tuning と実トラフィック相当データ → 標準（§2 Evidence、§10）
- (b) 推測値 → Info 指摘。Phase 3 で計測計画
- 出典：E-68、E-32

**Q8-4. 下流容量の上限は？**

- DynamoDB partition（3,000 RCU / 1,000 WCU）と on-demand の 2 倍則、外部 API rate limit、RDS 接続数を列挙し、SQS consumer `maxConcurrency` と reserved concurrency をそれに合わせる（§10、§11 平準化）
- 出典：E-06、E-07、E-17、E-69、E-32

**Q8-5. 過負荷時の挙動は？**

- (a) 早期 429/503 を返してよい → 標準：tier 別 rate limit + load shedding（§10）
- (b) すべて受け付ける → SQS で受付し非同期化。同期で「すべて処理」は不可
- 出典：E-52、E-02

## 9. 信頼性

**Q9-1. retry の所有者はどこか？**

- 呼出チェーンごとに1箇所を指名（通常：SQS redelivery または Step Functions Retry）。他層は `maxAttempts: 1`。retry budget を検討（§12、ADR-0014、AP-06）
- 出典：E-56、E-53、E-55

**Q9-2. RTO / RPO は？**

- (a) RPO ≤ 数分、RTO ≤ 1 時間 → 標準：PITR、retain policy、single region + cell（§12、§17）
- (b) RPO ≈ 0、RTO ≤ 数分 → multi-region を事業要件とデータ整合性で検証（§11 地域分散）。ADR-0003
- (c) 未定 → 要求仕様へ差し戻し
- 出典：E-36、E-05（global tables の quota）。RTO/RPO の区分値は既定値（例示値）：PITR + single region で到達できる水準と multi-region が必要になる水準を事業継続要件の典型値で区切った設計判断。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-29、事業継続要件をもとに platform-team と事業側が ADR-0003 改訂時に見直す）

**Q9-3. control plane 障害時に data plane は継続すべきか？**

- はい → static stability：tenant 設定のキャッシュ、既定値（§12）
- いいえ → 許容時間を SLO に明記
- 出典：E-51

**Q9-4. 障害隔離の単位は？**

- (a) サービス単位で十分 → 標準 Phase 1
- (b) tenant tier / cell 単位 → Phase 2：cell 設計、routing 以外の状態共有なし（§3 Cell、§12）
- 出典：E-78、E-75

**Q9-5. 障害試験の計画は？**

- dependency timeout、throttle、poison message、DLQ、compensation を staging で定期実施（§12、受入基準）。goodput が頭打ちになる点を超えて負荷試験。計画なしは Minor
- 出典：E-52、E-88

## 10. セキュリティ

**Q10-1. 認可の単位は？**

- tenant + resource ownership（+ role）。authorizer 通過だけで認可済みとしない（§6、§13）
- 出典：E-46、E-08

**Q10-2. 公開面はあるか？**

- (a) API Gateway + authorizer のみ → 標準
- (b) Function URL、Web Function endpoint、public bucket → 脅威モデル必須。WAF（REST API のみ直接統合）、rate limit、egress 制限、S3 Block Public Access（§13）
- 出典：E-04、E-70

**Q10-3. 秘密情報の保管は？**

- Secrets Manager / Parameter Store（Powertools Parameters で 5 秒キャッシュ）。環境変数・イベント・Step Functions state に埋め込まない（§13）
- 出典：E-41、E-27、E-24

**Q10-4. 監査対象操作は？**

- 重要操作を列挙し、audit log を通常ログと分離（保存・アクセス権・保持期間）（§13）
- 出典：E-44

**Q10-5. tenant isolation test の受入基準は？**

- 異なる tenant token、改ざん tenant ID、推測 ID、非同期 event 改ざんの4種を CI/E2E に含める（§13、受入基準）
- 出典：E-47

## 11. 可観測性

**Q11-1. 相関 ID の生成点は？**

- API 入口で `correlationId` 生成/検証（Powertools `correlationIdPath`）。外部 trace header を無条件に信用しない（§14）
- 出典：E-40、E-28

**Q11-2. 非同期経路の追跡は？**

- envelope の `correlationId` / `causationId` / `eventId` を正式メタデータとして保存し、ログで全件検索可能。archive replay では trace header が失われる（§14、ADR-0015、AP-14）
- 出典：E-13、E-59

**Q11-3. メトリクスの dimension は？**

- service / operation / tenant tier / cell / deployment version。tenant ID は dimension にしない（§14、AP-10）
- 出典：E-43、E-42

**Q11-4. 観測基盤は？**

- (a) Powertools + X-Ray / Application Signals → 標準（主要な初期判断 observability）
- (b) OTel backend 等 → 標準化 ADR-0015
- 出典：E-81、E-32

**Q11-5. SLO alarm と dashboard は？**

- `ServiceObservability` で Application Signals SLO、error budget burn、p99/availability/queue age/throttles/concurrency/cost（§10、§19）
- 出典：E-81、E-18、E-84

## 12. コスト

**Q12-1. 原価の管理単位は？**

- request / workflow / job / tenant / tier 当たり。含める費用項目を列挙（Lambda $0.20/M、Step Functions $0.000025/transition、CloudWatch metric $0.30、logs $0.50/GB、X-Ray $5/M）（§15、ADR-0018）
- 出典：E-31、E-23、E-42

**Q12-2. tenant/tier 配賦の driver は？**

- request、storage、workflow execution 等。`costCenter` 確定、cost allocation tags（§3、§15）
- 出典：E-24

**Q12-3. 稼働率は？**

- (a) 間欠 → 標準 Lambda
- (b) 常時高稼働 → Fargate break-even を ADR-0009 で再評価（§15 最適化順序8）
- 出典：E-31。稼働率閾値は既定値（例示値）：一次スクリーニングは月間平均稼働率 40%（ADR-0009 の条件表）、最終判断は `pnpm cost-model` の break-even と運用負担。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-07）。計測で確定: break-even 稼働率（M-07、現在は未計測）

**Q12-4. ログ・トレースの費用上限は？**

- log retention、sampling、metrics 数を試算に含める（§15 最適化順序1）
- 出典：E-42、E-43、E-28

## 13. チームと所有

**Q13-1. 所有チームと on-call は決まっているか？**

- はい → `ownerTeam`、`onCall` に記録
- いいえ → **設計を開始しない**（§3「所有者不明はデプロイ不可」）
- 出典：E-73、E-76

**Q13-2. リポジトリ戦略は？**

- (a) monorepo + サービス単位 pipeline/ownership → 標準（ADR-0002）
- (b) polyrepo → ADR-0002 の例外。CODEOWNERS と共通パッケージ配布方法を記録
- 出典：E-36（CDK app は 1 package 1 repository を推奨、共有 construct は別パッケージ）、E-63

**Q13-3. このサービスは他サービスと常に同時変更されるか？**

- はい → 統合を検討（§4 分割判定）
- いいえ → 分割妥当
- 出典：E-63

**Q13-4. 運用成果物を誰がいつ作るか？**

- `runbook`、`dashboard`、`threatModel` を設計書と同時に。リリース後は不可（§3、§19）
- 出典：E-73、E-76

**Q13-5. ADR の起票対象は？**

- 本質問票で「例外」と判定した項目すべて。各 ADR に Context / Decision / Alternatives（2案以上）/ Consequences / Evidence / Expiry / Owner（§20）
- 出典：E-89

---

## 回答の転記先

| 質問群 | `service.yaml` フィールド                              | ADR                     |
| ------ | ------------------------------------------------------ | ----------------------- |
| 1, 6   | `runtimeProfile`                                       | ADR-0006/0007/0008/0009 |
| 2      | `tenantIsolationModel`, `awsAccounts`, `regions`       | ADR-0003/0004           |
| 3      | `syncContracts`                                        | ADR-0005/0014           |
| 4      | `publishedEvents`, `consumedEvents`                    | ADR-0011/0013           |
| 5      | （`runtimeProfile` に workflow 種別）                  | ADR-0010                |
| 7      | `dataClassification`                                   | ADR-0012                |
| 8, 9   | `slo`, `rto`, `rpo`                                    | ADR-0016/0017           |
| 10     | `threatModel`                                          | —                       |
| 11     | `dashboard`                                            | ADR-0015                |
| 12     | `costCenter`                                           | ADR-0018                |
| 13     | `ownerTeam`, `onCall`, `repository`, `runbook`, `adrs` | ADR-0001/0002           |
