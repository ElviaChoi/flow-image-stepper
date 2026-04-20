(function attachParser(global) {
  const CHARACTER_ID_RE = /Character ID:\s*([^\s`]+_CS-\d{2})/g;
  const SCENE_HEADER_RE = /Image\s+(\d+)\s*\/\s*(\d+)/g;
  const CODE_BLOCK_RE = /```(?:[a-zA-Z]*)?\s*([\s\S]*?)```/;
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
    const match = /Image\s+\d+\s*\/\s*\d+/.exec(source);
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

  function parseScenes(source) {
    const matches = [...source.matchAll(SCENE_HEADER_RE)];
    return matches.map((match, index) => {
      const start = match.index + match[0].length;
      const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
      const body = source.slice(start, end);
      const placement = getLineValue(body, "\ubc30\uce58");
      const castLine = getLineValue(body, "\ub4f1\uc7a5\uc778\ubb3c");
      const references = castLine.includes("\uc5c6\uc74c")
        ? []
        : [...new Set(castLine.match(REFERENCE_ID_RE) || [])];
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

  function parseFlowPrompt(source) {
    const text = source.replace(/\r\n/g, "\n");
    return {
      characters: parseCharacters(text).filter((item) => item.prompt),
      scenes: parseScenes(text).filter((item) => item.prompt)
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
