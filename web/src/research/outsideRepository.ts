/** Keeps evaluation data and results out of this repository. */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
);

/** The real location `path` has or would have, refused when it lies in
 * `repository`. The path need not exist yet: links are resolved through its
 * nearest existing ancestor, so nothing has to be created to check it. */
export function outsideRepository(
  path: string,
  repository: string = REPOSITORY,
): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  const real = join(realpathSync(existing), ...missing);
  if (real === repository || real.startsWith(repository + sep))
    throw new Error(
      "Evaluation data and results must stay outside the repository",
    );
  return real;
}
