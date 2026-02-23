import http from 'node:http';

const AUTH_CALLBACK_PATH = '/oauth2/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Ports that currently have an active callback server listening. */
const portsInUse = new Set<number>();

export interface CallbackResult {
  code: string;
  state: string;
}

export interface CallbackServerOptions {
  port: number;
  expectedState: string;
  timeoutMs?: number;
}

function successHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tone — Authorized</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; margin: 0; background: #f0fdf4;
    }
    .card {
      text-align: center; padding: 2.5rem 3rem;
      background: white; border-radius: 1rem;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    .icon { font-size: 3rem; margin-bottom: 0.5rem; }
    h1 { margin: 0 0 0.5rem; color: #166534; font-size: 1.5rem; }
    p { margin: 0; color: #6b7280; font-size: 0.95rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>Authorized</h1>
    <p>Google access granted. You can close this tab — Tone has confirmed via Telegram.</p>
  </div>
</body>
</html>`;
}

function errorHtml(reason: string): string {
  const safeReason = reason.replace(/[<>&"]/g, (char) => {
    const entities: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' };
    return entities[char] ?? char;
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tone — Authorization failed</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; margin: 0; background: #fef2f2;
    }
    .card {
      text-align: center; padding: 2.5rem 3rem;
      background: white; border-radius: 1rem;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    .icon { font-size: 3rem; margin-bottom: 0.5rem; }
    h1 { margin: 0 0 0.5rem; color: #991b1b; font-size: 1.5rem; }
    p { margin: 0.25rem 0; color: #6b7280; font-size: 0.95rem; }
    code { background: #f3f4f6; padding: 0.1rem 0.4rem; border-radius: 0.25rem; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">❌</div>
    <h1>Authorization failed</h1>
    <p>Google returned: <code>${safeReason}</code></p>
    <p>Go back to Telegram and tap <strong>Try again</strong>.</p>
  </div>
</body>
</html>`;
}

/**
 * Starts a temporary local HTTP server on the given port that waits for Google
 * to redirect back with an OAuth authorization code. Resolves when the code is
 * captured and the state parameter matches. Rejects on a Google-reported error,
 * a state mismatch, or when the timeout expires. The server shuts itself down
 * in all cases — success, failure, or timeout.
 *
 * Only one server may be active per port at a time. A second call with the same
 * port while the first is still running rejects immediately.
 */
export const startCallbackServer = (options: CallbackServerOptions): Promise<CallbackResult> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (portsInUse.has(options.port)) {
    return Promise.reject(
      new Error(
        `An authorization flow is already in progress on port ${options.port}. Please wait or try again shortly.`,
      ),
    );
  }

  portsInUse.add(options.port);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      portsInUse.delete(options.port);
      server.close();
      action();
    };

    const server = http.createServer((req, res) => {
      const rawUrl = req.url ?? '/';

      let parsed: URL;
      try {
        parsed = new URL(rawUrl, `http://localhost:${options.port}`);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request.');
        return;
      }

      /* Silently drop common browser noise (favicon etc.) so they don't interfere. */
      if (parsed.pathname !== AUTH_CALLBACK_PATH) {
        res.writeHead(204);
        res.end();
        return;
      }

      const errorParam = parsed.searchParams.get('error');
      if (errorParam) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml(errorParam));
        settle(() => reject(new Error(`Google OAuth error: ${errorParam}`)));
        return;
      }

      const code = parsed.searchParams.get('code') ?? '';
      const state = parsed.searchParams.get('state') ?? '';

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing authorization code.');
        return;
      }

      if (state !== options.expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('State mismatch.');
        settle(() =>
          reject(
            new Error('OAuth state mismatch — possible CSRF. Please tap /connect and try again.'),
          ),
        );
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(successHtml());
      settle(() => resolve({ code, state }));
    });

    server.on('error', (error: NodeJS.ErrnoException) => {
      const message =
        error.code === 'EADDRINUSE'
          ? `Port ${options.port} is already in use. Change GMAIL_REDIRECT_URI to use a different port, or wait a moment and try again.`
          : `OAuth callback server error: ${error.message}`;
      settle(() => reject(new Error(message)));
    });

    timer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            'Google authorization timed out after 5 minutes. Tap /connect and try again when ready.',
          ),
        ),
      );
    }, timeoutMs);

    server.listen(options.port);
  });
};

/**
 * Parses the port number from a redirect URI such as http://localhost:8085/oauth2/callback.
 * Falls back to 8085 if the URI cannot be parsed or contains no explicit port.
 */
export const extractPortFromRedirectUri = (redirectUri: string): number => {
  try {
    const url = new URL(redirectUri);
    const port = parseInt(url.port, 10);
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return 8085;
  }
};
