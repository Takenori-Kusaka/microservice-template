# Runbook：example-workflow-service

| 項目               | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| serviceId          | `workflow-service`（control plane：テナントプロビジョニング）                                                                                                                                                                                                                                                                                                                                                                                                           |
| 構成               | EventBridge rule（`tenant.provisioning.requested.v1`）→ Step Functions Standard `tenant-provisioning`：Validate → ReserveSlot → Provision → Activate。Catch → RevokeProvision / ReleaseSlot（補償）。各Task = `ObservableFunction`、retry（`TRANSIENT_RETRY`: backoff 2s、rate 2.0、最大4回、full jitter、maxDelay 30s。2026-10-18 の game day で cell-flaky が 4 回 retry 後に成功）、`TimeoutSeconds` 60s。入力に `context.correlationId` / `tenantId` / `tenantTier` |
| ownerTeam / onCall | platform-team / `pagerduty:platform-primary`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| SLO                | 成功率 99%（補償成功含む、30d）。処理開始遅延 5分。1実行 典型2分 / 最大15分                                                                                                                                                                                                                                                                                                                                                                                             |
| dashboard          | `workflow-service-<env>`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 関連               | [指針書8章](../microservice-guidelines.md#8-処理ワークフロー)、[12章](../microservice-guidelines.md#12-信頼性)、[DLQ redrive](dlq-redrive.md)                                                                                                                                                                                                                                                                                                                           |

---

## 0. 最初の5分

| alarm                                   | 優先度 | 意味                                  | 節  |
| --------------------------------------- | ------ | ------------------------------------- | --- |
| `workflow-service-executions-failed`    | P1     | 補償も失敗した、または補償不能な失敗  | 3.2 |
| `workflow-service-executions-timed-out` | P1     | state machine全体のtimeout（15分）    | 3.3 |
| `workflow-service-compensation-rate`    | P2     | 補償経路に入る割合が上昇（> 5%）      | 3.4 |
| `workflow-service-executions-throttled` | P2     | `StartExecution` throttle             | 3.5 |
| `workflow-service-task-*-errors`        | P3     | 特定Taskのエラー率                    | 3.2 |
| `workflow-service-rule-dlq`             | P2     | EventBridge → Step Functions 起動失敗 | 3.6 |

1. dashboardで、実行数（started / succeeded / failed / timed out / aborted）、Task別のerror / duration、補償経路の件数、deployment markerを確認。
2. 失敗実行を `correlationId` / `tenantId` で特定（3.1）。
3. 直近デプロイがあればrollback（4.1）。

## 1. 症状の例

- テナントのプロビジョニングが完了しない（control plane UIで `provisioning` のまま）。
- 実行が `FAILED` で終わり、slot / provisionが残ったまま（補償失敗）。
- 同一テナントに二重にslotが予約された。
- 実行が15分でtimeout。

## 2. ダッシュボード / alarm / ログ

| 項目                   | 場所                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| dashboard              | `workflow-service-<env>`                                                                                                          |
| Step Functions console | state machine `workflow-service-tenant-provisioning-<env>`：実行一覧、実行履歴（state遷移、入出力、エラー）                       |
| state machine log      | `/aws/vendedlogs/states/workflow-service-tenant-provisioning-<env>`（ALL、execution data含む。`restricted` データは含めない設計） |
| Task Lambda log        | `/aws/lambda/workflow-service-<task>-<env>`                                                                                       |
| X-Ray                  | state machine tracing有効。Task Lambdaまでのtrace                                                                                 |

## 3. 診断手順

### 3.1 実行の特定

```bash
export ENV=production
SM_ARN="arn:aws:states:<region>:<account>:stateMachine:workflow-service-tenant-provisioning-${ENV}"

# 失敗実行の一覧
aws stepfunctions list-executions --state-machine-arn "$SM_ARN" --status-filter FAILED --max-results 20 \
  --query 'executions[].{name:name,start:startDate,stop:stopDate}' --output table

# correlationId から実行を探す（state machine log）
```

```
# Logs Insights（state machine log group）
fields @timestamp, execution_arn, type, details.name, details.error, details.cause
| filter details.input like /<correlationId>/ or execution_arn like /<tenantId>/
| sort @timestamp asc
```

実行名は `PavedWorkflow` が `<tenantId>-<correlationId>` 形式で設定しているため、`list-executions` の `name` で絞れる。

### 3.2 失敗実行の履歴

```bash
EXEC_ARN="<executionArn>"
aws stepfunctions describe-execution --execution-arn "$EXEC_ARN" --query '{status:status,input:input,output:output,error:error,cause:cause}'

# 遷移履歴（失敗 state と補償経路を確認）
aws stepfunctions get-execution-history --execution-arn "$EXEC_ARN" --reverse-order --max-results 50 \
  --query 'events[].{id:id,type:type,state:stateEnteredEventDetails.name,failed:taskFailedEventDetails.error,cause:taskFailedEventDetails.cause}' --output table
```

| 失敗state           | 補償経路                      | 典型原因                                  | 対応                                       |
| ------------------- | ----------------------------- | ----------------------------------------- | ------------------------------------------ |
| Validate            | なし（副作用前）              | 入力不正（schema）、tenant registry不整合 | poison相当。入力を確認し、要求元へ差し戻し |
| ReserveSlot         | ReleaseSlot                   | cell容量不足、registry throttle           | 容量確認。registry回復後に再要求（4.3）    |
| Provision           | RevokeProvision → ReleaseSlot | 下流（service API）障害、IAM、quota       | 下流回復後に再要求                         |
| Activate            | RevokeProvision → ReleaseSlot | registry更新失敗                          | 同上                                       |
| 補償state自体が失敗 | —                             | **手動介入必須**。slot / provisionが残る  | 4.2                                        |

Task Lambdaのログ：

```
fields @timestamp, level, errorName, errorMessage, tenantId, correlationId, step
| filter correlationId = "<correlationId>"
| sort @timestamp asc
```

retryが3回尽きた後に `Catch` へ遷移する。`TaskFailed` の `error` が `Lambda.TooManyRequestsException` ならLambda throttle（[lambda-concurrency-throttling.md](lambda-concurrency-throttling.md)）、`States.Timeout` ならTask timeout（60s）。

### 3.3 timeout

| timeout                        | 値   | 原因候補                                                                  |
| ------------------------------ | ---- | ------------------------------------------------------------------------- |
| Task `TimeoutSeconds`          | 60s  | 下流遅延、Lambda timeout（Task LambdaのLambda timeoutはこれより短く設定） |
| state machine `TimeoutSeconds` | 15分 | retryとbackoffの累積、`Wait` state の長期化、下流の長期障害               |

実行履歴で各stateの滞在時間を確認し、支配的なstateを特定する。

### 3.4 補償率上昇

補償経路に入る割合が5%を超える場合、特定のTaskが継続的に失敗している。

```
# state machine log: Catch 遷移の集計
fields details.name
| filter type = "TaskFailed"
| stats count(*) by details.name, details.error
```

原因がdownstream（service API）の劣化なら、該当サービスのrunbookへ。入力起因（特定tier、特定cell）なら、requestの発行元（control plane UI / API）を確認。

### 3.5 StartExecution throttle

Standardの `StartExecution` はtoken bucketでthrottleされる（US East (N. Virginia) / US West (Oregon) / Europe (Ireland) はbucket 1,300・refill 300/秒、その他リージョンはbucket 800・refill 150/秒。soft quota）。EventBridge → Step Functions直接統合がburstした場合、rule DLQ（3.6）に `ERROR_CODE=THROTTLING` で入る。open executionsのquotaは1,000,000 / account / regionであり、通常はStartExecutionのrateが先に上限になる。

```bash
# Step Functions の quota 一覧から StartExecution 関連を確認する（quota code は Service Quotas console で確認）
aws service-quotas list-service-quotas --service-code states \
  --query "Quotas[?contains(QuotaName, 'StartExecution')].{name:QuotaName,value:Value,code:QuotaCode}" --output table
```

対応：rule DLQから再送。恒常ならquota増枠申請、またはEventBridge → SQS → Lambda → StartExecution に変更（平準化）。

### 3.6 rule DLQ

```bash
RULE_DLQ=$(aws sqs get-queue-url --queue-name "workflow-service-rule-dlq-${ENV}" --query QueueUrl --output text)
aws sqs receive-message --queue-url "$RULE_DLQ" --max-number-of-messages 5 --visibility-timeout 5 \
  --message-attribute-names All --query 'Messages[].{attrs:MessageAttributes,body:Body}'
```

| `ERROR_CODE`                                       | 原因                                                         | 対応                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `NO_PERMISSIONS`                                   | rule roleに `states:StartExecution` がない。retryなしで即DLQ | rollback                                                                                           |
| `THROTTLING`                                       | 3.5                                                          | 再送                                                                                               |
| `RESOURCE_ALREADY_EXISTS`                          | 同名実行が既に存在（同一 `tenantId-correlationId` の再要求） | 想定内（Standardのexactly-once：同名の実行中workflowに対してidempotentに応答）。元実行の結果を確認 |
| `ERROR_FROM_TARGET` / `INTERNAL_ERROR` / `TIMEOUT` | 一時障害。`EXHAUSTED_RETRY_CONDITION` が退避理由を示す       | 再送                                                                                               |

rule DLQからの再起動は、メッセージbody（EventEnvelope）を取り出して `StartExecution` を手動実行する（4.3）。

### 3.7 二重プロビジョニング

Standardはexactly-once実行モデルで、実行中のworkflowと同名の `StartExecution` にはidempotentな応答を返し、新しい実行を開始しない（完了後の同名再利用は例外になる。実行履歴は90日で削除され、その後は名前を再利用できる）。二重が起きるのは、異なる `correlationId` で2回要求された場合。

1. tenant registryで該当テナントの状態と `provisioningExecutionArn` を確認。
2. 2つの実行の `correlationId` と `causationId` から、要求元（control plane API）の二重送信かを特定。
3. 後発の実行を `StopExecution` し、補償を手動実行（4.2）。
4. control plane API側の冪等性（`Idempotency-Key`）を確認。

## 4. 復旧手順

### 4.1 rollback

state machine versionとaliasを戻す。

```bash
aws stepfunctions list-state-machine-versions --state-machine-arn "$SM_ARN" --max-results 5
aws stepfunctions update-state-machine-alias --state-machine-alias-arn "${SM_ARN}:live" \
  --routing-configuration '[{"stateMachineVersionArn":"<previousVersionArn>","weight":100}]'
```

aliasは最大2 versionへのweighted routingを持つ。実行中の実行は開始時のversionで継続する。Task Lambdaのrollbackは各関数のalias。

### 4.2 補償失敗時の手動介入

補償（ReleaseSlot / RevokeProvision）が失敗して終わった実行は、slotまたはprovisionが残っている。

1. 実行履歴から、どこまで副作用が進んだかを確認（ReserveSlot成功？ Provision成功？）。
2. 各副作用の所有サービスの公開API / commandで取り消す。**他サービスのDBを直接触らない**。

```bash
# ReleaseSlot 相当（cell capacity service の公開 API 経由）
pnpm --filter example-workflow-service run compensate -- --step release-slot --tenant-id <tenantId> --correlation-id <correlationId> --env "$ENV" --dry-run
pnpm --filter example-workflow-service run compensate -- --step release-slot --tenant-id <tenantId> --correlation-id <correlationId> --env "$ENV"

# RevokeProvision 相当
pnpm --filter example-workflow-service run compensate -- --step revoke-provision --tenant-id <tenantId> --correlation-id <correlationId> --env "$ENV"
```

補償scriptは冪等（複数回実行しても副作用1回分）。

3. tenant registryの状態を `failed` に更新し、要求元へ通知（`tenant.provisioning.failed.v1` を同じ `correlationId` で発行）。
4. audit logに手動介入を記録（`action: manual-compensation`、`subjectId: <operator>`）。

### 4.3 再要求（再実行）

原因解消後、新しい `correlationId` で再要求するか、元のenvelopeで `StartExecution` する。

```bash
# rule DLQ から取り出した envelope（detail）で手動起動。実行名は tenantId-correlationId-retry<N>
aws stepfunctions start-execution --state-machine-arn "${SM_ARN}:live" \
  --name "<tenantId>-<correlationId>-retry1" \
  --input file:///tmp/envelope.json
```

元実行が途中まで副作用を持っていた場合は、先に4.2で補償してから再要求する。Validate / ReserveSlotは冪等に設計されているため、slotが既にある状態での再要求は既存slotを再利用する。

### 4.4 実行の停止

```bash
aws stepfunctions stop-execution --execution-arn "$EXEC_ARN" --error ManualStop --cause "<ticket>"
```

停止はCatchを通らないため、補償は手動（4.2）。

## 5. エスカレーション

| 状況                                                         | 先                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| 下流サービス（cell capacity、registry、order-service）の障害 | 該当サービスのon-call                                       |
| 補償失敗が複数テナントに及ぶ                                 | platform-teamリード。control plane UIでの新規要求を一時停止 |
| 二重プロビジョニングで課金・契約影響                         | CS + 法務確認                                               |
| 実行履歴に `restricted` データが含まれている疑い             | security on-call。log groupのアクセス制限                   |

## 6. post-incident

- 失敗実行数、補償成功 / 失敗数、手動介入数、影響テナント。
- 補償失敗の根本原因と、補償の冪等性・retry設定の見直し。
- Task timeout / retry presetの妥当性（ADR-0010）。
- 実行履歴に載せるデータ分類の再確認。
- 手動補償scriptの改善（dry-run、ログ）。
- `tests/resiliency/` のcompensation testに今回のケースを追加。

## 7. 出典

| 記述                                                                                      | 出典（指針書References番号）              |
| ----------------------------------------------------------------------------------------- | ----------------------------------------- |
| Standard：1年、exactly-once、履歴90日（30日に短縮可）、同名実行のidempotent応答           | Step Functions choosing workflow type[72] |
| open executions 1,000,000、StartExecution token bucket、入出力256 KiB、履歴25,000イベント | Step Functions service quotas[73]         |
| alias = 最大2 versionのweighted routing                                                   | Step Functions versions and aliases[74]   |
| EventBridge DLQ `ERROR_CODE` 値、retry 24時間 / 185回                                     | EventBridge DLQ[70]、retry policy[69]     |
| Saga / 補償                                                                               | AWS saga orchestration[29]                |
| Task timeout 60秒、state machine timeout 15分、成功率SLO                                  | 例示値（出典なし）                        |
