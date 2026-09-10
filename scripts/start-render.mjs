import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const legacyOrderbookDirectories = new Set([
  process.env.PARA_DATA_DIR,
  "/var/data/para-orderbooks",
  "/tmp/para-orderbooks",
].filter(Boolean));

await Promise.all([...legacyOrderbookDirectories].map((directory) =>
  rm(directory, { recursive: true, force: true })
));

const executable = fileURLToPath(new URL("../node_modules/.bin/vinext", import.meta.url));
const web = spawn(executable, ["start"], {
  stdio: "inherit",
  env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
});

const shutdown = (signal) => {
  if (!web.killed) web.kill(signal);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
web.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
