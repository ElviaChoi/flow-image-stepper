const sourceEl = document.getElementById("source");
const summaryEl = document.getElementById("summary");
const logEl = document.getElementById("log");
const modelEl = document.getElementById("model");
const sceneCountEl = document.getElementById("sceneCount");
const aspectRatioEl = document.getElementById("aspectRatio");

let parsed = null;
let characterIndex = 0;
let sceneIndex = 0;
let sceneOutputs = [];
let characterRefs = {};
let checkpoint = null;

init();

function init() {
  chrome.storage.local.get(["source", "parsed", "characterIndex", "sceneIndex", "sceneOutputs", "characterRefs", "checkpoint", "model", "sceneCount", "aspectRatio"], (data) => {
    if (data.source) sourceEl.value = data.source;
    if (data.model) modelEl.value = data.model;
    if (data.sceneCount) sceneCountEl.value = String(data.sceneCount);
    if (data.aspectRatio) aspectRatioEl.value = data.aspectRatio;
    sceneOutputs = data.sceneOutputs || [];
    characterRefs = data.characterRefs || {};
    checkpoint = data.checkpoint || null;
    if (data.parsed) {
      parsed = data.parsed;
      characterIndex = data.characterIndex || 0;
      sceneIndex = data.sceneIndex || 0;
      renderSummary();
    }
  });

  document.getElementById("parse").addEventListener("click", parseInput);
  document.getElementById("runCharacters").addEventListener("click", () => runStep("runCharacters"));
  document.getElementById("runScenes").addEventListener("click", () => runStep("runScenes"));
  document.getElementById("recoverScene").addEventListener("click", () => runRecoverScene());
  document.getElementById("backScene").addEventListener("click", () => backOneScene());
  document.getElementById("downloadScenes").addEventListener("click", () => runDownloadScenes());
  document.getElementById("clearSource").addEventListener("click", clearSource);
  modelEl.addEventListener("change", saveSettings);
  sceneCountEl.addEventListener("change", saveSettings);
  aspectRatioEl.addEventListener("change", saveSettings);
}

function parseInput() {
  parsed = FlowPromptParser.parse(sourceEl.value);
  characterIndex = 0;
  sceneIndex = 0;
  sceneOutputs = [];
  characterRefs = {};
  checkpoint = null;
  chrome.storage.local.set({
    source: sourceEl.value,
    parsed,
    characterIndex,
    sceneIndex,
    characterRefs: {},
    sceneOutputs: [],
    checkpoint: null,
    ...getCurrentSettings()
  });
  renderSummary();
  setLog("Parsed prompts.");
}

function renderSummary() {
  if (!parsed) return;
  summaryEl.classList.remove("empty");
  summaryEl.textContent = `${renderResumePoint()}

${FlowPromptParser.summarize(parsed)}

Next character: ${Math.min(characterIndex + 1, parsed.characters.length)}/${parsed.characters.length}
Next scene: ${Math.min(sceneIndex + 1, parsed.scenes.length)}/${parsed.scenes.length}

${renderCharacterRefStatus()}

${renderSceneOutputStatus()}`;
}

function renderResumePoint() {
  const nextCharacter = parsed.characters[characterIndex];
  const nextScene = parsed.scenes[sceneIndex];
  const last = checkpoint
    ? `${checkpoint.label} at ${new Date(checkpoint.savedAt).toLocaleString("ko-KR")}`
    : "No completed step yet.";
  return `Resume point:
- Last success: ${last}
- Next character: ${nextCharacter ? nextCharacter.id : "done"}
- Next scene: ${nextScene ? String(nextScene.index).padStart(3, "0") : "done"}
- Model: ${modelEl.value}`;
}

function renderCharacterRefStatus() {
  if (!parsed?.characters?.length) return "Character reference status: none";
  const lines = parsed.characters.map((character, index) => {
    const ref = characterRefs[character.id];
    const marker = index < characterIndex ? "done" : index === characterIndex ? "next" : "todo";
    const saved = ref ? "saved" : "missing";
    const model = ref?.model ? ` / ${ref.model}` : "";
    const media = ref?.mediaName ? `: ${ref.mediaName}` : "";
    return `- ${character.id} [${marker}] ${saved}${model}${media}`;
  });
  return `Character reference status:\n${lines.join("\n")}`;
}

function renderSceneOutputStatus() {
  if (!parsed?.scenes?.length) return "Scene output status: none";
  const byScene = new Map();
  for (const output of sceneOutputs) {
    const list = byScene.get(output.sceneIndex) || [];
    list.push(output);
    byScene.set(output.sceneIndex, list);
  }

  const lines = parsed.scenes.map((scene, index) => {
    const outputs = byScene.get(scene.index) || [];
    const marker = index < sceneIndex ? "done" : index === sceneIndex ? "next" : "todo";
    const models = [...new Set(outputs.map((output) => output.model).filter(Boolean))];
    const model = models.length ? ` / ${models.join(", ")}` : "";
    const names = outputs.map((output) => output.filename).join(", ");
    return `- ${String(scene.index).padStart(3, "0")} [${marker}] saved ${outputs.length}${model}: ${names || "-"}`;
  });
  return `Scene output status:\n${lines.join("\n")}`;
}

async function runStep(action) {
  if (!parsed) parseInput();
  const selected = selectNextItem(action);
  if (!selected) return;
  if (action === "runScenes" && !(await ensureSceneReferencesReady(selected.item))) {
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes("labs.google") || !tab.url?.includes("/tools/flow")) {
    setLog("The active tab is not a Flow page.");
    return;
  }

  setLog(`${action === "runCharacters" ? "Character sheet" : "Scene images"} requested: ${selected.label}`);
  const payload = {
    parsed: selected.parsed,
    settings: getCurrentSettings()
  };
  payload.settings.characterCount = 1;

  navigator.clipboard.writeText(selected.prompt).catch(() => null).finally(() => {
    sendFlowMessage(tab.id, { type: action, payload }, (response) => {
      if (chrome.runtime.lastError) {
        setLog(`Failed: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (response?.ok) {
        markSelectedDone(action);
      }
      setLog(response?.message || "Command sent.");
    });
  });
}

async function runRecoverScene() {
  if (!parsed) parseInput();
  const selected = selectNextItem("runScenes");
  if (!selected) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes("labs.google") || !tab.url?.includes("/tools/flow")) {
    setLog("The active tab is not a Flow page.");
    return;
  }

  setLog(`Recover requested: ${selected.label}`);
  const payload = {
    parsed: selected.parsed,
    settings: {
      model: modelEl.value,
      sceneCount: Number(sceneCountEl.value)
    }
  };

  sendFlowMessage(tab.id, { type: "runRecoverScene", payload }, (response) => {
    if (chrome.runtime.lastError) {
      setLog(`Failed: ${chrome.runtime.lastError.message}`);
      return;
    }
    if (response?.ok) {
      markSelectedDone("runScenes");
      refreshSavedState();
    }
    setLog(response?.message || "Command sent.");
  });
}

function backOneScene() {
  if (!parsed) parseInput();
  if (!parsed?.scenes?.length) return;
  const nextIndex = Math.max(0, sceneIndex - 1);
  const scene = parsed.scenes[nextIndex];
  sceneIndex = nextIndex;
  sceneOutputs = sceneOutputs.filter((output) => output.sceneIndex !== scene.index);
  chrome.storage.local.set({ sceneIndex, sceneOutputs }, () => {
    renderSummary();
    setLog(`Back to scene ${scene.index}. Removed saved outputs for that scene.`);
  });
}

async function runDownloadScenes() {
  chrome.storage.local.get({ sceneOutputs: [] }, (data) => {
    const outputs = data.sceneOutputs || [];
    if (!outputs.length) {
      setLog("No generated scene images have been saved yet.");
      return;
    }

    setLog(`Scene image download requested: ${outputs.length} file(s).`);
    chrome.runtime.sendMessage({ type: "downloadSceneOutputs", outputs }, (response) => {
      if (chrome.runtime.lastError) {
        setLog(`Failed: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (!response?.ok) {
        setLog(`Error: ${response?.message || "Download failed."}`);
        return;
      }
      setLog(`Download started: ${response.count} file(s).`);
    });
  });
}

async function runDownloadScenesFromPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes("labs.google") || !tab.url?.includes("/tools/flow")) {
    setLog("The active tab is not a Flow page.");
    return;
  }

  sendFlowMessage(tab.id, { type: "runDownloadScenes", payload: {} }, (response) => {
    if (chrome.runtime.lastError) {
      setLog(`Failed: ${chrome.runtime.lastError.message}`);
      return;
    }
    setLog(response?.message || "Command sent.");
  });
}

function selectNextItem(action) {
  if (action === "runCharacters") {
    const item = parsed.characters[characterIndex];
    if (!item) {
      setLog("No remaining character sheets.");
      return null;
    }
    return {
      label: item.id,
      prompt: item.prompt,
      parsed: { characters: [item], scenes: [] },
      item
    };
  }
  const item = parsed.scenes[sceneIndex];
  if (!item) {
    setLog("No remaining scenes.");
    return null;
  }
  return {
    label: `Image ${item.index}/${item.total}`,
    prompt: item.prompt,
    parsed: { characters: [], scenes: [item] },
    item
  };
}

function getMissingSceneReferences(scene) {
  if (!scene?.references?.length) return [];
  return scene.references.filter((id) => !characterRefs[id]);
}

async function ensureSceneReferencesReady(scene) {
  await refreshSavedState({ render: false });
  const missing = getMissingSceneReferences(scene);
  if (!missing.length) return true;
  renderSummary();
  setLog(`Missing character reference(s) for scene ${scene.index}: ${missing.join(", ")}. Generate or recover them before running this scene.`);
  return false;
}

function markSelectedDone(action) {
  if (action === "runCharacters") {
    const character = parsed.characters[characterIndex];
    characterIndex += 1;
    checkpoint = buildCheckpoint("character", character);
  } else {
    const scene = parsed.scenes[sceneIndex];
    sceneIndex += 1;
    checkpoint = buildCheckpoint("scene", scene);
  }
  chrome.storage.local.set({ characterIndex, sceneIndex, checkpoint }, () => refreshSavedState());
}

function buildCheckpoint(type, item) {
  if (!item) return checkpoint;
  if (type === "character") {
    return {
      type,
      label: `Character ${item.id}`,
      characterIndex,
      sceneIndex,
      savedAt: Date.now()
    };
  }
  return {
    type,
    label: `Scene ${String(item.index).padStart(3, "0")}`,
    characterIndex,
    sceneIndex,
    savedAt: Date.now()
  };
}

function refreshSavedState(options = { render: true }) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ sceneOutputs: [], characterRefs: {} }, (data) => {
      sceneOutputs = data.sceneOutputs || [];
      characterRefs = data.characterRefs || {};
      if (options.render) renderSummary();
      resolve();
    });
  });
}

function sendFlowMessage(tabId, message, callback) {
  chrome.tabs.sendMessage(tabId, message, (response) => {
    const error = chrome.runtime.lastError;
    if (!error) {
      callback(response);
      return;
    }

    if (!error.message.includes("Receiving end does not exist")) {
      callback();
      return;
    }

    chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }, () => {
      if (chrome.runtime.lastError) {
        callback();
        return;
      }
      chrome.tabs.sendMessage(tabId, message, callback);
    });
  });
}

function setLog(message) {
  const time = new Date().toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  logEl.textContent += `[${time}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function getCurrentSettings() {
  return {
    model: modelEl.value,
    sceneCount: Number(sceneCountEl.value),
    aspectRatio: aspectRatioEl.value
  };
}

function saveSettings() {
  chrome.storage.local.set(getCurrentSettings(), () => {
    renderSummary();
    setLog(`Settings saved: ${modelEl.value}, x${sceneCountEl.value}, ${aspectRatioEl.value}.`);
  });
}

function clearSource() {
  parsed = null;
  characterIndex = 0;
  sceneIndex = 0;
  sceneOutputs = [];
  characterRefs = {};
  checkpoint = null;
  sourceEl.value = "";
  summaryEl.classList.add("empty");
  summaryEl.textContent = "Not parsed yet.";
  logEl.textContent = "";
  chrome.storage.local.remove(["source", "parsed", "characterIndex", "sceneIndex", "characterRefs", "sceneOutputs", "checkpoint"]);
}
