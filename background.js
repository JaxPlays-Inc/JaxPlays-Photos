// JaxPlays Photos: single prompt for JPG, WEBP mirrors name; robust filename handling

const MENU_PARENT = "jaxplays_photos_parent";

const ACTIONS = [
  { id: "save_headshot", title: "Save a Headshot", jpgDir: "assets/media/headshots", webpDir: "static/media/headshots" },
  { id: "save_poster",   title: "Save a Poster",   jpgDir: "assets/media/posters",   webpDir: "static/media/posters" },
  { id: "save_photo",    title: "Save a Photo",    jpgDir: "assets/media/photos",    webpDir: "static/media/photos" }
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
    const chosenJpgPath = await saveWithPromptAndGetPath(jpgBlob, jpgSuggested);
    if (!chosenJpgPath) {
      notify("Canceled", "Save dialog closed without saving");
      return;
    }

    // Get safe base name from the actual chosen file
    const rawBase = getFilenameWithoutExt(chosenJpgPath);
    const base = sanitize(rawBase) || sanitize(suggestedBase) || `image-${Date.now()}`;

    // 2) Try silent WEBP save with the same base
    const webpSuggested = `${action.webpDir}/${base}.webp`;
    const silentOk = await saveSilentlyWithConfirm(webpBlob, webpSuggested);

    if (!silentOk) {
      // Fallback: prompt for WEBP with same suggested folder and base
      await saveWithPromptAndGetPath(webpBlob, webpSuggested);
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
async function saveWithPromptAndGetPath(blob, suggestedPath) {
  const dataUrl = await blobToDataUrl(blob);
  const id = await downloadsDownload({
    url: dataUrl,
    filename: suggestedPath,
    conflictAction: "uniquify",
    saveAs: true
  }).catch(err => {
    console.warn("download failed:", err);
    return null;
  });
  if (!id) return null;
  const filename = await waitForFilenameOrComplete(id, 10000);
  return filename || null;
}

// Try silent save, confirm it actually started
async function saveSilentlyWithConfirm(blob, path) {
  try {
    const dataUrl = await blobToDataUrl(blob);
    const id = await downloadsDownload({
      url: dataUrl,
      filename: path,
      conflictAction: "uniquify",
      saveAs: false
    });
    const ok = await waitForBegin(id, 5000);
    if (!ok) {
      console.warn("Silent save did not start within timeout");
      return false;
    }
    return true;
  } catch (err) {
    console.warn("Silent save blocked or failed:", err);
    return false;
  }
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

// Wait until Chrome reports the chosen filename or completes
async function waitForFilenameOrComplete(id, timeoutMs) {
  return new Promise(resolve => {
    const start = Date.now();

    const onChanged = delta => {
      if (delta.id !== id) return;
      if (delta.filename && delta.filename.current) {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(delta.filename.current.replace(/\\/g, "/"));
      } else if (delta.state && delta.state.current === "complete") {
        chrome.downloads.onChanged.removeListener(onChanged);
        downloadsSearch({ id }).then(items => {
          resolve((items?.[0]?.filename || "").replace(/\\/g, "/"));
        }).catch(() => resolve(""));
      } else if (delta.state && delta.state.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve("");
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);

    const t = setInterval(async () => {
      if (Date.now() - start > timeoutMs) {
        chrome.downloads.onChanged.removeListener(onChanged);
        const items = await downloadsSearch({ id }).catch(() => []);
        resolve((items?.[0]?.filename || "").replace(/\\/g, "/"));
        clearInterval(t);
      }
    }, 400);
  });
}

// Wait for a download to at least begin
async function waitForBegin(id, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const items = await downloadsSearch({ id }).catch(() => []);
    const it = items?.[0];
    if (it && (it.state === "in_progress" || it.state === "complete")) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
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
