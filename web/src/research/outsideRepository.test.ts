// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { outsideRepository, REPOSITORY } from "./outsideRepository";

describe("keeping evaluation files out of the repository", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repo");
  mkdirSync(join(repository, "web"), { recursive: true });
  const refused =
    "Evaluation data and results must stay outside the repository";

  it("accepts a place outside, existing or not, and creates nothing", () => {
    expect(outsideRepository(root, repository)).toBe(root);
    const fresh = join(root, "results", "run-1");
    expect(outsideRepository(fresh, repository)).toBe(fresh);
    expect(existsSync(join(root, "results"))).toBe(false);
    // A sibling whose name only starts like the repository's is outside.
    expect(outsideRepository(join(root, "repo-data"), repository)).toBe(
      join(root, "repo-data"),
    );
  });

  it("refuses the repository and anything in it, before creating it", () => {
    for (const inside of [
      repository,
      join(repository, "web"),
      join(repository, "web", "results", "run-1"),
      join(repository, "new", "deep", "place"),
      join(repository, "web", "..", "data"),
    ]) {
      expect(() => outsideRepository(inside, repository)).toThrow(refused);
    }
    expect(existsSync(join(repository, "new"))).toBe(false);
    expect(existsSync(join(repository, "web", "results"))).toBe(false);
  });

  it("follows a link into the repository, also under a missing tail", () => {
    const link = join(root, "link");
    symlinkSync(join(repository, "web"), link);
    expect(() => outsideRepository(link, repository)).toThrow(refused);
    expect(() =>
      outsideRepository(join(link, "results", "run-1"), repository),
    ).toThrow(refused);
  });

  it("knows this checkout", () => {
    expect(existsSync(join(REPOSITORY, "web", "package.json"))).toBe(true);
    expect(() => outsideRepository(join(REPOSITORY, "web", "out"))).toThrow(
      refused,
    );
  });
});
