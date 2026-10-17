# ADR-0013: Event envelope and versioning

- Status: accepted
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0011, ADR-0012, ADR-0014, ADR-0015

## Context

ADR-0011 でサービス間連携の既定を EventBridge + SQS とした。イベントの形式を統一しないと、consumer ごとに `tenantId` や相関 ID の取り出し方が異なり、冪等性（ADR-0014）とトレーサビリティ（ADR-0015）を共通ライブラリで保証できない。また、PII や巨大 payload をイベントに載せると、EventBridge archive、DLQ、ログに秘密情報が残留する。

CloudEvents 1.0（v1.0.2）は、必須属性として `id`（producer 内で一意、非空文字列）、`source`（非空 URI-reference）、`specversion`（`"1.0"`）、`type`（非空文字列、reverse-DNS 接頭辞を SHOULD）を、任意属性として `datacontenttype`（RFC 2046）、`dataschema`（URI）、`subject`、`time`（RFC 3339）を定義し、任意個の extension context attribute を標準属性と同じ命名規則・型体系で追加できると規定する。[^80]

X-Ray はサンプリングされ[^60]、EventBridge は PutEvents 時に trace header が渡された場合だけ target へ伝播し[^43]、archive からの replay では `replay-name` field が付加される一方で元の trace header は保持されない。[^78][^43] そのため `correlationId`、`eventId`、`causationId` をイベント payload の正式なメタデータとして保存し、トレースとは独立して検索可能にする必要がある。

EventBridge Schema Registry は OpenAPI 3 と JSONSchema Draft4 の 2 形式に対応し、イベントからの schema 推論とコードバインディングの生成ができる。[^79] AWS Prescriptive Guidance の transactional outbox は consumer の冪等性と、イベント順序の保持を要求している。[^86]

`@paas/event-contracts` がこの envelope の型と zod schema、`schemas/events/` の JSON Schema を提供し、`apps/example-order-service` の outbox relay と `apps/example-worker-service` の consumer が共有する。

## Decision

準拠: CloudEvents Specification v1.0.2[^80]、Amazon EventBridge User Guide（schema registry、archive / replay、X-Ray 連携）[^79][^78][^43]、ULID 仕様[^81]、Martin Fowler「Tolerant Reader」[^82]、Danilo Sato「ParallelChange」（expand / contract）[^83]、AWS Prescriptive Guidance「Transactional outbox」[^86]

**CloudEvents 1.0 の必須属性に本 PaaS の extension attribute を加えた envelope を全サービス間イベントの標準とする。**

```json
{
  "specversion": "1.0",
  "id": "event-id",
  "type": "order.created.v1",
  "source": "order-service",
  "time": "2026-10-17T00:00:00Z",
  "tenantId": "tenant-id",
  "correlationId": "business-flow-id",
  "causationId": "parent-command-or-event-id",
  "subject": "order/order-id",
  "datacontenttype": "application/json",
  "data": {}
}
```

| 属性              | 規則                                                                                                                                        | 根拠                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `specversion`     | 常に `"1.0"`                                                                                                                                | CloudEvents 必須属性[^80]                                                                                                                                                                                                                                                     |
| `id`              | ULID（128 bit、48 bit timestamp + 80 bit randomness、26 文字、辞書順ソート可）。[^81] consumer の冪等キー（`eventId`）として使う            | CloudEvents 必須属性、producer 内で一意[^80]                                                                                                                                                                                                                                  |
| `type`            | `<aggregate>.<pastTenseVerb>.v<N>`。過去形の事実。command と混同しない                                                                      | CloudEvents 必須属性。[^80] reverse-DNS 接頭辞（SHOULD）は EventBridge `detail-type` の可読性のため意図的に省略する。これは仕様の SHOULD からの逸脱であり、外部連携時は `source` と組み合わせて一意性を担保する                                                               |
| `source`          | 発行サービスの `serviceId`（URI-reference として有効な文字列）                                                                              | CloudEvents 必須属性[^80]                                                                                                                                                                                                                                                     |
| `time`            | RFC 3339 UTC。発行時刻（DB commit 時刻）                                                                                                    | CloudEvents 任意属性[^80]                                                                                                                                                                                                                                                     |
| `tenantId`        | `ExecutionContext.tenantId`。必須。EventBridge rule の filter と consumer の tenant context 復元に使う                                      | extension attribute[^80]                                                                                                                                                                                                                                                      |
| `correlationId`   | 業務フロー ID。入口 API で生成または検証したものを伝播                                                                                      | extension attribute。[^80] replay で trace が切れるため payload に保持[^78][^43]                                                                                                                                                                                              |
| `causationId`     | 当該イベントを起こした command / event の ID                                                                                                | extension attribute[^80]                                                                                                                                                                                                                                                      |
| `subject`         | `<resourceType>/<resourceId>`                                                                                                               | CloudEvents 任意属性[^80]                                                                                                                                                                                                                                                     |
| `datacontenttype` | `application/json`                                                                                                                          | CloudEvents 任意属性（RFC 2046）[^80]                                                                                                                                                                                                                                         |
| `data`            | `type` ごとの JSON Schema に従う。PII・秘密・1 MB 超 payload 禁止。大きなデータは S3 object reference（`{ bucket, key, versionId }`）を渡す | EventBridge PutEvents は 1 リクエスト最大 10 entries・合計 1 MB（1,048,576 bytes）未満で、1 MB 超は S3 参照を推奨している（確認日 2026-10-17）[^v1]。本テンプレートの 1 MB 上限は envelope 込みでこの範囲に収め、batch 送信時は合計が 1 MB を超えないよう producer が分割する |

CloudEvents 準拠範囲: 必須属性と上記任意属性を採用し、`tenantId`, `correlationId`, `causationId` は extension context attribute として扱う。binary content mode と CloudEvents の HTTP / Kafka protocol binding は採用しない。EventBridge の `detail-type` には `type` を、`detail` には envelope 全体を置く。

versioning 規則:

- `type` の末尾 `v<N>` を major version とする。後方互換な追加（optional field 追加）は version を変えない。
- 破壊的変更（field 削除、型変更、意味変更）は新 `type`（`order.created.v2`）を発行し、producer は移行期間中 v1 と v2 の **両方を発行** する（expand）。consumer を v2 へ移し（migrate）、v1 の consumer がゼロになったことを EventBridge rule の一覧と metric で確認してから v1 発行を止める（contract）。[^83]
- consumer は未知の field を無視する（Tolerant Reader: 必要な要素だけを取り、それ以外は無視する）。[^82]
- 移行期間は最長 6 か月とする（既定値（例示値）: 6 か月。consumer の月次リリースサイクルを複数回含み、archive の replay 対象期間が 2 倍に膨らまない長さとして置いた設計判断で、外部出典に基づかない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-11、consumer の移行実績で見直す）。）
- schema は `schemas/events/<type>.json` に **JSON Schema Draft4 互換** で置き、EventBridge Schema Registry へ CI から登録する。Registry は Draft4 と OpenAPI 3 のみ対応するため[^79]、Draft 2020-12 固有のキーワードは使わない。

## Alternatives

### A. 独自 envelope（CloudEvents 非準拠）

- 長所: 属性名を自由に決められる。
- 短所: 外部システム連携や他の event broker への移行時に変換が必要。CloudEvents は extension attribute を許容しており[^80]、準拠コストは低い。

### B. CloudEvents 完全準拠（binary mode、全 protocol binding、`dataschema`、`data_base64` を含む）

- 長所: 仕様との互換性が最大。[^80]
- 短所: EventBridge は structured mode の JSON しか扱わないため、binary mode と各 binding は実装コストだけが生じる。必要になった時点で拡張する。

### C. versioning を `data.schemaVersion` field で行う（`type` は固定）

- 長所: EventBridge rule を version ごとに増やさなくて済む。
- 短所: rule の filter で version を選べず、consumer が旧 version の payload を誤って処理する事故を防ぎにくい。`type` 末尾での major versioning を採用する。

## Consequences

- **費用**: 移行期間中の二重発行で EventBridge の PutEvents が一時的に倍になる。
- **性能**: envelope のメタデータ分が各イベントに加わるが、無視できる見込み（計測で確定: 平均イベントサイズと envelope の比率を `tests/performance/burst-isolation/` の投入イベントで記録する。docs/decision/template-defaults.md#計測で確定する項目 M-15、現在は未計測）。
- **運用**: schema registry と互換性テストが CI に加わる。DLQ のメッセージからも `tenantId` と `correlationId` で検索できるため、redrive 時の診断が速くなる。replay されたイベントは `replay-name` で識別できる。[^78]
- **Lock-in**: CloudEvents 準拠により EventBridge 以外（SNS、Kafka、外部 webhook）へも同じ envelope を使える。[^80]
- **移行**: 既存イベントを本 envelope へ移す際は、relay 層で wrap し v1 として扱う。

## Evidence

- CloudEvents v1.0.2 の必須 / 任意 / extension 属性の定義。[^80]
- EventBridge と X-Ray: trace header は PutEvents 時に渡された場合のみ伝播。[^43] archive replay では `replay-name` が付加される。[^78]
- X-Ray の既定サンプリングは毎秒 1 リクエスト + 追加分の 5%。[^60]
- EventBridge Schema Registry の対応形式（OpenAPI 3 / JSONSchema Draft4）。[^79]
- 受入基準「API → ... → Step Functions を `correlationId` で全件検索できる」を `tests/integration/correlation-search/` で検証する。`POST /orders` から発行された `order.created.v1` が worker の SQS、DLQ、Step Functions 入力まで同じ `correlationId` を持つことを CloudWatch Logs Insights クエリで確認する。
- `tests/contract/events/` で、`schemas/events/` の全 schema に対し、過去 version との後方互換性（optional field 追加のみ）を `@paas/testing` の schema diff で検証する。

## Compliance / How it is enforced

- `@paas/event-contracts` の `createEvent()` だけが envelope を生成でき、`tenantId` と `correlationId` を `ExecutionContext` から自動付与する。`id` は ULID で生成する。[^81] 手書きの `PutEvents` 呼び出しは eslint ルール `paas/no-raw-put-events`（未実装・予定。現状は `EventSubscription` が service.yaml の consumedEvents と照合） で禁止する。
- `createEvent()` が zod schema で `data` を検証し、`type` が `schemas/events/` に存在しない場合は例外を投げる。PII 検出（email、電話番号パターン）は `@paas/observability` の redaction と同じ allowlist で警告する。
- `EventSubscription` Construct は `type` と `tenantId` の filter を必須プロパティとし、`detail-type` の prefix match を禁止する。
- CI の `contract` ステップで `schemas/events/` の JSON Schema（Draft4 互換）を EventBridge Schema Registry へ登録し[^79]、既存 version との breaking change を検出したら失敗させる。
- `PavedQueueConsumer` の Powertools `BatchProcessor` 用 preset が envelope を parse し、`ExecutionContext` を復元してから handler を呼ぶ。envelope 違反メッセージは即 DLQ へ送る。

## 参考

[^43]: [Amazon EventBridge integration with AWS X-Ray](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-related-service-xray.html)（指針書 References より）

[^60]: [Configuring sampling rules (AWS X-Ray)](https://docs.aws.amazon.com/xray/latest/devguide/xray-console-sampling.html)（参照日 2026-10-17）

[^78]: [Archiving and replaying events in Amazon EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-archive.html)（参照日 2026-10-17）

[^79]: [Amazon EventBridge schemas](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-schema.html)（参照日 2026-10-17）

[^80]: [CloudEvents Specification v1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md)（参照日 2026-10-17）

[^81]: [ULID Specification (GitHub)](https://github.com/ulid/spec)（参照日 2026-10-17）

[^82]: [Tolerant Reader - Martin Fowler (2011-05-09)](https://martinfowler.com/bliki/TolerantReader.html)（参照日 2026-10-17）

[^83]: [ParallelChange (expand / contract) - Danilo Sato, martinfowler.com (2014-05-13)](https://martinfowler.com/bliki/ParallelChange.html)（参照日 2026-10-17）

[^86]: [Transactional outbox pattern (AWS Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)（参照日 2026-10-17）

[^v1]: [Sending events with PutEvents in Amazon EventBridge - Calculating PutEvents event entry size](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-putevents.html#eb-putevent-size)（参照日 2026-10-17。「you can batch up to 10 event entries into one request」「The total request size ... must be less than 1 MB (1,048,576 bytes)」「If the entry size is larger than 1 MB ... we recommend uploading the event to an Amazon S3 bucket」）
