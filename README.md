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
- **Real-tweet injection (default):** the same hook also *modifies* home
  timeline responses, splicing the raw saved tweet objects back into the data
  before X's code sees it — X's own renderer then shows them as fully native
  tweets (images, video, quote tweets, working buttons). `src/content.js` adds
  a "From your saved posts" badge after they render. If anything about the
  payload looks unexpected, we splice nothing and the feed is untouched.
- **Fallback cards:** with injection disabled (options page), or for posts
  captured before raw data was stored, `src/content.js` instead rebuilds a
  simplified text-only card itself and inserts it into the DOM. Posts are
  persisted in `storage.local` either way; a `MutationObserver` keeps
  badges/cards present as X re-renders / virtualizes the feed.

### Keeping the pool fresh

You only have to seed it **once** per source:

- **First time:** just open `/bookmarks` (and/or your profile's **Likes** tab)
  once — no scrolling needed. This records each request's "signature"
  (URL + auth) so it can be replayed.
- **After that, automatic:** while x.com is open, the addon **backfills** your
  entire bookmarks/likes history in the background — 25 pages per 15-minute
  chunk (jittered ~0.5s between pages), resuming from a saved cursor until it
  reaches the end of each list or the pool is full. Once complete, it re-walks
  the newest pages every 6h to pick up saves made on other devices. All
  requests are same-origin replays with your cookies and a fresh CSRF token.
- **Live:** any tweet you bookmark or like is added to the pool immediately;
  un-bookmarking / un-liking removes it.

Captured posts persist in `storage.local`, so they survive browser restarts.

> The first two jobs are purely *passive* (reading what the page fetched). The
> background re-fetch is *active* (the addon makes its own requests) — more
> convenient, but more clearly against X's ToS. If the captured query id goes
> stale (X redeploys), refetches start failing — the options page shows the
> last successful refresh, and the console nags after ~a day of failures; just
> scroll `/bookmarks` once to re-capture it.

### Clip to Obsidian

The same `fetch` hook also watches for the **`CreateBookmark`** mutation X fires
the moment you bookmark a tweet. When it sees one, it resolves the tweet's
content (from a small cache of every tweet it has parsed) and hands it to
`src/background.js`, which `PUT`s a markdown note into your vault using the
[Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api)
plugin. Notes replicate **Obsidian Web Clipper's** default format (same
frontmatter: title/source/`[[@handle]]` author/published/created/description/
`clippings` tag), so auto-clipped bookmarks are indistinguishable from
manually clipped posts. The filename is `folder/Post by @handle on X
<tweetid>.md` — the id keeps distinct tweets by one author apart, while
re-bookmarking the same tweet just overwrites its note (no duplicates).

Two delivery guarantees:

- If the tweet's content isn't in the cache yet, the clip is **deferred** (never
  written as an empty note) and fires as soon as the data shows up — at the
  latest, the next background bookmarks refetch.
- If **Obsidian isn't running**, the clip is queued and retried automatically
  (every 10 minutes, on the next clip, or when "Test connection" succeeds).

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

(Temporary add-ons are removed when Firefox restarts. Requires Firefox 142+.)

## Release (permanent install via AMO unlisted signing)

The add-on is registered on addons.mozilla.org as **unlisted** (self-
distribution): every version gets auto-signed by AMO, producing a `.xpi` that
installs permanently. One-time setup: generate API credentials in the AMO
Developer Hub ("Manage API Keys") and store them as `WEB_EXT_API_KEY` /
`WEB_EXT_API_SECRET` environment variables (never commit them).

To ship a new version:

1. Bump `version` in `manifest.json` (AMO rejects duplicate versions).
2. `npx web-ext sign --channel=unlisted`
   — lints, uploads, waits for signing, and drops the signed `.xpi` into
   `web-ext-artifacts/` (gitignored).
3. Open the `.xpi` in Firefox; it updates in place, storage untouched.

## Try it / verify

1. Open `x.com` and the browser console (F12).
2. Visit **your Bookmarks** (`x.com/i/bookmarks`) and/or **Likes**, and scroll a
   bit. You should see console logs like:
   `[feed-revive] captured 18 new bookmarks post(s) — 18 stored total`
   → *This verifies data capture (slice 1).*
3. Go to **Home** (`x.com/home`) and scroll. Roughly every 20 posts you should
   see a revived tweet badged **"From your bookmarks"** / **"From your likes"**
   (bookmark/heart icon).
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

- Filters: only-bookmarks vs only-likes, min-age, hide-already-seen.
- A toolbar popup with capture stats and an on/off toggle.
