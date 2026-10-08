import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";

describe("examples/vikunja/.fixloop.yml", () => {
  it("validates against the schema", async () => {
    const src = await readFile("examples/vikunja/.fixloop.yml", "utf8");
    expect(() => parseConfig(src)).not.toThrow();
  });
});
