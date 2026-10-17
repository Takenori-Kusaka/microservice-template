# Runbook：example-worker-service

| 項目               | 内容                                                                                                                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| serviceId          | `worker-service`                                                                                                                                                                                                                                                                               |
| 構成               | EventBridge rule（`order.created.v1`）→ SQS standard-tier（`maxConcurrency` 20）/ premium-tier（`maxConcurrency` 50）→ Lambda `fulfill`（`BatchProcessor`、partial batch failure）→ 外部履行API。発行：`order.fulfilled.v1` / `fulfillment.failed.v1`。DLQ（tier別、14日）、redrive、age alarm |
| ownerTeam / onCall | team-commerce / `pagerduty:commerce-primary`                                                                                                                                                                                                                                                   |
| SLO                | 処理開始遅延 p95：premium 60s / standard 300s。end-to-end（created → fulfilled）p95 5分。DLQ率 < 0.1%                                                                                                                                                                                          |
| dashboard          | `worker-service-<env>`                                                                                                                                                                                                                                                                         |
| 関連               | [DLQ redrive](dlq-redrive.md)、[同時実行throttle](lambda-concurrency-throttling.md)、[order-service](order-service.md)、[指針書7章](../microservice-guidelines.md#7-イベント設計)、[12章](../microservice-guidelines.md#12-信頼性)                                                             |

---

## 0. 最初の5分

| alarm                              | 優先度  | 意味                                                     | 節                               |
| ---------------------------------- | ------- | -------------------------------------------------------- | -------------------------------- |
| `worker-service-premium-tier-age`  | P1      | premium の処理開始が遅れている（> 120s）                 | 3.2                              |
| `worker-service-standard-tier-age` | P2      | standard の処理開始が遅れている（> 600s）                | 3.2                              |
| `worker-service-*-dlq-visible`     | P2 / P1 | 処理失敗が3回続いたメッセージがある                      | [dlq-redrive.md](dlq-redrive.md) |
| `worker-service-fulfill-errors`    | P3      | エラー率上昇（SLO内の兆候）                              | 3.3                              |
| `worker-service-fulfill-throttles` | P2      | Lambda throttle（`maxConcurrency` または account quota） | 3.4                              |
| `worker-service-rule-dlq`          | P2      | EventBridge → SQS の配信失敗                             | 3.5                              |
| `worker-service-no-events`         | P3      | 営業時間にイベントが来ない                               | 3.6                              |

1. dashboardで、tier別のqueue depth / age / in-flight、Lambda concurrency / errors / throttles、DLQ、外部API latencyを見る。
2. 直近デプロイがあればrollback（4.1）。
3. ageが伸びていてエラーがなければ容量不足（3.2）。エラーがあれば原因分類（3.3）。

## 1. 症状の例

- 注文が履行されない / 遅い（テナント問い合わせ）。
- premium テナントの履行がstandardと同じく遅い。
- DLQにメッセージが溜まる。
- 同じ注文が二重に履行された。
- 外部履行APIからrate limit（429）を受けている。

## 2. ダッシュボード / alarm / ログ

| 項目       | 場所                                                                                                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dashboard  | `worker-service-<env>`：tier別 `ApproximateAgeOfOldestMessage` / `ApproximateNumberOfMessagesVisible` / `NotVisible`、Lambda `ConcurrentExecutions` / `Errors` / `Throttles` / `Duration`、batch item failure率、DLQ、外部API latency / 429、deployment marker |
| Lambda log | `/aws/lambda/worker-service-fulfill-<env>`                                                                                                                                                                                                                     |
| X-Ray      | SQS → Lambda 自動リンク。`correlationId` でorder-serviceの入口まで遡れる                                                                                                                                                                                       |

## 3. 診断手順

### 3.1 状況把握

```bash
export ENV=production
for TIER in premium standard; do
  Q=$(aws sqs get-queue-url --queue-name "worker-service-${TIER}-tier-${ENV}" --query QueueUrl --output text)
  echo "== $TIER"
  aws sqs get-queue-attributes --queue-url "$Q" \
    --attribute-names ApproximateNumberOfMessagesVisible ApproximateNumberOfMessagesNotVisible ApproximateNumberOfMessagesDelayed
done

aws lambda get-function-concurrency --function-name "worker-service-fulfill-${ENV}"
aws lambda list-event-source-mappings --function-name "worker-service-fulfill-${ENV}" \
  --query 'EventSourceMappings[].{uuid:UUID,state:State,maxConc:ScalingConfig.MaximumConcurrency,batch:BatchSize,source:EventSourceArn}'
```

### 3.2 age上昇（処理が追いつかない）

| 観測                                                                                    | 原因                                                                  | 対応                                                                                   |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `NotVisible` が `maxConcurrency × batchSize` 付近で張り付き、エラーなし、durationが通常 | 純粋な容量不足（burst）                                               | 一時的ならSLO内に回復するか待つ。恒常なら `maxConcurrency` 増（下流容量の範囲内。4.2） |
| durationが通常の数倍                                                                    | 外部履行APIの遅延                                                     | 外部API status確認。timeout（`deadline`）で早期failにしているか。4.3                   |
| `Throttles` > 0                                                                         | account concurrency枯渇、または `maxConcurrency` 上限                 | [lambda-concurrency-throttling.md](lambda-concurrency-throttling.md)                   |
| premiumだけ遅い                                                                         | premium queue の `maxConcurrency` 不足、またはpremium テナントのburst | premium `maxConcurrency` 増。standard から一時的に振り替え（合計を下流容量内に）       |
| エラー多発で `maxReceiveCount` 消費 → visibility timeout分だけ遅延                      | 3.3                                                                   | 3.3                                                                                    |
| event source mapping `Disabled`                                                         | 誰かが無効化                                                          | 有効化。CloudTrailで操作者確認                                                         |

visibility timeoutはLambda timeout（60s）× 6 + batching window = 360s以上（AWS推奨）。失敗したメッセージは最大360s後に再配信され、`maxReceiveCount` 5回でDLQへ送られるため、エラー多発時はageが段階的に伸びる。Lambdaは関数コード起因の失敗時にevent source mappingの同時実行を段階的に絞る（backoff）ため、ageの伸びはエラー率に比例する。

### 3.3 エラー分類

```
fields @timestamp, errorName, errorMessage, eventId, tenantId, tenantTier, correlationId, deploymentVersion
| filter level = "ERROR"
| stats count(*) as c by errorName, tenantTier
| sort c desc
```

| `errorName`                              | 原因                                                        | 対応                                                            |
| ---------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| `FulfillmentApiError` 429 / 503          | 外部履行APIのrate limit / 障害                              | 4.3。`maxConcurrency` を一時的に下げて外部APIを保護             |
| `TimeoutError` / `DeadlineExceededError` | 外部API遅延                                                 | 同上                                                            |
| `ZodError`（envelope検証）               | producer（order-service）のschema変更、またはregistry不整合 | poison。DLQへ。producer側の `contract` stageが通っていたか確認  |
| `UnknownEventVersionError`               | 未対応version（`order.created.v2`）が来た                   | consumer側のregistry更新をデプロイ。それまでDLQ                 |
| `IdempotencyAlreadyInProgressError`      | 同一 `eventId` の並行処理（at-least-once配信の重複）        | 想定内。batch item failureにならないことを確認（skip扱い）      |
| `ConditionalCheckFailedException`        | fulfillment stateの競合                                     | 想定内（冪等）。多発なら重複配信が異常に多い。EventBridge側確認 |
| `AccessDeniedException`                  | IAM変更ミス                                                 | rollback                                                        |

### 3.4 Lambda throttle

[lambda-concurrency-throttling.md](lambda-concurrency-throttling.md)。worker固有：

- `maxConcurrency`（event source mapping）による制限は `Throttles` に計上されない。queue側でpollingが止まる（ageが伸びる）。
- `Throttles` が出るのは、account unreserved poolの枯渇、またはfunction reserved concurrencyを超えた場合。
- workerがcritical API（order-service createOrder、reserved 100）を侵食していないかを確認。侵食していれば、workerの `maxConcurrency` を下げる。

### 3.5 EventBridge rule DLQ（配信失敗）

```bash
RULE_DLQ=$(aws sqs get-queue-url --queue-name "worker-service-rule-dlq-${ENV}" --query QueueUrl --output text)
aws sqs receive-message --queue-url "$RULE_DLQ" --max-number-of-messages 5 --visibility-timeout 5 \
  --message-attribute-names All --query 'Messages[].{attrs:MessageAttributes,body:Body}'
```

EventBridgeはDLQメッセージに `RULE_ARN` / `TARGET_ARN` / `ERROR_CODE` / `ERROR_MESSAGE` / `EXHAUSTED_RETRY_CONDITION` / `RETRY_ATTEMPTS` のmessage attributeを付与する。

| `ERROR_CODE` attribute                             | 原因                                                                                                                          | 対応                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `NO_PERMISSIONS`                                   | SQS queue policyがEventBridgeを許可していない（CDK変更ミス）。retryなしで即DLQ                                                | rollback                 |
| `NO_RESOURCE`                                      | queue削除 / 不正なARN。retryなしで即DLQ                                                                                       | 復旧deploy               |
| `RESOURCE_LIMIT_EXCEEDED` / `THROTTLING`           | SQS側のthrottle                                                                                                               | 一時的。rule DLQから再送 |
| `TIMEOUT` / `INTERNAL_ERROR` / `ERROR_FROM_TARGET` | 一時障害。`EXHAUSTED_RETRY_CONDITION` が `MaximumRetryAttempts` または `MaximumEventAgeInSeconds`（既定24時間 / 185回）で退避 | rule DLQから再送         |
| `INVALID_JSON` / `INVALID_PARAMETER`               | producer側の不正なイベント                                                                                                    | producer修正。poison扱い |

rule DLQはEventBridgeをsourceとするため、SQSの `StartMessageMoveTask`（SQS queueをsourceとするDLQのみ対応）では戻せない。rule DLQからの再送は、AWSが案内する方法のいずれかで行う：(a) rule DLQをLambdaのevent sourceにしてbody（イベント）を元のSQS queueへ `SendMessage` するconsumerを用意する、(b) SDK / CLIでメッセージを読み取り、元のSQS queueへ `send-message` する。

### 3.6 イベントが来ない

| 確認                                                 | コマンド                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| order-service が発行しているか                       | order-service runbook 3.6（outbox relay）                                                                   |
| ruleが有効か                                         | `aws events describe-rule --name worker-service-order-created-<env> --event-bus-name paas-<env>-cell-a-bus` |
| rule patternが `detail-type` / `source` と一致するか | `aws events test-event-pattern --event-pattern file://pattern.json --event file://sample.json`              |
| busに届いているか                                    | bus のCloudWatch metrics `Invocations` / `FailedInvocations`（rule別）                                      |

### 3.7 二重履行の報告

1. `correlationId` で両方の履行ログを取得し、`eventId` が同一か確認。
2. 同一 `eventId`：consumer冪等の失敗。冪等テーブル（Powertools Idempotency）のthrottle / TTL / fail-open設定を確認。
3. 異なる `eventId`：producer側で2回発行されている（outbox二重書き込み、relay再処理）。order-service runbookへ。
4. 業務補正：外部履行APIでの取消と `fulfillment.failed.v1` または補正イベント発行。

## 4. 復旧手順

### 4.1 rollback

```bash
FN="worker-service-fulfill-${ENV}"
aws lambda update-alias --function-name "$FN" --name live --function-version "<previous>"
```

CDKリソース変更を含む場合はpipelineから。

### 4.2 maxConcurrency変更（一時）

```bash
UUID=$(aws lambda list-event-source-mappings --function-name "worker-service-fulfill-${ENV}" \
  --query "EventSourceMappings[?contains(EventSourceArn, 'premium-tier')].UUID" --output text)
aws lambda update-event-source-mapping --uuid "$UUID" --scaling-config MaximumConcurrency=40
```

`maxConcurrency` は2〜1,000の範囲で、関数のreserved concurrency以下にする（reservedを超えるとLambdaがthrottleする）。合計（premium + standard）が外部履行APIの容量（100 req/s ÷ 処理時間）と、account concurrency budgetを超えないこと。手動変更はインシデント後にCDK contextへ反映する。

### 4.3 外部履行API障害時

1. `maxConcurrency` を下げて外部APIへの負荷を抑える（429を減らす）。
2. 外部API回復まで、メッセージはqueueに滞留（14日保持）。ageはSLO違反になるが、DLQ行きを避けるため `maxReceiveCount` を一時的に増やす**のではなく**、event source mappingを一時 `Disabled` にして受信自体を止める選択肢を検討する（visibility timeoutの消費を避ける）。

```bash
aws lambda update-event-source-mapping --uuid "$UUID" --no-enabled
# 回復後
aws lambda update-event-source-mapping --uuid "$UUID" --enabled
```

3. 回復後、ageの回復速度を監視。premium優先で `maxConcurrency` を戻す。
4. 既にDLQに入った分は [dlq-redrive.md](dlq-redrive.md)。

### 4.4 poison message

[dlq-redrive.md](dlq-redrive.md) 4.2。

## 5. エスカレーション

| 状況                                              | 先                             |
| ------------------------------------------------- | ------------------------------ |
| EventBridge bus / account concurrency / `@paas/*` | platform-team on-call          |
| 外部履行APIの長期障害                             | ownerTeamリード + ベンダー窓口 |
| 二重履行で顧客影響                                | CS + ownerTeamリード           |
| 改ざんイベントの疑い                              | security on-call               |

## 6. post-incident

- tier別のage推移、DLQ件数、redrive件数、業務補正件数。
- `maxConcurrency` / timeout / `maxReceiveCount` の見直し（`concurrency-budget.md`、ADR-0017）。
- 外部API依存の非同期化・サーキットブレーカー検討。
- 手動変更のCDK反映。
- poison原因のproducer側修正（schema、validation）。

## 7. 出典

| 記述                                                          | 出典（指針書References番号）              |
| ------------------------------------------------------------- | ----------------------------------------- |
| visibility timeout 6倍 + batching window、`maxReceiveCount` 5 | Lambda SQS event source configuration[61] |
| `maxConcurrency` 2〜1,000、reserved以下                       | Lambda SQS scaling[62]                    |
| 失敗時のbackoff（同時実行を絞る）、partial batch response     | Lambda SQS error handling[139]            |
| EventBridge DLQ attributes、`ERROR_CODE` 値、再送方法         | EventBridge DLQ[70]                       |
| EventBridge retry 24時間 / 185回                              | EventBridge retry policy[69]              |
| EventBridgeは順序保証なし                                     | AWS Decision Guide[57]                    |
| SQS `StartMessageMoveTask` はSQS sourceのDLQのみ              | SQS API Reference[114]                    |
| EventBridge PutEventsサイズ上限 1 MB                          | EventBridge PutEvents[71]                 |
| age SLO、`maxConcurrency` 値、外部API容量                     | 例示値（出典なし）                        |
