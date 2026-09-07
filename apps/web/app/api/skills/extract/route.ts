// POST /api/skills/extract  { mode?, contact?, dryRun?, limit? }
// GET  /api/skills/extract  → coverage counts
// v2.0 Phase 5 — (re)derive and store skills for the owner's contacts.
// Owner-only (proxy boundary). Heuristic by default and fully offline; the AI
// pass is opt-in per request and uses the host-configured BYO key from the
// server environment — the browser never sees or sends a key. A failed AI
// pass degrades to the heuristic result and is reported, never hidden.
import { conn } from '@/lib/db';
import { resolveAiProvider, AiProviderError } from '@netpro/core/src/ai';
import { extractSkillsBatch, skillsStatus } from '@netpro/core/src/skills';
import { crmErrorResponse, crmJson, readCrmJson } from '@/lib/crm-request';
import { extractModeParam, resolveOptionalContact } from '@/lib/skills-request';

/** Read AI credentials from the server environment (host-configured BYO key). */
function credentialsFromEnv(explicitProvider?: string) {
  const provider = explicitProvider ?? process.env.AI_PROVIDER;
  const model =
    process.env.AI_MODEL ?? (provider === 'anthropic' ? process.env.ANTHROPIC_MODEL : process.env.OPENAI_MODEL);
  return {
    provider,
    openaiKey: process.env.OPENAI_API_KEY ?? null,
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? null,
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? null,
    model: model || undefined,
  };
}

export async function GET(): Promise<Response> {
  try {
    return crmJson(await skillsStatus(conn));
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    // An empty body is fine — "extract everything, heuristically" is the
    // common case — but a present body must be well-formed JSON.
    const hasBody = request.headers.get('content-length') !== '0' && request.body !== null;
    const body = hasBody ? await readCrmJson(request) : {};

    const mode = extractModeParam(body.mode);
    const dryRun = body.dryRun === true;
    const ref = await resolveOptionalContact(conn, typeof body.contact === 'string' ? body.contact : null);
    const rawLimit = body.limit;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit >= 1
        ? Math.min(Math.trunc(rawLimit), 10_000)
        : undefined;

    let provider = null;
    let model: string | undefined;
    if (mode === 'ai') {
      const explicit = typeof body.provider === 'string' ? body.provider.trim() : undefined;
      if (explicit && explicit !== 'openai' && explicit !== 'anthropic') {
        return crmJson({ error: 'Invalid provider — expected "openai" or "anthropic".' }, 400);
      }
      const credentials = credentialsFromEnv(explicit || undefined);
      provider = resolveAiProvider(credentials);
      model = credentials.model;
    }

    const summary = await extractSkillsBatch(conn, {
      mode,
      provider,
      model,
      dryRun,
      contactIds: ref ? [ref.id] : undefined,
      limit,
    });
    return crmJson(summary);
  } catch (error) {
    if (error instanceof AiProviderError) {
      if (error.code === 'not_configured') {
        return crmJson({ error: error.message, code: 'ai_not_configured' }, 500);
      }
      return crmJson({ error: error.message, code: 'ai_upstream_error' }, 502);
    }
    return crmErrorResponse(error);
  }
}
