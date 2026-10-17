# ADR-0010: Step Functions policy

- Status: accepted
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0001, ADR-0011, ADR-0012, ADR-0014, ADR-0015

## Context

複数ステップの状態遷移、分岐、待機、再試行、補償を Lambda 内のカスタムコードで実装すると、Lambda が「オーケストレータ」になり、実行時間、再試行の重複、可視性の欠如という問題が生じる。AWS は、複雑なエラー・再試行ロジックを Step Functions へ移し、Lambda には業務ロジックを残すことでカスタムコードを減らすことを推奨している。[^27][^28] AWS Prescriptive Guidance の saga orchestration パターンは、database-per-service では 2 相コミットが使えないため、中央のオーケストレータが補償トランザクションで整合性を保つとし、Step Functions Standard workflow での実装を示している。[^87][^29]

Step Functions の Standard と Express の仕様（参照日 2026-10-17）は次のとおり。[^55]

| 項目                         | Standard                                                         | Express                                                      |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| 最大実行時間                 | 1 年                                                             | 5 分                                                         |
| 実行セマンティクス           | exactly-once（`Retry` 指定時を除き同じ state を 2 回実行しない） | 非同期: at-least-once、同期: at-most-once                    |
| 同名 execution               | 実行中の同名 execution があれば冪等に応答                        | 冪等性は管理されない。同名で並行実行される                   |
| 実行履歴                     | API で 90 日間取得可（quota 申請で 30 日に短縮可）               | Step Functions は保持しない。CloudWatch Logs を有効化する    |
| 課金                         | state transition 数                                              | execution 数、実行時間、メモリ                               |
| service integration          | 全パターン                                                       | `.sync`（Job-run）と `.waitForTaskToken`（Callback）は非対応 |
| Distributed Map / Activities | 対応                                                             | 非対応                                                       |
| 変更                         | 作成後に type は変更不可                                         | 同左                                                         |

一方で、Step Functions を無制限に許容すると、state machine が複数サービスの DynamoDB テーブルを直接更新する「分散モノリス」や、native integration で済む処理に wrapper Lambda を作る無駄が生じる。[^28]

`apps/example-workflow-service` は Step Functions Standard による provisioning saga（テナント環境の払い出し）で、各ステップが他サービスの公開 API / command を呼び、失敗時に補償アクションを実行する。これが本 ADR の標準例である。

## Decision

準拠: AWS Step Functions Developer Guide「Choosing workflow type」[^55]、AWS Prescriptive Guidance「Saga orchestration pattern」[^87]、AWS Compute Blog「From AWS Lambda orchestration to AWS Step Functions」[^27]、「Operating Lambda: Anti-patterns」[^28]、AWS Prescriptive Guidance「Database-per-service」[^18]

Step Functions を **許容するのではなく、明示的オーケストレーションの標準候補** とする。ただし次の条件を満たすことを必須とする。

1. 状態遷移、分岐、待機、再試行、補償が業務上可視化すべき概念である。単純な逐次処理には使わない。
2. Lambda を単なるオーケストレータとして使わない。Lambda から別 Lambda を同期 invoke して待つ構造を禁止する。[^28]
3. native service integration（DynamoDB、SQS、EventBridge、SDK integration）で済む処理に wrapper Lambda を作らない。[^27]
4. state machine は原則 1 bounded context 内に置く（ADR-0001）。
5. 複数サービスをまたぐ Saga は「業務プロセス所有サービス」（例: `apps/example-workflow-service`）が所有し、各サービスの公開 API / command / event だけを使う。[^87]
6. workflow から他サービスの DB、DynamoDB テーブル、S3 prefix を直接更新しない。[^18]
7. 実行履歴に載せてよいデータ分類を定め、秘密・不要な PII を state に渡さない。Standard の実行履歴は 90 日保持されるため[^55]、大きな payload や機微データは S3 reference を渡す。
8. Saga の参加者は冪等にする。Prescriptive Guidance は一時障害やオーケストレータ障害での再実行に備えて participant の冪等性を要求している。[^87]（ADR-0014）
9. Standard / Express は次の基準で選ぶ。[^55]

| 基準           | Standard                                      | Express                                                             |
| -------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| 実行時間       | 5 分超〜最大 1 年                             | 5 分以内                                                            |
| 実行モデル     | exactly-once。冪等でない副作用を含む saga     | at-least-once（非同期）。冪等な処理のみ                             |
| 監査           | 実行履歴 90 日が補償の証跡になる              | CloudWatch Logs のみ                                                |
| 統合パターン   | `.sync` / `.waitForTaskToken` が必要な場合    | native integration のみで足りる場合                                 |
| 本 PaaS の既定 | provisioning、tenant migration、補償付き saga | 高頻度の変換 pipeline、同期 API 内の短い合成（synchronous Express） |

`PavedWorkflow` は Standard を既定とし、Express は `workflowType: 'express'` と冪等性の宣言（ADR-0014）を要求する。

## Alternatives

### A. Lambda 内でオーケストレーション（1 Lambda が全ステップを逐次呼ぶ）

- 長所: 1 つの関数で完結し、追加サービスが不要。
- 短所: 15 分上限[^42]、途中失敗時の再開不能、補償ロジックの手書き、再試行の重複、実行状態の不可視。AWS のアンチパターンとして明示されている。[^28]

### B. EventBridge による choreography のみ（オーケストレータなし）

- 長所: サービス間が最も疎結合で、各サービスが独立して反応する。
- 短所: 「今どのステップにいるか」「どこで失敗したか」を横断的に把握できず、補償の責任者が曖昧になる。Prescriptive Guidance は saga choreography を別パターンとして扱い、オーケストレータの単一障害点を避けたい場合の選択肢としている。[^87] 単純な fan-out（ADR-0011）には適するが、補償を要する provisioning のような業務プロセスには不適。

### C. 独自ワークフローエンジン（Temporal など）を ECS 上で運用

- 長所: コードとしてワークフローを書け、言語機能を活用できる。
- 短所: エンジンの運用、DB、worker の管理が managed-first 原則[^11]に反する。中規模 PaaS では Step Functions で十分。

## Consequences

- **費用**: Standard の state transition 課金は高頻度処理で高くなるため[^55]、Express 判定と native integration による transition 削減を行う。
- **性能**: Standard は state transition ごとに実行状態を永続化するため遅延が加わる（公式の遅延値は記載がない。確認日 2026-10-17）[^v1]。同期 API 内の合成には synchronous Express または API composition を使う。[^55]
- **運用**: `PavedWorkflow` が logging、tracing、timeout、retry preset、execution alarm を自動設定する。失敗 execution の redrive 手順を runbook に置く。
- **Lock-in**: ASL（Amazon States Language）は AWS 固有。業務ロジックは Lambda / API 側に置き、state machine は「手順」だけを持つことで lock-in 範囲を限定する。
- **移行**: サービス境界の変更時は、saga の各ステップが公開 API / command しか使っていないため、state machine を所有サービスごと移動できる。

## Evidence

- AWS Compute Blog: Lambda orchestration から Step Functions への移行でカスタムコードが削減された事例。[^27]
- Operating Lambda アンチパターン: Lambda のオーケストレータ化と同期 invoke チェーンの弊害。[^28]
- Prescriptive Guidance / Compute Blog: Saga orchestration の Step Functions 実装。[^87][^29]
- Step Functions Standard は exactly-once、Express は at-least-once / at-most-once。[^55]
- 受入基準「dependency timeout、throttle、poison message、DLQ、workflow compensation を試験できる」を `tests/resiliency/workflow-compensation/` で検証する。`apps/example-workflow-service` の provisioning saga に対し、ステップ 3 で下流 API に 503 を注入し、補償がステップ 2 → 1 の逆順で実行され、最終状態が `ROLLED_BACK` になることを integration test で確認する。
- 受入基準「API → ... → Step Functions を `correlationId` で全件検索できる」を ADR-0015 の trace test で確認する。

### 実測（2026-10-18 sandbox、provisioning workflow の game day）

ap-northeast-1 `paas-sandbox-cell-01` の `apps/example-workflow-service`（`PavedWorkflow`、Standard）。2026-10-18 08:05 JST に `aws events put-events` で bus `paas-sandbox-cell-01-bus` へ `tenant.provisioning-requested.v1` を 3 件発行し、Step Functions の execution history と provisioning table の scan で結果を確認した。失敗は `src/tasks/provision.ts` のシミュレーション（cellId `cell-full` = 恒久失敗、`cell-flaky` = 70% で throw する一時失敗）で注入した。`tests/resiliency/workflow-compensation/` の自動 integration test は未作成で、本結果は手動 game day の記録である（docs/decision/template-defaults.md#計測で確定する項目 M-29）。

| ケース                       | 結果                 | 所要時間 | 経路                                                                                                                                                          | 最終状態（provisioning table）        |
| ---------------------------- | -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| (a) `cell-01`（正常）        | `SUCCEEDED`          | 3.9 秒   | Init → ValidateRequest → ReserveTenantSlot → ProvisionResources → ActivateTenant → PublishProvisioned → Provisioned                                           | slot `TENANT#newco-ok` が `ACTIVE`    |
| (b) `cell-full`（恒久失敗）  | `FAILED`（補償済み） | 3.5 秒   | … → ProvisionResources（失敗）→ Catch → ReleaseTenantSlot → PublishFailed → ProvisioningFailed                                                                | slot は削除済み（table に存在しない） |
| (c) `cell-flaky`（一時失敗） | `SUCCEEDED`          | 24.4 秒  | ProvisionResources で `LambdaFunctionFailed` 4 回 → `TRANSIENT_RETRY`（interval 2 秒、backoff 2、full jitter、maxAttempts 4、maxDelay 30 秒）で再試行後に成功 | slot `ACTIVE`                         |

読み方:

- 補償は Decision の「Catch で補償を逆順に実行する」とおり ReleaseTenantSlot まで戻り、`tenant.provisioning-failed.v1` を発行して `Fail` で終わった。slot が残らないことを table で確認した（runbook `docs/runbooks/workflow-service.md` 4.2 の手動介入は不要だった）。
- 一時失敗は state machine の retry だけで吸収され、Lambda 側の retry や consumer 側の再配信と多重にならなかった（ADR-0014 の「retry owner を 1 層に限定」）。4 回 retry の総時間 24.4 秒は interval 2 秒 × backoff 2（2 + 4 + 8 + 16 = 30 秒上限）に full jitter が入った値で、TD-14 の想定内。
- Evidence 1 行目の integration test（503 注入、最終状態 `ROLLED_BACK`）は未実装。本テンプレートの実装では失敗時の最終状態は「slot 削除 + `ProvisioningFailed`」で、`ROLLED_BACK` という状態値は持たないため、test 作成時に受入基準の表現を合わせる。
- runbook は retry を「最大 3 回」と記載しているが、コード（`TRANSIENT_RETRY`）は maxAttempts 4 で、実測も 4 回 retry した。runbook 側を修正する。

## Compliance / How it is enforced

- `PavedWorkflow` が Standard を既定とし、`workflowType: 'express'` には `idempotent: true` の宣言を要求する。
- `PavedWorkflow` が CloudWatch Logs（ALL レベル、環境別 retention）、X-Ray tracing[^49]、全 Task の timeout と retry preset（指数 backoff、jitter、最大 3 回）、`ExecutionsFailed` / `ExecutionsTimedOut` alarm を自動付与する。
- `PlatformGuardrails` が state machine role の IAM policy を検査し、所有 Service Stack 外の DynamoDB テーブル / S3 bucket への書き込み権限を synth で拒否する。
- `PlatformGuardrails` が Lambda Task の中で `lambda:InvokeFunction` を同期 invoke する IAM 権限（Lambda → Lambda）を検出し、ADR 参照なしの場合は拒否する。
- `ServiceManifest.dataClassification` に基づき、`PavedWorkflow` が `confidential` 以上のデータを扱う state machine の実行履歴に payload をそのまま渡していないことを lint（ASL の `Parameters` に S3 reference 以外の大 payload がないか）で確認する。
- CI の `contract` ステップで、saga の各 Task が参照する API / event が `@paas/api-contracts` / `@paas/event-contracts` に存在することを検査する。

## 参考

[^11]: [Operational Excellence Pillar - AWS Well-Architected Framework](https://docs.aws.amazon.com/pdfs/wellarchitected/latest/operational-excellence-pillar/wellarchitected-operational-excellence-pillar.pdf)（指針書 References より）

[^18]: [Database-per-service pattern (Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-data-persistence/database-per-service.md)（指針書 References より）

[^27]: [From AWS Lambda orchestration to AWS Step Functions](https://aws.amazon.com/blogs/compute/streamlining-aws-serverless-workflows-from-aws-lambda-orchestration-to-aws-step-functions/)（指針書 References より）

[^28]: [Operating Lambda: Anti-patterns in event-driven architectures – Part 3](https://aws.amazon.com/blogs/compute/operating-lambda-anti-patterns-in-event-driven-architectures-part-3/)（指針書 References より）

[^29]: [Building a serverless distributed application using a saga orchestration pattern](https://aws.amazon.com/blogs/compute/building-a-serverless-distributed-application-using-a-saga-orchestration-pattern/)（指針書 References より）

[^42]: [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)（参照日 2026-10-17）

[^49]: [Trace Step Functions request data in AWS X-Ray](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-xray-tracing.html)（指針書 References より）

[^55]: [Choosing workflow type in Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html)（参照日 2026-10-17）

[^87]: [Saga orchestration pattern (AWS Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga-orchestration.html)（参照日 2026-10-17）

[^v1]: [Choosing workflow type in Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html)（参照日 2026-10-17。Standard は「Execution state internally persists between state transitions」、Express は persist しない。遅延の数値は記載なし）
