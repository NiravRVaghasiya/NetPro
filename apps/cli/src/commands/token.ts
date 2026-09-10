import type { Command } from 'commander';
import type { EnsureAccessTokenResult } from '@netpro/db';

export interface TokenCommandOptions {
  /** Replace the existing token with a fresh one. */
  rotate?: boolean;
  /** Print only the path (scripts: `cat $(netpro token --path)`). */
  path?: boolean;
  /** Machine-readable output. */
  json?: boolean;
}

export interface TokenResult extends EnsureAccessTokenResult {
  /** True when `--rotate` replaced a token that already existed. */
  rotated: boolean;
  /** Display-safe preview of the token (`np_2c9…Kf4`). */
  preview: string;
}

export type TokenDeps = {
  /** Environment overlay (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
};

/**
 * `netpro token` — show (or create/rotate) the local access token.
 *
 * Phase 5: loopback requests are trusted, so the token matters exactly when
 * the server is reachable from somewhere else — `netpro serve --host 0.0.0.0`,
 * a reverse proxy, or a container. Showing it is deliberate: it is the user's
 * own machine, the file is mode 0600, and a secret the user cannot read is a
 * secret they will work around. `netpro serve` itself only ever prints a
 * redacted preview.
 */
export async function executeToken(
  options: TokenCommandOptions = {},
  deps: TokenDeps = {}
): Promise<TokenResult> {
  const {
    ensureAccessToken,
    generateAccessToken,
    readAccessToken,
    redactAccessToken,
    writeAccessToken,
  } = await import('@netpro/db');
  const env = deps.env ?? process.env;

  if (!options.rotate) {
    const result = ensureAccessToken(env);
    return {
      ...result,
      rotated: false,
      preview: redactAccessToken(result.token),
    };
  }

  // Rotation replaces whatever is there. On a fresh install there is nothing
  // to replace, so the honest report is "created", not "rotated".
  const hadToken = readAccessToken(env) !== null;
  const token = generateAccessToken();
  const path = writeAccessToken(token, env);
  return {
    token,
    path,
    created: !hadToken,
    rotated: hadToken,
    preview: redactAccessToken(token),
  };
}

export function formatToken(result: TokenResult, options: TokenCommandOptions = {}): string {
  if (options.path) return result.path;
  const state = result.rotated
    ? 'replaced'
    : result.created
      ? 'created'
      : 'existing';
  return [
    'NetPro access token',
    '',
    `Token:    ${result.token}`,
    `Stored:   ${result.path} (mode 0600, ${state})`,
    '',
    'Use it for requests that do not come from this machine:',
    `  curl -H "Authorization: Bearer ${result.preview}" http://127.0.0.1:3777/api/identity`,
    '',
    'Loopback requests (this machine) are trusted and need no token.',
    'Rotate with `netpro token --rotate`; existing sessions keep working until then.',
  ].join('\n');
}

export function registerTokenCommand(program: Command): void {
  program
    .command('token')
    .description('Show the local access token (used for remote/non-loopback access)')
    .option('--rotate', 'Replace the existing token with a fresh one')
    .option('--path', 'Print only the token file path')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (options: TokenCommandOptions) => {
      try {
        const result = await executeToken(options);
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                token: result.token,
                path: result.path,
                created: result.created,
                rotated: result.rotated,
              },
              null,
              2
            )
          );
        } else {
          console.log(formatToken(result, options));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`✗ netpro token failed: ${message}`);
        process.exitCode = 1;
      }
    });
}
