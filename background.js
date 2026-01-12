// JaxPlays Photos: single prompt for JPG, WEBP mirrors name; robust filename handling

const MENU_PARENT = "jaxplays_photos_parent";

// Paths are RELATIVE to Chrome's configured download directory
// Set Chrome's download location to: /Users/rayhollister/Sites/jaxplays.org
const ACTIONS = [
  {
    id: "save_headshot",
    title: "Save a Headshot",
    jpgDir: "assets/media/headshots",
    webpDir: "static/media/headshots"
  },
  {
    id: "save_poster",
    title: "Save a Poster",
    jpgDir: "assets/media/posters",
    webpDir: "static/media/posters"
  },
  {
    id: "save_photo",
    title: "Save a Photo",
    jpgDir: "assets/media/photos",
    webpDir: "static/media/photos"
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
    const { baseName: suggestedBase, extension: originalExt } = deriveNames(info.srcUrl, imgBlob.type);

    // Prompt user for filename via injected script
    const filename = await promptForFilename(tab.id, suggestedBase);
    if (!filename) {
      notify("Canceled", "No filename provided");
      return;
    }

    const base = sanitize(filename) || sanitize(suggestedBase) || `image-${Date.now()}`;

    // Convert to WebP for static folder
    const webpBlob = await convertBlob(imgBlob, "image/webp", 0.92);

    // Save original format to assets folder, WebP to static folder
    const originalPath = `${action.jpgDir}/${base}.${originalExt}`;
    const webpPath = `${action.webpDir}/${base}.webp`;

    console.log("Saving original to:", originalPath);
    console.log("Saving webp to:", webpPath);

    // Convert blobs to data URLs for passing to content script
    const [originalDataUrl, webpDataUrl] = await Promise.all([
      blobToDataUrl(imgBlob),
      blobToDataUrl(webpBlob)
    ]);

    // Use content script to trigger downloads (anchor tag method respects filename)
    const [originalOk, webpOk] = await Promise.all([
      downloadViaContentScript(tab.id, originalDataUrl, `${base}.${originalExt}`, originalPath),
      downloadViaContentScript(tab.id, webpDataUrl, `${base}.webp`, webpPath)
    ]);

    if (originalOk && webpOk) {
      notify("Saved", `${base}.${originalExt} and ${base}.webp`);
    } else if (originalOk) {
      notify("Partial Save", `Original saved, WebP failed: ${base}`);
    } else if (webpOk) {
      notify("Partial Save", `WebP saved, original failed: ${base}`);
    } else {
      notify("Error", "Both saves failed");
    }
  } catch (e) {
    console.error("JaxPlays Photos error:", e);
    notify("Error", String(e?.message || e));
  }
});

// Prompt user for filename using injected script
async function promptForFilename(tabId, suggestedName) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (suggested) => {
        return prompt("Enter filename (without extension):", suggested);
      },
      args: [suggestedName]
    });
    return results?.[0]?.result || null;
  } catch (err) {
    console.warn("Could not prompt for filename:", err);
    return suggestedName; // Fall back to suggested name
  }
}

// ---- Helpers ----

async function fetchImageAsBlob(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.blob();
}

function deriveNames(srcUrl, mimeType) {
  // Map MIME types to extensions
  const mimeToExt = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/tiff": "tiff"
  };

  try {
    const u = new URL(srcUrl);
    const leaf = u.pathname.split("/").filter(Boolean).pop() || "image";
    // Extract extension from URL
    const urlExtMatch = leaf.match(/\.([a-zA-Z0-9]+)$/);
    const urlExt = urlExtMatch ? urlExtMatch[1].toLowerCase() : null;
    // Use MIME type extension, fall back to URL extension, then default to jpg
    const extension = mimeToExt[mimeType] || urlExt || "jpg";
    const base = leaf.replace(/\.[a-zA-Z0-9]+$/, "");
    const safeBase = sanitize(base);
    return { baseName: safeBase || `image-${Date.now()}`, extension };
  } catch {
    const extension = mimeToExt[mimeType] || "jpg";
    return { baseName: `image-${Date.now()}`, extension };
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

// Download via content script using anchor tag (respects filename)
async function downloadViaContentScript(tabId, dataUrl, filename, fullPath) {
  console.log("downloadViaContentScript:", filename, "->", fullPath);

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (dataUrl, filename) => {
        return new Promise((resolve) => {
          try {
            // Convert data URL to blob
            fetch(dataUrl)
              .then(res => res.blob())
              .then(blob => {
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = filename;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                // Clean up after a delay
                setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
                resolve({ success: true });
              })
              .catch(err => resolve({ success: false, error: err.message }));
          } catch (err) {
            resolve({ success: false, error: err.message });
          }
        });
      },
      args: [dataUrl, filename]
    });

    const result = results?.[0]?.result;
    console.log("Content script result:", result);
    return result?.success || false;
  } catch (err) {
    console.warn("downloadViaContentScript failed:", err);
    return false;
  }
}

// Save silently using offscreen document for blob URL creation (backup method)
async function saveSilently(blob, path) {
  const dataUrl = await blobToDataUrl(blob);
  const cleanPath = path.replace(/^\/+/, '').replace(/\\/g, '/');
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  console.log("saveSilently via offscreen:", cleanPath);

  try {
    // Ensure offscreen document exists
    await ensureOffscreenDocument();

    // Get blob URL from offscreen document
    const blobResponse = await chrome.runtime.sendMessage({
      target: 'offscreen',
      op: 'createBlobUrl',
      dataUrl: dataUrl,
      id: requestId
    });

    console.log("Blob URL response:", JSON.stringify(blobResponse));

    if (!blobResponse?.success || !blobResponse?.blobUrl) {
      console.warn("Failed to create blob URL:", blobResponse?.error);
      return false;
    }

    // Now download using the blob URL from background script
    const downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: blobResponse.blobUrl,
        filename: cleanPath,
        conflictAction: "uniquify",
        saveAs: false
      }, (id) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(id);
        }
      });
    });

    console.log("Download started with id:", downloadId);

    // Wait for completion
    const outcome = await waitForCompletion(downloadId, 20000);
    console.log("Download outcome:", JSON.stringify(outcome));

    // Clean up blob URL
    chrome.runtime.sendMessage({
      target: 'offscreen',
      op: 'revokeBlobUrl',
      id: requestId
    }).catch(() => {}); // Ignore errors

    return outcome.success;
  } catch (err) {
    console.warn("saveSilently failed:", err);
    return false;
  }
}

// Lock to prevent race condition when creating offscreen document
let creatingOffscreen = null;

// Create offscreen document if it doesn't exist
async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');

  // Check if already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) {
    return; // Already exists
  }

  // If already creating, wait for that to finish
  if (creatingOffscreen) {
    return creatingOffscreen;
  }

  // Create it (with lock to prevent race condition)
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Convert data URLs to blob URLs for downloads with correct filenames'
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

// Save original file directly from URL (no conversion)
async function saveFromUrl(srcUrl, path) {
  console.log("saveFromUrl called with path:", path);
  try {
    const id = await downloadsDownload({
      url: srcUrl,
      filename: path,
      conflictAction: "uniquify",
      saveAs: false
    });
    console.log("Download started with id:", id);

    const outcome = await waitForCompletion(id, 20000);
    console.log("Download outcome:", outcome);
    if (!outcome.success) {
      console.warn("URL save did not complete:", outcome.reason || "unknown");
      await downloadsCancel(id);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("URL save failed:", err);
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
