const pendingDownloadNames = [];

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
  const nextName = pendingDownloadNames.shift();
  if (!nextName) return;

  const extension = getExtension(downloadItem.filename);
  suggest({
    filename: `Flow Image Stepper/${nextName}${extension}`,
    conflictAction: "uniquify"
  });
});

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
    pendingDownloadNames.push(sanitizeFilename(output.filename || "flow-scene"));
    await downloadUrl({
      url: output.src
    });
  }
  return validOutputs.length;
}

function downloadUrl({ url }) {
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
      resolve(downloadId);
    });
  });
}
