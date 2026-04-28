import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { execSync, spawn as spawnProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { waitForDaemon } from '../browser/cdp-client.js';
import { loadConfig } from '../utils/config.js';
import { setAgentBrowserDefaults } from '../utils/exec.js';
import { ensureDevServer } from '../server/start.js';
import { closeBrowser, connectBrowser, openBrowser } from '../browser/session.js';
import { startRecording } from '../browser/capture.js';
import { ensureOutputDir, generateTimestamp, generateSessionDirName } from '../artifacts/bundle.js';
import {
  saveSession,
  hasActiveSession,
  clearSession,
  generateAgentBrowserSessionName,
} from '../session/state.js';
import { writeMetadata } from '../session/metadata.js';

interface StartOptions {
  description?: string;
  port?: number;
  run?: string;
  headed?: boolean;
  output?: string;
  url?: string;
  cdp?: string;
  force?: boolean;
}

export async function startCommand(options: StartOptions): Promise<void> {
  const config = loadConfig();
  setAgentBrowserDefaults({ configPath: config.browser.configPath });
  if (options.port) config.devServer.port = options.port;
  if (options.output) config.output = options.output;
  if (options.headed !== undefined) config.headless = !options.headed;

  const outputDir = path.resolve(config.output);
  const timestamp = generateTimestamp();

  if (hasActiveSession(outputDir)) {
    if (options.force) {
      clearSession(outputDir);
      console.log(chalk.yellow('⚠') + chalk.dim(' Cleared stale session'));
    } else {
      console.log(
        chalk.yellow('⚠ A session is already active.') +
          chalk.dim(' Run "proofshot stop" first, or use --force to override.'),
      );
      return;
    }
  }

  ensureOutputDir(outputDir);

  const sessionDirName = generateSessionDirName(timestamp, options.description || null);
  const sessionDir = path.join(outputDir, sessionDirName);
  const sessionName = generateAgentBrowserSessionName(timestamp);
  ensureOutputDir(sessionDir);

  const videoPath = path.join(sessionDir, 'session.webm');
  const serverErrorLog = path.join(sessionDir, 'server.log');

  let branch = '';
  let commitSha = '';
  try {
    branch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // Non-fatal outside a git repo.
  }
  try {
    commitSha = execSync('git rev-parse HEAD', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // Non-fatal outside a git repo.
  }

  writeMetadata(sessionDir, {
    branch,
    commitSha,
    startedAt: new Date().toISOString(),
    description: options.description || null,
  });

  const cdpMode = !!options.cdp;
  let serverAlreadyRunning = true;
  let recordingStarted = false;

  // ── Browser connection ──────────────────────────────────────────────
  if (cdpMode) {
    console.log(chalk.dim(`Connecting to CDP endpoint: ${options.cdp}`));
    try {
      connectBrowser(options.cdp!, config.viewport, sessionName);
      console.log(chalk.green('✓') + ' Connected to CDP browser');
    } catch (error: any) {
      console.error(
        chalk.red('✗') +
          ` Failed to connect to CDP: ${error.message}\n` +
          chalk.dim('Make sure the target is running with --remote-debugging-port'),
      );
      process.exit(1);
    }
  } else {
    if (options.run) {
      console.log(chalk.dim(`Starting: ${options.run}`));
      try {
        await ensureDevServer(
          options.run,
          config.devServer.port,
          config.devServer.startupTimeout,
          serverErrorLog,
        );
        serverAlreadyRunning = false;
        console.log(chalk.green('✓') + ` Dev server started on :${config.devServer.port}`);
        console.log(chalk.dim(`  Server logs → ${serverErrorLog}`));
      } catch (error: any) {
        console.error(chalk.red('✗') + ` Failed to start dev server: ${error.message}`);
        process.exit(1);
      }
    } else {
      console.log(chalk.dim('No --run provided, assuming server is already running'));
    }

    const baseUrl = `http://localhost:${config.devServer.port}`;
    const openUrl = options.url || baseUrl;

    console.log(chalk.dim('Opening browser...'));
    try {
      openBrowser(openUrl, config.viewport, config.headless, sessionName, config.browser);
      console.log(chalk.green('✓') + ' Browser ready');
    } catch (error: any) {
      closeBrowser();
      console.error(
        chalk.red('✗') +
          ` Failed to open browser: ${error.message}\n` +
          chalk.dim('Make sure agent-browser is installed: npm install -g agent-browser'),
      );
      process.exit(1);
    }
  }

  // ── Recording ───────────────────────────────────────────────────────
  // Unix domain sockets have a 104-byte path limit on macOS.
  // Use /tmp with the session name to keep the path short.
  const socketPath = path.join(os.tmpdir(), `${sessionName}.sock`);

  if (cdpMode) {
    // CDP: Electron doesn't support Target.createBrowserContext, so
    // agent-browser's Playwright recording fails. Instead, spawn a
    // Playwright screencast daemon that connects via connectOverCDP,
    // records via page.screencast, and listens on a Unix domain socket
    // for the stop command. No polling, no sentinels — proper IPC.
    try {
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const distRoot = thisDir.includes('/src/')
        ? thisDir.replace(/\/src\/.*/, '')
        : path.join(thisDir, '..');
      const daemonScript = path.join(distRoot, 'src', 'browser', 'cdp-daemon.js');
      const child = spawnProcess('node', [daemonScript, options.cdp!, videoPath, socketPath], {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.log(chalk.dim(`  ${msg}`));
      });
      child.unref();

      // Wait for daemon to be ready (socket accepts connections)
      await waitForDaemon(socketPath);
      recordingStarted = true;
      console.log(chalk.green('✓') + ' Screencast recording started');
    } catch (error: any) {
      console.log(
        chalk.yellow('⚠') +
          ` Screencast recording failed: ${error.message}\n` +
          chalk.dim('  Ensure playwright is installed. Screenshots will still be captured.'),
      );
    }
  } else {
    // Standard: use agent-browser's Playwright-based recording
    const RECORDING_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;
    let lastError: any;

    for (let attempt = 1; attempt <= RECORDING_RETRIES; attempt++) {
      try {
        startRecording(videoPath, sessionName);
        recordingStarted = true;
        console.log(chalk.green('✓') + ' Recording started');
        break;
      } catch (error: any) {
        lastError = error;
        if (attempt < RECORDING_RETRIES) {
          console.log(
            chalk.yellow('⚠') +
              ` Recording failed (attempt ${attempt}/${RECORDING_RETRIES}), retrying in ${RETRY_DELAY_MS / 1000}s...`,
          );
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }

    if (!recordingStarted) {
      closeBrowser();
      console.error(
        chalk.red('✗') +
          ` Failed to initialize recording after ${RECORDING_RETRIES} attempts: ${lastError?.message}\n` +
          chalk.dim('Recording is required — ProofShot cannot proceed without video capture.\n') +
          chalk.dim('Troubleshooting:\n') +
          chalk.dim('  1. Make sure agent-browser is installed and running\n') +
          chalk.dim('  2. Try "proofshot clean" then re-run "proofshot start"\n') +
          chalk.dim('  3. If the port was already in use, stop the old server first'),
      );
      process.exit(1);
    }
  }

  // ── Save session + print summary ────────────────────────────────────
  saveSession({
    startedAt: new Date().toISOString(),
    description: options.description || null,
    outputDir,
    sessionDir,
    sessionName,
    videoPath,
    serverErrorLog,
    port: config.devServer.port,
    serverCommand: options.run || null,
    serverAlreadyRunning,
    recordingActive: recordingStarted,
    cdpMode,
    daemonSocketPath: cdpMode ? socketPath : undefined,
    viewport: { width: config.viewport.width, height: config.viewport.height },
  });

  console.log('');
  console.log(chalk.green.bold('✅ ProofShot session started'));
  console.log('');
  if (cdpMode) {
    console.log(`CDP:        ${chalk.cyan(options.cdp)}`);
  } else {
    console.log(`Server:     ${options.run ? chalk.cyan(options.run) : chalk.dim('external')} on :${config.devServer.port}`);
  }
  console.log(`Browser:    ${cdpMode ? 'CDP (external)' : `Chromium (${config.headless ? 'headless' : 'headed'})`}`);
  console.log(`Session:    ${chalk.dim(sessionName)}`);
  if (recordingStarted) {
    console.log(`Recording:  ${chalk.dim(videoPath)}`);
  }
  console.log(`Errors log: ${chalk.dim(serverErrorLog)}`);

  if (options.description) {
    console.log(`Verifying:  ${chalk.white(options.description)}`);
  }

  console.log('');
  console.log(chalk.dim('Use proofshot exec to navigate and test:'));
  console.log(chalk.dim('  proofshot exec snapshot -i            # See interactive elements'));
  console.log(chalk.dim('  proofshot exec click @e3              # Click an element'));
  console.log(chalk.dim('  proofshot exec fill @e2 "text"        # Fill a form field'));
  console.log(chalk.dim('  proofshot exec screenshot step.png    # Capture a moment'));
  console.log('');
  console.log(`When done, run: ${chalk.white('proofshot stop')}`);
}
