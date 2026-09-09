// apps/web/app/(app)/settings/card/tracking-panel.tsx — v2.5 Phase 2: the
// owner-facing privacy documentation and embed snippet for profile-view
// tracking; v2.5 Phase 6: the retention windows it documents read the same
// env config the purge job uses, so the panel can never promise a different
// horizon than the database honours. Server-rendered, dumb by design (the
// page resolves the origin) so it renders in unit tests without request
// headers.
import { viewsDisabled } from "@/lib/beacon";
import { retentionConfig } from "@/lib/retention";

export function CardTrackingPanel({ origin }: { origin: string }) {
  const enabled = !viewsDisabled();
  const retention = retentionConfig();
  const pixelSnippet = `<img src="${origin}/api/card/pixel.gif?p=blog" width="1" height="1" alt="">`;
  return (
    <section className="space-y-4 rounded-xl border border-[#dce3dc] bg-[#f4f6f0] p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-[#183c30]">Profile view tracking</h2>
        <span
          className={
            enabled
              ? "rounded-full bg-[#e2efe4] px-2.5 py-0.5 text-xs font-medium text-[#2c5e43]"
              : "rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-600"
          }
        >
          {enabled ? "Enabled" : "Disabled (NETPRO_DISABLE_VIEWS)"}
        </span>
      </div>
      <div className="space-y-3 text-sm leading-6 text-[#44534a]">
        <p>
          {enabled
            ? "Visitors to your public card and embeds are counted so you can see who views your profile. The beacon sets no cookies and talks to no third parties."
            : "View tracking is switched off for this instance: the beacon endpoints answer but store nothing, and no tracking markup is served."}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="font-semibold text-[#183c30]">
              Stored ({retention.viewRetentionDays} days, then purged)
            </h3>
            <ul className="list-disc space-y-1 pl-5">
              <li>a 16-character salted hash of IP + browser (rotates daily — never reversible)</li>
              <li>bot / owner-view labels (excluded from your counts)</li>
              <li>referring site (domain + path, never its query string)</li>
              <li>country / city from your hosting platform’s headers, if present</li>
              <li>utm_source / utm_medium / utm_campaign and optional read duration</li>
            </ul>
          </div>
          <div>
            <h3 className="font-semibold text-[#183c30]">Never stored</h3>
            <ul className="list-disc space-y-1 pl-5">
              <li>raw IP addresses, emails, or cookies of any kind</li>
              <li>cross-day or cross-session identifiers (hashes rotate daily)</li>
              <li>anything from Do-Not-Track / Global-Privacy-Control visitors beyond the bare count</li>
            </ul>
          </div>
        </div>
        <p className="text-xs text-[#627366]">
          A daily job enforces the window (at most one run per 24 h, audited in
          the activity log). The content tracker’s engagement snapshots are kept
          for {retention.contentMetricRetentionDays} days — the latest snapshot
          per piece always survives, even when it is older.
        </p>
        <div>
          <h3 className="font-semibold text-[#183c30]">Embed on your blog or portfolio</h3>
          <p className="mb-2">
            Paste this just before <code className="rounded bg-white px-1.5 py-0.5 text-xs">&lt;/body&gt;</code>. It
            sends one 1-pixel request when the page loads — no JavaScript required.
          </p>
          <pre className="overflow-x-auto rounded-lg border border-[#dce3dc] bg-white p-3 text-xs leading-5 text-[#31413a]">
            <code>{pixelSnippet}</code>
          </pre>
          <p className="mt-2 text-xs text-[#627366]">
            Share a personalized link —{" "}
            <code className="rounded bg-white px-1.5 py-0.5">
              {origin}/card?v=…
            </code>{" "}
            — to a contact and their visits are attributed to them in your
            view analytics. The token is signed by this instance, expires
            after 30 days, and a link to an unknown or deleted contact is
            ignored.
          </p>
        </div>
      </div>
    </section>
  );
}
