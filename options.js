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
}

$("save").addEventListener("click", async () => {
  await ext.storage.local.set({ [SETTINGS_KEY]: readForm() });
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
