#!/usr/bin/env -S npx tsx
/**
 * Tool-selection eval for REA's MCP catalog.
 *
 *   npx tsx run.ts --audit                       # catalog size + similar-description pairs (no API key)
 *   npx tsx run.ts --fixtures fixtures.json      # run the eval (needs ANTHROPIC_API_KEY)
 *
 * Measures only the FIRST tool an agent picks for a task. Tools are never executed.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";

// ---------- fixtures ----------

const TaskSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(10),
  /** Any tool in this list counts as a correct first call. */
  expected: z.array(z.string().min(1)).min(1),
  tags: z.array(z.string()).default([]),
});

const FixtureSchema = z
  .array(TaskSchema)
  .min(1)
  .superRefine((tasks, ctx) => {
    const seen = new Set<string>();
    tasks.forEach((t, i) => {
      if (seen.has(t.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate id "${t.id}"`,
          path: [i, "id"],
        });
      }
      seen.add(t.id);
    });
  });

type Task = z.infer<typeof TaskSchema>;

// ---------- CLI ----------

const { values: args } = parseArgs({
  options: {
    fixtures: { type: "string", default: "fixtures.example.json" },
    out: { type: "string", default: "report.json" },
    model: {
      type: "string",
      default: process.env.EVAL_MODEL ?? "claude-sonnet-5-5",
    },
    trials: { type: "string", default: "3" },
    concurrency: { type: "string", default: "4" },
    // "any" forces a tool call (pure selection); "auto" lets the model answer in text instead.
    choice: { type: "string", default: "any" },
    temperature: { type: "string", default: "0" },
    audit: { type: "boolean", default: false },
    // "subset" (default) = expected tools + nearest-neighbour distractors + filler; "full" = whole catalog.
    catalog: { type: "string", default: "subset" },
    "subset-size": { type: "string", default: "60" },
    // Allow requests whose tool definitions exceed ~150K estimated tokens.
    force: { type: "boolean", default: false },
  },
});

const SYSTEM =
  "You are an agent with reverse-engineering tools. For the user's task, call the single tool " +
  "you would use FIRST. Do not explain.";

// ---------- catalog ----------

type McpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

async function loadCatalog(): Promise<McpTool[]> {
  const [command, ...cmdArgs] = (
    process.env.REA_MCP_CMD ?? "npx -y rea-agents@latest mcp"
  ).split(" ");
  const client = new Client({ name: "rea-tool-eval", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({ command: command!, args: cmdArgs }),
  );
  try {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    await client.close();
  }
}

function catalogStats(tools: McpTool[]) {
  const rows = tools.map((t) => ({
    name: t.name,
    descChars: t.description?.length ?? 0,
    schemaChars: JSON.stringify(t.inputSchema).length,
  }));
  const totalChars = rows.reduce((s, r) => s + r.descChars + r.schemaChars, 0);
  // ~4 chars/token is a rough heuristic, not a tokenizer.
  return {
    toolCount: rows.length,
    totalChars,
    approxTokens: Math.round(totalChars / 4),
    rows,
  };
}

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );

/** Cheap heuristic: word-set Jaccard on descriptions. Surfaces candidates, not verdicts. */
function similarPairs(tools: McpTool[], top = 10) {
  const sets = tools.map((t) => words(t.description ?? ""));
  const pairs: { a: string; b: string; jaccard: number }[] = [];
  for (let i = 0; i < tools.length; i++) {
    for (let j = i + 1; j < tools.length; j++) {
      const inter = [...sets[i]!].filter((w) => sets[j]!.has(w)).length;
      const union = sets[i]!.size + sets[j]!.size - inter;
      if (union > 0)
        pairs.push({
          a: tools[i]!.name,
          b: tools[j]!.name,
          jaccard: inter / union,
        });
    }
  }
  return pairs.sort((x, y) => y.jaccard - x.jaccard).slice(0, top);
}

const fnv = (s: string) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};

/** Nearest tools by description similarity: the distractors most likely to cause a wrong pick. */
function neighbours(name: string, tools: McpTool[], k: number): string[] {
  const self = tools.find((t) => t.name === name);
  if (!self) return [];
  const a = words(self.description ?? "");
  return tools
    .filter((t) => t.name !== name)
    .map((t) => {
      const b = words(t.description ?? "");
      const inter = [...a].filter((w) => b.has(w)).length;
      return { name: t.name, score: inter / (a.size + b.size - inter || 1) };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, k)
    .map((x) => x.name);
}

/** Deterministic (no RNG) so runs are comparable across machines and over time. */
function selectCatalog(all: McpTool[], tasks: Task[]): McpTool[] {
  if (args.catalog === "full") return all;
  const target = Number(args["subset-size"]);
  const chosen = new Set(tasks.flatMap((t) => t.expected));
  for (const name of [...chosen])
    neighbours(name, all, 4).forEach((n) => chosen.add(n));
  const filler = all
    .map((t) => t.name)
    .filter((n) => !chosen.has(n))
    .sort((a, b) => fnv(a) - fnv(b));
  for (const n of filler) {
    if (chosen.size >= target) break;
    chosen.add(n);
  }
  return all.filter((t) => chosen.has(t.name));
}

// ---------- eval ----------

function toAnthropicTools(tools: McpTool[]): Anthropic.Tool[] {
  const mapped: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
  // Cache the (large) tool block across requests to cut cost and latency.
  const last = mapped.length - 1;
  mapped[last] = { ...mapped[last]!, cache_control: { type: "ephemeral" } };
  return mapped;
}

async function runTrial(
  client: Anthropic,
  tools: Anthropic.Tool[],
  task: Task,
): Promise<string> {
  const res = await client.messages.create({
    model: args.model!,
    max_tokens: 512,
    temperature: Number(args.temperature),
    system: SYSTEM,
    tools,
    tool_choice: args.choice === "auto" ? { type: "auto" } : { type: "any" },
    messages: [{ role: "user", content: task.prompt }],
  });
  const use = res.content.find((b) => b.type === "tool_use");
  return use?.type === "tool_use" ? use.name : "<none>";
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift())
        await fn(item);
    }),
  );
}

async function main() {
  const catalog = await loadCatalog();
  const stats = catalogStats(catalog);

  if (args.audit) {
    console.log(
      `tools: ${stats.toolCount}  chars: ${stats.totalChars}  ~tokens: ${stats.approxTokens}`,
    );
    console.log("\nlargest definitions:");
    console.table(
      [...stats.rows]
        .sort(
          (a, b) => b.schemaChars + b.descChars - a.schemaChars - a.descChars,
        )
        .slice(0, 15),
    );
    console.log("\nmost similar descriptions (candidates only):");
    console.table(similarPairs(catalog));
    console.log(
      "\nall tool names:\n" +
        catalog
          .map((t) => t.name)
          .sort()
          .join("\n"),
    );
    return;
  }

  const tasks = FixtureSchema.parse(
    JSON.parse(await readFile(args.fixtures!, "utf8")),
  );
  const known = new Set(catalog.map((t) => t.name));
  const unknown = tasks.flatMap((t) =>
    t.expected.filter((e) => !known.has(e)).map((e) => `${t.id}: ${e}`),
  );
  if (unknown.length) {
    throw new Error(
      `Fixtures reference tools missing from the live catalog:\n  ${unknown.join("\n  ")}`,
    );
  }

  const evalCatalog = selectCatalog(catalog, tasks);
  const evalStats = catalogStats(evalCatalog);
  console.log(
    `catalog mode: ${args.catalog} (${evalStats.toolCount}/${stats.toolCount} tools, ~${evalStats.approxTokens} tokens)`,
  );
  if (evalStats.approxTokens > 150_000 && !args.force) {
    throw new Error(
      `Tool definitions are ~${evalStats.approxTokens} tokens, likely beyond the model context. ` +
        `Use --catalog subset (default) or pass --force.`,
    );
  }

  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY; SDK retries 429/5xx by default
  const tools = toAnthropicTools(evalCatalog);
  const trials = Number(args.trials);
  const results: {
    id: string;
    expected: string[];
    tags: string[];
    picks: string[];
    passRate: number;
  }[] = [];

  await pool(tasks, Number(args.concurrency), async (task) => {
    const picks: string[] = [];
    for (let i = 0; i < trials; i++)
      picks.push(await runTrial(anthropic, tools, task));
    const passRate =
      picks.filter((p) => task.expected.includes(p)).length / trials;
    results.push({
      id: task.id,
      expected: task.expected,
      tags: task.tags,
      picks,
      passRate,
    });
    console.log(
      `${passRate === 1 ? "PASS" : passRate === 0 ? "FAIL" : "FLAKY"}  ${task.id}  -> ${picks.join(", ")}`,
    );
  });

  const confusion = new Map<string, number>();
  for (const r of results) {
    for (const p of r.picks) {
      if (!r.expected.includes(p)) {
        const key = `${r.expected[0]} -> ${p}`;
        confusion.set(key, (confusion.get(key) ?? 0) + 1);
      }
    }
  }

  const accuracy = results.reduce((s, r) => s + r.passRate, 0) / results.length;
  console.log(
    `\naccuracy: ${(accuracy * 100).toFixed(1)}% over ${results.length} tasks x ${trials} trials`,
  );
  console.log("most common confusions:");
  console.table(
    [...confusion]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([pair, count]) => ({ pair, count })),
  );

  await writeFile(
    args.out!,
    JSON.stringify(
      {
        model: args.model,
        choice: args.choice,
        trials,
        date: new Date().toISOString(),
        catalog: {
          mode: args.catalog,
          liveToolCount: stats.toolCount,
          presentedToolCount: evalStats.toolCount,
          approxTokens: evalStats.approxTokens,
        },
        accuracy,
        results: results.sort((a, b) => a.id.localeCompare(b.id)),
        confusions: Object.fromEntries(confusion),
      },
      null,
      2,
    ),
  );
  console.log(`report written to ${args.out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
