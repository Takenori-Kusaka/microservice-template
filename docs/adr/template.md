# ADR-XXXX: <English title>

- Status: proposed | accepted | superseded | deprecated
- Date: YYYY-MM-DD
- Owner: <team or person responsible for the decision and its review>
- Review date: YYYY-MM-DD
- Related: ADR-....

<!--
記入ガイド（ガイドライン ch.20「例外と ADR」および docs/adr/README.md の記述ルールに準拠）

指針から外れること自体を禁止しない。代わりに、次を必ず記録する。
- Context: 負荷、データ、SLO、規制、チーム条件
- Decision: 選択と適用範囲。冒頭に「準拠: <組織 / 標準>」の行を置く
- Alternatives: 少なくとも 2 案、それぞれ長所・短所
- Consequences: 費用、性能、運用、lock-in、移行
- Evidence: 負荷試験、見積り、PoC 結果（proposed の場合は実施すべき protocol と合格閾値）
- Expiry/Review date: 再評価日
- Owner: 意思決定と見直し責任者

出典ルール:
- 規範的な記述、数値、上限、料金、「ベストプラクティス」の主張には脚注 [^n] と URL を付ける。
- 出典は AWS 文書、名前のある企業の公開実践、または標準・仕様に限る。AI や個人の意見・記憶を根拠にしない。
- quota / 料金 / 上限 / 製品挙動は記載前に現行ドキュメントで検証し、脚注に参照日を記す。
- 出典のない数値・判断は、「既定値（例示値）: 値 + 設計判断の理由 + 調整: docs/decision/template-defaults.md#既定値レジスタ（TD-NN）」、「計測で確定: 取得方法（M-NN）」、「公式ドキュメントに記載なし（確認日、URL）」のいずれかの形で書き、本テンプレートの初期値・仮定であることを明示する。新しい既定値・計測項目は docs/decision/template-defaults.md に行を追加する。
- 脚注番号は docs/architecture/guidelines-outline.md の References（1〜54）を共有し、新規出典は 55 以降を全 ADR で共通に使う（既存 ADR の「参考」節で番号を確認する）。
-->

## Context

<!--
この決定が必要になった背景を書く。
- 対象となる負荷（RPS、burst、tenant 数、payload）、データ分類、SLO、規制、チーム条件
- 現状の問題と、放置した場合に起きること
- 関連する既存 ADR とガイドラインの章
- 本テンプレートの具体的な構成要素（apps/、packages/@paas/*）との関係
- 根拠となる AWS 仕様・quota・料金は参照日付きで表にする
-->

## Decision

準拠: <組織 / 標準。例: AWS Well-Architected SaaS Lens[^2]、CloudEvents 1.0[^80]>

<!--
何を選び、どこに適用するかを書く。
- 標準として採用するもの、例外として許可するもの、禁止するもの
- 適用範囲（全サービス / 特定サービス / 特定 runtimeProfile / 特定環境）
- 具体的な設定値や閾値は表にし、各行に根拠の脚注、または「既定値（例示値）… 調整: TD-NN」「計測で確定: … M-NN」を付ける
- proposed の場合は accepted へ変更する条件を明記する
-->

## Alternatives

<!-- 少なくとも 2 案。各案に長所と短所を書き、可能なら出典を付ける。 -->

### A. <alternative>

- 長所:
- 短所:

### B. <alternative>

- 長所:
- 短所:

## Consequences

<!-- 5 観点を必ず埋める。推測は「計測で確定: 取得方法（M-NN）」または「公式ドキュメントに記載なし（確認日、URL）」の形で書く。 -->

- **費用**:
- **性能**:
- **運用**:
- **Lock-in**:
- **移行**:

## Evidence

<!--
accepted の場合: 根拠となる負荷試験、見積り、PoC 結果、外部事例、受入基準との対応。
proposed の場合: 実施すべき benchmark / PoC の protocol（対象、負荷、計測項目、合格閾値、結果の記録先）。閾値が外部文献に基づかない場合は「計測で確定: 初回 benchmark の結果を本 ADR に記録し閾値を見直す（M-NN、現在は未計測）」と書く。
-->

## Compliance / How it is enforced

<!--
この決定をどの仕組みが強制するかを書く。文書だけで統制しない。
- @paas/constructs のどの Construct（ObservableFunction, TenantAwareTable, IdempotencyTable, PavedApiService, PavedQueueConsumer, PavedWorkflow, EventSubscription, ServiceObservability, ServiceMetadata, PlatformGuardrails, ServiceStack）
- eslint ルール（paas/*）
- CI ステップ（format, lint, typecheck, unit, contract, synth, policy, deploy ephemeral, integration, load smoke, canary, promote）
- テスト（tests/contract, integration, tenant-isolation, resiliency, performance）
- レビュー（週次 SLO、月次 cost/capacity/quota、四半期 architecture/conformance）
-->

## Expiry / Review date

<!--
- Review date には再評価日を置く。標準 ADR は 6 か月、例外 ADR は最長 12 か月。
- 例外 ADR は Expiry を必須とし、期限を過ぎた例外は PlatformGuardrails が synth を失敗させる。
- 再評価時は、変更がなくても Review date を更新し、評価結果を本節の下に追記する。参照した AWS ドキュメントの参照日も更新する。
- 置き換える場合は Status を superseded にし、Related に新 ADR を記載する。
-->

| 日付       | 評価者 | 結果 |
| ---------- | ------ | ---- |
| YYYY-MM-DD |        | 初版 |

## 参考

<!--
本 ADR で使う脚注の定義をすべて置く。形式:
[^n]: [title](url)（参照日 YYYY-MM-DD）
指針書 References から転記した場合は（指針書 References より）、本文を取得できなかった場合は（本文未取得。確認日 YYYY-MM-DD、取得できなかった理由）と記す。
-->

[^n]: [title](url)（参照日 YYYY-MM-DD）
