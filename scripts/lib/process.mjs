import { spawnSync } from "node:child_process";
// Modified from xAI's bridge runtime to avoid shell argument expansion and
// verify process birth identity before terminating persisted PIDs (2026).
import fs from "node:fs";
import process from "node:process";

function sleepMs(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration <= 0) {
    return;
  }
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, duration);
}

export function runCommand(command, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    // All callers pass an executable and an argv array. Enabling a shell on
    // Windows would reinterpret user-controlled refs/prompts as shell syntax.
    shell: false,
    windowsHide: true
  });

  const status = result.status == null ? (result.signal ? 1 : null) : result.status;

  return {
    command,
    args,
    status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

function normalizeIdentityOutput(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function readLinuxProcessIdentity(pid, options = {}) {
  const readFileSyncImpl = options.readFileSyncImpl ?? fs.readFileSync;
  const readlinkSyncImpl = options.readlinkSyncImpl ?? fs.readlinkSync;
  const statText = String(readFileSyncImpl(`/proc/${pid}/stat`, "utf8"));
  const closeParen = statText.lastIndexOf(")");
  if (closeParen < 0) return null;
  const fieldsAfterCommand = statText.slice(closeParen + 2).trim().split(/\s+/);
  // /proc/<pid>/stat field 22 is the process start time in clock ticks. The
  // array starts at field 3, so its index is 19.
  const startTicks = fieldsAfterCommand[19];
  if (!startTicks) return null;

  let bootId = "unknown-boot";
  let executable = "unknown-executable";
  try {
    bootId = normalizeIdentityOutput(readFileSyncImpl("/proc/sys/kernel/random/boot_id", "utf8"));
  } catch {
  }
  try {
    executable = normalizeIdentityOutput(readlinkSyncImpl(`/proc/${pid}/exe`));
  } catch {
  }
  return `linux:${bootId}:${startTicks}:${executable}`;
}

function readWindowsProcessIdentity(pid, options = {}) {
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const command = [
    `$p = Get-Process -Id ${pid} -ErrorAction Stop`,
    "$ticks = $p.StartTime.ToUniversalTime().Ticks",
    "Write-Output ($ticks.ToString() + '|' + $p.ProcessName)"
  ].join("; ");
  const result = runCommandImpl(
    options.powershellBinary ?? "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { env: options.env }
  );
  if (result.error || result.status !== 0) return null;
  const output = normalizeIdentityOutput(result.stdout);
  return output ? `win32:${output}` : null;
}

function readPsProcessIdentity(pid, platform, options = {}) {
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const result = runCommandImpl("ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="], {
    env: options.env
  });
  if (result.error || result.status !== 0) return null;
  const output = normalizeIdentityOutput(result.stdout);
  return output ? `${platform}:${output}` : null;
}

/**
 * Return an OS-derived process birth identity suitable for detecting PID
 * reuse. This intentionally excludes command arguments so prompts never enter
 * persisted run state.
 */
export function getProcessIdentity(pid, options = {}) {
  const numericPid = Number(pid);
  if (!Number.isSafeInteger(numericPid) || numericPid <= 0) return null;
  const platform = options.platform ?? process.platform;

  try {
    if (platform === "linux") {
      return readLinuxProcessIdentity(numericPid, options);
    }
    if (platform === "win32") {
      return readWindowsProcessIdentity(numericPid, options);
    }
    return readPsProcessIdentity(numericPid, platform, options);
  } catch {
    return null;
  }
}

export function verifyProcessIdentity(pid, expectedIdentity, options = {}) {
  const currentIdentity = getProcessIdentity(pid, options);
  const expected = typeof expectedIdentity === "string" && expectedIdentity.trim()
    ? expectedIdentity.trim()
    : null;
  return {
    verified: Boolean(expected && currentIdentity && expected === currentIdentity),
    expectedIdentity: expected,
    currentIdentity,
    reason: !expected
      ? "missing-stored-identity"
      : !currentIdentity
        ? "process-not-found-or-identity-unavailable"
        : expected === currentIdentity
          ? "verified"
          : "identity-mismatch"
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.signal || result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.signal || result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

function isZombieProcess(pid) {
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
      windowsHide: true
    });
    if (result.error || result.status !== 0) {
      return true;
    }
    const stat = String(result.stdout ?? "").trim();
    if (!stat) {
      return true;
    }
    return /\bZ\b|^Z/i.test(stat) || stat.toUpperCase().includes("Z");
  } catch {
    return false;
  }
}

function processIsAlive(pid, killImpl) {
  try {
    killImpl(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return !isZombieProcess(pid);
    }
    throw error;
  }
  return !isZombieProcess(pid);
}

function tryKill(killImpl, pid, signal) {
  try {
    killImpl(pid, signal);
    return { ok: true, missing: false, denied: false };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { ok: false, missing: true, denied: false };
    }
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return { ok: false, missing: false, denied: true };
    }
    throw error;
  }
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const isAliveImpl =
    options.isAliveImpl ?? ((candidatePid) => processIsAlive(candidatePid, killImpl));
  const graceMs = options.graceMs ?? 200;

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      const direct = tryKill(killImpl, pid, "SIGTERM");
      if (direct.missing) {
        return { attempted: true, delivered: false, method: "kill" };
      }
      return { attempted: true, delivered: true, method: "kill" };
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  const methods = [];
  let signaledLiveProcess = false;

  const groupKill = tryKill(killImpl, -pid, "SIGTERM");
  if (groupKill.ok) {
    methods.push("process-group");
    signaledLiveProcess = true;
  } else if (groupKill.denied) {
    methods.push("process-group-denied");
  }

  if (isAliveImpl(pid)) {
    const directKill = tryKill(killImpl, pid, "SIGTERM");
    if (directKill.ok) {
      methods.push("process");
      signaledLiveProcess = true;
    } else if (directKill.missing) {
      return {
        attempted: true,
        delivered: signaledLiveProcess,
        method: methods.join("+") || "process"
      };
    } else if (directKill.denied) {
      methods.push("process-denied");
    }
  } else if (!signaledLiveProcess) {
    return {
      attempted: true,
      delivered: false,
      method: methods.join("+") || "process-group"
    };
  } else {
    return {
      attempted: true,
      delivered: true,
      method: methods.join("+") || "process-group"
    };
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAliveImpl(pid)) {
      return { attempted: true, delivered: true, method: methods.join("+") || "process" };
    }
    sleepMs(20);
  }

  if (!isAliveImpl(pid)) {
    return { attempted: true, delivered: true, method: methods.join("+") || "process" };
  }

  const groupKillHard = tryKill(killImpl, -pid, "SIGKILL");
  if (groupKillHard.ok) {
    methods.push("process-group-sigkill");
  }
  if (isAliveImpl(pid)) {
    const directKillHard = tryKill(killImpl, pid, "SIGKILL");
    if (directKillHard.ok) {
      methods.push("process-sigkill");
    } else if (directKillHard.missing) {
      return { attempted: true, delivered: true, method: methods.join("+") || "process-sigkill" };
    }
  } else {
    return { attempted: true, delivered: true, method: methods.join("+") || "process-group-sigkill" };
  }

  sleepMs(40);
  const stillAlive = isAliveImpl(pid);
  return {
    attempted: true,
    delivered: !stillAlive,
    method: methods.join("+") || "process-sigkill"
  };
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
