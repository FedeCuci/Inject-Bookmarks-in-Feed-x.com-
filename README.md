# Feed Revive

A Firefox add-on that does two things with your X (Twitter) activity:

1. **Revive** — re-surfaces your liked/bookmarked posts back into your home
   timeline, so you actually see them again.
2. **Clip to Obsidian** — when you bookmark a tweet, it's automatically written
   to your Obsidian vault via the Local REST API plugin.

## How it works (v0.1)

- `src/interceptor.js` runs in the page's main world and wraps `window.fetch`.
  When you visit your **Bookmarks** or **Likes** page, X loads those posts via
  its internal GraphQL API — we read those responses as they arrive (no extra
  requests of our own) and hand the posts to the content script.
- `src/content.js` stores the captured posts (`storage.local`) and injects them
  into the home timeline, styled to look like native tweets. A `MutationObserver`
  re-inserts them as X re-renders / virtualizes the feed.

### Keeping the pool fresh

You only have to seed it **once**:

- **First time:** open `/bookmarks` and scroll down once. This passively captures
  your existing bookmarks *and* records the request "signature" (URL + auth).
- **After that, automatic:** on each visit to x.com, if it's been >6h, the addon
  **replays** that bookmarks request in the background (same-origin, your cookies,
  a fresh CSRF token) and paginates through your whole list — no need to open
  `/bookmarks` again.
- **Live:** any tweet you bookmark is added to the pool immediately.

Captured posts persist in `storage.local`, so they survive browser restarts.

> The first two jobs are purely *passive* (reading what the page fetched). The
> background re-fetch is *active* (the addon makes its own requests) — more
> convenient, but more clearly against X's ToS. If the captured query id goes
> stale (X redeploys), a refetch will fail silently; just scroll `/bookmarks`
> once to re-capture it.

### Clip to Obsidian

The same `fetch` hook also watches for the **`CreateBookmark`** mutation X fires
the moment you bookmark a tweet. When it sees one, it resolves the tweet's
content (from a small cache of every tweet it has parsed) and hands it to
`src/background.js`, which `PUT`s a markdown note into your vault using the
[Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api)
plugin. The note filename is `folder/handle-tweetid.md`, so re-bookmarking the
same tweet just overwrites it (no duplicates).

Detection is via the network mutation, not a button click, so it also works when
you bookmark with the keyboard or from a tweet's detail page.

## Setup: Obsidian clipping

1. In Obsidian, install the **Local REST API** community plugin and enable it.
2. In the plugin settings, turn on the **Non-encrypted (HTTP) Server** (port
   `27123`) and copy the **API Key**. (HTTP-on-localhost avoids the self-signed
   certificate hassle; the extension reaches it via its `127.0.0.1` host
   permission, which also bypasses CORS.)
3. In Firefox, open the add-on's options (`about:addons` → Feed Revive →
   Preferences, or the gear menu), paste the API key, set the target folder,
   and click **Test connection**. You should see *Connected ✓*.
4. Make sure Obsidian is running, then bookmark a tweet — a note appears in your
   vault, and the console logs `[feed-revive] saved to Obsidian: …`.

## Install (temporary, for development)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select this folder's `manifest.json`.

(Temporary add-ons are removed when Firefox restarts. Requires Firefox 128+.)

## Try it / verify

1. Open `x.com` and the browser console (F12).
2. Visit **your Bookmarks** (`x.com/i/bookmarks`) and/or **Likes**, and scroll a
   bit. You should see console logs like:
   `[feed-revive] captured 18 new bookmarks post(s) — 18 stored total`
   → *This verifies data capture (slice 1).*
3. Go to **Home** (`x.com/home`) and scroll. Every ~5 posts you should see a
   card badged **"↩ From your saved posts"**.
   → *This verifies injection (slice 2).*

## Known fragilities

X changes its DOM and GraphQL shapes without notice. The two things most likely
to need updating over time:

- **`data-testid="cellInnerDiv"`** — the timeline cell selector in `content.js`.
- **Tweet field paths** in `interceptor.js` (`normalizeTweet`).

The parser walks the response tree and checks multiple field locations to stay
resilient, but breakage is expected maintenance, not a bug we can design away.

## Note on Terms of Service

This reads data from your own logged-in session. Even passive reading of X's
internal endpoints is against X's Terms of Service. It's low-risk for personal,
local, single-user use — but you should know it.

## Roadmap

- Retry queue for clips made while Obsidian is closed.
- Filters: only-bookmarks vs only-likes, min-age, hide-already-seen.
- A toolbar popup with capture stats and an on/off toggle.
