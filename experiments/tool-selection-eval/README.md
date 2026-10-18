# rea-tool-eval

Measures which REA MCP tool an agent picks FIRST for a natural-language task. Tools are never executed.

## Setup

```bash
npm install            # pins rea-agents as a devDependency for reproducible runs
export ANTHROPIC_API_KEY=...
```

## Audit (no API key)

```bash
REA_MCP_CMD="node node_modules/rea-agents/scripts/rea.mjs mcp" npx tsx run.ts --audit
```

Prints tool count, approximate token cost, largest definitions, and the most similar description pairs.

## Eval

```bash
REA_MCP_CMD="node node_modules/rea-agents/scripts/rea.mjs mcp" \
  npx tsx run.ts --fixtures fixtures.example.json --trials 3 --out report.json
```

Flags: `--model`, `--trials`, `--concurrency`, `--choice any|auto`, `--temperature`,
`--catalog subset|full`, `--subset-size N`, `--force`.

## Fixture format

```json
{
  "id": "wasm-01",
  "prompt": "...",
  "expected": ["inspect_wasm_artifact"],
  "tags": ["static"]
}
```

`expected` is any-of: every listed tool counts as a correct first call. Expected names are checked
against the live catalog, so a renamed tool fails loudly instead of silently scoring 0%.

## Design notes and limitations

- First-call only. Tasks that legitimately start with a session/setup tool must list it in `expected`.
- `subset` mode presents expected tools + their 4 nearest-neighbour tools (by description similarity) + deterministic filler.
  The full catalog is ~195K estimated tokens, which is why `full` refuses to run without `--force`.
  Subset accuracy is an upper bound on full-catalog accuracy.
- `--choice any` forces a tool call (pure selection). `auto` also counts "answered without a tool" as a miss.
- Token estimates use chars/4, not a tokenizer.
- Results are nondeterministic; use `--trials` and compare pass rates, not single runs.
