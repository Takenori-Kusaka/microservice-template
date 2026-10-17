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
