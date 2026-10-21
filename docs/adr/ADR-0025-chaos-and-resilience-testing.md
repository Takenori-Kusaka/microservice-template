# ADR-0025: Chaos and resilience testing (FIS, game days, Resilience Hub)

- Status: accepted
- Date: 2026-10-21
- Owner: platform-team
- Review date: 2027-04-21
- Related: ADR-0003（staging account）, ADR-0010, ADR-0011, ADR-0014, ADR-0016, ADR-0017, ADR-0020, ADR-0026, [第21章 21.2](../microservice-guidelines-resilience-security.md), [runbooks/worker-service.md](../runbooks/worker-service.md), [runbooks/workflow-service.md](../runbooks/workflow-service.md)

## Context

第12章（信頼性）は retry / timeout / DLQ / 補償を設計で要求するが、「設計どおりに壊れるか」を定期的に証明する仕組みが ADR として固定されていなかった。Principles of Chaos Engineering は chaos engineering を「本番の乱れた条件に耐える能力への確信を得るために、システムで実験する規律」と定義し、(1) steady state の仮説、(2) 実世界の事象の再現、(3) 本番での実験、(4) 継続的な自動実行、(5) blast radius の最小化を挙げる。[^216] Netflix Chaos Monkey は本番でインスタンスを無作為に停止する。[^217] AWS Well-Architected REL12-BP04 は「production またはそれに近い環境で定期的に chaos 実験を行う」ことを求め、FIS の stop condition（CloudWatch alarm、template あたり最大 5）を guardrail とし、仮説のテンプレート「If {{fault}} occurs, the {{workload}} will {{mitigating controls}} to maintain {{metric impact}}」、「まず非本番で、次に本番で」、「experiments as code」、「結果の保存」を示す。[^219] REL12-BP05 は game day を定期行事とし、「文書化しただけで試さない」をアンチパターンとする。[^220] Google SRE は test-induced emergency から「rollback 手順を事前に試す」「手順を周知する」教訓を得ている。[^228]

AWS FIS の serverless 対応（参照日 2026-10-18）:

| 対象                            | FIS の対応                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lambda Event Functions          | `aws:lambda:invocation-add-delay`（`startupDelayMilliseconds` 0〜900,000、既定 1,000）、`aws:lambda:invocation-error`（`preventExecution`）、`aws:lambda:invocation-http-integration-response`（`statusCode` / `contentTypeHeader`）。`invocationPercentage` 1〜100[^221]。FIS managed extension を layer として付け `AWS_LAMBDA_EXEC_WRAPPER=/opt/aws-fis/bootstrap` と S3 の設定場所を設定。設定の poll は最大 60 秒間隔で fault 反映に最大 60 秒の ramp-up。response streaming 関数では使えない[^222] |
| Lambda Web Functions / MicroVMs | 公式ドキュメントに記載なし（確認日 2026-10-18、https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html ）。Lambda action の resource type は `aws:lambda:function` のみ[^221]                                                                                                                                                                                                                                                                                                        |
| DynamoDB                        | `aws:dynamodb:global-table-pause-replication` のみ。テーブル単位の throttle / latency / error 注入 action は公式ドキュメントに記載なし（同上）。`aws:fis:inject-api-*` の対象 `service` は `ec2` と `kinesis` のみ[^221]                                                                                                                                                                                                                                                                                 |
| SQS / EventBridge               | 公式ドキュメントに記載なし（確認日 2026-10-18、同 URL）。action 一覧に `aws:sqs:*` / `aws:events:*` は存在しない[^221]                                                                                                                                                                                                                                                                                                                                                                                   |
| stop condition                  | CloudWatch alarm。発火で実験は停止し再開できない[^223]                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 補完ツール                      | Gremlin Failure Flags は AWS Lambda を公式サポートし、sidecar proxy / SDK でアプリ層の fault を注入する。実験停止中はアプリに影響なし[^218]                                                                                                                                                                                                                                                                                                                                                              |

本テンプレートが持つ simulation hook（コードで確認 2026-10-18）:

| hook                                       | 所在                                                    | 挙動                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| sku `POISON-*`                             | `apps/example-worker-service/src/domain/fulfillment.ts` | 恒久失敗。retry せず failed-event 経路へ                                                              |
| sku `FLAKY-ONCE`                           | 同上                                                    | 初回のみ一時失敗、2 回目以降成功                                                                      |
| `cellId = cell-flaky`                      | `apps/example-workflow-service/src/tasks/provision.ts`  | 70% の確率で一時失敗（state machine の backoff + jitter retry を検証）                                |
| `cellId = cell-full`                       | 同上                                                    | 恒久失敗（補償トランザクションを検証）                                                                |
| `tests/resiliency/fault-injection.test.ts` | `tests/resiliency/`                                     | AWS 不要。poison message で retry storm が起きない、下流 publish 失敗が batch item failure として返る |

再生手段の公式仕様: CodeDeploy は deploy 失敗時または alarm 発火時に「最後の正常 revision」を新 deployment として再デプロイする[^226]、EventBridge archive は既定無期限で replay は同時 10 / account / region、`replay-name` 付与、投入から archive 到着まで 10 分待つ[^78]、DynamoDB PITR は回復期間 1〜35 日で常に新テーブルへ復元、`LatestRestorableDateTime` は通常 5 分前[^90]、reserved concurrency 0 で関数を意図的に throttle[^40]、`UpdateEventSourceMapping` の `Enabled=false` で polling を停止[^227]。Resilience Hub は resiliency policy（disruption type ごとの RTO / RPO）で評価し「Policy met / breached」と resilience score を出し、FIS 実験と SOP を推奨、drift を検出する。[^224][^225]

## Decision

準拠: Principles of Chaos Engineering[^216]、AWS Well-Architected REL12-BP04 / REL12-BP05[^219][^220]、AWS FIS Actions reference / Lambda actions / stop conditions[^221][^222][^223]、AWS Resilience Hub[^224][^225]、Google SRE「Emergency Response」[^228]

- **実験は staging を既定とする**（ADR-0003 の `staging` は chaos test 用途）。production では canary（CodeDeploy）と synthetic traffic に限定し、FIS `invocationPercentage` ≤ 10% かつ stop condition 必須とする（既定値（例示値）: 10%。CodeDeploy canary の 10% 段階（TD-25）に揃えた設計判断。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-33））。[^219]
- **実験は code 化する。** FIS experiment template は `apps/platform-cdk` の IaC、アプリ層の fault は `tests/resiliency/` と `@paas/testing` の fixture で管理し、CI（AWS 不要の fault-injection test）と月次 game day の両方で実行する。[^219] 各実験は steady state、仮説（REL12-BP04 の書式）、blast radius、abort 条件（stop condition）、再生手順、記録先を MUST 持つ。
- **FIS は Lambda Event Functions の 3 action に使う。** SQS / EventBridge / DynamoDB テーブル / Web Functions / MicroVMs には FIS action がないため[^221]、アプリ側の simulation hook（`POISON-*`、`FLAKY-ONCE`、`cell-flaky`、`cell-full`）と IAM / 設定変更による擬似障害（EventBridge rule disable、event source mapping `Enabled=false`[^227]、reserved concurrency 0[^40]）で代替する。custom script は「状態把握・ログ・rollback を備える場合のみ」という REL12-BP04 の条件[^219]を、hook を fixture と runbook で管理することで満たす。
- **FIS Lambda extension は staging の `ObservableFunction` にのみ付与し、production には付与しない。** extension の poll による latency と課金の影響は計測で確定: M-25（未計測、layer 未付与）。[^222]
- **game day シナリオ G1〜G9 を正本とする**（値は例示値、仮説の書式は REL12-BP04[^219]）。

  | #   | シナリオ                   | 注入手段                                                                         | steady state / 仮説                                                                        | blast radius             | abort 条件                                   |
  | --- | -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------ | -------------------------------------------- |
  | G1  | API 依存先の遅延           | FIS `invocation-add-delay`（order API、10%、1,500 ms）[^221]                     | p99 ≤ SLO + 遅延分、5xx 率 < 1%、retry 増幅なし（SDK 3 回以内、TD-14）                     | staging の 1 サービス    | availability burn rate fast alarm            |
  | G2  | API 障害 → canary rollback | FIS `invocation-http-integration-response`（500、20%）を canary version に[^221] | CodeDeploy alarm 発火で自動 rollback（TD-25）、全体成功率 ≥ 99%[^226]                      | canary 10%               | rollback 完了 or 5 分                        |
  | G3  | poison message             | sku `POISON-*` を含む `order.created.v1` を投入                                  | 5 回受信後 DLQ、alarm、他メッセージ継続、retry storm なし                                  | worker 1 queue           | DLQ > 100 or age alarm                       |
  | G4  | 一時障害と再生             | sku `FLAKY-ONCE`、`cellId = cell-flaky`                                          | 冪等再実行で副作用 1 回、補償なしで成功                                                    | worker / workflow 1 実行 | 二重履行検出（`IdempotentReplayCount` 異常） |
  | G5  | 配信停止 → 蓄積 → replay   | EventBridge rule を一時 disable                                                  | API 継続、outbox 蓄積、再有効化後に全件配信、archive replay でも二重処理なし[^78]          | 1 bus                    | outbox 未発行 > 1,000 件 or 30 分            |
  | G6  | consumer 停止              | event source mapping `Enabled=false`[^227] or reserved concurrency 0[^40]        | queue 蓄積、age alarm、再開後に backlog 消化が SLO 内                                      | worker 1 関数            | age > 3× SLO                                 |
  | G7  | データ破壊 → PITR 復元     | staging で `DeleteItem` 大量実行                                                 | PITR で任意秒へ復元（RPO ≤ 5 分、TD-29）。新テーブルへの復元と設定再適用を runbook 化[^90] | staging 1 テーブル       | なし（staging 専用）                         |
  | G8  | control plane 停止         | tenant registry の Lambda を reserved concurrency 0[^40]                         | data plane は JWT claims の tier で処理継続（static stability）                            | staging control plane    | API 5xx > 1%                                 |
  | G9  | 侵入シミュレーション       | GuardDuty sample finding、staging で擬似漏えい key（ADR-0026）                   | 検知 → 自動封じ込め → runbook が時間内に完走。TTD / TTC を記録（M-26）                     | staging の 1 テナント    | 封じ込めが他テナントへ波及した時点           |

- 各サービスは G1〜G6 相当の実験を MUST 持ち、staging で月次 SHOULD 実行し、結果（時刻、条件、dashboard、観測）を MUST 記録する（TD-33: staging 月次、security game day 四半期、DR 演習 年次）。[^219]
- 再生手順（rollback、redrive、replay、PITR 復元）は runbook に MUST 書き、game day で SHOULD 実際に実行する。[^220][^228]
- Resilience Hub には `service.yaml` の `rto` / `rpo` を policy に転記し、四半期レビューで評価を再実行する。[^224][^225] Gremlin 等の第三者ツールは、FIS でカバーできないアプリ層 fault（特定テナント向けエラー、二重配信）が staging で必要になった時点で個別 ADR で判断する。[^218]

## Alternatives

### A. FIS のみ（アプリ側 hook なし）

- 長所: 実験が IaC だけで完結し、stop condition と experiment template の管理が AWS 側で統一される。[^221][^223]
- 短所: SQS / EventBridge / DynamoDB テーブル / Web Functions への action がなく[^221]、本テンプレートの主経路（outbox → EventBridge → SQS → consumer → Step Functions）を壊せない。

### B. アプリ側 hook のみ（FIS なし）

- 長所: AWS 不要で CI 実行でき、全 runtime profile で同じ手段が使える（`tests/resiliency/fault-injection.test.ts`）。
- 短所: Lambda の init / invoke 遅延や API Gateway 統合応答の差し替えは実機の fault でしか再現できない。[^221][^222] stop condition（CloudWatch alarm で自動停止）を自前実装する必要がある。

### C. Gremlin Failure Flags を標準にする

- 長所: Lambda を公式サポートし、アプリ層の多様な fault（特定顧客向けエラー、二重配信、API の予期しない応答）を SDK で注入できる。[^218]
- 短所: 有償の第三者 SDK / sidecar を全関数に入れる。FIS + hook で主要シナリオ（G1〜G9）が満たせるため、標準にしない。

### D. production で実験しない（staging のみ）

- 長所: 顧客影響ゼロ。
- 短所: REL12-BP04 は「まず非本番で、次に本番で」を推奨し[^219]、staging は quota / トラフィック / データ量が production と異なる（本テンプレートの sandbox は Lambda quota 10、M-18）。canary + 10% 以下の限定で production でも行う。

## Consequences

- **費用**: FIS の実行費用は action 分数課金（料金は本 ADR では引用しない。採用時に https://aws.amazon.com/fis/pricing/ を確認して Evidence に追記する）。staging の game day は月次 1 回。FIS extension の課金影響は計測で確定: M-25。
- **性能**: FIS extension の poll が `Init Duration` / `Duration` に加算される。[^222] 計測で確定: 付与前後の `Init Duration` p95 と `Duration` p50（M-25）。production には付与しないため SLO への影響なし。
- **運用**: platform-team が FIS experiment template（`apps/platform-cdk`）、simulation hook、game day 記録（`tests/performance/results/README.md` と各 runbook）を保守する。REL12-BP04 の「Capture and store experiment results」に従い、結果は Evidence 節と `docs/decision/template-defaults.md` の M 列へ記録する。[^219]
- **Lock-in**: FIS は AWS 固有だが experiment template は IaC。simulation hook はアプリコードで backend 非依存。
- **移行**: 既存サービスは `tests/resiliency/` に G1〜G6 相当の test を追加し、FIS template を staging に deploy する。Web Functions（`experimental-web`、ADR-0006）は FIS 非対応のため hook のみ。

## Evidence

### 実測（2026-10-17/18、ap-northeast-1 sandbox、Lambda quota 10）

- **負荷試験（M-16 / M-17、`tests/performance/results/order-api-2026-10-18.*`、E-178）**: steady 30 RPS で失敗率 0.03%、client p99 91.5 ms。overload 150 RPS で 28.5%（7,189 件）が throttle（stage throttle の 429 と Lambda quota 10 の 503）されても成功リクエストの p99 は 91.5 ms のまま（goodput 維持）。Lambda throttle 合計 3,728 件（OutboxRelay / Fulfill\* consumer を含む）が発生しても全関数 errors 0、DLQ 8 本すべて 0 件、OUTBOX 残 0、作成 18,014 件すべて `FULFILLED` に収束し、SQS 再配信 + partial batch failure による retry が負荷を増幅しなかった。`ThrottlesAlarm` が 4 本（CreateOrder / OutboxRelay / FulfillPremiumConsumer / SandboxAuthorizer）発火。詳細は [tests/performance/results/README.md](../../tests/performance/results/README.md) §1。
- **provisioning workflow game day（M-29、E-179、2026-10-18 08:05 JST）**: `tenant.provisioning-requested.v1` を 3 件発行。`cell-01` SUCCEEDED 3.9 秒、`cell-full` FAILED 3.5 秒で補償経路（ReleaseTenantSlot → PublishFailed → ProvisioningFailed）が完走し slot 削除、`cell-flaky` SUCCEEDED 24.4 秒（`LambdaFunctionFailed` 4 回を `TRANSIENT_RETRY`（base 2 秒 / backoff 2 / full jitter / maxAttempts 4）で吸収）。runbook 記載の「最大 3 回」はコード（4 回）と不一致で TD-14 に記録。詳細は同 README §3 と [docs/decision/template-defaults.md](../decision/template-defaults.md) M-29。
- **ローカル fault-injection（M-16）**: `tests/resiliency/fault-injection.test.ts` が poison message で retry storm が起きないこと、下流 publish 失敗が batch item failure として返ることを AWS 不要で検証（CI で毎回実行）。

### 未計測（proposed 項目ではなく、accepted 後に追記する計測）

- FIS extension overhead と fault 反映までの秒数（M-25、FIS layer 未付与）。
- G1 / G2 / G5 / G6 / G7 / G8 の staging 初回実行結果（sandbox は quota 10 で reserved concurrency を設定できないため G6 / G8 の reserved concurrency 0 は staging の quota 増枠後に実施）。
- G9 の TTD / TTC（M-26、ADR-0026）。
- canary rollback 試験（M-21、`tests/resiliency/canary-rollback/` 未作成）。

### 受入基準

- `tests/resiliency/` に G1〜G6 相当の試験があり、staging で月次実行の記録が残っている。
- FIS experiment template が IaC で管理され、stop condition に CloudWatch alarm が設定されている。[^223]
- production の実験が canary + `invocationPercentage` ≤ 10% に限定されている（TD-33）。
- EventBridge archive replay、DLQ redrive、PITR 復元を game day で 1 回以上実施した記録がある。
- `service.yaml` の `rto` / `rpo` が Resilience Hub policy と一致し、最新評価が「Policy met」。[^225]

## Compliance / How it is enforced

- `tests/resiliency/fault-injection.test.ts` を CI の `unit` ステップで毎回実行する（AWS 不要）。
- `ObservableFunction` が `EnvironmentConfig.fisExtensionLayerArn`（staging のみ設定、追加予定）を受け取ると FIS layer と `AWS_LAMBDA_EXEC_WRAPPER` / `AWS_FIS_CONFIGURATION_LOCATION` を付与し、`PlatformGuardrails` が production Stage で FIS layer を含む関数を synth で拒否する。[^222]
- FIS experiment template（`AWS::FIS::ExperimentTemplate`）は `apps/platform-cdk` で定義し、`PlatformGuardrails` が `stopConditions` のない template と、production で `invocationPercentage` > 10 の action を synth で拒否する（TD-33）。[^223]
- `PavedQueueConsumer` / `PavedWorkflow` の `@paas/testing` fixture が simulation hook（`POISON-*`、`FLAKY-ONCE`、`cell-flaky`、`cell-full`）を提供し、サービス固有の hook を作らせない。
- 月次 game day の記録は `tests/performance/results/` と各 runbook の「実測」節に残し、四半期 architecture review で REL12-BP04 の「結果の保存」を確認する。[^219]
- Resilience Hub の評価結果（Policy met / breached）を四半期 conformance review の必須項目にする。[^225]

## Expiry / Review date

| 日付       | 評価者        | 結果                                                               |
| ---------- | ------------- | ------------------------------------------------------------------ |
| 2026-10-21 | platform-team | 初版。2026-10-18 の負荷試験と workflow game day を Evidence に記録 |

## 参考

[^40]: [Configuring reserved concurrency for an Event Function](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)（参照日 2026-10-17。「To intentionally throttle an Event Function, set its reserved concurrency to 0.」）

[^78]: [Archiving and replaying events in Amazon EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-archive.html)（参照日 2026-10-17）

[^90]: [Enable point-in-time recovery in DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/PointInTimeRecovery_Howitworks.html)（参照日 2026-10-17）

[^216]: [Principles of Chaos Engineering](https://principlesofchaos.org/)（参照日 2026-10-18）

[^217]: [Chaos Monkey - Netflix](https://netflix.github.io/chaosmonkey/)（参照日 2026-10-18）

[^218]: [Failure Flags overview - Gremlin Docs](https://www.gremlin.com/docs/failure-flags-overview)（参照日 2026-10-18）

[^219]: [REL12-BP04 Test resiliency using chaos engineering - AWS Well-Architected](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_testing_resiliency_failure_injection_resiliency.html)（参照日 2026-10-18）

[^220]: [REL12-BP05 Conduct game days regularly - AWS Well-Architected](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_testing_resiliency_game_days_resiliency.html)（参照日 2026-10-18）

[^221]: [AWS FIS Actions reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)（参照日 2026-10-18）

[^222]: [Use the AWS FIS aws:lambda:function actions](https://docs.aws.amazon.com/fis/latest/userguide/use-lambda-actions.html)（参照日 2026-10-18）

[^223]: [Stop conditions for AWS FIS](https://docs.aws.amazon.com/fis/latest/userguide/stop-conditions.html)（参照日 2026-10-18）

[^224]: [What is AWS Resilience Hub?](https://docs.aws.amazon.com/resilience-hub/latest/userguide/what-is.html)（参照日 2026-10-18）

[^225]: [AWS Resilience Hub concepts](https://docs.aws.amazon.com/resilience-hub/latest/userguide/concepts-terms.html)（参照日 2026-10-18）

[^226]: [Redeploy and roll back a deployment with CodeDeploy](https://docs.aws.amazon.com/codedeploy/latest/userguide/deployments-rollback-and-redeploy.html)（参照日 2026-10-18）

[^227]: [UpdateEventSourceMapping - AWS Lambda API](https://docs.aws.amazon.com/lambda/latest/api/API_UpdateEventSourceMapping.html)（参照日 2026-10-18）

[^228]: [Emergency Response - Google SRE Book](https://sre.google/sre-book/emergency-response/)（参照日 2026-10-18）
