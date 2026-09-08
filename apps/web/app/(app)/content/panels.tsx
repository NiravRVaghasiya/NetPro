"use client";

// apps/web/app/(app)/content/panels.tsx
//
// The interactive pieces of /content and /content/[id]. Every mutation goes
// through the owner-only APIs; nothing here holds a key or a connection
// string. Three ideas carry the panels:
//
//   * **Idempotent adds.** A duplicate URL returns the existing row with
//     `created: false` — the form says so instead of erroring.
//   * **Preview before write.** The CSV/feed import defaults to a dry run;
//     per-row problems are rendered, and the import writes nothing until the
//     owner asks.
//   * **Manual numbers are the product.** No provider runs without an
//     explicit fetch, and in v2.5 every API provider is a disabled stub —
//     so the snapshot form is where engagement numbers come from.
import { useState } from "react";
import { useRouter } from "next/navigation";

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(
    url: string,
    method: string,
    body?: unknown,
  ): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers:
          body instanceof FormData
            ? undefined
            : { "Content-Type": "application/json" },
        body:
          body instanceof FormData
            ? body
            : body
              ? JSON.stringify(body)
              : undefined,
      });
      const data = (await res.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!res.ok) {
        const message =
          data && typeof data.error === "string"
            ? data.error
            : `Request failed (${res.status}).`;
        setError(message);
        return { ok: false, data };
      }
      router.refresh();
      return { ok: true, data };
    } catch {
      setError("Network error — please try again.");
      return { ok: false, data: null };
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run, setError };
}

const field: React.CSSProperties = {
  display: "grid",
  gap: "0.25rem",
  marginBottom: "0.5rem",
};
const row: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  flexWrap: "wrap",
};
const one: React.CSSProperties = { ...field, flex: "1 1 12rem" };

const PLATFORMS = [
  "",
  "blog",
  "twitter",
  "x",
  "devto",
  "linkedin",
  "youtube",
  "github",
  "manual",
  "rss",
];

const TYPES = ["", "article", "post", "video", "thread", "repo"];

export function AddContentForm() {
  const { error, busy, run } = useAction();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [platform, setPlatform] = useState("");
  const [type, setType] = useState("");
  const [author, setAuthor] = useState("");
  const [tags, setTags] = useState("");
  const [publishedAt, setPublishedAt] = useState("");
  const [note, setNote] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const { ok, data } = await run("/api/content", "POST", {
      url,
      title,
      platform: platform || undefined,
      type: type || undefined,
      author: author || undefined,
      tags: tags || undefined,
      publishedAt: publishedAt || undefined,
    });
    if (ok) {
      const created = data?.created !== false;
      const item = data?.item as { title?: string } | undefined;
      setNote(
        created
          ? `Tracked “${item?.title ?? title}”.`
          : `“${item?.title ?? title}” was already tracked — the existing row is unchanged.`,
      );
      setUrl("");
      setTitle("");
      setPlatform("");
      setType("");
      setAuthor("");
      setTags("");
      setPublishedAt("");
    }
  }

  return (
    <section aria-label="Track content" style={{ marginTop: "1.5rem" }}>
      <h2 style={{ fontSize: "1rem" }}>Track a piece of content</h2>
      <form onSubmit={submit} style={{ maxWidth: "40rem" }}>
        <label style={field}>
          <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>URL</span>
          <input
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            maxLength={2048}
          />
        </label>
        <div style={row}>
          <label style={{ ...one, flex: "2 1 18rem" }}>
            <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>Title</span>
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={300}
              placeholder="Why I left React"
            />
          </label>
          <label style={one}>
            <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
              Platform
            </span>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              <option value="">detect from URL</option>
              {PLATFORMS.slice(1).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div style={row}>
          <label style={one}>
            <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>Type</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t === "" ? "—" : t}
                </option>
              ))}
            </select>
          </label>
          <label style={one}>
            <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
              Author (optional)
            </span>
            <input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              maxLength={200}
            />
          </label>
        </div>
        <div style={row}>
          <label style={one}>
            <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
              Tags (optional, comma-separated)
            </span>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="js, web"
              maxLength={1000}
            />
          </label>
          <label style={one}>
            <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
              Published (optional, YYYY-MM-DD)
            </span>
            <input
              value={publishedAt}
              onChange={(e) => setPublishedAt(e.target.value)}
              placeholder="2026-09-01"
            />
          </label>
        </div>
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Track it"}
        </button>
        {note ? (
          <p style={{ color: "#047857", margin: "0.5rem 0 0" }}>{note}</p>
        ) : null}
        {error ? (
          <p role="alert" style={{ color: "#b91c1c", margin: "0.5rem 0 0" }}>
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}

interface ImportSummary {
  items: number;
  created: number;
  existing: number;
  feed: { title: string | null; link: string | null } | null;
  errors: Array<{ row: number; reason: string }>;
  warnings: Array<{ row: number; reason: string }>;
  dryRun: boolean;
}

export function ImportContentPanel() {
  const { error, busy, run, setError } = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  async function submit(event: React.FormEvent, dryRun: boolean) {
    event.preventDefault();
    if (!file) {
      setError("Choose a CSV or feed XML file first.");
      return;
    }
    const form = new FormData();
    form.append("file", file);
    const { ok, data } = await run(
      `/api/content?dryRun=${dryRun ? "1" : "0"}`,
      "POST",
      form,
    );
    setSummary(ok ? ((data as unknown as ImportSummary) ?? null) : null);
    if (ok) setError(null);
  }

  return (
    <section aria-label="Import content" style={{ marginTop: "1.5rem" }}>
      <h2 style={{ fontSize: "1rem" }}>Import a CSV or an RSS/Atom feed</h2>
      <p style={{ color: "#6b7280", margin: "0 0 0.5rem" }}>
        CSV columns are matched by name — <code>url</code>, <code>title</code>,{" "}
        <code>platform</code>, <code>published_at</code>, <code>tags</code>… (a
        spreadsheet from your blog or a dev.to export works). Feeds import each
        entry as a piece of content. Re-importing the same file adds nothing.
      </p>
      <form style={{ maxWidth: "32rem" }}>
        <label style={field}>
          <input
            type="file"
            accept=".csv,.xml,.rss,.atom,text/csv,application/xml,text/xml,application/rss+xml,application/atom+xml"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            disabled={busy || !file}
            onClick={(e) => submit(e, true)}
          >
            {busy ? "Working…" : "Preview"}
          </button>
          <button
            type="button"
            disabled={busy || !file}
            onClick={(e) => submit(e, false)}
          >
            {busy ? "Working…" : "Import"}
          </button>
        </div>
      </form>
      {error ? (
        <p role="alert" style={{ color: "#b91c1c" }}>
          {error}
        </p>
      ) : null}
      {summary ? (
        <div
          style={{
            marginTop: "0.75rem",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            padding: "0.75rem",
          }}
        >
          <p style={{ margin: "0 0 0.25rem" }}>
            <strong>
              {summary.dryRun ? "Preview — nothing written." : "Imported."}
            </strong>{" "}
            {summary.items} row(s) · {summary.created} new · {summary.existing}{" "}
            already tracked
          </p>
          {summary.feed?.title ? (
            <p style={{ margin: "0 0 0.25rem", color: "#374151" }}>
              feed: {summary.feed.title}
              {summary.feed.link ? ` (${summary.feed.link})` : ""}
            </p>
          ) : null}
          {summary.errors.length > 0 ? (
            <ul style={{ margin: "0.25rem 0", paddingLeft: "1.25rem" }}>
              {summary.errors.slice(0, 10).map((e) => (
                <li key={`${e.row}-${e.reason}`}>
                  row {e.row}: {e.reason}
                </li>
              ))}
            </ul>
          ) : null}
          {summary.warnings.length > 0 ? (
            <ul style={{ margin: "0.25rem 0", paddingLeft: "1.25rem" }}>
              {summary.warnings.slice(0, 10).map((w) => (
                <li key={`${w.row}-${w.reason}`}>
                  row {w.row}: {w.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function RecordMetricsForm({ contentId }: { contentId: string }) {
  const { error, busy, run } = useAction();
  const [views, setViews] = useState("");
  const [likes, setLikes] = useState("");
  const [comments, setComments] = useState("");
  const [shares, setShares] = useState("");
  const [bookmarks, setBookmarks] = useState("");
  const [fetchedAt, setFetchedAt] = useState("");

  const num = (v: string): number | undefined =>
    v === "" ? undefined : Number(v);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const body: Record<string, unknown> = {
      views: num(views),
      likes: num(likes),
      comments: num(comments),
      shares: num(shares),
      bookmarks: num(bookmarks),
      fetchedAt: fetchedAt || undefined,
    };
    const { ok } = await run(
      `/api/content/${encodeURIComponent(contentId)}/metrics`,
      "POST",
      body,
    );
    if (ok) {
      setViews("");
      setLikes("");
      setComments("");
      setShares("");
      setBookmarks("");
      setFetchedAt("");
    }
  }

  return (
    <section aria-label="Update numbers" style={{ marginTop: "1rem" }}>
      <h2 style={{ fontSize: "1rem" }}>Update numbers</h2>
      <p style={{ color: "#6b7280", margin: "0 0 0.5rem", maxWidth: "36rem" }}>
        Read the figures off the platform and add a snapshot — one per check-in.
        Leave a field empty when the platform does not report it.
      </p>
      <form onSubmit={submit} style={{ maxWidth: "40rem" }}>
        <div style={row}>
          {(
            [
              ["views", views, setViews],
              ["likes", likes, setLikes],
              ["comments", comments, setComments],
              ["shares", shares, setShares],
              ["bookmarks", bookmarks, setBookmarks],
            ] as const
          ).map(([name, value, set]) => (
            <label key={name} style={one}>
              <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
                {name}
              </span>
              <input
                type="number"
                min={0}
                step={1}
                value={value}
                onChange={(e) => set(e.target.value)}
                placeholder="0"
              />
            </label>
          ))}
          <label style={one}>
            <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
              Measured on (optional)
            </span>
            <input
              value={fetchedAt}
              onChange={(e) => setFetchedAt(e.target.value)}
              placeholder="2026-09-07"
            />
          </label>
        </div>
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Add snapshot"}
        </button>
        {error ? (
          <p role="alert" style={{ color: "#b91c1c", margin: "0.5rem 0 0" }}>
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}

export function AddMentionForm({ contentId }: { contentId: string }) {
  const { error, busy, run } = useAction();
  const [contact, setContact] = useState("");
  const [context, setContext] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const { ok } = await run(
      `/api/content/${encodeURIComponent(contentId)}/mentions`,
      "POST",
      {
        contact,
        context: context || undefined,
      },
    );
    if (ok) {
      setContact("");
      setContext("");
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{
        display: "flex",
        gap: "0.5rem",
        flexWrap: "wrap",
        marginTop: "0.5rem",
      }}
    >
      <input
        required
        value={contact}
        onChange={(e) => setContact(e.target.value)}
        placeholder="contact name, email or id"
        style={{ flex: "2 1 14rem" }}
      />
      <input
        value={context}
        maxLength={120}
        onChange={(e) => setContext(e.target.value)}
        placeholder="context (co-authored, mentioned…)"
        style={{ flex: "1 1 12rem" }}
      />
      <button type="submit" disabled={busy}>
        {busy ? "Linking…" : "Link contact"}
      </button>
      {error ? (
        <span role="alert" style={{ color: "#b91c1c" }}>
          {error}
        </span>
      ) : null}
    </form>
  );
}

export function RemoveMentionButton({
  contentId,
  contactId,
  name,
}: {
  contentId: string;
  contactId: string;
  name: string;
}) {
  const { error, busy, run } = useAction();
  return (
    <span
      style={{ display: "inline-flex", gap: "0.5rem", alignItems: "center" }}
    >
      <button
        type="button"
        aria-label={`Remove ${name} from this content`}
        disabled={busy}
        onClick={() =>
          run(
            `/api/content/${encodeURIComponent(contentId)}/mentions?contactId=${encodeURIComponent(contactId)}`,
            "DELETE",
          )
        }
      >
        {busy ? "…" : "Remove"}
      </button>
      {error ? (
        <span role="alert" style={{ color: "#b91c1c" }}>
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function RemoveContentButton({ contentId }: { contentId: string }) {
  const { error, busy, run } = useAction();
  return (
    <span
      style={{ display: "inline-flex", gap: "0.5rem", alignItems: "center" }}
    >
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          if (
            !window.confirm(
              "Delete this piece of content, its snapshots and its mentions?",
            )
          )
            return;
          const { ok } = await run(
            `/api/content/${encodeURIComponent(contentId)}`,
            "DELETE",
          );
          if (ok) window.location.assign("/content");
        }}
      >
        {busy ? "Deleting…" : "Delete content"}
      </button>
      {error ? (
        <span role="alert" style={{ color: "#b91c1c" }}>
          {error}
        </span>
      ) : null}
    </span>
  );
}
