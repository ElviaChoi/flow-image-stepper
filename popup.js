const sourceEl = document.getElementById("source");
const summaryEl = document.getElementById("summary");
const logEl = document.getElementById("log");
const modelEl = document.getElementById("model");
const sceneCountEl = document.getElementById("sceneCount");
const aspectRatioEl = document.getElementById("aspectRatio");
const promptEditorEl = document.getElementById("promptEditor");
const settingsNoteEl = document.getElementById("settingsNote");

const PRO_MODEL = "Nano Banana Pro";
const PRO_MAX_SCENE_COUNT = 2;

let parsed = null;
let characterIndex = 0;
let sceneIndex = 0;
let sceneOutputs = [];
let characterRefs = {};
let checkpoint = null;
let editorKind = "characters";
let editorIndex = 0;

init();

function init() {
  chrome.storage.local.get(["source", "parsed", "characterIndex", "sceneIndex", "sceneOutputs", "characterRefs", "checkpoint", "model", "sceneCount", "aspectRatio"], (data) => {
    if (data.source) sourceEl.value = data.source;
    if (data.model) modelEl.value = data.model;
    if (data.sceneCount) sceneCountEl.value = String(data.sceneCount);
    if (data.aspectRatio) aspectRatioEl.value = data.aspectRatio;
    enforceModelLimits({ persist: false });
    sceneOutputs = data.sceneOutputs || [];
    characterRefs = data.characterRefs || {};
    checkpoint = data.checkpoint || null;
    if (data.parsed) {
      parsed = data.parsed;
      characterIndex = data.characterIndex || 0;
      sceneIndex = data.sceneIndex || 0;
      editorKind = characterIndex < parsed.characters.length ? "characters" : "scenes";
      editorIndex = editorKind === "characters" ? characterIndex : sceneIndex;
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
  updateSettingsNote();
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
  setLog("캐릭터/장면 목록을 만들었습니다.");
}

function renderSummary() {
  if (!parsed) return;
  summaryEl.classList.remove("empty");
  summaryEl.classList.add("summary-dashboard");
  summaryEl.innerHTML = "";
  summaryEl.append(
    buildOverviewSummary(),
    buildCharacterSummary(),
    buildSceneSummary()
  );
  renderPromptEditor();
}

function buildOverviewSummary() {
  const card = createEl("div", "summary-card summary-overview");
  const nextCharacter = parsed.characters[characterIndex];
  const nextScene = parsed.scenes[sceneIndex];
  const last = checkpoint
    ? `${checkpoint.label} / ${new Date(checkpoint.savedAt).toLocaleString("ko-KR")}`
    : "아직 완료된 작업이 없습니다.";

  card.append(
    createEl("h3", "", "다음 작업"),
    buildMetricRow("캐릭터", nextCharacter ? nextCharacter.id : "완료", `${Math.min(characterIndex, parsed.characters.length)} / ${parsed.characters.length} 완료`),
    buildMetricRow("장면", nextScene ? String(nextScene.index).padStart(3, "0") : "완료", `${Math.min(sceneIndex, parsed.scenes.length)} / ${parsed.scenes.length} 완료`),
    buildMetricRow("모델", modelEl.value, `x${getEffectiveSceneCount()}, ${aspectRatioEl.value}`),
    createEl("div", "summary-last", `마지막 저장: ${last}`)
  );
  return card;
}

function buildCharacterSummary() {
  const card = createEl("div", "summary-card");
  card.append(createEl("h3", "", "캐릭터 참조 상태"));
  if (!parsed.characters.length) {
    card.append(createEl("div", "summary-empty", "캐릭터 프롬프트가 없습니다."));
    return card;
  }

  for (const [index, character] of parsed.characters.entries()) {
    const ref = characterRefs[character.id];
    const status = getProgressStatus(index, characterIndex);
    const savedText = ref ? `저장됨${ref.model ? ` / ${ref.model}` : ""}` : "참조 없음";
    card.append(buildStatusRow({
      title: character.id,
      detail: ref?.mediaName || savedText,
      status
    }));
  }
  return card;
}

function buildSceneSummary() {
  const card = createEl("div", "summary-card");
  card.append(createEl("h3", "", "장면 결과 상태"));
  if (!parsed.scenes.length) {
    card.append(createEl("div", "summary-empty", "장면 프롬프트가 없습니다."));
    return card;
  }

  const byScene = new Map();
  for (const output of sceneOutputs) {
    const list = byScene.get(output.sceneIndex) || [];
    list.push(output);
    byScene.set(output.sceneIndex, list);
  }

  for (const [index, scene] of parsed.scenes.entries()) {
    const outputs = byScene.get(scene.index) || [];
    const status = getProgressStatus(index, sceneIndex);
    const refs = scene.references.length ? scene.references.join(", ") : "참조 없음";
    const filenames = outputs.map((output) => output.filename).join(", ");
    const detail = `저장 ${outputs.length}개 / ${refs}${filenames ? ` / ${filenames}` : ""}`;
    card.append(buildStatusRow({
      title: String(scene.index).padStart(3, "0"),
      detail,
      status
    }));
  }
  return card;
}

function buildMetricRow(label, value, detail) {
  const row = createEl("div", "summary-metric");
  row.append(
    createEl("span", "metric-label", label),
    createEl("strong", "metric-value", value),
    createEl("span", "metric-detail", detail)
  );
  return row;
}

function buildStatusRow({ title, detail, status }) {
  const row = createEl("div", "summary-row");
  const text = createEl("div", "summary-row-text");
  text.append(
    createEl("strong", "", title),
    createEl("span", "", detail)
  );
  row.append(
    createEl("span", `status-pill ${status.className}`, status.label),
    text
  );
  return row;
}

function getProgressStatus(index, currentIndex) {
  if (index < currentIndex) return { label: "완료", className: "is-done" };
  if (index === currentIndex) return { label: "다음", className: "is-next" };
  return { label: "대기", className: "is-todo" };
}

function createEl(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function renderPromptEditor() {
  if (!parsed) {
    promptEditorEl.classList.add("empty");
    promptEditorEl.textContent = "프롬프트를 수정하고 다시 생성 준비를 누르면 해당 캐릭터나 장면부터 다시 만들 수 있습니다.";
    return;
  }

  const items = getEditorItems();
  promptEditorEl.classList.remove("empty");
  promptEditorEl.innerHTML = "";

  const tabs = document.createElement("div");
  tabs.className = "editor-tabs";
  tabs.append(
    buildEditorTab("characters", `캐릭터 (${parsed.characters.length})`),
    buildEditorTab("scenes", `장면 (${parsed.scenes.length})`)
  );

  const select = document.createElement("select");
  select.className = "editor-select";
  for (const [index, item] of items.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = getEditorLabel(item, index);
    select.append(option);
  }
  editorIndex = clampEditorIndex(editorIndex, items.length);
  select.value = String(editorIndex);
  select.addEventListener("change", () => {
    editorIndex = Number(select.value);
    renderPromptEditor();
  });

  const selected = items[editorIndex];
  const textarea = document.createElement("textarea");
  textarea.id = "itemPrompt";
  textarea.className = "item-prompt";
  textarea.spellcheck = false;
  textarea.value = selected?.prompt || "";
  textarea.placeholder = items.length ? "이 항목의 프롬프트를 수정하세요." : "이 그룹에 파싱된 프롬프트가 없습니다.";
  textarea.disabled = !selected;

  const meta = document.createElement("div");
  meta.className = "editor-meta";
  meta.textContent = selected ? getEditorMeta(selected) : "수정할 항목이 없습니다.";

  const actions = document.createElement("div");
  actions.className = "editor-actions";
  actions.append(
    buildEditorButton("수정하고 다시 생성 준비", () => {
      if (saveEditedPrompt(textarea.value, { silent: true })) {
        setSelectedAsNext();
      }
    }, "button-primary", !selected)
  );

  promptEditorEl.append(tabs, select, meta, textarea, actions);
}

function buildEditorTab(kind, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = kind === editorKind ? "active" : "";
  button.addEventListener("click", () => {
    editorKind = kind;
    editorIndex = kind === "characters" ? clampEditorIndex(characterIndex, parsed.characters.length) : clampEditorIndex(sceneIndex, parsed.scenes.length);
    renderPromptEditor();
  });
  return button;
}

function buildEditorButton(label, onClick, className = "", disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className) button.className = className;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function getEditorItems() {
  return editorKind === "characters" ? parsed.characters : parsed.scenes;
}

function clampEditorIndex(index, length) {
  if (!length) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

function getEditorLabel(item, index) {
  if (editorKind === "characters") {
    const marker = index < characterIndex ? "완료" : index === characterIndex ? "다음" : "대기";
    return `${item.id} [${marker}]`;
  }
  const marker = index < sceneIndex ? "완료" : index === sceneIndex ? "다음" : "대기";
  return `${String(item.index).padStart(3, "0")} / ${item.total} [${marker}]`;
}

function getEditorMeta(item) {
  if (editorKind === "characters") {
    const ref = characterRefs[item.id];
    return ref
      ? `저장된 캐릭터 참조가 있습니다: ${ref.mediaName || ref.href || item.id}`
      : "아직 저장된 캐릭터 참조가 없습니다.";
  }
  const refs = item.references?.length ? item.references.join(", ") : "참조 없음";
  const saved = sceneOutputs.filter((output) => output.sceneIndex === item.index).length;
  return `참조 캐릭터: ${refs}. 저장된 장면 이미지: ${saved}.`;
}

function saveEditedPrompt(value, options = {}) {
  const items = getEditorItems();
  const item = items[editorIndex];
  const prompt = value.trim();
  if (!item || !prompt) {
    setLog("프롬프트가 비어 있어 저장하지 않았습니다.");
    return false;
  }

  item.prompt = prompt;
  if (editorKind === "scenes") {
    item.references = getReferencesFromPrompt(prompt);
  }
  chrome.storage.local.set({ parsed }, () => {
    renderSummary();
    if (!options.silent) {
      setLog(`${editorKind === "characters" ? "캐릭터" : "장면"} 프롬프트를 저장했습니다: ${getEditorLabel(item, editorIndex)}.`);
    }
  });
  return true;
}

function getReferencesFromPrompt(prompt) {
  const knownIds = new Set((parsed.characters || []).map((character) => character.id));
  return [...new Set(prompt.match(/[^\s,()]+_CS-\d{2}/g) || [])]
    .filter((id) => knownIds.has(id));
}

function setSelectedAsNext() {
  const items = getEditorItems();
  const item = items[editorIndex];
  if (!item) return;

  if (editorKind === "characters") {
    characterIndex = editorIndex;
    delete characterRefs[item.id];
    checkpoint = buildManualCheckpoint(`Character ${item.id}`);
    chrome.storage.local.set({ characterIndex, characterRefs, checkpoint }, () => refreshSavedState());
    setLog(`${item.id} 캐릭터를 다시 생성할 준비가 완료되었습니다. 기존 참조 기록은 삭제했습니다.`);
    return;
  }

  sceneIndex = editorIndex;
  sceneOutputs = sceneOutputs.filter((output) => output.sceneIndex !== item.index);
  checkpoint = buildManualCheckpoint(`Scene ${String(item.index).padStart(3, "0")}`);
  chrome.storage.local.set({ sceneIndex, sceneOutputs, checkpoint }, () => refreshSavedState());
  setLog(`${item.index}번 장면을 다시 생성할 준비가 완료되었습니다. 기존 장면 결과는 삭제했습니다.`);
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
    setLog("현재 탭이 Flow 페이지가 아닙니다.");
    return;
  }

  setLog(`${action === "runCharacters" ? "캐릭터 시트" : "장면 이미지"} 생성을 요청했습니다: ${selected.label}`);
  const payload = {
    parsed: selected.parsed,
    settings: getCurrentSettings()
  };
  payload.settings.characterCount = 1;

  navigator.clipboard.writeText(selected.prompt).catch(() => null).finally(() => {
    sendFlowMessage(tab.id, { type: action, payload }, (response) => {
      if (chrome.runtime.lastError) {
        setLog(`실패: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (response?.ok) {
        markSelectedDone(action);
      }
      setLog(response?.message || "명령을 보냈습니다.");
    });
  });
}

async function runRecoverScene() {
  if (!parsed) parseInput();
  const selected = selectNextItem("runScenes");
  if (!selected) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes("labs.google") || !tab.url?.includes("/tools/flow")) {
    setLog("현재 탭이 Flow 페이지가 아닙니다.");
    return;
  }

  setLog(`최신 결과 저장을 요청했습니다: ${selected.label}`);
  const payload = {
    parsed: selected.parsed,
    settings: {
      model: modelEl.value,
      sceneCount: getEffectiveSceneCount()
    }
  };

  sendFlowMessage(tab.id, { type: "runRecoverScene", payload }, (response) => {
    if (chrome.runtime.lastError) {
      setLog(`실패: ${chrome.runtime.lastError.message}`);
      return;
    }
    if (response?.ok) {
      markSelectedDone("runScenes");
      refreshSavedState();
    }
    setLog(response?.message || "명령을 보냈습니다.");
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
    setLog(`${scene.index}번 장면으로 돌아갔습니다. 해당 장면의 기존 결과는 삭제했습니다.`);
  });
}

async function runDownloadScenes() {
  chrome.storage.local.get({ sceneOutputs: [] }, (data) => {
    const outputs = data.sceneOutputs || [];
    if (!outputs.length) {
      setLog("아직 저장된 장면 이미지가 없습니다.");
      return;
    }

    setLog(`장면 이미지 다운로드를 요청했습니다: ${outputs.length}개`);
    chrome.runtime.sendMessage({ type: "downloadSceneOutputs", outputs }, (response) => {
      if (chrome.runtime.lastError) {
        setLog(`실패: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (!response?.ok) {
        setLog(`오류: ${response?.message || "다운로드에 실패했습니다."}`);
        return;
      }
      setLog(`다운로드를 시작했습니다: ${response.count}개`);
    });
  });
}

async function runDownloadScenesFromPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes("labs.google") || !tab.url?.includes("/tools/flow")) {
    setLog("현재 탭이 Flow 페이지가 아닙니다.");
    return;
  }

  sendFlowMessage(tab.id, { type: "runDownloadScenes", payload: {} }, (response) => {
    if (chrome.runtime.lastError) {
      setLog(`실패: ${chrome.runtime.lastError.message}`);
      return;
    }
    setLog(response?.message || "명령을 보냈습니다.");
  });
}

function selectNextItem(action) {
  if (action === "runCharacters") {
    const item = parsed.characters[characterIndex];
    if (!item) {
      setLog("남은 캐릭터 시트가 없습니다.");
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
    setLog("남은 장면이 없습니다.");
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
  setLog(`${scene.index}번 장면에 필요한 캐릭터 참조가 없습니다: ${missing.join(", ")}. 먼저 해당 캐릭터를 생성하거나 복구해 주세요.`);
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

function buildManualCheckpoint(label) {
  return {
    type: "manual",
    label: `Edited ${label}`,
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
    sceneCount: getEffectiveSceneCount(),
    aspectRatio: aspectRatioEl.value
  };
}

function saveSettings() {
  enforceModelLimits({ persist: false });
  chrome.storage.local.set(getCurrentSettings(), () => {
    renderSummary();
    updateSettingsNote();
    setLog(`설정을 저장했습니다: ${modelEl.value}, x${getEffectiveSceneCount()}, ${aspectRatioEl.value}`);
  });
}

function getEffectiveSceneCount() {
  const selectedCount = Number(sceneCountEl.value);
  if (modelEl.value === PRO_MODEL) {
    return Math.min(selectedCount, PRO_MAX_SCENE_COUNT);
  }
  return selectedCount;
}

function enforceModelLimits(options = { persist: true }) {
  const isPro = modelEl.value === PRO_MODEL;
  for (const option of sceneCountEl.options) {
    const count = Number(option.value);
    option.disabled = isPro && count > PRO_MAX_SCENE_COUNT;
  }

  if (isPro && Number(sceneCountEl.value) > PRO_MAX_SCENE_COUNT) {
    sceneCountEl.value = String(PRO_MAX_SCENE_COUNT);
    if (options.persist) {
      chrome.storage.local.set(getCurrentSettings());
    }
  }
  updateSettingsNote();
}

function updateSettingsNote() {
  if (!settingsNoteEl) return;
  if (modelEl.value === PRO_MODEL) {
    settingsNoteEl.textContent = "Nano Banana Pro는 사용량 제한에 걸리기 쉬워 장면 생성 수를 최대 x2로 제한합니다.";
    settingsNoteEl.classList.add("is-visible");
    return;
  }
  settingsNoteEl.textContent = "";
  settingsNoteEl.classList.remove("is-visible");
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
  summaryEl.classList.remove("summary-dashboard");
  summaryEl.textContent = "아직 목록이 없습니다.";
  logEl.textContent = "";
  chrome.storage.local.remove(["source", "parsed", "characterIndex", "sceneIndex", "characterRefs", "sceneOutputs", "checkpoint"]);
  renderPromptEditor();
}
