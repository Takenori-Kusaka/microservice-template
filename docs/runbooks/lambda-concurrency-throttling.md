# Runbook：Lambda同時実行数 throttling

| 項目   | 内容                                                                                                                                                                                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 対象   | 全サービスのLambda関数。アカウント・リージョン単位の同時実行quota（既定1,000）、function reserved concurrency、SQS `maxConcurrency`                                                    |
| 所有   | account-level alarm：platform-team。function-level alarm：各サービスチーム                                                                                                             |
| 優先度 | critical関数の `Throttles > 0`：P1。account `ConcurrentExecutions > 70%`：P2、`> 85%`：P1。`ClaimedAccountConcurrency > 80%`：P2                                                       |
| 関連   | [指針書11章](../microservice-guidelines.md#11-lambda同時実行数とクォータ)、[10章](../microservice-guidelines.md#10-性能容量)、`apps/platform-cdk/docs/concurrency-budget.md`、ADR-0017 |

throttleは「quotaをどう超えるか」ではなく、**計測 → 削減 → 保護 → 平準化 → 申請 → 隔離** の順で扱う（指針書11章）。本runbookはインシデント時の切り分けと一時対応を扱い、恒常対策は `concurrency-budget.md` とADRへ反映する。

---

## 1. 症状

- クライアントが429（API Gateway経由の `TooManyRequestsException`）。
- `Throttles` メトリクスが特定関数または複数関数で上昇。
- SQS consumerのageが伸びているが `ConcurrentExecutions` が頭打ち。
- Step Functions Taskが `Lambda.TooManyRequestsException` でretry → Catch。
- 非同期invoke（EventBridge → Lambda直接等）がretryされ、遅延。

## 2. ダッシュボード / alarm

| 項目              | 場所                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account dashboard | `platform-concurrency-<env>`：`ConcurrentExecutions`（account）、`UnreservedConcurrentExecutions`、`ClaimedAccountConcurrency`、関数別 `ConcurrentExecutions` top 10、`Throttles` top 10、quota現在値 |
| service dashboard | `<serviceId>-<env>`：関数別 `ConcurrentExecutions` / `Throttles` / `ProvisionedConcurrencySpilloverInvocations`                                                                                       |
| alarm             | `platform-account-concurrency-70` / `-85`、`platform-claimed-concurrency-80`、`<serviceId>-<function>-throttles`                                                                                      |

## 3. 診断手順

### 3.1 どの層のthrottleか

```bash
export ENV=production
export REGION=<region>

# account quota と現在値
aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384 \
  --query 'Quota.{name:QuotaName,value:Value}'
aws lambda get-account-settings --query 'AccountLimit.{concurrent:ConcurrentExecutions,unreserved:UnreservedConcurrentExecutions}'

# account 全体の ConcurrentExecutions（直近15分、最大）
aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name ConcurrentExecutions \
  --start-time "$(date -u -d '-15 minutes' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 60 --statistics Maximum

# ClaimedAccountConcurrency（reserved + provisioned を含む予約済み量）
aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name ClaimedAccountConcurrency \
  --start-time "$(date -u -d '-15 minutes' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 60 --statistics Maximum
```

```bash
# throttle されている関数 top 10（直近15分）
aws cloudwatch get-metric-data --start-time "$(date -u -d '-15 minutes' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --metric-data-queries '[{"Id":"t","Expression":"SORT(SEARCH('"'"'{AWS/Lambda,FunctionName} MetricName=\"Throttles\"'"'"', '"'"'Sum'"'"', 60), SUM, DESC, 10)","ReturnData":true}]' \
  --query 'MetricDataResults[].{fn:Label,values:Values}' --output table
```

| 観測                                                                                      | 層                                                                                    | 節  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --- |
| account `ConcurrentExecutions` ≈ quota、複数関数で `Throttles`                            | **account quota枯渇**                                                                 | 3.2 |
| account余裕あり、`UnreservedConcurrentExecutions` ≈ 0、reserved未設定の関数で `Throttles` | **unreserved pool枯渇**（reservedの合計が大きすぎる、またはreserved外の関数がburst）  | 3.3 |
| 特定関数の `ConcurrentExecutions` ≈ その関数のreserved値、その関数だけ `Throttles`        | **function reserved上限**                                                             | 3.4 |
| SQS consumerのageが伸び、`ConcurrentExecutions` ≈ `maxConcurrency`、`Throttles` なし      | **SQS `maxConcurrency` 上限**（throttleではなくpolling制限）                          | 3.5 |
| `ProvisionedConcurrencySpilloverInvocations` > 0                                          | Provisioned Concurrency超過（spilloverはon-demandで処理され、それ自体は障害ではない） | 3.6 |
| 短時間（10秒程度）のburstで `Throttles`、その後収束                                       | **scaling rate制限**（関数ごとに10秒あたり1,000）                                     | 3.7 |

### 3.2 account quota枯渇

```bash
# 関数別 ConcurrentExecutions top 10（誰が食っているか）
aws cloudwatch get-metric-data --start-time "$(date -u -d '-15 minutes' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --metric-data-queries '[{"Id":"c","Expression":"SORT(SEARCH('"'"'{AWS/Lambda,FunctionName} MetricName=\"ConcurrentExecutions\"'"'"', '"'"'Maximum'"'"', 60), MAX, DESC, 10)","ReturnData":true}]' \
  --query 'MetricDataResults[].{fn:Label,max:Values[0]}' --output table
```

| 支配的な関数                                    | 原因候補                                           | 一時対応                                                                                         |
| ----------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| worker consumer                                 | burst、`maxConcurrency` 未設定または大きすぎ       | `maxConcurrency` を下げる（4.2）                                                                 |
| outbox relay                                    | Streams shard数増（テーブル成長）、relayの遅延蓄積 | relayに上限（reserved）を設定                                                                    |
| 暴走関数（無限ループ、自己invoke、retry storm） | バグ                                               | 該当関数のreserved concurrencyを0にして止める（4.3。AWS best practicesが推奨する手順）→ rollback |
| 新規デプロイされた関数                          | 設定ミス（reserved未設定の大量fan-out）            | rollback                                                                                         |
| 正当な需要増                                    | 成長                                               | quota増枠申請（4.5）。critical関数のreservedで保護（4.1）                                        |

### 3.3 unreserved pool枯渇

```bash
# reserved concurrency を持つ関数と値の一覧
for FN in $(aws lambda list-functions --query 'Functions[].FunctionName' --output text); do
  R=$(aws lambda get-function-concurrency --function-name "$FN" --query ReservedConcurrentExecutions --output text 2>/dev/null)
  [ "$R" != "None" ] && echo "$FN $R"
done | sort -k2 -n -r
```

reservedの合計が `quota - 100` に近いと、unreserved関数の取り分が100しかない。`concurrency-budget.md` と照合し、過大なreservedを下げる（4.1）。`PlatformGuardrails` はsynth時に合計を検査するが、手動変更やquota減少で崩れることがある。

### 3.4 function reserved上限

その関数の需要がreserved値を超えている。

| 関数                                                        | 対応                                                                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| critical API（例：order-service createOrder、reserved 100） | 正当なburstならreservedを増やす（unreserved poolに余裕があること）。tenant skewならtier throttle強化（order-service runbook 4.2） |
| 上限目的のreserved（非重要batch）                           | 想定どおり。遅延を許容。急ぐなら一時的に増やす                                                                                    |

### 3.5 SQS maxConcurrency

throttleではない。[worker-service runbook](worker-service.md) 3.2 / 4.2。下流容量の範囲内で `maxConcurrency` を調整。

### 3.6 Provisioned Concurrency spillover

spilloverはon-demand実行でcold startを伴うため、p99に影響する。恒常的ならPCの値またはスケジュール（Application Auto Scaling）を見直す（ADR-0016）。緊急の一時対応は不要。

### 3.7 scaling rate制限

関数ごと・リージョンごとに10秒あたり1,000 execution environment（または10秒あたり10,000 RPS）の増加率制限。未使用分は繰り越されない。0から数千への瞬間burstで一時的に429でthrottleされる。SQS前段での平準化、またはPC（事前warm）で対応。一時的なら経過観察。

### 3.8 RPS上限

Lambdaは同時実行quotaとは別に、**RPS上限 = 同時実行quota × 10**（既定1,000なら10,000 RPS）をaccount / function両レベルに課す。平均durationが100 ms未満の関数は、`ConcurrentExecutions` に余裕があってもこの上限でthrottleされ得る。この場合の対処は同時実行quotaの増枠申請である。

### 3.9 cross-check：下流への影響

throttleで止めている間に下流が守られているかも確認する。throttle解除（reserved増）によって下流（DynamoDB、外部API）が飽和しないか、各サービスのdashboardで確認してから増やす。

## 4. 復旧手順

### 4.1 reserved concurrencyの変更（一時）

```bash
FN="order-service-createOrder-${ENV}"
aws lambda put-function-concurrency --function-name "$FN" --reserved-concurrent-executions 150
```

制約：reservedの合計 ≤ `quota - 100`（Lambdaは常に100をunreserved用に確保する）。reserved concurrencyは上限であると同時に下限でもあり、他関数はその分を使えなくなる。インシデント後にCDK（`ObservableFunction` の `reservedConcurrency` props）と `concurrency-budget.md` へ反映。

### 4.2 SQS maxConcurrencyの変更（一時）

```bash
UUID=$(aws lambda list-event-source-mappings --function-name "worker-service-fulfill-${ENV}" \
  --query "EventSourceMappings[?contains(EventSourceArn, 'standard-tier')].UUID" --output text)
aws lambda update-event-source-mapping --uuid "$UUID" --scaling-config MaximumConcurrency=10
```

### 4.3 暴走関数の停止

```bash
# reserved 0 で invocation を止める（非同期 invoke は retry → DLQ へ）
aws lambda put-function-concurrency --function-name "<runaway-fn>" --reserved-concurrent-executions 0
# 原因修正・rollback 後に戻す
aws lambda delete-function-concurrency --function-name "<runaway-fn>"
# または元の reserved 値を put
```

SQS consumerの場合はevent source mappingを `--no-enabled` にする方が、visibility timeoutの消費を避けられる。

### 4.4 Provisioned Concurrency（一時）

```bash
aws lambda put-provisioned-concurrency-config --function-name "$FN" --qualifier live --provisioned-concurrent-executions 20
```

alias / versionにのみ設定でき（`$LATEST` 不可）、reservedの範囲内でのみ設定可能。設定量×有効化期間で課金される（5分単位切り上げ）ため、インシデント後に必ず見直す。

### 4.5 quota増枠申請

```bash
aws service-quotas request-service-quota-increase --service-code lambda --quota-code L-B99A9384 --desired-value 2000
aws service-quotas list-requested-service-quota-change-history-by-quota --service-code lambda --quota-code L-B99A9384
```

quota code `L-B99A9384` はAWS General Referenceの「Concurrent executions」（adjustable）である。申請には需要予測（Workload Profile）と負荷試験結果を添える（サポートケースのテキスト）。処理に時間がかかるため、インシデント中の緊急申請に頼らず、`ClaimedAccountConcurrency / SERVICE_QUOTA(ConcurrentExecutions)` が70%に到達した時点で事前申請する（月次capacity review）。新規アカウントは縮小されたquotaから始まり、利用実績に応じてAWSが自動で引き上げる。

### 4.6 隔離（恒常対策、インシデント中は行わない）

account分割（control / data plane、cell、tier）は隔離境界と自動化を伴う構造変更であり、ADR-0003 / 0017で判断する。quota迂回のみを目的に行わない。

## 5. エスカレーション

| 状況                                | 先                                                   |
| ----------------------------------- | ---------------------------------------------------- |
| account quota枯渇で複数サービス影響 | platform-team on-call（P1）。各サービスon-callへ周知 |
| 暴走関数の特定ができない            | platform-team + 該当関数のownerTeam                  |
| quota増枠が処理されない             | AWSサポート（Business以上）に電話エスカレーション    |
| critical APIのthrottleが30分継続    | ownerTeamリード、ステータス連絡                      |

## 6. post-incident

- throttleされた関数、期間、件数、影響テナント。
- 層の特定（account / unreserved / reserved / maxConcurrency / scaling rate）と根本原因。
- `concurrency-budget.md` の更新：関数別予算、reserved配分、quota現在値、次回見直し日。
- 手動変更（reserved、maxConcurrency、PC）のCDK反映。
- 削減施策（duration短縮、batch化、direct integration、fan-out削減）の検討。
- alarm閾値（70% / 85%）での検知が十分早かったか。
- 四半期capacity reviewでの増枠申請タイミングの見直し。

## 7. 出典

| 記述                                                                                                                                                       | 出典（指針書References番号）                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| account既定1,000、reserved合計 ≤ quota − 100、scaling rate 1,000/10秒、RPS = 10×quota、reservedは上限かつ下限                                              | Lambda scaling[39]、scaling behavior[59]                             |
| `ConcurrentExecutions` / `UnreservedConcurrentExecutions` / `ClaimedAccountConcurrency` / `ProvisionedConcurrencySpilloverInvocations` の定義、70% alarm例 | Lambda concurrency monitoring[58]、ClaimedAccountConcurrency発表[41] |
| quota code `L-B99A9384`、新規アカウントの縮小quota                                                                                                         | AWS General Reference Lambda quotas[126]、Lambda quotas[42]          |
| Provisioned Concurrency：alias / version、≤ reserved、課金                                                                                                 | Lambda provisioned concurrency[82]、Lambda pricing[51]               |
| SQS `maxConcurrency` 2〜1,000、reserved以下                                                                                                                | Lambda SQS scaling[62]                                               |
| 暴走時にreserved 0                                                                                                                                         | Lambda best practices[83]                                            |
| Streams `ParallelizationFactor` 最大10                                                                                                                     | Lambda with DynamoDB[85]                                             |
| alarm閾値 70% / 85% / 80%                                                                                                                                  | 例示値（AWS例の70%を参考）                                           |
