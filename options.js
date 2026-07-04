const ext = globalThis.browser || globalThis.chrome;
const SETTINGS_KEY = "feedRevive.obsidian";
const DEFAULTS = {
  enabled: true,
  baseUrl: "http://127.0.0.1:27123",
  apiKey: "",
  folder: "Twitter",
};

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = cls || "";
}

function readForm() {
  return {
    enabled: $("enabled").checked,
    baseUrl: $("baseUrl").value.trim() || DEFAULTS.baseUrl,
    apiKey: $("apiKey").value.trim(),
    folder: $("folder").value.trim() || DEFAULTS.folder,
  };
}

async function load() {
  const r = await ext.storage.local.get(SETTINGS_KEY);
  const s = Object.assign({}, DEFAULTS, (r && r[SETTINGS_KEY]) || {});
  $("enabled").checked = s.enabled;
  $("baseUrl").value = s.baseUrl;
  $("apiKey").value = s.apiKey;
  $("folder").value = s.folder;
  loadReviveStatus();
}

// Surface whether the background bookmarks refresh is actually working — its
// failures otherwise only show up in the x.com console.
async function loadReviveStatus() {
  const r = await ext.storage.local.get([
    "feedRevive.posts",
    "feedRevive.bmTemplate",
    "feedRevive.likesTemplate",
    "feedRevive.lastRefreshOk",
    "feedRevive.spliceEnabled",
    "feedRevive.likesOrder",
    "feedRevive.clipQueue",
    "feedRevive.pendingClips",
    "feedRevive.backfill",
  ]);
  const queued = (r["feedRevive.clipQueue"] || []).length;
  const pending = (r["feedRevive.pendingClips"] || []).length;
  const clipBits = [];
  if (queued) clipBits.push(`${queued} clip(s) queued until Obsidian is reachable`);
  if (pending) clipBits.push(`${pending} bookmark(s) waiting for tweet data`);
  $("clipQueueInfo").textContent = clipBits.length ? clipBits.join("; ") + "." : "";
  $("splice").checked = r["feedRevive.spliceEnabled"] !== false; // default on
  $("likesOrder").value = r["feedRevive.likesOrder"] || "default";
  const stored = r["feedRevive.posts"] || [];
  const count = stored.length;
  const rawCount = stored.filter((p) => p && p.raw).length;
  const bf = r["feedRevive.backfill"] || {};
  const bfState = (src) =>
    bf[src] && bf[src].done ? "history fully backfilled" : "backfilling history";
  const sources = [
    r["feedRevive.bmTemplate"] && `bookmarks (${bfState("bookmarks")})`,
    r["feedRevive.likesTemplate"] && `likes (${bfState("likes")})`,
  ]
    .filter(Boolean)
    .join(" + ");
  let refresh;
  if (!sources) {
    refresh =
      "Background refresh not set up yet — open x.com/i/bookmarks and your profile's Likes tab, and scroll each once.";
  } else if (r["feedRevive.lastRefreshOk"]) {
    refresh =
      `Background refresh armed for ${sources}. Last success: ` +
      new Date(r["feedRevive.lastRefreshOk"]).toLocaleString() +
      ".";
  } else {
    refresh = `Background refresh armed for ${sources}, but none has succeeded yet.`;
  }
  $("reviveStatus").textContent =
    `${count} post(s) in the revive pool, ${rawCount} with full tweet data ` +
    `for real-tweet injection. ${refresh}`;
}

$("save").addEventListener("click", async () => {
  await ext.storage.local.set({
    [SETTINGS_KEY]: readForm(),
    "feedRevive.spliceEnabled": $("splice").checked,
    "feedRevive.likesOrder": $("likesOrder").value,
  });
  setStatus("Saved.", "ok");
});

$("test").addEventListener("click", async () => {
  setStatus("Testing…");
  const res = await ext.runtime.sendMessage({ type: "ping", settings: readForm() });
  if (res && res.ok) {
    setStatus("Connected to Obsidian Local REST API ✓", "ok");
  } else {
    const detail = res && (res.status || res.error) ? ` (${res.status || res.error})` : "";
    setStatus(
      `Could not reach the Local REST API${detail}. Check the plugin is running, the HTTP server is enabled, and the URL/key are correct.`,
      "err"
    );
  }
});

load();
