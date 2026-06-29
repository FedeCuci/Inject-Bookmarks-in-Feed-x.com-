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
  const TEMPLATE_KEY = "feedRevive.bmTemplate";
  const REFRESH_KEY = "feedRevive.lastRefresh";
  const REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // 6h between background re-fetches
  const MAX_STORED = 1000; // cap to keep storage small
  const INJECT_EVERY = 20; // one revived post per N real posts
  const log = (...a) => console.log("[feed-revive]", ...a);

  // id -> post
  const posts = new Map();
  let cursor = 0; // round-robins through posts when injecting

  // --- 1. Capture ----------------------------------------------------------

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d.__feedRevive) return;

    if (d.channel === "saved" && Array.isArray(d.tweets)) {
      let added = 0;
      for (const t of d.tweets) {
        if (t && t.id && !posts.has(t.id)) {
          posts.set(t.id, t);
          added++;
        }
      }
      if (added) {
        log(`captured ${added} new ${d.source} post(s) — ${posts.size} stored total`);
        persist();
      }
    } else if (d.channel === "clip" && d.clip) {
      // A bookmark was just added — clip it to Obsidian, and also drop it
      // straight into the revive pool so it can resurface in the feed.
      log(`bookmarked @${d.clip.screenName || "?"} — sending to Obsidian`);
      if (runtime && runtime.sendMessage) {
        runtime.sendMessage({ type: "clip", clip: d.clip }).catch(() => {});
      }
      if (!d.clip.partial && d.clip.id && !posts.has(d.clip.id)) {
        posts.set(d.clip.id, d.clip);
        persist();
      }
    } else if (d.channel === "bmTemplate" && d.template) {
      // Remember how to replay the bookmarks request for background re-fetch.
      if (storage) storage.local.set({ [TEMPLATE_KEY]: d.template });
    } else if (d.channel === "refetchDone") {
      log(`background refresh done — ${d.total} bookmark(s) seen`);
    }
  });

  // Trigger a background bookmarks refresh if it's been long enough and we've
  // captured the request once. (First time, you still scroll /bookmarks once.)
  async function maybeRefetch() {
    if (!storage) return;
    const r = await storage.local.get([TEMPLATE_KEY, REFRESH_KEY]);
    const template = r[TEMPLATE_KEY];
    if (!template) return;
    if (Date.now() - (r[REFRESH_KEY] || 0) < REFRESH_INTERVAL) return;
    log("refreshing bookmarks in the background…");
    window.postMessage(
      { __feedReviveCmd: "refetchBookmarks", template },
      location.origin
    );
    storage.local.set({ [REFRESH_KEY]: Date.now() }); // optimistic; avoids spam
  }

  function persist() {
    if (!storage) return;
    // Keep the most recently captured posts only.
    const all = [...posts.values()]
      .sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0))
      .slice(0, MAX_STORED);
    storage.local.set({ [STORE_KEY]: all });
  }

  function restore() {
    if (!storage) return;
    storage.local.get(STORE_KEY).then((res) => {
      const all = (res && res[STORE_KEY]) || [];
      for (const t of all) if (t && t.id) posts.set(t.id, t);
      if (all.length) log(`restored ${all.length} saved post(s) from storage`);
    });
  }

  // --- 2. Injection --------------------------------------------------------

  const isHome = () =>
    location.pathname === "/home" || location.pathname === "/";

  function pickPost() {
    if (posts.size === 0) return null;
    const values = [...posts.values()];
    const post = values[cursor % values.length];
    cursor++;
    return post;
  }

  // Stable tweet ordering. X virtualizes the timeline — only a handful of cells
  // exist in the DOM at once and they recycle as you scroll — so counting
  // *rendered* cells gives inconsistent spacing. Instead we key off each tweet's
  // status id and remember the order we first saw it, so "every Nth tweet" stays
  // consistent no matter how the window scrolls.
  const seenOrder = new Map(); // tweetId -> 0-based order first seen
  let seenCount = 0;

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
    if (!isHome() || posts.size === 0) return;
    const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
    if (!cells.length) return;

    for (const cell of cells) {
      const id = cellTweetId(cell);
      if (!id) continue; // not a tweet cell (module header, who-to-follow, etc.)
      let idx = seenOrder.get(id);
      if (idx === undefined) {
        idx = seenCount++;
        seenOrder.set(id, idx);
      }
      if ((idx + 1) % INJECT_EVERY !== 0) continue;
      if (cell.querySelector(":scope > [data-feed-revive]")) continue; // already injected
      const post = pickPost();
      if (!post) break;
      const card = buildCard(post);
      if (card) cell.appendChild(card);
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
      text("span", "fr-badge-icon", "↩"),
      text("span", "fr-badge-text", "From your saved posts")
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
