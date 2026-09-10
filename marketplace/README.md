# NetPro plugin marketplace (self-hosted)

This directory **is** the default marketplace. `index.json` is a static file —
fetch it with a plain GET (the installer sends no telemetry), or copy the
whole directory to any static host (GitHub Pages, S3, an intranet file share)
and point `MARKETPLACE_INDEX_URL` at your copy. Tarball URLs may be relative
to the index, so a mirrored directory keeps working with no edits.

## Entry format (schema 1)

```json
{
  "schema": 1,
  "updated_at": "2026-09-10T07:30:00.000Z",
  "plugins": [
    {
      "name": "example-event-discovery",
      "version": "1.0.0",
      "description": "What the plugin does.",
      "homepage": "https://github.com/you/plugin",
      "source": {
        "type": "tarball",
        "url": "tarballs/example-event-discovery-1.0.0.tgz",
        "sha256": "<sha256 of the tarball bytes>"
      },
      "manifest": {
        "permissions": {
          "network": ["api.example.com"],
          "capabilities": ["event-discovery", "command"]
        }
      }
    }
  ]
}
```

A `git` source pins a commit instead of a tarball:

```json
"source": { "type": "git", "url": "https://github.com/you/plugin.git", "commit": "<40-char sha>" }
```

## What the installer verifies

1. The index parses and matches schema 1 (size-capped at 256 KiB).
2. The tarball's sha256 matches the index entry — mismatch is a hard,
   audited refusal.
3. The tarball extracts cleanly (no symlinks, no `..` escapes, no absolute
   paths; size-capped) and carries a `manifest.json` at its root.
4. The manifest's name, version, and permissions match the index listing
   exactly — a listing that advertises one thing and ships another is refused.
5. The manifest's engine range accepts this NetPro version.

Installs always land **disabled**: enabling requires the explicit
permissions review (`--i-have-reviewed-permissions` on the CLI, a confirm
step in the web UI).

## Rebuilding the reference tarball

```bash
tar -czf marketplace/tarballs/example-event-discovery-1.0.0.tgz \
  -C plugins/example-event-discovery manifest.json index.js
sha256sum marketplace/tarballs/example-event-discovery-1.0.0.tgz
# paste the hash into marketplace/index.json and bump updated_at
```

Keep the tarball root flat: `manifest.json` + `index.js` at the top level.
