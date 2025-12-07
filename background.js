// JaxPlays Photos: single prompt for JPG, WEBP mirrors name; robust filename handling

const MENU_PARENT = "jaxplays_photos_parent";

// Absolute paths for the renamed site; fallbacks stay relative to Chrome's download dir
const SITE_ROOT = "Sites/jaxplays.org/";
const ASSET_ROOT = `${SITE_ROOT}/assets/media`;
const STATIC_ROOT = `${SITE_ROOT}/static/media`;

const ACTIONS = [
  {
    id: "save_headshot",
    title: "Save a Headshot",
    jpgDir: `${ASSET_ROOT}/headshots`,
    webpDir: `${STATIC_ROOT}/headshots`,
    jpgFallback: "assets/media/headshots",
    webpFallback: "static/media/headshots"
  },
  {
    id: "save_poster",
    title: "Save a Poster",
    jpgDir: `${ASSET_ROOT}/posters`,
    webpDir: `${STATIC_ROOT}/posters`,
    jpgFallback: "assets/media/posters",
    webpFallback: "static/media/posters"
  },
  {
    id: "save_photo",
    title: "Save a Photo",
    jpgDir: `${ASSET_ROOT}/photos`,
    webpDir: `${STATIC_ROOT}/photos`,
    jpgFallback: "assets/media/photos",
    webpFallback: "static/media/photos"
  }
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_PARENT, title: "JaxPlays Photos", contexts: ["image"] });
  for (const a of ACTIONS) {
    chrome.contextMenus.create({ id: a.id, parentId: MENU_PARENT, title: a.title, contexts: ["image"] });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info.srcUrl) return;
  const action = ACTIONS.find(a => a.id === info.menuItemId);
  if (!action) return;

  try {
    const imgBlob = await fetchImageAsBlob(info.srcUrl);
    const { baseName: suggestedBase } = deriveNames(info.srcUrl, tab?.url);

    // Convert once each
    const jpgBlob = await convertBlob(imgBlob, "image/jpeg", 0.92);
    const webpBlob = await convertBlob(imgBlob, "image/webp", 0.92);

    // 1) Prompt once for JPG
    const jpgSuggested = `${action.jpgDir}/${suggestedBase}.jpg`;
    const jpgFallback = action.jpgFallback ? `${action.jpgFallback}/${suggestedBase}.jpg` : jpgSuggested;
    const chosenJpgPath = await saveWithPromptAndGetPath(jpgBlob, jpgSuggested, jpgFallback);
    if (!chosenJpgPath) {
      notify("Canceled", "Save dialog closed without saving");
      return;
    }

    // Get safe base name from the actual chosen file
    const rawBase = getFilenameWithoutExt(chosenJpgPath);
    const base = sanitize(rawBase) || sanitize(suggestedBase) || `image-${Date.now()}`;

    // 2) Try silent WEBP save with the same base
    const webpSuggested = `${action.webpDir}/${base}.webp`;
    const webpFallback = action.webpFallback ? `${action.webpFallback}/${base}.webp` : webpSuggested;
    const silentOk = await saveSilentlyWithConfirm(webpBlob, webpSuggested, webpFallback);

    if (!silentOk) {
      // Fallback: prompt for WEBP with same suggested folder and base
      await saveWithPromptAndGetPath(webpBlob, webpSuggested, webpFallback);
    }

    notify("Saved", `${action.title}: ${base}.jpg and ${base}.webp`);
  } catch (e) {
    console.error("JaxPlays Photos error:", e);
    notify("Error", String(e?.message || e));
  }
});

// ---- Helpers ----

async function fetchImageAsBlob(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.blob();
}

function deriveNames(srcUrl, pageUrl) {
  try {
    const u = new URL(srcUrl);
    const leaf = u.pathname.split("/").filter(Boolean).pop() || "image";
    const base = leaf.replace(/\.[a-zA-Z0-9]+$/, "");
    const host = u.host?.split(":")[0] || new URL(pageUrl || "https://x").host;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safeBase = sanitize(`${base}-${host}-${ts}`);
    return { baseName: safeBase };
  } catch {
    const ts = Date.now();
    return { baseName: `image-${ts}` };
  }
}

// Keep letters, numbers, dot, underscore, hyphen; collapse repeats; limit length
function sanitize(s) {
  return String(s).normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
}

// Works for absolute paths or Chrome’s internal paths
function getFilenameWithoutExt(fullPath) {
  if (!fullPath) return "";
  const norm = fullPath.replace(/\\/g, "/");
  const name = norm.split("/").pop() || norm;
  return name.replace(/\.[^.]+$/, "");
}

// Conversion using OffscreenCanvas in MV3 SW
async function convertBlob(srcBlob, mimeType, quality) {
  const bitmap = await createImageBitmap(srcBlob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: mimeType, quality });
  bitmap.close?.();
  return blob;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// One dialog, return the actual filename Chrome used
async function saveWithPromptAndGetPath(blob, primaryPath, fallbackPath) {
  const dataUrl = await blobToDataUrl(blob);

  const attempt = async (path) => {
    const id = await downloadsDownload({
      url: dataUrl,
      filename: path,
      conflictAction: "uniquify",
      saveAs: true
    }).catch(err => {
      console.warn("download failed:", err);
      return null;
    });
    if (!id) return null;
    const filename = await waitForFilenameOrComplete(id, 10000);
    return filename || null;
  };

  let filename = await attempt(primaryPath);
  if (!filename && fallbackPath && fallbackPath !== primaryPath) {
    filename = await attempt(fallbackPath);
  }
  return filename;
}

// Try silent save, ensure it actually completes, fallback if not
async function saveSilentlyWithConfirm(blob, primaryPath, fallbackPath) {
  const dataUrl = await blobToDataUrl(blob);

  const attempt = async (path) => {
    let id;
    try {
      id = await downloadsDownload({
        url: dataUrl,
        filename: path,
        conflictAction: "uniquify",
        saveAs: false
      });
    } catch (err) {
      console.warn("Silent save blocked or failed:", err);
      return { started: false, success: false };
    }

    const outcome = await waitForCompletion(id, 20000);
    if (!outcome.success) {
      console.warn("Silent save did not complete:", outcome.reason || "unknown reason");
      await downloadsCancel(id);
      return { started: true, success: false };
    }

    return { started: true, success: true };
  };

  let result = await attempt(primaryPath);
  if (result.success) return true;

  if (!result.started && fallbackPath && fallbackPath !== primaryPath) {
    result = await attempt(fallbackPath);
    if (result.success) return true;
  }

  return false;
}

// Promisified chrome.downloads APIs
function downloadsDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, id => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(id);
    });
  });
}

function downloadsSearch(query) {
  return new Promise((resolve, reject) => {
    chrome.downloads.search(query, items => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(items);
    });
  });
}

function downloadsCancel(id) {
  return new Promise(resolve => {
    chrome.downloads.cancel(id, () => {
      // Ignore cancel errors; return best-effort boolean
      const ok = !chrome.runtime.lastError;
      resolve(ok);
    });
  });
}

// Wait until Chrome reports the chosen filename or completes
async function waitForFilenameOrComplete(id, timeoutMs) {
  return new Promise(resolve => {
    const start = Date.now();
    let settled = false;
    let timer;

    const finish = value => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      if (timer) clearInterval(timer);
      resolve(value);
    };

    const onChanged = delta => {
      if (delta.id !== id) return;
      if (delta.filename && delta.filename.current) {
        finish(delta.filename.current.replace(/\\/g, "/"));
      } else if (delta.state && delta.state.current === "complete") {
        downloadsSearch({ id }).then(items => {
          finish((items?.[0]?.filename || "").replace(/\\/g, "/"));
        }).catch(() => finish(""));
      } else if (delta.state && delta.state.current === "interrupted") {
        finish("");
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);

    timer = setInterval(async () => {
      if (Date.now() - start > timeoutMs) {
        const items = await downloadsSearch({ id }).catch(() => []);
        finish((items?.[0]?.filename || "").replace(/\\/g, "/"));
      }
    }, 400);
  });
}

async function waitForCompletion(id, timeoutMs) {
  return new Promise(resolve => {
    const start = Date.now();
    let settled = false;
    let timer;

    const finish = result => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      if (timer) clearInterval(timer);
      resolve(result);
    };

    const normalizePath = path => (path || "").replace(/\\/g, "/");

    const checkItem = async (final = false) => {
      const items = await downloadsSearch({ id }).catch(() => []);
      const item = items?.[0];
      if (!item) return final ? { success: false, reason: "missing", filename: "" } : null;
      if (item.state === "complete") return { success: true, filename: normalizePath(item.filename) };
      if (item.state === "interrupted") return { success: false, reason: item.error || "interrupted", filename: normalizePath(item.filename) };
      if (item.danger && item.danger !== "safe") return { success: false, reason: `danger-${item.danger}`, filename: normalizePath(item.filename) };
      if (final) return { success: false, reason: item.state || "timeout", filename: normalizePath(item.filename) };
      return null;
    };

    const onChanged = delta => {
      if (delta.id !== id) return;
      if (delta.state) {
        const state = delta.state.current;
        if (state === "complete") {
          finish({ success: true, filename: normalizePath(delta.filename?.current) });
          return;
        }
        if (state === "interrupted") {
          finish({ success: false, reason: delta.error?.current || "interrupted", filename: normalizePath(delta.filename?.current) });
          return;
        }
      }
      if (delta.danger && delta.danger.current && delta.danger.current !== "safe") {
        finish({ success: false, reason: `danger-${delta.danger.current}`, filename: normalizePath(delta.filename?.current) });
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);

    (async () => {
      const immediate = await checkItem();
      if (immediate) {
        finish(immediate);
        return;
      }

      timer = setInterval(async () => {
        if (settled) return;
        if (Date.now() - start > timeoutMs) {
          const finalStatus = await checkItem(true);
          finish(finalStatus || { success: false, reason: "timeout", filename: "" });
        }
      }, 400);
    })();
  });
}

function notify(title, message) {
  // Try icon128, then 48, then create without icon if both fail
  const tryCreate = (iconPath) =>
    new Promise((resolve) => {
      const opts = {
        type: "basic",
        title,
        message
      };
      if (iconPath) opts.iconUrl = chrome.runtime.getURL(iconPath);
      chrome.notifications.create(opts, () => {
        // Swallow notification image errors
        // (Chrome reports them via lastError, not throw)
        // eslint-disable-next-line no-unused-expressions
        chrome.runtime.lastError;
        resolve(Boolean(!chrome.runtime.lastError));
      });
    });

  (async () => {
    // Try icon128
    if (await tryCreate("icons/icon128.png")) return;
    // Try icon48
    if (await tryCreate("icons/icon48.png")) return;
    // Try without icon
    await tryCreate(null);
  })();
}
