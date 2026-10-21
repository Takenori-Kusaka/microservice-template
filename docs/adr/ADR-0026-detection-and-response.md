# ADR-0026: Detection and response (GuardDuty / Security Hub / CloudTrail, auto-containment, log archive)

- Status: proposed
- Date: 2026-10-21
- Owner: platform-team + security-team
- Review date: 2027-04-21
- Related: ADR-0003（log-archive / security-tooling account の追加が必要）, ADR-0004, ADR-0007, ADR-0015, ADR-0020（code signing）, ADR-0022（CloudTrail 集約先）, ADR-0025（G9）, [第21章 21.3〜21.7](../microservice-guidelines-resilience-security.md), [runbooks/security-incident.md](../runbooks/security-incident.md), [threat-models/order-service.md](../threat-models/order-service.md)

## Context

第21章 21.1 は本 PaaS の攻撃者像を「資格情報悪用で log in し、機械速度で偵察・持ち出しを行う」と固定した。CrowdStrike 2026 Global Threat Report は eCrime の平均 breakout time 29 分（最速 27 秒）、検知の 82% が malware-free と報告し[^257]、Anthropic は AI が侵入作業の 80〜90% を実行したキャンペーンを公表した。[^258] 人手の封じ込めは攻撃速度に追いつかないため、検出から封じ込めまでを自動化し、誤検知時に人が止められる設計が必要になる。

pool モデル（ADR-0004）では 1 テナントの侵害が同じテーブル・関数・同時実行予算を共有する他テナントへ波及しうる。既存の層（JWT authorizer、`LeadingKeys` + `Scan` 禁止、per-function role、cell / account 分割、SCP、audit log）は MITRE ATT&CK IaaS matrix の tactic に対応付けて 21.3 に整理済み。[^256]

マネージド検出サービスの公式仕様（参照日 2026-10-18）:

| サービス                            | 検出範囲                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GuardDuty Lambda Protection         | Lambda network activity logs（VPC を使わない関数も含む）を監視し C&C / 暗号通貨 / Tor 等 7 種の finding を出す。Lambda@Edge は対象外。課金は処理ログ量[^230][^231]。CloudFormation では `AWS::GuardDuty::Detector` の `Features` に `LAMBDA_NETWORK_LOGS` を `ENABLED` で指定（2026-10-21）[^265]                                |
| GuardDuty Extended Threat Detection | GuardDuty 有効時に追加費用なしで既定有効。24 時間 rolling window で相関し `AttackSequence:IAM/CompromisedCredentials` / `S3/CompromisedData` 等を Critical で出す。suppression rule で archive された finding は相関に使われない[^233]                                                                                           |
| GuardDuty finding の配信            | EventBridge へ新規は near real-time、更新は既定 6 時間（15 分 / 1 時間に変更可）。finding 保持 90 日[^236]                                                                                                                                                                                                                       |
| CloudTrail data events              | DynamoDB table（item-level 全操作）/ Streams、Lambda `Invoke`、S3、SQS、SNS、EventBridge、Step Functions。既定では記録されず追加課金。advanced event selector で `eventName` / `readOnly` / `resources.ARN` を絞れる[^237][^238]。料金は $0.10 / 100,000 data events（management events は最初の 1 copy 無料、2026-10-21）[^264] |
| CloudTrail log file validation      | 1 時間ごとの digest file を SHA-256 with RSA で署名、前 digest の署名を連鎖。`validate-logs` で改変・削除を検出[^240]                                                                                                                                                                                                            |
| CloudTrail trail                    | 組織 trail は management account または delegated administrator のみ作成可。console で作る trail は multi-Region、single-Region trail は CLI で作る（2026-10-21）[^266]                                                                                                                                                          |
| S3 Object Lock                      | compliance mode では保持期間中は root を含め誰も上書き・削除できず、retention mode の変更と期間短縮も不可。Versioning 必須（2026-10-21）[^263]                                                                                                                                                                                   |
| Security Hub CSPM                   | FSBP / CIS / PCI / NIST の control を Config 経由で評価し、GuardDuty / Inspector / Macie の finding を ASFF で集約。automation rule は admin account あたり最大 100[^242][^244]。exposure findings は attack path / blast radius を可視化[^243]                                                                                  |
| Amazon Detective                    | CloudTrail / VPC Flow / GuardDuty finding から behavior graph、最大 1 年の履歴、finding group、IAM investigation[^245]                                                                                                                                                                                                           |
| AWS Config                          | configuration item と履歴、rule、conformance pack、remediation、aggregator[^246]                                                                                                                                                                                                                                                 |
| Amazon Inspector                    | Lambda standard / code scanning（90 日以内に invoke / 更新された `$LATEST`、CMK 暗号化関数は非対応）[^247]、code security（SAST / SCA / IaC、2025-06-17 GA）[^248]                                                                                                                                                               |
| IAM Access Analyzer                 | external / internal / unused access、custom policy checks。external access の対象に Lambda / SQS / KMS / Secrets Manager / DynamoDB table / stream[^261]                                                                                                                                                                         |
| CloudTrail Lake                     | 2026-05-31 以降は新規顧客に非開放。AWS は CloudWatch（pipelines、OCSF）への移行を推奨[^160][^161]                                                                                                                                                                                                                                |
| AWS SRA                             | Security OU に Log Archive account（immutable storage、storage sink）と Security Tooling account（GuardDuty / Security Hub / Detective の delegated admin）を置く[^249][^162]                                                                                                                                                    |

アプリ層の検出源 `TenantIsolationViolationAttempt` は `packages/observability/src/metrics.ts` の `recordIsolationViolation()` として、API 入口（`apps/example-order-service/src/entrypoints/http/shared.ts`）、Web Functions 入口（同 `web/server.ts`）、queue consumer（`apps/example-worker-service/src/entrypoints/queue/fulfill-order.ts`）の拒否点で発行される（コードで確認 2026-10-21。reason は `missing-tenant` / `invalid-tenant` / `foreign-cursor` / `envelope-tenant` / `other`）。

本 sandbox は共有の production アカウントに同居しているため、account / region singleton である GuardDuty detector と Security Hub を template が無条件に作ると、security-team が運用する既存の設定と衝突する。

## Decision

準拠: AWS Security Reference Architecture[^249][^162]、AWS Well-Architected SEC04-BP01 / SEC10[^250][^251]、AWS Security Incident Response Guide[^252]、NIST SP 800-61 Rev. 3 / CSF 2.0[^254][^255]、MITRE ATT&CK IaaS[^256]、GuardDuty / CloudTrail / Security Hub / Detective / Config / Inspector / Access Analyzer の各 User Guide[^230][^233][^236][^237][^240][^242][^245][^246][^247][^261]

### 1. 責任分界

- **account レベルのサービス（GuardDuty、Security Hub CSPM、CloudTrail 組織 trail、Config recorder、Inspector、Access Analyzer、Detective）は security-team が account ごとに有効化し、delegated administrator を Security Tooling account に置く（SRA）。**[^249] 本テンプレートはこれらを前提とし、template 側では作らない。
- **本テンプレートは opt-in の CDK construct `PlatformDetection`（`packages/constructs/src/platform-detection.ts`）を提供する。** `PlatformStack` が context `detection=true` のときだけ生成し（`cdk deploy --context detection=true`、CDK の `--context` は `node.tryGetContext` で読む[^215]）、既定では生成しない。理由は上記の singleton 衝突と、CloudTrail data events が event 数課金であること。[^264] 生成するリソースは次のとおり。

  | リソース                                             | 設定                                                                                                                                                                                                                                                                                                    |
  | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | CloudTrail trail（cell 単位、single-Region）         | `enableFileValidation: true`[^240]、management events read + write、`includeGlobalServiceEvents: true`、名前 `paas-<env>-<cellId>-trail`                                                                                                                                                                |
  | 専用 S3 bucket                                       | versioned、S3 managed 暗号化、SSL 強制、public access block、`objectLockEnabled: true`（retention rule を bucket 再作成なしに後付けできる Object Lock-ready 設定）[^263]、lifecycle `evidence-retention`（既定 365 日、`trailRetentionDays` で TD-31 に合わせる）、production は `RemovalPolicy.RETAIN` |
  | data events                                          | cell の `AWS::DynamoDB::Table`（`table/paas-<env>-*`）と Lambda 関数（`function:paas-<env>-*`）を read + write で記録[^237][^238]                                                                                                                                                                       |
  | GuardDuty detector（`enableGuardDuty: true` のとき） | `LAMBDA_NETWORK_LOGS` と `S3_DATA_EVENTS` を `ENABLED`[^265][^230]、`findingPublishingFrequency: FIFTEEN_MINUTES`[^236]                                                                                                                                                                                 |
  | Security Hub（`enableSecurityHub: true` のとき）     | `enableDefaultStandards: true`、`controlFindingGenerator: SECURITY_CONTROL`[^242]                                                                                                                                                                                                                       |
  | EventBridge rule                                     | `aws.guardduty` の `GuardDuty Finding` で `severity >= 7` を alarm topic（on-call）へ[^236]                                                                                                                                                                                                             |

- Log Archive account への集約（組織 trail → Object Lock compliance bucket）は ADR-0003 改訂の対象であり、`PlatformDetection` の cell 単位 trail はそれまでの代替と、cell 固有の data events の補完に使う。

### 2. 検出（第21章 21.4）

- GuardDuty（Lambda Protection、S3 Protection、Extended Threat Detection）、Security Hub CSPM、Config、Inspector Lambda scanning、Access Analyzer を全 account で MUST 有効化する。[^230][^233][^242][^246][^247][^261]
- production の `TenantAwareTable` では CloudTrail data events（少なくとも書き込み系）を MUST 記録する（例示値。読み取り系の量と費用は計測で確定: M-27、未計測）。`Scan` は IAM で禁止済み（ADR-0004）なので、data event に `eventName=Scan` が出ること自体を P1 とする。[^238]
- アプリ層: `TenantIsolationViolationAttempt` を API / Web / consumer の拒否点で MUST 発行し alarm を MUST 持つ（既定値（例示値）: 1 件で P2、同一 `subjectId` から 5 分に 10 件で P1。調整: TD-30）。authorizer 失敗率、冪等キー衝突、cursor 偽装、監査証跡停止（Config rule、`StopLogging` の EventBridge rule）も同表に従う。
- suppression rule と automation rule の追加は security-team の承認を MUST 経る（Extended Threat Detection の相関から外れるため[^233]）。

### 3. 自動封じ込めと abort（第21章 21.7）

- 対象は既定値（例示値）: GuardDuty severity ≥ 7（High / Critical）または `AttackSequence:*`、かつ影響範囲が 1 テナント / 1 関数 / 1 role に特定できる finding（調整: TD-32）。[^233][^236] 特定できない場合は人手判定。
- 封じ込め Lambda は Security Tooling account に置き、各 workload account の封じ込め専用 role（`PutFunctionConcurrency`[^40]、`UpdateEventSourceMapping`、`PutRolePolicy`（`AWSRevokeOlderSessions` のみ[^259]）、authorizer deny list の `PutItem`）だけを assume できる。削除系 API は持たない。
- abort: 誤検知時は security on-call が `containment-release` Lambda を手動実行し、解除も CloudTrail に残す。自動封じ込めが 1 時間に 3 回（既定値（例示値）、TD-32）を超えたら自動実行を停止し人手へ切り替える。反映時間は計測で確定: M-28。
- SLO（既定値（例示値）、調整: TD-30）: GuardDuty finding の EventBridge 配信 5 分以内（更新 finding の頻度を 15 分に設定[^236]）、P1 の一次判定 15 分以内、tenant / principal 単位の封じ込め 30 分以内（自動は 5 分以内）、根絶・復旧 24 時間以内。CrowdStrike の breakout time 平均 29 分[^257]より短く封じ込めるための設計判断。

### 4. 証拠保持と trace（第21章 21.5）

- 組織 trail は log file validation を MUST 有効化し、Log Archive account の Object Lock compliance mode bucket へ MUST 配信する。[^240][^263][^162]
- 保持期間は既定値（例示値）: CloudTrail と audit log は即時検索 1 年 + アーカイブ 7 年、GuardDuty finding は S3 export で 1 年、forensic 証拠はインシデント終結後 1 年以上（SEC04-BP01 の「3 か月〜1 年を即時検索可能、最長 7 年」の範囲で規制要件未確定のため上限側に置いた。調整: TD-31）。[^250][^236]
- 監査証跡の分析は CloudTrail trail → S3 → Athena を正本とし、CloudTrail Lake は採用しない（ADR-0022）。[^160][^161]
- chain-of-custody: 証拠の取得者・時刻・取得元 ARN・SHA-256 を記録し、Object Lock bucket にコピーし、封じ込め操作は CloudTrail に残る API で行う（NIST CSF 2.0 RS.AN-06 / RS.AN-07）。[^255]

### 5. `accepted` への条件

- G9（security game day）を staging で 1 回実施し、TTD / triage / TTC / TTR（M-26）を本 ADR に記録する。
- `PlatformDetection` を `detection=true` で staging に deploy し、data events の量と月額（M-27）、封じ込め手段の反映時間（M-28）を記録する。
- ADR-0003 を改訂して log-archive / security-tooling account を追加する。

## Alternatives

### A. template が GuardDuty / Security Hub / 組織 trail を無条件に作る

- 長所: `cdk deploy` だけで検出が揃う。
- 短所: GuardDuty detector と Security Hub は account / region singleton で、security-team の既存設定（delegated admin、organization trail）と衝突する。本 sandbox は共有 production アカウントに同居しており、無条件生成は事故になる。opt-in（`detection=true`）にする。

### B. CloudTrail Lake を監査証跡の正本にする

- 長所: SQL で直接クエリ、7 年保持オプション。[^160]
- 短所: 2026-05-31 以降は新規顧客に非開放。[^160][^161] S3 + Athena（+ CloudWatch pipelines の評価）に置く。

### C. 自動封じ込めなし（人手対応のみ）

- 長所: 誤検知で顧客を遮断するリスクがない。
- 短所: breakout time 平均 29 分・最速 27 秒[^257]、AI 支援攻撃の自動化[^258]に人手の triage（15 分）+ 封じ込め（30 分）では間に合わない。abort 手段と回数上限（TD-32）で誤検知リスクを抑えて自動化する。

### D. AWS Security Incident Response（有償）に triage を委ねる

- 長所: GuardDuty / Security Hub 経由の finding を自動 triage（99% 超をフィルタ）し 24/7 で AWS CIRT につなぐ。[^253]
- 短所: Organizations 統合と料金は公式ページに記載なし（確認日 2026-10-18、https://aws.amazon.com/security-incident-response/ ）。[^253] 自前 SOC がない組織の選択肢として runbook に残し、本 ADR の既定にはしない。

## Consequences

- **費用**: CloudTrail data events は $0.10 / 100,000 events（S3 配信）、management events は最初の 1 copy 無料。[^264] `PlatformDetection` の cell 単位 trail は management events の 2 copy 目になりうるため（組織 trail がある account では $2.00 / 100,000 events[^264]）、組織 trail 整備後は data events 専用に絞る。GuardDuty Lambda Protection は処理ログ量課金。[^230] Extended Threat Detection は追加費用なし。[^233] 計測で確定: data events の量と月額（M-27、未計測）。
- **性能**: 検出はアプリの経路外（CloudTrail / GuardDuty）で、Lambda の latency に影響しない。`recordIsolationViolation()` は EMF の 1 metric 追加のみ。
- **運用**: security-team が account レベルのサービスと delegated admin、platform-team が `PlatformDetection` と封じ込め Lambda、両者で runbook（security-incident.md）と G9 を保守する。GuardDuty finding の保持は 90 日のため S3 export を設定する。[^236]
- **Lock-in**: GuardDuty / Security Hub / Detective は AWS 固有。CloudTrail ログは S3 の JSON で Athena / 外部 SIEM から読める。
- **移行**: `detection=true` で staging に deploy → M-26 / M-27 / M-28 の計測 → ADR-0003 改訂（log-archive / security-tooling）→ 組織 trail へ移行し cell trail を data events 専用に縮小。

## Evidence

proposed の protocol（accepted への条件）:

| 項目                                   | 計測方法                                                                                                                                                                                        | 合格閾値                                                                   | 記録先                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------- |
| G9 の TTD / triage / TTC / TTR（M-26） | GuardDuty sample finding（Lambda Protection / AttackSequence）生成と staging の擬似漏えい key で、finding `createdAt` → EventBridge 受信 → page → 封じ込め API 呼び出し（CloudTrail）の各時刻差 | TD-30（TTD 5 分、triage 15 分、TTC 30 分 / 自動 5 分）                     | 本 ADR、runbooks/security-incident §8 |
| data events の量と月額（M-27）         | staging で書き込み系のみ → 読み書き両方の順に有効化し、S3 配信量と Cost Explorer の `DataEventsRecorded` を 1 週間記録                                                                          | 計測で確定: 読み取り系を production で有効化するかを量で判断（閾値未設定） | 本 ADR、template-defaults M-27        |
| 封じ込め手段の反映時間（M-28）         | staging で authorizer deny list / reserved concurrency 0 / WAF rule を実行し、k6 の連続リクエストで拒否が観測されるまでの秒数                                                                   | TD-30 の自動封じ込め 5 分以内に収まること                                  | 本 ADR、runbooks/security-incident §4 |
| `TenantIsolationViolationAttempt`      | `tests/tenant-isolation`（3 件、sandbox で 2 回 pass、E-102）に metric 発行の assertion を追加し、alarm の P1 / P2 振り分けを unit test で検証                                                  | 拒否点 3 箇所すべてで metric が出る                                        | `tests/tenant-isolation`              |
| `PlatformDetection` の synth / deploy  | `cdk synth --context detection=true` が cdk-nag を通り、staging deploy で trail の `validate-logs` が成功する[^240]                                                                             | synth エラー 0、`validate-logs` 成功                                       | 本 ADR                                |

既存の根拠: 第21章 21.4 の必須ルールとチェックリスト、SRA のアカウント構成[^249][^162]、SEC10 の準備項目（要員、playbook、forensic、simulation）[^251]、Security Incident Response Guide の段階（detection / analysis / containment / eradication / recovery）[^252]、NIST SP 800-61 Rev. 3[^254]。

## Compliance / How it is enforced

- `PlatformDetection`（`packages/constructs/src/platform-detection.ts`）は `PlatformStack` から `detection.enabled` が true のときだけ生成され、`apps/platform-cdk` の `EnvironmentStage` が context `detection` を props に渡す。GuardDuty / Security Hub は `enableGuardDuty` / `enableSecurityHub` が true のときだけ作る（既定 false）。
- `PlatformGuardrails` の cdk-nag（AwsSolutions）が trail bucket の暗号化 / SSL / public access を検査し、`StatefulRetainAspect` が production の bucket に `Retain` を要求する。[^104]
- `recordIsolationViolation()` の呼び出しは `PavedApiService` middleware（`shared.ts`）、Web preset（`server.ts`）、`PavedQueueConsumer` preset（`fulfill-order.ts`）に組み込まれ、サービス側で省略できない。`ServiceObservability` が `TenantIsolationViolationAttempt` の alarm（P2: ≥ 1、P1: 同一 `subjectId` 5 分 10 件）を生成する（追加予定）。
- SCP / RCP（ADR-0003）で member account から CloudTrail / Config / GuardDuty を停止できないようにする。[^94][^262] Config rule で IAM user の長期 access key を検出する。
- `tests/tenant-isolation` を CI の `tenant isolation` ステップで毎回実行する。
- 週次 SLO レビューで Security Hub exposure findings[^243]、四半期 architecture review で Access Analyzer unused access[^261] と TD-30 / TD-31 / TD-32 を見直す。

## Expiry / Review date

| 日付       | 評価者                        | 結果                                                                                |
| ---------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| 2026-10-21 | platform-team + security-team | 初版（proposed）。`PlatformDetection` を opt-in で追加。accepted 条件は Evidence 節 |

## 参考

[^40]: [Configuring reserved concurrency for an Event Function](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)（参照日 2026-10-17）

[^94]: [Service control policies (SCPs)](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)（参照日 2026-10-17）

[^104]: [cdk-nag (GitHub, cdklabs)](https://github.com/cdklabs/cdk-nag)（参照日 2026-10-17）

[^160]: [Working with AWS CloudTrail Lake](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-lake.html)（参照日 2026-10-18。2026-05-31 以降は新規顧客に非開放）

[^161]: [CloudTrail Lake availability change](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-lake-service-availability-change.html)（参照日 2026-10-18）

[^162]: [Security OU – Log Archive account - AWS SRA](https://docs.aws.amazon.com/prescriptive-guidance/latest/security-reference-architecture/log-archive.html)（参照日 2026-10-18）

[^215]: [Context values and the AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/context.html)（参照日 2026-10-21。`--context key=value`、`node.tryGetContext`、CLI からの値は常に文字列）

[^230]: [GuardDuty Lambda Protection](https://docs.aws.amazon.com/guardduty/latest/ug/lambda-protection.html)（参照日 2026-10-18）

[^231]: [Lambda Protection finding types](https://docs.aws.amazon.com/guardduty/latest/ug/lambda-protection-finding-types.html)（参照日 2026-10-18）

[^233]: [GuardDuty Extended Threat Detection](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty-extended-threat-detection.html)（参照日 2026-10-18）

[^236]: [Processing GuardDuty findings with Amazon EventBridge](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_findings_cloudwatch.html)（参照日 2026-10-18。更新 finding 既定 6 時間 → 15 分、保持 90 日）

[^237]: [Logging data events - AWS CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/logging-data-events-with-cloudtrail.html)（参照日 2026-10-18）

[^238]: [Logging DynamoDB operations by using AWS CloudTrail](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/logging-using-cloudtrail.html)（参照日 2026-10-18）

[^240]: [Validating CloudTrail log file integrity](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-intro.html)（参照日 2026-10-18）

[^242]: [Introduction to AWS Security Hub CSPM](https://docs.aws.amazon.com/securityhub/latest/userguide/what-is-securityhub.html)（参照日 2026-10-18）

[^243]: [Exposure findings in Security Hub](https://docs.aws.amazon.com/securityhub/latest/userguide/exposure-findings.html)（参照日 2026-10-18）

[^244]: [Understanding automation rules in Security Hub CSPM](https://docs.aws.amazon.com/securityhub/latest/userguide/automation-rules.html)（参照日 2026-10-18）

[^245]: [What is Amazon Detective?](https://docs.aws.amazon.com/detective/latest/userguide/what-is-detective.html)（参照日 2026-10-18）

[^246]: [What Is AWS Config?](https://docs.aws.amazon.com/config/latest/developerguide/WhatIsConfig.html)（参照日 2026-10-18）

[^247]: [Scanning AWS Lambda functions with Amazon Inspector](https://docs.aws.amazon.com/inspector/latest/user/scanning-lambda.html)（参照日 2026-10-18）

[^248]: [Amazon Inspector launches code security - AWS What's New 2025-06-17](https://aws.amazon.com/about-aws/whats-new/2025/06/amazon-inspector-code-security-shift-security-development/)（参照日 2026-10-18）

[^249]: [The AWS Security Reference Architecture](https://docs.aws.amazon.com/prescriptive-guidance/latest/security-reference-architecture/architecture.html)（参照日 2026-10-18）

[^250]: [SEC04-BP01 Configure service and application logging - AWS Well-Architected](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/sec_detect_investigate_events_app_service_logging.html)（参照日 2026-10-18）

[^251]: [Incident response / Preparation - AWS Well-Architected Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/preparation.html)（参照日 2026-10-18）

[^252]: [Updated whitepaper available: AWS Security Incident Response Guide - AWS Security Blog](https://aws.amazon.com/blogs/security/updated-whitepaper-available-aws-security-incident-response-guide/)（参照日 2026-10-18。2023-01-04。本体ページ本文は 2026-10-18 に取得できず、構成は Blog で確認）

[^253]: [AWS Security Incident Response - What's New 2024-12-01](https://aws.amazon.com/about-aws/whats-new/2024/12/aws-security-incident-response/)、[製品ページ](https://aws.amazon.com/security-incident-response/)（参照日 2026-10-18。Organizations 統合と料金は公式ページに記載なし）

[^254]: [NIST SP 800-61 Rev. 3](https://csrc.nist.gov/pubs/sp/800/61/r3/final)（参照日 2026-10-18）

[^255]: [NIST CSF 2.0 本文 PDF](https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf)（参照日 2026-10-18。RS.AN-06 / RS.AN-07）

[^256]: [MITRE ATT&CK Matrix - IaaS](https://attack.mitre.org/matrices/enterprise/cloud/iaas/)（参照日 2026-10-18。v20）

[^257]: [CrowdStrike Global Threat Report（2026 年版）](https://www.crowdstrike.com/en-us/global-threat-report/)（参照日 2026-10-18）

[^258]: [Disrupting the first reported AI-orchestrated cyber espionage campaign - Anthropic](https://www.anthropic.com/news/disrupting-AI-espionage)（参照日 2026-10-18。2025-11-13）

[^259]: [Revoke IAM role temporary security credentials](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html)（参照日 2026-10-18。`AWSRevokeOlderSessions`、約 30 秒後から有効）

[^261]: [Using AWS Identity and Access Management Access Analyzer](https://docs.aws.amazon.com/IAM/latest/UserGuide/what-is-access-analyzer.html)（参照日 2026-10-18）

[^262]: [Resource control policies (RCPs) - AWS Organizations](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_rcps.html)（参照日 2026-10-18。Lambda は対象サービスに含まれない）

[^263]: [Locking objects with Object Lock - Amazon S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)（参照日 2026-10-21。「In compliance mode, a protected object version can't be overwritten or deleted by any user, including the root user in your AWS account」、retention mode 変更・期間短縮不可、Versioning 必須）

[^264]: [AWS CloudTrail Pricing](https://aws.amazon.com/cloudtrail/pricing/)（参照日 2026-10-21。management events は最初の 1 copy 無料、以降 $2.00 / 100,000 events、data events $0.10 / 100,000 events、network activity events $0.10 / 100,000 events）

[^265]: [AWS::GuardDuty::Detector CFNFeatureConfiguration - CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-guardduty-detector-cfnfeatureconfiguration.html)（参照日 2026-10-21。`Name` の許容値は GuardDuty API `DetectorFeatureConfiguration` を参照、`Status` は `ENABLED | DISABLED`）

[^266]: [Creating a trail for your AWS account - AWS CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-create-and-update-a-trail.html)（参照日 2026-10-21。組織 trail は management account または delegated administrator のみ、console の trail は multi-Region、single-Region は CLI）
