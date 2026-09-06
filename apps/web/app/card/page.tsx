import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProfileCardView } from "@/components/profile-card";
import { loadPublishedProfile } from "@/lib/public-card";
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

export default async function PublicCardPage() {
  const profile = await loadPublishedProfile();
  if (!profile) notFound();
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
    </main>
  );
}
