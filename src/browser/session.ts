import { ab, ProofShotError } from '../utils/exec.js';
import type { BrowserConfig, ViewportConfig } from '../utils/config.js';

export function buildOpenBrowserCommand(
  url: string,
  headless = true,
  browserConfig?: BrowserConfig,
): string {
  const flags: string[] = [];

  if (!headless) flags.push('--headed');
  if (browserConfig?.ignoreHttpsErrors) flags.push('--ignore-https-errors');
  if (browserConfig?.executablePath) flags.push(`--executable-path "${browserConfig.executablePath.replace(/"/g, '\\"')}"`);

  const suffix = flags.length > 0 ? ` ${flags.join(' ')}` : '';
  return `open ${url}${suffix}`;
}

/**
 * Initialize a browser session.
 * Opens the browser and sets viewport dimensions.
 */
export function openBrowser(
  url: string,
  viewport: ViewportConfig,
  headless = true,
  sessionName?: string,
  browserConfig?: BrowserConfig,
): void {
  ab(buildOpenBrowserCommand(url, headless, browserConfig), { timeoutMs: 60000, session: sessionName });
  ab(`set viewport ${viewport.width} ${viewport.height}`, { session: sessionName });
}

/**
 * Discover the browser-level WebSocket URL from a CDP HTTP endpoint.
 * e.g. http://localhost:9333 → ws://localhost:9333/devtools/browser/ABC123
 *
 * agent-browser needs the browser-level endpoint (not page-level) to connect
 * to Electron and other CDP targets.
 */
export async function discoverBrowserWsUrl(cdpEndpoint: string): Promise<string> {
  const versionUrl = cdpEndpoint.replace(/\/$/, '') + '/json/version';
  const res = await fetch(versionUrl, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new ProofShotError(
      `CDP endpoint returned ${res.status} at ${versionUrl}. Is the app running with --remote-debugging-port?`,
    );
  }
  const info = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!info.webSocketDebuggerUrl) {
    throw new ProofShotError(
      `No webSocketDebuggerUrl in ${versionUrl}. Is the app running with --remote-debugging-port?`,
    );
  }
  return info.webSocketDebuggerUrl;
}

/**
 * Connect to an existing browser via CDP HTTP endpoint.
 * Uses the browser-level WebSocket URL from /json/version.
 */
export async function connectBrowser(
  cdpEndpoint: string,
  viewport: ViewportConfig,
  sessionName?: string,
): Promise<void> {
  const wsUrl = await discoverBrowserWsUrl(cdpEndpoint);
  ab(`connect ${wsUrl}`, { timeoutMs: 60000, session: sessionName });
  ab(`set viewport ${viewport.width} ${viewport.height}`, { session: sessionName });
}

/**
 * Close the browser session.
 */
export function closeBrowser(sessionName?: string): void {
  try {
    ab('close', { session: sessionName });
  } catch {
    // Browser may already be closed — that's fine
  }
}

/**
 * Check if agent-browser is installed and accessible.
 */
export function checkAgentBrowser(): boolean {
  try {
    ab('--version', 5000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get any console errors from the current page.
 */
export function getConsoleErrors(sessionName?: string): string {
  try {
    return ab('errors', { session: sessionName });
  } catch {
    return '';
  }
}

/**
 * Get console output from the current page.
 */
export function getConsoleOutput(sessionName?: string): string {
  try {
    return ab('console', { session: sessionName });
  } catch {
    return '';
  }
}

export interface ConsoleMessage {
  text: string;
  timestamp: number; // epoch ms
  type: string; // log, warn, error, etc.
}

/**
 * Get console output as structured JSON with per-message timestamps.
 */
export function getConsoleOutputJson(sessionName?: string): ConsoleMessage[] {
  try {
    const raw = ab('console --json', { session: sessionName });
    const parsed = JSON.parse(raw);
    // agent-browser wraps JSON output: {success, data: {messages: [...]}, error}
    const messages = parsed?.data?.messages ?? parsed;
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

/**
 * Get the current page title.
 */
export function getPageTitle(sessionName?: string): string {
  try {
    return ab('get title', { session: sessionName });
  } catch {
    return '';
  }
}

/**
 * Get the current page URL.
 */
export function getPageUrl(sessionName?: string): string {
  try {
    return ab('get url', { session: sessionName });
  } catch {
    return '';
  }
}
