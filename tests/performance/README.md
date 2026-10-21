# Performance tests

指針 §10「性能・容量」「Evidence over defaults」に基づき、Provisioned Concurrency、メモリ、同時実行予算は **ここで測ってから** 決める。

| ステップ        | コマンド                                                            | 判定                                                                                           |
| --------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1. Power tuning | `pnpm power-tuning ...`（tools/power-tuning）                       | メモリ候補を balanced で選ぶ                                                                   |
| 2. 定常負荷     | `k6 run tests/performance/order-api.k6.js`（steady シナリオ）       | p99 < service.yaml の `latencyP99Ms`、error rate < 0.1%                                        |
| 3. 過負荷       | 同スクリプト overload シナリオ                                      | 429/503 が増えても成功リクエストの p99 と goodput が維持される（tipping point 後の崩壊がない） |
| 4. 記録         | `tests/performance/results/*.json` を ADR-0016 の Evidence へリンク |                                                                                                |

観測項目（CloudWatch）: `ConcurrentExecutions`、`Throttles`、`ClaimedAccountConcurrency`、API Gateway `5XXError`/`Latency` p99、DynamoDB `ThrottledRequests`、SQS `ApproximateAgeOfOldestMessage`。

出典: Amazon Builders' Library「Using load shedding to avoid overload」「Resilience lessons from the lunch rush」、AWS Well-Architected Serverless Lens（性能最適化）。

## Event Functions vs Web Functions（ADR-0006 / M-06）

同一 workload を両 compute に送り、`results/` の summary export と CloudWatch を比較する。Web 側は実験 stack（`pnpm synth --context env=sandbox --context experimentalWeb=true` → deploy）が前提で、endpoint は `IamAuth`（SigV4 署名、`X-Amz-Content-SHA256` 必須。Lambda は `Authorization` を削除してから転送するため sandbox claims は `x-paas-sandbox-claims` header で渡す）。

```bash
# Event side
TARGET=event PAAS_API_URL=https://<api-id>.execute-api.ap-northeast-1.amazonaws.com \
  k6 run --summary-export tests/performance/results/<date>.event.summary.json tests/performance/event-vs-web.k6.js
node tests/performance/collect-metrics.mjs --start <iso> --end <iso> --api-id <api-id> --out tests/performance/results/<date>.event.cloudwatch.json

# Web side (static credentials for SigV4; the console-session credentials of `aws login` are exported the same way)
eval "$(aws configure export-credentials --format env)"
TARGET=web PAAS_WEB_URL=https://<WebEndpointDomain output> AWS_REGION=ap-northeast-1 \
  k6 run --summary-export tests/performance/results/<date>.web.summary.json tests/performance/event-vs-web.k6.js
node tests/performance/collect-web-metrics.mjs --start <iso> --end <iso> \
  --function-name <WebFunctionName output> --endpoint-name <WebEndpointName output> \
  --out tests/performance/results/<date>.web.cloudwatch.json
```

| 比較項目（ADR-0006 Evidence 表） | Event 側の値                                             | Web 側の値                                                                            |
| -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| warm / cold p99                  | k6 `create_order_latency`、Logs Insights `@initDuration` | k6 同 metric、`platform.initStart` ログ、`responses_with_lambda_web_logstream_header` |
| throttle 率                      | k6 `throttled`、`Throttles`                              | k6 `throttled`、`AWS/Lambda/Web/Usage` の throttle 4 種                               |
| CPU active ratio                 | （Event は `Duration` = 課金時間）                       | `EnvironmentCPUTime / EnvironmentActiveTime`（`collect-web-metrics.mjs`）             |
| request 当たり費用               | `pnpm cost-model`                                        | 料金表 × 計測値（ADR-0006 脚注 51）                                                   |

既定プロファイルは steady 50 RPS × 10 分 + burst 0→200 RPS（`STEADY_RPS` / `BURST_TARGET_RPS` 等で変更）。sandbox の Lambda 同時実行 quota 10 では Event 側が先に throttle されるため、比較は quota 引き上げ後か、`STEADY_RPS=30` の縮小プロファイルで行う。
