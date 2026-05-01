(function attachParser(global) {
  const CHARACTER_ID_RE = /(?:Character\s*ID\s*:\s*|\uCE90\uB9AD\uD130\s*\uC2DC\uD2B8\s*[\u2014\u2013\-:：]?\s*)([A-Za-z0-9_\-\u3131-\uD79D]+_CS-\d{2})/g;
  const SCENE_HEADER_RE = /(?:Image|이미지)\s*(\d+)\s*\/\s*(\d+)/gi;
  const SCENE_HEADER_SINGLE_RE = /(?:Image|이미지)\s*(\d+)\s*\/\s*(\d+)/i;
  const CODE_BLOCK_RE = /```[^\r\n]*(?:\r?\n)?([\s\S]*?)```/;
  const CODE_BLOCK_GLOBAL_RE = /```[^\r\n]*(?:\r?\n)?([\s\S]*?)```/g;
  const REFERENCE_ID_RE = /[^\s,()]+_CS-\d{2}/g;
  const FRIENDLY_CHARACTER_HEADING_RE = /^\s*(?:#{1,4}\s*)?(?:캐릭터|등장인물|인물|Characters?|Cast)\s*[:：]?\s*$/i;
  const FRIENDLY_SCENE_HEADING_RE = /^\s*(?:#{1,4}\s*)?(?:장면|씬|스토리|이미지|Scenes?|Story|Images?)\s*[:：]?\s*$/i;
  const FRIENDLY_CAST_LINE_RE = /^\s*(?:[^\w\u3131-\uD79D]*\s*)?(?:등장인물|출연|캐릭터|인물|Cast|Characters?)\s*[:：]\s*(.+)$/i;
  const FRIENDLY_PLACEMENT_LINE_RE = /^\s*(?:[^\w\u3131-\uD79D]*\s*)?(?:배치|위치|장소|Placement|Location)\s*[:：]\s*(.+)$/i;
  const PROMPT_LABEL_RE = /^\s*(?:프롬프트|Prompt|Image\s*Prompt|Scene\s*Prompt|Character\s*Prompt)\s*[:：]?\s*(.*)$/i;
  const META_LINE_RE = /^\s*(?:[^\w\u3131-\uD79D]*\s*)?(?:캐릭터\s*ID|Character\s*ID|ID|이름|Name|등장인물|출연|Cast|Characters?|배치|위치|장소|Placement|Location)\s*[:：]/i;
  const PROMPT_NOISE_LINE_RE = /^\s*(?:Plaintext|Text|Prompt|프롬프트|🖼️|🖼|```+)\s*$/i;
  const PROMPT_PACK_CHARACTER_RE = /^\s*(?:캐릭터\s*시트(?:\s*프롬프트)?|캐릭터\s*프롬프트|Character\s*(?:Sheet\s*Prompt|Sheet|Prompt))/i;
  const PROMPT_PACK_SCENE_RE = /^\s*(?:장면\s*(?:이미지\s*)?프롬프트|이미지\s*프롬프트|Scene\s*(?:Image\s*)?Prompt|Image\s*Prompt|(?:장면|씬|Scene|Image|이미지)\s*\d+)/i;

  function normalizePrompt(text) {
    return text
      .replace(/^Copy/gm, "")
      .replace(/\r\n/g, "\n")
      .trim();
  }

  function getFirstCodeBlock(text) {
    const match = text.match(CODE_BLOCK_RE);
    return normalizePrompt(match ? match[1] : text);
  }

  function getPromptText(text) {
    const match = text.match(CODE_BLOCK_RE);
    if (match) return normalizePrompt(match[1]);
    const lines = [];
    let sawPromptLabel = false;
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      const promptMatch = line.match(PROMPT_LABEL_RE);
      if (promptMatch) {
        sawPromptLabel = true;
        if (promptMatch[1]) lines.push(promptMatch[1]);
        continue;
      }
      if (META_LINE_RE.test(line)) continue;
      if (PROMPT_NOISE_LINE_RE.test(line)) continue;
      if (sawPromptLabel && !line) {
        lines.push("");
        continue;
      }
      lines.push(rawLine);
    }
    return normalizePrompt(lines.join("\n"));
  }

  function firstSceneIndex(source) {
    const match = /(?:Image|이미지)\s*\d+\s*\/\s*\d+/i.exec(source);
    return match ? match.index : source.length;
  }

  function parseCharacters(source) {
    const characterZone = source.slice(0, firstSceneIndex(source));
    const matches = [...characterZone.matchAll(CHARACTER_ID_RE)];
    return matches.map((match, index) => {
      const id = match[1].trim();
      const start = match.index + match[0].length;
      const end = index + 1 < matches.length ? matches[index + 1].index : characterZone.length;
      const body = characterZone.slice(start, end);
      return { id, prompt: getPromptText(body), status: "pending" };
    });
  }

  function getLineValue(body, keyword) {
    const line = body
      .split("\n")
      .map((value) => value.trim())
      .find((value) => value.includes(keyword));
    if (!line) return "";
    const colon = line.indexOf(":");
    return colon >= 0 ? line.slice(colon + 1).trim() : line;
  }

  function getReferencesFromText(text) {
    if ((text || "").includes("\uc5c6\uc74c")) return [];
    return [...new Set((text || "").match(REFERENCE_ID_RE) || [])];
  }

  function getHeaderLine(line) {
    return line
      .replace(/^\s*#{1,4}\s*/, "")
      .replace(/^\s*[-*]\s+/, "")
      .replace(/^\s*\*+|\*+\s*$/g, "")
      .replace(/^\s*\[|\]\s*$/g, "")
      .trim();
  }

  function getInlineId(text) {
    return (text.match(REFERENCE_ID_RE) || [])[0] || "";
  }

  function getLineField(body, labels) {
    const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const re = new RegExp(`^\\s*(?:[^\\w\\u3131-\\uD79D]*\\s*)?(?:${labelPattern})\\s*[:：]\\s*(.+)$`, "im");
    const match = body.match(re);
    return match ? normalizePrompt(match[1]) : "";
  }

  function makeCharacterId(name, index) {
    return normalizeFriendlyCharacterId(name || `Character ${index + 1}`, index);
  }

  function getNameFromHeader(header) {
    const cleaned = header
      .replace(PROMPT_PACK_CHARACTER_RE, "")
      .replace(REFERENCE_ID_RE, "")
      .replace(/^[\s:：|—–-]+|[\s:：|—–-]+$/g, "");
    return normalizePrompt(cleaned);
  }

  function parsePromptPackHeader(line) {
    const header = getHeaderLine(line);
    if (!header) return null;
    if (PROMPT_PACK_CHARACTER_RE.test(header)) {
      return { kind: "character", header };
    }
    if (PROMPT_PACK_SCENE_RE.test(header)) {
      const match = header.match(/(\d+)(?:\s*\/\s*(\d+))?/);
      return {
        kind: "scene",
        header,
        index: match ? Number(match[1]) : 0,
        total: match?.[2] ? Number(match[2]) : 0
      };
    }
    return null;
  }

  function splitPromptPackBlocks(source) {
    const blocks = [];
    let current = null;
    for (const line of source.split("\n")) {
      const header = parsePromptPackHeader(line);
      if (header) {
        if (current) blocks.push(current);
        current = { ...header, lines: [] };
        continue;
      }
      if (current) current.lines.push(line);
    }
    if (current) blocks.push(current);
    return blocks;
  }

  function parsePromptPack(source) {
    const blocks = splitPromptPackBlocks(source);
    if (!blocks.length) return null;
    const characters = [];
    const sceneBlocks = [];
    for (const block of blocks) {
      const body = block.lines.join("\n");
      if (block.kind === "character") {
        const inlineId = getInlineId(block.header) || getInlineId(body);
        const name = getLineField(body, ["이름", "Name"]) || getNameFromHeader(block.header) || inlineId.replace(/_CS-\d{2}$/i, "");
        const id = inlineId || makeCharacterId(name, characters.length);
        const prompt = getPromptText(body);
        if (prompt) characters.push({ id, name, prompt, status: "pending" });
        continue;
      }
      sceneBlocks.push(block);
    }
    const scenes = sceneBlocks.map((block, index) => {
      const body = block.lines.join("\n");
      const castLine = getLineField(body, ["등장인물", "출연", "캐릭터", "인물", "Cast", "Characters"]);
      const placement = getLineField(body, ["배치", "위치", "장소", "Placement", "Location"]);
      const references = findFriendlyReferences(body, castLine, characters);
      return {
        index: block.index || index + 1,
        total: block.total || sceneBlocks.length,
        placement,
        castLine: castLine || (references.length ? references.join(", ") : "참조 없음"),
        references,
        chapter: (placement.match(/Chapter\s+(\d+)/i) || [null, ""])[1],
        prompt: getPromptText(body),
        status: "pending"
      };
    }).filter((scene) => scene.prompt);
    if (!characters.length && !scenes.length) return null;
    return {
      mode: "prompt-pack",
      characters,
      scenes
    };
  }

  function stripListMarker(line) {
    return line
      .replace(/^\s*[-*]\s+/, "")
      .replace(/^\s*\d+\s*[\).]\s+/, "")
      .trim();
  }

  function splitFriendlySections(source) {
    const sections = [];
    let current = { kind: "body", lines: [] };
    for (const rawLine of source.split("\n")) {
      const line = rawLine.trim();
      if (FRIENDLY_CHARACTER_HEADING_RE.test(line)) {
        sections.push(current);
        current = { kind: "characters", lines: [] };
        continue;
      }
      if (FRIENDLY_SCENE_HEADING_RE.test(line)) {
        sections.push(current);
        current = { kind: "scenes", lines: [] };
        continue;
      }
      current.lines.push(rawLine);
    }
    sections.push(current);
    return sections.filter((section) => section.lines.some((line) => line.trim()));
  }

  function slugCharacterName(name) {
    const slug = normalizePrompt(name)
      .replace(/_CS-\d{2}$/i, "")
      .replace(/[^\w\u3131-\uD79D-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return slug || "Character";
  }

  function normalizeFriendlyCharacterId(name, index) {
    const cleanName = normalizePrompt(name);
    if (/_CS-\d{2}$/i.test(cleanName)) return cleanName;
    return `${slugCharacterName(cleanName)}_CS-${String(index + 1).padStart(2, "0")}`;
  }

  function parseFriendlyCharacterLine(line) {
    const clean = stripListMarker(line);
    if (!clean || FRIENDLY_CHARACTER_HEADING_RE.test(clean) || FRIENDLY_SCENE_HEADING_RE.test(clean)) return null;
    const match = clean.match(/^(.{1,40}?)(?:\s*[:：=|]\s*|\s+[—–-]\s+)(.+)$/);
    if (!match) return null;
    const name = normalizePrompt(match[1]);
    const description = normalizePrompt(match[2]);
    if (!name || !description) return null;
    return { name, description };
  }

  function buildCharacterPrompt(name, description) {
    return [
      `Create a consistent character reference sheet for ${name}.`,
      "",
      `Character details: ${description}`,
      "",
      "Show the same character clearly in a clean reference sheet with front-facing portrait, half-body view, and full-body view.",
      "Keep facial features, hairstyle, age, body type, outfit, and color palette consistent.",
      "Use a simple neutral background. Do not include other characters."
    ].join("\n");
  }

  function parseFriendlyCharacters(sections) {
    const characterSection = sections.find((section) => section.kind === "characters");
    if (!characterSection) return [];
    const entries = [];
    let current = null;
    for (const line of characterSection.lines) {
      const parsedLine = parseFriendlyCharacterLine(line);
      if (parsedLine) {
        if (current) entries.push(current);
        current = parsedLine;
        continue;
      }
      if (current && line.trim()) {
        current.description = `${current.description}\n${stripListMarker(line)}`;
      }
    }
    if (current) entries.push(current);
    return entries.map((entry, index) => {
      const id = normalizeFriendlyCharacterId(entry.name, index);
      return {
        id,
        name: entry.name,
        prompt: buildCharacterPrompt(entry.name, entry.description),
        status: "pending"
      };
    });
  }

  function parseFriendlySceneHeader(line) {
    const clean = line.replace(/^\s*[-*]\s+/, "").trim();
    const match = clean.match(/^(?:(?:장면|씬|Scene|Image|이미지)\s*)?(\d+)(?:\s*\/\s*(\d+))?\s*(?:[.)\]:：-]\s*)?(.*)$/i);
    if (!match) return null;
    if (!/^(?:장면|씬|Scene|Image|이미지|\d)/i.test(clean)) return null;
    return {
      index: Number(match[1]),
      total: match[2] ? Number(match[2]) : 0,
      text: normalizePrompt(match[3] || "")
    };
  }

  function splitFriendlySceneEntries(lines) {
    const entries = [];
    let current = null;
    for (const line of lines) {
      const header = parseFriendlySceneHeader(line);
      if (header) {
        if (current) entries.push(current);
        current = { index: header.index, total: header.total, lines: header.text ? [header.text] : [] };
        continue;
      }
      if (current) current.lines.push(line);
    }
    if (current) entries.push(current);
    if (entries.length) return entries;

    return normalizePrompt(lines.join("\n"))
      .split(/\n\s*\n+/)
      .map((value, index) => ({ index: index + 1, total: 0, lines: [value] }))
      .filter((entry) => normalizePrompt(entry.lines.join("\n")));
  }

  function findFriendlyReferences(text, castText, characters) {
    const refs = new Set(getReferencesFromText(`${castText || ""}\n${text || ""}`));
    const haystack = `${castText || ""}\n${text || ""}`;
    for (const character of characters) {
      const name = character.name || character.id.replace(/_CS-\d{2}$/i, "");
      if (name && haystack.includes(name)) refs.add(character.id);
    }
    return [...refs];
  }

  function buildScenePrompt(text, references, characterNames) {
    const lines = [normalizePrompt(text)];
    if (references.length) {
      lines.push("");
      lines.push(`Use the uploaded character reference images for: ${characterNames.join(", ")}.`);
      lines.push("Maintain each referenced character's face, hairstyle, outfit, age, body type, and overall visual identity consistently.");
    }
    lines.push("");
    lines.push("Create a cinematic, coherent scene image with clear composition, natural lighting, and no extra duplicated characters.");
    return lines.join("\n").trim();
  }

  function parseFriendlyScenes(sections, characters) {
    const sceneSection = sections.find((section) => section.kind === "scenes");
    if (!sceneSection) return [];
    const entries = splitFriendlySceneEntries(sceneSection.lines);
    const total = entries.length;
    return entries.map((entry, index) => {
      const promptLines = [];
      let castLine = "";
      let placement = "";
      for (const line of entry.lines) {
        const castMatch = line.match(FRIENDLY_CAST_LINE_RE);
        const placementMatch = line.match(FRIENDLY_PLACEMENT_LINE_RE);
        if (castMatch) {
          castLine = normalizePrompt(castMatch[1]);
          continue;
        }
        if (placementMatch) {
          placement = normalizePrompt(placementMatch[1]);
          continue;
        }
        promptLines.push(line);
      }
      const rawPrompt = normalizePrompt(promptLines.join("\n"));
      const references = findFriendlyReferences(rawPrompt, castLine, characters);
      const characterNames = references.map((id) => {
        const character = characters.find((item) => item.id === id);
        return character?.name || id;
      });
      return {
        index: entry.index || index + 1,
        total: entry.total || total,
        placement,
        castLine: castLine || (references.length ? references.join(", ") : "참조 없음"),
        references,
        chapter: "",
        prompt: buildScenePrompt(rawPrompt, references, characterNames),
        status: "pending"
      };
    }).filter((scene) => scene.prompt);
  }

  function parseFriendlyStory(source) {
    const sections = splitFriendlySections(source);
    const characters = parseFriendlyCharacters(sections);
    const scenes = parseFriendlyScenes(sections, characters);
    if (!characters.length && !scenes.length) return null;
    return {
      mode: "friendly-story",
      characters,
      scenes
    };
  }

  function parseScenes(source) {
    const matches = [...source.matchAll(SCENE_HEADER_RE)];
    return matches.map((match, index) => {
      const start = match.index + match[0].length;
      const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
      const body = source.slice(start, end);
      const placement = getLineValue(body, "\ubc30\uce58");
      const castLine = getLineValue(body, "\ub4f1\uc7a5\uc778\ubb3c");
      const references = getReferencesFromText(castLine);
      const chapter = (placement.match(/Chapter\s+(\d+)/i) || [null, ""])[1];
      return {
        index: Number(match[1]),
        total: Number(match[2]),
        placement,
        castLine,
        references,
        chapter,
        prompt: getPromptText(body),
        status: "pending"
      };
    });
  }

  function getCodeBlocks(source) {
    return [...source.matchAll(CODE_BLOCK_GLOBAL_RE)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      prompt: normalizePrompt(match[1])
    }));
  }

  function parseReferencedScenes(source) {
    const blocks = getCodeBlocks(source);
    const scenes = [];
    for (const [blockIndex, block] of blocks.entries()) {
      const previousEnd = blockIndex > 0 ? blocks[blockIndex - 1].end : 0;
      const meta = source.slice(previousEnd, block.start);
      const placement = getLineValue(meta, "\ubc30\uce58");
      const castLine = getLineValue(meta, "\ub4f1\uc7a5\uc778\ubb3c");
      if (!castLine) continue;
      const references = getReferencesFromText(castLine);

      const header = meta.match(SCENE_HEADER_SINGLE_RE);
      const chapter = (placement.match(/Chapter\s+(\d+)/i) || [null, ""])[1];
      scenes.push({
        index: header ? Number(header[1]) : scenes.length + 1,
        total: header ? Number(header[2]) : blocks.length,
        placement,
        castLine,
        references,
        chapter,
        prompt: block.prompt,
        status: "pending"
      });
    }
    return scenes;
  }

  function parseLooseReferencedScenes(source) {
    const blocks = [];
    let current = null;
    for (const rawLine of source.split("\n")) {
      const line = rawLine.trim();
      const startsScene = FRIENDLY_PLACEMENT_LINE_RE.test(line);
      const hasCast = FRIENDLY_CAST_LINE_RE.test(line);

      if (startsScene && current && getPromptText(current.lines.join("\n"))) {
        blocks.push(current);
        current = null;
      }
      if (startsScene || hasCast || current) {
        if (!current) current = { lines: [] };
        current.lines.push(rawLine);
      }
    }
    if (current) blocks.push(current);

    const scenes = blocks.map((block, index) => {
      const body = block.lines.join("\n");
      const placement = getLineField(body, ["배치", "위치", "장소", "Placement", "Location"]);
      const castLine = getLineField(body, ["등장인물", "출연", "캐릭터", "인물", "Cast", "Characters"]);
      const prompt = getPromptText(body);
      const references = getReferencesFromText(castLine);
      return {
        index: index + 1,
        total: blocks.length,
        placement,
        castLine: castLine || (references.length ? references.join(", ") : "참조 없음"),
        references,
        chapter: (placement.match(/Chapter\s+(\d+)/i) || [null, ""])[1],
        prompt,
        status: "pending"
      };
    }).filter((scene) => scene.prompt && (scene.placement || scene.references.length));

    return scenes.map((scene) => ({ ...scene, total: scenes.length }));
  }

  function parseSimpleScenes(source) {
    const prompts = normalizePrompt(source)
      .split(/\n\s*\n+/)
      .map((value) => getPromptText(value))
      .filter(Boolean);
    const total = prompts.length;
    return prompts.map((prompt, index) => ({
      index: index + 1,
      total,
      placement: "",
      castLine: "참조 없음",
      references: [],
      chapter: "",
      prompt,
      status: "pending"
    }));
  }

  function parseFlowPrompt(source) {
    const text = source.replace(/\r\n/g, "\n");
    const characters = parseCharacters(text).filter((item) => item.prompt);
    const scenes = parseScenes(text).filter((item) => item.prompt);
    const referencedScenes = scenes.length ? scenes : parseReferencedScenes(text).filter((item) => item.prompt);
    if (referencedScenes.length) {
      return {
        mode: "structured",
        characters,
        scenes: referencedScenes
      };
    }
    const promptPack = parsePromptPack(text);
    if (promptPack) return promptPack;
    if (characters.length) {
      return {
        mode: "structured",
        characters,
        scenes: []
      };
    }
    const friendly = parseFriendlyStory(text);
    if (friendly) return friendly;
    const looseReferencedScenes = parseLooseReferencedScenes(text);
    if (looseReferencedScenes.length) {
      return {
        mode: "structured",
        characters: [],
        scenes: looseReferencedScenes
      };
    }
    return {
      mode: "simple-scenes",
      characters: [],
      scenes: parseSimpleScenes(text)
    };
  }

  function summarize(parsed) {
    const lines = [];
    lines.push(`Character sheets: ${parsed.characters.length}`);
    parsed.characters.forEach((item) => lines.push(`- ${item.id}`));
    lines.push("");
    lines.push(`Scenes: ${parsed.scenes.length}`);
    parsed.scenes.forEach((item) => {
      const refs = item.references.length ? item.references.join(", ") : "no references";
      const chapter = item.chapter ? `Ch.${item.chapter}` : "Chapter unknown";
      lines.push(`- ${String(item.index).padStart(3, "0")} / ${chapter} / ${refs}`);
    });
    return lines.join("\n").trim();
  }

  global.FlowPromptParser = {
    parse: parseFlowPrompt,
    summarize
  };
})(globalThis);
