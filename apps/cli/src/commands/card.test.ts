import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCard } from "./card";
import { createProgram } from "../cli";

const openDb = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("card must be offline");
  }),
);
vi.mock("../db", () => ({ openDb }));

let folder: string;
let input: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "netpro-card-"));
  input = join(folder, "profile.json");
  writeFileSync(
    input,
    JSON.stringify({ fullName: "Ada Lovelace", email: "ada@example.com" }),
  );
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("netpro card", () => {
  it("renders HTML to stdout by default, without opening a database", () => {
    const result = executeCard({ input, generate: true });
    expect(result.output).toBe(result.content);
    expect(result.content).toContain("<!doctype html>");
    expect(result.content).toContain("Ada Lovelace");
    expect(openDb).not.toHaveBeenCalled();
  });

  it("writes a vCard file and reports where it went", () => {
    const output = join(folder, "contact.vcf");
    const result = executeCard({ input, format: "vcard", output });
    expect(result.output).toContain(output);
    expect(readFileSync(output, "utf8")).toBe(result.content);
    expect(result.content).toContain("FN:Ada Lovelace\r\n");
  });

  it("writes standalone HTML", () => {
    const output = join(folder, "card.html");
    executeCard({ input, output });
    expect(readFileSync(output, "utf8")).toContain("Ada Lovelace");
  });

  it.each([
    [{}, /--input/],
    [{ input: "missing.json" }, /ENOENT/],
    [{ format: "pdf" }, /html or vcard/],
  ])("rejects invalid CLI options: %j", (options, error) => {
    expect(() =>
      executeCard({
        input,
        ...options,
        ...(Object.keys(options).length ? {} : { input: undefined }),
      }),
    ).toThrow(error);
  });

  it("rejects invalid JSON and unsafe profile fields", () => {
    writeFileSync(input, "not JSON");
    expect(() => executeCard({ input })).toThrow(/valid JSON/);
    writeFileSync(input, '{"fullName":"Ada","notes":"private"}');
    expect(() => executeCard({ input })).toThrow(/unsupported/);
  });

  it("rejects oversized input and never overwrites its source JSON", () => {
    expect(() => executeCard({ input, output: input })).toThrow(/different/);
    writeFileSync(input, "x".repeat(32769));
    expect(() => executeCard({ input })).toThrow(/32 KiB/);
  });

  it("wires flags to real generation through Commander", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node",
      "netpro",
      "card",
      "--generate",
      "--input",
      input,
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("<!doctype html>"),
    );
    expect(openDb).not.toHaveBeenCalled();
  });

  it("reports a nonzero exit status for invalid input without a stack trace", async () => {
    writeFileSync(input, "not JSON");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node",
      "netpro",
      "card",
      "--input",
      input,
    ]);
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "netpro card: Profile must be valid JSON.",
    );
  });
});
