#!/usr/bin/env node

const fs = require("fs");
const { spawnSync } = require("child_process");

const REQUIRED_PACKAGES = [
  "bubblewrap",
  "dbus-user-session",
  "dbus-x11",
  "openbox",
  "tint2",
  "x11-apps",
  "x11-utils",
  "x11-xserver-utils",
  "xserver-xorg-core",
  "xserver-xorg-legacy",
  "xserver-xorg-video-dummy",
  "xauth",
  "xdg-utils",
  "xterm",
  "xvfb",
];

function readOsRelease() {
  const raw = fs.readFileSync("/etc/os-release", "utf8");
  const entries = Object.fromEntries(
    raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator === -1) {
          return [line, ""];
        }
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1).replace(/^"/, "").replace(/"$/, "");
        return [key, value];
      }),
  );
  return entries;
}

function assertUbuntu() {
  const osRelease = readOsRelease();
  const id = String(osRelease.ID || "").toLowerCase();
  const idLike = String(osRelease.ID_LIKE || "").toLowerCase();

  if (id !== "ubuntu" && !idLike.includes("ubuntu")) {
    throw new Error("setupVirtualDesktops is only supported on Ubuntu");
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

function writeXwrapperConfig(command, isRoot) {
  const contents = "allowed_users=anybody\nneeds_root_rights=yes\n";
  if (isRoot) {
    fs.mkdirSync("/etc/X11", { recursive: true });
    fs.writeFileSync("/etc/X11/Xwrapper.config", contents, "utf8");
    return;
  }

  const result = spawnSync(command, ["tee", "/etc/X11/Xwrapper.config"], {
    input: contents,
    stdio: ["pipe", "inherit", "inherit"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error("Failed to write /etc/X11/Xwrapper.config");
  }
}

function main() {
  assertUbuntu();

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const command = isRoot ? "apt-get" : "sudo";

  console.log("Installing Ubuntu packages for virtual desktop sessions...");
  console.log(`Packages: ${REQUIRED_PACKAGES.join(", ")}`);

  run(command, isRoot ? ["update"] : ["apt-get", "update"]);
  run(command, isRoot ? ["install", "-y", ...REQUIRED_PACKAGES] : ["apt-get", "install", "-y", ...REQUIRED_PACKAGES]);
  writeXwrapperConfig(command, isRoot);

  console.log("Virtual desktop dependencies installed.");
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
