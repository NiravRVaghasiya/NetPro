// packages/server — NetPro local-first HTTP server
//
// Phase 1: standalone package that builds independently, imports @netpro/core
// and @netpro/db, and does not depend on Vercel or apps/web.
//
// Phase 2: `runServe` powers `netpro serve` (and this package's standalone
// bin). Phase 5: authentication is a local installation identity plus optional
// access token — no GitHub OAuth required to run. Later phases add: full API
// (Phase 6), jobs (Phase 7), SSE (Phase 8).

export { loadConfig, DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT, type ServerConfig } from './config';
export { createApp, type NetProApp, type CreateAppOptions } from './app';
export { startServer, type RunningServer, type StartServerOptions } from './server';
export {
  runServe,
  main,
  isLoopbackHost,
  friendlyListenError,
  prepareAuthPolicy,
  type RunServeOptions,
  type ServeHandle,
  type ServeStopReason,
} from './serve';
export {
  AUTH_MODES,
  DEFAULT_AUTH_MODE,
  authStartupDiagnostics,
  describeAuthPolicy,
  extractCredential,
  isDirectLoopbackRequest,
  isLoopbackAddress,
  loadAuthPolicy,
  resolveAuthContext,
  resolveAuthMode,
  tokensEqual,
  type AuthContext,
  type AuthKind,
  type AuthMode,
  type AuthPolicy,
  type AuthRequestInfo,
} from './auth/index';
export { createJobRegistry, JobRegistry, type Job, type JobStatus, type JobType } from './jobs/index';
export { createEventBus, EventBus, type NetProEvent } from './events/index';
export { dispatch, isPublicApiPath, PUBLIC_API_PATHS, type RouteContext } from './routes/index';
export { handleHealth, type HealthBody, type HealthDeps } from './routes/health';
export {
  renderHomeHtml,
  handleHome,
  handleLocked,
  renderLockedHtml,
  SERVER_VERSION,
  type HomeInfo,
  type LockedInfo,
} from './routes/home';
