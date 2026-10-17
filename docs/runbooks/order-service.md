# Runbook：example-order-service

| 項目               | 内容                                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| serviceId          | `order-service`                                                                                                                                                                                                                                                                       |
| 構成               | CloudFront/WAF → API Gateway HTTP API（JWT authorizer）→ Lambda（createOrder / getOrder / listOrders / updateOrderStatus）→ DynamoDB `orders`（`pk=TENANT#<tenantId>`, `sk=ORDER#<orderId>`、Streams on）+ `idempotency` table → outbox relay Lambda → EventBridge `order.created.v1` |
| ownerTeam / onCall | team-commerce / `pagerduty:commerce-primary`                                                                                                                                                                                                                                          |
| SLO                | availability 99.9%、createOrder p95 300ms / p99 800ms、getOrder p99 300ms（30d）                                                                                                                                                                                                      |
| RTO / RPO          | 1h / 5m（PITR）                                                                                                                                                                                                                                                                       |
| dashboard          | `order-service-<env>`                                                                                                                                                                                                                                                                 |
| 関連               | [脅威モデル](../threat-models/order-service.md)、[DLQ redrive](dlq-redrive.md)、[同時実行throttle](lambda-concurrency-throttling.md)、[指針書6章](../microservice-guidelines.md#6-api設計)、[9章](../microservice-guidelines.md#9-データ設計)                                         |

---

## 0. 最初の5分

1. alarm名から症状を特定する（下表）。
2. dashboard `order-service-<env>` で、availability、p99、throttles、DynamoDB throttled requests、relay iterator age、deployment markerを確認する。
3. **直近のデプロイがあれば、まずrollback**（4.1）。原因調査はrollback後。
4. 影響テナントを特定する（3.1）。

| alarm                                            | 優先度  | 節  |
| ------------------------------------------------ | ------- | --- |
| `order-service-availability-burn-fast` / `-slow` | P1 / P2 | 3.2 |
| `order-service-createOrder-p99`                  | P1      | 3.3 |
| `order-service-createOrder-throttles`            | P1      | 3.4 |
| `order-service-orders-throttled-requests`        | P2      | 3.5 |
| `order-service-outbox-relay-iterator-age`        | P2      | 3.6 |
| `order-service-outbox-relay-dlq`                 | P1      | 3.6 |
| `order-service-idempotency-throttled`            | P2      | 3.7 |
| `order-service-low-traffic`                      | P3      | 3.8 |
| `order-service-authorizer-401-rate`              | P2      | 3.9 |

---

## 1. 症状の例

- クライアントが500 / 503 / 504を受ける。
- `POST /orders` が遅い（p99 > 800ms）。
- 429が増えている（テナントからの問い合わせ）。
- 注文は作成されたが `order.created.v1` が出ない（worker側で履行されない）。
- 同じ注文が二重に作成された、または正当な再送が409になる。
- 特定テナントだけ失敗する。

## 2. ダッシュボード / alarm / ログ

| 項目                   | 場所                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dashboard              | CloudWatch `order-service-<env>`：SLO、latency（operation別）、errors、throttles、concurrency、DynamoDB（consumed / throttled）、Streams iterator age、relay DLQ、deployment marker |
| Application Signals    | service `order-service`：SLO status、error budget                                                                                                                                   |
| API Gateway access log | `/aws/apigateway/order-service-<env>/access`                                                                                                                                        |
| Lambda log             | `/aws/lambda/order-service-createOrder-<env>` 等、`/aws/lambda/order-service-outbox-relay-<env>`                                                                                    |
| audit log              | `/paas/audit/order-service-<env>`                                                                                                                                                   |
| X-Ray                  | service map `order-service`                                                                                                                                                         |

## 3. 診断手順

### 3.1 影響テナントと範囲

```
# Logs Insights: 直近30分のエラーをテナント別に集計（全 order-service log group）
fields tenantId, operation, errorName
| filter level = "ERROR"
| stats count(*) as errors by tenantId, operation, errorName
| sort errors desc
| limit 50
```

```
# API Gateway access log: status 別、tenant 別
fields status, tenantId, routeKey
| filter status >= 500
| stats count(*) by status, tenantId, routeKey
| sort count(*) desc
```

特定テナントに集中していればnoisy neighbor（3.4、3.5）またはそのテナント固有データの問題。全テナントなら共通基盤・デプロイ・下流。

### 3.2 availability低下（5xx増加）

```
fields @timestamp, operation, errorName, errorMessage, requestId, correlationId, tenantId, deploymentVersion
| filter level = "ERROR"
| sort @timestamp desc
| limit 100
```

| `errorName`                                                                  | 原因                                     | 対応                                 |
| ---------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------ |
| `ProvisionedThroughputExceededException` / `ThrottlingException`（DynamoDB） | テーブルthrottle                         | 3.5                                  |
| `TimeoutError`（SDK）/ `DeadlineExceededError`                               | 下流遅延                                 | 3.3、DynamoDBのlatencyメトリクス確認 |
| `TooManyRequestsException`（Lambda）                                         | Lambda throttle                          | 3.4                                  |
| `ZodError` 起因の500（validationは400のはず）                                | バグ。レスポンス変換の不備               | rollback                             |
| `IdempotencyPersistenceLayerError`                                           | 冪等テーブル障害                         | 3.7                                  |
| `AccessDeniedException`                                                      | IAM変更ミス                              | 直近のCDK変更をrollback              |
| `Runtime.ImportModuleError` / 初期化エラー                                   | デプロイ不良（bundle破損、環境変数欠落） | 即rollback                           |

デプロイ直後なら `deploymentVersion` で新旧を比較する。

```
fields deploymentVersion
| filter level = "ERROR"
| stats count(*) by deploymentVersion
```

### 3.3 latency劣化

X-Rayでsubsegment別の時間を確認する。HTTP APIはX-Ray segmentを生成しないため、traceのrootはLambda（active tracing）であり、API Gateway → Lambda間の待ち時間はaccess logの `$context.integrationLatency` とLambdaの `Duration` の差から推定する。

```bash
aws xray get-trace-summaries \
  --start-time "$(date -u -d '-15 minutes' +%s)" --end-time "$(date -u +%s)" \
  --filter-expression 'service("order-service") AND responsetime > 0.8' \
  --query 'TraceSummaries[].{id:Id,duration:Duration,http:Http.HttpURL}' --output table
```

| 支配的なsubsegment                        | 原因候補                                                        | 対応                                                                       |
| ----------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `Initialization`（cold start）            | デプロイ直後のcold多発、bundle肥大、Provisioned Concurrency不足 | 一時的なら経過観察。恒常ならpower-tuning / bundle確認 / PC検討（ADR-0016） |
| `DynamoDB.TransactWriteItems` / `GetItem` | テーブルthrottle、hot partition                                 | 3.5                                                                        |
| `DynamoDB`（idempotency）                 | 冪等テーブルthrottle                                            | 3.7                                                                        |
| Lambda本体（subsegmentなし）              | CPU不足（memory）、同期的な重い処理、ログ出力過多               | memory確認、`LOG_LEVEL` がDEBUGになっていないか                            |
| API Gateway → Lambda間                    | Lambda throttle（キューイング）                                 | 3.4                                                                        |

cold start率：

```
fields cold_start
| stats sum(cold_start) / count(*) as coldRate by bin(5m)
```

### 3.4 Lambda throttle（429 / `Throttles` > 0）

[lambda-concurrency-throttling.md](lambda-concurrency-throttling.md) に従う。order-service固有：

- `createOrder` はreserved concurrency 100。`Throttles` が出ている場合、critical APIが予算を超えている（tenant skew、burst）。
- API Gateway tier別throttle（standard 50 / premium 200 RPS）による429はLambda throttleではない。access logの `status=429` と `tenantId` で確認。

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda --metric-name Throttles \
  --dimensions Name=FunctionName,Value="order-service-createOrder-${ENV}" \
  --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 60 --statistics Sum
```

### 3.5 DynamoDB throttle / hot partition

```bash
TABLE="order-service-orders-${ENV}"
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB --metric-name ThrottledRequests \
  --dimensions Name=TableName,Value="$TABLE" \
  --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 60 --statistics Sum

# on-demand でも partition 単位の上限（3,000 RCU / 1,000 WCU）はある
# CloudWatch Contributor Insights が有効なら hot key を確認
aws dynamodb describe-contributor-insights --table-name "$TABLE"
```

| 状況                                         | 対応                                                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1テナント（1 partition key）への集中書き込み | 一時的：そのテナントのtier throttleを強化（API Gateway）。恒常：write sharding（`pk = TENANT#<id>#<shard>`）をdata-model.mdとADRで設計                           |
| GSIのthrottle                                | GSI keyのcardinality確認。GSI projectionの見直し                                                                                                                 |
| テーブル全体                                 | on-demandは前回ピークの2倍までは即時対応するが、30分以内に2倍を超えるとthrottleされ得る。burst前のpre-warming（warm throughput設定または負荷試験でのwarm）を検討 |

### 3.6 outbox relay（イベントが出ない）

```bash
# iterator age（Streams の遅延）
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda --metric-name IteratorAge \
  --dimensions Name=FunctionName,Value="order-service-outbox-relay-${ENV}" \
  --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 60 --statistics Maximum

# event source mapping の状態
aws lambda list-event-source-mappings --function-name "order-service-outbox-relay-${ENV}" \
  --query 'EventSourceMappings[].{state:State,lastResult:LastProcessingResult,uuid:UUID}'
```

| 状況                              | 対応                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| iterator age上昇、relayエラーなし | relayの `maxConcurrency` / shard数不足。Streams shardは partition数に連動。一時的なら待つ                                    |
| relayエラー（`PutEvents` 失敗）   | EventBridge bus policy / quota（`PutEvents` 10,000 req/s per region）。bus側の障害                                           |
| relay DLQにrecord                 | [dlq-redrive.md](dlq-redrive.md)。outbox itemは `published=false` のまま残るため、原因修正後に `tools/` の再発行scriptで再送 |
| event source mapping `Disabled`   | 誰かが無効化した。有効化し、CloudTrailで操作者を確認                                                                         |
| 24時間超の停止                    | Streams retention（24時間）切れ。`published=false` のoutbox itemを `Query`（GSI `outbox-pending`）して再発行script           |

特定注文のイベントが出たか確認：

```
# relay log
fields @timestamp, eventId, type, tenantId, correlationId, message
| filter correlationId = "<correlationId>"
| sort @timestamp asc
```

### 3.7 冪等テーブル

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB --metric-name ThrottledRequests \
  --dimensions Name=TableName,Value="order-service-idempotency-${ENV}" \
  --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 60 --statistics Sum
```

| 症状                                               | 原因                                                                                                                                                                | 対応                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 正当な再送が409 `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` | クライアントが同一keyで異なるbodyを送っている（タイムスタンプ等をbodyに含めている）                                                                                 | クライアント側修正を依頼。仕様どおり                                                   |
| 409 `IDEMPOTENCY_IN_PROGRESS` が多発               | 前回処理がtimeoutし、in-progressレコードが残っている（Powertoolsは `IdempotencyAlreadyInProgressError` を投げる）                                                   | Lambda timeoutとIdempotencyのin-progress期限の整合を確認                               |
| 二重作成                                           | `Idempotency-Key` なしで送られた（`idempotent: true` routeなら400のはず）、または冪等テーブル障害時のfail-open                                                      | ログで `idempotencyKey` を確認。`throwOnNoIdempotencyKey: true` が設定されているか確認 |
| 期限切れ後の再送で二重作成                         | `expiresAfterSeconds`（本テンプレートは24時間。Powertools既定は1時間）超の再送。期限判定はレコード内timestampで行われ、DynamoDB TTLによる物理削除は期限後48時間以内 | 仕様。クライアントへ案内                                                               |

### 3.8 low traffic

営業時間にrequest数が期待の10%未満。

| 原因候補                    | 確認                                          |
| --------------------------- | --------------------------------------------- |
| CloudFront / WAF でブロック | WAF sampled requests、CloudFront 4xx / 5xx    |
| DNS / 証明書                | `curl -v` でTLS確認                           |
| authorizer全失敗（401）     | 3.9                                           |
| クライアント側障害          | 主要テナントへ確認                            |
| 実際に閑散（祝日）          | カレンダー確認。alarmのスケジュール除外を検討 |

### 3.9 authorizer 401増加

```
# access log
fields @timestamp, status, tenantId, authorizerError
| filter status = 401
| stats count(*) by authorizerError
```

| 原因                                  | 対応                                             |
| ------------------------------------- | ------------------------------------------------ |
| IdPのJWKSローテーション失敗 / IdP障害 | platform-team（control plane）へエスカレーション |
| issuer / audience のSSM parameter変更 | 直近のcontrol plane deployをrollback             |
| クライアントのトークン期限切れ多発    | クライアント側のrefresh不具合。CSへ              |

## 4. 復旧手順

### 4.1 rollback

```bash
# pipeline の rollback（推奨）: 前 deploymentVersion を promote
# 緊急時: alias を前 version へ（CodeDeploy 経由でない手動操作。後で pipeline と整合させる）
FN="order-service-createOrder-${ENV}"
aws lambda list-versions-by-function --function-name "$FN" --query 'Versions[-3:].[Version,LastModified]' --output table
aws lambda update-alias --function-name "$FN" --name live --function-version "<previous>"
```

CDKリソース変更（IAM、環境変数、テーブル設定）を含む場合は、pipelineから前commitを再deployする。手動alias変更はLambda codeのみに効く。

### 4.2 throttle強化（noisy neighbor封じ込め）

```bash
# route throttle を一時的に下げる（CDK context 変更 → deploy が正道。緊急時は console / CLI）
# HTTP API の throttle は stage / route 単位のみ。特定テナントだけを絞るには WAF rate-based rule を使う
aws apigatewayv2 update-stage --api-id <apiId> --stage-name '$default' \
  --route-settings '{"POST /orders":{"ThrottlingRateLimit":20,"ThrottlingBurstLimit":40}}'
```

手動変更はCDK driftになるため、インシデント後にCDK contextへ反映して再deployする。

### 4.3 DynamoDB復旧（データ破損・誤削除）

```bash
# PITR から別テーブル名へ復元（元テーブルは触らない）
aws dynamodb restore-table-to-point-in-time \
  --source-table-name "order-service-orders-${ENV}" \
  --target-table-name "order-service-orders-${ENV}-restore-$(date -u +%Y%m%d%H%M)" \
  --restore-date-time "<ISO8601>"
```

復元テーブルから必要なitemを抽出し、`TransactWriteItems` で本テーブルへ戻す。全面切り替えはCDKのテーブル名変更を伴うため、platform-teamと合意のうえ行う。RTO 1時間を超える見込みなら早期にエスカレーション。

### 4.4 outboxの再発行

```bash
# published=false の outbox item を列挙（GSI outbox-pending）し、再発行 script へ渡す
aws dynamodb query --table-name "order-service-orders-${ENV}" \
  --index-name outbox-pending \
  --key-condition-expression "published = :f" \
  --expression-attribute-values '{":f":{"S":"false"}}' \
  --projection-expression "pk, sk, eventId, correlationId" > /tmp/pending.json

pnpm --filter example-order-service run outbox:republish --input /tmp/pending.json --env "$ENV" --dry-run
pnpm --filter example-order-service run outbox:republish --input /tmp/pending.json --env "$ENV"
```

consumer側は `eventId` で冪等のため、重複発行は無害。

## 5. エスカレーション

| 状況                                                 | 先                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| authorizer / IdP / EventBridge bus / cell router     | platform-team on-call                                                                 |
| テナント越境の疑い（他テナントのデータが返った報告） | security on-call。即時にaudit logと該当 `requestId` を保全。該当routeの一時停止を検討 |
| DynamoDB復旧がRTO内に収まらない                      | platform-team + ownerTeamリード                                                       |
| 複数テナント影響でステータス連絡が必要               | CS                                                                                    |

## 6. post-incident

- タイムライン（検知 / 一次対応 / 復旧）とTTD / TTR（DORAのfailed deployment recovery timeに相当）を記録。
- 影響テナント・件数（`tenantId` 集計）。
- 根本原因と、検知・封じ込め・復旧それぞれの改善。
- 手動変更（alias、throttle）をCDKへ反映したか。
- 再発防止：test追加、alarm閾値、性能予算（ADR-0016）、concurrency budget（ADR-0017）の更新。
- blameless（Google SRE postmortem culture）。

## 7. 出典

| 記述                                                                 | 出典（指針書References番号）                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| HTTP APIはX-Ray segmentを生成しない                                  | API Gateway HTTP vs REST[77]                                 |
| HTTP API access logの `$context.*` 変数                              | HTTP API logging[141]                                        |
| DynamoDB on-demandの2倍 / 30分挙動                                   | DynamoDB on-demand[65]                                       |
| partition上限 3,000 RCU / 1,000 WCU、Contributor Insights            | DynamoDB partition key design[66]、Contributor Insights[127] |
| Streams 24時間保持                                                   | DynamoDB Streams[64]                                         |
| Powertools Idempotencyの期限・in-progress・`throwOnNoIdempotencyKey` | Powertools Idempotency[87]                                   |
| reserved concurrency、`Throttles`                                    | Lambda scaling[39]、Lambda concurrency monitoring[58]        |
| JWT authorizerの公開鍵キャッシュ（最大2時間）                        | HTTP API JWT authorizer[79]                                  |
| HTTP APIはstage / route throttleのみ                                 | HTTP API throttling[78]                                      |
| PITR復元                                                             | DynamoDB（指針書9章）                                        |
| blameless postmortem                                                 | Google SRE Book[93]                                          |
| alarm閾値、reserved 100、throttle値                                  | 例示値（出典なし）                                           |
