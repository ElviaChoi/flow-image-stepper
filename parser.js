(function attachParser(global) {
  const CHARACTER_ID_RE = /(?:Character\s*ID\s*:\s*|\uCE90\uB9AD\uD130\s*\uC2DC\uD2B8\s*[\u2014\u2013\-:：]?\s*)([A-Za-z0-9_\-\u3131-\uD79D]+_CS-\d{2})/g;
  const SCENE_HEADER_RE = /(?:Image|이미지)\s*(\d+)\s*\/\s*(\d+)/gi;
  const SCENE_HEADER_SINGLE_RE = /(?:Image|이미지)\s*(\d+)\s*\/\s*(\d+)/i;
  const CODE_BLOCK_RE = /```[^\r\n]*(?:\r?\n)?([\s\S]*?)```/;
  const CODE_BLOCK_GLOBAL_RE = /```[^\r\n]*(?:\r?\n)?([\s\S]*?)```/g;
  const REFERENCE_ID_RE = /[^\s,()]+_CS-\d{2}/g;

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
      return { id, prompt: getFirstCodeBlock(body), status: "pending" };
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
        prompt: getFirstCodeBlock(body),
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

  function parseSimpleScenes(source) {
    const prompts = normalizePrompt(source)
      .split(/\n\s*\n+/)
      .map((value) => normalizePrompt(value))
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
    if (characters.length || referencedScenes.length) {
      return {
        mode: "structured",
        characters,
        scenes: referencedScenes
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
