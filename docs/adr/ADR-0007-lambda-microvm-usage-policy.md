# ADR-0007: Lambda MicroVM usage policy

- Status: proposed
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0004, ADR-0006, ADR-0008, ADR-0009, ADR-0015

## Context

AWS Lambda MicroVMs は、Firecracker による VM 級隔離、完全な OS 機能（システムパッケージのインストール、ファイルシステムのマウント）、スナップショットによる高速起動、ingress / egress ネットワークの細かな制御を提供する serverless compute environment である。AWS はユースケースとして、対話型開発環境、AI コード実行 sandbox、データ分析（Jupyter 等）、セキュリティスキャン、強化学習環境、マルチテナント CI/CD、ユーザー提供スクリプトを実行するゲームサーバを挙げている。[^68][^23]

MicroVM の制約（参照日 2026-10-17）は次のとおり。[^42][^21][^68]

| 項目           | 値                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 最大実行時間   | 8 時間（28,800 秒）、running + suspended の合計。引き上げ不可[^42][^21]                                                                  |
| アーキテクチャ | ARM64（Graviton）のみ[^42]                                                                                                               |
| メモリ quota   | リージョン当たり既定 400 GB（US East / Ohio / Oregon / Tokyo は 1,024 GB）、4 倍まで burst。引き上げ可[^42]                              |
| API rate       | `RunMicrovm` 5 TPS、`ResumeMicrovm` 5 TPS、`SuspendMicrovm` 2 TPS（引き上げ可）[^42]                                                     |
| ネットワーク   | 専用 HTTPS endpoint + JWE 認証、egress は public internet / VPC を設定可能[^68][^23]                                                     |
| ライフサイクル | run / suspend / resume / terminate を API または idle policy で制御。suspend 中はメモリ・ディスク状態を保持し compute 課金なし[^68][^23] |
| 課金           | 稼働中は秒単位の compute（baseline + peak）、suspend 中は snapshot storage、データ転送[^23][^51]                                         |

AWS 自身が MicroVM を「user or AI-produced untrusted code を実行する persistent environment」向けと位置づけており[^21]、通常の短い REST API を置き換えるものではない。B2B PaaS では将来、テナントがカスタムスクリプト、プラグイン、AI エージェントのツール実行を持ち込む可能性がある。そのとき pool Lambda（ADR-0004）上でテナント任意コードを実行すると、実行環境の共有とクレデンシャルの漏洩リスクが生じる。一方で、MicroVM を「長時間実行できる Lambda」として通常 API や batch に流用すると、課金モデルと観測性が標準 paved road から外れる。

## Decision

準拠: AWS Lambda Developer Guide「AWS Lambda MicroVMs」（想定ユースケースと主要機能）[^68]、「What is AWS Lambda?」（3 primitive の比較）[^21]、Lambda quotas[^42]、AWS SaaS Lens（tenant isolation）[^12]

- **通常の同期 API、非同期 consumer、workflow task には Lambda MicroVMs を使用禁止とする。** AWS の比較表でも Event Functions が request-response / event-driven、Web Functions が HTTP backend、MicroVMs が untrusted code の persistent environment と役割分担されている。[^21]
- **MicroVM は `runtimeProfile: 'microvm-sandbox'` として、次の 4 条件を 1 つ以上満たす機能に限り、個別 ADR を起票したうえで許可する。** いずれも AWS が挙げるユースケースに含まれる。[^68]
  1. テナント提供コード（スクリプト、プラグイン、カスタム変換）の実行
  2. AI エージェントのツール実行 sandbox
  3. セッション間でメモリ・ディスク状態を保持する対話セッション（REPL、notebook、ブラウザ自動化）
  4. VM 級隔離を契約・規制上要求される処理
- MicroVM を使う機能は、専用の Service Stack と専用 execution role を持ち、pool datastore へ直接アクセスできない。結果はサービスの公開 API またはイベント経由で返す。
- MicroVM セッションは `ExecutionContext.tenantId` 単位で生成し、テナント間でセッションを共有しない。AWS も「各テナントを隔離されたカーネル、メモリ空間、ディスク状態で実行」する用途を示している。[^23]
- 最大実行時間は機能ごとに上限（本テンプレート既定 15 分、AWS 上限 8 時間[^42]）を `ServiceManifest` に明記し、idle policy による自動 suspend[^68]と、上限到達時の terminate、課金 alarm を必須とする。既定値（例示値）: 15 分。AWS 上限 8 時間の内側で、課金暴走と放置セッションを抑えるため Lambda Event Functions の timeout 上限と同じ値に揃えた設計判断で、外部出典に基づかない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-05、PoC M-08 のセッション時間分布をもとに見直す）。
- MicroVM の outbound network は既定で遮断し、許可する宛先（例: サービス自身の公開 API、パッケージレジストリの proxy）を egress 設定で明示する。[^68]
- MicroVM へ渡す入力と MicroVM から受け取る出力は `@paas/event-contracts` と同じ envelope（`tenantId`, `correlationId`）を持ち、ADR-0015 の相関 ID 検索の対象に含める。
- `RunMicrovm` の API rate（既定 5 TPS）[^42]を超えるセッション開始が見込まれる場合は、事前に quota 引き上げを申請する。

本 ADR を `accepted` に変更するには、Evidence 節の PoC を少なくとも 1 機能で完了し、隔離と費用の結果を記録する必要がある。それまでは「通常 API 禁止」の部分のみを即時適用する。

## Alternatives

### A. 通常 Lambda Event Functions でテナントコードを `vm` モジュールや WebAssembly で実行

- 長所: 既存 paved road、Powertools、alias 運用をそのまま使える。
- 短所: Node.js 公式ドキュメントは「The `node:vm` module is not a security mechanism. Do not use it to run untrusted code.」と明記している（確認日 2026-10-17）。[^v1]WebAssembly は隔離が強いが、テナントが任意の Node.js / Python コードを書く要件には合わない。状態保持ができない。[^21]

### B. ECS/Fargate で tenant ごとの task を起動

- 長所: 長時間実行と状態保持が可能で、Fargate task は専用のカーネル・CPU・メモリ・ENI を持ち他 task と共有しない。[^73]
- 短所: task 起動時間は公式に数値が公開されておらず、image の pull 時間が image サイズに比例することが AWS Containers Blog に記載されている[^v2]ため、対話セッションの初回応答は PoC で実測する。課金は秒単位だが 1 分の最小課金があり[^v3]、短時間 sandbox では MicroVM より高くなりうる（計測で確定: セッション時間分布ごとの月額を `pnpm cost-model` で試算する。docs/decision/template-defaults.md#計測で確定する項目 M-09、現在は未計測）。ADR-0009 の対象として長時間 batch では再評価する。

### C. MicroVM を長時間 batch や通常 API にも使う

- 長所: 1 つのプリミティブで統一できる。
- 短所: 通常 API では API Gateway 連携、alias / weighted routing、Powertools が使えず、`RunMicrovm` 5 TPS の API rate[^42]が request 単位の起動には不向き。batch は Step Functions Distributed Map（既定 10,000 並列）[^88]や AWS Batch の方が単価と観測性で優れる。

## Consequences

- **費用**: MicroVM は稼働中の秒単位 compute と suspend 中の snapshot storage で課金される。[^23] セッションの idle policy と最大時間を厳格に管理しないと費用が膨らむ。tenant 別の cost attribution（ADR-0018）でセッション時間を配賦する。
- **性能**: 通常 API に MicroVM を使わないことで、標準 API の p99 budget と Provisioned Concurrency 戦略は影響を受けない。
- **運用**: MicroVM 専用の observability preset（セッション ID、tenant ID、実行時間、terminate 理由）を `@paas/observability` に追加する必要がある。AWS の monitoring ガイド[^68]に従う。
- **Lock-in**: MicroVM は Lambda 固有のプリミティブであり、代替は Fargate task または自前 Firecracker となる。採用機能を限定することで lock-in 範囲を狭める。
- **移行**: 将来 MicroVM の機能が拡張され通常 API に有利となった場合は ADR-0006 と同じ benchmark protocol で再評価する。

## Evidence

PoC protocol（`tests/resiliency/microvm-sandbox/`）。合格閾値は本テンプレートの初期値。計測で確定: 初回 PoC のセッション開始 p50 / p95、状態復元時間、同時 100 セッションの throttle、隔離試験の結果を本 ADR に記録し、閾値を見直す（docs/decision/template-defaults.md#計測で確定する項目 M-08、現在は未計測・試験ディレクトリ未作成）。

1. テナント提供スクリプトを実行する sandbox 機能を 1 つ選び、MicroVM と Fargate task の 2 案で実装する。
2. 隔離試験: sandbox 内から pool DynamoDB テーブル、他テナントのセッション、execution role の credentials へアクセスを試み、すべて拒否されることを確認する。egress 制限[^68]が有効であることを外部宛て通信で確認する。
3. 性能: セッション開始 p50/p95（run と resume の両方）、状態復元時間、同時セッション 100 件での `RunMicrovm` throttle[^42]を計測する。
4. 費用: 1 セッション 10 分 × 1 日 1,000 セッションの月額を両案で試算する。[^51]
5. 合格条件: 隔離試験で越境 0 件、セッション開始 p95 < 2 秒、費用が Fargate 案以下または応答性で優位であること。
6. 結果を本 ADR へ追記し、許可機能一覧を固定する。

## Compliance / How it is enforced

- `ObservableFunction` が `runtimeProfile: 'microvm-sandbox'` を受け付けるのは `ServiceManifest.runtimeProfile` が一致し、`adrs` に本 ADR と機能別 ADR が参照されている場合のみ。`PlatformGuardrails` がそれ以外を synth で拒否する。
- `PavedApiService` と `PavedQueueConsumer` は MicroVM プロファイルの関数を handler として受け付けない（型レベルで排除）。
- `PlatformGuardrails` が MicroVM 用 execution role から `TenantAwareTable` への直接アクセス権限を検出して拒否する。
- セッション最大時間と idle policy を `ServiceManifest` に必須化し、超過を検出する alarm を `ServiceObservability` が自動生成する。
- threat model（`docs/threat-models/`）に sandbox escape と credential exposure の項目を必須化し、セキュリティレビューを通過しない限り production へ deploy しない。

## 参考

[^12]: [Multi-tenant microservices - SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/multi-tenant-microservices.html)（指針書 References より）

[^21]: [What is AWS Lambda?](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html)（参照日 2026-10-17）

[^23]: [AWS Lambda MicroVMs](https://aws.amazon.com/lambda/lambda-microvms/)（参照日 2026-10-17）

[^42]: [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)（参照日 2026-10-17）

[^51]: [AWS Lambda Pricing](https://aws.amazon.com/lambda/pricing/)（参照日 2026-10-17）

[^68]: [AWS Lambda MicroVMs (Developer Guide)](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html)（参照日 2026-10-17）

[^73]: [Architect for AWS Fargate for Amazon ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)（参照日 2026-10-17）

[^88]: [Using Map state in Distributed mode (Step Functions)](https://docs.aws.amazon.com/step-functions/latest/dg/state-map-distributed.html)（参照日 2026-10-17）

[^v1]: [VM (executing JavaScript) - Node.js Documentation](https://nodejs.org/api/vm.html)（参照日 2026-10-17）

[^v2]: [Under the hood: Lazy Loading Container Images with Seekable OCI and AWS Fargate - AWS Containers Blog](https://aws.amazon.com/blogs/containers/under-the-hood-lazy-loading-container-images-with-seekable-oci-and-aws-fargate/)（参照日 2026-10-17。「With overlayfs there is a correlation between the time taken to pull an image and the size of the container image.」起動秒数の公表なし）

[^v3]: [AWS Fargate Pricing](https://aws.amazon.com/fargate/pricing/)（参照日 2026-10-17。「Pricing is calculated per second with a 1-minute minimum.」ap-northeast-1 の単価は AWS Price List Bulk API `AmazonECS` の ap-northeast-1 ファイル https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/ap-northeast-1/index.json で確認）
