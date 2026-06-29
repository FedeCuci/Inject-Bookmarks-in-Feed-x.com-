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
  const CACHE_MAX = 500;
  const MAX_PAGES = 25; // re-fetch pagination safety cap
  // Public X web-app bearer token (stable for years); only a fallback — we
  // prefer the authorization header captured from a real request.
  const DEFAULT_BEARER =
    "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

  const tweetCache = new Map(); // id -> normalized tweet

  const post = (payload) =>
    window.postMessage(
      Object.assign({ __feedRevive: true }, payload),
      window.location.origin
    );

  const wrapped = async function (...args) {
    const req = args[0];
    const init = args[1];
    const url = typeof req === "string" ? req : req && req.url;

    if (url && /\/graphql\//.test(url)) {
      console.log("[feed-revive] graphql op:", url.split("?")[0].split("/").pop());
    }

    if (url && /\/CreateBookmark\b/.test(url)) {
      try {
        handleBookmarkAdded(readTweetId(req, init));
      } catch (_) {}
    }
    if (url && /\/Bookmarks\b/.test(url)) {
      try {
        post({
          channel: "bmTemplate",
          template: { url, authorization: getHeader(req, init, "authorization") },
        });
      } catch (_) {}
    }

    const response = await origFetch.apply(this, args);

    try {
      if (url && /\/graphql\//.test(url)) {
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
          if (/\/graphql\//.test(url)) {
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
          if (/\/Bookmarks\b/.test(url)) {
            try {
              post({
                channel: "bmTemplate",
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

    XHR.prototype.__feedReviveWrapped = true;
    console.log("[feed-revive] interceptor active (XHR hooked)");
  }

  // Commands from the content script (isolated world).
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__feedReviveCmd !== "refetchBookmarks") return;
    refetchBookmarks(d.template).catch(() => {});
  });

  // --- Active re-fetch -----------------------------------------------------

  async function refetchBookmarks(template) {
    if (!template || !template.url) return;
    let cursor = null;
    let total = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      let data;
      try {
        // origFetch (not the wrapped one) so we don't recurse into ourselves.
        const res = await origFetch(setCursor(template.url, cursor), {
          headers: liveHeaders(template),
          credentials: "include",
        });
        if (!res.ok) {
          console.warn("[feed-revive] bookmark refetch HTTP", res.status);
          break;
        }
        data = await res.json();
      } catch (e) {
        console.warn("[feed-revive] bookmark refetch error", e);
        break;
      }
      const tweets = extractTweets(data);
      if (tweets.length) {
        post({ channel: "saved", source: "bookmarks", tweets });
        total += tweets.length;
      }
      const next = findBottomCursor(data);
      if (!next || next === cursor || tweets.length === 0) break;
      cursor = next;
    }
    post({ channel: "refetchDone", source: "bookmarks", total });
  }

  function liveHeaders(template) {
    const h = {
      authorization: template.authorization || DEFAULT_BEARER,
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
    const clip = cached || {
      id: tweetId,
      text: "",
      name: "Tweet",
      screenName: "",
      avatar: "",
      createdAt: "",
      capturedAt: Date.now(),
      partial: true,
    };
    clip.link = clip.screenName
      ? `https://x.com/${clip.screenName}/status/${clip.id}`
      : `https://x.com/i/status/${clip.id}`;
    post({ channel: "clip", clip });
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
