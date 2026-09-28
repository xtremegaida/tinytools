#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, DEFAULT_CONFIG_YAML, CONFIG_FILENAMES } from "./config.js";
import { SKIP_EXPLANATIONS } from "./extract.js";
import { GitError } from "./git.js";
import {
  check,
  extract,
  openRepo,
  orphans,
  pruneOrphans,
  restoreRepo,
  status,
  type EngineContext,
  type ExtractReport,
  type RestoreReport,
} from "./engine.js";
import { StoreError, TOOL_VERSION } from "./store.js";

const USAGE = `sideline ${TOOL_VERSION} — keep code and comment data separate

Usage
  sideline extract [paths...]   Lift comments out of the code into the store
  sideline restore [paths...]   Put the stored comments back into the code
  sideline status               Show the state of every file in the store
  sideline check                Exit non-zero if the store is out of sync
  sideline orphans              List comments that no longer have a home
  sideline init                 Write a default config file

Options
  --all           Scan every file instead of only what git reports as changed
  --dry-run       Report what would happen without writing anything
  --json          Emit machine-readable output
  --no-verify     Skip the round-trip check (not recommended)
  --prune         With 'orphans', delete them from the store
  --config PATH   Use a specific config file
  -h, --help      Show this help
  -v, --version   Show the version
`;

function fail(message: string): never {
  process.stderr.write(`sideline: ${message}\n`);
  process.exit(1);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function reportSkipped(skipped: { path: string; reason: keyof typeof SKIP_EXPLANATIONS }[]): void {
  if (skipped.length === 0) return;
  process.stdout.write(`\n${plural(skipped.length, "file")} skipped:\n`);
  for (const s of skipped) {
    process.stdout.write(`  ${s.path}\n    ${SKIP_EXPLANATIONS[s.reason]}\n`);
  }
}

function printExtract(report: ExtractReport, dryRun: boolean): void {
  const mode = report.fullScan ? "full scan" : "incremental";
  const verb = dryRun ? "would rewrite" : "rewritten";

  process.stdout.write(`Scanned ${plural(report.scanned, "file")} (${mode}).\n`);
  process.stdout.write(
    `  ${report.rewritten.length} ${verb}, ${report.unchanged} unchanged\n`,
  );
  process.stdout.write(
    `  ${plural(report.added, "comment")} extracted, ${report.updated} updated`,
  );
  if (report.removed > 0) process.stdout.write(`, ${report.removed} removed`);
  process.stdout.write("\n");

  if (report.reanchored > 0) {
    process.stdout.write(`  ${plural(report.reanchored, "comment")} re-anchored\n`);
  }
  if (report.retained > 0) {
    process.stdout.write(
      `  ${plural(report.retained, "comment")} kept from code edited while extracted\n`,
    );
  }
  if (report.orphaned > 0) {
    process.stdout.write(
      `  ${plural(report.orphaned, "comment")} orphaned — run 'sideline orphans' to review\n`,
    );
  }
  for (const r of report.renamed) {
    process.stdout.write(`  moved: ${r.from} -> ${r.to}\n`);
  }
  for (const f of report.orphanedFiles) {
    process.stdout.write(`  file gone: ${f} (its comments are retained)\n`);
  }

  reportSkipped(report.skipped);
}

function printRestore(report: RestoreReport, dryRun: boolean): void {
  const verb = dryRun ? "would rewrite" : "rewritten";
  process.stdout.write(`Scanned ${plural(report.scanned, "file")}.\n`);
  process.stdout.write(
    `  ${report.rewritten.length} ${verb}, ${report.unchanged} unchanged\n`,
  );
  process.stdout.write(`  ${plural(report.placed, "comment")} placed\n`);
  if (report.reanchored > 0) {
    process.stdout.write(`  ${plural(report.reanchored, "comment")} re-anchored\n`);
  }
  if (report.orphaned > 0) {
    process.stdout.write(
      `  ${plural(report.orphaned, "comment")} could not be placed and stay in the store\n`,
    );
  }
  for (const m of report.missing) {
    process.stdout.write(`  missing from disk: ${m}\n`);
  }
  reportSkipped(report.skipped);
}

function cmdInit(cwd: string): number {
  const target = path.join(cwd, CONFIG_FILENAMES[0]!);
  if (fs.existsSync(target)) {
    process.stdout.write(`${CONFIG_FILENAMES[0]} already exists; leaving it alone.\n`);
    return 0;
  }
  fs.writeFileSync(target, DEFAULT_CONFIG_YAML, "utf8");
  process.stdout.write(`Wrote ${CONFIG_FILENAMES[0]}.\n`);
  return 0;
}

function cmdStatus(ctx: EngineContext, json: boolean): number {
  const rows = status(ctx);
  if (json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write("The store is empty. Run 'sideline extract' to populate it.\n");
    return 0;
  }

  const width = Math.max(...rows.map((r) => r.path.length));
  for (const r of rows) {
    const orphanNote = r.orphans > 0 ? `  (${r.orphans} orphaned)` : "";
    process.stdout.write(
      `${r.path.padEnd(width)}  ${r.health.padEnd(9)}  ${plural(r.comments, "comment")}${orphanNote}\n`,
    );
  }
  return 0;
}

function cmdCheck(ctx: EngineContext, json: boolean): number {
  const result = check(ctx);
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.inSync ? 0 : 2;
  }

  if (result.inSync) {
    process.stdout.write("Store is in sync.\n");
    return 0;
  }

  process.stdout.write("Store is out of sync.\n");
  for (const p of result.restored) process.stdout.write(`  has comments: ${p}\n`);
  for (const p of result.drifted) process.stdout.write(`  drifted:      ${p}\n`);
  for (const p of result.missing) process.stdout.write(`  missing:      ${p}\n`);
  for (const p of result.unextracted) process.stdout.write(`  unextracted:  ${p}\n`);
  process.stdout.write("\nRun 'sideline extract' to bring it back in line.\n");
  return 2;
}

function cmdOrphans(ctx: EngineContext, json: boolean, prune: boolean, dryRun: boolean): number {
  const list = orphans(ctx);

  if (prune) {
    const removed = pruneOrphans(ctx, dryRun);
    process.stdout.write(
      `${dryRun ? "Would delete" : "Deleted"} ${plural(removed, "orphaned comment")}.\n`,
    );
    return 0;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    return 0;
  }
  if (list.length === 0) {
    process.stdout.write("No orphaned comments.\n");
    return 0;
  }

  process.stdout.write(`${plural(list.length, "orphaned comment")}:\n\n`);
  for (const o of list) {
    process.stdout.write(`  ${o.id}  ${o.path}  (${o.reason})\n`);
    for (const line of o.text.split("\n")) process.stdout.write(`      ${line}\n`);
    process.stdout.write("\n");
  }
  process.stdout.write("Use 'sideline orphans --prune' to delete them.\n");
  return 0;
}

export function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        all: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        verify: { type: "boolean", default: true },
        prune: { type: "boolean", default: false },
        config: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err) {
    fail((err as Error).message);
  }

  const { values, positionals } = parsed;

  if (values.version) {
    process.stdout.write(`${TOOL_VERSION}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return positionals.length === 0 && !values.help ? 1 : 0;
  }

  const command = positionals[0]!;
  const paths = positionals.slice(1);
  const cwd = process.cwd();

  if (command === "init") return cmdInit(cwd);

  const ctx = openRepo(cwd, values.config);
  const options = {
    all: values.all,
    dryRun: values["dry-run"],
    verify: values.verify,
    paths,
  };

  switch (command) {
    case "extract":
      printExtract(extract(ctx, options), options.dryRun);
      return 0;
    case "restore":
      printRestore(restoreRepo(ctx, options), options.dryRun);
      return 0;
    case "status":
      return cmdStatus(ctx, values.json);
    case "check":
      return cmdCheck(ctx, values.json);
    case "orphans":
      return cmdOrphans(ctx, values.json, values.prune, options.dryRun);
    default:
      fail(`unknown command '${command}'. Run 'sideline --help'.`);
  }
}

const isDirectRun = process.argv[1] !== undefined;
if (isDirectRun) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ConfigError || err instanceof StoreError || err instanceof GitError) {
      fail(err.message);
    }
    throw err;
  }
}
