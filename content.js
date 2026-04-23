const K = {
  newProject: "\uc0c8 \ud504\ub85c\uc81d\ud2b8",
  image: "\uc774\ubbf8\uc9c0",
  make: "\ub9cc\ub4e4\uae30",
  clearPrompt: "\ud504\ub86c\ud504\ud2b8 \uc9c0\uc6b0\uae30",
  download: "\ub2e4\uc6b4\ub85c\ub4dc",
  originalSize: "\uc6d0\ubcf8 \ud06c\uae30",
  done: "\uc644\ub8cc",
  back: "\ub4a4\ub85c",
  assetSearch: "\uc560\uc14b \uac80\uc0c9",
  editableText: "\uc218\uc815 \uac00\ub2a5\ud55c \ud14d\uc2a4\ud2b8"
};

const FLOW_STEPPER = {
  running: false,
  delayMs: 350,
  debug: false
};

function debugLog(message, data) {
  if (!FLOW_STEPPER.debug) return;
  if (typeof data === "undefined") {
    console.info("[Flow Stepper][debug]", message);
    return;
  }
  console.info("[Flow Stepper][debug]", message, data);
}

function safeText(value, max = 400) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function dumpSettingsSnapshot() {
  const settingsButton = findSettingsButton();
  return {
    href: location.href,
    settingsButtonText: safeText(settingsButton?.textContent || ""),
    selectedSettingsText: safeText(getSelectedSettingsText?.() || "", 800)
  };
}

function dumpSettingTabs(limit = 40) {
  const surfaces = getSettingsSurfaces?.() || [];
  const tabs = surfaces.flatMap((surface) => [...surface.querySelectorAll('button[role="tab"]')]);
  return tabs.slice(0, limit).map((tab) => ({
    text: safeText(tab.textContent || "", 120),
    id: safeText(tab.id || "", 120),
    ariaSelected: tab.getAttribute("aria-selected"),
    dataState: tab.getAttribute("data-state"),
    controls: safeText(tab.getAttribute("aria-controls") || "", 120)
  }));
}

function dumpEditItemsSummary(limit = 10) {
  const items = getEditItems?.() || [];
  return {
    count: items.length,
    head: items.slice(0, limit).map((item) => ({
      href: item.href,
      tileId: item.tileId,
      mediaName: getMediaNameFromUrl(item.src || "")
    }))
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type?.startsWith("run")) return;
  if (FLOW_STEPPER.running) {
    sendResponse({ ok: false, message: "이미 작업이 실행 중입니다." });
    return;
  }

  FLOW_STEPPER.running = true;
  FLOW_STEPPER.debug = Boolean(message?.payload?.settings?.debug);
  const task = getTask(message);

  task
    .then(() => sendResponse({ ok: true, message: "작업이 완료되었습니다." }))
    .catch((error) => {
      console.error("[Flow Stepper]", error);
      sendResponse({ ok: false, message: `오류: ${error.message}` });
    })
    .finally(() => {
      FLOW_STEPPER.running = false;
      FLOW_STEPPER.debug = false;
    });

  return true;
});

function getTask(message) {
  if (message.type === "runCharacters") return runCharacters(message.payload);
  if (message.type === "runScenes") return runScenes(message.payload);
  if (message.type === "runRecoverScene") return runRecoverScene(message.payload);
  if (message.type === "runDownloadScenes") return runDownloadScenes();
  return Promise.reject(new Error(`알 수 없는 작업입니다: ${message.type}`));
}

async function runCharacters(payload) {
  await ensureProjectEditor();
  for (const character of payload.parsed.characters) {
    console.info("[Flow Stepper] character", character.id);
    await clearPromptAndReferences();
    await setGenerationSettings({
      mode: K.image,
      model: payload.settings.model,
      aspectRatio: payload.settings.aspectRatio,
      count: 1
    });

    const before = snapshotEditLinks();
    await pastePrompt(character.prompt);
    await clickGenerate();
    const newItems = await waitForProjectNewMedia(before, 1, 240000);
    await saveCharacterReference(character.id, newItems[0], payload.settings.model);
  }
}

async function runScenes(payload) {
  await ensureProjectEditor();
  for (const scene of payload.parsed.scenes) {
    const baseName = buildSceneBaseName(scene);
    console.info("[Flow Stepper] scene", baseName);
    debugLog("runScenes:start", {
      sceneIndex: scene.index,
      sceneTotal: scene.total,
      expectedCount: payload.settings.sceneCount,
      model: payload.settings.model,
      aspectRatio: payload.settings.aspectRatio,
      references: scene.references,
      snapshot: dumpSettingsSnapshot()
    });
    await clearPromptAndReferences();

    for (const ref of scene.references) {
      await attachReference(ref);
    }

    const before = snapshotEditLinks();
    debugLog("runScenes:beforeGenerate", {
      beforeCount: before.size,
      snapshot: dumpSettingsSnapshot()
    });
    await pastePrompt(scene.prompt);
    await setGenerationSettings({
      mode: K.image,
      model: payload.settings.model,
      aspectRatio: payload.settings.aspectRatio,
      count: payload.settings.sceneCount
    });
    debugLog("runScenes:afterSettings", {
      snapshot: dumpSettingsSnapshot(),
      tabs: dumpSettingTabs(30)
    });
    await clickGenerate();
    debugLog("runScenes:clickedGenerate", {
      expectedCount: payload.settings.sceneCount,
      editItems: dumpEditItemsSummary(8)
    });
    const newItems = await waitForProjectNewMedia(before, payload.settings.sceneCount, 300000);
    debugLog("runScenes:gotNewMedia", {
      expectedCount: payload.settings.sceneCount,
      got: newItems.length,
      hrefs: newItems.map((item) => item.href)
    });
    await saveSceneOutputs(scene, newItems, baseName, payload.settings.model);
  }
}

async function runRecoverScene(payload) {
  await ensureProjectEditor();
  const scene = payload.parsed.scenes[0];
  if (!scene) throw new Error("최신 결과를 저장할 장면이 선택되지 않았습니다.");
  const count = payload.settings.sceneCount || 1;
  const items = getRecentEditItems(count);
  if (items.length < count) {
    throw new Error(`저장할 최신 장면 이미지 ${count}개를 찾지 못했습니다.`);
  }
  const baseName = buildSceneBaseName(scene);
  await saveSceneOutputs(scene, items, baseName, payload.settings.model);
}

async function ensureProjectEditor() {
  if (isMediaEditView()) {
    await returnToEditor();
  }
  if (!isMediaEditView() && findPromptEditor()) return;
  const newProject = findButton((button) => button.textContent.includes(K.newProject));
  if (newProject) {
    newProject.click();
    await waitFor(() => !isMediaEditView() && findPromptEditor(), 30000);
    return;
  }
  throw new Error("프롬프트 입력창 또는 새 프로젝트 버튼을 찾지 못했습니다.");
}

async function setGenerationSettings({ mode, model, aspectRatio, count }) {
  const settingsButton = findSettingsButton();
  if (!settingsButton) throw new Error("생성 설정 버튼을 찾지 못했습니다.");
  if (isCurrentSetting(settingsButton, model, aspectRatio, count)) {
    return;
  }
  console.info("[Flow Stepper] opening settings", {
    current: settingsButton.textContent,
    model,
    aspectRatio,
    count
  });
  clickElement(settingsButton);
  await waitForSettingsPanel(settingsButton, 15000);
  await delay(120);

  clickSettingText(mode, { optional: true });
  await delay(80);
  if (model) {
    await clickModelSetting(model);
    await delay(80);
  }
  clickSettingText(aspectRatio);
  await delay(80);
  const countWasSelected = clickCountSetting(count);
  console.info("[Flow Stepper] clicked settings", {
    selected: getSelectedSettingsText(),
    trigger: settingsButton.textContent
  });
  await waitFor(() => isCurrentSetting(settingsButton, model, aspectRatio, count, { requireCount: countWasSelected }) ||
    isOpenSettingSelected(model, aspectRatio, count, { requireCount: countWasSelected }), 8000, 150);
  closeOpenMenus();
  await delay(120);
}

function closeOpenMenus() {
  document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    keyCode: 27,
    which: 27,
    bubbles: true,
    cancelable: true
  }));
  document.body.click();
}

async function waitForSettingsPanel(settingsButton, timeoutMs) {
  await waitFor(() => {
    if (settingsButton.getAttribute("aria-expanded") === "true") return true;
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    if (tabs.some((tab) => [K.image, "Imagen", "Nano", "16:9", "4:3", "1:1", "3:4", "9:16", "x1", "x2", "x3", "x4"]
      .some((label) => normalize(tab.textContent).includes(normalize(label))))) {
      return true;
    }
    const menu = document.querySelector('[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]');
    return menu || null;
  }, timeoutMs);
}

function isCurrentSetting(button, model, aspectRatio, count, options = { requireCount: true }) {
  const text = normalize(button.textContent);
  const aspectMap = {
    "16:9": "crop_16_9",
    "4:3": "crop_landscape",
    "1:1": "crop_square",
    "3:4": "crop_portrait",
    "9:16": "crop_9_16"
  };
  const hasCount = !options.requireCount || text.includes(`x${count}`) || text.includes(String(count));
  const hasAspect = text.includes(normalize(aspectRatio)) || text.includes(aspectMap[aspectRatio]);
  const hasModel = !model || text.includes(normalize(model));
  return hasModel && hasCount && hasAspect;
}

function isOpenSettingSelected(model, aspectRatio, count, options = { requireCount: true }) {
  const selectedText = normalize(getSelectedSettingsText());
  const hasModel = !model || selectedText.includes(normalize(model));
  const hasCount = !options.requireCount || selectedText.includes(`x${count}`) || selectedText.includes(String(count));
  const hasAspect = selectedText.includes(normalize(aspectRatio));
  return hasModel && hasCount && hasAspect;
}

function getSelectedSettingsText() {
  const surfaces = getSettingsSurfaces();
  const tabs = surfaces.flatMap((surface) => [...surface.querySelectorAll('button[role="tab"]')]);
  return tabs
    .filter((tab) => tab.getAttribute("aria-selected") === "true" || tab.getAttribute("data-state") === "active")
    .map((tab) => tab.textContent)
    .join(" ");
}

function findSettingsButton() {
  const promptBar = findPromptBar();
  if (promptBar) {
    const promptBarSettings = [...promptBar.querySelectorAll("button")]
      .find((button) => {
        const text = button.textContent || "";
        return button.getAttribute("aria-haspopup") === "menu" &&
          (text.includes("Nano") || text.includes("Banana") || text.includes("Imagen") || text.includes("crop_") || /x[1-4]/.test(text));
      });
    if (promptBarSettings) return promptBarSettings;
  }

  const buttons = [...document.querySelectorAll("button")];
  return findPromptBarButtonBeforeGenerate() || buttons.find((button) => {
    const text = button.textContent || "";
    return (
      button.getAttribute("aria-haspopup") === "menu" &&
      (text.includes("Nano") || text.includes("Banana") || text.includes("Imagen") || text.includes("crop_") || /x[1-4]/.test(text))
    );
  }) || buttons.find((button) => {
    const text = button.textContent || "";
    return text.includes("crop_16_9") || text.includes("crop_9_16") || /x[1-4]/.test(text);
  });
}

function findPromptBarButtonBeforeGenerate() {
  const generate = findButton((candidate) =>
    candidate.textContent.includes("arrow_forward") && candidate.textContent.includes(K.make)
  );
  if (!generate) return null;
  const ancestors = [];
  let node = generate.parentElement;
  while (node && ancestors.length < 6) {
    ancestors.push(node);
    node = node.parentElement;
  }

  for (const ancestor of ancestors) {
    const menuButtons = [...ancestor.querySelectorAll("button")]
      .filter((button) => button !== generate && button.getAttribute("aria-haspopup") === "menu");
    const settings = menuButtons.find((button) => {
      const text = button.textContent || "";
      return text.includes("Nano") || text.includes("Banana") || text.includes("Imagen") || text.includes("crop_") || /x[1-4]/.test(text);
    });
    if (settings) return settings;
  }

  return null;
}

function findPromptBar() {
  const editor = findPromptEditor();
  if (!editor) return null;
  let node = editor.parentElement;
  while (node) {
    const text = node.textContent || "";
    const hasAdd = text.includes("add_2");
    const hasGenerate = text.includes("arrow_forward") && text.includes(K.make);
    if (hasAdd && hasGenerate && node.querySelectorAll("button").length >= 2) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

async function clickModelSetting(model) {
  const currentButton = findModelDropdownButton();
  if (!currentButton) {
    clickSettingText(model, { optional: true });
    return;
  }

  if (normalize(currentButton.textContent).includes(normalize(model))) {
    return;
  }

  console.info("[Flow Stepper] opening model menu", {
    current: currentButton.textContent,
    model
  });
  clickElement(currentButton);
  await waitFor(() => findVisibleSettingCandidate(model), 8000, 150);
  clickSettingText(model);
}

function findModelDropdownButton() {
  const surfaces = getSettingsSurfaces();
  const buttons = surfaces.flatMap((surface) => [...surface.querySelectorAll("button")]);
  return buttons.find((button) => {
    const text = normalize(button.textContent);
    return button.getAttribute("aria-haspopup") === "menu" &&
      ((text.includes("Nano") && text.includes("Banana")) || text.includes("Imagen"));
  }) || null;
}

function clickSettingText(text, options = { optional: false }) {
  const candidate = findSettingTab(text) || findVisibleSettingCandidate(text);
  if (!candidate) {
    if (options.optional) return;
    throw new Error(`설정 항목을 찾지 못했습니다: ${text}`);
  }
  console.info("[Flow Stepper] click setting", text, {
    text: candidate.textContent,
    id: candidate.id,
    controls: candidate.getAttribute("aria-controls")
  });
  clickElement(candidate);
  return candidate;
}

function clickCountSetting(count) {
  const candidate = findSettingTab(`x${count}`) || findVisibleCountCandidate(count);
  if (!candidate) {
    console.warn("[Flow Stepper] count setting not found; continuing with current Flow count", count);
    return false;
  }
  console.info("[Flow Stepper] click count setting", count, {
    text: candidate.textContent,
    id: candidate.id,
    controls: candidate.getAttribute("aria-controls"),
    label: candidate.getAttribute("aria-label")
  });
  clickElement(candidate);
  return true;
}

function findSettingTab(text) {
  const normalizedText = normalize(text);
  const surfaces = getSettingsSurfaces();
  const tabs = surfaces.flatMap((surface) => [...surface.querySelectorAll('button[role="tab"]')]);

  if (/^x[1-4]$/.test(text)) {
    const number = text.slice(1);
    return tabs.find((tab) =>
      normalize(tab.textContent) === normalizedText ||
      normalize(tab.textContent) === number ||
      tab.id.endsWith(`-trigger-${number}`) ||
      tab.getAttribute("aria-controls")?.endsWith(`-content-${number}`) ||
      hasCountToken(tab.id, number) ||
      hasCountToken(tab.getAttribute("aria-controls"), number)
    ) || null;
  }

  const aspectIdMap = {
    "16:9": "LANDSCAPE",
    "4:3": "LANDSCAPE_4_3",
    "1:1": "SQUARE",
    "3:4": "PORTRAIT_3_4",
    "9:16": "PORTRAIT"
  };
  const aspectId = aspectIdMap[text];
  if (aspectId) {
    return tabs.find((tab) =>
      normalize(tab.textContent).includes(normalizedText) ||
      tab.id.endsWith(`-trigger-${aspectId}`) ||
      tab.getAttribute("aria-controls")?.endsWith(`-content-${aspectId}`)
    ) || null;
  }

  if (text === K.image) {
    return tabs.find((tab) =>
      normalize(tab.textContent).includes(normalizedText) ||
      tab.id.endsWith("-trigger-IMAGE") ||
      tab.getAttribute("aria-controls")?.endsWith("-content-IMAGE")
    ) || null;
  }

  return tabs.find((tab) => normalize(tab.textContent).includes(normalizedText)) || null;
}

function findVisibleSettingCandidate(text) {
  const normalizedText = normalize(text);
  const surfaces = getSettingsSurfaces();
  const elements = surfaces.flatMap((surface) =>
    [surface, ...surface.querySelectorAll('[role="tab"], [role="menuitem"], [role="option"], button, div, span')]
  );

  return elements
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const value = normalize(element.textContent);
      return value === normalizedText || value.includes(normalizedText);
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const aExact = normalize(a.textContent) === normalizedText ? 0 : 1;
      const bExact = normalize(b.textContent) === normalizedText ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return (ar.width * ar.height) - (br.width * br.height);
    })[0] || null;
}

function findVisibleCountCandidate(count) {
  const countText = String(count);
  const surfaces = getSettingsSurfaces();
  const elements = surfaces.flatMap((surface) =>
    [surface, ...surface.querySelectorAll('[role="tab"], [role="menuitem"], [role="option"], button, div, span')]
  );

  return elements
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const text = normalize(element.textContent);
      const label = normalize([
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.id,
        element.getAttribute("aria-controls")
      ].filter(Boolean).join(" "));
      return text === `x${countText}` ||
        text === countText ||
        hasCountToken(label, countText);
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const aText = normalize(a.textContent);
      const bText = normalize(b.textContent);
      const aExact = aText === `x${countText}` || aText === countText ? 0 : 1;
      const bExact = bText === `x${countText}` || bText === countText ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return (ar.width * ar.height) - (br.width * br.height);
    })[0] || null;
}

function hasCountToken(value, countText) {
  const text = normalize(value).toUpperCase();
  if (!text) return false;
  return text.includes(`X${countText}`) ||
    text.includes(`COUNT${countText}`) ||
    text.includes(`COUNT_${countText}`) ||
    text.includes(`IMAGECOUNT${countText}`) ||
    text.includes(`IMAGE_COUNT_${countText}`) ||
    text.includes(`NUMIMAGES${countText}`) ||
    text.includes(`NUM_IMAGES_${countText}`) ||
    text.endsWith(`-${countText}`) ||
    text.endsWith(`_${countText}`);
}

function getSettingsSurfaces() {
  const selectors = [
    '[role="menu"]',
    '[role="dialog"]',
    '[data-radix-popper-content-wrapper]',
    '[data-state="open"]'
  ];
  const surfaces = selectors.flatMap((selector) => [...document.querySelectorAll(selector)])
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const text = normalize(element.textContent);
      return rect.width > 0 && rect.height > 0 &&
        (text.includes("x1") || text.includes("x2") || text.includes("16:9") || text.includes(K.image) || text.includes("Imagen"));
    });
  return surfaces.length ? surfaces : [document.body];
}

async function pastePrompt(prompt) {
  const editor = findPromptEditor();
  if (!editor) throw new Error("프롬프트 입력창을 찾지 못했습니다.");
  clickElement(editor);
  editor.focus();
  await delay(80);

  await pasteWithClipboard(editor, prompt);
  await delay(500);

  if (!editorTextContains(editor, prompt)) {
    await pasteWithBeforeInput(editor, prompt);
    await delay(500);
  }

  if (!editorTextContains(editor, prompt)) {
    throw new Error("Flow 입력창에 프롬프트를 넣지 못했습니다.");
  }
}

async function pasteWithClipboard(editor, prompt) {
  clickElement(editor);
  editor.focus();
  const pasted = document.execCommand("paste");
  if (!pasted) {
    const data = new DataTransfer();
    data.setData("text/plain", prompt);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data
    });
    editor.dispatchEvent(event);
  }
}

async function pasteWithBeforeInput(editor, prompt) {
  clickElement(editor);
  editor.focus();
  const event = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "insertFromPaste",
    data: prompt
  });
  editor.dispatchEvent(event);
}

function clickElement(element) {
  const rect = element.getBoundingClientRect();
  const clientX = rect.left + Math.max(1, Math.min(rect.width / 2, rect.width - 1));
  const clientY = rect.top + Math.max(1, Math.min(rect.height / 2, rect.height - 1));
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    screenX: window.screenX + clientX,
    screenY: window.screenY + clientY,
    button: 0,
    buttons: 1,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true
  };

  if (window.PointerEvent) {
    element.dispatchEvent(new PointerEvent("pointerover", eventInit));
    element.dispatchEvent(new PointerEvent("pointerenter", eventInit));
    element.dispatchEvent(new PointerEvent("pointerdown", eventInit));
  }
  element.dispatchEvent(new MouseEvent("mouseover", eventInit));
  element.dispatchEvent(new MouseEvent("mouseenter", eventInit));
  element.dispatchEvent(new MouseEvent("mousedown", eventInit));
  if (window.PointerEvent) {
    element.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, buttons: 0 }));
  }
  element.dispatchEvent(new MouseEvent("mouseup", { ...eventInit, buttons: 0 }));
  element.dispatchEvent(new MouseEvent("click", { ...eventInit, buttons: 0 }));
  element.click?.();
}

function doubleClickElement(element) {
  clickElement(element);
  element.dispatchEvent(new MouseEvent("dblclick", {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window
  }));
}

function editorTextContains(editor, prompt) {
  const probe = prompt.replace(/\s+/g, " ").trim().slice(0, 40);
  const text = (editor.innerText || editor.textContent || "").replace(/\s+/g, " ").trim();
  return probe.length > 0 && text.includes(probe);
}

async function clearPromptAndReferences() {
  const clearButton = findButton((button) => button.textContent.includes(K.clearPrompt));
  if (clearButton) {
    clearButton.click();
    await delay(250);
  }

  const cancelButtons = [...document.querySelectorAll("button")]
    .filter((button) => button.textContent.includes("cancel"));
  for (const button of cancelButtons) {
    button.click();
    await delay(100);
  }
}

async function clickGenerate() {
  await waitFor(findPromptEditor, 15000);
  const button = findGenerateButton();
  if (!button) throw new Error("생성 버튼을 찾지 못했습니다.");
  button.click();
}

function findGenerateButton() {
  const promptBar = findPromptBar();
  const buttons = promptBar ? [...promptBar.querySelectorAll("button")] : [...document.querySelectorAll("button")];
  const byIcon = buttons.find((button) =>
    button.textContent.includes("arrow_forward") && button.textContent.includes(K.make)
  );
  if (byIcon) return byIcon;

  const editor = findPromptEditor();
  if (!editor) return null;
  const ancestors = [];
  let node = editor.parentElement;
  while (node && ancestors.length < 8) {
    ancestors.push(node);
    node = node.parentElement;
  }

  for (const ancestor of ancestors) {
    const localButtons = [...ancestor.querySelectorAll("button")];
    const likely = localButtons[localButtons.length - 1];
    if (likely && !likely.textContent.includes("add_2")) return likely;
  }

  return null;
}

async function attachReference(name) {
  const refs = await loadCharacterReferences();
  const savedRef = refs[name];
  const previousAttachmentCount = getPromptAttachmentImageCount();
  const promptBar = findPromptBar();
  const addButton = [...(promptBar || document).querySelectorAll("button")].find((button) =>
    button.textContent.includes("add_2") && button.textContent.includes(K.make)
  );
  if (!addButton) throw new Error("참조 이미지 추가 버튼을 찾지 못했습니다.");
  debugLog("attachReference:openPicker", {
    name,
    previousAttachmentCount,
    savedRef: savedRef ? { id: savedRef.id, mediaName: savedRef.mediaName, href: savedRef.href } : null,
    snapshot: dumpSettingsSnapshot()
  });
  addButton.click();
  await waitFor(getAssetPickerSearchInput, 15000);

  const search = getAssetPickerSearchInput();
  // Fast path: picker가 이미 최신 목록 상태면 바로 찾는다.
  let image = await waitFor(() => findReferenceImage(name, savedRef, refs), 1500, 120).catch(() => null);

  // Fallback 1: 검색어를 비우고 짧게 다시 시도한다.
  if (!image && search) {
    setInputValue(search, "");
    await delay(220);
    image = await waitFor(() => findReferenceImage(name, savedRef, refs), 5000, 120).catch(() => null);
  }

  // Fallback 2: 이름으로 좁혀서 찾는다.
  if (!image && search) {
    setInputValue(search, name);
    await delay(220);
    image = await waitFor(() => findReferenceImage(name, savedRef, refs), 5000, 120).catch(() => null);
    if (!image) {
      setInputValue(search, "");
      await delay(220);
      image = await waitFor(() => findReferenceImage(name, savedRef, refs), 5000, 120).catch(() => null);
    }
  }
  if (!image) throw new Error(`저장된 참조 이미지를 찾지 못했습니다: ${name}`);
  debugLog("attachReference:foundImage", {
    name,
    alt: image.getAttribute("alt"),
    src: image.currentSrc || image.src || "",
    pickerRows: getAssetPickerRows()?.length || 0,
    images: getAssetPickerListImages().slice(0, 12).map((img) => ({
      alt: safeText(img.getAttribute("alt") || "", 80),
      mediaName: getMediaNameFromUrl(img.currentSrc || img.src || "")
    }))
  });
  const target = findReferenceClickTarget(image);
  await selectReferenceTarget(target, name, savedRef, previousAttachmentCount);
  debugLog("attachReference:attached", {
    name,
    previousAttachmentCount,
    nextAttachmentCount: getPromptAttachmentImageCount()
  });
  await delay(120);
}

function findReferenceImage(name, savedRef, refs = {}) {
  const images = getAssetPickerListImages();
  const byName = pickBestReferenceImage(images.filter((img) => img.alt === name));
  if (byName) return byName;

  if (!savedRef) return null;
  return pickBestReferenceImage(images.filter((img) => {
    const src = img.currentSrc || img.src || "";
    const mediaName = getMediaNameFromUrl(src);
    return (
      (savedRef.mediaName && mediaName === savedRef.mediaName) ||
      (savedRef.src && src === savedRef.src) ||
      (savedRef.src && src.includes(savedRef.mediaName || "__no_match__"))
    );
  })) || pickReferenceImageBySavedOrder(name, images, refs) || null;
}

function getAssetPickerRows() {
  const search = getAssetPickerSearchInput();
  if (!search) return [];
  return [...document.querySelectorAll("[data-index], [data-item-index]")]
    .filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && row.querySelector("img");
    })
    .sort((a, b) => {
      const ai = Number(a.getAttribute("data-index") || a.getAttribute("data-item-index") || 0);
      const bi = Number(b.getAttribute("data-index") || b.getAttribute("data-item-index") || 0);
      if (ai !== bi) return ai - bi;
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      if (Math.abs(ar.top - br.top) > 8) return ar.top - br.top;
      return ar.left - br.left;
    });
}

function getAssetPickerListImages() {
  return getAssetPickerRows()
    .map((row) => row.querySelector("img[alt]") || row.querySelector("img"))
    .filter(Boolean);
}

function pickReferenceImageBySavedOrder(name, images, refs) {
  const recentRefs = Object.values(refs || {})
    .filter((ref) => ref?.id)
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const rank = recentRefs.findIndex((ref) => ref.id === name);
  if (rank < 0) return null;

  const candidates = images
    .map((img) => ({ img, rect: img.getBoundingClientRect() }))
    .filter(({ img, rect }) => img.closest("[data-index], [data-item-index]") && rect.width > 0 && rect.height > 0 && rect.width <= 160 && rect.height <= 160)
    .sort((a, b) => {
      if (Math.abs(a.rect.top - b.rect.top) > 8) return a.rect.top - b.rect.top;
      return a.rect.left - b.rect.left;
    });
  return candidates[rank]?.img || null;
}

function getAssetPickerSearchInput() {
  return document.querySelector(`input[placeholder="${K.assetSearch}"]`);
}

function getAssetPickerSurface() {
  const search = getAssetPickerSearchInput();
  if (!search) return null;
  let node = search;
  while (node && node !== document.body) {
    const text = node.textContent || "";
    const rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 &&
      (node.getAttribute("role") === "dialog" ||
        node.matches?.('[data-radix-popper-content-wrapper], [data-state="open"]') ||
        (node.querySelector?.(`input[placeholder="${K.assetSearch}"]`) && node.querySelectorAll?.("img").length))) {
      return node;
    }
    node = node.parentElement;
  }
  return search.parentElement || null;
}

function pickBestReferenceImage(images) {
  if (!images.length) return null;
  return images
    .map((img) => ({ img, rect: img.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && rect.height > 0)
    .sort((a, b) => {
      const aSmall = a.rect.width <= 120 && a.rect.height <= 120 ? 0 : 1;
      const bSmall = b.rect.width <= 120 && b.rect.height <= 120 ? 0 : 1;
      if (aSmall !== bSmall) return aSmall - bSmall;
      return (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
    })[0]?.img || images[0];
}

function findReferenceClickTarget(image) {
  const row = image.closest("[data-index], [data-item-index]");
  if (row) return row;

  let node = image;
  for (let depth = 0; node && depth < 6; depth += 1) {
    const rect = node.getBoundingClientRect();
    const isClickable = node.matches?.('button, [role="button"], [data-index], [tabindex]');
    if (isClickable && rect.width <= 420 && rect.height <= 150) return node;
    if (node !== image && rect.width <= 420 && rect.height <= 150) return node;
    node = node.parentElement;
  }
  return image;
}

async function selectReferenceTarget(target, name, savedRef, previousAttachmentCount) {
  const candidates = getReferenceSelectionCandidates(target);
  for (const candidate of candidates) {
    clickElement(candidate);
    const attached = await waitFor(() => isReferenceAttached(previousAttachmentCount), 2500, 150).catch(() => false);
    if (attached) return;
    doubleClickElement(candidate);
    const attachedByDoubleClick = await waitFor(() => isReferenceAttached(previousAttachmentCount), 2500, 150).catch(() => false);
    if (attachedByDoubleClick) return;
    if (isMediaEditView()) {
      await returnToEditor();
      throw new Error(`참조 이미지가 선택되지 않고 상세 화면으로 열렸습니다: ${name}`);
    }
  }

  pressEnterInAssetPicker();
  const attachedByEnter = await waitFor(() => isReferenceAttached(previousAttachmentCount), 2500, 150).catch(() => false);
  if (attachedByEnter) return;

  throw new Error(`참조 이미지 첨부 실패: ${name}. ${describeReferencePickerState(candidates, previousAttachmentCount)}`);
}

function getReferenceSelectionCandidates(target) {
  const candidates = [];
  const row = target.closest?.("[data-index], [data-item-index]");
  if (row) {
    candidates.push(row);
    const rowImage = row.querySelector("img");
    if (rowImage) candidates.push(rowImage);
  }
  const card = findReferenceCard(target);
  const picker = getAssetPickerSurface();
  if (card) {
    candidates.push(...[...card.querySelectorAll('button, [role="button"], [tabindex]')]
      .filter((element) =>
        (!picker || picker.contains(element)) &&
        !element.querySelector("img") &&
        !element.closest('a[href*="/edit/"]')
      ));
  }
  if (!picker || picker.contains(target)) {
    candidates.push(target);
  }
  const preview = findAssetPickerPreviewImage(target);
  if (preview) {
    candidates.push(preview);
  }
  return [...new Set(candidates)].filter(Boolean);
}

function describeReferencePickerState(candidates, previousAttachmentCount) {
  const picker = getAssetPickerSurface();
  const rows = getAssetPickerRows();
  const buttons = picker ? [...picker.querySelectorAll("button, [role='button']")].map((button) => normalize(button.textContent)).filter(Boolean) : [];
  const candidateSummary = candidates.map((element) => {
    const rect = element.getBoundingClientRect();
    return `${element.tagName.toLowerCase()}:${normalize(element.textContent).slice(0, 24)}:${Math.round(rect.width)}x${Math.round(rect.height)}`;
  }).join(" | ");
  return `pickerRows=${rows.length}, buttons=${buttons.join(",") || "-"}, attachments=${previousAttachmentCount}->${getPromptAttachmentImageCount()}, candidates=${candidateSummary || "-"}`;
}

function findAssetPickerPreviewImage(selectedTarget) {
  const picker = getAssetPickerSurface();
  if (!picker) return null;
  const selectedSrc = selectedTarget.querySelector?.("img")?.currentSrc ||
    selectedTarget.querySelector?.("img")?.src ||
    selectedTarget.currentSrc ||
    selectedTarget.src ||
    "";
  const selectedName = getMediaNameFromUrl(selectedSrc);
  const images = [...picker.querySelectorAll("img")]
    .filter((img) => !img.closest("[data-index], [data-item-index]"))
    .map((img) => ({ img, rect: img.getBoundingClientRect() }))
    .filter(({ img, rect }) => {
      if (rect.width <= 160 || rect.height <= 120) return false;
      const src = img.currentSrc || img.src || "";
      return !selectedName || getMediaNameFromUrl(src) === selectedName;
    })
    .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
  return images[0]?.img || null;
}

function pressEnterInAssetPicker() {
  const picker = getAssetPickerSurface();
  const target = picker || document;
  target.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true
  }));
}

function findReferenceCard(target) {
  let node = target;
  for (let depth = 0; node && depth < 8; depth += 1) {
    const rect = node.getBoundingClientRect();
    if (node !== target && rect.width <= 520 && rect.height <= 260 && node.querySelector?.("img")) {
      return node;
    }
    node = node.parentElement;
  }
  return target.parentElement || target;
}

function findLargestMatchingReferenceImage(name, savedRef) {
  const images = getAssetPickerListImages().filter((img) => {
    if (img.alt === name) return true;
    if (!savedRef) return false;
    const src = img.currentSrc || img.src || "";
    return savedRef.mediaName && getMediaNameFromUrl(src) === savedRef.mediaName;
  });
  return images
    .map((img) => ({ img, rect: img.getBoundingClientRect() }))
    .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0]?.img || null;
}

function isReferenceAttached(previousAttachmentCount) {
  return !isMediaEditView() && getPromptAttachmentImageCount() > previousAttachmentCount;
}

function getPromptAttachmentImageCount() {
  const promptBar = findPromptBar();
  if (!promptBar) return 0;
  return [...promptBar.querySelectorAll("img, [draggable='false'][alt]")]
    .filter((element) => !element.closest('[data-index], [data-item-index]') && !element.closest('[role="dialog"]'))
    .length;
}

function snapshotEditLinks() {
  return new Set(getEditItems().map((item) => item.href));
}

function getEditItems() {
  const seen = new Set();
  return [...document.querySelectorAll('a[href*="/edit/"]')]
    .map((link) => ({
      href: link.href,
      tile: link.closest("[data-tile-id]") || link,
      tileId: link.closest("[data-tile-id]")?.getAttribute("data-tile-id") || "",
      src: link.closest("[data-tile-id]")?.querySelector("img")?.currentSrc ||
        link.closest("[data-tile-id]")?.querySelector("img")?.src ||
        ""
    }))
    .filter((item) => {
      if (!item.href || seen.has(item.href)) return false;
      seen.add(item.href);
      return true;
    });
}

function getRecentEditItems(count) {
  return getEditItems()
    .map((item, index) => ({
      ...item,
      index,
      rect: item.tile.getBoundingClientRect()
    }))
    .filter((item) => item.rect.width > 0 && item.rect.height > 0)
    .sort((a, b) => {
      const ay = Math.round(a.rect.top / 20) * 20;
      const by = Math.round(b.rect.top / 20) * 20;
      if (ay !== by) return ay - by;
      if (a.rect.left !== b.rect.left) return a.rect.left - b.rect.left;
      return a.index - b.index;
    })
    .slice(0, count)
    .map(({ rect, index, ...item }) => item);
}

async function waitForNewMedia(before, expectedCount, timeoutMs) {
  return waitFor(() => {
    const next = getEditItems().filter((item) => !before.has(item.href));
    return next.length >= expectedCount ? next.slice(0, expectedCount) : null;
  }, timeoutMs);
}

async function waitForProjectNewMedia(before, expectedCount, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isMediaEditView()) {
      await returnToEditor();
    }
    const next = getEditItems().filter((item) => !before.has(item.href));
    if (next.length >= expectedCount) {
      return next.slice(0, expectedCount);
    }
    if (FLOW_STEPPER.debug && (Date.now() - start) % 5000 < 550) {
      debugLog("waitForProjectNewMedia:poll", {
        elapsedMs: Date.now() - start,
        expectedCount,
        got: next.length,
        editItems: dumpEditItemsSummary(6)
      });
    }
    await delay(500);
  }
  const debugTail = FLOW_STEPPER.debug
    ? ` (expected=${expectedCount}, snapshot=${JSON.stringify(dumpSettingsSnapshot())}, editItems=${JSON.stringify(dumpEditItemsSummary(6))})`
    : "";
  throw new Error(`Flow 화면 응답을 기다리다가 시간이 초과되었습니다.${debugTail}`);
}

async function saveCharacterReference(id, item, model) {
  const src = item.src || item.tile.querySelector("img")?.currentSrc || item.tile.querySelector("img")?.src || "";
  const mediaName = getMediaNameFromUrl(src);
  const refs = await loadCharacterReferences();
  const savedRef = {
    id,
    href: item.href,
    tileId: item.tileId || "",
    src,
    mediaName,
    model: model || "",
    savedAt: Date.now()
  };
  refs[id] = savedRef;
  const library = await loadCharacterLibrary();
  library[id] = savedRef;
  await chrome.storage.local.set({
    characterRefs: refs,
    characterLibrary: library
  });
  console.info("[Flow Stepper] saved reference", id, refs[id]);
}

async function saveSceneOutputs(scene, items, baseName, model) {
  const outputs = await loadSceneOutputs();
  const existingKeys = new Set(outputs.map((item) => item.key));
  const additions = items.map((item, index) => {
    const sequence = String(index + 1).padStart(2, "0");
    const filename = `${baseName}_${sequence}`;
    return {
      key: `${scene.index}:${item.href}`,
      sceneIndex: scene.index,
      sceneTotal: scene.total,
      outputIndex: index + 1,
      filename,
      href: item.href,
      tileId: item.tileId || "",
      src: item.src || "",
      mediaName: getMediaNameFromUrl(item.src || ""),
      model: model || "",
      savedAt: Date.now()
    };
  }).filter((item) => !existingKeys.has(item.key));

  const nextOutputs = outputs.concat(additions)
    .sort((a, b) => (a.sceneIndex - b.sceneIndex) || (a.outputIndex - b.outputIndex));
  await chrome.storage.local.set({ sceneOutputs: nextOutputs });
  console.info("[Flow Stepper] saved scene outputs", additions);
}

function loadSceneOutputs() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ sceneOutputs: [] }, (result) => {
      resolve(result.sceneOutputs || []);
    });
  });
}

async function runDownloadScenes() {
  const outputs = await loadSceneOutputs();
  if (!outputs.length) throw new Error("아직 저장된 장면 이미지가 없습니다.");
  await ensureProjectEditor();

  for (const output of outputs) {
    await downloadSavedSceneOutput(output);
    await returnToEditor();
  }
}

async function downloadSavedSceneOutput(output) {
  const item = findSavedSceneItem(output);
  if (!item) throw new Error(`생성된 장면 이미지를 찾지 못했습니다: ${output.filename}`);
  await downloadMedia(item, output.filename);
}

function findSavedSceneItem(output) {
  const items = getEditItems();
  return items.find((item) => item.href === output.href) ||
    items.find((item) => output.tileId && item.tileId === output.tileId) ||
    items.find((item) => output.mediaName && getMediaNameFromUrl(item.src) === output.mediaName) ||
    null;
}

async function downloadMedia(item, name) {
  item.tile.scrollIntoView({ block: "center", inline: "center" });
  await delay(150);
  const link = item.tile.querySelector('a[href*="/edit/"]') || item.tile;
  link.click();
  await waitFor(() => document.querySelector(`input[aria-label="${K.editableText}"]`), 30000);

  try {
    await downloadOriginal(name);
  } catch (error) {
    console.warn("[Flow Stepper] Download skipped:", error);
  }
}

function loadCharacterReferences() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ characterRefs: {} }, (result) => {
      resolve(result.characterRefs || {});
    });
  });
}

function loadCharacterLibrary() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ characterLibrary: {} }, (result) => {
      resolve(result.characterLibrary || {});
    });
  });
}

function getMediaNameFromUrl(src) {
  if (!src) return "";
  try {
    const url = new URL(src, location.href);
    return url.searchParams.get("name") || "";
  } catch (error) {
    const match = src.match(/[?&]name=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }
}

async function downloadOriginal(name) {
  const download = findButton((button) => button.textContent.includes(K.download));
  if (!download) throw new Error("다운로드 버튼을 찾지 못했습니다.");
  clickElement(download);
  const oneK = await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')]
    .find((item) => item.textContent.includes("1K") && item.textContent.includes(K.originalSize)), 6000);
  await chrome.runtime.sendMessage({ type: "prepareDownloadName", filename: name });
  clickElement(oneK);
  await delay(1200);
}

async function returnToEditor() {
  const done = findButton((button) => button.textContent.includes(K.done));
  if (done) {
    clickElement(done);
    await waitFor(() => !isMediaEditView() && findPromptEditor(), 20000).catch(() => null);
    await delay(800);
    if (!isMediaEditView()) return;
  }

  const back = findButton((button) => button.textContent.includes(K.back));
  if (back) {
    clickElement(back);
    await waitFor(() => !isMediaEditView() && findPromptEditor(), 20000).catch(() => null);
    await delay(800);
    if (!isMediaEditView()) return;
  }

  throw new Error("Flow 편집 화면에서 프로젝트 입력 화면으로 돌아가지 못했습니다. 상단의 완료 버튼을 눌러 다시 시도해주세요.");
}

function isMediaEditView() {
  if (location.href.includes("/edit/")) return true;
  const hasDownload = Boolean(findButton((button) => button.textContent.includes(K.download)));
  const hasDone = Boolean(findButton((button) => button.textContent.includes(K.done)));
  const hasEditableText = Boolean(document.querySelector(`input[aria-label="${K.editableText}"]`));
  return hasDone && (hasDownload || hasEditableText);
}

function findPromptEditor() {
  return document.querySelector('[role="textbox"][contenteditable="true"][data-slate-editor="true"]');
}

function findButton(predicate) {
  return [...document.querySelectorAll("button")].find(predicate);
}

function setInputValue(input, value) {
  input.focus();
  input.select?.();
  const previousValue = input.value;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }

  const tracker = input._valueTracker;
  if (tracker) {
    tracker.setValue(previousValue);
  }

  input.setAttribute("value", value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  if (input.value !== value) {
    input.focus();
    input.select?.();
    document.execCommand("insertText", false, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function buildSceneBaseName(scene) {
  const index = String(scene.index).padStart(3, "0");
  const chapter = scene.chapter ? `Ch${String(scene.chapter).padStart(2, "0")}` : "Ch00";
  const refs = scene.references.length ? scene.references.join("_") : "no-ref";
  return sanitizeFileName(`${index}_${chapter}_${refs}`);
}

function sanitizeFileName(value) {
  return value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
}

function normalize(value) {
  return (value || "").replace(/\s+/g, "");
}

function delay(ms = FLOW_STEPPER.delayMs) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 30000, intervalMs = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = fn();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error("Flow 화면 응답을 기다리다가 시간이 초과되었습니다.");
}
