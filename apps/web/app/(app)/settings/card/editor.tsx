"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ProfileCardView } from "@/components/profile-card";
// Import pure entry points, never the card barrel (which also exports database IO).
import {
  PROFILE_LIMITS,
  type ProfileCard,
  type ProfileCardState,
} from "@netpro/core/src/card/types";
import { validateProfileCard } from "@netpro/core/src/card/validation";

const EMPTY_CARD: ProfileCard = {
  fullName: "",
  headline: "",
  bio: "",
  company: "",
  role: "",
  location: "",
  email: "",
  phone: "",
  links: [],
};
const inputClass =
  "mt-1.5 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-700/15 disabled:opacity-60";
const secondaryButton =
  "rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-50";
type TextField = Exclude<keyof ProfileCard, "links">;
type Action = "save" | "publish" | "unpublish";

function Field({
  field,
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  field: TextField;
  label: string;
  value: string;
  onChange: (field: TextField, value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block text-sm font-medium text-slate-700">
      {label}
      {field === "fullName" && <span className="text-emerald-800"> *</span>}
      <input
        className={inputClass}
        value={value}
        type={type}
        autoComplete="off"
        required={field === "fullName"}
        maxLength={PROFILE_LIMITS[field]}
        placeholder={placeholder}
        onChange={(event) => onChange(field, event.target.value)}
      />
    </label>
  );
}

export default function CardEditor({
  initialState,
}: {
  initialState: ProfileCardState;
}) {
  const [state, setState] = useState(initialState);
  const [form, setForm] = useState<ProfileCard>(
    initialState.draft ?? EMPTY_CARD,
  );
  const [busy, setBusy] = useState<Action | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [publicUrl, setPublicUrl] = useState("/card");
  useEffect(() => {
    setPublicUrl(new URL("/card", window.location.href).href);
  }, []);

  const isPublished = state.published !== null;
  const dirty =
    JSON.stringify(form) !== JSON.stringify(state.draft ?? EMPTY_CARD);
  const preview = { ...form, fullName: form.fullName || "Your name" };

  function change(update: (previous: ProfileCard) => ProfileCard) {
    setForm(update);
    setConsent(false);
    setMessage("");
    setError("");
  }
  function setField(field: TextField, value: string) {
    change((previous) => ({ ...previous, [field]: value }));
  }

  async function persist(action: Action) {
    if (busy || (action === "publish" && !consent)) return;
    setError("");
    setMessage("");
    setNeedsLogin(false);
    let profile: ProfileCard | undefined;
    try {
      if (action !== "unpublish") profile = validateProfileCard(form);
    } catch (failure) {
      setError((failure as Error).message);
      return;
    }
    setBusy(action);
    try {
      const response = await fetch("/api/card", {
        method:
          action === "save" ? "PUT" : action === "publish" ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        ...(profile ? { body: JSON.stringify(profile) } : {}),
      });
      const result = (await response.json()) as ProfileCardState & {
        error?: string;
      };
      if (!response.ok) {
        setNeedsLogin(response.status === 401);
        setError(
          response.status === 401
            ? "Your session expired. Sign in again before saving."
            : (result.error ??
                "The card could not be saved. Please try again."),
        );
        return;
      }
      setState(result);
      // Unpublishing must not discard any unsaved form edits.
      if (action !== "unpublish" && result.draft) setForm(result.draft);
      setConsent(false);
      setMessage(
        action === "save"
          ? "Draft saved. Your public card has not changed."
          : action === "publish"
            ? "Your card is published and ready to share."
            : "Card unpublished. Your saved draft is still here.",
      );
    } catch {
      setError(
        "Couldn’t reach NetPro. Your unsaved changes are still here; please try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    void persist("save");
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setMessage("Public link copied.");
    } catch {
      setError(
        "Couldn’t copy automatically. Select and copy the URL below instead.",
      );
    }
  }

  function downloadJson() {
    try {
      const profile = validateProfileCard(form);
      const url = URL.createObjectURL(
        new Blob([`${JSON.stringify(profile, null, 2)}\n`], {
          type: "application/json",
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "profile.json";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("Profile JSON downloaded. This does not publish your card.");
    } catch (failure) {
      setError((failure as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-6xl py-6 sm:py-10">
      <div className="mb-9 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/settings"
            className="text-xs font-medium text-slate-500 hover:text-emerald-800"
          >
            ← Settings
          </Link>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[#183c30]">
            Your profile card
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            A thoughtful introduction, ready to share. Only the details you
            choose.
          </p>
        </div>
        <span
          className={`mt-7 rounded-full px-3 py-1.5 text-xs font-medium ${isPublished ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-600"}`}
        >
          {isPublished ? "● Published" : "○ Private · not published"}
        </span>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          {error}
          {needsLogin && (
            <>
              {" "}
              <Link className="underline" href="/login">
                Sign in again
              </Link>
            </>
          )}
        </div>
      )}
      <div
        role="status"
        aria-live="polite"
        className={
          message
            ? "mb-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
            : "sr-only"
        }
      >
        {message}
      </div>

      <div className="grid items-start gap-10 lg:grid-cols-[1.1fr_1fr]">
        <form onSubmit={save}>
          <fieldset disabled={busy !== null} className="space-y-7">
            <legend className="sr-only">Public profile details</legend>
            <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
              <h2 className="text-sm font-semibold text-[#183c30]">
                01 — The introduction
              </h2>
              <Field
                field="fullName"
                label="Full name"
                value={form.fullName}
                onChange={setField}
                placeholder="How you’d like to be introduced"
              />
              <Field
                field="headline"
                label="Headline"
                value={form.headline}
                onChange={setField}
                placeholder="What you do, in your own words"
              />
              <div>
                <label
                  htmlFor="profile-bio"
                  className="block text-sm font-medium text-slate-700"
                >
                  About you
                </label>
                <textarea
                  id="profile-bio"
                  className={inputClass}
                  rows={4}
                  value={form.bio}
                  maxLength={PROFILE_LIMITS.bio}
                  placeholder="What are you building, exploring, or looking to connect about?"
                  onChange={(event) => setField("bio", event.target.value)}
                />
              </div>
              <p className="text-right text-xs text-slate-400">
                {form.bio.length.toLocaleString("en-US")} / 2,000
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  field="role"
                  label="Role"
                  value={form.role}
                  onChange={setField}
                  placeholder="Your role"
                />
                <Field
                  field="company"
                  label="Company"
                  value={form.company}
                  onChange={setField}
                  placeholder="Where you work"
                />
              </div>
              <Field
                field="location"
                label="Location"
                value={form.location}
                onChange={setField}
                placeholder="City, country, or anywhere"
              />
            </section>

            <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
              <h2 className="text-sm font-semibold text-[#183c30]">
                02 — Ways to connect
              </h2>
              <p className="text-xs leading-5 text-slate-500">
                Optional. Email and phone will be public and included in the
                contact download if you publish them.
              </p>
              <Field
                field="email"
                label="Email (public)"
                type="email"
                value={form.email}
                onChange={setField}
                placeholder="hello@example.com"
              />
              <Field
                field="phone"
                label="Phone (public)"
                type="tel"
                value={form.phone}
                onChange={setField}
                placeholder="+1 555 010 1234"
              />
              <div className="border-t border-slate-100 pt-4">
                <p className="mb-3 text-sm font-medium text-slate-700">
                  Your links{" "}
                  <span className="font-normal text-slate-400">· up to 6</span>
                </p>
                <div className="space-y-3">
                  {form.links.map((link, index) => (
                    <div
                      key={index}
                      className="rounded-lg border border-slate-100 bg-slate-50 p-3"
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs text-slate-500">
                          Link {index + 1}
                        </span>
                        <button
                          type="button"
                          className="text-xs text-slate-500 underline hover:text-red-700"
                          aria-label={`Remove link ${index + 1}`}
                          onClick={() =>
                            change((previous) => ({
                              ...previous,
                              links: previous.links.filter(
                                (_, i) => i !== index,
                              ),
                            }))
                          }
                        >
                          Remove
                        </button>
                      </div>
                      <label className="block text-xs font-medium text-slate-600">
                        Link {index + 1} label
                        <input
                          className={inputClass}
                          value={link.label}
                          required
                          maxLength={PROFILE_LIMITS.linkLabel}
                          placeholder="Portfolio, GitHub, LinkedIn…"
                          onChange={(event) =>
                            change((previous) => ({
                              ...previous,
                              links: previous.links.map((item, i) =>
                                i === index
                                  ? { ...item, label: event.target.value }
                                  : item,
                              ),
                            }))
                          }
                        />
                      </label>
                      <label className="mt-2 block text-xs font-medium text-slate-600">
                        Link {index + 1} URL
                        <input
                          className={inputClass}
                          value={link.url}
                          required
                          type="url"
                          maxLength={PROFILE_LIMITS.linkUrl}
                          placeholder="https://"
                          onChange={(event) =>
                            change((previous) => ({
                              ...previous,
                              links: previous.links.map((item, i) =>
                                i === index
                                  ? { ...item, url: event.target.value }
                                  : item,
                              ),
                            }))
                          }
                        />
                      </label>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className={`${secondaryButton} mt-3 w-full`}
                  disabled={form.links.length >= PROFILE_LIMITS.links}
                  onClick={() =>
                    change((previous) => ({
                      ...previous,
                      links: [...previous.links, { label: "", url: "" }],
                    }))
                  }
                >
                  + Add a link
                </button>
              </div>
            </section>

            <section className="space-y-4 rounded-xl border border-[#dce3dc] bg-[#f4f6f0] p-5 sm:p-6">
              <h2 className="text-sm font-semibold text-[#183c30]">
                03 — You decide what goes live
              </h2>
              <p className="text-xs leading-6 text-[#526459]">
                Saving a draft never changes your public card. Publishing shares
                every filled field with anyone who has the link. Unpublishing
                cannot recall downloaded or copied details.
              </p>
              <label className="flex items-start gap-3 text-sm leading-6 text-[#234333]">
                <input
                  className="mt-1 h-4 w-4 shrink-0 accent-[#214e3b]"
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                I’ve reviewed the preview and want to make these details public.
              </label>
              <div className="flex flex-wrap gap-3">
                <button type="submit" className={secondaryButton}>
                  {busy === "save" ? "Saving…" : "Save draft"}
                </button>
                <button
                  type="button"
                  disabled={!consent || busy !== null}
                  onClick={() => void persist("publish")}
                  className="rounded-lg bg-[#214e3b] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#183c30] focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy === "publish"
                    ? "Publishing…"
                    : isPublished
                      ? "Publish changes"
                      : "Publish card"}
                </button>
                {isPublished && (
                  <button
                    type="button"
                    onClick={() => void persist("unpublish")}
                    className="px-2 py-2.5 text-sm text-red-700 underline underline-offset-4"
                  >
                    {busy === "unpublish" ? "Unpublishing…" : "Unpublish"}
                  </button>
                )}
              </div>
              <p className="text-xs text-[#627366]">
                {dirty
                  ? "You have unsaved changes."
                  : state.updatedAt
                    ? `Last saved ${state.updatedAt.slice(0, 16).replace("T", " ")} UTC`
                    : "No draft saved yet. Nothing is public."}
              </p>
            </section>
          </fieldset>
        </form>

        <aside className="space-y-5 lg:sticky lg:top-8">
          <div className="flex items-center justify-between px-1 text-xs">
            <h2 className="font-semibold uppercase tracking-[0.15em] text-slate-500">
              Private preview
            </h2>
            <span className="text-slate-400">Updates as you type</span>
          </div>
          <ProfileCardView profile={preview} preview />
          <div className="rounded-xl border border-slate-200 p-5">
            <h2 className="text-sm font-semibold text-[#183c30]">
              Your shareable link
            </h2>
            <input
              aria-label="Public card URL"
              className={`${inputClass} font-mono text-xs`}
              readOnly
              value={publicUrl}
              onFocus={(event) => event.target.select()}
            />
            {isPublished ? (
              <div className="mt-3 flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={() => void copyLink()}
                  className={secondaryButton}
                >
                  Copy link
                </button>
                <a
                  href="/card"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-emerald-800 underline underline-offset-4"
                >
                  View published card ↗
                </a>
              </div>
            ) : (
              <p className="mt-3 text-xs leading-5 text-slate-500">
                This link returns “not available” until you publish. The preview
                is visible only to you.
              </p>
            )}
          </div>
          <div className="px-1">
            <button
              type="button"
              disabled={busy !== null}
              onClick={downloadJson}
              className="text-sm font-medium text-slate-600 underline underline-offset-4"
            >
              Download profile JSON ↓
            </button>
            <p className="mt-2 text-xs leading-6 text-slate-400">
              Take it with you. Use{" "}
              <code>netpro card --generate --input profile.json</code> for a
              standalone HTML card, or add <code>--format vcard</code>.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
