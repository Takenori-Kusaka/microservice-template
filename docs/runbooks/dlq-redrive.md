# Runbook：DLQ redrive

| 項目   | 内容                                                                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 対象   | `PavedQueueConsumer` が生成する全SQS DLQ（`example-worker-service` のstandard-tier / premium-tier DLQ、outbox relayのon-failure DLQ、EventBridge rule DLQ） |
| 所有   | 各queueの所有サービスチーム（`service.yaml` の `ownerTeam`）                                                                                                |
| 優先度 | DLQ > 0 が5分継続：P2。DLQ > 100 または60分継続：P1                                                                                                         |
| 関連   | [指針書7章](../microservice-guidelines.md#7-イベント設計)、[12章](../microservice-guidelines.md#12-信頼性)、[worker-service runbook](worker-service.md)     |

DLQは終着点ではない。DLQに入ったメッセージは「処理されなかった業務」であり、原因を特定し、redriveするか、退避して業務的に補正するかを必ず決める。

---

## 1. 症状

- alarm `<serviceId>-<queue>-dlq-visible` が発火（`ApproximateNumberOfMessagesVisible > 0`）。
- dashboardのDLQパネルにメッセージ数が表示される。
- 業務側から「注文が履行されない」「プロビジョニングが完了しない」の問い合わせ。

## 2. ダッシュボード / alarm

| 項目      | 場所                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| dashboard | CloudWatch dashboard `<serviceId>-<env>`、「Queues」セクション                                                   |
| alarm     | `<serviceId>-<queue>-dlq-visible`（P2 / P1）、`<serviceId>-<queue>-age`（滞留）、`<serviceId>-<function>-errors` |
| ログ      | `/aws/lambda/<serviceId>-<function>-<env>`。Logs Insightsで `level = "ERROR"`                                    |

## 3. 診断手順

### 3.1 状況把握

```bash
export ENV=production
export QUEUE_URL=$(aws sqs get-queue-url --queue-name "<serviceId>-standard-tier-${ENV}" --query QueueUrl --output text)
export DLQ_URL=$(aws sqs get-queue-url --queue-name "<serviceId>-standard-tier-dlq-${ENV}" --query QueueUrl --output text)

# DLQ件数と最古メッセージ年齢
aws sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names ApproximateNumberOfMessagesVisible ApproximateNumberOfMessagesNotVisible

aws cloudwatch get-metric-statistics \
  --namespace AWS/SQS --metric-name ApproximateAgeOfOldestMessage \
  --dimensions Name=QueueName,Value="<serviceId>-standard-tier-dlq-${ENV}" \
  --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 300 --statistics Maximum
```

### 3.2 サンプル取得（削除せずに覗く）

```bash
# visibility timeout を短くして peek。削除しない
aws sqs receive-message \
  --queue-url "$DLQ_URL" \
  --max-number-of-messages 10 \
  --visibility-timeout 5 \
  --attribute-names All \
  --message-attribute-names All \
  --query 'Messages[].{id:MessageId,receive:Attributes.ApproximateReceiveCount,sent:Attributes.SentTimestamp,body:Body}' \
  --output json > /tmp/dlq-sample.json

# envelope の type / tenantId / correlationId / id を一覧
jq -r '.[] | (.body | fromjson | .detail // .) | [.type, .tenantId, .correlationId, .id] | @tsv' /tmp/dlq-sample.json
```

注意：`receive-message` はメッセージを一時的に不可視にする。`--visibility-timeout 5` で短時間に戻す。

### 3.3 原因の分類

`correlationId` と `eventId` でconsumer Lambdaのログを検索する。

```
# Logs Insights（log group: /aws/lambda/<serviceId>-fulfill-<env>）
fields @timestamp, level, message, errorName, errorMessage, eventId, tenantId, correlationId
| filter eventId = "<eventId>"
| sort @timestamp desc
| limit 50
```

DLQに到達したメッセージは、`maxReceiveCount`（本テンプレートは5。AWSがLambda consumer向けに推奨する下限）回の受信で処理に失敗したものである。

| 分類                                                            | ログの特徴                                                                                 | 対応                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------- |
| **A. 一時障害**（下流timeout、throttle、依存サービス障害）      | `errorName` が `TimeoutError` / `ThrottlingException` / `ServiceUnavailable`。同時刻に多数 | 下流回復を確認後、全件redrive      |
| **B. poison message**（schema不適合、業務的に処理不能なデータ） | `errorName` が `ZodError` / `ValidationError` / 業務例外。特定 `eventId` のみ              | redriveしない。退避して補正        |
| **C. バグ**（デプロイ後に発生、特定codepath）                   | デプロイ時刻（`deploymentVersion`）以降に集中                                              | rollback or hotfix後にredrive      |
| **D. 権限・設定**（`AccessDenied`、環境変数欠落）               | `errorName` が `AccessDeniedException`、初期化エラー                                       | 設定修正後にredrive                |
| **E. 冪等テーブル / consumerテーブルのthrottle**                | `ProvisionedThroughputExceededException`                                                   | 容量確認後にredrive。batchSize調整 |

### 3.4 二度目のDLQ到達（poison判定）

同一 `eventId` が過去にredrive済みでDLQに戻った場合はpoison messageとみなし、再redriveしない。`PavedQueueConsumer` はredrive済みメッセージに `redriveCount` message attributeを付けるため、以下で判定する。

```bash
jq -r '.[] | select(.MessageAttributes.redriveCount.StringValue != null) | .MessageId' /tmp/dlq-sample.json
```

## 4. 復旧手順

### 4.1 分類A / C / D / E：原因解消後のredrive

前提：原因が解消していること（下流回復、rollback完了、設定修正デプロイ完了）。解消前のredriveは再度DLQへ戻り、`ApproximateReceiveCount` を消費するだけである。

```bash
# SQS redrive to source（マネージド機能）。元queueへ戻す
TASK=$(aws sqs start-message-move-task \
  --source-arn "arn:aws:sqs:<region>:<account>:<serviceId>-standard-tier-dlq-${ENV}" \
  --max-number-of-messages-per-second 10 \
  --query TaskHandle --output text)

# 進捗
aws sqs list-message-move-tasks \
  --source-arn "arn:aws:sqs:<region>:<account>:<serviceId>-standard-tier-dlq-${ENV}"

# 必要なら中断
aws sqs cancel-message-move-task --task-handle "$TASK"
```

`--max-number-of-messages-per-second` は下流容量（worker `maxConcurrency` × 1 / 処理時間）を超えないように設定する。上限は500 msg/s、省略時はSQSがbacklogサイズから自動調整する。`StartMessageMoveTask` はSQS queueをsourceとするDLQのみ対応し、1つのqueueに対して同時に実行できるmove taskは1つである。大量redrive時はage alarmが一時的に発火するため、事前にチームチャネルへ周知する。

redrive後の確認：

```bash
# DLQ が 0 に戻り、元 queue の age が SLO 内に収束すること
watch -n 30 "aws sqs get-queue-attributes --queue-url $DLQ_URL --attribute-names ApproximateNumberOfMessagesVisible --query Attributes.ApproximateNumberOfMessagesVisible --output text"
```

### 4.2 分類B：poison messageの退避

```bash
# 1. メッセージを S3 へ退避（削除前に必ず保存）
BUCKET="paas-${ENV}-dlq-quarantine"
TS=$(date -u +%Y%m%dT%H%M%SZ)
aws s3 cp /tmp/dlq-sample.json "s3://${BUCKET}/<serviceId>/standard-tier/${TS}.json"

# 2. 退避済みメッセージを DLQ から削除（ReceiptHandle が必要なため receive し直す）
aws sqs receive-message --queue-url "$DLQ_URL" --max-number-of-messages 10 --visibility-timeout 30 \
  --query 'Messages[].{Id:MessageId,ReceiptHandle:ReceiptHandle}' --output json > /tmp/dlq-handles.json
# 対象 eventId のものだけ選んで削除する（全削除しない）
aws sqs delete-message --queue-url "$DLQ_URL" --receipt-handle "<ReceiptHandle>"
```

退避後、業務的な補正を行う。

| イベント                                      | 補正                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `order.created.v1` が処理不能                 | 注文の状態を確認し、手動履行または `fulfillment.failed.v1` を手動発行（`correlationId` を引き継ぐ）して注文側へ通知 |
| `tenant.provisioning.requested.v1` が処理不能 | tenant registryの状態を確認し、再要求または手動プロビジョニング                                                     |
| outbox relay DLQ（Streams record）            | outbox itemが `published=false` のまま。原因修正後に専用の再発行script（`tools/` に用意）で `PutEvents`             |

補正結果はインシデントticketに記録する。

### 4.3 大量DLQ（> 1,000件）の場合

1. まずconsumerを止めない。redriveの前に原因解消を優先。
2. redrive速度を下流容量に合わせる（`--max-number-of-messages-per-second`）。
3. tier別に優先度をつける：premium DLQを先にredrive。
4. age alarmの一時的な発火は想定内としてチームへ周知。

## 5. エスカレーション

| 状況                                                               | エスカレーション先                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------- |
| 原因が共通基盤（EventBridge bus、control plane、`@paas/*` のバグ） | platform-team on-call                                |
| 原因がセキュリティ（改ざんイベント、権限異常）                     | security on-call。退避したメッセージを証跡として保全 |
| 30分で原因分類ができない                                           | サービスチームのsecondary on-call                    |
| 業務補正に顧客連絡が必要                                           | CS + ownerTeamリード                                 |

## 6. post-incident

- DLQ到達件数、原因分類、redrive件数、退避件数、業務補正内容を記録する。
- 分類B（poison）の場合、producer側のvalidation強化またはschema改訂を検討する（イベントregistry PR）。
- 分類C（バグ）の場合、該当codepathのunit / contract testを追加する。
- 分類A（一時障害）が繰り返される場合、timeout / `maxConcurrency` / 下流容量の見直しをADRまたは `concurrency-budget.md` へ反映する。
- DLQ alarm閾値が適切だったか（検知までの時間）を確認する。

## 7. 予防

- `tests/resiliency/` のpoison message testが、DLQ到達 → alarm → 他メッセージ継続を検証している。
- `maxReceiveCount: 5` を安易に増やさない。増やすとpoison messageがqueueを占有する時間が伸びる。逆に5未満にすると、throttle起因の一時失敗でもDLQへ送られる。
- イベントschema変更は互換性テスト（CI `contract` stage）を通す。

## 8. 出典

| 記述                                                                                           | 出典（指針書References番号）              |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `maxReceiveCount` 5以上、visibility timeout 6倍                                                | Lambda SQS event source configuration[61] |
| SQS保持期間 最大14日                                                                           | SQS message quotas[60]                    |
| `StartMessageMoveTask`：DLQ → 元queue、最大500 msg/s、queueあたり1 task                        | SQS API Reference[114]                    |
| partial batch response、`ApproximateAgeOfOldestMessage` / `NumberOfMessagesDeleted` による確認 | Lambda SQS error handling[139]            |
| EventBridge rule DLQの `ERROR_CODE` 値                                                         | EventBridge DLQ[70]                       |
| alarm閾値（> 0 / > 100 / 60分）                                                                | 例示値（出典なし）                        |
