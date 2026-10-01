// `bun run up`: starts the Ori runtime and the console server together, prefixes their output
// with [ori] and [app], waits until Ori's chat bridge and the console both answer, then prints
// the console URL. Ctrl-C stops both. If either stops on its own, the other is stopped too and
// this exits non-zero.
import { existsSync } from "node:fs";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { config } from "../src/config";

export const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 2_000;
const STOP_GRACE_MS = 5_000;

////////////////////
// PURE HELPERS   //
////////////////////

/**
 * The port the Ori runtime binds, read from ORI_URL.
 *
 * Parameters
 * ----------
 * oriUrl : string
 *     ORI_URL, e.g. "http://127.0.0.1:4717".
 *
 * Returns
 * -------
 * number
 *     The explicit port, or the scheme's default (80 for http, 443 for https).
 *
 * Raises
 * ------
 * Error
 *     When ORI_URL is not an http(s) URL.
 */
export function oriPortFrom(oriUrl: string): number {
  let url: URL;
  try {
    url = new URL(oriUrl);
  } catch {
    throw new Error(`ORI_URL must be a URL like http://127.0.0.1:4717, got "${oriUrl}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`ORI_URL must start with http:// or https://, got "${oriUrl}"`);
  }
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/**
 * Where the `ori` binary is: on PATH, else the installer's ~/.local/bin/ori, else null.
 */
export function findOri(
  which: (name: string) => string | null = (name) => Bun.which(name),
  exists: (path: string) => boolean = existsSync,
  home: string = homedir(),
): string | null {
  const onPath = which("ori");
  if (onPath) return onPath;
  const installed = join(home, ".local", "bin", "ori");
  return exists(installed) ? installed : null;
}

export type ProbeResult = "ready" | "not-ready" | "unreachable";

/** Ask Ori's ticket-reply feature whether its chat bridge is up. */
export async function probeBridge(oriUrl: string, fetchFn: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    const res = await fetchFn(`${oriUrl}/ticket-reply/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return "not-ready";
    const body = (await res.json().catch(() => null)) as { bridge?: unknown } | null;
    return body?.bridge === true ? "ready" : "not-ready";
  } catch {
    return "unreachable";
  }
}

/** Ask the console server whether it answers. */
export async function probeApp(appUrl: string, fetchFn: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    const res = await fetchFn(appUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok ? "ready" : "not-ready";
  } catch {
    return "unreachable";
  }
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  // Checked before each probe: stop waiting when a child has already exited.
  aborted?: () => boolean;
}

/**
 * Poll `probe` until it reports ready, the deadline passes, or `aborted` turns true.
 *
 * Returns
 * -------
 * { ready: true } | { ready: false; last: ProbeResult | "aborted" }
 *     On failure, `last` is the final probe result (or "aborted"), which picks the message.
 */
export async function waitUntilReady(
  probe: () => Promise<ProbeResult>,
  { timeoutMs = READY_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS, now = Date.now, sleep = Bun.sleep, aborted = () => false }: WaitOptions = {},
): Promise<{ ready: true } | { ready: false; last: ProbeResult | "aborted" }> {
  const deadline = now() + timeoutMs;
  let last: ProbeResult = "unreachable";
  while (true) {
    if (aborted()) return { ready: false, last: "aborted" };
    last = await probe();
    if (last === "ready") return { ready: true };
    if (now() >= deadline) return { ready: false, last };
    await sleep(intervalMs);
  }
}

export const readyMessage = (port: number) => `Console ready: http://localhost:${port}`;

export const ORI_NOT_INSTALLED_MESSAGE =
  "Ori is not installed: `ori` is not on PATH or at ~/.local/bin/ori. Install Ori, run `ori login`, then `bun run setup`.";

/** The message for an Ori runtime that never reported its chat bridge ready. */
export function oriTimeoutMessage(last: ProbeResult, timeoutMs: number = READY_TIMEOUT_MS): string {
  const seconds = Math.round(timeoutMs / 1000);
  if (last === "unreachable") {
    return (
      `Ori did not start listening on ${config.oriUrl} within ${seconds} s. ` +
      "Check the [ori] lines above; if Ori says you are not signed in, run `ori login`, then `bun run up` again."
    );
  }
  return (
    `Ori is running but its ticket-reply chat bridge did not start within ${seconds} s. ` +
    "Check the [ori] lines above; if Ori says you are not signed in, run `ori login`, then `bun run up` again."
  );
}

export const appTimeoutMessage = (port: number, timeoutMs: number = READY_TIMEOUT_MS) =>
  `The console server did not answer on http://localhost:${port} within ${Math.round(timeoutMs / 1000)} s. Check the [app] lines above.`;

export const portInUseMessage = (port: number, what: "ori" | "app") =>
  what === "ori"
    ? `Port ${port} (the Ori runtime, from ORI_URL) is already in use. Stop whatever holds it (another \`bun run up\` or \`bun run ori:start\`?) or change ORI_URL in .env.`
    : `Port ${port} (the console, from PORT) is already in use. Stop whatever holds it (another \`bun run up\` or \`bun run start\`?) or change PORT in .env.`;

// Matched against each raw (unprefixed) [ori] line once the console is ready, to cut INFO
// noise while still surfacing anything worth seeing: warnings, errors, and exception/stack
// trace lines (a line like "    at foo (file.ts:12:3)").
const ORI_NOISE_RE = /\b(?:WARN|ERROR|failed)\b|error:|✗|\bexception\b|^\s*at\s+\S/i;

/** Whether an [ori] line should still be shown after the console is ready. */
export function isOriWarningOrError(line: string): boolean {
  return ORI_NOISE_RE.test(line);
}

export const ORI_LOG_HINT = "Ori's full log: .ori/logs/ (shown here: warnings and errors only)";

export function unexpectedExitMessage(name: "ori" | "app", code: number | null): string {
  const what = name === "ori" ? "The Ori runtime" : "The console server";
  const how = code === null ? "was killed" : `exited with code ${code}`;
  const hint = name === "ori" ? " If Ori says you are not signed in, run `ori login`, then `bun run up` again." : "";
  return `${what} ${how}; stopping the other process. See the [${name}] lines above.${hint}`;
}

/**
 * Splits a byte stream into lines and prefixes each one. Bytes after the last newline wait for
 * the next chunk, so a line split across chunks still comes out whole.
 */
export class LinePrefixer {
  private pending = "";
  private readonly decoder = new TextDecoder();

  // shouldShow is consulted per line, at the time that line is emitted, so a caller can flip
  // its behavior (e.g. once the console reports ready) without replacing the prefixer.
  constructor(
    private readonly prefix: string,
    private readonly shouldShow: (line: string) => boolean = () => true,
  ) {}

  push(chunk: Uint8Array | string): string {
    this.pending += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    return lines
      .filter((line) => this.shouldShow(line))
      .map((line) => this.format(line))
      .join("");
  }

  flush(): string {
    this.pending += this.decoder.decode();
    const rest = this.pending;
    this.pending = "";
    return rest && this.shouldShow(rest) ? this.format(rest) : "";
  }

  private format(line: string): string {
    return line ? `${this.prefix} ${line}\n` : `${this.prefix}\n`;
  }
}

////////////////////
// PROCESSES      //
////////////////////

// This script's own lines carry no prefix, so they stand out from the [ori] and [app] output.
const say = (line: string) => process.stdout.write(`${line}\n`);
const complain = (line: string) => process.stderr.write(`${line}\n`);
const REPO_ROOT = join(import.meta.dir, "..");
// A terminal's Ctrl-C reaches the children as well as this process, so a child can exit a
// moment before the SIGINT handler here runs. Waiting this long before calling an exit
// unexpected keeps that ordinary shutdown from reading as a crash.
const EXIT_SETTLE_MS = 200;

async function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function canListen(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host }, () => server.close(() => resolve(true)));
  });
}

async function portInUse(port: number, host: string): Promise<boolean> {
  return (await canConnect(host, port)) || !(await canListen(port, host === "localhost" ? undefined : host));
}

async function pipeWithPrefix(
  stream: ReadableStream<Uint8Array>,
  prefix: string,
  out: NodeJS.WriteStream,
  shouldShow?: (line: string) => boolean,
): Promise<void> {
  const prefixer = new LinePrefixer(prefix, shouldShow);
  for await (const chunk of stream) out.write(prefixer.push(chunk));
  out.write(prefixer.flush());
}

interface Child {
  name: "ori" | "app";
  proc: Subprocess<"ignore", "pipe", "pipe">;
}

function spawnChild(name: Child["name"], cmd: string[], shouldShow?: (line: string) => boolean): Child {
  const proc = Bun.spawn(cmd, { cwd: REPO_ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
  void pipeWithPrefix(proc.stdout, `[${name}]`, process.stdout, shouldShow);
  void pipeWithPrefix(proc.stderr, `[${name}]`, process.stderr, shouldShow);
  return { name, proc };
}

async function stopChild({ proc }: Child): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  const stopped = await Promise.race([proc.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
  if (!stopped) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

async function main(): Promise<void> {
  const oriPort = oriPortFrom(config.oriUrl);
  const oriHost = new URL(config.oriUrl).hostname;
  const appPort = config.port;

  const ori = findOri();
  if (!ori) {
    complain(ORI_NOT_INSTALLED_MESSAGE);
    process.exit(1);
  }
  if (await portInUse(oriPort, oriHost)) {
    complain(portInUseMessage(oriPort, "ori"));
    process.exit(1);
  }
  if (await portInUse(appPort, "localhost")) {
    complain(portInUseMessage(appPort, "app"));
    process.exit(1);
  }

  say(`Starting the Ori runtime on port ${oriPort} and the console on port ${appPort}...`);
  // Before the console is ready, every [ori] line is shown; afterward, only warnings and
  // errors are, to cut the INFO noise once there's nothing left to watch for.
  let ready = false;
  const children = [
    spawnChild("ori", [ori, "start", "--no-install", "--port", String(oriPort)], (line) => !ready || isOriWarningOrError(line)),
    spawnChild("app", [process.execPath, "src/server.ts"]),
  ];

  let stopping = false;
  const stopAll = async (exitCode: number, message?: string) => {
    if (stopping) return;
    stopping = true;
    if (message) complain(message);
    await Promise.all(children.map(stopChild));
    process.exit(exitCode);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      say("Stopping the Ori runtime and the console.");
      void stopAll(0);
    });
  }
  for (const child of children) {
    void child.proc.exited.then(async (code) => {
      await Bun.sleep(EXIT_SETTLE_MS);
      if (!stopping) void stopAll(1, unexpectedExitMessage(child.name, child.proc.signalCode ? null : code));
    });
  }

  const aborted = () => stopping;
  const [oriReady, appReady] = await Promise.all([
    waitUntilReady(() => probeBridge(config.oriUrl), { aborted }),
    waitUntilReady(() => probeApp(`http://localhost:${appPort}/`), { aborted }),
  ]);
  if (stopping) return;
  if (!oriReady.ready) return stopAll(1, oriTimeoutMessage(oriReady.last as ProbeResult));
  if (!appReady.ready) return stopAll(1, appTimeoutMessage(appPort));
  say(readyMessage(appPort));
  ready = true;
  say(ORI_LOG_HINT);
}

if (import.meta.main) await main();
