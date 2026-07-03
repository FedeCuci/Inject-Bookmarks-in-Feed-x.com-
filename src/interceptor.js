// interceptor.js — runs in the PAGE's main world (world: "MAIN").
//
// Wraps window.fetch AND XMLHttpRequest (X uses XHR for GraphQL) to passively:
//   1. Read Bookmarks/Likes GraphQL responses (the "revive" feature) and cache
//      every Tweet it parses from any GraphQL response.
//   2. Detect CreateBookmark and forward the bookmarked tweet to be clipped.
//   3. Capture the Bookmarks request "signature" so it can later be REPLAYED
//      in the background (active re-fetch) without visiting /bookmarks.
//
// It also listens for a "refetchBookmarks" command from the content script and
// replays the captured request, paginating through your whole bookmark list.
//
// Everything is wrapped in try/catch: this code must NEVER break x.com.

(function () {
  "use strict";

  const origFetch = window.fetch;
  if (!origFetch || origFetch.__feedReviveWrapped) return;

  const SAVED_RE = [/\/Bookmarks\b/, /\/Likes\b/];
  const HOME_RE = /\/(HomeTimeline|HomeLatestTimeline)\b/;
  const CACHE_MAX = 500;
  const MAX_PAGES = 25; // re-fetch pagination safety cap
  const DEBUG = false; // per-request GraphQL logging (noisy; leaks our presence)

  const tweetCache = new Map(); // id -> normalized tweet

  // Real-tweet splicing: raw Tweet nodes get inserted into home timeline
  // responses before X's code sees them, so X's own renderer displays them as
  // fully native tweets. Pool comes from the content script (persisted
  // captures) plus anything parsed live this session.
  let spliceEnabled = false;
  let spliceEvery = 20; // one spliced tweet per N real timeline entries
  const splicePool = []; // raw Tweet nodes, oldest-added first
  const splicePoolIds = new Set();
  const sessionSpliced = new Set(); // don't repeat a tweet until pool exhausted

  const post = (payload) =>
    window.postMessage(
      Object.assign({ __feedRevive: true }, payload),
      window.location.origin
    );

  const wrapped = async function (...args) {
    const req = args[0];
    const init = args[1];
    const url = typeof req === "string" ? req : req && req.url;

    if (DEBUG && url && /\/graphql\//.test(url)) {
      console.log("[feed-revive] graphql op:", url.split("?")[0].split("/").pop());
    }

    if (url && /\/CreateBookmark\b/.test(url)) {
      try {
        handleBookmarkAdded(readTweetId(req, init));
      } catch (_) {}
    }
    if (url && /\/FavoriteTweet\b/.test(url)) {
      try {
        handleLikeAdded(readTweetId(req, init));
      } catch (_) {}
    }
    if (url && /\/(DeleteBookmark|UnfavoriteTweet)\b/.test(url)) {
      try {
        handleUnsaved(readTweetId(req, init));
      } catch (_) {}
    }
    const tmplSource = templateSource(url);
    if (tmplSource) {
      try {
        post({
          channel: "bmTemplate",
          source: tmplSource,
          template: { url, authorization: getHeader(req, init, "authorization") },
        });
      } catch (_) {}
    }

    const response = await origFetch.apply(this, args);

    try {
      if (url && /\/graphql\//.test(url)) {
        if (HOME_RE.test(url) && spliceEnabled && splicePool.length) {
          // Home timeline: splice saved tweets into the payload and hand X a
          // rebuilt Response, so its own renderer shows them as real tweets.
          // Any failure falls through to the untouched original.
          try {
            const data = await response.clone().json();
            processGraphql(url, data);
            if (spliceTimeline(data)) {
              return new Response(JSON.stringify(data), {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              });
            }
          } catch (_) {}
          return response;
        }
        response
          .clone()
          .json()
          .then((data) => processGraphql(url, data))
          .catch(() => {});
      }
    } catch (_) {
      /* never break the app */
    }
    return response;
  };
  wrapped.__feedReviveWrapped = true;
  window.fetch = wrapped;
  console.log("[feed-revive] interceptor active (fetch hooked)");

  // X loads timelines (incl. Bookmarks/Likes) via XMLHttpRequest, not fetch, so
  // we have to hook XHR as well. Same passive logic, routed through the same
  // helpers. Still wrapped in try/catch — never break x.com.
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && !XHR.prototype.__feedReviveWrapped) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    const origSetHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url, ...rest) {
      try {
        this.__feedRevive = { url: url == null ? "" : String(url), headers: {} };
      } catch (_) {}
      return origOpen.apply(this, [method, url, ...rest]);
    };

    XHR.prototype.setRequestHeader = function (name, value) {
      try {
        if (this.__feedRevive) {
          this.__feedRevive.headers[String(name).toLowerCase()] = value;
        }
      } catch (_) {}
      return origSetHeader.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      try {
        const info = this.__feedRevive;
        const url = info && info.url;
        if (url) {
          if (DEBUG && /\/graphql\//.test(url)) {
            console.log(
              "[feed-revive] graphql op (xhr):",
              url.split("?")[0].split("/").pop()
            );
          }
          if (/\/CreateBookmark\b/.test(url)) {
            try {
              handleBookmarkAdded(readTweetIdFromBody(body));
            } catch (_) {}
          }
          if (/\/FavoriteTweet\b/.test(url)) {
            try {
              handleLikeAdded(readTweetIdFromBody(body));
            } catch (_) {}
          }
          if (/\/(DeleteBookmark|UnfavoriteTweet)\b/.test(url)) {
            try {
              handleUnsaved(readTweetIdFromBody(body));
            } catch (_) {}
          }
          const tmplSource = templateSource(url);
          if (tmplSource) {
            try {
              post({
                channel: "bmTemplate",
                source: tmplSource,
                template: {
                  url,
                  authorization: info.headers["authorization"] || null,
                },
              });
            } catch (_) {}
          }
          if (/\/graphql\//.test(url)) {
            this.addEventListener("load", function () {
              try {
                let data;
                if (this.responseType === "json") data = this.response;
                else if (this.responseType === "" || this.responseType === "text")
                  data = JSON.parse(this.responseText);
                else return; // arraybuffer/blob/document — not ours
                if (data) processGraphql(url, data);
              } catch (_) {
                /* never break the app */
              }
            });
          }
        }
      } catch (_) {}
      return origSend.apply(this, arguments);
    };

    // Splicing for XHR: X registers its load handlers before we can, so we
    // can't modify the payload "before X reads it" from an event. Instead we
    // patch the response getters — whichever code reads the body of a home
    // timeline XHR gets the spliced version (computed once, cached on the
    // request). Non-home requests pass straight through.
    const rtDesc = Object.getOwnPropertyDescriptor(XHR.prototype, "responseText");
    const rDesc = Object.getOwnPropertyDescriptor(XHR.prototype, "response");
    if (rtDesc && rtDesc.get) {
      Object.defineProperty(XHR.prototype, "responseText", {
        configurable: true,
        get: function () {
          const real = rtDesc.get.call(this);
          try {
            return spliceXhrText(this, real);
          } catch (_) {
            return real;
          }
        },
      });
    }
    if (rDesc && rDesc.get) {
      Object.defineProperty(XHR.prototype, "response", {
        configurable: true,
        get: function () {
          const real = rDesc.get.call(this);
          try {
            if (this.responseType === "json") return spliceXhrJson(this, real);
            if (this.responseType === "" || this.responseType === "text")
              return spliceXhrText(this, real);
          } catch (_) {}
          return real;
        },
      });
    }

    XHR.prototype.__feedReviveWrapped = true;
    console.log("[feed-revive] interceptor active (XHR hooked)");
  }

  function shouldSpliceXhr(xhr) {
    const info = xhr.__feedRevive;
    return (
      spliceEnabled &&
      splicePool.length > 0 &&
      info &&
      HOME_RE.test(info.url) &&
      xhr.readyState === 4
    );
  }

  function spliceXhrText(xhr, real) {
    const info = xhr.__feedRevive;
    if (info && info.splicedText !== undefined) return info.splicedText;
    if (typeof real !== "string" || !shouldSpliceXhr(xhr)) return real;
    let out = real;
    try {
      const data = JSON.parse(real);
      if (spliceTimeline(data)) out = JSON.stringify(data);
    } catch (_) {}
    info.splicedText = out;
    return out;
  }

  function spliceXhrJson(xhr, real) {
    const info = xhr.__feedRevive;
    if (!info || info.splicedJson) return real;
    if (!real || !shouldSpliceXhr(xhr)) return real;
    info.splicedJson = true; // parsed object is shared — mutate it once
    try {
      spliceTimeline(real);
    } catch (_) {}
    return real;
  }

  // Commands from the content script (isolated world).
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d) return;
    if (d.__feedReviveCmd === "refetchSaved") {
      refetchSaved(d.source === "likes" ? "likes" : "bookmarks", d.template).catch(() => {});
    } else if (d.__feedReviveCmd === "splicePool") {
      try {
        spliceEnabled = !!d.enabled;
        if (d.every > 0) spliceEvery = d.every;
        for (const node of d.nodes || []) addToSplicePool(node);
        if (spliceEnabled && splicePool.length) {
          console.log(
            `[feed-revive] real-tweet splicing armed — ${splicePool.length} tweet(s) in pool`
          );
        }
      } catch (_) {}
    }
  });

  // --- Real-tweet splicing ---------------------------------------------------

  function addToSplicePool(node) {
    if (!node || !node.rest_id || splicePoolIds.has(node.rest_id)) return;
    splicePoolIds.add(node.rest_id);
    splicePool.push(node);
  }

  function removeFromSplicePool(id) {
    if (!splicePoolIds.has(id)) return;
    splicePoolIds.delete(id);
    const i = splicePool.findIndex((n) => n && n.rest_id === id);
    if (i >= 0) splicePool.splice(i, 1);
  }

  // Insert saved tweets into a home timeline payload (mutates `data`).
  // Returns true if anything was inserted. Must never throw on X's data —
  // anything unexpected means "insert nothing", not "break the feed".
  function spliceTimeline(data) {
    if (!spliceEnabled || !splicePool.length) return false;
    const entries = findAddEntries(data);
    if (!entries) return false;

    const isTweetEntry = (e) =>
      e &&
      typeof e.entryId === "string" &&
      e.content &&
      e.content.entryType === "TimelineTimelineItem" &&
      e.content.itemContent &&
      e.content.itemContent.itemType === "TimelineTweet";

    // Every tweet id already in this payload (including inside conversation
    // modules) — never splice a duplicate next to the organic copy.
    const present = new Set();
    walk(entries, 0, (node) => {
      if (node && node.__typename === "Tweet" && node.rest_id) present.add(node.rest_id);
    });

    const positions = [];
    for (let i = 0; i < entries.length; i++) {
      if (isTweetEntry(entries[i])) positions.push(i);
    }
    if (!positions.length) return false; // cursor-only/empty page — leave it alone

    const want = Math.max(1, Math.round(positions.length / spliceEvery));
    const splicedIds = [];
    // Insert at the highest anchor first so earlier indices stay valid.
    for (let k = want; k >= 1; k--) {
      const node = nextSpliceNode(present);
      if (!node) break;
      const idx =
        positions[Math.min(Math.floor((positions.length * k) / (want + 1)), positions.length - 1)];
      entries.splice(idx + 1, 0, makeEntry(node, entries[idx]));
      present.add(node.rest_id);
      sessionSpliced.add(node.rest_id);
      splicedIds.push(node.rest_id);
    }

    if (splicedIds.length) {
      post({ channel: "spliced", ids: splicedIds });
      console.log(`[feed-revive] spliced ${splicedIds.length} saved tweet(s) into the timeline`);
    }
    return splicedIds.length > 0;
  }

  // The instructions live at data.home.home_timeline_urt.instructions today,
  // but we search for the TimelineAddEntries shape instead of hard-coding the
  // path — one less thing to break when X moves it.
  function findAddEntries(data) {
    let entries = null;
    walk(data, 0, (node) => {
      if (!entries && node && node.type === "TimelineAddEntries" && Array.isArray(node.entries)) {
        entries = node.entries;
      }
    });
    return entries;
  }

  // Uniform-random pick so old saves surface as often as fresh ones, but no
  // repeats until the whole pool has been shown this session.
  function nextSpliceNode(present) {
    for (let pass = 0; pass < 2; pass++) {
      const eligible = splicePool.filter(
        (n) => !present.has(n.rest_id) && !sessionSpliced.has(n.rest_id)
      );
      if (eligible.length) {
        return eligible[Math.floor(Math.random() * eligible.length)];
      }
      // Whole pool shown this session — start a new cycle and try once more.
      sessionSpliced.clear();
    }
    return null;
  }

  function makeEntry(node, anchor) {
    // sortIndex just below the anchor's, so clients that sort (rather than
    // trust array order) keep us right after it.
    let sortIndex = anchor && anchor.sortIndex;
    try {
      sortIndex = (BigInt(sortIndex) - 1n).toString();
    } catch (_) {}
    return {
      entryId: "tweet-" + node.rest_id,
      sortIndex: typeof sortIndex === "string" ? sortIndex : "0",
      content: {
        entryType: "TimelineTimelineItem",
        __typename: "TimelineTimelineItem",
        itemContent: {
          itemType: "TimelineTweet",
          __typename: "TimelineTweet",
          tweet_results: { result: node },
          tweetDisplayType: "Tweet",
        },
      },
    };
  }

  // --- Active re-fetch -----------------------------------------------------

  async function refetchSaved(source, template) {
    if (!template || !template.url) return;
    // These endpoints need the session's own authorization header; without it
    // the replay is guaranteed to 401, so don't bother (and say why).
    if (!template.authorization) {
      console.warn(
        `[feed-revive] captured ${source} request has no authorization header — scroll the ${source} page once to re-capture`
      );
      post({ channel: "refetchDone", source, total: 0, ok: false });
      return;
    }
    let cursor = null;
    let total = 0;
    let ok = true;
    for (let page = 0; page < MAX_PAGES; page++) {
      let data;
      try {
        // origFetch (not the wrapped one) so we don't recurse into ourselves.
        const res = await origFetch(setCursor(template.url, cursor), {
          headers: liveHeaders(template),
          credentials: "include",
        });
        if (!res.ok) {
          console.warn(`[feed-revive] ${source} refetch HTTP`, res.status);
          ok = false;
          break;
        }
        data = await res.json();
      } catch (e) {
        console.warn(`[feed-revive] ${source} refetch error`, e);
        ok = false;
        break;
      }
      const tweets = extractTweets(data);
      if (tweets.length) {
        for (const t of tweets) addToSplicePool(t.raw); // refetches feed the pool too
        post({ channel: "saved", source, tweets });
        total += tweets.length;
      }
      const next = findBottomCursor(data);
      if (!next || next === cursor || tweets.length === 0) break;
      cursor = next;
    }
    post({ channel: "refetchDone", source, total, ok });
  }

  function templateSource(url) {
    if (!url) return null;
    if (/\/Bookmarks\b/.test(url)) return "bookmarks";
    if (/\/Likes\b/.test(url)) return "likes";
    return null;
  }

  function liveHeaders(template) {
    const h = {
      authorization: template.authorization,
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
    };
    const ct0 = getCookie("ct0");
    if (ct0) h["x-csrf-token"] = ct0;
    return h;
  }

  function setCursor(urlStr, cursor) {
    const u = new URL(urlStr, location.href);
    let vars = {};
    try {
      vars = JSON.parse(u.searchParams.get("variables") || "{}");
    } catch (_) {}
    if (cursor) vars.cursor = cursor;
    else delete vars.cursor;
    u.searchParams.set("variables", JSON.stringify(vars));
    return u.toString();
  }

  function findBottomCursor(data) {
    let found = null;
    walk(data, 0, (node) => {
      if (node && node.cursorType === "Bottom" && typeof node.value === "string") {
        found = node.value;
      }
    });
    return found;
  }

  // --- Bookmark-added detection --------------------------------------------

  function readTweetId(req, init) {
    return readTweetIdFromBody(init && init.body);
  }

  function readTweetIdFromBody(body) {
    if (typeof body !== "string") return null;
    try {
      const parsed = JSON.parse(body);
      return (parsed && parsed.variables && parsed.variables.tweet_id) || null;
    } catch (_) {
      return null;
    }
  }

  function handleBookmarkAdded(tweetId) {
    if (!tweetId) return;
    const cached = tweetCache.get(tweetId);
    if (cached && cached.raw) {
      // A just-bookmarked tweet joins the revive pool right away, raw node
      // included, via the normal "saved" channel (persisted by the content
      // script) and the live splice pool.
      addToSplicePool(cached.raw);
      post({ channel: "saved", source: "bookmarks", tweets: [cached] });
    }
    const clip = Object.assign(
      {},
      cached || {
        id: tweetId,
        text: "",
        name: "Tweet",
        screenName: "",
        avatar: "",
        createdAt: "",
        capturedAt: Date.now(),
        partial: true,
      }
    );
    delete clip.raw; // the full node is for splicing, not for the Obsidian note
    clip.link = clip.screenName
      ? `https://x.com/${clip.screenName}/status/${clip.id}`
      : `https://x.com/i/status/${clip.id}`;
    post({ channel: "clip", clip });
  }

  // A like joins the revive pool the same way a bookmark does — but is NOT
  // clipped to Obsidian.
  function handleLikeAdded(tweetId) {
    if (!tweetId) return;
    const cached = tweetCache.get(tweetId);
    if (cached && cached.raw) {
      addToSplicePool(cached.raw);
      post({ channel: "saved", source: "likes", tweets: [cached] });
    }
  }

  // Un-liking / un-bookmarking evicts the tweet so it stops resurfacing.
  // (A tweet that was BOTH liked and bookmarked gets dropped too eagerly here,
  // but the next background refetch brings it back.)
  function handleUnsaved(tweetId) {
    if (!tweetId) return;
    removeFromSplicePool(tweetId);
    post({ channel: "unsaved", id: tweetId });
  }

  // --- GraphQL parsing -----------------------------------------------------

  function processGraphql(url, data) {
    const tweets = extractTweets(data);

    for (const t of tweets) {
      tweetCache.set(t.id, t);
      if (tweetCache.size > CACHE_MAX) {
        tweetCache.delete(tweetCache.keys().next().value);
      }
    }

    if (SAVED_RE.some((re) => re.test(url))) {
      for (const t of tweets) addToSplicePool(t.raw); // live captures join the pool
      const source = /\/Likes\b/.test(url) ? "likes" : "bookmarks";
      console.log(
        `[feed-revive] ${source} response parsed: ${tweets.length} usable tweet(s)` +
          (tweets.length ? "" : ` (raw Tweet nodes seen: ${countRawTweets(data)})`)
      );
      if (tweets.length) post({ channel: "saved", source, tweets });
    }
  }

  function countRawTweets(data) {
    let n = 0;
    walk(data, 0, (node) => {
      if (node && node.__typename === "Tweet") n++;
    });
    return n;
  }

  function extractTweets(data) {
    const out = [];
    const seen = new Set();
    walk(data, 0, (node) => {
      if (node && node.__typename === "Tweet" && node.rest_id) {
        if (seen.has(node.rest_id)) return;
        const t = normalizeTweet(node);
        if (t) {
          seen.add(node.rest_id);
          t.raw = node; // full node — needed to splice the real tweet back in
          out.push(t);
        }
      }
    });
    return out;
  }

  function walk(node, depth, visit) {
    if (!node || typeof node !== "object" || depth > 40) return;
    visit(node);
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1, visit);
    } else {
      for (const key in node) walk(node[key], depth + 1, visit);
    }
  }

  function normalizeTweet(node) {
    try {
      const legacy = node.legacy || {};
      const user =
        node.core && node.core.user_results && node.core.user_results.result;
      if (!user) return null;
      const uLegacy = user.legacy || {};
      const uCore = user.core || {};

      const text =
        (node.note_tweet &&
          node.note_tweet.note_tweet_results &&
          node.note_tweet.note_tweet_results.result &&
          node.note_tweet.note_tweet_results.result.text) ||
        legacy.full_text ||
        "";

      const screenName = uCore.screen_name || uLegacy.screen_name || "";
      if (!screenName) return null;

      return {
        id: node.rest_id,
        text: text,
        name: uCore.name || uLegacy.name || screenName,
        screenName: screenName,
        avatar:
          (user.avatar && user.avatar.image_url) ||
          uLegacy.profile_image_url_https ||
          "",
        createdAt: legacy.created_at || "",
        capturedAt: Date.now(),
      };
    } catch (_) {
      return null;
    }
  }

  // --- header / cookie helpers ---------------------------------------------

  function getHeader(req, init, name) {
    name = name.toLowerCase();
    const sources = [];
    if (init && init.headers) sources.push(init.headers);
    if (req && typeof req !== "string" && req.headers) sources.push(req.headers);
    for (const h of sources) {
      if (h && typeof h.get === "function") {
        const v = h.get(name);
        if (v) return v;
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) if (String(k).toLowerCase() === name) return v;
      } else if (h && typeof h === "object") {
        for (const k in h) if (k.toLowerCase() === name) return h[k];
      }
    }
    return null;
  }

  function getCookie(name) {
    const m = document.cookie.match(
      new RegExp("(?:^|; )" + name + "=([^;]*)")
    );
    return m ? decodeURIComponent(m[1]) : "";
  }
})();
