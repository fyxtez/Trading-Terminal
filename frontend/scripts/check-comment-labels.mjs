import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const SOURCE_ROOTS = [
  new URL("../src/", import.meta.url),
  new URL("../../backend/src/", import.meta.url),
];
const SOURCE_EXTENSIONS = new Set([".css", ".rs", ".ts", ".tsx"]);
const HISTORICAL_LABEL = /\b(?:FIX|FEATURE)\b/g;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const location = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      if (entry.isDirectory()) return sourceFiles(location);
      return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [location] : [];
    }),
  );
  return nestedFiles.flat();
}

const violations = [];
const files = (await Promise.all(SOURCE_ROOTS.map(sourceFiles))).flat();
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(HISTORICAL_LABEL)) {
    const line = source.slice(0, match.index).split("\n").length;
    violations.push(`${path.relative(process.cwd(), file.pathname)}:${line}`);
  }
}

if (violations.length > 0) {
  console.error("Replace historical FIX/FEATURE labels with present-tense invariants:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Comment invariant guard passed");
}
