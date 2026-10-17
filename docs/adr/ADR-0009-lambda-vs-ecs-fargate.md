# ADR-0009: Lambda vs ECS/Fargate

- Status: proposed
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0006, ADR-0007, ADR-0008, ADR-0010, ADR-0017, ADR-0018

## Context

本 PaaS は serverless-first だが serverless-only ではない。Lambda への適合性ではなく、実行時間、CPU、メモリ、状態、隔離、レイテンシ、単価で判断する。evertz.io は Lambda / Step Functions / DynamoDB / EventBridge 中心の serverless-first を採用しつつ、長時間実行や特定ハードウェア要件では別の計算基盤を選んでいる。[^8] AWS Well-Architected は、差別化にならない運用をマネージドサービスへ寄せることを推奨している。[^11]

Lambda Event Functions の制約（参照日 2026-10-17）は次のとおり。[^42][^21]

- 1 invocation 最大 15 分（900 秒）。Lambda Managed Instances を使う場合は非同期 / event source mapping 経由の invocation に限り最大 90 分。
- メモリ 128〜10,240 MB、1,769 MB で 1 vCPU 相当。CPU はメモリに比例して割り当てられる。
- 実行環境当たりのネットワーク帯域 625 Mbps（VPC 外では引き上げ申請可、最大 3,000 Mbps）。
- 既定の同時実行 quota 1,000 / リージョン（数万まで引き上げ可）。
- 課金は request $0.20 / 百万 + GB 秒（x86 $0.0000166667、arm64 は 20% 低い）。[^51][^71]

AWS Fargate は、各 task が独自の隔離境界を持ち、カーネル・CPU・メモリ・ENI を他 task と共有しない。[^73] ゼロスケールはできず、task の起動時間は公式に数値が公開されておらず、image の pull 時間は image サイズに比例する[^v1]（計測で確定: 起動秒数は `tests/performance/lambda-vs-fargate/` で Lambda cold start と並べて計測する。docs/decision/template-defaults.md#計測で確定する項目 M-13、現在は未計測）。

AWS の Lambda 比較表は Event Functions の duration を「既定 15 分 / Lambda Managed Instances で 90 分 / Durable Functions で最長 1 年のマルチステップ」と記載しており[^21]、Lambda 側にも長時間ワークロード向けの選択肢が増えている。本 ADR は Fargate 判定の前に、これらの Lambda 内選択肢を比較対象に含める。

## Decision

準拠: AWS Well-Architected Framework（managed-first）[^11]、AWS Lambda Developer Guide（quotas、3 primitive 比較）[^42][^21]、Amazon ECS Developer Guide「Architect for AWS Fargate」[^73]、evertz.io の serverless-first 事例[^8]、AWS Serverless Applications Lens（cost and performance optimization）[^36]

ガイドライン ch.8 の決定木を正式な判断順序とし、**zip Lambda を既定、ECS/Fargate を例外プロファイル `runtimeProfile: 'fargate-service' | 'fargate-task'` として扱う。**

1. AWS サービス統合だけで完結するか: 完結するなら Step Functions / EventBridge Pipes / API Gateway direct integration（Lambda を書かない）。[^27]
2. 15 分以内、stateless、イベント単位か: zip Lambda（ADR-0008）。[^42]
3. 大規模 native dependency または既存 OCI build が必要か: Lambda container image を比較（ADR-0008）。[^31]
4. 継続高 CPU、長時間、daemon、特殊 network、予測可能な高稼働率か: **ECS/Fargate**。[^73] ただし 15〜90 分の非同期処理は Lambda Managed Instances を先に比較する（本テンプレートでは未評価。Phase 2 で本 ADR の試験対象に加える）。[^21]
5. VM 級隔離、状態保持、対話セッション、テナント任意コードか: Lambda MicroVMs（ADR-0007）。[^21]
6. バッチで大量並列か: Step Functions Distributed Map（既定 10,000 並列、Standard のみ）[^88]、AWS Batch、ECS/Fargate を処理時間と単価で比較。

ECS/Fargate を選ぶ具体的な条件（1 つ以上該当し、個別 ADR を起票）。既定値（例示値）: 下表の閾値。実行時間・帯域・メモリ比は Lambda quota に基づくが、稼働率 40% は Lambda GB 秒単価と Fargate 単価の一次スクリーニング値であり、外部文献に基づく数値ではない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-07、`pnpm cost-model` の break-even 試算 M-07 で見直す）。

| 条件         | 閾値                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 実行時間     | 1 実行が 15 分（非同期なら Managed Instances の 90 分）を超え[^42][^21]、Step Functions での分割が業務上不自然             |
| 稼働率       | 月間平均稼働率が 40% 以上で、Lambda の GB 秒費用[^51]が同等 vCPU / メモリの Fargate 月額を超える                           |
| CPU 特性     | 継続的に CPU bound で、Lambda の memory-CPU 比例モデル（1,769 MB = 1 vCPU）[^42]では過剰メモリを割り当てることになる       |
| ネットワーク | 常時接続（WebSocket server、gRPC streaming、長時間 outbound 接続）、固定 IP egress、または 625 Mbps[^42]を超える帯域が必要 |
| 同時実行     | 必要同時実行がリージョン quota 引き上げ後も不足し、ADR-0017 の手順を尽くした                                               |

Fargate を採用するサービスも、`ServiceManifest`、`@paas/runtime-context`、`@paas/observability`（Powertools は「AWS Lambda only」を tenet とし非 Lambda 環境は非公式サポートのため[^v2]、OTel preset を使う）、ADR-0001 のサービス境界を同じく適用する。

## Alternatives

### A. 全処理を Lambda に載せる（serverless-only）

- 長所: 単一ランタイムで paved road が最も単純。
- 短所: 15 分超の処理を Step Functions で無理に分割し、常時高負荷では費用が Fargate を上回る可能性がある（計測で確定: 稼働率別の費用は `pnpm cost-model` に Fargate 単価を追加した break-even 試算で確定する。M-07、現在は未計測）。evertz.io の知見とも反する。[^8]

### B. 全処理を ECS/Fargate に載せる

- 長所: 実行時間・CPU・ネットワークの制約がなく、task 単位の隔離が明確。[^73]
- 短所: ゼロスケールできず、中規模 PaaS のイベント駆動処理ではアイドル費用が支配的になる。API Gateway の JWT authorizer、Lambda alias、Powertools Idempotency といった paved road を使えない。

### C. EKS（Kubernetes）

- 長所: エコシステムが広く、マルチクラウド移植性が高い。
- 短所: control plane の運用と cluster upgrade の負担が managed-first 原則[^11]に反する。中規模 PaaS では Fargate の方が運用コストが低い。

## Consequences

- **費用**: Lambda 既定により低稼働率ワークロードの費用はゼロスケールで最小。Fargate 採用サービスは固定費を tenant / tier に配賦するため ADR-0018 の driver（CPU 時間 × tenant 比率）が必要。
- **性能**: Fargate はコールドスタートがなく p99 が安定するが、スケールアウトに時間がかかるため burst 吸収には SQS が必要（スケールアウト秒数は公式ドキュメントに記載なし（確認日 2026-10-17）。計測で確定: `tests/performance/lambda-vs-fargate/` で計測する。M-13、現在は未計測）。
- **運用**: Fargate サービスは task 定義、ALB、auto scaling、イメージ scan、platform version の retirement[^73]を所有チームが運用する。platform-team は `PavedFargateService` を将来 Construct として提供するか、個別 ADR で判断する。
- **Lock-in**: Fargate 上のコンテナは最も移植性が高い。Lambda は AWS 固有だが application 層は分離されている。
- **移行**: Lambda → Fargate は application 層を HTTP サーバまたは queue consumer loop で包み直す。ADR-0006 の Web Functions 版が中間段階として使える。

## Evidence

break-even 試算と負荷試験 protocol（`tests/performance/lambda-vs-fargate/`、`tools/cost-model/`）。合格閾値は本テンプレートの初期値。計測で確定: 初回 benchmark の結果（break-even 稼働率、起動 / scale-out 秒数、p99）を本 ADR に記録し、閾値を見直す（docs/decision/template-defaults.md#計測で確定する項目 M-07 / M-13、現在は未計測・試験ディレクトリ未作成）。

1. 対象ワークロードの過去 30 日の `Invocations`、`Duration` の p50/p95、memory 設定、稼働率を CloudWatch から抽出する。[^75]
2. Lambda 費用 = request 数 × $0.20 / 百万 + GB 秒 × 単価（arm64）[^51]、Fargate 費用 = 必要 vCPU・メモリ × 稼働時間 + ALB を `tools/cost-model/` で試算する（Fargate 単価は AWS 料金表で確認済み。ap-northeast-1、Linux/x86: $0.05056 / vCPU 時・$0.00553 / GB 時、Linux/ARM: $0.04045 / vCPU 時・$0.00442 / GB 時、1 分の最小課金。確認日 2026-10-17[^v3]）。
3. 稼働率 20% / 40% / 60% / 80% の 4 シナリオで月額を比較し、break-even 稼働率を記録する。
4. `apps/example-worker-service` の consumer を Fargate task 版でも実装し、同一 SQS 負荷（1,000 msg/s 10 分）で `ApproximateAgeOfOldestMessage`[^77] p99、throttle、費用を比較する。
5. 合格条件（Fargate 採用）: 稼働率が break-even を上回る、または実行時間・ネットワーク条件で Lambda が不可能であること。Fargate 版の `ApproximateAgeOfOldestMessage` p99 が Lambda 版の 1.5 倍以内。

結果を本 ADR に追記し `accepted` とする。月次の cost / capacity レビューで稼働率 40% 超の Lambda 関数を抽出し、再評価対象にする。

## Compliance / How it is enforced

- `ObservableFunction` / `PavedApiService` / `PavedQueueConsumer` / `PavedWorkflow` は Lambda 前提であり、Fargate は `ServiceManifest.runtimeProfile: 'fargate-*'` と ADR 参照なしには `PlatformGuardrails` が synth で拒否する。
- Lambda timeout が 10 分を超える関数は `ObservableFunction` が警告し、15 分（上限[^42]）設定は ADR 参照を要求する。
- `ServiceObservability` の dashboard に稼働率（`Duration` 合計 / 月間秒数 × 同時実行）を表示し、40% 超で月次レビューへ自動 issue を起票する。
- Fargate サービスも `@paas/runtime-context` の `ExecutionContext` と `correlationId` を必須とし、`@paas/testing` の contract test でログ付与を検証する。

## 参考

[^8]: [Stream with Evertz SaaS playout platform evertz.io](https://aws.amazon.com/blogs/media/stream-with-evertz-saas-playout-platform-evertz-io/)（指針書 References より）

[^11]: [Operational Excellence Pillar - AWS Well-Architected Framework](https://docs.aws.amazon.com/pdfs/wellarchitected/latest/operational-excellence-pillar/wellarchitected-operational-excellence-pillar.pdf)（指針書 References より）

[^21]: [What is AWS Lambda?](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html)（参照日 2026-10-17）

[^27]: [From AWS Lambda orchestration to AWS Step Functions](https://aws.amazon.com/blogs/compute/streamlining-aws-serverless-workflows-from-aws-lambda-orchestration-to-aws-step-functions/)（指針書 References より）

[^31]: [Create a Lambda Event Function using a container image](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)（参照日 2026-10-17）

[^36]: [Lambda cost and performance optimization (Serverless Applications Lens)](https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/cost-and-performance-optimization.md)（指針書 References より）

[^42]: [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)（参照日 2026-10-17）

[^51]: [AWS Lambda Pricing](https://aws.amazon.com/lambda/pricing/)（参照日 2026-10-17）

[^71]: [AWS Lambda Functions Powered by AWS Graviton2 Processor](https://aws.amazon.com/blogs/aws/aws-lambda-functions-powered-by-aws-graviton2-processor-run-your-functions-on-arm-and-get-up-to-34-better-price-performance/)（参照日 2026-10-17）

[^73]: [Architect for AWS Fargate for Amazon ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)（参照日 2026-10-17）

[^75]: [Types of metrics for Lambda Event Functions](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html)（参照日 2026-10-17）

[^77]: [Available CloudWatch metrics for Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html)（参照日 2026-10-17）

[^88]: [Using Map state in Distributed mode (Step Functions)](https://docs.aws.amazon.com/step-functions/latest/dg/state-map-distributed.html)（参照日 2026-10-17）

[^v1]: [Under the hood: Lazy Loading Container Images with Seekable OCI and AWS Fargate - AWS Containers Blog](https://aws.amazon.com/blogs/containers/under-the-hood-lazy-loading-container-images-with-seekable-oci-and-aws-fargate/)（参照日 2026-10-17。「With overlayfs there is a correlation between the time taken to pull an image and the size of the container image.」起動秒数の公表なし）

[^v2]: [Powertools for AWS Lambda (TypeScript)](https://docs.aws.amazon.com/powertools/typescript/latest/)（参照日 2026-10-17。Tenets「AWS Lambda only. We optimise for AWS Lambda function environments and supported runtimes only. Utilities might work with web frameworks and non-Lambda environments, though they are not officially supported.」）

[^v3]: [AWS Fargate Pricing](https://aws.amazon.com/fargate/pricing/)（参照日 2026-10-17。「Pricing is calculated per second with a 1-minute minimum.」ap-northeast-1 の単価は AWS Price List Bulk API `AmazonECS` の ap-northeast-1 ファイル https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/ap-northeast-1/index.json で確認）
