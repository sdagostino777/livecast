/**
 * Process entry point: build the app, listen on loopback, stay alive.
 *
 * nginx owns ports 80/443 and fs access is via the shared filesystem, so the
 * Node process is deliberately boring: no TLS, no static-file tuning, no
 * clustering (FFmpeg is the CPU consumer, not HTTP).
 */
import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = await buildApp({ logger: true });

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { port: config.port, host: config.host, publicUrl: config.publicUrl, dataDir: config.dataDir },
    "livecast listening",
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  try {
    app.pipeline.stop();
  } catch {
    /* nothing to stop */
  }
  await app.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
