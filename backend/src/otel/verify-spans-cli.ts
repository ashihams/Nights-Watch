/**
 * CLI wrapper: verify spans for a run.id via WSL ClickHouse (no SigNoz UI).
 * Usage: npm run spans:verify -- run-XXXX
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const runId = process.argv[2];
if (!runId) {
  console.error("Usage: npm run spans:verify -- <runId>");
  process.exit(1);
}

const script = resolve(
  process.cwd(),
  "../infra/signoz/verify-run-spans.sh",
).replace(/\\/g, "/");

// Map Windows path to WSL /mnt/<drive>/...
const mnt = script.replace(/^([A-Za-z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`);

const result = spawnSync(
  "wsl.exe",
  ["-d", "Ubuntu", "--", "bash", "-lc", `sed -i 's/\\r$//' '${mnt}' && bash '${mnt}' '${runId}'`],
  { encoding: "utf8", stdio: "inherit" },
);

process.exit(result.status ?? 1);
