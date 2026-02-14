export function normalizeUrl(url) {
  const hasProtocol = /^https?:\/\//i.test(url);
  const complete = hasProtocol ? url : `https://${url}`;
  return new URL(complete).toString();
}

export async function fetchSongPageText(sourceUrl, fetchImpl = fetch) {
  const withoutProtocol = sourceUrl.replace(/^https?:\/\//i, "");
  const proxyUrl = `https://r.jina.ai/http://${withoutProtocol}`;

  const response = await fetchImpl(proxyUrl, {
    method: "GET",
    headers: {
      Accept: "text/plain",
    },
  });

  if (!response.ok) {
    throw new Error("Ошибка загрузки страницы через прокси.");
  }

  return response.text();
}

export function parseAmdmText(raw) {
  const lines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/^L\d+:\s?/, "").replace(/\s+$/g, ""));

  const { artist, title } = extractArtistAndTitle(lines);
  const startIndex = findStartIndex(lines);
  const endIndex = findEndIndex(lines, startIndex);

  const bodyLines = lines.slice(startIndex, endIndex);
  const bodyText = bodyLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  return { artist, title, bodyText };
}

export function toCho({ title, artist, bodyText }, options = {}) {
  const { preserveChordRows = false, simpleChordDistribution = false } = options;
  const lines = bodyText.split("\n");
  const out = [];

  if (title) {
    out.push(`{title: ${title}}`);
  }
  if (artist) {
    out.push(`{artist: ${artist}}`);
  }
  out.push("");

  let pendingChordLines = [];
  let currentSectionName = "";
  let carriedChordLines = null;
  let carriedTailChords = null;
  let sectionFirstChord = "";
  let sectionLineCount = 0;

  for (const rawLine of lines) {
    let line = rawLine;
    if (simpleChordDistribution) {
      const tailCarry = extractTrailingCarryChords(line);
      if (tailCarry) {
        line = tailCarry.line;
        carriedTailChords = tailCarry.chords;
      }
    }

    const trimmed = line.trim();

    if (!trimmed) {
      if (pendingChordLines.length) {
        // Some sources (amdm via text proxy) place an empty line between
        // chord and lyric lines. Keep pending chords for the next lyric.
        continue;
      }
      out.push("");
      continue;
    }

    if (/^\[[^\]]+\]:?$/.test(trimmed)) {
      if (pendingChordLines.length) {
        if (simpleChordDistribution) {
          carriedChordLines = pendingChordLines.slice();
        } else {
          out.push(buildChordOnlyLine(pendingChordLines));
        }
      }
      pendingChordLines = [];
      const section = trimmed.replace(/[\[\]:]/g, "").trim();
      currentSectionName = section;
      sectionFirstChord = "";
      sectionLineCount = 0;
      out.push(`{c: ${section}}`);
      continue;
    }

    const sectionCue = parseSectionCueLine(line);
    if (sectionCue) {
      if (pendingChordLines.length) {
        if (simpleChordDistribution) {
          carriedChordLines = pendingChordLines.slice();
        } else {
          out.push(buildChordOnlyLine(pendingChordLines));
        }
      }
      pendingChordLines = [];
      currentSectionName = sectionCue.section;
      sectionFirstChord = "";
      sectionLineCount = 0;
      out.push(`{c: ${sectionCue.section}}`);
      if (sectionCue.tail) {
        const sectionTailWithCarry =
          carriedTailChords?.length && simpleChordDistribution
            ? mergeSimpleChordSequenceWithLyricsDistributed(carriedTailChords, sectionCue.tail)
            : sectionCue.tail;
        carriedTailChords = null;
        if (carriedChordLines?.length) {
          const mergedSectionTail = mergeChordLinesWithLyric(carriedChordLines, sectionTailWithCarry);
          const nextSection = maybeAutoSwitchFromChorus(
            mergedSectionTail,
            simpleChordDistribution,
            currentSectionName,
            sectionFirstChord,
            sectionLineCount,
          );
          if (nextSection.switchToVerse) {
            out.push("{c: Куплет}");
            currentSectionName = "Куплет";
            sectionFirstChord = "";
            sectionLineCount = 0;
          }
          out.push(mergedSectionTail);
          if (nextSection.firstChord) {
            if (!sectionFirstChord) {
              sectionFirstChord = nextSection.firstChord;
            }
            sectionLineCount += 1;
          }
          carriedChordLines = null;
        } else {
          out.push(convertChordProgressionToInline(sectionTailWithCarry));
        }
      }
      continue;
    }

    if (isChordLine(trimmed)) {
      pendingChordLines.push(rawLine);
      continue;
    }

    if (carriedChordLines?.length) {
      if (line.includes("[")) {
        const nextSection = maybeAutoSwitchFromChorus(
          line,
          simpleChordDistribution,
          currentSectionName,
          sectionFirstChord,
          sectionLineCount,
        );
        if (nextSection.switchToVerse) {
          out.push("{c: Куплет}");
          currentSectionName = "Куплет";
          sectionFirstChord = "";
          sectionLineCount = 0;
        }
        out.push(line);
        if (nextSection.firstChord) {
          if (!sectionFirstChord) {
            sectionFirstChord = nextSection.firstChord;
          }
          sectionLineCount += 1;
        }
        carriedChordLines = null;
        continue;
      }
      const mergedCarried = cleanupMergedLyricArtifacts(mergeChordLinesWithLyric(carriedChordLines, line));
      const nextSection = maybeAutoSwitchFromChorus(
        mergedCarried,
        simpleChordDistribution,
        currentSectionName,
        sectionFirstChord,
        sectionLineCount,
      );
      if (nextSection.switchToVerse) {
        out.push("{c: Куплет}");
        currentSectionName = "Куплет";
        sectionFirstChord = "";
        sectionLineCount = 0;
      }
      out.push(mergedCarried);
      if (nextSection.firstChord) {
        if (!sectionFirstChord) {
          sectionFirstChord = nextSection.firstChord;
        }
        sectionLineCount += 1;
      }
      carriedChordLines = null;
      continue;
    }

    if (isTablatureOrStringLine(line)) {
      if (pendingChordLines.length) {
        out.push(buildChordOnlyLine(pendingChordLines));
        pendingChordLines = [];
      }

      if (!isInstrumentalSectionName(currentSectionName)) {
        out.push("{c: Проигрыш}");
        currentSectionName = "Проигрыш";
      }

      out.push(line);
      continue;
    }

    if (isInstrumentalSectionName(currentSectionName) && isLikelyChordProgressionLine(line)) {
      out.push(convertChordProgressionToInline(line));
      continue;
    }

    if (pendingChordLines.length) {
      if (isTablatureOrStringLine(line)) {
        out.push(buildChordOnlyLine(pendingChordLines));
        out.push(line);
        pendingChordLines = [];
        continue;
      }

      if (line.includes("[")) {
        const nextSection = maybeAutoSwitchFromChorus(
          line,
          simpleChordDistribution,
          currentSectionName,
          sectionFirstChord,
          sectionLineCount,
        );
        if (nextSection.switchToVerse) {
          out.push("{c: Куплет}");
          currentSectionName = "Куплет";
          sectionFirstChord = "";
          sectionLineCount = 0;
        }
        out.push(line);
        if (nextSection.firstChord) {
          if (!sectionFirstChord) {
            sectionFirstChord = nextSection.firstChord;
          }
          sectionLineCount += 1;
        }
        pendingChordLines = [];
        continue;
      }

      if (preserveChordRows) {
        out.push(buildChordOnlyLine(pendingChordLines));
        out.push(line);
        pendingChordLines = [];
        continue;
      }

      const singleTokenLines = pendingChordLines
        .map((line) => extractChordTokens(line))
        .filter((tokens) => tokens.length === 1)
        .map((tokens) => tokens[0]);

      if (singleTokenLines.length === pendingChordLines.length) {
        const mergedSingle = cleanupMergedLyricArtifacts(
          simpleChordDistribution
            ? mergeSimpleChordSequenceWithLyricsDistributed(singleTokenLines, line)
            : mergeSimpleChordSequenceWithLyrics(singleTokenLines, line),
        );
        const nextSection = maybeAutoSwitchFromChorus(
          mergedSingle,
          simpleChordDistribution,
          currentSectionName,
          sectionFirstChord,
          sectionLineCount,
        );
        if (nextSection.switchToVerse) {
          out.push("{c: Куплет}");
          currentSectionName = "Куплет";
          sectionFirstChord = "";
          sectionLineCount = 0;
        }
        out.push(mergedSingle);
        if (nextSection.firstChord) {
          if (!sectionFirstChord) {
            sectionFirstChord = nextSection.firstChord;
          }
          sectionLineCount += 1;
        }
      } else if (simpleChordDistribution && pendingChordLines.length === 1) {
        const spreadTokens = extractChordTokens(pendingChordLines[0]);
        const mergedSpread = cleanupMergedLyricArtifacts(mergeSimpleChordSequenceWithLyricsDistributed(spreadTokens, line));
        const nextSection = maybeAutoSwitchFromChorus(
          mergedSpread,
          simpleChordDistribution,
          currentSectionName,
          sectionFirstChord,
          sectionLineCount,
        );
        if (nextSection.switchToVerse) {
          out.push("{c: Куплет}");
          currentSectionName = "Куплет";
          sectionFirstChord = "";
          sectionLineCount = 0;
        }
        out.push(mergedSpread);
        if (nextSection.firstChord) {
          if (!sectionFirstChord) {
            sectionFirstChord = nextSection.firstChord;
          }
          sectionLineCount += 1;
        }
      } else {
        const mergedChordLine = combineChordLines(pendingChordLines);
        const mergedComplex = cleanupMergedLyricArtifacts(mergeChordLineWithLyrics(mergedChordLine, line));
        const nextSection = maybeAutoSwitchFromChorus(
          mergedComplex,
          simpleChordDistribution,
          currentSectionName,
          sectionFirstChord,
          sectionLineCount,
        );
        if (nextSection.switchToVerse) {
          out.push("{c: Куплет}");
          currentSectionName = "Куплет";
          sectionFirstChord = "";
          sectionLineCount = 0;
        }
        out.push(mergedComplex);
        if (nextSection.firstChord) {
          if (!sectionFirstChord) {
            sectionFirstChord = nextSection.firstChord;
          }
          sectionLineCount += 1;
        }
      }
      pendingChordLines = [];
      continue;
    }

    if (simpleChordDistribution && carriedTailChords?.length && !line.includes("[")) {
      const mergedTail = cleanupMergedLyricArtifacts(mergeSimpleChordSequenceWithLyricsDistributed(carriedTailChords, line));
      const nextSection = maybeAutoSwitchFromChorus(
        mergedTail,
        simpleChordDistribution,
        currentSectionName,
        sectionFirstChord,
        sectionLineCount,
      );
      if (nextSection.switchToVerse) {
        out.push("{c: Куплет}");
        currentSectionName = "Куплет";
        sectionFirstChord = "";
        sectionLineCount = 0;
      }
      out.push(mergedTail);
      if (nextSection.firstChord) {
        if (!sectionFirstChord) {
          sectionFirstChord = nextSection.firstChord;
        }
        sectionLineCount += 1;
      }
      carriedTailChords = null;
      continue;
    }

    if (
      simpleChordDistribution &&
      /^припев$/i.test(currentSectionName || "") &&
      sectionLineCount >= 2 &&
      isLikelyPureLyricLine(line)
    ) {
      out.push("{c: Куплет}");
      currentSectionName = "Куплет";
      sectionFirstChord = "";
      sectionLineCount = 0;
    }

    out.push(line);
  }

  if (pendingChordLines.length) {
    out.push(buildChordOnlyLine(pendingChordLines));
  }
  if (carriedChordLines?.length) {
    out.push(buildChordOnlyLine(carriedChordLines));
  }

  const choText = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return simpleChordDistribution ? normalizePesniSectionFlow(choText) : choText;
}

function mergeChordLinesWithLyric(chordLines, lyricLine) {
  const singleTokenLines = chordLines
    .map((line) => extractChordTokens(line))
    .filter((tokens) => tokens.length === 1)
    .map((tokens) => tokens[0]);

  if (singleTokenLines.length === chordLines.length) {
    return mergeSimpleChordSequenceWithLyrics(singleTokenLines, lyricLine);
  }

  const mergedChordLine = combineChordLines(chordLines);
  return mergeChordLineWithLyrics(mergedChordLine, lyricLine);
}

export function mapUrlToSong(normalizedUrl, rawText) {
  const sourceHost = new URL(normalizedUrl).hostname.replace(/^www\./, "");
  if (!sourceHost.endsWith("amdm.ru")) {
    throw new Error("Пока поддерживается только amdm.ru");
  }

  const parsed = parseAmdmText(rawText);
  if (!parsed.bodyText) {
    throw new Error("Не удалось распознать текст песни на странице.");
  }

  return {
    id: crypto.randomUUID(),
    title: cleanSongTitle(parsed.title || "Без названия"),
    artist: parsed.artist || "Неизвестный исполнитель",
    sourceUrl: normalizedUrl,
    sourceHost,
    importedAt: new Date().toISOString(),
    format: "cho",
    cho: toCho(parsed),
  };
}

export function parseTextChordSheet(raw) {
  const lines = raw.replace(/\r/g, "").split("\n").map((line) => line.replace(/\s+$/g, ""));
  const firstLine = lines.find((line) => line.trim()) || "";
  const { artist, title } = splitHeading(firstLine);

  const startIndex = lines.indexOf(firstLine);
  const bodyLines = lines
    .slice(startIndex + 1)
    .map(stripRepeatNotations)
    .filter((line) => !/^Аккорд\s+/i.test(line.trim()));

  const bodyText = bodyLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return {
    artist: artist || "Неизвестный исполнитель",
    title: cleanSongTitle(title || "Без названия"),
    bodyText,
  };
}

export function mapTextToSong(rawText, sourceLabel = "local-text") {
  const parsed = parseTextChordSheet(rawText);
  if (!parsed.bodyText) {
    throw new Error("Не удалось распознать текст песни.");
  }

  return {
    id: crypto.randomUUID(),
    title: parsed.title,
    artist: parsed.artist,
    sourceUrl: `text://${sourceLabel}`,
    sourceHost: "local-file",
    importedAt: new Date().toISOString(),
    format: "cho",
    cho: toCho(parsed, {
      preserveChordRows: false,
      simpleChordDistribution: /pesnipodgitaru/i.test(sourceLabel),
    }),
  };
}

export function mapRawFileToSong(rawContent, sourceLabel) {
  const isHtml = /<html[\s>]|<pre[\s>]|<span[\s>]/i.test(rawContent);
  if (!isHtml) {
    return mapTextToSong(rawContent, sourceLabel);
  }

  const extracted = extractTextFromHtmlChordSheet(rawContent, sourceLabel);
  return mapTextToSong(extracted, sourceLabel);
}

function mergeChordLineWithLyrics(chordLine, lyricLine) {
  const result = [];
  const chordMatches = Array.from(chordLine.matchAll(/\S+/g));
  let cursor = 0;

  const rawPositions = chordMatches.map((match) => match.index ?? 0);
  const maxRawPos = rawPositions.length ? Math.max(...rawPositions) : 0;
  let scale = 1;
  if (lyricLine.length > 0 && maxRawPos > lyricLine.length * 1.2) {
    scale = lyricLine.length / maxRawPos;
  }

  const chordNames = chordMatches.map((match) => match[0]);
  const projectedPositions = rawPositions.map((pos) => Math.min(Math.round(pos * scale), lyricLine.length));

  // Some sources contain inflated right-side spacing in chord rows.
  // If two-chord line collapses to "start + end", place second chord
  // around the middle of lyrics (word boundary) for readable alignment.
  if (
    chordNames.length === 2 &&
    lyricLine.length > 18 &&
    projectedPositions[0] <= 1 &&
    projectedPositions[1] >= lyricLine.length - 1
  ) {
    return mergeTwoChordLineWithLyrics(chordNames, lyricLine);
  }

  for (let i = 0; i < chordMatches.length; i += 1) {
    const match = chordMatches[i];
    const chord = match[0];
    const rawPos = rawPositions[i] ?? 0;
    const chordPos = Math.min(Math.round(rawPos * scale), lyricLine.length);
    result.push(lyricLine.slice(cursor, chordPos));
    result.push(`[${chord}]`);
    cursor = chordPos;
  }

  result.push(lyricLine.slice(cursor));
  return result.join("");
}

function mergeTwoChordLineWithLyrics(chords, lyricLine) {
  const [firstChord, secondChord] = chords;
  const firstPos = 0;
  const half = Math.floor(lyricLine.length * 0.55);
  const rightPart = lyricLine.slice(half);
  const rightWord = rightPart.search(/\S/);
  const secondPos = rightWord === -1 ? Math.min(lyricLine.length, half) : half + rightWord;

  return (
    lyricLine.slice(0, firstPos) +
    `[${firstChord}]` +
    lyricLine.slice(firstPos, secondPos) +
    `[${secondChord}]` +
    lyricLine.slice(secondPos)
  );
}

function combineChordLines(chordLines) {
  const positions = [];

  for (const line of chordLines) {
    positions.push(...extractChordTokensWithPos(line));
  }

  positions.sort((a, b) => a.pos - b.pos);

  let out = "";
  for (const item of positions) {
    let pos = item.pos;
    if (out.length > pos) {
      pos = out.length + 1;
    }
    if (out.length < pos) {
      out += " ".repeat(pos - out.length);
    }
    out += item.chord;
  }

  return out;
}

function extractChordTokensWithPos(line) {
  const out = [];
  for (const match of line.matchAll(/\S+/g)) {
    const rawToken = match[0] || "";
    const normalized = normalizeChordLikeToken(rawToken);
    if (!normalized || !isChordToken(normalized)) {
      continue;
    }
    out.push({
      chord: normalized,
      pos: match.index ?? 0,
    });
  }
  return out;
}

function mergeSimpleChordSequenceWithLyrics(chords, lyricLine) {
  if (!chords.length) {
    return lyricLine;
  }

  if (chords.length === 1) {
    return `[${chords[0]}]${lyricLine}`;
  }

  if (chords.length === 2) {
    const words = lyricLine.match(/\S+/g) || [];
    const lastWord = words[words.length - 1] || "";
    const lastWordStart = lastWord ? lyricLine.lastIndexOf(lastWord) : 0;
    const firstPos = Math.max(0, lastWordStart);
    const secondPos = Math.min(lyricLine.length, firstPos + Math.max(1, Math.floor(lastWord.length / 2)));

    let out = "";
    out += lyricLine.slice(0, firstPos);
    out += `[${chords[0]}]`;
    out += lyricLine.slice(firstPos, secondPos);
    out += `[${chords[1]}]`;
    out += lyricLine.slice(secondPos);
    return out;
  }

  const maxPos = Math.max(0, lyricLine.length - 1);
  const positions = chords.map((chord, index) => ({
    chord,
    pos: Math.round((index * maxPos) / (chords.length - 1)),
  }));

  let result = "";
  let cursor = 0;
  for (const item of positions) {
    const pos = Math.min(item.pos, lyricLine.length);
    result += lyricLine.slice(cursor, pos);
    result += `[${item.chord}]`;
    cursor = pos;
  }
  result += lyricLine.slice(cursor);

  return result;
}

function mergeSimpleChordSequenceWithLyricsDistributed(chords, lyricLine) {
  if (!chords.length) {
    return lyricLine;
  }

  if (chords.length === 1) {
    return `[${chords[0]}]${lyricLine}`;
  }

  if (chords.length === 2) {
    const firstPos = 0;
    const anchor = Math.floor(lyricLine.length * 0.55);
    const right = lyricLine.slice(anchor);
    const rightWord = right.search(/\S/);
    const secondPos = Math.min(lyricLine.length, rightWord === -1 ? anchor : anchor + rightWord);

    let out = "";
    out += lyricLine.slice(0, firstPos);
    out += `[${chords[0]}]`;
    out += lyricLine.slice(firstPos, secondPos);
    out += `[${chords[1]}]`;
    out += lyricLine.slice(secondPos);
    return out;
  }

  const maxPos = Math.max(0, lyricLine.length - 1);
  const positions = chords.map((chord, index) => ({
    chord,
    pos: Math.round((index * maxPos) / (chords.length - 1)),
  }));

  let result = "";
  let cursor = 0;
  for (const item of positions) {
    const pos = Math.min(item.pos, lyricLine.length);
    result += lyricLine.slice(cursor, pos);
    result += `[${item.chord}]`;
    cursor = pos;
  }
  result += lyricLine.slice(cursor);

  return result;
}

function extractChordTokens(value) {
  const tokens = value.trim().split(/\s+/).map((token) => token.trim()).filter(Boolean);
  const out = [];

  for (const token of tokens) {
    const normalized = normalizeChordLikeToken(token);
    if (isChordToken(normalized)) {
      out.push(normalized);
      continue;
    }

    const combined = splitCombinedChordToken(normalized);
    if (combined.length > 1) {
      out.push(...combined);
    }
  }

  return out;
}

function buildChordOnlyLine(chordLines) {
  const merged = chordLines.flatMap((line) => extractChordTokens(line));
  return merged.map((chord) => `[${chord}]`).join(" ");
}

function parsePlainSectionLine(rawLine) {
  const match = rawLine.match(/^\s*([A-Za-zА-Яа-яЁё0-9\s]+):\s*(.*)$/);
  if (!match) {
    return null;
  }

  const section = (match[1] || "").trim();
  const tail = (match[2] || "").trim();
  if (!isSectionName(section)) {
    return null;
  }

  return { section, tail };
}

function parseLooseSectionLine(rawLine) {
  const match = rawLine.match(
    /^\s*(куплет|припев|вступление|проигрыш|кода|бридж|соло|intro|verse|chorus|bridge|instrumental|interlude|outro)\s*([.:!?-])?\s*(.*)$/i,
  );
  if (!match) {
    return null;
  }

  const section = (match[1] || "").trim();
  if (!isSectionName(section)) {
    return null;
  }

  const separator = (match[2] || "").trim();
  const tail = (match[3] || "").trim();

  if (!separator && tail) {
    return null;
  }

  return { section, tail };
}

function parseSectionCueLine(rawLine) {
  return parsePlainSectionLine(rawLine) || parseLooseSectionLine(rawLine);
}

function isSectionName(value) {
  return /^(куплет|припев|вступление|проигрыш|кода|бридж|соло|intro|verse|chorus|bridge|instrumental|interlude|outro)$/i.test(
    value.trim(),
  );
}

function convertChordProgressionToInline(value) {
  const protectedChords = [];
  const protectedValue = value.replace(/\[([^\]]+)\]/g, (_, chord) => {
    const index = protectedChords.push(chord) - 1;
    return `@@${index}@@`;
  });

  const converted = protectedValue.replace(
    /\b([A-H](?:#|b)?(?:m|maj|min|sus|dim|aug|add|mmaj)?\d*(?:\/[A-H](?:#|b)?)?)\b/gi,
    "[$1]",
  );

  return converted.replace(/@@(\d+)@@/g, (_, indexRaw) => {
    const index = Number.parseInt(indexRaw, 10);
    return `[${protectedChords[index] || ""}]`;
  });
}

function isInstrumentalSectionName(value) {
  return /^(вступление|проигрыш|соло|кода|intro|instrumental|interlude|outro)$/i.test(value.trim());
}

function isLikelyChordProgressionLine(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  // Keep real string tablature lines as-is (E|---, B|---, etc.).
  if (/^[EADGBe]\|/.test(trimmed)) {
    return false;
  }

  // If there are Cyrillic letters, this is likely lyrics/comment text.
  if (/[А-Яа-яЁё]/.test(trimmed)) {
    return false;
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  let chordCount = 0;

  for (const token of tokens) {
    const normalized = normalizeChordLikeToken(token);

    if (!normalized) {
      continue;
    }

    if (isChordToken(normalized)) {
      chordCount += 1;
      continue;
    }

    if (isProgressionSeparatorToken(normalized)) {
      continue;
    }

    return false;
  }

  return chordCount >= 2;
}

function findStartIndex(lines) {
  const firstSection = lines.findIndex((line) => /^\s*\[[^\]]+\]:?\s*$/.test(line));
  if (firstSection !== -1) {
    return firstSection;
  }

  const firstChord = lines.findIndex((line) => isChordLine(line.trim()));
  if (firstChord !== -1) {
    return firstChord;
  }

  return 0;
}

function findEndIndex(lines, startIndex) {
  const stopPatterns = [/Свернуть\s+Распечатать/i, /###\s+Аппликатуры аккордов/i, /популярные подборы/i];

  for (let i = startIndex; i < lines.length; i += 1) {
    if (stopPatterns.some((pattern) => pattern.test(lines[i]))) {
      return i;
    }
  }

  return lines.length;
}

function isChordLine(value) {
  const tokens = value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (!tokens.length || tokens.length > 12) {
    return false;
  }

  let chordCount = 0;
  for (const token of tokens) {
    const normalized = normalizeChordLikeToken(token);
    if (!normalized) {
      continue;
    }
    if (isChordToken(normalized)) {
      chordCount += 1;
      continue;
    }
    const combined = splitCombinedChordToken(normalized);
    if (combined.length > 1) {
      chordCount += combined.length;
      continue;
    }
    if (isProgressionSeparatorToken(normalized)) {
      continue;
    }
    return false;
  }

  return chordCount > 0;
}

function normalizeChordLikeToken(token) {
  const cleaned = token.replace(/^[\[\(\{]+/, "").replace(/[\]\)\},:;.!?]+$/, "");
  return normalizeCyrillicChordLetters(cleaned);
}

function normalizeCyrillicChordLetters(token) {
  if (!/[А-Яа-яЁё]/.test(token)) {
    return token;
  }

  return token
    .replace(/[Аа]/g, "A")
    .replace(/[Вв]/g, "B")
    .replace(/[Сс]/g, "C")
    .replace(/[Ее]/g, "E")
    .replace(/[Нн]/g, "H");
}

function isProgressionSeparatorToken(token) {
  return /^(?:\|+|\/+|-+|x\d+|\}x\d+|\(+\)+|\.{1,3})$/i.test(token);
}

function isChordToken(token) {
  return /^(?:[A-H](?:#|b)?(?:m|maj|min|sus|dim|aug|add|mmaj)?\d*(?:\/[A-H](?:#|b)?)?|N\.C\.)$/i.test(token);
}

function splitCombinedChordToken(token) {
  if (!token || token.length < 2) {
    return [];
  }

  const out = [];
  let rest = token;

  while (rest.length) {
    const match = rest.match(/^(?:[A-H](?:#|b)?(?:m|maj|min|sus|dim|aug|add|mmaj)?\d*(?:\/[A-H](?:#|b)?)?|N\.C\.)/i);
    if (!match || !match[0]) {
      return [];
    }
    out.push(match[0]);
    rest = rest.slice(match[0].length);
  }

  return out.length > 1 ? out : [];
}

function extractArtistAndTitle(lines) {
  const candidates = [
    lines.find((line) => /^Title:\s+/i.test(line)),
    lines.find((line) => /^#\s+/.test(line)),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const parsed = splitHeading(candidate);
    if (parsed.artist || parsed.title) {
      return parsed;
    }
  }

  return { artist: "", title: "" };
}

function splitHeading(rawHeading) {
  const cleanedHeading = rawHeading
    .replace(/^Title:\s+/i, "")
    .replace(/^#\s+/, "")
    .replace(/\s*[|•]\s*amdm\.?ru.*$/i, "")
    .replace(/,\s*аккорды.*$/i, "")
    .trim();

  const parts = cleanedHeading
    .split(/\s+-\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length > 1) {
    return {
      artist: parts[0],
      title: parts.slice(1).join(" - "),
    };
  }

  return {
    artist: "",
    title: parts[0] || "",
  };
}

function cleanSongTitle(title) {
  return title
    .replace(/\s*\(аккорды для гитары\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTextFromHtmlChordSheet(html, sourceLabel = "") {
  if (/pesnipodgitaru\.ru/i.test(html) || /pesnipodgitaru/i.test(sourceLabel)) {
    return extractTextFromPesniPodGitaru(html);
  }

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);

  const title = normalizeHtmlText(titleMatch?.[1] || "");
  const preBody = preMatch?.[1] || html;

  const withoutTags = preBody
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  const decoded = decodeHtmlEntities(withoutTags)
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!title) {
    return decoded;
  }

  return `${title}\n${decoded}`;
}

function extractTextFromPesniPodGitaru(html) {
  const titleText = normalizeHtmlText(
    html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
      html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
      "",
  );
  const title = cleanPesniPodGitaruTitle(titleText);

  const artistText = normalizeHtmlText(
    html.match(
      /<div[^>]*class="[^"]*breadcrumb[^"]*"[\s\S]*?<a[^>]+href="https?:\/\/pesnipodgitaru\.ru\/pesni\/russkiy-rok\/[^"]+"[^>]*>\s*(?:<span[^>]*>)?([^<]+)(?:<\/span>)?\s*<\/a>\s*<meta[^>]+position[^>]+content="3"/i,
    )?.[1] ||
      html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ||
      "",
  );
  const artist = cleanPesniPodGitaruArtist(artistText);

  const articleHtml =
    html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/i)?.[1] || html;

  const cleanedHtml = articleHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<div[^>]*class=['"][^'"]*code-block[^'"]*['"][^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/<a[^>]*>/gi, "")
    .replace(/<\/a>/gi, "")
    .replace(/<pre[^>]*>/gi, "\n")
    .replace(/<\/pre>/gi, "\n")
    .replace(/<h[1-6][^>]*>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  const pesniLines = decodeHtmlEntities(cleanedHtml)
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map(normalizePesniBodyLine)
    .filter((line) => !isPesniNoiseLine(line))
    .map((line) => line.replace(/\s+$/g, ""))
    .filter(Boolean);

  const bodyText = pesniLines
    .slice(findPesniBodyStartIndex(pesniLines))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (artist && title) {
    return `${artist} - ${title}\n${bodyText}`.trim();
  }

  if (title) {
    return `${title}\n${bodyText}`.trim();
  }

  return bodyText;
}

function cleanPesniPodGitaruTitle(value) {
  return value
    .replace(/\s*группы\s+[^,|]+.*$/i, "")
    .replace(/\s*текст.*$/i, "")
    .replace(/\|\s*песни под гитару.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPesniPodGitaruArtist(value) {
  const cleaned = value
    .replace(/^группа\s+/i, "")
    .replace(/^клуб\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "";
  }

  if (/^kino/i.test(cleaned) || /виктор цой/i.test(cleaned)) {
    return "Кино";
  }

  return cleaned;
}

function normalizePesniBodyLine(line) {
  return line
    .replace(/\u00a0/g, " ")
    .replace(/&#8203;/g, "")
    .replace(/\b\d+\s*[рp]\.?\s*[A-H](?:#|b)?(?:m|maj|min|sus|dim|aug|add|mmaj)?\d*\b/gi, "")
    .replace(/\b\d+\s*[рp]\.?\b/gi, "")
    .replace(/^[ _—-]+/g, "")
    .replace(/\s+$/g, "");
}

function stripRepeatNotations(line) {
  return line
    .replace(/\b\d+\s*[рp]\.?\s*[A-H](?:#|b)?(?:m|maj|min|sus|dim|aug|add|mmaj)?\d*\b/gi, "")
    .replace(/\b\d+\s*[рp]\.?\b/gi, "")
    .replace(/(?:^|\s)\d+\s*[рp]\.?(?=\s|$)/gi, " ")
    .replace(/(?:^|\s)\d+\s*[рp](?=\s|$)/giu, " ")
    .trimEnd();
}

function cleanupMergedLyricArtifacts(line) {
  return line
    .replace(/[A-H]\[([A-H](?:#|b)?(?:m|maj|min|sus|dim|aug|add|mmaj)?\d*)\]m/gi, "[$1]")
    .replace(/\s+$/g, "");
}

function extractTrailingCarryChords(line) {
  const tokens = Array.from(line.matchAll(/\S+/g));
  if (!tokens.length) {
    return null;
  }

  const tailChords = [];
  let cutIndex = line.length;

  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = normalizeChordLikeToken(tokens[i][0] || "");
    const combined = isChordToken(token) ? [token] : splitCombinedChordToken(token);

    if (!combined.length) {
      break;
    }

    tailChords.unshift(...combined);
    cutIndex = tokens[i].index ?? cutIndex;
  }

  if (tailChords.length < 2) {
    return null;
  }

  const prefix = line.slice(0, cutIndex);
  if (!/[_—-]/.test(prefix.slice(Math.max(0, prefix.length - 16)))) {
    return null;
  }

  const cleanedLine = prefix.replace(/[\s_—-]+$/g, "");
  if (!cleanedLine.trim()) {
    return null;
  }

  return {
    line: cleanedLine,
    chords: tailChords,
  };
}

function maybeAutoSwitchFromChorus(line, simpleChordDistribution, currentSectionName, sectionFirstChord, sectionLineCount) {
  const firstChord = (line.match(/\[([^\]]+)\]/)?.[1] || "").trim();
  if (!firstChord) {
    return { firstChord: "", switchToVerse: false };
  }

  if (!simpleChordDistribution || !/^припев$/i.test(currentSectionName || "")) {
    return { firstChord, switchToVerse: false };
  }

  if (!sectionFirstChord) {
    return { firstChord, switchToVerse: false };
  }

  // Heuristic for pesnipodgitaru: if chorus already has at least 4 lines and
  // first chord abruptly changes, it's usually a switch back to verse.
  const lyricText = line.replace(/\[[^\]]+\]/g, "").trim();
  const emphaticEnding = /[!?]\s*$/.test(lyricText);

  if (sectionLineCount >= 4 && firstChord !== sectionFirstChord && !emphaticEnding) {
    return { firstChord, switchToVerse: true };
  }

  return { firstChord, switchToVerse: false };
}

function isLikelyPureLyricLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.includes("[")) {
    return false;
  }
  if (isTablatureOrStringLine(trimmed)) {
    return false;
  }
  return /[А-Яа-яЁёA-Za-z]/.test(trimmed);
}

function normalizePesniSectionFlow(choText) {
  const lines = choText.split("\n");
  const out = [];
  let currentSection = "";
  let chorusChordedLines = 0;

  for (const rawLine of lines) {
    const line = rawLine;
    const directive = line.match(/^\{\s*c\s*:\s*([^}]+)\}\s*$/i);
    if (directive) {
      currentSection = (directive[1] || "").trim();
      chorusChordedLines = 0;
      out.push(line);
      continue;
    }

    if (!line.trim()) {
      out.push(line);
      continue;
    }

    if (/^припев$/i.test(currentSection)) {
      if (line.includes("[")) {
        chorusChordedLines += 1;
      } else if (chorusChordedLines >= 2 && isLikelyPureLyricLine(line)) {
        out.push("{c: Куплет}");
        currentSection = "Куплет";
        chorusChordedLines = 0;
      }
    }

    out.push(line);
  }

  return out.join("\n");
}

function isPesniNoiseLine(line) {
  const value = line.trim();
  if (!value) {
    return true;
  }

  if (/^[—\-_.\s]+$/u.test(value)) {
    return true;
  }

  if (/(русский рок под гитару|группа «?кино»? и виктор цой|текст песни, аккорды(?:, табулатура,? видеоразбор)?|музыка и слова виктор цой)/i.test(value)) {
    return true;
  }

  if (/^рекомендуемый рисунок:?$/i.test(value)) {
    return true;
  }

  if (/тональност/i.test(value)) {
    return true;
  }

  return false;
}

function findPesniBodyStartIndex(lines) {
  const musicalStart = lines.findIndex((line) => {
    if (/тональност/i.test(line)) {
      return false;
    }
    if (/^\d-я\s+/i.test(line)) {
      return true;
    }
    if (/^[A-H][#b]?(?:m|maj|min|sus|dim|aug|add)?\d*(?:\s+[A-H][#b]?(?:m|maj|min|sus|dim|aug|add)?\d*)+\s*$/i.test(line)) {
      return true;
    }
    if (/[А-Яа-яЁё]/.test(line) && /[A-H][#b]?(?:m|maj|min|sus|dim|aug|add)?\d*/i.test(line)) {
      return true;
    }
    return false;
  });

  return musicalStart === -1 ? 0 : musicalStart;
}

function isTablatureOrStringLine(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/^[1-6]-я\s+/.test(trimmed)) {
    return true;
  }
  if (/^[EADGBe]\|/.test(trimmed)) {
    return true;
  }
  return false;
}

function normalizeHtmlText(value) {
  return decodeHtmlEntities(value)
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
}
