import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProfileCardView } from "@/components/profile-card";
import { loadPublishedProfile } from "@/lib/public-card";
import { viewsDisabled } from "@/lib/beacon";
import { profileDescription } from "@netpro/core/src/card/presentation";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const profile = await loadPublishedProfile();
  const privacy: Metadata = {
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
  if (!profile) return { ...privacy, title: "Card unavailable — NetPro" };
  const title = `${profile.fullName} — NetPro`;
  const description = profileDescription(profile);
  return {
    ...privacy,
    title,
    description,
    openGraph: { title, description, type: "profile", siteName: "NetPro" },
    twitter: { card: "summary", title, description },
  };
}

// v2.5 Phase 2 — the view beacon. Exactly one row per visit:
//
//   * Without JS the <noscript> pixel loads (no duration available).
//   * With JS, navigator.sendBeacon fires on pagehide and reports the read
//     duration (and the ?v= contact-resolution token, which the pixel never
//     loads in a JS browser).
//
// No cookies, no third parties, no inline state beyond the token literal
// injected below. When NETPRO_DISABLE_VIEWS=true nothing is rendered at
// all. This is a plain STRING — it must never be evaluated server-side.
const VIEW_BEACON_SCRIPT = `(() => {
  const start = Date.now();
  let sent = false;
  const send = () => {
    if (sent) return;
    sent = true;
    const payload = {
      page: "/card",
      durationMs: Math.min(Date.now() - start, 3600000),
    };
    if (window.__NETPRO_VIEW_TOKEN__) payload.viewToken = window.__NETPRO_VIEW_TOKEN__;
    try {
      const blob = new Blob([JSON.stringify(payload)], {
        type: "application/json",
      });
      if (typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon("/api/card/view", blob);
      } else {
        fetch("/api/card/view", {
          method: "POST",
          body: JSON.stringify(payload),
          headers: { "Content-Type": "application/json" },
          keepalive: true,
        });
      }
    } catch {
      /* a view is best-effort; the card must never break */
    }
  };
  window.addEventListener("pagehide", send);
})();`;

export default async function PublicCardPage(
  {
    searchParams,
  }: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
  } = {},
) {
  const profile = await loadPublishedProfile();
  if (!profile) notFound();
  const sp = (await searchParams) ?? {};
  const trackingEnabled = !viewsDisabled();
  // An owner-minted ?v= token (HMAC, 30-day cap) marks whose card this is;
  // cryptographic validation happens server-side at ingestion, never here.
  // The base64url charset check here is what keeps the token safe to embed
  // in the inline beacon script.
  const viewToken =
    typeof sp.v === "string" &&
    sp.v.length > 0 &&
    sp.v.length <= 512 &&
    /^[A-Za-z0-9_-]+$/.test(sp.v)
      ? sp.v
      : null;
  const pixelUrl = trackingEnabled
    ? `/api/card/pixel.gif?p=/card${
        viewToken ? `&v=${encodeURIComponent(viewToken)}` : ""
      }`
    : null;
  return (
    <main className="min-h-screen bg-[#f3f5ef] px-5 py-12 sm:py-16">
      <div className="mx-auto max-w-[600px]">
        <ProfileCardView profile={profile} downloadHref="/card/vcard" />
        <p className="mt-6 text-center text-xs leading-6 text-[#627366]">
          Your network, owned by you. Made with{" "}
          <a className="underline underline-offset-4" href="/">
            NetPro
          </a>
          .
        </p>
      </div>
      {pixelUrl && (
        <noscript>
          <img
            src={pixelUrl}
            width={1}
            height={1}
            alt=""
            aria-hidden="true"
            style={{ position: "absolute", left: "-9999px" }}
          />
        </noscript>
      )}
      {trackingEnabled && (
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__NETPRO_VIEW_TOKEN__=${JSON.stringify(viewToken)};${VIEW_BEACON_SCRIPT}`,
          }}
        />
      )}
    </main>
  );
}
