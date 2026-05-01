const sourceEl = document.getElementById("source");
const characterBuilderRowsEl = document.getElementById("characterBuilderRows");
const sceneBuilderRowsEl = document.getElementById("sceneBuilderRows");
const addCharacterEl = document.getElementById("addCharacter");
const addSceneEl = document.getElementById("addScene");
const buildSourceEl = document.getElementById("buildSource");
const summaryEl = document.getElementById("summary");
const logEl = document.getElementById("log");
const modelEl = document.getElementById("model");
const sceneCountEl = document.getElementById("sceneCount");
const aspectRatioEl = document.getElementById("aspectRatio");
const debugEl = document.getElementById("debug");
const exportLibraryEl = document.getElementById("exportLibrary");
const importLibraryEl = document.getElementById("importLibrary");
const importFileEl = document.getElementById("importFile");
const promptEditorAccordionEl = document.getElementById("promptEditorAccordion");
const promptEditorEl = document.getElementById("promptEditor");
const promptEditorSummaryEl = document.getElementById("promptEditorSummary");
const settingsNoteEl = document.getElementById("settingsNote");

const PRO_MODEL = "Nano Banana Pro";
const PRO_MAX_SCENE_COUNT = 2;
const CHARACTER_LIBRARY_KEY = "characterLibrary";
const CHARACTER_LIBRARY_BY_PROJECT_KEY = "characterLibraryByProject";
const CHARACTER_REFS_BY_PROJECT_KEY = "characterRefsByProject";
const PROJECT_LAST_USED_KEY = "projectLastUsedAt";
const PROMPT_EDITOR_EXPANDED_KEY = "promptEditorExpanded";
const REGEN_QUEUE_BY_PROJECT_KEY = "regenQueueByProject";
const MAX_REFS_PER_PROJECT = 200;

let parsed = null;
let characterIndex = 0;
let sceneIndex = 0;
let sceneOutputs = [];
let characterRefs = {};
let characterLibrary = {};
let characterRefsByProject = {};
let characterLibraryByProject = {};
let projectLastUsedAt = {};
let currentProjectId = "";
let checkpoint = null;
let editorKind = "characters";
let editorIndex = 0;
let promptEditorExpanded = false;
let regenQueueByProject = {};
let regenQueue = { characters: [], scenes: [] };
let lastRunSelection = null;

init();

function normalizeCharacterId(value) {
  return String(value || "")
    .trim()
    // common formatting noise from copy/paste (markdown bold, quotes)
    .replace(/^\*+/, "")
    .replace(/\*+$/, "")
    .replace(/^"+|"+$/g, "")
    .replace(/^'+|'+$/g, "")
    .trim();
}

function resolveFallbackProjectId() {
  const candidates = new Map();
  for (const [projectId, savedAt] of Object.entries(projectLastUsedAt || {})) {
    if (!projectId) continue;
    candidates.set(projectId, Number(savedAt || 0));
  }
  // If last-used map is empty, fall back to any known project buckets.
  for (const projectId of Object.keys(characterRefsByProject || {})) {
    if (!projectId) continue;
    if (!candidates.has(projectId)) candidates.set(projectId, 0);
  }
  for (const projectId of Object.keys(characterLibraryByProject || {})) {
    if (!projectId) continue;
    if (!candidates.has(projectId)) candidates.set(projectId, 0);
  }
  for (const projectId of Object.keys(regenQueueByProject || {})) {
    if (!projectId) continue;
    if (!candidates.has(projectId)) candidates.set(projectId, 0);
  }
  if (!candidates.size) return "";
  return [...candidates.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0][0];
}

function ensureProjectContextFromStorage() {
  if (currentProjectId) return;
  const fallback = resolveFallbackProjectId();
  if (!fallback) return;
  currentProjectId = fallback;
}

function init() {
  migrateLegacyCharacterStorage().then(async () => {
    await refreshCurrentProjectContext();
    chrome.storage.local.get([
      "source", "parsed", "characterIndex", "sceneIndex", "sceneOutputs",
      CHARACTER_REFS_BY_PROJECT_KEY, CHARACTER_LIBRARY_BY_PROJECT_KEY, PROJECT_LAST_USED_KEY,
      REGEN_QUEUE_BY_PROJECT_KEY,
      "checkpoint", "model", "sceneCount", "aspectRatio", "debug", PROMPT_EDITOR_EXPANDED_KEY
    ], (data) => {
      if (data.source) sourceEl.value = data.source;
      if (data.model) modelEl.value = data.model;
      if (data.sceneCount) sceneCountEl.value = String(data.sceneCount);
      if (data.aspectRatio) aspectRatioEl.value = data.aspectRatio;
      if (debugEl) debugEl.checked = Boolean(data.debug);
      enforceModelLimits({ persist: false });
      sceneOutputs = data.sceneOutputs || [];
      characterRefsByProject = data[CHARACTER_REFS_BY_PROJECT_KEY] || {};
      characterLibraryByProject = data[CHARACTER_LIBRARY_BY_PROJECT_KEY] || {};
      projectLastUsedAt = data[PROJECT_LAST_USED_KEY] || {};
      regenQueueByProject = data[REGEN_QUEUE_BY_PROJECT_KEY] || {};
      ensureProjectContextFromStorage();
      characterRefs = getProjectBucket(characterRefsByProject, currentProjectId);
      characterLibrary = getProjectBucket(characterLibraryByProject, currentProjectId);
      regenQueue = normalizeRegenQueue(getProjectBucket(regenQueueByProject, currentProjectId));
      checkpoint = data.checkpoint || null;
      promptEditorExpanded = Boolean(data[PROMPT_EDITOR_EXPANDED_KEY]);
      syncPromptEditorAccordion();
      if (data.parsed) {
        parsed = data.parsed;
        characterIndex = data.characterIndex || 0;
        sceneIndex = data.sceneIndex || 0;
        editorKind = characterIndex < parsed.characters.length ? "characters" : "scenes";
        editorIndex = editorKind === "characters" ? characterIndex : sceneIndex;
        renderSummary();
        hydrateBuilderFromParsed(parsed);
      }
    });
  });

  document.getElementById("parse").addEventListener("click", parseInput);
  document.getElementById("restoreRefs").addEventListener("click", restoreCharacterReferencesFromLibrary);
  document.getElementById("runCharacters").addEventListener("click", () => runStep("runCharacters"));
  document.getElementById("runScenes").addEventListener("click", () => runStep("runScenes"));
  document.getElementById("recoverScene").addEventListener("click", () => runRecoverScene());
  document.getElementById("backScene").addEventListener("click", () => backOneScene());
  document.getElementById("downloadScenes").addEventListener("click", () => runDownloadScenes());
  exportLibraryEl?.addEventListener("click", exportCharacterLibraryBackup);
  importLibraryEl?.addEventListener("click", () => importFileEl?.click());
  importFileEl?.addEventListener("change", importCharacterLibraryBackup);
  document.getElementById("clearSource").addEventListener("click", clearSource);
  addCharacterEl?.addEventListener("click", () => addBuilderCharacter());
  addSceneEl?.addEventListener("click", () => addBuilderScene());
  buildSourceEl?.addEventListener("click", buildSourceFromBuilder);
  modelEl.addEventListener("change", saveSettings);
  sceneCountEl.addEventListener("change", saveSettings);
  aspectRatioEl.addEventListener("change", saveSettings);
  if (debugEl) debugEl.addEventListener("change", saveSettings);
  promptEditorAccordionEl?.addEventListener("toggle", onPromptEditorAccordionToggle);
  updateSettingsNote();
  updatePromptEditorAccordionSummary();
  ensureInitialBuilderRows();
}

function ensureInitialBuilderRows() {
  if (!characterBuilderRowsEl || !sceneBuilderRowsEl) return;
  if (!characterBuilderRowsEl.children.length) addBuilderCharacter();
  if (!sceneBuilderRowsEl.children.length) addBuilderScene();
}

function hydrateBuilderFromParsed(nextParsed) {
  if (!characterBuilderRowsEl || !sceneBuilderRowsEl || !nextParsed) return;
  characterBuilderRowsEl.innerHTML = "";
  sceneBuilderRowsEl.innerHTML = "";
  for (const character of nextParsed.characters || []) {
    addBuilderCharacter({
      id: character.id || "",
      name: character.name || String(character.id || "").replace(/_CS-\d{2}$/i, ""),
      prompt: character.prompt || ""
    });
  }
  for (const scene of nextParsed.scenes || []) {
    addBuilderScene({
      title: scene.placement || `장면 ${scene.index || sceneBuilderRowsEl.children.length + 1}`,
      references: scene.references || [],
      prompt: scene.prompt || ""
    });
  }
  ensureInitialBuilderRows();
  syncBuilderTitles();
  syncSceneCharacterOptions();
}

function addBuilderCharacter(data = {}) {
  const index = characterBuilderRowsEl.children.length;
  const card = createEl("div", "builder-card builder-character-card");
  card.dataset.kind = "character";

  const header = createEl("div", "builder-card-header");
  header.append(
    createEl("div", "builder-card-title", `캐릭터 ${index + 1}`),
    buildRemoveBuilderButton(card)
  );

  const grid = createEl("div", "builder-grid");
  const nameInput = buildBuilderInput("이름", "예: 연화", data.name || "");
  nameInput.classList.add("builder-character-name");
  const idInput = buildBuilderInput("캐릭터 ID", "예: 연화_CS-01", data.id || "");
  idInput.classList.add("builder-character-id");
  if (data.id) idInput.dataset.touched = "true";
  const promptInput = buildBuilderTextarea("캐릭터 시트 프롬프트", "외형, 의상, 표정, 기준 포즈 등 캐릭터 시트에 넣을 프롬프트", data.prompt || "");
  promptInput.classList.add("builder-character-prompt");

  nameInput.addEventListener("input", () => {
    if (idInput.dataset.touched === "true") {
      syncSceneCharacterOptions();
      return;
    }
    idInput.value = makeBuilderCharacterId(nameInput.value, getBuilderCardIndex(card));
    syncSceneCharacterOptions();
  });
  idInput.addEventListener("input", () => {
    idInput.dataset.touched = "true";
    syncSceneCharacterOptions();
  });

  grid.append(
    wrapBuilderField("이름", nameInput),
    wrapBuilderField("캐릭터 ID", idInput),
    wrapBuilderField("캐릭터 시트 프롬프트", promptInput)
  );
  card.append(header, grid);
  characterBuilderRowsEl.append(card);
  if (!idInput.value) idInput.value = makeBuilderCharacterId(nameInput.value, index);
  syncBuilderTitles();
  syncSceneCharacterOptions();
}

function addBuilderScene(data = {}) {
  const index = sceneBuilderRowsEl.children.length;
  const card = createEl("div", "builder-card builder-scene-card");
  card.dataset.kind = "scene";

  const header = createEl("div", "builder-card-header");
  header.append(
    createEl("div", "builder-card-title", `장면 ${index + 1}`),
    buildRemoveBuilderButton(card)
  );

  const titleInput = buildBuilderInput("장면 제목", "예: 비 오는 골목", data.title || "");
  titleInput.classList.add("builder-scene-title");
  const refs = createEl("div", "scene-character-list");
  refs.dataset.selected = (data.references || []).join(",");
  const promptInput = buildBuilderTextarea("장면 프롬프트", "장면 구도, 배경, 행동, 분위기 등을 입력하세요.", data.prompt || "");
  promptInput.classList.add("builder-scene-prompt");

  const grid = createEl("div", "builder-grid");
  grid.append(
    wrapBuilderField("장면 제목", titleInput),
    wrapBuilderField("등장 캐릭터", refs),
    wrapBuilderField("장면 프롬프트", promptInput)
  );
  card.append(header, grid);
  sceneBuilderRowsEl.append(card);
  syncBuilderTitles();
  syncSceneCharacterOptions();
}

function buildRemoveBuilderButton(card) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "builder-remove";
  button.textContent = "삭제";
  button.addEventListener("click", () => {
    card.remove();
    syncBuilderTitles();
    syncSceneCharacterOptions();
  });
  return button;
}

function buildBuilderInput(label, placeholder, value = "") {
  const input = document.createElement("input");
  input.type = "text";
  input.setAttribute("aria-label", label);
  input.placeholder = placeholder;
  input.value = value;
  return input;
}

function buildBuilderTextarea(label, placeholder, value = "") {
  const textarea = document.createElement("textarea");
  textarea.setAttribute("aria-label", label);
  textarea.spellcheck = false;
  textarea.placeholder = placeholder;
  textarea.value = value;
  return textarea;
}

function wrapBuilderField(labelText, input) {
  const field = createEl("div", "builder-field");
  field.append(createEl("span", "", labelText), input);
  return field;
}

function syncBuilderTitles() {
  [...characterBuilderRowsEl.querySelectorAll(".builder-character-card")].forEach((card, index) => {
    card.querySelector(".builder-card-title").textContent = `캐릭터 ${index + 1}`;
    const idInput = card.querySelector(".builder-character-id");
    if (idInput && !idInput.dataset.touched) {
      idInput.value = makeBuilderCharacterId(card.querySelector(".builder-character-name")?.value || "", index);
    }
  });
  [...sceneBuilderRowsEl.querySelectorAll(".builder-scene-card")].forEach((card, index) => {
    card.querySelector(".builder-card-title").textContent = `장면 ${index + 1}`;
  });
}

function getBuilderCardIndex(card) {
  const rows = card.dataset.kind === "scene" ? sceneBuilderRowsEl : characterBuilderRowsEl;
  return [...rows.children].indexOf(card);
}

function getBuilderCharacters() {
  return [...characterBuilderRowsEl.querySelectorAll(".builder-character-card")]
    .map((card, index) => {
      const nameInput = card.querySelector(".builder-character-name");
      const idInput = card.querySelector(".builder-character-id");
      const promptInput = card.querySelector(".builder-character-prompt");
      const rawName = nameInput?.value.trim() || "";
      const rawId = idInput?.value.trim() || "";
      const prompt = promptInput?.value.trim() || "";
      if (!rawName && !prompt && idInput?.dataset.touched !== "true") return null;
      const name = rawName || `캐릭터 ${index + 1}`;
      const id = normalizeCharacterId(rawId || makeBuilderCharacterId(name, index));
      return { name, id, prompt };
    })
    .filter(Boolean);
}

function getBuilderScenes() {
  return [...sceneBuilderRowsEl.querySelectorAll(".builder-scene-card")]
    .map((card, index) => {
      const title = card.querySelector(".builder-scene-title")?.value.trim() || `장면 ${index + 1}`;
      const references = [...card.querySelectorAll(".scene-character-list input:checked")]
        .map((input) => normalizeCharacterId(input.value))
        .filter(Boolean);
      const prompt = card.querySelector(".builder-scene-prompt")?.value.trim() || "";
      return { title, references, prompt };
    })
    .filter((item) => item.title || item.references.length || item.prompt);
}

function getAvailableCharacterOptions() {
  const byId = new Map();
  const addOption = (id, name = "") => {
    const cleanId = normalizeCharacterId(id);
    if (!cleanId || byId.has(cleanId)) return;
    byId.set(cleanId, {
      id: cleanId,
      name: name || cleanId.replace(/_CS-\d{2}$/i, "")
    });
  };

  for (const character of parsed?.characters || []) {
    addOption(character.id, character.name || "");
  }
  for (const character of getBuilderCharacters()) {
    addOption(character.id, character.name || "");
  }
  for (const id of Object.keys(characterRefs || {})) {
    addOption(id);
  }
  for (const id of Object.keys(characterLibrary || {})) {
    addOption(id);
  }
  const projectLibrary = getProjectBucket(characterLibraryByProject, currentProjectId);
  for (const id of Object.keys(projectLibrary || {})) {
    addOption(id);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function syncSceneCharacterOptions() {
  const characters = getAvailableCharacterOptions();
  for (const list of sceneBuilderRowsEl.querySelectorAll(".scene-character-list")) {
    const selected = new Set([
      ...(list.dataset.selected || "").split(","),
      ...[...list.querySelectorAll("input:checked")].map((input) => input.value)
    ].map((id) => normalizeCharacterId(id)).filter(Boolean));
    list.innerHTML = "";
    if (!characters.length) {
      list.append(createEl("div", "builder-empty", "먼저 캐릭터를 추가하세요."));
      continue;
    }
    for (const character of characters) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = character.id;
      checkbox.checked = selected.has(character.id);
      checkbox.addEventListener("change", () => {
        list.dataset.selected = [...list.querySelectorAll("input:checked")]
          .map((input) => input.value)
          .join(",");
      });
      label.append(checkbox, createEl("span", "", `${character.name} (${character.id})`));
      list.append(label);
    }
    list.dataset.selected = [...list.querySelectorAll("input:checked")]
      .map((input) => input.value)
      .join(",");
  }
}

async function buildSourceFromBuilder() {
  syncBuilderTitles();
  syncSceneCharacterOptions();
  const characters = getBuilderCharacters();
  const scenes = getBuilderScenes();
  const hasCharacterPrompt = characters.some((item) => item.prompt);
  const hasScenePrompt = scenes.some((item) => item.prompt);
  if (!hasCharacterPrompt && !hasScenePrompt) {
    setLog("캐릭터나 장면 프롬프트를 먼저 입력하세요.");
    return;
  }

  const lines = [];
  for (const character of characters.filter((item) => item.prompt)) {
    lines.push(`캐릭터 시트 프롬프트 - ${character.id}`);
    lines.push(`이름: ${character.name}`);
    lines.push("프롬프트:");
    lines.push(character.prompt);
    lines.push("");
  }
  scenes.filter((item) => item.prompt).forEach((scene, index) => {
    lines.push(`장면 이미지 프롬프트 ${index + 1}`);
    if (scene.title) lines.push(`배치: ${scene.title}`);
    lines.push(`등장인물: ${scene.references.length ? scene.references.join(", ") : "참조 없음"}`);
    lines.push("프롬프트:");
    lines.push(scene.prompt);
    lines.push("");
  });

  sourceEl.value = lines.join("\n").trim();
  await parseInput();
}

function makeBuilderCharacterId(name, index) {
  const cleaned = String(name || `Character ${index + 1}`)
    .trim()
    .replace(/_CS-\d{2}$/i, "");
  const slug = cleaned
    .replace(/[^\w\u3131-\uD79D-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "Character";
  return `${slug}_CS-${String(index + 1).padStart(2, "0")}`;
}

async function parseInput() {
  if (!confirmParseReset()) return;
  await refreshCurrentProjectContext();
  parsed = FlowPromptParser.parse(sourceEl.value);
  // Normalize references so Flow scenes can find saved character refs
  for (const scene of parsed?.scenes || []) {
    if (!scene?.references?.length) continue;
    scene.references = scene.references.map((id) => normalizeCharacterId(id)).filter(Boolean);
  }
  sceneIndex = 0;
  sceneOutputs = [];
  characterRefs = await getRestoredCharacterRefs(parsed, currentProjectId, { includeAllWhenNoIds: true });
  characterIndex = getNextCharacterIndex(parsed, characterRefs);
  checkpoint = null;
  regenQueue = { characters: [], scenes: [] };
  if (currentProjectId) {
    characterRefsByProject[currentProjectId] = characterRefs;
    regenQueueByProject[currentProjectId] = regenQueue;
  }
  chrome.storage.local.set({
    source: sourceEl.value,
    parsed,
    characterIndex,
    sceneIndex,
    [CHARACTER_REFS_BY_PROJECT_KEY]: characterRefsByProject,
    [REGEN_QUEUE_BY_PROJECT_KEY]: regenQueueByProject,
    sceneOutputs: [],
    checkpoint: null,
    ...getCurrentSettings()
  });
  renderSummary();
  hydrateBuilderFromParsed(parsed);
  if (parsed.mode === "simple-scenes") {
    setLog(`장면 헤더가 없어 빈 줄 기준으로 ${parsed.scenes.length}개 장면을 만들었습니다. 캐릭터 참조는 적용되지 않습니다.`);
  } else if (parsed.mode === "prompt-pack") {
    setLog(`프롬프트 묶음에서 캐릭터 ${parsed.characters.length}개와 장면 ${parsed.scenes.length}개를 인식했습니다. 프롬프트 본문은 그대로 사용합니다.`);
  } else if (parsed.mode === "friendly-story") {
    setLog(`쉬운 입력 모드로 캐릭터 ${parsed.characters.length}개와 장면 ${parsed.scenes.length}개를 만들었습니다. 장면에 등장한 캐릭터 이름은 자동으로 참조 연결했습니다.`);
  } else {
    setLog("캐릭터/장면 목록을 만들었습니다.");
  }
}

function confirmParseReset() {
  if (!hasInProgressWorkflow()) return true;
  return window.confirm("이미 작업 중입니다. 프롬프트 목록을 다시 만들면 진행 상태와 저장된 장면 결과가 초기화됩니다. 계속할까요?");
}

function hasInProgressWorkflow() {
  if (sceneOutputs.length) return true;
  if (characterIndex > 0 || sceneIndex > 0) return true;
  if (checkpoint) return true;
  if (!parsed) return false;
  return parsed.characters.length > 0 || parsed.scenes.length > 0;
}

function getReferencedCharacterIds(nextParsed) {
  const ids = new Set();
  for (const character of nextParsed?.characters || []) {
    ids.add(normalizeCharacterId(character.id));
  }
  for (const scene of nextParsed?.scenes || []) {
    for (const id of scene.references || []) {
      ids.add(normalizeCharacterId(id));
    }
  }
  return ids;
}

function loadCharacterLibrary() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [CHARACTER_LIBRARY_BY_PROJECT_KEY]: {} }, (result) => {
      characterLibraryByProject = result[CHARACTER_LIBRARY_BY_PROJECT_KEY] || {};
      characterLibrary = getProjectBucket(characterLibraryByProject, currentProjectId);
      resolve(characterLibrary);
    });
  });
}

function mergeRefsIntoCharacterLibrary(refs = {}) {
  const entries = Object.entries(refs).filter(([, ref]) => ref);
  if (!entries.length) return Promise.resolve(characterLibrary);

  let changed = false;
  const nextLibrary = { ...getProjectBucket(characterLibraryByProject, currentProjectId) };
  for (const [id, ref] of entries) {
    if (!nextLibrary[id] || nextLibrary[id].savedAt !== ref.savedAt) {
      nextLibrary[id] = ref;
      changed = true;
    }
  }
  if (!changed) return Promise.resolve(characterLibrary);

  characterLibrary = trimProjectLibrary(nextLibrary);
  characterLibraryByProject[currentProjectId] = characterLibrary;
  projectLastUsedAt[currentProjectId] = Date.now();
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [CHARACTER_LIBRARY_BY_PROJECT_KEY]: characterLibraryByProject,
      [PROJECT_LAST_USED_KEY]: projectLastUsedAt
    }, () => resolve(characterLibrary));
  });
}

async function getRestoredCharacterRefs(nextParsed, projectId = currentProjectId, options = {}) {
  const library = await loadCharacterLibrary();
  const ids = getReferencedCharacterIds(nextParsed);
  const idsToRestore = ids.size || !options.includeAllWhenNoIds
    ? [...ids]
    : Object.keys(library || {});
  const restored = {};
  for (const id of idsToRestore) {
    if (library[id]) {
      restored[id] = library[id];
    }
  }
  return restored;
}

async function restoreCharacterReferencesFromLibrary() {
  await refreshCurrentProjectContext();
  if (!currentProjectId) {
    setLog("Flow 프로젝트 탭을 열어야 참조를 복구할 수 있습니다.");
    return;
  }
  const restored = await getRestoredCharacterRefs(parsed, currentProjectId, { includeAllWhenNoIds: true });
  const availableIds = Object.keys(characterLibrary || {}).sort();
  const currentIds = [...getReferencedCharacterIds(parsed)];
  const matchedIds = Object.keys(restored).sort();
  const missingIds = currentIds.filter((id) => !restored[id]).sort();
  characterRefs = {
    ...characterRefs,
    ...restored
  };
  characterRefsByProject[currentProjectId] = characterRefs;
  projectLastUsedAt[currentProjectId] = Date.now();
  if (parsed) {
    characterIndex = getNextCharacterIndex(parsed, characterRefs);
  }
  chrome.storage.local.set({
    [CHARACTER_REFS_BY_PROJECT_KEY]: characterRefsByProject,
    [PROJECT_LAST_USED_KEY]: projectLastUsedAt,
    characterIndex
  }, () => {
    if (parsed) renderSummary();
    const count = Object.keys(restored).length;
    setLog(count
      ? `참조 ${count}개를 불러왔습니다: ${matchedIds.join(", ")}.`
      : "현재 프로젝트에서 매칭되는 저장 참조가 없습니다.");
    if (missingIds.length) {
      setLog(`현재 프롬프트에서 누락된 참조: ${missingIds.join(", ")}.`);
    }
    if (availableIds.length) {
      setLog(`현재 프로젝트 저장 참조: ${availableIds.join(", ")}.`);
    }
  });
}

function getNextCharacterIndex(nextParsed, refs) {
  const characters = nextParsed?.characters || [];
  const nextIndex = characters.findIndex((character) => !refs[character.id]);
  return nextIndex === -1 ? characters.length : nextIndex;
}

function normalizeRegenQueue(value) {
  const fallback = { characters: [], scenes: [] };
  if (!value || typeof value !== "object") return fallback;
  const characters = Array.isArray(value.characters)
    ? value.characters.filter(Boolean).map(String)
    : [];
  const scenes = Array.isArray(value.scenes)
    ? value.scenes
      .filter((v) => typeof v === "number" || /^\d+$/.test(String(v)))
      .map((v) => Number(v))
    : [];
  return {
    characters: [...new Set(characters)],
    scenes: [...new Set(scenes)]
  };
}

function persistRegenQueue() {
  if (!currentProjectId) return Promise.resolve();
  regenQueueByProject[currentProjectId] = normalizeRegenQueue(regenQueue);
  projectLastUsedAt[currentProjectId] = Date.now();
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [REGEN_QUEUE_BY_PROJECT_KEY]: regenQueueByProject,
      [PROJECT_LAST_USED_KEY]: projectLastUsedAt
    }, () => resolve());
  });
}

function enqueueRegen(kind, key) {
  regenQueue = normalizeRegenQueue(regenQueue);
  if (kind === "character") {
    regenQueue.characters = [...new Set([...(regenQueue.characters || []), String(key)])];
  } else {
    regenQueue.scenes = [...new Set([...(regenQueue.scenes || []), Number(key)])];
  }
  return persistRegenQueue();
}

function dequeueRegen(kind, key) {
  regenQueue = normalizeRegenQueue(regenQueue);
  if (kind === "character") {
    regenQueue.characters = (regenQueue.characters || []).filter((id) => id !== String(key));
  } else {
    regenQueue.scenes = (regenQueue.scenes || []).filter((sceneNumber) => sceneNumber !== Number(key));
  }
  return persistRegenQueue();
}

function renderSummary() {
  if (!parsed) return;
  summaryEl.classList.remove("empty");
  summaryEl.classList.add("summary-dashboard");
  summaryEl.innerHTML = "";
  summaryEl.append(
    buildOverviewSummary(),
    buildSummaryAccordion("캐릭터 참조 보관함", getLibraryAccordionDetail(), buildLibrarySummary(), { tone: "library" }),
    buildSummaryAccordion("캐릭터 준비 현황", getCharacterAccordionDetail(), buildCharacterSummary(), { tone: "characters" }),
    buildSummaryAccordion("장면 저장 현황", getSceneAccordionDetail(), buildSceneSummary(), { tone: "scenes" })
  );
  renderPromptEditor();
}

function buildSummaryAccordion(title, detail, content, options = {}) {
  const accordion = document.createElement("details");
  accordion.className = "summary-accordion";
  if (options.tone) accordion.classList.add(`summary-accordion-${options.tone}`);
  if (options.open) accordion.open = true;

  const summary = document.createElement("summary");
  summary.append(
    createEl("span", "summary-accordion-title", title),
    createEl("span", "summary-accordion-detail", detail)
  );

  const body = createEl("div", "summary-accordion-body");
  body.append(content);
  accordion.append(summary, body);
  return accordion;
}

function getLibraryAccordionDetail() {
  const count = Object.keys(getProjectBucket(characterLibraryByProject, currentProjectId) || {}).length;
  return count ? `${count}개 보관` : "보관된 참조 없음";
}

function getCharacterAccordionDetail() {
  const total = parsed?.characters?.length || 0;
  if (!total) return "캐릭터 없음";
  const ready = parsed.characters.filter((character) => Boolean(characterRefs[character.id])).length;
  return `${ready} / ${total} 준비됨`;
}

function getSceneAccordionDetail() {
  const total = parsed?.scenes?.length || 0;
  if (!total) return "장면 없음";
  return `${getSavedSceneCount()} / ${total} 저장됨`;
}

function onPromptEditorAccordionToggle() {
  promptEditorExpanded = Boolean(promptEditorAccordionEl?.open);
  chrome.storage.local.set({ [PROMPT_EDITOR_EXPANDED_KEY]: promptEditorExpanded });
}

function syncPromptEditorAccordion() {
  if (!promptEditorAccordionEl) return;
  promptEditorAccordionEl.open = promptEditorExpanded;
}

function updatePromptEditorAccordionSummary() {
  if (!promptEditorSummaryEl) return;
  if (!parsed) {
    promptEditorSummaryEl.textContent = "필요할 때 펼쳐서 프롬프트를 수정할 수 있습니다.";
    return;
  }
  const items = getEditorItems();
  const selected = items[clampEditorIndex(editorIndex, items.length)];
  if (!selected) {
    promptEditorSummaryEl.textContent = "수정할 항목이 없습니다.";
    return;
  }
  if (editorKind === "characters") {
    promptEditorSummaryEl.textContent = `현재 대상: ${selected.id}`;
    return;
  }
  promptEditorSummaryEl.textContent = `현재 대상: 장면 ${String(selected.index).padStart(3, "0")} / ${selected.total}`;
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
    buildMetricRow("모드", getParseModeLabel(), getParseModeDetail()),
    buildMetricRow("캐릭터", nextCharacter ? nextCharacter.id : "완료", `${Math.min(characterIndex, parsed.characters.length)} / ${parsed.characters.length} 완료`),
    buildMetricRow("장면", nextScene ? String(nextScene.index).padStart(3, "0") : "완료", `${getSavedSceneCount()} / ${parsed.scenes.length} 저장`),
    buildMetricRow("모델", modelEl.value, `x${getEffectiveSceneCount()}, ${aspectRatioEl.value}`),
    createEl("div", "summary-last", `마지막 저장: ${last}`)
  );
  return card;
}

function getParseModeLabel() {
  if (parsed?.mode === "simple-scenes") return "간단 장면";
  if (parsed?.mode === "prompt-pack") return "프롬프트 묶음";
  if (parsed?.mode === "friendly-story") return "쉬운 입력";
  return "정식 포맷";
}

function getParseModeDetail() {
  if (parsed?.mode === "simple-scenes") return "캐릭터 참조 없음";
  if (parsed?.mode === "prompt-pack") return "본문 유지, 참조 자동 연결";
  if (parsed?.mode === "friendly-story") return "이름 기반 참조 자동 연결";
  return "캐릭터 참조 사용";
}

function buildCharacterSummary() {
  const card = createEl("div", "summary-card");
  if (!parsed.characters.length) {
    card.append(createEl("div", "summary-empty", "캐릭터 프롬프트가 없습니다."));
    return card;
  }

  for (const [index, character] of parsed.characters.entries()) {
    const ref = characterRefs[character.id];
    const status = getCharacterProgressStatus(character, index);
    const savedText = ref ? `참조 저장됨${ref.model ? ` / ${ref.model}` : ""}` : "캐릭터 참조 없음";
    card.append(buildStatusRow({
      title: character.id,
      detail: ref?.mediaName || savedText,
      status
    }));
  }
  return card;
}

function buildLibrarySummary() {
  const card = createEl("div", "summary-card");
  const projectLibrary = getProjectBucket(characterLibraryByProject, currentProjectId);
  const libraryEntries = Object.entries(projectLibrary || {})
    .filter(([, ref]) => ref)
    .sort(([a], [b]) => a.localeCompare(b));
  if (currentProjectId) {
    card.append(createEl("div", "summary-empty", `현재 프로젝트: ${currentProjectId}`));
  }

  if (!libraryEntries.length) {
    card.append(createEl("div", "summary-empty", "현재 프로젝트 보관함에 캐릭터 참조가 없습니다."));
    return card;
  }

  const currentIds = getReferencedCharacterIds(parsed);
  for (const [id, ref] of libraryEntries) {
    const isCurrent = currentIds.has(id);
    const isLoaded = Boolean(characterRefs[id]);
    card.append(buildStatusRow({
      title: id,
      detail: ref.mediaName || ref.href || "saved",
      status: isLoaded
        ? { label: "사용 중", className: "is-done" }
        : isCurrent
          ? { label: "불러오기", className: "is-next" }
          : { label: "보관됨", className: "is-todo" }
    }));
  }
  return card;
}

function buildSceneSummary() {
  const card = createEl("div", "summary-card");
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
    const status = getSceneProgressStatus(scene, index, sceneIndex, outputs.length);
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

function getCharacterProgressStatus(character, index) {
  const id = character?.id;
  if (id && regenQueue?.characters?.includes(id)) {
    return { label: "재생성", className: "is-queued" };
  }
  if (id && characterRefs?.[id]) {
    return { label: "저장됨", className: "is-done" };
  }
  if (index === characterIndex) {
    return { label: "다음", className: "is-next" };
  }
  return { label: "대기", className: "is-todo" };
}

function getSceneProgressStatus(scene, index, currentIndex, savedCount) {
  if (regenQueue?.scenes?.includes(scene?.index)) {
    return { label: "재생성", className: "is-queued" };
  }
  if (savedCount > 0) {
    return { label: "저장됨", className: "is-done" };
  }
  if (index === currentIndex) {
    return { label: "다음", className: "is-next" };
  }
  if (index < currentIndex) {
    return { label: "미저장", className: "is-todo" };
  }
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
    promptEditorEl.textContent = "프롬프트를 수정한 뒤, '이 항목만 재생성 준비'로 큐에 넣거나 '이 지점부터 다시 생성 준비'로 되감아 다시 만들 수 있습니다.";
    updatePromptEditorAccordionSummary();
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

  const referencePicker = editorKind === "scenes" && selected
    ? buildEditorReferencePicker(selected.references || [])
    : null;

  const actions = document.createElement("div");
  actions.className = "editor-actions";
  actions.append(
    buildEditorButton("수정 저장", () => {
      saveEditedPrompt(textarea.value, {
        references: referencePicker ? getCheckedReferenceIds(referencePicker) : null
      });
    }, "", !selected),
    buildEditorButton("이 항목만 재생성 준비", async () => {
      if (!saveEditedPrompt(textarea.value, {
        silent: true,
        references: referencePicker ? getCheckedReferenceIds(referencePicker) : null
      })) return;
      await setSelectedAsRegenOnly();
    }, "button-primary", !selected),
    buildEditorButton("이 지점부터 다시 생성 준비", async () => {
      if (!saveEditedPrompt(textarea.value, {
        silent: true,
        references: referencePicker ? getCheckedReferenceIds(referencePicker) : null
      })) return;
      await setSelectedAsNext();
    }, "", !selected)
  );

  promptEditorEl.append(tabs, select, meta);
  if (referencePicker) promptEditorEl.append(referencePicker);
  promptEditorEl.append(textarea, actions);
  updatePromptEditorAccordionSummary();
}

function buildEditorReferencePicker(selectedIds = []) {
  const field = createEl("div", "builder-field editor-reference-picker");
  field.append(createEl("span", "", "참조 캐릭터"));
  const list = createEl("div", "scene-character-list");
  const selected = new Set((selectedIds || []).map((id) => normalizeCharacterId(id)).filter(Boolean));
  const options = getAvailableCharacterOptions();
  if (!options.length) {
    list.append(createEl("div", "builder-empty", "저장된 캐릭터 참조가 없습니다. 먼저 참조 보관함을 다시 연결하세요."));
  } else {
    for (const option of options) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = option.id;
      checkbox.checked = selected.has(option.id);
      label.append(checkbox, createEl("span", "", `${option.name} (${option.id})`));
      list.append(label);
    }
  }
  field.append(list);
  return field;
}

function getCheckedReferenceIds(container) {
  return [...container.querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => normalizeCharacterId(input.value))
    .filter(Boolean);
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

function getSceneOutputCount(sceneNumber) {
  return sceneOutputs.filter((output) => output.sceneIndex === sceneNumber).length;
}

function getSavedSceneCount() {
  return new Set(sceneOutputs.map((output) => output.sceneIndex)).size;
}

function getEditorLabel(item, index) {
  if (editorKind === "characters") {
    const marker = regenQueue?.characters?.includes(item.id)
      ? "재생성"
      : characterRefs?.[item.id]
        ? "저장됨"
        : index === characterIndex
          ? "다음"
          : "대기";
    return `${item.id} [${marker}]`;
  }
  const saved = getSceneOutputCount(item.index);
  const marker = regenQueue?.scenes?.includes(item.index)
    ? "재생성"
    : index === sceneIndex
      ? "다음"
      : saved > 0
        ? "저장됨"
        : "대기";
  return `${String(item.index).padStart(3, "0")} / ${item.total} [${marker}]`;
}

function getEditorMeta(item) {
  if (editorKind === "characters") {
    const ref = characterRefs[item.id];
    return ref
      ? `보관된 캐릭터 참조가 연결되어 있습니다: ${ref.mediaName || ref.href || item.id}`
      : "아직 연결된 캐릭터 참조가 없습니다.";
  }
  const refs = item.references?.length ? item.references.join(", ") : "참조 없음";
  const saved = getSceneOutputCount(item.index);
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
    item.references = Array.isArray(options.references)
      ? options.references
      : getReferencesFromPrompt(prompt);
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
  const knownIds = new Set(getAvailableCharacterOptions().map((character) => normalizeCharacterId(character.id)));
  return [...new Set((prompt.match(/[^\s,()]+_CS-\d{2}/g) || [])
    .map((id) => normalizeCharacterId(id))
    .filter(Boolean))]
    .filter((id) => knownIds.has(id));
}

async function setSelectedAsRegenOnly() {
  const items = getEditorItems();
  const item = items[editorIndex];
  if (!item) return;

  await refreshCurrentProjectContext();
  await refreshSavedState({ render: false });

  if (editorKind === "characters") {
    delete characterRefs[item.id];
    if (currentProjectId) characterRefsByProject[currentProjectId] = characterRefs;
    checkpoint = buildManualCheckpoint(`Character ${item.id}`);
    await new Promise((resolve) => chrome.storage.local.set({
      [CHARACTER_REFS_BY_PROJECT_KEY]: characterRefsByProject,
      checkpoint
    }, () => resolve()));
    await enqueueRegen("character", item.id);
    await refreshSavedState();
    setLog(`${item.id} 캐릭터를 재생성 큐에 추가했습니다. (다른 캐릭터 상태는 유지)`);
    return;
  }

  sceneOutputs = sceneOutputs.filter((output) => output.sceneIndex !== item.index);
  checkpoint = buildManualCheckpoint(`Scene ${String(item.index).padStart(3, "0")}`);
  await new Promise((resolve) => chrome.storage.local.set({ sceneOutputs, checkpoint }, () => resolve()));
  await enqueueRegen("scene", item.index);
  await refreshSavedState();
  setLog(`${item.index}번 장면을 재생성 큐에 추가했습니다. (다른 장면 상태는 유지)`);
}

async function setSelectedAsNext() {
  const items = getEditorItems();
  const item = items[editorIndex];
  if (!item) return;

  if (editorKind === "characters") {
    characterIndex = editorIndex;
    delete characterRefs[item.id];
    checkpoint = buildManualCheckpoint(`Character ${item.id}`);
    characterRefsByProject[currentProjectId] = characterRefs;
    await new Promise((resolve) => chrome.storage.local.set({
      characterIndex,
      [CHARACTER_REFS_BY_PROJECT_KEY]: characterRefsByProject,
      checkpoint
    }, () => resolve()));
    await refreshSavedState();
    setLog(`${item.id} 캐릭터를 다시 생성할 준비가 완료되었습니다. 기존 참조 기록은 삭제했습니다.`);
    return;
  }

  sceneIndex = editorIndex;
  sceneOutputs = sceneOutputs.filter((output) => output.sceneIndex !== item.index);
  checkpoint = buildManualCheckpoint(`Scene ${String(item.index).padStart(3, "0")}`);
  await new Promise((resolve) => chrome.storage.local.set({ sceneIndex, sceneOutputs, checkpoint }, () => resolve()));
  await refreshSavedState();
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
  if (!parsed) await parseInput();
  await refreshCurrentProjectContext();
  await refreshSavedState({ render: false });
  const selected = selectNextItem(action);
  if (!selected) return;
  if (!currentProjectId) {
    if (action === "runCharacters") {
      setLog("현재 프로젝트 ID가 아직 없습니다. 캐릭터 생성 중 Flow에서 프로젝트가 생성되면 자동으로 저장됩니다.");
    } else if (action === "runScenes" && !getMissingSceneReferences(selected.item).length) {
      setLog("캐릭터 참조가 없는 장면입니다. Flow에서 새 프로젝트를 열어 장면 생성을 시작합니다.");
    } else {
      setLog("캐릭터 참조가 필요한 장면은 Flow 프로젝트 화면을 먼저 열어주세요.");
      return;
    }
  }
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
  if (currentProjectId) payload.settings.projectId = currentProjectId;
  payload.settings.characterCount = 1;

  navigator.clipboard.writeText(selected.prompt).catch(() => null).finally(() => {
    lastRunSelection = selected;
    sendFlowMessage(tab.id, { type: action, payload }, (response) => {
      if (chrome.runtime.lastError) {
        setLog(`실패: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (response?.ok) {
        markSelectedDone(action, lastRunSelection).catch((error) => {
          setLog(`완료 처리 실패: ${error.message}`);
        });
      }
      setLog(response?.message || "명령을 보냈습니다.");
    });
  });
}

async function runRecoverScene() {
  if (!parsed) await parseInput();
  await refreshCurrentProjectContext();
  if (!currentProjectId) {
    setLog("현재 탭에서 Flow 프로젝트 ID를 찾지 못했습니다.");
    return;
  }
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
      sceneCount: getEffectiveSceneCount(),
      debug: Boolean(debugEl?.checked),
      projectId: currentProjectId
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

async function backOneScene() {
  if (!parsed) await parseInput();
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

    const orderedOutputs = sortSceneOutputsForDownload(outputs);
    setLog(`장면 이미지 다운로드를 순서대로 요청했습니다: ${orderedOutputs.length}개`);
    chrome.runtime.sendMessage({ type: "downloadSceneOutputs", outputs: orderedOutputs }, (response) => {
      if (chrome.runtime.lastError) {
        setLog(`실패: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (!response?.ok) {
        setLog(`오류: ${response?.message || "다운로드에 실패했습니다."}`);
        return;
      }
      setLog(`다운로드를 완료했습니다: ${response.count}개`);
    });
  });
}

function sortSceneOutputsForDownload(outputs) {
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
    const queuedId = regenQueue?.characters?.[0];
    const queuedItem = queuedId ? parsed.characters.find((character) => character.id === queuedId) : null;
    const item = queuedItem || parsed.characters[characterIndex];
    if (!item) {
      setLog("남은 캐릭터 시트가 없습니다.");
      return null;
    }
    return {
      label: item.id,
      prompt: item.prompt,
      parsed: { characters: [item], scenes: [] },
      item,
      selection: { kind: "character", key: item.id, fromQueue: Boolean(queuedItem) }
    };
  }
  const queuedSceneNumber = regenQueue?.scenes?.[0];
  const queuedScene = typeof queuedSceneNumber === "number"
    ? parsed.scenes.find((scene) => scene.index === queuedSceneNumber)
    : null;
  const item = queuedScene || parsed.scenes[sceneIndex];
  if (!item) {
    setLog("남은 장면이 없습니다.");
    return null;
  }
  return {
    label: `Image ${item.index}/${item.total}`,
    prompt: item.prompt,
    parsed: { characters: [], scenes: [item] },
    item,
    selection: { kind: "scene", key: item.index, fromQueue: Boolean(queuedScene) }
  };
}

function getMissingSceneReferences(scene) {
  if (!scene?.references?.length) return [];
  return scene.references
    .map((id) => normalizeCharacterId(id))
    .filter((id) => id && !characterRefs[id]);
}

async function ensureSceneReferencesReady(scene) {
  await refreshSavedState({ render: false });
  if (scene?.references?.some((id) => !characterRefs[normalizeCharacterId(id)])) {
    if (!currentProjectId) {
      renderSummary();
      setLog("이 장면은 캐릭터 참조가 필요합니다. 먼저 Flow 프로젝트 화면을 열어 캐릭터 참조를 불러오거나 생성해 주세요.");
      return false;
    }
    const restored = await getRestoredCharacterRefs(parsed);
    characterRefs = {
      ...characterRefs,
      ...restored
    };
    characterRefsByProject[currentProjectId] = characterRefs;
    projectLastUsedAt[currentProjectId] = Date.now();
    characterIndex = getNextCharacterIndex(parsed, characterRefs);
    await chrome.storage.local.set({
      [CHARACTER_REFS_BY_PROJECT_KEY]: characterRefsByProject,
      [PROJECT_LAST_USED_KEY]: projectLastUsedAt,
      characterIndex
    });
  }
  const missing = getMissingSceneReferences(scene);
  if (!missing.length) return true;
  renderSummary();
  setLog(`${scene.index}번 장면에 필요한 캐릭터 참조가 없습니다: ${missing.join(", ")}. 먼저 해당 캐릭터를 생성하거나 복구해 주세요.`);
  return false;
}

async function markSelectedDone(action, selected) {
  const selection = selected?.selection || {};
  const item = selected?.item || null;

  // After the first generation Flow may create a new project and update the URL.
  // Refresh project context so we load refs/queues from the right bucket.
  await refreshCurrentProjectContext();

  if (selection.fromQueue && selection.kind === "character") {
    await dequeueRegen("character", selection.key);
  }
  if (selection.fromQueue && selection.kind === "scene") {
    await dequeueRegen("scene", selection.key);
  }

  // Content script persists refs/outputs on success, so reload first.
  await refreshSavedState({ render: false });

  if (action === "runCharacters") {
    characterIndex = getNextCharacterIndex(parsed, characterRefs);
    checkpoint = buildCheckpoint("character", item);
  } else {
    if (!selection.fromQueue) {
      sceneIndex += 1;
    }
    checkpoint = buildCheckpoint("scene", item);
  }

  await new Promise((resolve) => chrome.storage.local.set({ characterIndex, sceneIndex, checkpoint }, () => resolve()));
  await refreshSavedState();
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
    chrome.storage.local.get({
      sceneOutputs: [],
      [CHARACTER_REFS_BY_PROJECT_KEY]: {},
      [CHARACTER_LIBRARY_BY_PROJECT_KEY]: {},
      [PROJECT_LAST_USED_KEY]: {},
      [REGEN_QUEUE_BY_PROJECT_KEY]: {}
    }, (data) => {
      sceneOutputs = data.sceneOutputs || [];
      characterRefsByProject = data[CHARACTER_REFS_BY_PROJECT_KEY] || {};
      characterLibraryByProject = data[CHARACTER_LIBRARY_BY_PROJECT_KEY] || {};
      projectLastUsedAt = data[PROJECT_LAST_USED_KEY] || {};
      regenQueueByProject = data[REGEN_QUEUE_BY_PROJECT_KEY] || {};
      ensureProjectContextFromStorage();
      characterRefs = getProjectBucket(characterRefsByProject, currentProjectId);
      characterLibrary = getProjectBucket(characterLibraryByProject, currentProjectId);
      regenQueue = normalizeRegenQueue(getProjectBucket(regenQueueByProject, currentProjectId));
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
    aspectRatio: aspectRatioEl.value,
    debug: Boolean(debugEl?.checked)
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

async function clearSource() {
  if (!confirmClearSource()) return;
  await mergeRefsIntoCharacterLibrary(characterRefs);
  parsed = null;
  characterIndex = 0;
  sceneIndex = 0;
  sceneOutputs = [];
  characterRefs = {};
  regenQueue = { characters: [], scenes: [] };
  checkpoint = null;
  editorKind = "characters";
  editorIndex = 0;
  sourceEl.value = "";
  summaryEl.classList.add("empty");
  summaryEl.classList.remove("summary-dashboard");
  summaryEl.textContent = "아직 목록이 없습니다.";
  logEl.textContent = "";
  if (currentProjectId) {
    characterRefsByProject[currentProjectId] = {};
    regenQueueByProject[currentProjectId] = regenQueue;
  }
  chrome.storage.local.set({
    [CHARACTER_REFS_BY_PROJECT_KEY]: characterRefsByProject,
    [REGEN_QUEUE_BY_PROJECT_KEY]: regenQueueByProject
  });
  chrome.storage.local.remove(["source", "parsed", "characterIndex", "sceneIndex", "sceneOutputs", "checkpoint"]);
  renderPromptEditor();
}

function confirmClearSource() {
  if (!hasActiveWorkflow()) return true;
  return window.confirm("진행 중인 작업을 초기화할까요?\n프롬프트와 진행 상태가 지워집니다.");
}

function hasActiveWorkflow() {
  if (!parsed) return false;
  if (checkpoint) return true;
  const hasPendingCharacters = characterIndex < (parsed.characters?.length || 0);
  const hasPendingScenes = sceneIndex < (parsed.scenes?.length || 0);
  return hasPendingCharacters || hasPendingScenes;
}

function getProjectBucket(map, projectId) {
  if (!projectId) return {};
  return map?.[projectId] || {};
}

function trimProjectLibrary(library) {
  const entries = Object.entries(library || {})
    .filter(([, ref]) => ref)
    .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
  return Object.fromEntries(entries.slice(0, MAX_REFS_PER_PROJECT));
}

function extractFlowProjectId(url = "") {
  const match = url.match(/\/project\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function refreshCurrentProjectContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const projectId = extractFlowProjectId(tab?.url || "");
  if (projectId) {
    currentProjectId = projectId;
  } else {
    ensureProjectContextFromStorage();
  }
  return currentProjectId;
}

function migrateLegacyCharacterStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get({
      [CHARACTER_REFS_BY_PROJECT_KEY]: {},
      [CHARACTER_LIBRARY_BY_PROJECT_KEY]: {},
      [PROJECT_LAST_USED_KEY]: {},
      characterRefs: {},
      [CHARACTER_LIBRARY_KEY]: {}
    }, async (data) => {
      const byProjectRefs = data[CHARACTER_REFS_BY_PROJECT_KEY] || {};
      const byProjectLibrary = data[CHARACTER_LIBRARY_BY_PROJECT_KEY] || {};
      const hasScoped = Object.keys(byProjectRefs).length || Object.keys(byProjectLibrary).length;
      if (hasScoped) {
        resolve();
        return;
      }

      const legacyRefs = data.characterRefs || {};
      const legacyLibrary = data[CHARACTER_LIBRARY_KEY] || {};
      if (!Object.keys(legacyRefs).length && !Object.keys(legacyLibrary).length) {
        resolve();
        return;
      }

      const projectId = await refreshCurrentProjectContext();
      const fallback = projectId || "legacy";
      const mergedLibrary = trimProjectLibrary({
        ...legacyLibrary,
        ...legacyRefs
      });
      const now = Date.now();
      chrome.storage.local.set({
        [CHARACTER_REFS_BY_PROJECT_KEY]: { [fallback]: { ...legacyRefs } },
        [CHARACTER_LIBRARY_BY_PROJECT_KEY]: { [fallback]: mergedLibrary },
        [PROJECT_LAST_USED_KEY]: { [fallback]: now }
      }, () => {
        chrome.storage.local.remove(["characterRefs", CHARACTER_LIBRARY_KEY], () => resolve());
      });
    });
  });
}

function exportCharacterLibraryBackup() {
  const payload = {
    schemaVersion: 1,
    exportedAt: Date.now(),
    data: {
      [CHARACTER_REFS_BY_PROJECT_KEY]: characterRefsByProject || {},
      [CHARACTER_LIBRARY_BY_PROJECT_KEY]: characterLibraryByProject || {},
      [PROJECT_LAST_USED_KEY]: projectLastUsedAt || {}
    }
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  anchor.href = url;
  anchor.download = `flow-stepper-library-backup-${stamp}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  setLog("캐릭터 참조 백업(JSON)을 다운로드했습니다.");
}

function importCharacterLibraryBackup(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsedJson = JSON.parse(String(reader.result || "{}"));
      const backupRefs = parsedJson?.data?.[CHARACTER_REFS_BY_PROJECT_KEY];
      const backupLibrary = parsedJson?.data?.[CHARACTER_LIBRARY_BY_PROJECT_KEY];
      const backupLastUsed = parsedJson?.data?.[PROJECT_LAST_USED_KEY];
      if (!backupRefs || !backupLibrary || !backupLastUsed) {
        throw new Error("백업 포맷이 올바르지 않습니다.");
      }

      const mergedRefs = { ...characterRefsByProject };
      const mergedLibrary = { ...characterLibraryByProject };
      const mergedLastUsed = { ...projectLastUsedAt };

      for (const [projectId, refs] of Object.entries(backupRefs)) {
        mergedRefs[projectId] = { ...(mergedRefs[projectId] || {}), ...(refs || {}) };
      }

      for (const [projectId, library] of Object.entries(backupLibrary)) {
        const current = mergedLibrary[projectId] || {};
        const incoming = library || {};
        const next = { ...current };
        for (const [id, ref] of Object.entries(incoming)) {
          if (!next[id] || (next[id].savedAt || 0) < (ref?.savedAt || 0)) {
            next[id] = ref;
          }
        }
        mergedLibrary[projectId] = trimProjectLibrary(next);
      }

      for (const [projectId, savedAt] of Object.entries(backupLastUsed)) {
        mergedLastUsed[projectId] = Math.max(Number(mergedLastUsed[projectId] || 0), Number(savedAt || 0));
      }

      characterRefsByProject = mergedRefs;
      characterLibraryByProject = mergedLibrary;
      projectLastUsedAt = mergedLastUsed;
      characterRefs = getProjectBucket(characterRefsByProject, currentProjectId);
      characterLibrary = getProjectBucket(characterLibraryByProject, currentProjectId);

      chrome.storage.local.set({
        [CHARACTER_REFS_BY_PROJECT_KEY]: characterRefsByProject,
        [CHARACTER_LIBRARY_BY_PROJECT_KEY]: characterLibraryByProject,
        [PROJECT_LAST_USED_KEY]: projectLastUsedAt
      }, () => {
        renderSummary();
        setLog("캐릭터 참조 백업(JSON)을 복원했습니다.");
      });
    } catch (error) {
      setLog(`백업 복원 실패: ${error.message}`);
    } finally {
      if (importFileEl) importFileEl.value = "";
    }
  };
  reader.readAsText(file);
}
