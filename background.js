const nativeDownloadWatches = new Map();
const NATIVE_DOWNLOAD_TTL = 60_000;
const DOWNLOAD_COMPLETE_TIMEOUT = 10 * 60 * 1000;
let filenameListenerReleaseTimer = null;

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
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    nativeDownloadWatches.set(token, {
      token,
      name: sanitizeFilename(message.filename || "flow-image"),
      startedAt: Date.now(),
      expiresAt: Date.now() + NATIVE_DOWNLOAD_TTL,
      downloadId: null
    });
    ensureFilenameListener();
    scheduleFilenameListenerRelease();
    sendResponse({ ok: true, token });
    return false;
  }

  if (message?.type === "waitPreparedDownload") {
    waitForPreparedDownload(message.token)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message?.type === "downloadSceneOutputs") {
    downloadSceneOutputs(message.outputs || [])
      .then((count) => sendResponse({ ok: true, count }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  return false;
});

function handleDeterminingFilename(downloadItem, suggest) {
  pruneExpiredNativeWatches();

  if (downloadItem.byExtensionId) {
    scheduleFilenameListenerRelease();
    return;
  }

  const watchEntry = findNativeWatch(downloadItem);
  if (!watchEntry) {
    scheduleFilenameListenerRelease();
    return;
  }

  const [token, watch] = watchEntry;
  watch.downloadId = downloadItem.id;
  nativeDownloadWatches.set(token, watch);

  suggest({
    filename: `Flow Image Stepper/${watch.name}${getExtension(downloadItem.filename)}`,
    conflictAction: "uniquify"
  });
  scheduleFilenameListenerRelease();
}

function ensureFilenameListener() {
  if (filenameListenerReleaseTimer) {
    clearTimeout(filenameListenerReleaseTimer);
    filenameListenerReleaseTimer = null;
  }
  if (!chrome.downloads.onDeterminingFilename.hasListener(handleDeterminingFilename)) {
    chrome.downloads.onDeterminingFilename.addListener(handleDeterminingFilename);
  }
}

function scheduleFilenameListenerRelease() {
  if (filenameListenerReleaseTimer) clearTimeout(filenameListenerReleaseTimer);
  filenameListenerReleaseTimer = setTimeout(() => {
    pruneExpiredNativeWatches();
    if (nativeDownloadWatches.size) {
      scheduleFilenameListenerRelease();
      return;
    }
    if (chrome.downloads.onDeterminingFilename.hasListener(handleDeterminingFilename)) {
      chrome.downloads.onDeterminingFilename.removeListener(handleDeterminingFilename);
    }
  }, 1000);
}

function pruneExpiredNativeWatches() {
  const now = Date.now();
  for (const [token, watch] of nativeDownloadWatches.entries()) {
    if (!watch.downloadId && watch.expiresAt <= now) {
      nativeDownloadWatches.delete(token);
    }
  }
}

function findNativeWatch(item = {}) {
  if (!shouldHandleNativeDownload(item)) return null;
  const createdAt = item.startTime ? Date.parse(item.startTime) : Date.now();
  return [...nativeDownloadWatches.entries()].find(([, watch]) => {
    if (watch.downloadId) return false;
    return createdAt >= watch.startedAt - 1000 && createdAt <= watch.expiresAt;
  });
}

function shouldHandleNativeDownload(downloadItem = {}) {
  if (downloadItem.byExtensionId) return false;
  const values = [downloadItem.url, downloadItem.finalUrl, downloadItem.referrer]
    .filter(Boolean)
    .join(" ");
  return /labs\.google|googleusercontent\.com|googleapis\.com/i.test(values);
}

async function downloadSceneOutputs(outputs) {
  const validOutputs = sortSceneOutputs(outputs.filter((output) => output?.src && output?.filename));
  if (!validOutputs.length) throw new Error("No downloadable scene image URLs were saved.");

  for (const output of validOutputs) {
    await downloadUrl({
      url: output.src,
      name: sanitizeFilename(output.filename || "flow-scene")
    });
  }
  return validOutputs.length;
}

function downloadUrl({ url, name }) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename: `Flow Image Stepper/${name}${getExtensionFromUrl(url)}`,
      conflictAction: "uniquify",
      saveAs: false
    }, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (typeof downloadId !== "number") {
        reject(new Error("Chrome did not return a download id."));
        return;
      }

      waitForDownloadComplete(downloadId)
        .then(() => resolve(downloadId))
        .catch((waitError) => reject(waitError));
    });
  });
}

function waitForPreparedDownload(token) {
  return new Promise((resolve, reject) => {
    const watch = nativeDownloadWatches.get(token);
    if (!watch) {
      reject(new Error("준비된 다운로드 정보를 찾지 못했습니다."));
      return;
    }

    let done = false;
    let startPoll = null;
    const noStartTimeout = setTimeout(() => {
      if (!watch.downloadId) finish(new Error("다운로드가 시작되지 않았습니다."));
    }, 15_000);
    const timeout = setTimeout(() => finish(new Error("Download completion timed out.")), DOWNLOAD_COMPLETE_TIMEOUT);

    function finish(error, item = null) {
      if (done) return;
      done = true;
      clearTimeout(noStartTimeout);
      clearTimeout(timeout);
      if (startPoll) clearInterval(startPoll);
      chrome.downloads.onChanged.removeListener(onChanged);
      nativeDownloadWatches.delete(token);
      scheduleFilenameListenerRelease();
      if (error) reject(error);
      else resolve({ downloadId: watch.downloadId, actualFilename: item?.filename || "" });
    }

    function checkCurrentState() {
      if (!watch.downloadId) return;
      chrome.downloads.search({ id: watch.downloadId }, (items) => {
        const item = items?.[0];
        if (item?.state === "complete") finish(null, item);
        if (item?.state === "interrupted") finish(new Error("Download was interrupted."), item);
      });
    }

    function onChanged(delta) {
      if (!watch.downloadId || delta.id !== watch.downloadId || !delta.state?.current) return;
      checkCurrentState();
    }

    chrome.downloads.onChanged.addListener(onChanged);
    startPoll = setInterval(() => {
      if (!nativeDownloadWatches.has(token)) {
        clearInterval(startPoll);
        return;
      }
      if (watch.downloadId) {
        clearInterval(startPoll);
        checkCurrentState();
      }
    }, 100);
  });
}

function waitForDownloadComplete(downloadId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Download completion timed out.")), DOWNLOAD_COMPLETE_TIMEOUT);

    function finish(error) {
      clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(onChanged);
      if (error) reject(error);
      else resolve();
    }

    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state?.current) return;
      if (delta.state.current === "complete") finish();
      if (delta.state.current === "interrupted") finish(new Error("Download was interrupted."));
    }

    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }, (items) => {
      const item = items?.[0];
      if (item?.state === "complete") finish();
      if (item?.state === "interrupted") finish(new Error("Download was interrupted."));
    });
  });
}

function sortSceneOutputs(outputs) {
  return [...outputs].sort((a, b) => {
    const sceneDiff = numericSortValue(a.sceneIndex) - numericSortValue(b.sceneIndex);
    if (sceneDiff) return sceneDiff;
    const outputDiff = numericSortValue(a.outputIndex) - numericSortValue(b.outputIndex);
    if (outputDiff) return outputDiff;
    return String(a.filename || "").localeCompare(String(b.filename || ""), undefined, { numeric: true });
  });
}

function numericSortValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}

function getExtension(filename) {
  const match = String(filename || "").match(/\.[a-z0-9]{2,5}$/i);
  return match ? match[0] : ".png";
}

function getExtensionFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    return getExtension(path);
  } catch (error) {
    return ".png";
  }
}

function sanitizeFilename(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "flow-image";
}