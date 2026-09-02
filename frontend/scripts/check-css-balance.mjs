import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

async function listCssFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return listCssFiles(path);
      return extname(entry.name) === ".css" ? [path] : [];
    }),
  );
  return nested.flat();
}

function checkBraces(source, path) {
  const stack = [];
  let quote = null;
  let escaped = false;
  let inComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (inComment) {
      if (character === "*" && next === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }

    if (character === "/" && next === "*") {
      inComment = true;
      index += 1;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      stack.push(index);
    } else if (character === "}") {
      if (stack.length === 0) throw new Error(`${path}: unmatched closing brace`);
      stack.pop();
    }
  }

  if (inComment) throw new Error(`${path}: unclosed comment`);
  if (quote) throw new Error(`${path}: unclosed string`);
  if (stack.length > 0) throw new Error(`${path}: ${stack.length} unclosed brace(s)`);
}

const files = await listCssFiles(sourceRoot);
for (const file of files) {
  checkBraces(await readFile(file, "utf8"), relative(sourceRoot, file));
}

console.log(`CSS syntax guard passed (${files.length} files)`);
