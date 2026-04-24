const pendingDownloadNames = [];
const pendingDownloadRequests = [];
const pendingDownloadNamesById = new Map();

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.runtime.onStartup.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "prepareDownloadName") {
    pendingDownloadNames.push(sanitizeFilename(message.filename || "flow-image"));
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "downloadSceneOutputs") {
    downloadSceneOutputs(message.outputs || [])
      .then((count) => sendResponse({ ok: true, count }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
});

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  if (!shouldHandleDownload(downloadItem)) {
    suggest();
    return;
  }

  let nextName = pendingDownloadNamesById.get(downloadItem.id);
  if (nextName) {
    pendingDownloadNamesById.delete(downloadItem.id);
    removePendingRequestById(downloadItem.id);
  } else if (downloadItem.byExtensionId === chrome.runtime.id) {
    const request = pendingDownloadRequests.shift();
    nextName = request?.name || "";
  } else {
    nextName = pendingDownloadNames.shift();
  }

  if (!nextName) {
    suggest();
    return;
  }

  const extension = getExtension(downloadItem.filename);
  suggest({
    filename: `Flow Image Stepper/${nextName}${extension}`,
    conflictAction: "uniquify"
  });
});

function shouldHandleDownload(downloadItem = {}) {
  if (downloadItem.byExtensionId && downloadItem.byExtensionId !== chrome.runtime.id) {
    return false;
  }

  if (downloadItem.byExtensionId === chrome.runtime.id) {
    return true;
  }

  const values = [downloadItem.url, downloadItem.finalUrl, downloadItem.referrer]
    .filter(Boolean)
    .join(" ");
  return /labs\.google|googleusercontent\.com|googleapis\.com/i.test(values);
}

function getExtension(filename) {
  const match = filename.match(/\.[a-z0-9]{2,5}$/i);
  return match ? match[0] : ".png";
}

function sanitizeFilename(value) {
  return value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

async function downloadSceneOutputs(outputs) {
  const validOutputs = outputs.filter((output) => output?.src && output?.filename);
  if (!validOutputs.length) throw new Error("No downloadable scene image URLs were saved.");

  for (const output of validOutputs) {
    const request = {
      id: null,
      name: sanitizeFilename(output.filename || "flow-scene")
    };
    pendingDownloadRequests.push(request);
    await downloadUrl({
      url: output.src,
      request
    });
  }
  return validOutputs.length;
}

function downloadUrl({ url, request }) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      conflictAction: "uniquify",
      saveAs: false
    }, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (typeof downloadId === "number" && request) {
        request.id = downloadId;
        pendingDownloadNamesById.set(downloadId, request.name);
      }
      resolve(downloadId);
    });
  });
}

function removePendingRequestById(downloadId) {
  const index = pendingDownloadRequests.findIndex((request) => request.id === downloadId);
  if (index >= 0) pendingDownloadRequests.splice(index, 1);
}
