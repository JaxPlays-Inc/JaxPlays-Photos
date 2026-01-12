// Offscreen document for JaxPlays Photos - creates blob URLs from data URLs

// Store blob URLs so they don't get garbage collected
const blobUrls = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  if (message.op === 'createBlobUrl') {
    createBlobUrl(message.dataUrl, message.id)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async response
  }

  if (message.op === 'revokeBlobUrl') {
    const url = blobUrls.get(message.id);
    if (url) {
      URL.revokeObjectURL(url);
      blobUrls.delete(message.id);
    }
    sendResponse({ success: true });
    return false;
  }

  return false;
});

async function createBlobUrl(dataUrl, id) {
  try {
    // Convert data URL to blob
    const response = await fetch(dataUrl);
    const blob = await response.blob();

    // Create blob URL (works in offscreen document)
    const blobUrl = URL.createObjectURL(blob);

    // Store it so it doesn't get garbage collected
    blobUrls.set(id, blobUrl);

    console.log('Created blob URL for', id, ':', blobUrl.substring(0, 50));
    return { success: true, blobUrl };
  } catch (err) {
    console.error('Blob URL creation error:', err);
    return { success: false, error: err.message };
  }
}
