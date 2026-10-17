# レビューキットの使い方

本ディレクトリは、`docs/architecture/guidelines-outline.md`（以下「指針」）を**レビュー基準**として運用するための道具一式である。対象は次の4種類の成果物で、それぞれ専用チェックリストを用意している。

| 対象成果物                              | チェックリスト                                                                   | 主な利用場面                                         |
| --------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 要求仕様書（workload profile を含む）   | [requirements-spec-review-checklist.md](./requirements-spec-review-checklist.md) | 新規サービス企画時、アーキテクチャ判断の前提確認     |
| 設計指針書（他チーム/他社が書いた指針） | [design-guideline-review-checklist.md](./design-guideline-review-checklist.md)   | 指針の採用可否判断、自社指針との差分抽出             |
| 設計書（特定サービスの詳細設計）        | [design-document-review-checklist.md](./design-document-review-checklist.md)     | 実装着手前のデザインレビュー、ADR起票判断            |
| 既存コードリポジトリ                    | [repository-review-checklist.md](./repository-review-checklist.md)               | 既存サービスの適合性監査、テンプレート移行前の棚卸し |

補助資料として、指針が警告するアンチパターン集 [anti-patterns.md](./anti-patterns.md)、全出典の台帳 [evidence-register.md](./evidence-register.md)、判断ガイド `docs/decision/` 配下（質問票、決定木、技術選定根拠）を併用する。

## 根拠（Evidence）のルール

本キットの全チェック項目・アンチパターン・決定木の分岐・技術選定理由は、**名前のある出典**（AWS 公式ドキュメント、Well-Architected / SaaS Lens / Serverless Lens、Builders' Library、Prescriptive Guidance、企業の公開エンジニアリングプラクティス、RFC / CloudEvents / OpenAPI 等の規格）に遡れるようにしている。

- 各表の「根拠」列は `E-NN` で [evidence-register.md](./evidence-register.md) の行を指す。台帳には組織・文書名・URL・確認日がある。
- 出典で確認できなかった事項は「**既定値（例示値）**（`docs/decision/template-defaults.md` の `TD-NN`）」または「**計測で確定**（`M-NN`）」と明記し、事実ではなく仮定として扱う。レビュアはこれを根拠に Blocker を出してはならない。
- 指針の章番号（`指針 §N`）と ADR 番号（`ADR-NNNN`）は組織内ルールの所在、`E-NN` はそのルールを裏付ける外部出典、と役割を分ける。
- 新しい指摘観点を追加するときは、台帳に行を足してから項目を書く。出典がない観点は指針の改訂提案として分離する。

## レビューの進め方

1. **前提の固定**：対象の `service.yaml`（または要求仕様書の workload profile）を読み、`serviceId`、`ownerTeam`、`tenantIsolationModel`、`runtimeProfile`、`slo` を控える。所有者不明の成果物はレビュー不可（指針 §3、根拠 E-73）。
2. **チェックリストの一巡**：各項目を「合格 / 指摘 / 対象外」で判定する。「対象外」には理由を書く。根拠なしの「合格」は認めない（指針 §2 Evidence over defaults）。
3. **指摘の記録**：下記テンプレートで findings 表を作る。各指摘には必ず指針の章番号または ADR 番号と、台帳の `E-NN` を付ける。
4. **重大度の確定**：下記定義に従う。Blocker が1件でもあればレビュー結果は「不合格」。
5. **クロージング**：Blocker/Major は期限付きで対応するか、期限付き例外 ADR を起票する（指針 §20、根拠 E-89）。Minor/Info はバックログ化で可。

## 重大度の定義

| 重大度      | 定義                                                                                     | 典型例                                                                                                                                                                                            | 必要な対応                                           | 根拠                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| **Blocker** | テナント越境、データ喪失、所有者不在など、指針の必須ルール違反で本番投入を止めるべきもの | クライアント入力の `tenantId` でデータアクセス（§5）、他サービスの DynamoDB テーブル直接読取（§4）、production の stateful resource に retain policy なし（§17）、`ownerTeam`/`onCall` 欠落（§3） | デプロイ前に修正。例外 ADR 不可                      | E-47（越境は回復不能になりうる）、E-36（stateful 保護）、E-73（所有者） |
| **Major**   | 運用品質・性能・費用に直接影響し、放置すると障害やコスト逸脱が見込まれるもの             | retry の多層化（§12）、DLQ の alarm/redrive 手順なし（§7）、SLO 未定義（§10）、wildcard IAM（§13）、同期チェーンの多段化（§4）                                                                    | 期限付き修正、または期限・Owner 付き例外 ADR         | E-56、E-19、E-82、E-32                                                  |
| **Minor**   | 指針逸脱だが影響が局所的、または回避策が存在するもの                                     | ログの一部が非構造化（§14）、`service.yaml` の `dashboard`/`runbook` リンク切れ、cursor pagination 未採用の内部 API（§6）                                                                         | 次回リリースまでに対応、またはバックログ             | E-40、E-57                                                              |
| **Info**    | 改善提案、将来の再評価事項、指針側への質問                                               | arm64 未検証（§10）、Web Functions 比較未実施（ADR-0006）、Power Tuning 未実施（§15）                                                                                                             | 記録のみ。四半期 architecture review で再確認（§19） | E-29、E-68                                                              |

重大度を上げる基準：**data plane の既存テナント処理に影響する**（根拠 E-51）、**複数サービスに波及する**、**事後修正にデータ移行を要する**のいずれかに該当すれば一段階上げる。

## Findings 記録テンプレート

レビュー結果は対象リポジトリの `docs/review/findings/<YYYY-MM-DD>-<serviceId>.md` に残す。表の列は固定とする。

```markdown
# Review findings: <serviceId> (<対象成果物の種類>)

- 対象: <ファイル名 / commit SHA / 文書版数>
- レビュー日: <YYYY-MM-DD>
- レビュア: <名前 / チーム>
- 結果: 合格 / 条件付き合格 / 不合格（Blocker 件数）

| ID    | 指針参照            | 出典       | 重大度  | 指摘                                                                                                 | 証跡                                                           | 推奨対応                                                                                       | 期限 / ADR            |
| ----- | ------------------- | ---------- | ------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------- |
| F-001 | 指針 §5 / ADR-0004  | E-47, E-08 | Blocker | `GET /orders` ハンドラが query string の `tenantId` をそのまま `KeyConditionExpression` に渡している | `src/entrypoints/http/list-orders.ts:42`                       | `@paas/runtime-context` の `ExecutionContext.tenantId` に置換し、tenant-isolation テストを追加 | 2026-10-31            |
| F-002 | 指針 §7 / ADR-0013  | E-59, E-44 | Major   | `order.created.v1` の payload に顧客メールアドレスが含まれる                                         | `schemas/events/order.created.v1.json` の `data.customerEmail` | PII を除去し customer-service の API 参照へ変更                                                | 2026-11-15 / ADR-00xx |
| F-003 | 指針 §10 / ADR-0016 | E-29, E-30 | Info    | arm64 への切替が未検証                                                                               | `service.yaml` の `runtimeProfile` が x86_64                   | Power Tuning と負荷試験で比較                                                                  | 次回四半期レビュー    |
```

列の書き方：

- **ID**：`F-` 連番。再レビュー時も番号を引き継ぐ。
- **指針参照**：`指針 §N` と、該当すれば `ADR-NNNN`。
- **出典**：台帳の `E-NN`。根拠が「既定値（例示値）」（`TD-NN`）または「計測で確定」（`M-NN`）だけの観点は Info までに留める。
- **指摘**：事実のみ。推測は「〜と見える」と書き分ける。
- **証跡**：ファイル名と行番号、設計書の節番号、または計測値。証跡のない指摘は Info に落とす。
- **推奨対応**：テンプレートの対応物（例：`PavedQueueConsumer` の利用、`TenantAwareTable` への置換）を名指しする。
- **期限 / ADR**：日付、または例外 ADR 番号。Blocker は期限必須、ADR 不可。

## レビュー粒度の目安

| 対象       | 標準所要時間 | 必読資料                               |
| ---------- | ------------ | -------------------------------------- |
| 要求仕様書 | 1〜2時間     | 指針 §1、§5、§10、「主要な初期判断」表 |
| 設計指針書 | 半日         | 指針全章、「優先ADR一覧」              |
| 設計書     | 2〜4時間     | 指針 §4〜§14、該当 ADR                 |
| リポジトリ | 半日〜1日    | 指針 §13〜§18、`service.yaml`、CI 定義 |

## レビュアの禁止事項

- 指針と台帳に根拠のない個人の好みを指摘しない。必要なら指針改訂提案として分けて出す。
- 「最新だから」「流行だから」を理由に技術変更を要求しない。選定根拠は `docs/decision/technology-selection-rationale.md` の運用実態と出典に基づく（指針 §2）。
- 例外 ADR の存在だけで合格にしない。ADR に Expiry/Review date と Owner があるかを確認する（指針 §20、根拠 E-89）。
- 計測結果なしに memory、timeout、concurrency、Provisioned Concurrency の値を是認しない（指針 §2、根拠 E-32、E-33、E-68）。
- 「既定値（例示値）」「計測で確定」の項目を Blocker/Major の根拠にしない。

## 指針との同期

チェックリスト項目はすべて指針の章番号と台帳 ID に紐づく。指針または台帳を改訂したときは、以下の手順で本キットを更新する。

1. 改訂した章番号または `E-NN` で `docs/review/` と `docs/decision/` を grep し、該当項目を洗い出す。
2. 項目の追加・削除・合格基準変更を同一 PR に含める。
3. ADR 番号や台帳 ID の付け替えがあれば `anti-patterns.md`、`technology-selection-rationale.md`、`decision-trees.md` の参照も更新する。
4. 台帳の確認日が 12 か月を超えた出典は、四半期レビューで再取得する。
