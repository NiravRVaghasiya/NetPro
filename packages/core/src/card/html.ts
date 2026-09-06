import type { ProfileCard } from "./types";
import { validateProfileCard } from "./validation";
import { renderProfileVCard } from "./vcard";
import {
  profileDescription,
  profileEmailHref,
  profileInitials,
  profilePhoneHref,
} from "./presentation";
import { PROFILE_CARD_CSS } from "./styles";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Offline artifact: no JS, tracking pixels, remote fonts, database, or hosting required. */
export function renderProfileCardHtml(input: ProfileCard): string {
  const profile = validateProfileCard(input);
  const e = escapeHtml;
  const occupation = [profile.role, profile.company]
    .filter(Boolean)
    .join(" at ");
  const facts = [occupation, profile.location].filter(Boolean);
  const emailHref = profileEmailHref(profile.email);
  const download = `data:text/vcard;charset=utf-8,${encodeURIComponent(renderProfileVCard(profile))}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${e(profileDescription(profile))}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${e(profile.fullName)} — Networking card</title>
<style>${PROFILE_CARD_CSS}
body{margin:0;padding:48px 20px;background:#f3f5ef;min-height:100vh;box-sizing:border-box}main{max-width:600px;margin:auto}.credit{text-align:center;font:12px/1.7 system-ui,sans-serif;color:#627366;margin:24px 0}
</style>
</head>
<body><main>
<article class="np-card">
<header class="np-card-top"><p class="np-card-kicker">A little introduction</p><span class="np-card-mark"><i aria-hidden="true"></i> NetPro</span></header>
<div class="np-card-main">
<div class="np-card-avatar" aria-hidden="true">${e(profileInitials(profile.fullName))}</div>
<h1>${e(profile.fullName)}</h1>
${profile.headline ? `<p class="np-card-headline">${e(profile.headline)}</p>` : ""}
${facts.length ? `<div class="np-card-facts">${facts.map((fact) => `<span>${e(fact)}</span>`).join("")}</div>` : ""}
${profile.bio ? `<p class="np-card-bio">${e(profile.bio)}</p>` : ""}
${profile.links.length ? `<nav class="np-card-links" aria-label="Profile links">${profile.links.map((link) => `<a href="${e(link.url)}" target="_blank" rel="noopener noreferrer nofollow"><span>${e(link.label)}</span><b aria-hidden="true">↗</b></a>`).join("")}</nav>` : ""}
</div>
<footer class="np-card-footer"><p class="np-card-kicker">Keep in touch</p><div class="np-card-actions">
${profile.email ? `<a href="${e(emailHref)}">Say hello ↗</a>` : ""}
<a class="np-card-secondary" href="${e(download)}" download="contact.vcf">Save contact ↓</a>
</div>
${profile.email || profile.phone ? `<div class="np-card-contact">${profile.email ? `<a href="${e(emailHref)}">${e(profile.email)}</a>` : ""}${profile.phone ? `<a href="${e(profilePhoneHref(profile.phone))}">${e(profile.phone)}</a>` : ""}</div>` : ""}
</footer></article>
<p class="credit">Your network, owned by you. Made with NetPro.</p>
</main></body></html>\n`;
}
