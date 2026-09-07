// GET /api/skills/gap?role=&description=&skills=&contact=&limit=
// v2.0 Phase 5 — the skills gap analyzer API. Owner-only (proxy boundary).
// Without `contact` the whole live network is analysed: per-skill coverage,
// the skills nobody has, and the best individual matches. With `contact`, one
// person is compared against the target (unknown → 404, ambiguous → 400 via
// the shared resolver). Everything is computed offline from the bounded
// taxonomy — no AI call, no key, no side effects.
import { conn } from '@/lib/db';
import {
  analyzeNetworkGaps,
  gapAnalysis,
  getSkillsProfile,
  loadSkillContacts,
  parseTarget,
} from '@netpro/core/src/skills';
import { crmErrorResponse, crmJson } from '@/lib/crm-request';
import { boundedInt, resolveOptionalContact, skillTargetParams } from '@/lib/skills-request';

export async function GET(request: Request): Promise<Response> {
  const sp = new URL(request.url).searchParams;
  try {
    const target = skillTargetParams(sp);
    const ref = await resolveOptionalContact(conn, sp.get('contact'));
    if (ref) {
      const profile = await getSkillsProfile(conn, ref.id);
      if (!profile) return crmJson({ error: `No contact found with id "${ref.id}".` }, 404);
      const parsed = parseTarget(target);
      // Evidence beats a stale stored verdict, but an owner/AI claim the text
      // no longer supports still counts — the union is what the CLI uses too.
      const gap = gapAnalysis(parsed, new Set<string>([...profile.current.skills, ...profile.stored]));
      return crmJson({
        contact: { id: ref.id, fullName: ref.fullName, email: ref.email, company: ref.company, role: ref.role },
        target: parsed,
        gap,
      });
    }

    const contacts = await loadSkillContacts(conn);
    const analysis = analyzeNetworkGaps(target, contacts, {
      candidates: boundedInt(sp.get('limit'), 10, 1, 100),
      perSkill: boundedInt(sp.get('perSkill'), 5, 1, 50),
    });
    return crmJson(analysis);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
