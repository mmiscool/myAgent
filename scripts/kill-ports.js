const { execFileSync } = require("child_process");

const ports = process.argv.slice(2).map((value) => String(value).trim()).filter(Boolean);

if (ports.length === 0) {
  console.error("Usage: node scripts/kill-ports.js <port> [port...]");
  process.exit(1);
}

let killedAny = false;

for (const port of ports) {
  let output = "";

  try {
    output = execFileSync("lsof", [`-t`, `-iTCP:${port}`, `-sTCP:LISTEN`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    continue;
  }

  const pids = output.split(/\s+/).map((value) => value.trim()).filter(Boolean);

  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
      killedAny = true;
      console.log(`Stopped process ${pid} on port ${port}`);
    } catch {
      // Ignore races where the process exits before we signal it.
    }
  }
}

if (!killedAny) {
  console.log("No matching dev servers were running.");
}
