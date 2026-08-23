/** Client-side SEO analysis for a generated article (no network calls). */

const LENGTH_TARGETS = {
  short: [400, 500],
  medium: [800, 1000],
  long: [1500, 1800],
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip Markdown to readable plain text for word/sentence/syllable analysis. */
function toPlainText(md) {
  return (md || "")
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .replace(/[*_>#~`]+/g, " ") // stray md symbols
    .replace(/\s+/g, " ")
    .trim();
}

function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!word) return 0;
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  word = word.replace(/^y/, "");
  const groups = word.match(/[aeiouy]{1,2}/g);
  return groups ? groups.length : 1;
}

/** Flesch Reading Ease (0–100; higher = easier). */
function fleschReadingEase(text) {
  const sentences = (text.match(/[.!?]+(?:\s|$)/g) || []).length || 1;
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length || 1;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const score = 206.835 - 1.015 * (wordCount / sentences) - 84.6 * (syllables / wordCount);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function fleschLabel(score) {
  if (score >= 80) return "very easy";
  if (score >= 70) return "easy";
  if (score >= 60) return "standard";
  if (score >= 50) return "fairly difficult";
  if (score >= 30) return "difficult";
  return "very hard";
}

function rangeCheck(label, value, min, max, detail) {
  let status = "good";
  if (value < min * 0.6 || value > max * 1.4) status = "bad";
  else if (value < min || value > max) status = "warn";
  return { label, status, detail };
}

/**
 * Analyze an article for on-page SEO signals.
 * @returns {{score:number, wordCount:number, readingTime:number, fleschScore:number,
 *   fleschLabel:string, headings:{h1:number,h2:number,h3:number},
 *   keywordStats:Array, titleLen:number, metaLen:number, checks:Array}}
 */
export function analyzeSeo({ markdown = "", title = "", meta = "", keywords = [], length = "medium" }) {
  const text = toPlainText(markdown);
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const readingTime = Math.max(1, Math.round(wordCount / 200));
  const fleschScore = fleschReadingEase(text);

  const h1 = (markdown.match(/^#\s+/gm) || []).length;
  const h2 = (markdown.match(/^##\s+/gm) || []).length;
  const h3 = (markdown.match(/^###\s+/gm) || []).length;

  const lower = text.toLowerCase();
  const keywordStats = (keywords || [])
    .map((k) => (k || "").trim())
    .filter(Boolean)
    .map((kw) => {
      const count = (lower.match(new RegExp(`\\b${escapeRegex(kw.toLowerCase())}\\b`, "g")) || []).length;
      const density = wordCount ? (count / wordCount) * 100 : 0;
      const inTitle = title.toLowerCase().includes(kw.toLowerCase());
      return { keyword: kw, count, density, inTitle };
    });

  const titleLen = title.trim().length;
  const metaLen = meta.trim().length;
  const [minW, maxW] = LENGTH_TARGETS[length] || LENGTH_TARGETS.medium;

  const checks = [];
  checks.push(rangeCheck("Title length", titleLen, 30, 60, `${titleLen} chars · ideal 50–60`));
  checks.push(rangeCheck("Meta description", metaLen, 120, 160, `${metaLen} chars · ideal 120–160`));
  checks.push({
    label: "Single H1 title",
    status: h1 === 1 ? "good" : "bad",
    detail: `${h1} H1 heading${h1 === 1 ? "" : "s"}`,
  });
  checks.push({
    label: "Section headings",
    status: h2 >= 2 ? "good" : "warn",
    detail: `${h2} H2 · ${h3} H3`,
  });
  checks.push({
    label: "Length target",
    status:
      wordCount >= minW && wordCount <= maxW
        ? "good"
        : wordCount >= minW * 0.8 && wordCount <= maxW * 1.2
        ? "warn"
        : "bad",
    detail: `${wordCount} words · target ${minW}–${maxW}`,
  });
  checks.push({
    label: "Readability",
    status: fleschScore >= 60 ? "good" : fleschScore >= 40 ? "warn" : "bad",
    detail: `Flesch ${fleschScore} · ${fleschLabel(fleschScore)}`,
  });
  if (keywordStats.length) {
    const inRange = keywordStats.filter((k) => k.density >= 0.3 && k.density <= 2.5).length;
    checks.push({
      label: "Keyword density",
      status: inRange === keywordStats.length ? "good" : inRange > 0 ? "warn" : "bad",
      detail: keywordStats.map((k) => `${k.keyword} ${k.density.toFixed(1)}%`).join(" · "),
    });
    checks.push({
      label: "Keyword in title",
      status: keywordStats.some((k) => k.inTitle) ? "good" : "warn",
      detail: keywordStats.some((k) => k.inTitle)
        ? "a target keyword appears in the title"
        : "no target keyword in the title",
    });
  }

  const score = Math.round(
    (checks.reduce((s, c) => s + (c.status === "good" ? 1 : c.status === "warn" ? 0.5 : 0), 0) /
      checks.length) *
      100
  );

  return {
    score,
    wordCount,
    readingTime,
    fleschScore,
    fleschLabel: fleschLabel(fleschScore),
    headings: { h1, h2, h3 },
    keywordStats,
    titleLen,
    metaLen,
    checks,
  };
}

export function seoTier(score) {
  if (score >= 80) return "good";
  if (score >= 55) return "warn";
  return "bad";
}
