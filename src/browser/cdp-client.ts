/**
 * IPC client for the CDP screencast daemon.
 *
 * Connects to the daemon's Unix domain socket, sends a JSON command,
 * waits for the JSON response, and disconnects. Blocking from the
 * caller's perspective — no polling, no sentinels.
 */
import * as net from 'net';

export interface DaemonRequest {
  method: 'ping' | 'stop';
}

export interface DaemonResponse {
  ok: boolean;
  error?: string;
  videoPath?: string;
}

/**
 * Send a command to the CDP daemon and wait for the response.
 * Throws if the daemon is not running (ENOENT / ECONNREFUSED).
 */
export function sendCommand(
  socketPath: string,
  request: DaemonRequest,
  timeoutMs = 30000,
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath });
    let buffer = '';
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error(`Daemon did not respond within ${timeoutMs / 1000}s`));
    }, timeoutMs);

    client.on('connect', () => {
      client.write(JSON.stringify(request) + '\n');
    });

    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        clearTimeout(timer);
        const line = buffer.slice(0, newlineIdx);
        client.end();
        try {
          resolve(JSON.parse(line) as DaemonResponse);
        } catch {
          reject(new Error(`Invalid response from daemon: ${line}`));
        }
      }
    });

    client.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        reject(new Error('Daemon is not running'));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Wait for the daemon socket to become available after spawn.
 * Retries connection with backoff. Returns once a ping succeeds.
 */
export async function waitForDaemon(
  socketPath: string,
  maxAttempts = 30,
  intervalMs = 200,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await sendCommand(socketPath, { method: 'ping' }, 3000);
      if (res.ok) return;
    } catch {
      // Daemon not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Daemon failed to start');
}
