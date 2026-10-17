# Runbook：セキュリティインシデント（侵入の検知・封じ込め・根絶・復旧）

| 項目   | 内容                                                                                                                                                                                                                                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 対象   | 本テンプレート由来の全サービス（API / worker / workflow）と platform（control plane、cell router、pipeline）。GuardDuty / Security Hub / Inspector / Access Analyzer の finding、およびアプリ層の検出（`TenantIsolationViolationAttempt`、authorizer 失敗率、冪等キー衝突、cursor 偽装）                                                              |
| 所有   | security on-call（一次）、影響サービスの `ownerTeam` on-call（二次）、platform-team on-call（共通基盤）                                                                                                                                                                                                                                               |
| 優先度 | P1：`AttackSequence:*`、GuardDuty severity ≥ 7、tenant 越境の成功痕跡、監査証跡の停止、production role の侵害。P2：severity 4〜6.9、越境試行のみ、単一テナントの credential stuffing。P3：Inspector / CSPM の finding                                                                                                                                 |
| 関連   | [指針書 第21章](../microservice-guidelines-resilience-security.md)、[第13章](../microservice-guidelines.md#13-セキュリティ)、[第14章](../microservice-guidelines.md#14-リクエストトレーサビリティ)、[第19章](../microservice-guidelines.md#19-運用)、[dlq-redrive](dlq-redrive.md)、[lambda-concurrency-throttling](lambda-concurrency-throttling.md) |

構成は AWS Security Incident Response Guide の Preparation / Operations（detection, analysis, containment, eradication, recovery）/ Post-incident activity[21-62] と NIST SP 800-61 Rev. 3[21-64] に合わせる。攻撃は機械速度で進む（第21章 21.1）ため、**封じ込めを先に、分析は並行して** 行う。全操作は CloudTrail に残る API で行い、証拠の chain-of-custody（第21章 21.5）を守る。

---

## 0. 準備（事前に揃っていること）

| 項目                    | 内容                                                                                                                                          | 根拠              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| break-glass アクセス    | Security Tooling account の `security-responder` permission set（session 1 時間）。各 workload account に封じ込め専用 role（削除系 API なし） | SEC10-BP05[21-61] |
| 事前ツール              | 封じ込め Lambda（第21章 21.7）、`containment-release` Lambda、Athena の CloudTrail テーブル、Detective、forensic bucket（Object Lock）        | SEC10-BP06[21-61] |
| 連絡先                  | `service.yaml` の `onCall`、security on-call、CS、法務、AWS Support / AWS Security Incident Response（契約時）                                | SEC10-BP01[21-61] |
| 演習                    | 四半期の security game day（第21章 G9）。GuardDuty sample finding と staging の擬似漏えい key で TTD / TTC を計測                             | SEC10-BP07[21-61] |
| incident state document | ticket に時刻付きで判断と操作を記録する担当（Communication / Planning）を決める                                                               | Google SRE[21-76] |

## 1. 症状

- GuardDuty finding（Lambda Protection、`AttackSequence:IAM/CompromisedCredentials`、`AttackSequence:S3/CompromisedData`、AI Protection）が EventBridge 経由で page。
- alarm `<serviceId>-tenant-isolation-violation`（P1 / P2）、`<serviceId>-authorizer-failures`、`<serviceId>-idempotency-key-conflict`。
- CloudTrail data event に `Scan`、自サービス以外のテーブル ARN、`VpceAccessDenied` の急増。
- Config rule / EventBridge で CloudTrail `StopLogging`、GuardDuty 無効化、Config recorder 停止を検出。
- 顧客・外部からの通報（他テナントのデータが見えた、など）。

## 2. ダッシュボード / alarm

| 項目         | 場所                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| finding      | Security Tooling account の GuardDuty / Security Hub（CSPM と exposure findings）、Detective finding group |
| アプリ       | CloudWatch dashboard `<serviceId>-<env>` の「Security」セクション（越境試行、authorizer 失敗、冪等衝突）   |
| 監査証跡     | Log Archive account の CloudTrail bucket（Athena）、audit log group、API Gateway access log                |
| 自動封じ込め | `security-containment` Lambda のログ（実行した遮断、対象、解除手順）                                       |

## 3. 診断手順（分析）

封じ込め（§4）が先に走っていても、以下を並行して進める。すべての取得結果は `s3://paas-<env>-forensic/<incidentId>/` に SHA-256 と取得時刻を付けて保存する。

### 3.1 finding の確認と影響範囲の仮決め

```bash
export INCIDENT=INC-$(date -u +%Y%m%d)-001
# finding の詳細（Security Tooling account）
aws guardduty get-findings --detector-id "$DETECTOR" --finding-ids "<findingId>" > /tmp/$INCIDENT-finding.json
# Detective の investigation（IAM role / user が主体の場合）
aws detective start-investigation --graph-arn "$GRAPH" --entity-arn "<role-or-user-arn>" \
  --scope-start-time "$(date -u -d '-24 hours' +%FT%TZ)" --scope-end-time "$(date -u +%FT%TZ)"
```

仮決めする 4 点：**主体**（role session / Identity Center user / token の `subjectId`）、**範囲**（tenant / 関数 / account）、**経路**（資格情報 / injection / サプライチェーン / agent）、**進行度**（偵察 → 権限昇格 → 持ち出し）。

### 3.2 アプリログから影響テナントと操作を特定

```
# Logs Insights（log group: /aws/lambda/<serviceId>-*-<env>、audit log group）
fields @timestamp, service, operation, tenantId, subjectId, correlationId, requestId, level, errorName
| filter subjectId = "<subjectId>" or correlationId = "<correlationId>"
| sort @timestamp asc
| limit 1000
```

```
# 越境試行の集計（EMF の metadata に tenantId が残る）
fields @timestamp, tenantId, subjectId, operation
| filter TenantIsolationViolationAttempt > 0
| stats count() by tenantId, subjectId, operation
```

### 3.3 CloudTrail で AWS API の操作を突合

```sql
-- Athena（Log Archive account の CloudTrail テーブル）
SELECT eventtime, eventsource, eventname, useridentity.type, useridentity.principalid,
       useridentity.sessioncontext.sessionissuer.arn AS issuer,
       useridentity.sessioncontext.sourceidentity AS src,
       useridentity.inscopeof.sourcearn AS invoked_from,
       sourceipaddress, errorcode, requestparameters
FROM cloudtrail_logs
WHERE eventtime BETWEEN '<start>' AND '<end>'
  AND (useridentity.principalid LIKE '<role-id>%' OR useridentity.sessioncontext.sourceidentity = '<user>')
ORDER BY eventtime;
```

確認すること：`sessionIssuer.arn` が関数単位の role なら侵害された関数が一意に決まる。`sourceIdentity` / `onBehalfOf.userId` が無い人の操作は Identity Center 外のアクセスであり、それ自体が異常。`eventName = Scan` や他サービスのテーブルへのアクセスは IAM で禁止済みなので、出現すれば権限逸脱か policy 改変を疑い、Config の履歴で policy の変更時刻と変更者を確認する。

### 3.4 証跡の保全

```bash
# CloudTrail log の完全性（digest の署名連鎖）を検証して結果を保存
aws cloudtrail validate-logs --trail-arn "$TRAIL_ARN" \
  --start-time "<start>" --end-time "<end>" > /tmp/$INCIDENT-validate.txt
# 関数コードと設定のスナップショット（侵害関数の version を固定）
aws lambda get-function --function-name "<fn>" --qualifier "<version>" > /tmp/$INCIDENT-fn.json
# DLQ / outbox に残る疑わしいメッセージは dlq-redrive §4.2 の手順で退避（削除しない）
aws s3 cp /tmp/$INCIDENT-* "s3://paas-${ENV}-forensic/${INCIDENT}/" --recursive
```

## 4. 封じ込め

原則：**影響範囲が最小の単位から**、解除可能な手段で、CloudTrail に残る API で行う。自動封じ込め（第21章 21.7）が既に実行済みなら、その内容を ticket に転記し、追加が必要なものだけ行う。

### 4.1 テナント単位の遮断（他テナントへ影響しない）

```bash
# authorizer / PavedApiService の deny list（tenantId または subjectId）に追加
aws dynamodb put-item --table-name "paas-${ENV}-tenant-deny-list" \
  --item '{"pk":{"S":"TENANT#<tenantId>"},"reason":{"S":"'"$INCIDENT"'"},"expiresAt":{"N":"<epoch>"}}'
# WAF：tenant 識別 header × IP の rate-based rule を強化、または IP set に追加（CloudFront の web ACL）
aws wafv2 update-ip-set --scope CLOUDFRONT --id "<ipset-id>" --name paas-blocklist \
  --addresses "<ip>/32" --lock-token "$(aws wafv2 get-ip-set --scope CLOUDFRONT --id <ipset-id> --name paas-blocklist --query LockToken --output text)"
# silo / premium テナントの CMK を無効化（cryptographic erasure 相当。復旧は enable-key）
aws kms disable-key --key-id "<tenant-key-id>"
```

### 4.2 関数単位の停止

```bash
# 同期 API / consumer を止める（reserved concurrency 0 = 全 invocation を throttle）
aws lambda put-function-concurrency --function-name "<fn>" --reserved-concurrent-executions 0
# SQS / Streams consumer の polling を止める（メッセージは queue に残る）
aws lambda update-event-source-mapping --uuid "<esm-uuid>" --no-enabled
# 非同期 invoke の destination / retry を止める
aws lambda delete-function-event-invoke-config --function-name "<fn>"
```

reserved concurrency 0 は他関数の unreserved pool を減らすため、[lambda-concurrency-throttling](lambda-concurrency-throttling.md) の予算を確認する。

### 4.3 資格情報の失効

```bash
# role の既存セッションを無効化（約 30 秒後から。新規 AssumeRole は影響なし）
aws iam put-role-policy --role-name "<role>" --policy-name AWSRevokeOlderSessions \
  --policy-document '{"Version":"2012-10-17","Statement":{"Effect":"Deny","Action":"*","Resource":"*","Condition":{"DateLessThan":{"aws:TokenIssueTime":"'"$(date -u +%FT%TZ)"'"}}}}'
# IAM user の access key（存在してはいけないが、見つけたら）
aws iam update-access-key --user-name "<user>" --access-key-id "<key>" --status Inactive
# Secrets Manager の秘密を即時 rotation
aws secretsmanager rotate-secret --secret-id "<secret-arn>" --rotate-immediately
```

Identity Center のユーザーが主体の場合は、IAM の role を直接編集できないため、(1) SCP の Deny に `userId` を追加、(2) 全 assignment を削除、(3) IdP で無効化、(4) Identity Center コンソールで active session を削除、(5) user を無効化、(6) **Deny を 12 時間以上残す** の順で行う[21-26]。

### 4.4 監査証跡が止められた場合

SCP で禁止しているはずの `StopLogging` / GuardDuty 無効化が起きたら **management account の侵害** を疑う。management account の root / 管理者の MFA と資格情報を最優先で確認し、AWS Support（および契約があれば AWS Security Incident Response）へ即時連絡する。

## 5. 根絶

1. 侵害された関数 version の code / layer / 依存を確認し（GuardDuty の推奨手順[21-39]）、Inspector finding を解消したうえで **pipeline 経由で** 再デプロイする（手動 deploy は禁止、ADR-0020）。code signing を `Enforce` にしていれば署名されていないコードは入らない。
2. 侵害経路に関わる **全資格情報** を交換する：関数 role は新規作成して付け替え、Secrets Manager は rotation、tenant 別 CMK は新しい key に re-encrypt、JWT 署名鍵は IdP で rotation（authorizer の公開鍵キャッシュ最大 2 時間に注意、第13章）。
3. 永続化の痕跡（新規 IAM role / policy、新規 event source mapping、Lambda の環境変数・layer の変更、EventBridge rule、S3 bucket policy）を Config の履歴と CloudTrail で洗い出し、IaC と差分があるものは削除する。
4. 他テナント・他 cell への横展開がないことを、同じ主体・同じ IP・同じ user agent で Athena を再検索して確認する。

## 6. 復旧

1. SLI（第19章の burn rate、p99、DLQ、age）が正常に戻っていることを確認してから、§4 の遮断を **逆順** に解除する：`delete-function-concurrency`、`update-event-source-mapping --enabled`、deny list の削除、`enable-key`、WAF の IP set から除去。解除も CloudTrail に残す。
2. 停止中に溜まったメッセージは [dlq-redrive](dlq-redrive.md) の手順で消化し、欠落イベントは EventBridge archive から replay する（同時 10、`replay-name` で重複排除、第21章 21.2）。
3. データ改ざん・削除があれば PITR で **新テーブル** に復元し、差分を業務的に突合してから切り替える（IAM / alarm / TTL / PITR 設定の再適用を忘れない）。
4. 影響テナントへ連絡する（第19章 顧客連絡）。複数テナントに及ぶ場合はステータスページ。

## 7. エスカレーション

| 状況                                                         | エスカレーション先                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 越境の成功痕跡、`AttackSequence:*`、production role の侵害   | security on-call → CISO 相当 → 法務（契約・規制上の通知義務）                 |
| 共通基盤（control plane、cell router、`@paas/*`）が起点      | platform-team on-call                                                         |
| management account、Log Archive、Security Tooling の侵害疑い | AWS Support（Enterprise）/ AWS Security Incident Response。経営層へ即時       |
| 30 分で主体・範囲が確定しない                                | 封じ込めを「関数単位」から「サービス単位（API stage の throttle 0）」へ拡大   |
| AI エージェント / MicroVM が起点                             | 当該 MicroVM を terminate、Network Connector の security group を deny に変更 |

## 8. post-incident

- blameless post-incident review を 5 営業日以内（第19章）。TTD / triage / TTC / TTR を記録し、第21章の SLO（TD-30）と比較する（M-26）。
- 検出ルール（Config rule、metric filter、EventBridge pattern）、自動封じ込めの条件（TD-32）、game day シナリオ（G9）を更新する。
- 証拠（forensic bucket）の保持期間は TD-31 に従い、ticket に chain-of-custody（取得者・時刻・ARN・hash）を残す。
- 侵入経路が仕様上の弱点（RCP 未適用、data events 未設定など）なら ADR-0026 に反映する。

## 9. 出典

| 記述                                                                                         | 出典（第21章 参考番号）                                                     |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Preparation / Operations / Post-incident の構成、NIST SP 800-61 との整合                     | AWS Security Incident Response Guide [21-62]、NIST SP 800-61 Rev. 3 [21-64] |
| SEC10-BP01〜BP07（要員、計画、forensic、playbook、事前アクセス、事前ツール、simulation）     | Well-Architected Security Pillar [21-61]                                    |
| reserved concurrency 0 で全 invocation を throttle                                           | Lambda reserved concurrency [21-15]                                         |
| `UpdateEventSourceMapping Enabled=false` で polling 停止                                     | Lambda API [21-16]                                                          |
| `AWSRevokeOlderSessions`（`aws:TokenIssueTime`）、約 30 秒後から有効                         | IAM revoke sessions [21-24]                                                 |
| Identity Center の失効手順（SCP Deny → assignment 削除 → session 削除 → 12 時間維持）        | IAM Identity Center [21-26]                                                 |
| 侵害関数の remediation（version 特定、code / layer / Inspector、CloudTrail、trigger 無効化） | GuardDuty [21-39]                                                           |
| GuardDuty finding の EventBridge 配信、finding 保持 90 日                                    | GuardDuty [21-43]                                                           |
| CloudTrail `validate-logs`（SHA-256 + RSA digest）                                           | CloudTrail [21-49]                                                          |
| `userIdentity.sessionIssuer` / `sourceIdentity` / `inScopeOf` / `onBehalfOf`                 | CloudTrail [21-50]                                                          |
| Detective の investigation と finding group                                                  | Detective [21-54]                                                           |
| EventBridge replay（同時 10、`replay-name`）                                                 | EventBridge [21-12]                                                         |
| PITR は新テーブルへ復元                                                                      | DynamoDB [21-13]                                                            |
| incident state document、役割分担                                                            | Google SRE Managing Incidents [21-76]                                       |
| 優先度の閾値（severity ≥ 7、30 分）、deny list の TTL                                        | 既定値（例示値）: TD-30 / TD-32                                             |

`[21-NN]` は [第21章](../microservice-guidelines-resilience-security.md) の参考番号 NN を指す。
