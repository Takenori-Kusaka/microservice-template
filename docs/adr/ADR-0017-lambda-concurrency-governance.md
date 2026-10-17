# ADR-0017: Lambda concurrency governance

- Status: accepted
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0003, ADR-0004, ADR-0009, ADR-0011, ADR-0016

## Context

Lambda Event Functions の同時実行に関する AWS の仕様（参照日 2026-10-17）は次のとおり。

- リージョン当たりの同時実行上限は既定 1,000 で、Service Quotas から数万規模まで引き上げ可能。新規アカウントは縮小 quota で開始し、利用実績に応じて自動的に引き上げられる。[^42]
- reserved concurrency は関数の下限かつ上限であり、他関数は使えない。設定できるのは「Unreserved account concurrency − 100」まで。残り 100 は reserved を持たない関数のために確保される。追加費用なし。[^40]
- provisioned concurrency も同じアカウント上限を消費し、同一関数では reserved concurrency を超えられない。[^74]
- `ClaimedAccountConcurrency` = `UnreservedConcurrentExecutions` + 割り当て済み（reserved + provisioned）で、on-demand invocation に使えない量を示す。`Throttles` は concurrency 不足で拒否された invocation 数。[^75][^41]
- SQS event source mapping の `maxConcurrency`（2〜1,000）は event source 単位の上限で、関数の reserved concurrency 以下に設定しなければ throttle が起こる。1 mapping の既定上限は 1,250 並列。[^58]
- 関数ごとのスケール上限は 10 秒当たり 1,000 実行環境。[^42]
- API Gateway のアカウント throttle（既定 10,000 RPS）と Lambda の 1,000 同時実行のミスマッチにより、API Gateway が Lambda の処理能力を超える request を受け入れうる。AWS は load test で quota を特定し、Lambda quota を引き上げることを推奨している。[^42]

マルチテナント PaaS では、1 つの worker の burst や 1 テナントの異常トラフィックが、同じアカウントの critical API を throttle させる。Amazon のマルチテナント非同期システムは、ワークロード別の同時実行制限と上流へのバックプレッシャーで対処している。[^6] AWS の multi-account whitepaper は、Service Quotas と API rate limit がアカウント単位で配分されるため、アカウント分離が quota の影響を分散するとしている。[^93]

`apps/example-worker-service` は tier 別 SQS queue と `maxConcurrency` で tenant tier ごとに同時実行を分け、`apps/example-order-service` の API 関数は reserved concurrency で worker burst から保護される。

## Decision

準拠: AWS Lambda Developer Guide（quotas、reserved / provisioned concurrency、SQS scaling、metrics）[^42][^40][^74][^58][^75]、Amazon Builders' Library「Avoiding insurmountable queue backlogs」[^6]、AWS whitepaper「Organizing Your AWS Environment Using Multiple Accounts」[^93]、ProGlove の運用事例[^3]

### 同時実行予算（reserved budgets）

各 production アカウント（リージョン）の同時実行上限を次の予算区分で管理し、`apps/platform-cdk` の `EnvironmentStage` に `concurrencyBudget` として記録する。既定値（例示値）: 下表の配分。「critical API が worker burst から保護される」受入基準を満たす比率として置いた設計判断で、外部出典に基づかない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-20）。計測で確定: 負荷試験（M-17）と月次の `ClaimedAccountConcurrency` レビュー（M-18）で見直す。2026-10-17 時点の sandbox（新規アカウント）は同時実行 quota 10 のため、この配分は増枠申請後にのみ適用できる。

| 区分                        | 初期配分（上限 1,000 の例）            | 対象                                                               | 設定方法                                                                                        |
| --------------------------- | -------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| critical API                | 300                                    | 顧客向け同期 API（`PavedApiService` の `criticality: 'critical'`） | 関数ごとに reserved concurrency[^40]                                                            |
| standard API                | 200                                    | その他同期 API                                                     | reserved なし（unreserved pool）                                                                |
| worker premium tier         | 150                                    | premium tenant の SQS consumer                                     | SQS event source `maxConcurrency` + 関数 reserved concurrency（`maxConcurrency` 合計以上）[^58] |
| worker standard tier        | 100                                    | standard tenant の SQS consumer                                    | 同上                                                                                            |
| workflow / relay / schedule | 100                                    | outbox relay、Step Functions Task、cron                            | 関数ごとに reserved concurrency（上限として）                                                   |
| unreserved 予備             | 150（うち 100 は AWS が強制確保[^40]） | 新規関数、burst 吸収                                               |                                                                                                 |

- 区分合計がアカウント上限の 90% を超える構成は synth で失敗させる（既定値（例示値）: 90%。unreserved 100 の強制確保[^40]を含め、増枠前の新規関数と burst 吸収に 10% を残す設計判断で、外部出典に基づかない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-21、未予約分の実績 M-18 で見直す）。）
- 各 Service Stack は `ServiceManifest.concurrency`（未実装・予定。現状は `reservedConcurrentExecutions` と `maxConcurrency` を Construct props で宣言） に区分と要求量を宣言し、`EnvironmentStage` が合計を検証する。

### 運用手順（順序固定）

1. **計測**: `ConcurrentExecutions`、`UnreservedConcurrentExecutions`、`ClaimedAccountConcurrency`、`Throttles` をアカウント dashboard に表示し[^75][^41]、`ClaimedAccountConcurrency` が上限の 70% で warning、85% で critical alarm（既定値（例示値）: 70% / 85%。quota 増枠申請の処理に数日かかるため、上限到達前に申請できる余裕として置いた設計判断で、外部出典に基づかない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-22、alarm の発火実績 M-18 で見直す）。）
2. **削減**: duration 短縮（Power Tuning[^103]）、batch 化、direct integration、不要な fan-out 削減、I/O 並列化。
3. **保護**: critical API へ reserved concurrency、非重要処理へ上限、tenant 別 rate limit。[^40]
4. **平準化**: SQS で burst を吸収し、consumer の `maxConcurrency` を下流容量（DynamoDB WCU、外部 API の rate limit）に合わせる。[^58][^6]
5. **申請**: 需要予測（RPS × p95 duration × 1.5）[^40]と負荷試験結果を添えて、リージョン quota を事前増枠する。[^42] production アカウント作成直後に申請し、staging は production と同じ値を申請する。
6. **隔離**: prod / non-prod、control / data plane、cell、tenant tier をアカウント分割する（ADR-0003）。[^93] アカウント追加は quota 迂回のためではなく、cell / tenant isolation 境界と account factory を伴わせる。[^3]
7. **地域分散**: 事業要件とデータ整合性が許す場合のみ multi-region へ展開する。
8. **ランタイム変更**: 常時高負荷や非常に高い同時実行で Lambda 単価・quota が不利なら ECS/Fargate を比較する（ADR-0009）。

## Alternatives

### A. 予算を設けず、quota 引き上げだけで対応

- 長所: 設定が不要で、throttle が起きにくい。
- 短所: 1 つの worker burst が critical API を含む全関数を throttle させる。下流 DynamoDB / 外部 API を守る上限がない。AWS も reserved concurrency を「下流リソースを圧迫しないための上限」として位置づけている。[^40] quota 引き上げには時間がかかり、障害時には間に合わない。

### B. 全関数に reserved concurrency を設定

- 長所: 各関数の上限が明確。
- 短所: reserved は合計でアカウント上限を消費し、未使用分を他関数が使えないため[^40]、全体の利用効率が下がる。新規関数のたびに予算再配分が必要になる。critical と上限保護の対象だけに限定する。

### C. 関数ごとにアカウントを分ける

- 長所: quota が完全に分離される。[^93]
- 短所: アカウントが関数数に比例して増え、観測・デプロイ・IAM の管理が破綻する。アカウント分割は cell / tenant isolation 境界に限定する（ADR-0003）。

## Consequences

- **費用**: reserved concurrency 自体は無料。[^40] SQS によるバッファは request 課金が加わる。quota 増枠は無料。
- **性能**: critical API は worker burst の影響を受けない。worker は tier 別上限で premium tenant の遅延を standard から保護する。
- **運用**: 予算配分の変更は `EnvironmentStage` の PR で行い、月次の capacity / quota レビューで実測と比較する。新サービス追加時は unreserved 予備から配分する。
- **Lock-in**: Lambda 固有の概念だが、予算という考え方は Fargate の task 数にも適用できる。
- **移行**: cell 分割時は予算表を cell アカウントごとに複製し、cell router による tenant 配置で負荷を分散する。

## Evidence

- Lambda の同時実行モデルと reserved / provisioned の関係、新規アカウントの縮小 quota。[^42][^40][^74]
- `ClaimedAccountConcurrency` による quota 監視。[^41][^75]
- SQS `maxConcurrency` と reserved concurrency の関係。[^58]
- Builders' Library: ワークロード別同時実行制限とバックプレッシャー。[^6]
- ProGlove: アカウント境界による concurrency / throttle の分離と、それを支える account factory。[^3]
- 受入基準「reserved concurrency により critical API が worker burst から保護される」を `tests/performance/burst-isolation/` で検証する。worker queue に 10,000 msg を投入し、worker 関数が `maxConcurrency` 上限まで消費している間に、`POST /orders` の `Throttles`[^75]が 0 件、p99 が SLO 内であることを確認する。
- 月次レビューで `ClaimedAccountConcurrency` の p99 と予算表の差分を記録し、70% 超が 2 か月続いたら quota 申請を起票する。

### 実測（2026-10-17/18 sandbox）

ap-northeast-1 の `paas-sandbox-cell-01`。新規アカウントのため Lambda 同時実行 quota は **10**（`aws lambda get-account-settings`、2026-10-17）で、TD-20 の予算配分と reserved concurrency は適用できない（reserved を設定すると unreserved が 0 になる）。計測は「quota に達したときの挙動」の確認であり、production の容量値ではない。結果ファイルは `tests/performance/results/order-api-2026-10-18.cloudwatch.json`、読み方は同ディレクトリの README。

| 項目                               | 値                                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 負荷                               | k6 steady 30 RPS × 3 分 → overload 30→150 RPS（2 分 ramp + 1 分 hold）、25,200 req                                                                          |
| account `ConcurrentExecutions` max | **10**（= quota。overload 中に張り付き）                                                                                                                    |
| `Throttles` 合計                   | **3,728**（CreateOrder 3,220、残りは OutboxRelay / Fulfill\* consumer / SandboxAuthorizer）                                                                 |
| CreateOrder                        | 18,019 invocations、errors 0、throttles 3,220、Duration p50 44 ms / p99 189 ms                                                                              |
| 非同期経路                         | OutboxRelay 3,018 / FulfillStandard 1,045 / FulfillPremium 730 / FulfillmentOutcomes 1,551 invocations、errors 0                                            |
| alarm                              | `ThrottlesAlarm` × 4 発火（CreateOrder / OutboxRelay / FulfillPremiumConsumer / SandboxAuthorizer）。`ClaimedAccountConcurrency` の 70 / 85% alarm は未評価 |
| 収束                               | run 後に 18,014 件すべて `FULFILLED`、OUTBOX 残 0、DLQ 8 本 0 件。throttle された SQS batch は再配信で処理され、poison 化しなかった                         |
| end-to-end                         | API の成功リクエスト p99 91.5 ms は overload 中も不変（goodput 維持。ADR-0016 実測）                                                                        |

読み方:

- quota 10 では API（CreateOrder + authorizer）と worker（OutboxRelay / Fulfill\*）が同じ 10 を奪い合い、CreateOrder が最多の throttle（3,220）を受けた。これは Decision の「critical API を reserved で保護する」理由そのもので、保護なしでは worker の burst が入口 API を throttle する実例である。
- SQS consumer の throttle は `maxReceiveCount` 内の再配信で吸収され、DLQ に落ちなかった（`maxConcurrency` が quota より大きい状態でも backpressure が機能）。
- 運用手順の順序「計測 → 削減 → 保護 → 平準化 → 申請」のうち、sandbox では「計測」まで完了。次は Service Quotas で quota 増枠を申請し（1,000 以上）、TD-20 の配分を適用してから `tests/performance/burst-isolation/`（M-14）を実施する。

## Compliance / How it is enforced

- `ServiceManifest.concurrency`（未実装・予定。現状は `reservedConcurrentExecutions` と `maxConcurrency` を Construct props で宣言） を必須化し、区分（`critical-api` / `standard-api` / `worker-premium` / `worker-standard` / `workflow`）と要求量を宣言させる。
- `EnvironmentStage` が全 Service Stack の宣言を集計し、区分合計がアカウント上限の 90% を超えたら synth で失敗させる。
- `PavedApiService` の `criticality: 'critical'` は reserved concurrency の指定を必須化し、`PlatformGuardrails` が未指定を拒否する。
- `PavedQueueConsumer` が SQS event source の `maxConcurrency` を必須プロパティとし、関数の reserved concurrency が全 event source の `maxConcurrency` 合計以上であること[^58]と、`ServiceManifest.concurrency`（未実装・予定。現状は `reservedConcurrentExecutions` と `maxConcurrency` を Construct props で宣言） の宣言値を超えないことを検査する。
- `ServiceObservability` のアカウント dashboard に `ClaimedAccountConcurrency`、`UnreservedConcurrentExecutions`、関数別 `Throttles` を表示し[^75]、70% / 85% alarm を自動生成する。
- CI の `policy` ステップで、Service Quotas の現在値（`aws service-quotas get-service-quota`）と予算表の整合を検査し、予算表が quota を超えていれば失敗させる。

## 参考

[^3]: [Lessons learned from scaling to 1 million Lambda functions](https://aws.amazon.com/blogs/architecture/lessons-learned-from-scaling-to-1-million-lambda-functions/)（指針書 References より）

[^6]: [Avoiding insurmountable queue backlogs](https://aws.amazon.com/builders-library/avoiding-insurmountable-queue-backlogs/)（指針書 References より）

[^40]: [Configuring reserved concurrency for an Event Function](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)（参照日 2026-10-17）

[^41]: [AWS Lambda supports additional concurrency metric for improved quota monitoring](https://aws.amazon.com/about-aws/whats-new/2023/12/aws-lambda-concurrency-metric-quota-monitoring/)（指針書 References より）

[^42]: [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)（参照日 2026-10-17）

[^58]: [Configuring scaling behavior for SQS event source mappings](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html)（参照日 2026-10-17）

[^74]: [Configuring provisioned concurrency for an Event Function](https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html)（参照日 2026-10-17）

[^75]: [Types of metrics for Lambda Event Functions](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html)（参照日 2026-10-17）

[^93]: [Benefits of using multiple AWS accounts](https://docs.aws.amazon.com/whitepapers/latest/organizing-your-aws-environment/benefits-of-using-multiple-aws-accounts.html)（参照日 2026-10-17）

[^103]: [AWS Lambda Power Tuning (GitHub)](https://github.com/alexcasalboni/aws-lambda-power-tuning)（参照日 2026-10-17）
