# ADR-0023: Local virtual environment (compose L1 / LocalStack L2)

- Status: accepted
- Date: 2026-10-21
- Owner: platform-team
- Review date: 2027-04-21
- Related: ADR-0002, ADR-0006, ADR-0009, ADR-0019, ADR-0020, ADR-0021, ADR-0022, [最新技術での再検討 §D](../decision/latest-tech-reassessment.md), [technology-selection-rationale.md](../decision/technology-selection-rationale.md)

## Context

owner から「オンプレ高スペック機での仮想システム構築（k8s / docker-compose）が必要」という要望が出た。本質は「クラウド往復なしで全経路を再現し高速にフィードバックを得たい」である。指針 §16 は「LocalStack 等は高速フィードバック用、最終保証は ephemeral AWS 環境」としており、この線引きを 2026-10 時点のツールで検証した。

AWS 公式の線引き（参照日 2026-10-17）:

- Lambda Testing Guide: 「cloud-based tests が品質の最も正確な尺度」「ローカルで cloud 環境を完全に再現することはできない」「エミュレータは控えめに使う。使う場合も設定検証のため cloud でテストが必要」「エミュレータの機能と API はサービス更新に遅れる」。[^193]
- Prescriptive Guidance: 「できる限り cloud でのテストに集中する」「理想は開発者ごとに専用 AWS アカウント」「ネットワークが遅い・不安定なチームや規制産業ではエミュレーションが gap を埋める」。[^194]
- serverless-test-samples: 「エミュレーションは実 cloud リソースに対するテストの代替ではない」「DynamoDB のような一部サービスのエミュレーションは高速フィードバックに有効」。[^195]
- Web Functions testing: 「ほとんどのアプリ挙動はフレームワークの通常ツールでローカルテストできる」。ローカル実行は `AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3000 node index.js`。IAM、S3 / KMS アクセス、lifecycle、scaling、telemetry、multi-Region は cloud テストが必要。[^135]

エミュレータの対応状況（参照日 2026-10-17、LocalStack 2026.10.0）:

| 対象                      | LocalStack の対応                                                                                                                                                                                                                                                                         | 公式ツール                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lambda Event Functions    | Docker socket マウント必須。Function URL の response streaming 非対応。hot reload は `hot-reload` bucket + 絶対パス[^168]                                                                                                                                                                 | SAM local は Event Functions のみで「AWS との 100% の忠実度を保証しない」[^182]。RIE は Linux x86_64 / arm64[^199]。base image は 22 / 24 / 26[^198] |
| Lambda Web Functions      | 対応（Hobby 以上）。`nodejs24.x` のみ、`node:24-slim`、2 CPU / 2 GiB、hot reload 約 1 秒（Kubernetes 実行時は不可）、IamAuth、revision 重み付け。endpoint は `localhost.localstack.cloud`、request body 非ストリーミング、quota は報告のみで未強制、CORS は endpoint に非適用[^166][^167] | SAM CLI 1.169.0 に Web Functions の記載なし[^108]                                                                                                    |
| API Gateway HTTP API      | 72 / 103 operations、Base 以上。authorizer 結果キャッシュなし、resource policy 未評価、usage plan throttling 未強制、response streaming 非対応[^169]                                                                                                                                      | —                                                                                                                                                    |
| DynamoDB + Streams        | DynamoDB Local 内蔵。Streams は Hobby 以上だが persistence 非対応[^170]                                                                                                                                                                                                                   | DynamoDB Local 3.3.2: PITR なし、`TransactionConflictException` を投げない、Streams の shard 生成レートが異なる[^183][^184]                          |
| EventBridge               | Hobby 以上。archive / replay 実装済み。Pipes は Ultimate。Scheduler は配信 1 回のみ[^171][^172]                                                                                                                                                                                           | Schema Registry は公式ドキュメントに記載なし（確認日 2026-10-18、https://docs.localstack.cloud/aws/services/ ）[^196]                                |
| SQS                       | 23 / 23 operations、DLQ / redrive 対応[^173]                                                                                                                                                                                                                                              | —                                                                                                                                                    |
| Step Functions            | 35 / 37 operations、persistence 非対応、`SFN_MOCK_CONFIG` で Task をモック[^174]                                                                                                                                                                                                          | Step Functions Local は「unsupported、feature parity なし」。代替は TestState API[^185][^186]                                                        |
| CloudWatch Logs / Metrics | Logs 58 / 118、Metrics 20 / 55。composite alarm 未評価。EMF は公式ドキュメントに記載なし（確認日 2026-10-18、https://docs.localstack.cloud/aws/services/cloudwatch/ ）[^175]                                                                                                              | —                                                                                                                                                    |
| X-Ray                     | Ultimate のみ、「同じ trace_id の segment を相関しない」[^176]                                                                                                                                                                                                                            | —                                                                                                                                                    |
| IAM                       | `ENFORCE_IAM=1` で有効化（既定 off）、Base 以上[^177]                                                                                                                                                                                                                                     | —                                                                                                                                                    |
| 料金 / 配布               | Hobby 無料（非商用、persistence なし）、Base $39 / license / 月（年契約）、Ultimate $89。2026-03-23 以降はイメージ起動に auth token 必須。月次 calendar versioning[^178]                                                                                                                  | cdklocal は deprecated、`lstk cdk` へ[^181]                                                                                                          |
| Kubernetes                | Helm chart あり。Lambda / ECS を Pod として動的生成する公式サポートは Enterprise のみ[^179]                                                                                                                                                                                               | —                                                                                                                                                    |

本テンプレートの実測（2026-10-17/18、E-102 / M-24）: sandbox で `tests/integration` 3 件と `tests/tenant-isolation` 3 件が 2 回 pass、full deploy は約 7 分。LocalStack 側は未実行で、挙動差は未記録。

## Decision

準拠: AWS Lambda Developer Guide「Testing serverless functions and applications」[^193]、「Testing Lambda Web Functions」[^135]、AWS Prescriptive Guidance「Serverless application testing」[^194]、aws-samples/serverless-test-samples[^195]、LocalStack Docs[^167][^169][^170][^171][^173][^174][^175][^176][^177]、DynamoDB local usage notes[^184]

- **L1（アプリ層 compose）を全サービスの標準ローカル環境とする。** 無料、エミュレータなし。`docker compose -f tools/local/compose.app.yaml up` で次を起動する。

  | サービス    | イメージ                                                                                               | 役割                                                                                          |
  | ----------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
  | `order-web` | `node:24-slim`、`AWS_LAMBDA_HTTP_ENDPOINT=0.0.0.0:3000`                                                | Web Functions と同じ起動経路で `server.ts` を実行[^135]。Event handler は vitest から直接呼ぶ |
  | `dynamodb`  | `amazon/dynamodb-local`（3.3.2）、`-sharedDb`[^183]                                                    | adapter の高速確認。`TransactionConflictException` を投げない等の差異を前提にする[^184]       |
  | `otel-lgtm` | `grafana/otel-lgtm`（Collector + Prometheus + Tempo + Loki + Grafana、「開発・デモ・テスト用」）[^190] | OTLP 4317 / 4318 受け。ADR-0022 の OTel 経路をローカルで通す                                  |
  | `k6`        | `grafana/k6` 2.3.0、`--out opentelemetry`[^192]                                                        | Web Functions の同時 64 リクエスト smoke                                                      |

- **L2（システム層 compose、LocalStack Base 以上）を高スペック機のオプションとして採用する（個人ライセンス）。** `compose.system.yaml` を L1 に重ね、`localstack/localstack:2026.10` を `/var/run/docker.sock` マウント、`LOCALSTACK_AUTH_TOKEN`、`PERSISTENCE=1`、`ENFORCE_IAM=1`、`LAMBDA_WEB_IGNORE_ARCHITECTURE=0`（arm64 を AWS と同様に要求）で起動し、`lstk cdk deploy` で HTTP API + Event / Web Functions + DynamoDB + Streams + EventBridge + SQS + Step Functions を 1 コマンドで構築する。[^167][^177][^180][^181] 対象は EventBridge / SQS / Step Functions をまたぐ経路の高速フィードバックと CDK テンプレートの早期検証。Ultimate は X-Ray / Pipes が必要なチームのみ。[^172][^176]
- **ephemeral AWS 環境を最終保証にする原則は変更なし。** IAM 境界（`dynamodb:LeadingKeys`）、tenant-isolation、throttle、同時実行 quota、Streams 順序、cold start、費用、`correlationId` 全経路検索（field index、cross-account）は AWS でのみ検証する。[^193][^194]
- **k8s（kind / Knative）は不採用。** kind v0.33.0[^188]、k3d 5.9.0[^189]、Knative Serving 1.23（scale-to-zero 既定 on）[^187]で同じ Node HTTP サーバを動かすことは技術的に可能だが、(1) 本テンプレートの実行モデルは Lambda であり k8s は第 3 の実行モデルを増やす、(2) LocalStack の Lambda-on-Kubernetes は Enterprise 限定[^179]、(3) Web Functions のローカル検証は compose で足りる[^167][^135]。ADR-0009 で Fargate プロファイルを採用した場合のみ再検討する。
- 検証対象の線引き:

  | 検証項目                                                   | L1            | L2                            | 実 AWS（ephemeral）      |
  | ---------------------------------------------------------- | ------------- | ----------------------------- | ------------------------ |
  | domain / application の unit、contract                     | ◎ 唯一        | —                             | —                        |
  | DynamoDB adapter の key 設計、条件式                       | ◎             | ○                             | ○ 最終[^184]             |
  | Web Functions の同時リクエスト / global state / event loop | ◎             | ○                             | ○ scaling は cloud[^135] |
  | HTTP API ルーティング、authorizer の有無                   | —             | ○ TTL / policy は未評価[^169] | ◎ 最終                   |
  | EventBridge rule → SQS → Lambda → Step Functions の経路    | —             | ◎ 高速フィードバック          | ◎ 最終                   |
  | `correlationId` 全経路検索                                 | ○ Loki で近似 | ○ LocalStack Logs             | ◎ 唯一の正               |
  | IAM 境界、`LeadingKeys`、tenant-isolation                  | —             | △ `ENFORCE_IAM`[^177]         | ◎ 唯一の正[^194]         |
  | throttle、quota、Streams 順序、cold start、費用            | —             | ×（quota 未強制[^167]）       | ◎ 唯一                   |

- 再検討トリガー: LocalStack が EMF / X-Ray 相関 / quota 強制に対応、SAM local が Web Functions に対応、AWS が Web Functions のローカルエミュレータを公開。

## Alternatives

### A. L1 compose のみ（エミュレータなし）

- 長所: 無料、外部ライセンス不要、AWS 公式が推奨する「エミュレータは控えめに」と整合。[^193] DynamoDB Local と Web Functions のローカル起動は AWS 公式手段。[^183][^135]
- 短所: EventBridge / SQS / Step Functions をまたぐ経路はローカルで再現できず、ephemeral AWS（full deploy 約 7 分、M-01）を待つ。

### B. L2 LocalStack（Base / Ultimate）を全員の標準にする

- 長所: HTTP API → Lambda → DynamoDB Streams → EventBridge → SQS → Step Functions が 1 コマンドで一周する。[^181] Web Functions も emulate できる。[^166][^167]
- 短所: 1 人あたり $39 / 月（年契約）、auth token 必須。[^178] quota 未強制、authorizer キャッシュなし、EMF / X-Ray 相関の非対応など AWS との差分が多く[^167][^169][^175][^176]、「LocalStack で通ったが AWS で落ちる」を防げない。高スペック機と Docker socket が必要。

### C. k8s（kind / k3d + Knative）

- 長所: scale-to-zero を含む常駐サーバの挙動を再現できる。[^187]
- 短所: Lambda の実行モデルを再現しない。LocalStack の k8s 連携は Enterprise 限定。[^179] 運用する実行基盤（Lambda）と異なる基盤でテストしても最終保証にならない。

### D. 開発者ごとの専用 AWS アカウント（ローカル環境なし）

- 長所: AWS Prescriptive Guidance の「理想」。[^194] 差分ゼロ。
- 短所: deploy 待ち（約 7 分）が unit レベルの反復に重い。オフライン・低帯域環境で使えない。L1 と併用する。

## Consequences

- **費用**: L1 は無料。L2 は LocalStack Base $39 / license / 月（年契約）を希望者のみ。[^178] ephemeral AWS の費用は従来どおり（sandbox 固定費は alarm 57 本 ≈ $5.7 / 月、E-103）。
- **性能**: L1 の Web server 起動と DynamoDB Local は秒単位。L2 の hot reload は Web Functions で約 1 秒、Event Functions で最大 700 ms。[^167][^168] 計測で確定: LocalStack 実行と sandbox 実行の挙動差を `tests/` の両方実行で記録する（M-24、LocalStack 側は未実行）。
- **運用**: `create-service` が `compose.app.yaml` と k6 smoke を生成する（計画）。L2 の手順書（`lstk cdk deploy`、`ENFORCE_IAM`、arm64 強制）を 2026-12-31 までに整備する。LocalStack は月次リリースのため[^178]、四半期で未対応項目（EMF、X-Ray 相関、quota 強制、Schema Registry）を再確認する。
- **Lock-in**: compose ファイルは標準 Docker。LocalStack 固有は `lstk` CLI と環境変数のみ。
- **移行**: 既存サービスは `tools/local/` の compose を追加するだけで L1 を使える。L2 は任意。

## Evidence

- AWS 公式のテスト方針（cloud 優先、エミュレータ控えめ）。[^193][^194][^195]
- Web Functions のローカル実行手順と cloud 必須項目。[^135]
- LocalStack 2026.10.0 の対応範囲と制限。[^166][^167][^168][^169][^170][^171][^172][^173][^174][^175][^176][^177][^178][^179][^180][^181]
- DynamoDB Local の差異。[^183][^184] Step Functions Local の非サポートと TestState API。[^185][^186]
- k8s 候補の版。[^187][^188][^189]
- 受入基準: `docker compose up` で Web server + DynamoDB Local + otel-lgtm + k6 smoke（同時 64 リクエスト）が通る。L2 では HTTP API → Event / Web → DynamoDB Streams → EventBridge → SQS → Step Functions がローカルで一周する。
- 計測で確定: LocalStack と sandbox の挙動差（M-24）。sandbox 側の値は E-102 / E-178（integration 3 件、tenant-isolation 3 件 pass、API Gateway requestId が `=` を含む）。

## Compliance / How it is enforced

- `tools/create-service` が `tools/local/compose.app.yaml` と k6 smoke script を生成する（計画。期限 2026-11-30、[再検討 §E #10](../decision/latest-tech-reassessment.md)）。
- CI は L1 / L2 を使わず ephemeral AWS で `integration` / `tenant-isolation` / `load smoke` を実行する（`.github/workflows/ci.yml` の `deploy-ephemeral` job）。ローカル環境の結果を production 適用の根拠にしない。
- `PlatformGuardrails` は LocalStack 向けの設定（`localhost.localstack.cloud` endpoint、`AWS_ENDPOINT_URL`）が production Stage の template に残っていた場合 synth を失敗させる。
- 四半期 architecture review で LocalStack の未対応項目一覧（Context の表）を再確認し、M-24 を更新する。

## Expiry / Review date

| 日付       | 評価者        | 結果                               |
| ---------- | ------------- | ---------------------------------- |
| 2026-10-21 | platform-team | 初版。L1 標準、L2 任意、k8s 不採用 |

## 参考

[^108]: [aws/aws-sam-cli Releases（v1.169.0）](https://github.com/aws/aws-sam-cli/releases)（参照日 2026-10-17。Web Functions の記載なし）

[^135]: [Testing Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-testing.html)（参照日 2026-10-17。`AWS_LAMBDA_HTTP_ENDPOINT` でのローカル実行、cloud 必須項目）

[^166]: [AWS Lambda Web Functions Are Here. Test Them Locally with LocalStack. - LocalStack Blog](https://blog.localstack.cloud/aws-lambda-web-functions-are-here/)（参照日 2026-10-17。2026-10-13）、[LocalStack for AWS release 2026.10.0](https://blog.localstack.cloud/localstack-for-aws-release-2026-10-0/)（同）

[^167]: [Lambda Web Functions - LocalStack Docs](https://docs.localstack.cloud/aws/services/lambda-web/)（参照日 2026-10-17）

[^168]: [Lambda - LocalStack Docs](https://docs.localstack.cloud/aws/services/lambda/)、[Hot reloading](https://docs.localstack.cloud/aws/tooling/lambda-tools/hot-reloading/)（参照日 2026-10-17）

[^169]: [API Gateway - LocalStack Docs](https://docs.localstack.cloud/aws/services/apigateway/)（参照日 2026-10-17）

[^170]: [DynamoDB](https://docs.localstack.cloud/aws/services/dynamodb/)、[DynamoDB Streams - LocalStack Docs](https://docs.localstack.cloud/aws/services/dynamodbstreams/)（参照日 2026-10-17）

[^171]: [EventBridge](https://docs.localstack.cloud/aws/services/events/)、[EventBridge Scheduler - LocalStack Docs](https://docs.localstack.cloud/aws/services/scheduler/)（参照日 2026-10-17）

[^172]: [EventBridge Pipes - LocalStack Docs](https://docs.localstack.cloud/aws/services/pipes/)（参照日 2026-10-17。Ultimate）

[^173]: [SQS - LocalStack Docs](https://docs.localstack.cloud/aws/services/sqs/)（参照日 2026-10-17）

[^174]: [Step Functions - LocalStack Docs](https://docs.localstack.cloud/aws/services/stepfunctions/)（参照日 2026-10-17）

[^175]: [CloudWatch](https://docs.localstack.cloud/aws/services/cloudwatch/)、[CloudWatch Logs - LocalStack Docs](https://docs.localstack.cloud/aws/services/logs/)（参照日 2026-10-17。EMF の記載なしは 2026-10-18 確認）

[^176]: [X-Ray - LocalStack Docs](https://docs.localstack.cloud/aws/services/xray/)（参照日 2026-10-17。Ultimate）

[^177]: [IAM Policy Enforcement](https://docs.localstack.cloud/aws/capabilities/security-testing/iam-policy-enforcement/)、[Configuration - LocalStack Docs](https://docs.localstack.cloud/aws/capabilities/config/configuration/)（参照日 2026-10-17）

[^178]: [LocalStack Pricing](https://localstack.cloud/pricing)、[Switching to calendar versioning](https://blog.localstack.cloud/switching-to-calendar-versioning/)（参照日 2026-10-17）

[^179]: [Kubernetes - LocalStack Docs](https://docs.localstack.cloud/aws/integrations/containers/kubernetes/)（参照日 2026-10-17。Lambda / ECS の Pod 生成は Enterprise）

[^180]: [Persistence](https://docs.localstack.cloud/aws/capabilities/state-management/persistence/)、[Installation - LocalStack Docs](https://docs.localstack.cloud/aws/getting-started/installation/)（参照日 2026-10-17）

[^181]: [localstack/aws-cdk-local README](https://github.com/localstack/aws-cdk-local)（参照日 2026-10-17。deprecated、`lstk cdk` へ）

[^182]: [Introduction to testing with sam local start-api](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/using-sam-cli-local-start-api.html)（参照日 2026-10-17）

[^183]: [DynamoDB local release history](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocalHistory.html)、[Downloading and running DynamoDB local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html)（参照日 2026-10-17。3.3.2）

[^184]: [DynamoDB local usage notes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.UsageNotes.html)（参照日 2026-10-17）

[^185]: [Testing state machines with Step Functions Local (unsupported)](https://docs.aws.amazon.com/step-functions/latest/dg/sfn-local.html)（参照日 2026-10-17）

[^186]: [Using TestState API](https://docs.aws.amazon.com/step-functions/latest/dg/test-state-isolation.html)（参照日 2026-10-17）

[^187]: [Configuring scale to zero - Knative](https://knative.dev/docs/serving/autoscaling/scale-to-zero/)、[knative/serving Releases](https://github.com/knative/serving/releases)（参照日 2026-10-17。v1.23.0）

[^188]: [kubernetes-sigs/kind Releases](https://github.com/kubernetes-sigs/kind/releases)（参照日 2026-10-17。v0.33.0）

[^189]: [k3d-io/k3d Releases](https://github.com/k3d-io/k3d/releases)（参照日 2026-10-17。v5.9.0）

[^190]: [grafana/docker-otel-lgtm README](https://github.com/grafana/docker-otel-lgtm)（参照日 2026-10-17。「開発・デモ・テスト用」）

[^192]: [OpenTelemetry output - Grafana k6 Docs](https://grafana.com/docs/k6/latest/results-output/real-time/opentelemetry/)、[grafana/k6 Releases](https://github.com/grafana/k6/releases)（参照日 2026-10-17。v2.3.0）

[^193]: [Testing serverless functions and applications (Lambda)](https://docs.aws.amazon.com/lambda/latest/dg/testing-guide.html)（参照日 2026-10-17）

[^194]: [Serverless application testing: Best practices](https://docs.aws.amazon.com/prescriptive-guidance/latest/serverless-application-testing/best-practices.html)、[Techniques](https://docs.aws.amazon.com/prescriptive-guidance/latest/serverless-application-testing/techniques.html)（参照日 2026-10-17）

[^195]: [aws-samples/serverless-test-samples README](https://github.com/aws-samples/serverless-test-samples)（参照日 2026-10-17）

[^196]: [AWS Services - LocalStack Docs](https://docs.localstack.cloud/aws/services/)（参照日 2026-10-18。Schema Registry の項目なし。`/aws/services/schemas/` は 404）

[^198]: [Deploy Node.js Lambda functions with container images](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-image.html)（参照日 2026-10-17。base image 22 / 24 / 26）

[^199]: [aws/aws-lambda-runtime-interface-emulator README](https://github.com/aws/aws-lambda-runtime-interface-emulator)（参照日 2026-10-17）
