/**
 * Recent logs for the panel.
 *
 * Two sources, in order of usefulness: the service's journal (encoder stderr,
 * systemd restarts, watchdog decisions) and an in-process ring buffer that keeps
 * the last lines even where journalctl does not exist (development, containers).
 */
import { execFile } from "node:child_process";

const RING_SIZE = 500;
const ring: string[] = [];

export function remember(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  ring.push(stamped);
  if (ring.length > RING_SIZE) ring.shift();
}

export function recentInMemory(limit: number): string[] {
  return ring.slice(-limit);
}

export function journalLines(unit: string, limit: number, timeoutMs = 4000): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "journalctl",
      ["-u", unit, "-n", String(limit), "--no-pager", "-o", "short-iso"],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout.split("\n").filter((line) => line.trim() !== ""));
      },
    );
  });
}
