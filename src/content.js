// content.js — runs in the extension's isolated world.
//
// Responsibilities:
//   1. Receive captured posts from interceptor.js (main world) and persist them.
//   2. Inject "revived" posts into the home timeline, styled to look native,
//      and keep them present as React re-renders / virtualizes the list.

(function () {
  "use strict";

  const ext = globalThis.browser || globalThis.chrome;
  const storage = ext && ext.storage;
  const runtime = ext && ext.runtime;
  const STORE_KEY = "feedRevive.posts";
  // Captured request "signatures" for background replay, one per source.
  const TEMPLATE_KEYS = {
    bookmarks: "feedRevive.bmTemplate",
    likes: "feedRevive.likesTemplate",
  };
  const REFRESH_KEY = "feedRevive.lastRefresh";
  const REFRESH_OK_KEY = "feedRevive.lastRefreshOk"; // last *successful* refetch
  const REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // 6h between top-of-list refreshes
  const BACKFILL_KEY = "feedRevive.backfill"; // per-source deep-history progress
  const BACKFILL_INTERVAL = 15 * 60 * 1000; // between 25-page backfill chunks
  const SPLICE_KEY = "feedRevive.spliceEnabled"; // real-tweet injection toggle
  const PENDING_KEY = "feedRevive.pendingClips"; // bookmark ids awaiting data
  // ~10-25MB of storage.local at worst (raw nodes are a few KB each) — the
  // price of having your whole saved history in rotation.
  const MAX_STORED = 3000;
  // Keep raw nodes (needed for real-tweet splicing) on EVERY stored post —
  // trimming them would silently exclude older saves from ever resurfacing,
  // since splicing replaces the cards entirely. Costs a few MB of
  // storage.local at worst; fine for a personal add-on.
  const RAW_MAX = MAX_STORED;
  const SEEN_MAX = 2000; // cap on per-session tweet-order bookkeeping
  const INJECT_EVERY = 20; // one revived post per N real posts
  const log = (...a) => console.log("[feed-revive]", ...a);

  // id -> post
  const posts = new Map();

  // Real-tweet splicing (the default): the interceptor inserts raw saved
  // tweets into home timeline payloads and X renders them natively; we only
  // add the "From your saved posts" badge afterwards. Fallback cards run when
  // splicing is off or nothing with raw data has been captured yet.
  let spliceActive = false;
  const splicedIds = new Set(); // tweet ids the interceptor has spliced in

  // --- 1. Capture ----------------------------------------------------------

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d.__feedRevive) return;

    if (d.channel === "saved" && Array.isArray(d.tweets)) {
      let added = 0;
      let changed = 0;
      for (const t of d.tweets) {
        if (!t || !t.id) continue;
        const prev = posts.get(t.id);
        t.source = d.source;
        if (!prev) {
          posts.set(t.id, t);
          added++;
        } else if (!prev.raw && t.raw) {
          // Re-captured with full tweet data (post predates splicing) — upgrade.
          t.source = mergeSource(prev.source, d.source);
          posts.set(t.id, t);
          changed++;
        } else if (mergeSource(prev.source, d.source) !== prev.source) {
          // Seen again from the other source (or from before sources were
          // recorded) — remember both.
          prev.source = mergeSource(prev.source, d.source);
          changed++;
        }
      }
      if (added || changed) {
        log(`captured ${added} new ${d.source} post(s) — ${posts.size} stored total`);
        persist();
      }
    } else if (d.channel === "clip" && d.clip) {
      // A bookmark was just added — clip it to Obsidian. (The interceptor
      // separately posts it on the "saved" channel, raw node included, so the
      // revive pool is handled above.)
      log(`bookmarked @${d.clip.screenName || "?"} — sending to Obsidian`);
      if (runtime && runtime.sendMessage) {
        runtime.sendMessage({ type: "clip", clip: d.clip }).catch(() => {});
      }
      // If this clip was pending (bookmarked before its data arrived), it's
      // handled now — from here on, delivery retries are the background
      // script's job.
      updatePending((ids) => ids.filter((x) => x !== d.clip.id));
    } else if (d.channel === "clipPending" && d.id) {
      // Bookmarked, but the tweet's data hasn't been parsed yet — persist the
      // debt so it survives reloads (resolved by a later parse or refetch).
      updatePending((ids) =>
        ids.includes(d.id) ? ids : [...ids, d.id].slice(-100)
      );
    } else if (d.channel === "spliced" && Array.isArray(d.ids)) {
      // Real tweets went into the timeline — remember them for badging, and
      // stop injecting fallback cards (splicing is clearly working).
      for (const id of d.ids) splicedIds.add(id);
      spliceActive = true;
    } else if (d.channel === "bmTemplate" && d.template) {
      // Remember how to replay this source's request for background re-fetch.
      const key = TEMPLATE_KEYS[d.source] || TEMPLATE_KEYS.bookmarks;
      if (storage) storage.local.set({ [key]: d.template });
    } else if (d.channel === "unsaved" && d.id) {
      // Un-liked or un-bookmarked — stop resurfacing it.
      if (posts.delete(d.id)) {
        persist();
        log("un-saved post removed from the pool");
      }
    } else if (d.channel === "refetchDone") {
      const source = d.source || "bookmarks";
      if (d.ok) {
        log(
          `background ${source} refresh done — ${d.total} post(s) seen` +
            (d.exhausted ? " (reached the end of the list)" : "")
        );
        if (storage) storage.local.set({ [REFRESH_OK_KEY]: Date.now() });
        updateBackfill(source, (b) => {
          if (d.exhausted) return { done: true, finishedAt: Date.now() };
          if (b.done) return b;
          return Object.assign({}, b, { cursor: d.cursor || null, fails: 0 });
        });
      } else {
        log(
          `background ${source} refresh failed — if this keeps happening, scroll that page once to re-capture the request`
        );
        updateBackfill(source, (b) => {
          if (b.done) return b;
          const fails = (b.fails || 0) + 1;
          // A resume cursor can go stale after an X redeploy; restart from
          // the top after repeated failures rather than retrying it forever.
          return fails >= 3 ? { fails: 0 } : Object.assign({}, b, { fails });
        });
      }
    }
  });

  // Two background jobs share the replay machinery (first time, you still
  // have to VISIT /bookmarks and your Likes tab once to capture the requests):
  //  - BACKFILL: crawls the source's entire history in 25-page chunks,
  //    resuming from a stored cursor every BACKFILL_INTERVAL, until the end
  //    of the list is reached or the pool is full. Runs while x.com is open.
  //  - TOP REFRESH: once backfill is done, re-walks the newest pages every
  //    REFRESH_INTERVAL to pick up saves made elsewhere (other devices).
  async function maybeRefetch() {
    if (!storage) return;
    const r = await storage.local.get([
      TEMPLATE_KEYS.bookmarks,
      TEMPLATE_KEYS.likes,
      REFRESH_KEY,
      REFRESH_OK_KEY,
      BACKFILL_KEY,
    ]);
    if (!r[TEMPLATE_KEYS.bookmarks] && !r[TEMPLATE_KEYS.likes]) return;
    const now = Date.now();
    const backfill = r[BACKFILL_KEY] || {};
    const topDue = now - (r[REFRESH_KEY] || 0) >= REFRESH_INTERVAL;
    let backfillChanged = false;
    let topRan = false;

    for (const source of Object.keys(TEMPLATE_KEYS)) {
      const template = r[TEMPLATE_KEYS[source]];
      if (!template) continue;
      const b = backfill[source] || {};
      if (!b.done) {
        if (posts.size >= MAX_STORED) {
          backfill[source] = { done: true, reason: "pool-full" };
          backfillChanged = true;
          log(`${source} backfill stopped — pool is full (${posts.size} posts)`);
          continue;
        }
        if (now - (b.lastChunk || 0) < BACKFILL_INTERVAL) continue;
        backfill[source] = Object.assign({}, b, { lastChunk: now });
        backfillChanged = true;
        log(`backfilling ${source} history${b.cursor ? " (continuing)" : ""}…`);
        window.postMessage(
          { __feedReviveCmd: "refetchSaved", source, template, cursor: b.cursor || null },
          location.origin
        );
      } else if (topDue) {
        log(`refreshing ${source} in the background…`);
        window.postMessage(
          // stopOnKnown: a no-news maintenance check costs one request.
          { __feedReviveCmd: "refetchSaved", source, template, cursor: null, stopOnKnown: true },
          location.origin
        );
        topRan = true;
      }
    }

    if (backfillChanged) storage.local.set({ [BACKFILL_KEY]: backfill });
    if (topRan) storage.local.set({ [REFRESH_KEY]: now }); // optimistic; avoids spam
    // Refreshes have been *attempted* but haven't succeeded in a long while —
    // the captured requests have probably gone stale (X redeploy). Say so,
    // since otherwise the pool just quietly stops updating.
    const lastOk = r[REFRESH_OK_KEY] || 0;
    if (lastOk && now - lastOk > 4 * REFRESH_INTERVAL) {
      log(
        "background refresh hasn't succeeded in over a day — scroll your Bookmarks/Likes pages once to re-capture the requests"
      );
    }
  }

  // TRAILING debounce: a backfill chunk delivers a page every ~0.5s for ~30s,
  // and every store write serializes the whole multi-MB pool — so wait for
  // the burst to END and write once (with a 30s cap so a very long burst
  // can't defer persistence forever). A non-trailing debounce here caused
  // 100%-CPU waves: one full serialization every 1.5s for the whole chunk.
  let persistTimer = null;
  let persistFirstReq = 0;
  function persist() {
    if (!storage) return;
    const now = Date.now();
    if (!persistFirstReq) persistFirstReq = now;
    if (persistTimer) clearTimeout(persistTimer);
    const delay = Math.min(5000, Math.max(0, persistFirstReq + 30000 - now));
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistFirstReq = 0;
      persistNow();
    }, delay);
  }

  window.addEventListener("pagehide", () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
      persistFirstReq = 0;
      persistNow();
    }
  });

  function persistNow() {
    if (!storage) return;
    // Keep the most recently captured posts only.
    const all = [...posts.values()]
      .sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0))
      .slice(0, MAX_STORED);
    // Raw nodes are ~10-50x the size of the normalized fields; keep them only
    // on the freshest RAW_MAX posts. (Deleting off the shared object also
    // frees it in the in-memory map — intended.)
    for (let i = RAW_MAX; i < all.length; i++) {
      if (all[i].raw) delete all[i].raw;
    }
    storage.local.set({ [STORE_KEY]: all });
    // Trim the in-memory pool to the same cap, or it grows for the whole
    // session while only the stored copy stays bounded.
    if (posts.size > MAX_STORED) {
      posts.clear();
      for (const t of all) posts.set(t.id, t);
    }
  }

  // Serialize read-modify-write of the pending-clip id list. (Two tabs can
  // still race each other; harmless — worst case a duplicate clip PUT, which
  // overwrites the same note.)
  let pendingChain = Promise.resolve();
  function updatePending(fn) {
    if (!storage) return;
    pendingChain = pendingChain.then(async () => {
      const r = await storage.local.get(PENDING_KEY);
      const ids = (r && r[PENDING_KEY]) || [];
      const next = fn(ids);
      if (next !== ids) await storage.local.set({ [PENDING_KEY]: next });
    }).catch(() => {});
  }

  // Same serialized read-modify-write pattern as updatePending, for the
  // per-source backfill progress ({cursor, lastChunk, fails} or {done: true}).
  let backfillChain = Promise.resolve();
  function updateBackfill(source, fn) {
    if (!storage) return;
    backfillChain = backfillChain
      .then(async () => {
        const r = await storage.local.get(BACKFILL_KEY);
        const all = (r && r[BACKFILL_KEY]) || {};
        all[source] = fn(all[source] || {});
        await storage.local.set({ [BACKFILL_KEY]: all });
      })
      .catch(() => {});
  }

  function restore() {
    if (!storage) return;
    storage.local.get([STORE_KEY, SPLICE_KEY, PENDING_KEY]).then((res) => {
      const all = (res && res[STORE_KEY]) || [];
      for (const t of all) if (t && t.id) posts.set(t.id, t);
      if (all.length) log(`restored ${all.length} saved post(s) from storage`);

      // Arm the interceptor's splice pool with the raw nodes we have. Even if
      // it's empty (pre-splicing captures), still send `enabled` so live
      // captures this session can start splicing.
      const enabled = res[SPLICE_KEY] !== false; // default on
      // Snapshots taken before the like/bookmark happened have the button
      // state un-toggled — we know better: being in the pool with that source
      // MEANS it's liked/bookmarked. Patch before handing them to X's renderer.
      for (const t of all) {
        if (!t || !t.raw || !t.raw.legacy) continue;
        if (t.source === "likes" || t.source === "both") t.raw.legacy.favorited = true;
        if (t.source === "bookmarks" || t.source === "both") t.raw.legacy.bookmarked = true;
      }
      const nodes = all.filter((t) => t && t.raw).map((t) => t.raw).slice(0, RAW_MAX);
      spliceActive = enabled && nodes.length > 0;
      window.postMessage(
        {
          __feedReviveCmd: "splicePool",
          enabled,
          every: INJECT_EVERY,
          nodes,
          pendingClips: res[PENDING_KEY] || [],
        },
        location.origin
      );
      if (enabled && !nodes.length && all.length) {
        log(
          "stored posts predate real-tweet injection — scroll x.com/i/bookmarks once to re-capture (using fallback cards meanwhile)"
        );
      }
    });
  }

  // --- 2. Injection --------------------------------------------------------

  const isHome = () =>
    location.pathname === "/home" || location.pathname === "/";

  // Random rather than round-robin, so old saves surface as often as fresh
  // ones. (Per-cell stability comes from the `assigned` map, not from here.)
  function pickPost() {
    if (posts.size === 0) return null;
    const values = [...posts.values()];
    return values[Math.floor(Math.random() * values.length)];
  }

  // Stable tweet ordering. X virtualizes the timeline — only a handful of cells
  // exist in the DOM at once and they recycle as you scroll — so counting
  // *rendered* cells gives inconsistent spacing. Instead we key off each tweet's
  // status id and remember the order we first saw it, so "every Nth tweet" stays
  // consistent no matter how the window scrolls.
  const seenOrder = new Map(); // tweetId -> 0-based order first seen
  const assigned = new Map(); // host tweetId -> revived post id pinned to it
  let seenCount = 0;

  // Sessions on X can be long; drop the oldest half of the bookkeeping once it
  // grows past SEEN_MAX. Oldest-first (Map preserves insertion order) — those
  // tweets are the least likely to still be on screen. A pruned tweet that does
  // reappear just gets a fresh order slot, which only shifts spacing slightly.
  function pruneSeen() {
    if (seenOrder.size <= SEEN_MAX) return;
    let drop = seenOrder.size - SEEN_MAX / 2;
    for (const id of seenOrder.keys()) {
      if (drop-- <= 0) break;
      seenOrder.delete(id);
      assigned.delete(id);
    }
  }

  function cellTweetId(cell) {
    const a = cell.querySelector('a[href*="/status/"]');
    const m = a && a.getAttribute("href").match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  // Append a revived card INSIDE every INJECT_EVERY-th distinct tweet's cell.
  // (Inside, not as a sibling: cells are position:absolute, so a sibling would
  // collapse to the top and overlap real tweets; inside, X's per-cell height
  // measurement reflows the following tweets to make room.) Idempotent +
  // self-healing: if React re-renders the cell and drops our card, the next
  // pass re-appends it.
  function refreshInjections() {
    if (!isHome()) return;
    const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
    if (!cells.length) return;

    if (splicedIds.size) markSplicedCells(cells);
    if (spliceActive) return; // real tweets are spliced in — no fallback cards
    if (posts.size === 0) return;

    for (const cell of cells) {
      const id = cellTweetId(cell);
      if (!id) continue; // not a tweet cell (module header, who-to-follow, etc.)
      let idx = seenOrder.get(id);
      if (idx === undefined) {
        idx = seenCount++;
        seenOrder.set(id, idx);
        pruneSeen();
      }
      if ((idx + 1) % INJECT_EVERY !== 0) continue;
      if (cell.querySelector(":scope > [data-feed-revive]")) continue; // already injected
      // Reuse the post already pinned to this host tweet, so a React re-render
      // that drops our card gets the SAME post back instead of the round-robin
      // shuffling a new one in (which also let one post show up twice).
      let post = posts.get(assigned.get(id));
      if (!post) {
        post = pickPost();
        if (!post) break;
        assigned.set(id, post.id);
      }
      const card = buildCard(post);
      if (card) cell.appendChild(card);
    }
  }

  // Spliced tweets are rendered by X itself and are indistinguishable from the
  // organic feed — prepend the "From your saved posts" badge to their article
  // so the user can tell. Idempotent; re-runs heal React re-renders, same as
  // the cards.
  function markSplicedCells(cells) {
    for (const cell of cells) {
      const id = cellTweetId(cell);
      if (!id || !splicedIds.has(id)) continue;
      if (cell.querySelector("[data-feed-revive-badge]")) continue;
      // Prepend to the CELL, not the <article>: the article is a flex
      // container, so a child div becomes a squeezed flex column beside the
      // tweet. Cell children lay out as plain blocks (our cards rely on the
      // same), giving a full-width row above the tweet.
      const post = posts.get(id);
      const badge = el("div", "fr-splice-badge");
      badge.setAttribute("data-feed-revive-badge", "1");
      badge.style.color = themeColors().secondary;
      badge.append(
        badgeIcon(post && post.source),
        text("span", "fr-badge-text", sourceLabel(post))
      );
      cell.prepend(badge);
    }
  }

  // Built with DOM APIs + textContent (not innerHTML) so post text/handles can
  // never be interpreted as markup — no manual escaping needed.
  function buildCard(post) {
    const wrap = el("div", "feed-revive-card");
    wrap.dataset.feedRevive = "1";
    // Our card is injected as a bare sibling of X's cells, where `color: inherit`
    // resolves to the default (black) — invisible on X's dark theme. Set X's
    // actual theme tokens (text/secondary/divider/hover) so the card is
    // indistinguishable from a native tweet on Default/Dim/Light.
    const c = themeColors();
    wrap.style.color = c.text;
    wrap.style.setProperty("--fr-secondary", c.secondary);
    wrap.style.setProperty("--fr-border", c.border);
    wrap.style.setProperty("--fr-hover", c.hover);
    // The card lives inside a tweet cell; stop clicks from bubbling to X's cell
    // handler (which would open the host tweet). Our own <a> still navigates.
    wrap.addEventListener("click", (e) => e.stopPropagation());

    const link = el("a", "fr-link");
    link.href = `https://x.com/${post.screenName}/status/${post.id}`;

    // Header mirroring X's "<name> reposted" label: a small grey icon in the
    // avatar gutter, with the text indented to align with the tweet body below.
    const badge = el("div", "fr-badge");
    badge.append(
      badgeIcon(post.source),
      text("span", "fr-badge-text", sourceLabel(post))
    );
    link.append(badge);

    const row = el("div", "fr-row");

    let avatar;
    if (post.avatar) {
      avatar = el("img", "fr-avatar");
      avatar.src = post.avatar;
      avatar.alt = "";
    } else {
      avatar = el("div", "fr-avatar fr-avatar-blank");
    }

    const head = el("div", "fr-head");
    head.append(
      text("span", "fr-name", post.name),
      text("span", "fr-handle", `@${post.screenName || ""}`)
    );
    const when = shortDate(post.createdAt);
    if (when) {
      head.append(text("span", "fr-handle", "·"), text("span", "fr-handle", when));
    }

    const body = el("div", "fr-body");
    const textNode = text("div", "fr-text", post.text);
    body.append(head, textNode);

    // Long posts: clamp like X does and offer an inline "Show more". A <span>
    // (not <button>) keeps the markup valid inside the wrapping <a>; its handler
    // expands in place and prevents the card's navigation.
    const t = post.text || "";
    if (t.length > 280 || (t.match(/\n/g) || []).length > 8) {
      textNode.classList.add("fr-clamped");
      const more = text("span", "fr-more", "Show more");
      more.setAttribute("role", "button");
      more.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        textNode.classList.remove("fr-clamped");
        more.remove();
      });
      body.append(more);
    }

    row.append(avatar, body);
    link.append(row);
    wrap.append(link);
    return wrap;
  }

  // Which list(s) a post came from → badge label. "both" happens when the
  // same tweet shows up in bookmarks AND likes; missing source means the post
  // was stored before sources were recorded (self-heals on the next refetch).
  function mergeSource(a, b) {
    if (!a || a === b) return b || a;
    if (!b) return a;
    return "both";
  }

  const SOURCE_LABELS = {
    bookmarks: "From your bookmarks",
    likes: "From your likes",
    both: "From your bookmarks & likes",
  };
  const sourceLabel = (post) =>
    (post && SOURCE_LABELS[post.source]) || "From your saved posts";

  // A text glyph (the old ↩) sits on the font baseline inside a taller line
  // box, so it can never vertically centre against the 13px label — X's native
  // "reposted" header uses a fixed-size SVG for exactly this reason. Filled
  // with currentColor so it takes the theme's secondary grey. Bookmark by
  // default; heart for likes-only posts.
  const ICON_BOOKMARK =
    "M6.5 2C5.12 2 4 3.12 4 4.5v18.06l8-5.71 8 5.71V4.5C20 3.12 18.88 2 17.5 2h-11zM6 4.5c0-.28.22-.5.5-.5h11c.28 0 .5.22.5.5v14.56l-6-4.29-6 4.29V4.5z";
  const ICON_HEART =
    "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z";

  function badgeIcon(source) {
    const wrap = el("span", "fr-badge-icon");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", source === "likes" ? ICON_HEART : ICON_BOOKMARK);
    svg.append(path);
    wrap.append(svg);
    return wrap;
  }

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }
  function text(tag, className, value) {
    const node = el(tag, className);
    node.textContent = value == null ? "" : String(value);
    return node;
  }

  // "Jun 5" like X, with the year added once it's not this year's post.
  function shortDate(s) {
    const d = new Date(s || "");
    if (isNaN(d)) return "";
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString("en-US", opts);
  }

  // X's design tokens for whichever theme is active, so the card matches native
  // tweets exactly. X keeps its <meta name="theme-color"> in sync with the theme
  // (Default #000, Dim #15202b, Light #fff); we fall back to the body's
  // background if it's missing.
  //   text:      primary tweet text / display name
  //   secondary: @handle + muted metadata grey
  //   border:    the hairline divider X draws between tweets
  //   hover:     the subtle row highlight on tweet hover
  function themeColors() {
    let bg = "";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) bg = meta.getAttribute("content") || "";
    if (!bg && document.body) bg = getComputedStyle(document.body).backgroundColor;
    const rgb = parseColor(bg);
    const luminance = rgb ? 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] : 0;
    const dark = !rgb || luminance < 128; // default to X's dark theme
    return dark
      ? {
          text: "rgb(231, 233, 234)",
          secondary: "rgb(113, 118, 123)",
          border: "rgb(47, 51, 54)",
          hover: "rgba(255, 255, 255, 0.03)",
        }
      : {
          text: "rgb(15, 20, 25)",
          secondary: "rgb(83, 100, 113)",
          border: "rgb(239, 243, 244)",
          hover: "rgba(0, 0, 0, 0.03)",
        };
  }

  function parseColor(str) {
    if (!str) return null;
    str = str.trim();
    let m = str.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = str.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }

  // --- Lifecycle -----------------------------------------------------------

  function start() {
    restore();
    setTimeout(maybeRefetch, 1500); // let the page settle before refetching
    // Keep the backfill moving while a tab stays open (chunks are gated by
    // BACKFILL_INTERVAL, so this re-check is cheap when nothing is due).
    setInterval(maybeRefetch, 5 * 60 * 1000);

    // Re-evaluate on DOM mutations (debounced) and on a steady interval so
    // injections survive SPA navigation and virtualized scrolling.
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        refreshInjections();
      }, 250);
    };

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(refreshInjections, 2000);
    log("ready — visit your Bookmarks/Likes pages to capture posts");
  }

  if (document.body) start();
  else
    document.addEventListener("DOMContentLoaded", start, { once: true });
})();
