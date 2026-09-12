// Keep compiler/test diagnostics available in public check annotations too.
import { spawn } from "node:child_process";
let [command, ...args] = process.argv.slice(2);
if (command === "npm") {
  // npm.cmd requires a shell; use the installed npm CLI directly instead.
  const { dirname, resolve } = await import("node:path");
  args = [resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), ...args];
  command = process.execPath;
}
const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
let tail = "";
for (const [stream, destination] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  stream.on("data", (data) => {
    destination.write(data);
    tail = (tail + data.toString()).slice(-14000);
  });
}
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("close", (code) => {
  if (code !== 0) {
    const escaped = tail.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
    console.log(`::error::${escaped}`);
    process.exitCode = code || 1;
  }
});
