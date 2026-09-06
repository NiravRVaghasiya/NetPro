import type { ProfileCard } from "@netpro/core/src/card/types";
import { PROFILE_CARD_CSS } from "@netpro/core/src/card/styles";
import {
  profileEmailHref,
  profileInitials,
  profilePhoneHref,
} from "@netpro/core/src/card/presentation";
import { safeProfileUrl } from "@netpro/core/src/card/validation";

/** Receives public fields only. Also used by the owner-only, unsaved form preview. */
export function ProfileCardView({
  profile,
  downloadHref,
  preview = false,
}: {
  profile: ProfileCard;
  downloadHref?: string;
  preview?: boolean;
}) {
  const occupation = [profile.role, profile.company]
    .filter(Boolean)
    .join(" at ");
  // A preview may contain an incomplete or unsafe URL while the user types.
  const links = profile.links.flatMap((link) => {
    const url = safeProfileUrl(link.url);
    return url && link.label.trim() ? [{ ...link, url }] : [];
  });
  return (
    <>
      <style>{PROFILE_CARD_CSS}</style>
      <article className="np-card">
        <header className="np-card-top">
          <p className="np-card-kicker">A little introduction</p>
          <span className="np-card-mark">
            <i aria-hidden="true" /> NetPro
          </span>
        </header>
        <div className="np-card-main">
          <div className="np-card-avatar" aria-hidden="true">
            {profileInitials(profile.fullName)}
          </div>
          <h1>{profile.fullName}</h1>
          {profile.headline && (
            <p className="np-card-headline">{profile.headline}</p>
          )}
          {(occupation || profile.location) && (
            <div className="np-card-facts">
              {occupation && <span>{occupation}</span>}
              {profile.location && <span>{profile.location}</span>}
            </div>
          )}
          {profile.bio && <p className="np-card-bio">{profile.bio}</p>}
          {links.length > 0 && (
            <nav className="np-card-links" aria-label="Profile links">
              {links.map((link, index) => (
                <a
                  key={`${link.url}-${index}`}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  <span>{link.label}</span>
                  <b aria-hidden="true">↗</b>
                </a>
              ))}
            </nav>
          )}
        </div>
        {(profile.email || profile.phone || downloadHref || preview) && (
          <footer className="np-card-footer">
            <p className="np-card-kicker">Keep in touch</p>
            <div className="np-card-actions">
              {profile.email && (
                <a href={profileEmailHref(profile.email)}>Say hello ↗</a>
              )}
              {downloadHref ? (
                <a
                  className="np-card-secondary"
                  href={downloadHref}
                  download="contact.vcf"
                >
                  Save contact ↓
                </a>
              ) : (
                preview && (
                  <span className="np-card-secondary" aria-hidden="true">
                    Save contact ↓
                  </span>
                )
              )}
            </div>
            {(profile.email || profile.phone) && (
              <div className="np-card-contact">
                {profile.email && (
                  <a href={profileEmailHref(profile.email)}>{profile.email}</a>
                )}
                {profile.phone && (
                  <a href={profilePhoneHref(profile.phone)}>{profile.phone}</a>
                )}
              </div>
            )}
          </footer>
        )}
      </article>
    </>
  );
}
