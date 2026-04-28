/**
 * CDP screencast daemon.
 *
 * Long-lived process that:
 *   1. Connects to Electron/Chrome via Playwright connectOverCDP
 *   2. Starts page.screencast recording
 *   3. Listens on a Unix domain socket for commands
 *   4. On "stop": awaits screencast.stop(), responds with video path, exits
 *
 * Spawned by `proofshot start --cdp`. Communicates with CLI via UDS (NDJSON).
 *
 * Usage: node cdp-daemon.js <cdp-endpoint> <video-path> <socket-path>
 */
import * as net from 'net';
import * as fs from 'fs';
import { chromium, type Page } from 'playwright-core';
import type { DaemonRequest, DaemonResponse } from './cdp-client.js';

async function main(): Promise<void> {
  const endpoint = process.argv[2];
  const videoPath = process.argv[3];
  const socketPath = process.argv[4];

  if (!endpoint || !videoPath || !socketPath) {
    process.stderr.write(
      'Usage: cdp-daemon <cdp-endpoint> <video-path> <socket-path>\n',
    );
    process.exit(1);
  }

  // ── Connect to browser and start recording ────────────────────────
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) {
    process.stderr.write('daemon: no browser context found\n');
    process.exit(1);
  }
  const page = context.pages()[0];
  if (!page) {
    process.stderr.write('daemon: no page found\n');
    process.exit(1);
  }

  await page.screencast.start({
    path: videoPath,
    size: { width: 1280, height: 720 },
  });
  process.stderr.write('daemon: recording\n');

  // ── IPC server ────────────────────────────────────────────────────
  const server = net.createServer((conn) => {
    let buffer = '';
    conn.on('data', (chunk) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return;

      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      let req: DaemonRequest;
      try {
        req = JSON.parse(line);
      } catch {
        respond(conn, { ok: false, error: 'Invalid JSON' });
        return;
      }

      handleRequest(req, page, conn, server);
    });
  });

  // Clean up stale socket
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  server.listen(socketPath, () => {
    process.stderr.write('daemon: ready\n');
  });

  // ── Cleanup on unexpected exit ────────────────────────────────────
  const cleanup = (): void => {
    try { server.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
  };
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
}

function respond(conn: net.Socket, res: DaemonResponse, onFlushed?: () => void): void {
  conn.write(JSON.stringify(res) + '\n');
  conn.end(onFlushed);
}

async function handleRequest(
  req: DaemonRequest,
  page: Page,
  conn: net.Socket,
  server: net.Server,
): Promise<void> {
  switch (req.method) {
    case 'ping':
      respond(conn, { ok: true });
      break;

    case 'stop':
      try {
        await page.screencast.stop();
        process.stderr.write('daemon: stopped\n');
        respond(conn, { ok: true }, () => {
          server.close(() => process.exit(0));
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        respond(conn, { ok: false, error: message }, () => {
          server.close(() => process.exit(1));
        });
      }
      break;

    default:
      respond(conn, { ok: false, error: `Unknown method: ${(req as Record<string, unknown>).method}` });
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`daemon: fatal — ${message}\n`);
  process.exit(1);
});
