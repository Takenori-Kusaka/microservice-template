# schemas/ — 契約の正本

| ディレクトリ | 正本                                                   | 生成物                                                              | CI ゲート                                                                                          |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `openapi/`   | OpenAPI 3.1（手書き）                                  | `packages/api-contracts/src/generated/*.ts`（openapi-typescript）   | `pnpm schemas:check`、`tests/contract/openapi-compatibility.test.ts`（major 内の破壊的変更を検出） |
| `events/`    | `packages/event-contracts/src/events/*.ts` の zod 定義 | `events/<type>.json`（JSON Schema draft 2020-12、`z.toJSONSchema`） | `pnpm schemas:check`、`tests/contract/event-schemas.test.ts`                                       |

## 既知の制約（確認日 2026-10-17）

- **EventBridge Schema Registry は OpenAPI 3.0 と JSON Schema Draft4 のみ対応**（[Amazon EventBridge schemas](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-schema.html)）。`events/*.json` は draft 2020-12 で生成しているため、Registry へ登録する場合は Draft4 互換へ変換する（`const` → `enum`、`$schema` の差し替え）。zod 4 の `z.toJSONSchema` は `draft-7` / `draft-2020-12` / `openapi-3.0` のみを target にできるため、変換ステップは `tools/` に追加予定（未実装）。
- CloudEvents 1.0.2 の `type` は reverse-DNS 接頭辞が SHOULD だが、本テンプレートは `order.created.v1` 形式を採用している（ADR-0013 に意図的逸脱として記録）。
