# 設計指針書レビューチェックリスト

対象：他チーム・他社・既存組織が作成した「マイクロサービス設計指針書」「アーキテクチャ標準」「開発ガイドライン」。
目的：その指針が、現場の判断を実際に決められる粒度を持っているか、禁止事項と検証方法が対になっているか、例外を管理できるかを確認する。本テンプレートの指針（`docs/architecture/guidelines-outline.md`）の20章構成を比較軸にする。
判定：各項目を「定義あり / 曖昧 / 欠落」で記録し、「曖昧」「欠落」のうち運用事故に直結するものを Major 以上とする。
根拠：「根拠」列の `E-NN` は [evidence-register.md](./evidence-register.md) を参照。

## レビューの原則

- 指針書は「原則」だけでは機能しない。各章に **判断基準・標準形・禁止事項・検証方法・ADR 候補** の5点が揃っているかを見る（指針「位置づけ」、根拠 E-89）。
- 「〜が望ましい」「〜を検討する」だけの文は判断基準にならない。閾値、順序、条件を要求する。
- 最新技術の採用を促すだけで運用実態（quota、障害モード、費用形状、on-call 負荷）に触れない章は「曖昧」とする（指針 §2）。
- 相手の指針が本テンプレートと異なる閾値を置いている場合、出典を確認する。出典がなければ「既定値（例示値）」同士の差分として記録し、本テンプレート側の値は `docs/decision/template-defaults.md` の `TD-NN` を引く。

## 1. 目的・適用範囲・原則

| #   | 確認観点                       | 合格基準                                                                                                                                            | 欠落時の典型的な弊害                         | 指針参照    | 根拠                               |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------- | ---------------------------------- |
| 1-1 | 対象と非対象が明記されているか | 対象規模（RPS、tenant 数）、対象技術、非目標が列挙                                                                                                  | 指針が全システムに一律適用され過剰設計を招く | §1          | E-36（必要になるまで複雑化しない） |
| 1-2 | 品質属性の優先順位があるか     | 順序が明示され、サービス差分は ADR 化と書かれている                                                                                                 | トレードオフ判断が担当者の好みになる         | §1 品質属性 | E-88                               |
| 1-3 | 設計原則に判断の方向性があるか | Managed-first、Serverless-first not only、One owner、Independent where valuable、Async by reason、Paved road、Evidence over defaults に相当する原則 | 「マイクロサービス化する」が目的化する       | §2          | E-72、E-46、E-76                   |
| 1-4 | 用語が定義されているか         | Platform / Microservice / Function / Workflow / Cell / Control plane / Data plane の区別                                                            | 「Lambda 関数＝マイクロサービス」の混同      | §3 定義     | E-74、E-51、E-78                   |

## 2. サービス境界

| #   | 確認観点                                                             | 合格基準                                                                                      | 欠落時の典型的な弊害              | 指針参照          | 根拠                                              |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------- | ----------------- | ------------------------------------------------- |
| 2-1 | 分割軸が列挙されているか                                             | 業務能力、データ正本、変更頻度、スケール/隔離、セキュリティ境界、認知負荷の6軸相当            | 技術層（API層、DB層）で分割される | §4 分割軸         | E-64、E-79、E-66                                  |
| 2-2 | 分割判定の閾値があるか                                               | 「N 軸以上で差がある場合に分割候補」の形で数値化                                              | 分割が無限に進む                  | §4 分割判定       | E-63（軸数の閾値は既定値（例示値）TD-01）         |
| 2-3 | **統合**判定があるか                                                 | 常に同時変更、同期チャット多発、同一トランザクション、個別 SLO 不能のときは統合と書かれている | 分散モノリス化                    | §4 分割判定       | E-63（独立デプロイ可能であること）                |
| 2-4 | 同期呼出チェーンの上限があるか                                       | ホップ数上限と超過時の代替（API composition、read model、非同期化）                           | 遅延とカスケード障害の蓄積        | §4 必須ルール     | E-50、E-56（「3 ホップ」は既定値（例示値）TD-02） |
| 2-5 | 共通ライブラリの範囲が限定されているか                               | 横断関心（観測、認証認可、tenant context、エラー、契約生成）に限定し、業務ロジックを禁止      | 共有ライブラリ経由の密結合        | §4 必須ルール     | E-46                                              |
| 2-6 | 「1関数＝1サービス」「1エンドポイント＝1リポジトリ」を否定しているか | 明示的に標準にしないと書かれている                                                            | 数百の極小リポジトリ              | §4、ADR-0001/0002 | E-74                                              |

## 3. マルチテナンシー

| #   | 確認観点                                           | 合格基準                                                                                      | 欠落時の典型的な弊害                                       | 指針参照                | 根拠       |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------- | ---------- |
| 3-1 | tenant context の構造が定義されているか            | `tenantId`、`tenantTier`、`requestId`、`correlationId`、`cellId` 等を含む実行コンテキストの型 | サービスごとに異なるテナント表現                           | §5 ExecutionContext     | E-46       |
| 3-2 | tenant 識別の信頼源が規定されているか              | 認証済み JWT / authorizer context から解決し、クライアント入力を禁止                          | テナント越境                                               | §5                      | E-46、E-47 |
| 3-3 | tenant context の取得が共通 SDK へ隠蔽されているか | 解決、IAM scope、ログ付与、メトリクス付与を共通化し、別ネットワークサービス化しない           | 各ハンドラで独自実装、または余分なホップ                   | §5、§2 Paved road       | E-46       |
| 3-4 | 分離モデルの選択肢と選択基準があるか               | pool / bridge / silo / account-per-tenant と、用途・長所・注意点                              | 全社一律 silo で配備コスト爆発、または一律 pool で規制違反 | §5 分離モデル、ADR-0004 | E-45、E-75 |
| 3-5 | 分離モデルがサービス単位で選べるか                 | 「PaaS 全体で一律にしない」と明記                                                             | 1テナントの要件で全サービスが silo 化                      | §5                      | E-45       |
| 3-6 | 段階導入の計画があるか                             | Phase 1 pool → Phase 2 cell → Phase 3 silo/account の順序と昇格条件                           | 初日から account-per-tenant を要求し自動化が追いつかない   | §5 推奨段階             | E-75、E-78 |
| 3-7 | pool のデータアクセス規則があるか                  | `tenantId` を partition key 先頭に置き、IAM 条件と repository wrapper で強制                  | GSI や scan でテナント越境                                 | §5 Phase 1、§13         | E-08       |

## 4. API 標準

| #   | 確認観点                               | 合格基準                                                                                                                      | 欠落時の典型的な弊害                   | 指針参照                     | 根拠       |
| --- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------- | ---------- |
| 4-1 | 標準経路が定義されているか             | `CloudFront/WAF → API Gateway → Lambda → service-owned datastore` 相当                                                        | サービスごとに異なる入口構成           | §6 API層の標準               | E-72       |
| 4-2 | API Gateway 種別の選択基準があるか     | HTTP API 標準、REST API の採用条件（usage plan、API key、request validation、キャッシュ、WAF、private）、機能表を ADR に固定  | 価格だけで選び後から機能不足           | §6、ADR-0005                 | E-04、E-93 |
| 4-3 | 認証と業務認可の責任分担があるか       | API Gateway は認証・ルーティング・スロットリング、業務認可はサービス側                                                        | authorizer 通過＝認可済みと誤解        | §6、§13                      | E-46       |
| 4-4 | 契約の正本と生成物が決まっているか     | OpenAPI 正本、型・validation・SDK・contract test の生成                                                                       | 手書きクライアントの乖離               | §6 API契約、§16              | E-60       |
| 4-5 | 破壊的変更の扱いがあるか               | 新 version または consumer 移行期間（expand/migrate/contract）                                                                | 無告知の契約変更で consumer 障害       | §6、§17 breaking change 検出 | E-65       |
| 4-6 | エラー応答の標準があるか               | HTTP status、安定した `error.code`（RFC 9457 の `type`/`title`/`status`/`detail`/`instance` 相当）、`requestId`、再試行可能性 | クライアントが再試行判断できない       | §6                           | E-58       |
| 4-7 | 冪等性の規定があるか                   | 書き込み API の `Idempotency-Key`、tenant+operation+key の組、保存期間                                                        | 重複注文・二重課金                     | §6、ADR-0014                 | E-39、E-91 |
| 4-8 | deadline/timeout budget の伝播があるか | 入口から下流へ残り時間を伝播                                                                                                  | 下流が完了しても上流はタイムアウト済み | §6                           | E-56、E-03 |
| 4-9 | pagination 標準があるか                | cursor 方式（opaque token）、無制限一覧禁止                                                                                   | 全件取得で Lambda timeout / RCU 枯渇   | §6                           | E-57       |

## 5. イベント標準

| #   | 確認観点                                     | 合格基準                                                                                                          | 欠落時の典型的な弊害                         | 指針参照                  | 根拠                                            |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------- | ----------------------------------------------- |
| 5-1 | メッセージング手段の役割分担があるか         | EventBridge / SQS Standard / SQS FIFO / SNS / DynamoDB Streams / Pipes の用途区分                                 | 全部 SNS、または全部 FIFO                    | §7 役割分担、ADR-0011     | E-14、E-15、E-09                                |
| 5-2 | イベント包絡が定義されているか               | CloudEvents 必須属性（`id`、`source`、`specversion`、`type`）＋拡張（`tenantId`、`correlationId`、`causationId`） | 相関不能なイベント                           | §7 イベント包絡、ADR-0013 | E-59                                            |
| 5-3 | event と command の区別があるか              | イベントは過去形の事実                                                                                            | 「〜せよ」イベントで consumer に責務が漏れる | §7                        | E-48（outbox は「起きた事実」を配信）           |
| 5-4 | payload 制約があるか                         | PII・秘密・巨大 payload 禁止、S3 object reference 方式                                                            | イベントバスに PII が流れ監査違反            | §7、ADR-0013              | E-12、E-44                                      |
| 5-5 | schema registry と互換性テストが CI にあるか | registry の所在、互換性検査の実行時点                                                                             | consumer を壊す schema 変更                  | §7、§17                   | E-11（EventBridge Schema Registry quota）、E-65 |
| 5-6 | DLQ の運用要件があるか                       | 所有者、alarm、診断、redrive 手順、DLQ retention > 元キュー                                                       | DLQ が墓場になる                             | §7、§12                   | E-19                                            |
| 5-7 | 滞留時間の SLO があるか                      | `ApproximateAgeOfOldestMessage` を SLO 化                                                                         | queue depth だけ見て遅延に気づかない         | §7、§19                   | E-54、E-18                                      |

## 6. データ所有権

| #   | 確認観点                                | 合格基準                                                                                                | 欠落時の典型的な弊害          | 指針参照                    | 根拠             |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------- | ---------------- |
| 6-1 | database-per-service が標準か           | 他サービスの DB/テーブル/S3 prefix の直接アクセス禁止                                                   | 共有 DB による密結合          | §4 必須ルール、§9、ADR-0012 | E-62、E-80、E-64 |
| 6-2 | 共有 DB の移行期ルールがあるか          | 期限、schema/table 分離、IAM 分離を必須化                                                               | 移行期が恒久化                | §4、ADR-0012                | E-62、E-89       |
| 6-3 | DynamoDB 設計書の必須項目があるか       | アクセスパターン、partition key cardinality、hot partition、GSI、条件付き書き込み、TTL                  | hot partition による throttle | §9                          | E-06、E-07       |
| 6-4 | Aurora/RDS の採用条件があるか           | 複雑な関係・制約・トランザクションが本質的な場合、接続数保護（RDS Proxy）                               | Lambda からの接続枯渇         | §9                          | E-69             |
| 6-5 | 横断参照の手段が定義されているか        | read model / CQRS、多段同期 join 禁止                                                                   | 実行時 join で遅延増大        | §9                          | E-62、E-80       |
| 6-6 | 分散トランザクションの方針があるか      | Saga と補償、整合性期待値を API 契約に含める                                                            | 暗黙の強整合性期待            | §9、ADR-0010                | E-49             |
| 6-7 | DB 更新とイベント発行の整合手段があるか | outbox/inbox または DynamoDB Streams                                                                    | イベント欠落・二重発行        | §9                          | E-48             |
| 6-8 | 移行・再整合が設計対象か                | tenant migration、cell migration、schema migration（expand/migrate/contract）、backfill、reconciliation | 移行が毎回手作業              | §9                          | E-65             |

## 7. 処理ランタイムとワークフロー

| #   | 確認観点                            | 合格基準                                                                                                   | 欠落時の典型的な弊害                             | 指針参照                       | 根拠             |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------ | ---------------- |
| 7-1 | ランタイム決定木があるか            | native 統合 → zip Lambda → container image → Fargate → MicroVM → 大規模バッチ の順序に相当する判定         | 「全部 Lambda」または「全部コンテナ」            | §8 決定木、ADR-0008/0009       | E-01、E-90、E-86 |
| 7-2 | Lambda の各形態の位置づけがあるか   | Event Functions 標準、Web Functions 検証候補、MicroVMs sandbox 専用、container image は包装方式            | 新形態を根拠なく全面採用                         | §6 Lambda選択表、ADR-0006/0007 | E-85、E-86、E-90 |
| 7-3 | Step Functions の採用条件があるか   | 状態遷移が業務上可視化すべき概念、Lambda をオーケストレータにしない、wrapper Lambda 禁止                   | Lambda 内 while ループによるオーケストレーション | §8、ADR-0010                   | E-50、E-49       |
| 7-4 | ワークフローの境界ルールがあるか    | 原則 1 bounded context 内、跨ぐ Saga は業務プロセス所有サービスが所有、他サービス DB 直接更新禁止          | ワークフローが全サービスの DB を書き換える       | §8                             | E-49、E-62       |
| 7-5 | Standard/Express の選択基準があるか | 実行時間（Express 5 分）、exactly-once / at-least-once、監査（履歴 90 日）、料金（transition vs duration） | 長時間処理を Express で実行し失敗                | §8、ADR-0010                   | E-21、E-22、E-23 |
| 7-6 | 実行履歴のデータ分類があるか        | 秘密・不要 PII を state に渡さない。256 KiB 超は S3                                                        | 実行履歴から PII 漏洩                            | §8                             | E-24、E-44       |

## 8. 性能予算と同時実行統制

| #   | 確認観点                            | 合格基準                                                                                                           | 欠落時の典型的な弊害                | 指針参照                | 根拠                         |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ----------------------- | ---------------------------- |
| 8-1 | SLO の定義形式があるか              | 成功率、p50/p95/p99、window、除外条件。平均値禁止                                                                  | 平均で合格、p99 で顧客影響          | §10 SLO-first、ADR-0016 | E-82、E-81                   |
| 8-2 | 性能予算の配賦方法があるか          | p99 を API Gateway、authorizer、init、business logic、datastore、downstream、network へ配賦                        | ボトルネックの所在が不明            | §10 性能予算            | E-56                         |
| 8-3 | 同時実行見積りの式と補正があるか    | `RPS × 平均duration` に p95/p99、burst、retry、tenant skew、downstream limit を加味                                | 下流 DB が先に死ぬ                  | §10                     | E-84、E-33、E-32             |
| 8-4 | 一貫性能の手段が列挙されているか    | Provisioned Concurrency の限定適用、reserved concurrency、rate limit、SQS 設定、Power Tuning、arm64、overload test | 全関数に Provisioned Concurrency    | §10 一貫性能の手段      | E-33、E-17、E-68、E-29、E-52 |
| 8-5 | 同時実行上限への対処順序があるか    | 計測 → 削減 → 保護 → 平準化 → 申請 → 隔離 → 地域分散 → ランタイム変更                                              | いきなりアカウント分割で quota 回避 | §11、ADR-0017           | E-84、E-75                   |
| 8-6 | 監視すべき quota メトリクスがあるか | `ConcurrentExecutions`、`UnreservedConcurrentExecutions`、`ClaimedAccountConcurrency`、`Throttles`                 | throttle に気づかない               | §11 計測                | E-84                         |
| 8-7 | アカウント追加の条件があるか        | cell/tenant isolation 境界と運用自動化を伴うこと                                                                   | アカウント乱立                      | §11                     | E-75                         |

## 9. 信頼性

| #   | 確認観点                             | 合格基準                                                                                        | 欠落時の典型的な弊害                  | 指針参照      | 根拠             |
| --- | ------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------- | ------------- | ---------------- |
| 9-1 | timeout の必須化があるか             | 全 network call に connection/request timeout。Step Functions Task に `TimeoutSeconds`          | ハング                                | §12           | E-53、E-24       |
| 9-2 | retry の条件があるか                 | transient error のみ、指数 backoff、full jitter、最大回数/総時間、冪等前提                      | retry storm                           | §12、ADR-0014 | E-53、E-55       |
| 9-3 | retry の所有者ルールがあるか         | 複数 layer で重ねない。チェーンの一箇所が所有                                                   | 多層 retry の増幅                     | §12           | E-56             |
| 9-4 | consumer の必須機能があるか          | partial batch failure、DLQ、redrive、poison message 隔離、visibility timeout ≥ 関数 timeout × 6 | 1件の毒メッセージでバッチ全体が再処理 | §12           | E-18、E-16、E-19 |
| 9-5 | backlog 上限と backpressure があるか | queue backlog 上限と上流への抑制                                                                | 無限キュー                            | §12           | E-54、E-52       |
| 9-6 | static stability の方針があるか      | control plane 障害時も data plane 継続                                                          | 設定サービス停止で全停止              | §12           | E-51             |
| 9-7 | 障害試験の定期実施があるか           | chaos / dependency timeout / throttle / partial outage を staging で定期試験                    | 初回障害が本番                        | §12           | E-52、E-88       |

## 10. セキュリティ

| #    | 確認観点                               | 合格基準                                                                                                      | 欠落時の典型的な弊害   | 指針参照         | 根拠             |
| ---- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------- | ---------------- |
| 10-1 | 最小権限の単位と lint があるか         | function/task 単位の execution role、wildcard IAM の lint（cdk-nag 等）                                       | `*` 権限で越境         | §13、§17 cdk-nag | E-32、E-38、E-36 |
| 10-2 | 監査ログの分離があるか                 | 重要操作を audit log に記録し、保存・アクセス権を通常ログと分ける                                             | 監査証跡が改変可能     | §13              | E-44             |
| 10-3 | 鍵と秘密の方針があるか                 | KMS 粒度（data class × tenant tier）、Secrets Manager/Parameter Store、環境変数・イベントへの秘密埋め込み禁止 | 秘密がログに出る       | §13              | E-25、E-41、E-40 |
| 10-4 | 公開面の脅威モデルが必須か             | public endpoint / Function URL / Web Function endpoint の認証・WAF・rate limit・egress                        | 未認証の公開 URL       | §13              | E-04、E-70       |
| 10-5 | tenant isolation test が CI/E2E 必須か | 異なる tenant token、改ざん tenant ID、推測 ID、非同期 event 改ざん                                           | 越境がリリース後に発覚 | §13、受入基準    | E-47             |

## 11. トレーサビリティと可観測性

| #    | 確認観点                                           | 合格基準                                                                                                                                               | 欠落時の典型的な弊害                 | 指針参照             | 根拠                                      |
| ---- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | -------------------- | ----------------------------------------- |
| 11-1 | 識別子の種類と意味が定義されているか               | `requestId`、`traceId`、`correlationId`、`eventId`、`causationId`、`idempotencyKey`、`tenantId`、`cellId`、`service`、`operation`、`deploymentVersion` | ID の意味がサービスごとに違う        | §14 識別子、ADR-0015 | E-59、E-40                                |
| 11-2 | sampled trace 非依存の相関があるか                 | `correlationId` 等をイベント payload の正式メタデータとして保存                                                                                        | replay や未サンプル時に追跡不能      | §14                  | E-28、E-13                                |
| 11-3 | 標準実装（Powertools 等）が指定されているか        | Logger/Tracer/Metrics/Idempotency/Batch の共通 preset                                                                                                  | 各サービスで独自ロガー               | §14 標準実装         | E-32、E-40                                |
| 11-4 | ログ形式と PII 制御があるか                        | JSON 構造化のみ、PII masking、field allowlist、`logEvent` 無効                                                                                         | PII がログに残る                     | §14                  | E-40、E-44                                |
| 11-5 | 外部 trace header の扱いがあるか                   | 入口で生成/検証し、外部入力を無条件に信頼しない                                                                                                        | trace 汚染                           | §14                  | E-28（parent-based sampling）、E-13       |
| 11-6 | メトリクス dimension の cardinality ルールがあるか | tenant ID を通常 CloudWatch dimension に無制限投入しない                                                                                               | メトリクス費用爆発                   | §14                  | E-43、E-42                                |
| 11-7 | ダッシュボードの絞り込み軸があるか                 | service、operation、tenant tier、cell、deployment version                                                                                              | デプロイ起因の障害を切り分けられない | §14、§19             | E-34（`ExecutedVersion` dimension）、E-77 |

## 12. コスト

| #    | 確認観点                           | 合格基準                                                                                                                  | 欠落時の典型的な弊害                           | 指針参照               | 根拠                         |
| ---- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------- | ---------------------------- |
| 12-1 | 原価の管理単位があるか             | request/workflow/job/tenant/tier 当たりの単位原価                                                                         | 月額総額しか分からない                         | §15 管理単位、ADR-0018 | E-31、E-23                   |
| 12-2 | 含める費用項目が列挙されているか   | API Gateway、Lambda、Step Functions、EventBridge/SQS、DynamoDB、CloudWatch                                                | ログ費用が計算外                               | §15                    | E-42                         |
| 12-3 | shared cost の配賦 driver があるか | tenant activity、request、storage、workflow execution 等                                                                  | 配賦が恣意的                                   | §15                    | E-24（cost allocation tags） |
| 12-4 | 最適化の順序があるか               | 不要処理削減 → direct integration → Power Tuning → arm64 → batch/filter → PC 限定 → Standard/Express → Fargate break-even | 先に Provisioned Concurrency を削って SLO 違反 | §15 最適化順序         | E-94、E-30、E-24、E-33       |

## 13. 開発標準・IaC・CI/CD

| #     | 確認観点                                  | 合格基準                                                                                                                                       | 欠落時の典型的な弊害            | 指針参照                    | 根拠                                                 |
| ----- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------- | ---------------------------------------------------- |
| 13-1  | サービス内部構造の標準があるか            | entrypoints / application / domain / ports / adapters / contracts / observability 相当。handler と業務ロジックの分離                           | handler に業務ロジック          | §16                         | E-32                                                 |
| 13-2  | テスト種別と実施環境があるか              | unit（domain/application）、contract（provider/consumer）、integration（実 AWS）、LocalStack は補助                                            | LocalStack 合格＝本番保証と誤解 | §16                         | E-36（synth は決定的、integration は実環境）、E-88   |
| 13-3  | Construct 階層と責務があるか              | L1/L2、Platform L3、Service Stack、Cell Stage、Environment Stage                                                                               | スタック境界が曖昧              | §17 Construct階層、ADR-0019 | E-36                                                 |
| 13-4  | 共通 Construct の自動付与項目があるか     | 暗号化、log retention、tracing、tags、alarms、DLQ、IAM boundary、tenant middleware、deployment strategy                                        | サービスごとに付け忘れ          | §17                         | E-36、E-76                                           |
| 13-5  | escape hatch と期限付き例外があるか       | 過剰抽象化の回避、例外 ADR                                                                                                                     | Construct が業務要件を阻害      | §17、§20                    | E-36（Construct だけでは compliance を強制できない） |
| 13-6  | スタック境界ルールがあるか                | 直接 resource reference 回避、stateful の retain/termination protection、logical ID 不変、bootstrap/pipeline/observability/control/data の分離 | `cdk destroy` でデータ消失      | §17 スタック境界            | E-36、E-35                                           |
| 13-7  | synth 時の policy-as-code があるか        | cdk-nag、IAM wildcard、public exposure、unencrypted storage、missing alarms                                                                    | ポリシー違反が本番へ            | §17、受入基準               | E-38、E-36                                           |
| 13-8  | 標準 pipeline の段階があるか              | format → lint → typecheck → unit → contract → synth → policy → ephemeral → integration → load smoke → canary → promote                         | テストなしデプロイ              | §18                         | E-88                                                 |
| 13-9  | artifact の一貫性があるか                 | 一度 build し環境間で同一 artifact を promote                                                                                                  | 環境ごとに異なるビルド          | §18                         | E-36（同一 commit は同一 template）                  |
| 13-10 | progressive delivery と rollback があるか | alias/weighted routing、canary、expand/migrate/contract、roll-forward 手順                                                                     | rollback 不能な DB 変更         | §18、ADR-0020               | E-34、E-65                                           |

## 14. 運用・ガバナンス

| #     | 確認観点                           | 合格基準                                                                                                              | 欠落時の典型的な弊害             | 指針参照              | 根拠             |
| ----- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------- | ---------------- |
| 14-1  | 所有メタデータが必須化されているか | `service.yaml` 相当の必須フィールドと「所有者不明はデプロイ不可」                                                     | 誰も直せないサービス             | §3 必須所有メタデータ | E-73、E-76       |
| 14-2  | RACI があるか                      | 業務契約、実装、共通 Construct、SDK、SLO/runbook、組織ポリシー、インシデント、共通基盤障害                            | 障害時の押し付け合い             | §3 RACI               | E-73             |
| 14-3  | サービス運用の必須成果物があるか   | SLO、dashboard、alarm、runbook、on-call、dependency map                                                               | 運用資料なし                     | §19                   | E-73、E-81       |
| 14-4  | アラーム設計方針があるか           | 顧客影響に近い SLI を上位に、queue age/throttles/concurrency/DLQ/error budget burn を標準化                           | 原因候補アラームの洪水           | §19                   | E-18、E-19、E-84 |
| 14-5  | レビュー周期があるか               | 週次 SLO、月次 cost/capacity/quota、四半期 architecture/conformance                                                   | 指針が陳腐化                     | §19                   | E-61             |
| 14-6  | ADR の必須項目があるか             | Context、Decision、Alternatives（2案以上）、Consequences、Evidence、Expiry/Review date、Owner                         | 期限のない例外が恒久化           | §20                   | E-89             |
| 14-7  | 例外プロセスがあるか               | 逸脱を禁止せず記録・期限・見直しで管理                                                                                | 指針が無視される、または硬直化   | §20                   | E-89             |
| 14-8  | 優先 ADR の一覧があるか            | 境界、tenant、API、workflow、data、trace、concurrency 等の主要判断が ADR 化される計画                                 | 判断根拠の喪失                   | 優先ADR一覧           | E-89             |
| 14-9  | 受入基準が検証可能か               | CI が owner/SLO/runbook 欠落を検出、tenant 越境 E2E、idempotency 並行試験、correlationId 全件検索、retain policy 検証 | 「準拠している」が証明不能       | 受入基準              | E-47、E-39、E-36 |
| 14-10 | 主張に出典があるか                 | 閾値・禁止事項・推奨に AWS 文書、企業プラクティス、規格の引用がある                                                   | 根拠のないルールが議論の的になる | 本キットの根拠ルール  | E-89             |

## 総合評価の書き方

1. 各章の「欠落」件数を集計し、**境界・テナント・データ所有・retry/DLQ・IaC 保護**の5領域で欠落があれば Major 以上とする。
2. 指針書が本テンプレートの指針と異なる判断をしている箇所は、「誤り」ではなく「差分」として記録し、相手側の根拠（運用実績、規制、規模、出典）を確認する。
3. 採用可否は「そのまま採用 / 差分を ADR 化して採用 / 不採用」の三択で結論づける。
