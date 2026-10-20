import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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
const jlpService = fileURLToPath(new URL("../services/jlp-research/server.py", import.meta.url));
let stopping = false;
let jlp;
let restartTimer;
let cloud, cloudRestartTimer;
const cloudEnabled = process.env.RENDER === "true" && existsSync("/var/data/jlp") && Boolean(process.env.SITE_PASSWORD);
function startCloud() {
  cloud = spawn(process.execPath, [fileURLToPath(new URL("../services/posley-cloud/server.mjs", import.meta.url))], { stdio: "inherit", env: process.env });
  cloud.on("error", () => console.error("Posley cloud service failed to start."));
  cloud.on("exit", () => {
    if (!stopping) cloudRestartTimer = setTimeout(startCloud, 5_000);
  });
}
if (cloudEnabled) startCloud();

function startJlp() {
  jlp = spawn(process.env.JLP_PYTHON || "python3", [jlpService], {
    stdio: "inherit",
    env: {
      ...process.env,
      JLP_PORT: process.env.JLP_PORT || "8788",
      ...(process.env.JLP_DATA_DIR ? {} : existsSync("/var/data/jlp")
        ? { JLP_DATA_DIR: "/var/data/jlp" } : {}),
    },
  });
  jlp.on("error", (error) => console.error("JLP data service failed to start:", error));
  jlp.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`JLP data service exited (${code ?? signal}); restarting in five seconds`);
    restartTimer = setTimeout(startJlp, 5_000);
  });
}
startJlp();

const web = spawn(executable, ["start"], {
  stdio: "inherit",
  env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log",
    ...(cloudEnabled ? { POSLEY_CLOUD_INTERNAL_URL: "http://127.0.0.1:8791" } : {}) },
});

const shutdown = (signal) => {
  stopping = true;
  clearTimeout(restartTimer);
  clearTimeout(cloudRestartTimer);
  if (cloud && !cloud.killed) cloud.kill(signal);
  if (jlp && !jlp.killed) jlp.kill(signal);
  if (!web.killed) web.kill(signal);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
web.on("exit", (code, signal) => {
  stopping = true;
  clearTimeout(restartTimer);
  clearTimeout(cloudRestartTimer);
  if (cloud && !cloud.killed) cloud.kill("SIGTERM");
  if (jlp && !jlp.killed) jlp.kill("SIGTERM");
  process.exitCode = code ?? (signal ? 1 : 0);
});
