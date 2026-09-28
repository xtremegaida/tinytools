import { afterEach, describe, expect, it } from "vitest";
import { check, extract, openRepo, restoreRepo, status } from "../src/engine.js";
import { cleanup, makeRepo, read, writeFiles } from "./helpers/repo.js";

const SOURCE = {
  "src/service.ts": [
    "// Header note about this module.",
    "",
    "import { client } from './client';",
    "",
    "export class Service {",
    "  // Retry because the upstream API is flaky.",
    "  // See ticket OPS-1423.",
    "  async fetch(id: string) {",
    "    const url = `/items/${id}`; // interpolated on purpose",
    "",
    "    /* block comment",
    "       across lines */",
    "    return client.get(url);",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/Model.cs": [
    "namespace App;",
    "",
    "public class Model",
    "{",
    "    /// <summary>The identifier.</summary>",
    "    public int Id { get; set; }",
    "",
    "    // @ts-nonsense is not a pragma in C#",
    "    public string Name { get; set; } = @\"a // b\";",
    "}",
    "",
  ].join("\n"),
};

const dirs: string[] = [];

function repo(files = SOURCE): string {
  const dir = makeRepo(files);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

describe("forward / reverse / forward", () => {
  it("returns to exactly the first-run state", () => {
    const dir = repo();

    extract(openRepo(dir));
    const storeAfterFirst = read(dir, "sideline.yaml");
    const strippedTs = read(dir, "src/service.ts");
    const strippedCs = read(dir, "src/Model.cs");

    // Comments are gone from the code but recorded in the store.
    expect(strippedTs).not.toContain("Retry because");
    expect(storeAfterFirst).toContain("Retry because");

    restoreRepo(openRepo(dir));
    expect(read(dir, "src/service.ts")).toBe(SOURCE["src/service.ts"]);
    expect(read(dir, "src/Model.cs")).toBe(SOURCE["src/Model.cs"]);

    extract(openRepo(dir));
    expect(read(dir, "src/service.ts")).toBe(strippedTs);
    expect(read(dir, "src/Model.cs")).toBe(strippedCs);
    expect(read(dir, "sideline.yaml")).toBe(storeAfterFirst);
  });

  it("survives several cycles unchanged", () => {
    const dir = repo();

    extract(openRepo(dir));
    const store = read(dir, "sideline.yaml");
    const stripped = read(dir, "src/service.ts");

    for (let i = 0; i < 3; i++) {
      restoreRepo(openRepo(dir));
      expect(read(dir, "src/service.ts")).toBe(SOURCE["src/service.ts"]);
      extract(openRepo(dir));
      expect(read(dir, "src/service.ts")).toBe(stripped);
      expect(read(dir, "sideline.yaml")).toBe(store);
    }
  });

  it("treats a second extract on extracted code as a no-op", () => {
    const dir = repo();

    extract(openRepo(dir));
    const store = read(dir, "sideline.yaml");

    const report = extract(openRepo(dir));
    expect(report.rewritten).toEqual([]);
    expect(report.removed).toBe(0);
    expect(report.orphaned).toBe(0);
    expect(read(dir, "sideline.yaml")).toBe(store);
  });

  it("treats a second restore on restored code as a no-op", () => {
    const dir = repo();

    extract(openRepo(dir));
    restoreRepo(openRepo(dir));
    const store = read(dir, "sideline.yaml");

    const report = restoreRepo(openRepo(dir));
    expect(report.rewritten).toEqual([]);
    expect(read(dir, "sideline.yaml")).toBe(store);
    expect(read(dir, "src/service.ts")).toBe(SOURCE["src/service.ts"]);
  });
});

describe("edits between runs", () => {
  it("deletes a record when the comment is removed from restored code", () => {
    const dir = repo();

    extract(openRepo(dir));
    restoreRepo(openRepo(dir));

    const edited = SOURCE["src/service.ts"].replace("  // See ticket OPS-1423.\n", "");
    writeFiles(dir, { "src/service.ts": edited });

    const report = extract(openRepo(dir));
    expect(report.removed).toBeGreaterThan(0);
    expect(read(dir, "sideline.yaml")).not.toContain("OPS-1423");
  });

  it("keeps records when code is edited while extracted", () => {
    const dir = repo();

    extract(openRepo(dir));
    const stripped = read(dir, "src/service.ts");

    // Add a line of code, with no comments anywhere.
    const edited = stripped.replace(
      "    return client.get(url);",
      "    const t = Date.now();\n    return client.get(url);",
    );
    writeFiles(dir, { "src/service.ts": edited });

    const report = extract(openRepo(dir));
    expect(report.removed).toBe(0);
    expect(report.retained).toBeGreaterThan(0);
    expect(read(dir, "sideline.yaml")).toContain("OPS-1423");

    // Everything still goes back where it belongs.
    restoreRepo(openRepo(dir));
    const restored = read(dir, "src/service.ts");
    expect(restored).toContain("// Retry because the upstream API is flaky.");
    expect(restored).toContain("const t = Date.now();");
  });

  it("picks up a comment added to already-extracted code", () => {
    const dir = repo();

    extract(openRepo(dir));
    const stripped = read(dir, "src/service.ts");
    writeFiles(dir, {
      "src/service.ts": stripped.replace(
        "    return client.get(url);",
        "    // brand new thought\n    return client.get(url);",
      ),
    });

    const report = extract(openRepo(dir));
    expect(report.added).toBe(1);
    expect(report.removed).toBe(0);
    expect(read(dir, "sideline.yaml")).toContain("brand new thought");
    expect(read(dir, "sideline.yaml")).toContain("OPS-1423");
  });

  it("re-anchors a comment when the code above it is deleted", () => {
    const dir = repo();

    extract(openRepo(dir));
    const stripped = read(dir, "src/service.ts");
    writeFiles(dir, {
      "src/service.ts": stripped.replace("import { client } from './client';\n", ""),
    });

    extract(openRepo(dir));
    restoreRepo(openRepo(dir));
    expect(read(dir, "src/service.ts")).toContain("// Retry because the upstream API is flaky.");
  });

  it("orphans a comment when its surroundings are rewritten wholesale", () => {
    const dir = repo();

    extract(openRepo(dir));
    writeFiles(dir, {
      "src/service.ts": "export const nothing = 0;\n",
    });

    const report = extract(openRepo(dir));
    expect(report.orphaned).toBeGreaterThan(0);

    // Orphaned means retained, not lost.
    const store = read(dir, "sideline.yaml");
    expect(store).toContain("OPS-1423");
    expect(store).toContain("orphaned: true");
  });
});

describe("check", () => {
  it("passes on freshly extracted code", () => {
    const dir = repo();
    extract(openRepo(dir));
    expect(check(openRepo(dir)).inSync).toBe(true);
  });

  it("fails while comments are back in the code", () => {
    const dir = repo();
    extract(openRepo(dir));
    restoreRepo(openRepo(dir));

    const result = check(openRepo(dir));
    expect(result.inSync).toBe(false);
    expect(result.restored).toContain("src/service.ts");
  });

  it("fails on a file with comments that was never extracted", () => {
    const dir = repo();
    extract(openRepo(dir));
    writeFiles(dir, { "src/extra.ts": "// never seen\nexport const y = 1;\n" });

    const result = check(openRepo(dir));
    expect(result.inSync).toBe(false);
    expect(result.unextracted).toContain("src/extra.ts");
  });
});

describe("status", () => {
  it("reports extracted, then restored, then drifted", () => {
    const dir = repo();

    extract(openRepo(dir));
    expect(status(openRepo(dir)).every((s) => s.health === "extracted")).toBe(true);

    restoreRepo(openRepo(dir));
    expect(status(openRepo(dir)).every((s) => s.health === "restored")).toBe(true);

    writeFiles(dir, { "src/service.ts": "export const x = 1;\n" });
    const rows = status(openRepo(dir));
    expect(rows.find((s) => s.path === "src/service.ts")?.health).toBe("drifted");
  });
});
