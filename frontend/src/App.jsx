import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  generateArticleStream,
  generateGroundedStream,
  clarifyTopic,
  checkHealth,
  listArticles,
  getArticle,
  createArticle,
  rewriteSection,
  updateArticle,
  generateOutline,
  expandOutlineStream,
  suggestSections,
  suggestKeywords,
  generateCover,
  generateFaq,
  generateSocial,
  improveSeo,
  translateArticle,
  analyzeCompetitors,
  editChat,
  generateSectionImages,
  planAgentActions,
} from "./api";
import { useAuthState } from "./AuthGate";
import { analyzeSeo, seoTier } from "./seo";
import { buildExportHtml, downloadHtmlFile, openPrintWindow, slugify } from "./exportDoc";

const TONES = ["informative", "professional", "casual", "friendly", "persuasive", "witty"];

const LENGTHS = [
  { value: "short", label: "Short", hint: "~400–500 words" },
  { value: "medium", label: "Medium", hint: "~800–1000 words" },
  { value: "long", label: "Long", hint: "~1500–1800 words" },
];

marked.setOptions({ breaks: true });

const HISTORY_LIMIT = 50;

const TRANSLATION_LANGUAGES = [
  "Spanish",
  "French",
  "German",
  "Italian",
  "Portuguese",
  "Dutch",
  "Russian",
  "Polish",
  "Turkish",
  "Arabic",
  "Hebrew",
  "Hindi",
  "Bengali",
  "Tamil",
  "Marathi",
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "Japanese",
  "Korean",
  "Vietnamese",
  "Thai",
  "Indonesian",
];

function cleanMeta(meta) {
  return (meta || "")
    .trim()
    .replace(/^(meta description|meta|description)\s*[:\-]\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function extractTitle(markdown, fallback) {
  const match = (markdown || "").match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m);
  return match ? match[1].trim() : fallback;
}

function countWords(text) {
  return ((text || "").match(/\b\w+\b/g) || []).length;
}

function markdownToPlain(md) {
  return (md || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/[\r]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseFormatted(text) {
  const blocks = [];
  let bullets = [];
  const flush = () => {
    if (bullets.length) {
      blocks.push({ type: "ul", items: bullets });
      bullets = [];
    }
  };
  for (const rawLine of (text || "").split("\n")) {
    const s = rawLine.trim();
    if (!s) {
      flush();
      continue;
    }
    if (/^[\u2022\-*]\s+/.test(s)) {
      bullets.push(s.replace(/^[\u2022\-*]\s+/, ""));
      continue;
    }
    flush();
    const words = s.split(/\s+/);
    if (words.length && words.every((w) => w.startsWith("#"))) {
      blocks.push({ type: "tags", items: words });
    } else {
      blocks.push({ type: "p", text: s });
    }
  }
  flush();
  return blocks;
}

function splitSections(markdown) {
  const sections = [];
  let current = { heading: "Introduction", lines: [] };
  for (const line of (markdown || "").split("\n")) {
    if (/^##\s+/.test(line)) {
      if (current.lines.length) sections.push(current);
      current = { heading: line.replace(/^#{2,}\s+/, "").trim() || "Section", lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length) sections.push(current);
  return sections.map((s, index) => ({
    index,
    heading: s.heading,
    text: s.lines.join("\n").trim(),
  }));
}

export default function App() {
  const [searchParams] = useSearchParams();
  const [topic, setTopic] = useState("");
  const [keywords, setKeywords] = useState("");
  const [tone, setTone] = useState("informative");
  const [length, setLength] = useState("medium");
  const [audience, setAudience] = useState("a general audience");
  const [clarify, setClarify] = useState(null); // { ambiguous, options } while asking
  const [clarifyLoading, setClarifyLoading] = useState(false);
  const [kwSuggestions, setKwSuggestions] = useState([]);
  const [kwLoading, setKwLoading] = useState(false);
  const [kwError, setKwError] = useState("");

  const [loading, setLoading] = useState(false);
  const [researching, setResearching] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const [coverLoading, setCoverLoading] = useState(false);
  const [faq, setFaq] = useState(null);
  const [faqLoading, setFaqLoading] = useState(false);
  const [faqOpen, setFaqOpen] = useState(false);
  const [social, setSocial] = useState(null);
  const [socialLoading, setSocialLoading] = useState(false);
  const [socialTab, setSocialTab] = useState("thread");
  const [copiedKey, setCopiedKey] = useState(null);
  const [socialOpen, setSocialOpen] = useState(false);
  const [shareNote, setShareNote] = useState("");
  const [improvingSeo, setImprovingSeo] = useState(false);
  const [translateOpen, setTranslateOpen] = useState(false);
  const [translateLang, setTranslateLang] = useState("Spanish");
  const [translateLoading, setTranslateLoading] = useState(false);
  const [translation, setTranslation] = useState(null); // { title, meta_description, markdown, target_language, word_count }
  const [competitorOpen, setCompetitorOpen] = useState(false);
  const [competitorLoading, setCompetitorLoading] = useState(false);
  const [competitor, setCompetitor] = useState(null); // { top_pages, gaps, suggested_sections, word_count_target }
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMessages, setEditorMessages] = useState([]); // [{role:'user'|'assistant', content, updated?}]
  const [editorInput, setEditorInput] = useState("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const [audioVoices, setAudioVoices] = useState([]);
  const [audioVoiceIdx, setAudioVoiceIdx] = useState(-1);
  const [audioRate, setAudioRate] = useState(1);
  const [audioStatus, setAudioStatus] = useState("idle"); // idle | playing | paused
  const [sectionImagesLoading, setSectionImagesLoading] = useState(false);
  const [openMenu, setOpenMenu] = useState(null); // 'export' | 'media' | 'repurpose' | null

  const [health, setHealth] = useState("checking"); // checking | online | offline
  const [provider, setProvider] = useState("");

  const [history, setHistory] = useState([]);
  const [stream, setStream] = useState(null); // { meta, markdown, hasArticle } while streaming
  const [sectionIdx, setSectionIdx] = useState("");
  const [rewriteHint, setRewriteHint] = useState("");
  const [rewriting, setRewriting] = useState(false);
  const [outline, setOutline] = useState(null); // array of { heading, points } | null
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);

  const { ready: authReady, signedIn, userId } = useAuthState();

  useEffect(() => {
    let active = true;
    checkHealth()
      .then((h) => {
        if (!active) return;
        setHealth("online");
        setProvider(h.provider);
      })
      .catch(() => active && setHealth("offline"));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!authReady) return undefined; // wait for Clerk to restore the session
    if (!signedIn) {
      setHistory([]);
      return undefined;
    }
    let active = true;
    listArticles()
      .then((rows) => active && setHistory(rows))
      .catch(() => active && setHistory([]));
    return () => {
      active = false;
    };
  }, [authReady, signedIn, userId]);

  useEffect(() => {
    const rawId = searchParams.get("article");
    if (!rawId) return;
    const targetId = Number(rawId);
    if (!targetId || (result && result.id === targetId)) return;

    let active = true;
    const match = history.find((a) => a.id === targetId);

    const applyArticle = (art) => {
      if (!active || !art) return;
      setResult(art);
      if (art.topic || art.title) setTopic(art.topic || art.title);
      if (art.keywords?.length)
        setKeywords(Array.isArray(art.keywords) ? art.keywords.join(", ") : art.keywords);
      if (art.tone) setTone(art.tone);
      if (art.length) setLength(art.length);
      if (art.audience) setAudience(art.audience);
    };

    if (match) {
      applyArticle(match);
    } else {
      getArticle(targetId)
        .then(applyArticle)
        .catch(() => {});
    }

    return () => {
      active = false;
    };
  }, [searchParams, history, result]);

  useEffect(() => {
    if (!faqOpen && !socialOpen && !translateOpen && !competitorOpen && !editorOpen && !audioOpen)
      return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") {
        setFaqOpen(false);
        setSocialOpen(false);
        setTranslateOpen(false);
        setCompetitorOpen(false);
        setEditorOpen(false);
        setAudioOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [faqOpen, socialOpen, translateOpen, competitorOpen, editorOpen, audioOpen]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return undefined;
    const load = () => {
      const list = window.speechSynthesis.getVoices();
      if (!list.length) return;
      setAudioVoices(list);
      setAudioVoiceIdx((prev) => {
        if (prev >= 0 && prev < list.length) return prev;
        const preferred = list.findIndex((v) => /en-(US|GB)/.test(v.lang) && !v.localService === false);
        return preferred >= 0 ? preferred : 0;
      });
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  useEffect(() => {
    if (!openMenu) return undefined;
    const onClick = (e) => {
      if (!e.target.closest(".action-menu")) setOpenMenu(null);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [openMenu]);

  useEffect(() => {
    if (audioOpen) return undefined;
    // Cancel any in-flight speech when the modal closes.
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setAudioStatus("idle");
    return undefined;
  }, [audioOpen]);

  const keywordList = useMemo(
    () =>
      keywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    [keywords]
  );

  async function handleSuggestKeywords() {
    if (topic.trim().length < 3 || kwLoading) return;
    setKwLoading(true);
    setKwError("");
    try {
      const data = await suggestKeywords({
        topic: topic.trim(),
        audience: audience.trim() || "a general audience",
        existing: keywordList,
      });
      const fresh = (data.keywords || []).filter(
        (k) => !keywordList.some((e) => e.toLowerCase() === k.toLowerCase())
      );
      setKwSuggestions(fresh);
      if (fresh.length === 0) setKwError("No new keywords to suggest — try a more specific topic.");
    } catch (err) {
      setKwError(err.message || "Could not suggest keywords.");
    } finally {
      setKwLoading(false);
    }
  }

  function addSuggestedKeyword(kw) {
    setKeywords((prev) => {
      const list = prev
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.some((e) => e.toLowerCase() === kw.toLowerCase())) return prev;
      return [...list, kw].join(", ");
    });
    setKwSuggestions((prev) => prev.filter((k) => k !== kw));
  }

  const articleHtml = useMemo(
    () => (result ? DOMPurify.sanitize(marked.parse(result.markdown)) : ""),
    [result]
  );

  const streamHtml = useMemo(
    () => (stream?.markdown ? DOMPurify.sanitize(marked.parse(stream.markdown)) : ""),
    [stream?.markdown]
  );

  const sections = useMemo(
    () => (result ? splitSections(result.markdown) : []),
    [result]
  );

  const readingTime = result ? Math.max(1, Math.round(result.word_count / 200)) : 0;

  const seo = useMemo(
    () =>
      result
        ? analyzeSeo({
            markdown: result.markdown,
            title: result.title,
            meta: result.meta_description,
            keywords: result.keywords?.length ? result.keywords : keywordList,
            length: result.length || length,
          })
        : null,
    [result, keywordList, length]
  );

  const newsletter = useMemo(() => {
    const nl = social?.newsletter || "";
    const out = {
      subject: "",
      preview: "",
      intro: "",
      highlights: [],
      whyItMatters: "",
      cta: "",
      text: nl,
      structured: false,
    };
    let section = null;
    for (const rawLine of nl.split("\n")) {
      const s = rawLine.trim();
      if (!s) continue;
      let m;
      if ((m = s.match(/^subject:\s*(.*)/i))) {
        out.subject = m[1].trim();
        section = null;
      } else if ((m = s.match(/^preview:\s*(.*)/i))) {
        out.preview = m[1].trim();
        section = "preview";
      } else if ((m = s.match(/^intro:\s*(.*)/i))) {
        out.intro = m[1].trim();
        section = "intro";
      } else if (/^highlights:/i.test(s)) {
        section = "highlights";
      } else if ((m = s.match(/^why it matters:\s*(.*)/i))) {
        out.whyItMatters = m[1].trim();
        section = "why";
      } else if ((m = s.match(/^cta:\s*(.*)/i))) {
        out.cta = m[1].trim();
        section = "cta";
      } else if (section === "highlights" && /^[-\u2022*]\s*/.test(s)) {
        const item = s.replace(/^[-\u2022*]\s*/, "");
        const idx = item.indexOf("|");
        out.highlights.push(
          idx === -1
            ? { head: "", text: item.trim() }
            : { head: item.slice(0, idx).trim(), text: item.slice(idx + 1).trim() }
        );
      } else if (section === "intro") {
        out.intro += (out.intro ? " " : "") + s;
      } else if (section === "why") {
        out.whyItMatters += (out.whyItMatters ? " " : "") + s;
      } else if (section === "cta") {
        out.cta += (out.cta ? " " : "") + s;
      } else if (section === "preview") {
        out.preview += (out.preview ? " " : "") + s;
      }
    }
    out.structured = !!(
      out.subject ||
      out.intro ||
      out.highlights.length ||
      out.cta ||
      out.whyItMatters
    );
    const parts = [];
    if (out.subject) parts.push(`Subject: ${out.subject}`);
    if (out.preview) parts.push(out.preview);
    if (out.intro) parts.push(out.intro);
    if (out.highlights.length)
      parts.push(
        out.highlights.map((h) => (h.head ? `${h.head}: ${h.text}` : h.text)).join("\n\n")
      );
    if (out.whyItMatters) parts.push(`Why it matters: ${out.whyItMatters}`);
    if (out.cta) parts.push(out.cta);
    out.text = parts.length ? parts.join("\n\n") : nl;
    out.emailBody =
      [
        out.intro,
        out.highlights
          .map((h) => (h.head ? `• ${h.head}: ${h.text}` : `• ${h.text}`))
          .join("\n\n"),
        out.whyItMatters ? `Why it matters: ${out.whyItMatters}` : "",
        out.cta,
      ]
        .filter(Boolean)
        .join("\n\n") || nl;
    return out;
  }, [social]);
  const canSubmit = topic.trim().length >= 3 && !loading && !clarifyLoading;

  async function handleSubmit(e) {
    e.preventDefault();
    if (topic.trim().length < 3 || loading || clarifyLoading) return;
    setError("");
    setClarifyLoading(true);
    try {
      const res = await clarifyTopic(topic.trim());
      if (res.ambiguous && (res.options || []).length >= 2) {
        setClarify(res);
        return;
      }
    } catch {
      /* if the clarify check fails, don't block generation */
    } finally {
      setClarifyLoading(false);
    }
    await proceedGeneration(currentPayload());
  }

  function proceedGeneration(payload) {
    return runGeneration(payload, generateGroundedStream, "gemini · web-grounded", true);
  }

  async function chooseTopic(label) {
    setClarify(null);
    setTopic(label);
    await proceedGeneration({ ...currentPayload(), topic: label });
  }

  async function keepOriginalTopic() {
    const original = topic.trim();
    setClarify(null);
    await proceedGeneration({ ...currentPayload(), topic: original });
  }

  function dismissClarify() {
    setClarify(null);
  }

  function currentPayload() {
    return {
      topic: topic.trim(),
      keywords: keywordList,
      tone,
      length,
      audience: audience.trim() || "a general audience",
    };
  }

  async function runGeneration(
    payload,
    streamFn = generateArticleStream,
    provider = "gemini",
    researchFirst = false
  ) {
    setError("");
    setResult(null);
    setFaq(null);
    setSocial(null);
    setFaqOpen(false);
    setSocialOpen(false);
    setOutline(null);
    setSuggestOpen(false);
    setSectionIdx("");
    setResearching(researchFirst);
    setStream({ meta: "", markdown: "", hasArticle: false });
    setLoading(true);
    try {
      const { meta, markdown } = await streamFn(payload, setStream);
      const finalResult = {
        title: extractTitle(markdown, payload.topic),
        meta_description: cleanMeta(meta).slice(0, 160),
        markdown,
        word_count: countWords(markdown),
        provider,
      };
      setResult(finalResult);
      setStream(null);
      try {
        const saved = await createArticle({
          topic: payload.topic,
          keywords: payload.keywords,
          tone: payload.tone,
          length: payload.length,
          audience: payload.audience,
          ...finalResult,
        });
        setResult(saved);
        setHistory((prev) => [saved, ...prev].slice(0, HISTORY_LIMIT));
      } catch {
        /* saving to the library is best-effort */
      }
    } catch (err) {
      setError(err.message);
      setStream(null);
    } finally {
      setLoading(false);
      setResearching(false);
    }
  }

  async function regenerate() {
    if (topic.trim().length < 3 || loading) return;
    await runGeneration(currentPayload(), generateGroundedStream, "gemini · web-grounded", true);
  }

  function openTranslate() {
    if (!result) return;
    setTranslateOpen(true);
  }

  async function handleCompetitorScan() {
    if (topic.trim().length < 3) return;
    setCompetitorOpen(true);
    if (competitorLoading || competitor) return;
    setCompetitorLoading(true);
    setError("");
    try {
      const res = await analyzeCompetitors({
        topic: topic.trim(),
        keywords: keywordList,
      });
      setCompetitor(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setCompetitorLoading(false);
    }
  }

  function useCompetitorSections() {
    if (!competitor?.suggested_sections?.length) return;
    setOutline(
      competitor.suggested_sections.map((h) => ({
        heading: h,
        points: "",
      }))
    );
    setCompetitorOpen(false);
  }

  function openEditor() {
    if (!result) return;
    setEditorOpen(true);
  }

  const AGENT_TOOL_LABELS = {
    edit: "Editing article",
    improve_seo: "Improving SEO",
    translate: "Translating",
    section_images: "Generating section images",
    cover_image: "Generating cover image",
    social: "Generating social pack",
    faq: "Generating FAQ",
    competitors: "Scanning competitors",
    export: "Exporting article",
    seo_report: "Analyzing SEO",
    proofread: "Proofreading",
    summarize: "Adding key takeaways",
  };

  function pushAgentStep(step) {
    setEditorMessages((prev) => [...prev, { role: "agent", ...step }]);
  }

  function updateLastAgentStep(patch) {
    setEditorMessages((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === "agent" && prev[i].status === "running") {
          const next = [...prev];
          next[i] = { ...next[i], ...patch };
          return next;
        }
      }
      return prev;
    });
  }

  /** Apply an updated article to state + persist it to the backend. */
  async function applyArticleUpdate(baseResult, patch) {
    const updated = {
      ...baseResult,
      title: patch.title || baseResult.title,
      meta_description:
        patch.meta_description !== undefined ? patch.meta_description : baseResult.meta_description,
      markdown: patch.markdown ?? baseResult.markdown,
      word_count: patch.word_count ?? countWords(patch.markdown ?? baseResult.markdown),
    };
    setResult(updated);
    setFaq(null);
    setSocial(null);
    if (baseResult.id) {
      try {
        const saved = await updateArticle(baseResult.id, {
          title: updated.title,
          meta_description: updated.meta_description,
          markdown: updated.markdown,
          word_count: updated.word_count,
        });
        setResult(saved);
        setHistory((prev) => prev.map((h) => (h.id === saved.id ? saved : h)));
        return saved;
      } catch {
        /* keep local update if persist fails */
      }
    }
    return updated;
  }

  /** Run a single agent action. `getCurrentResult` returns the freshest article
   *  so chained actions build on each other's output. Returns the updated result. */
  async function runAgentAction(action, getCurrentResult) {
    const current = getCurrentResult();
    if (!current) throw new Error("No article to act on.");
    switch (action.tool) {
      case "edit": {
        const instruction = String(action.args?.instruction || "").trim();
        if (!instruction) throw new Error("Edit requires an instruction.");
        const res = await editChat({
          title: current.title,
          meta_description: current.meta_description,
          markdown: current.markdown,
          messages: [{ role: "user", content: instruction }],
        });
        if (res.updated && res.markdown) {
          const saved = await applyArticleUpdate(current, {
            title: res.title,
            meta_description: res.meta_description,
            markdown: res.markdown,
            word_count: res.word_count,
          });
          return { result: saved, note: res.reply || "Article updated." };
        }
        return { result: current, note: res.reply || "No changes were needed." };
      }
      case "improve_seo": {
        const issues = seo
          ? seo.checks.filter((c) => c.status !== "good").map((c) => `${c.label}: ${c.detail}`)
          : [];
        setImprovingSeo(true);
        try {
          const res = await improveSeo({
            topic: topic.trim() || current.title,
            title: current.title,
            meta_description: current.meta_description,
            markdown: current.markdown,
            keywords: current.keywords?.length ? current.keywords : keywordList,
            tone: current.tone || tone,
            audience: current.audience || audience.trim() || "a general audience",
            issues,
          });
          const saved = await applyArticleUpdate(current, {
            title: res.title,
            meta_description: res.meta_description,
            markdown: res.markdown,
            word_count: res.word_count,
          });
          return { result: saved, note: "SEO rewrite applied." };
        } finally {
          setImprovingSeo(false);
        }
      }
      case "translate": {
        const language = String(action.args?.language || "").trim();
        if (!language) throw new Error("Translate requires a target language.");
        const res = await translateArticle({
          title: current.title,
          meta_description: current.meta_description,
          markdown: current.markdown,
          target_language: language,
        });
        const saved = await applyArticleUpdate(current, {
          title: res.title,
          meta_description: res.meta_description,
          markdown: res.markdown,
          word_count: res.word_count,
        });
        return { result: saved, note: `Article replaced with ${language} translation.` };
      }
      case "section_images": {
        if (!current.id) throw new Error("Save the article before adding section images.");
        setSectionImagesLoading(true);
        try {
          const res = await generateSectionImages(current.id);
          const saved = await applyArticleUpdate(current, {
            markdown: res.markdown,
            word_count: res.word_count,
          });
          const count = res.image_urls?.length || 0;
          return { result: saved, note: `Added ${count} section image${count === 1 ? "" : "s"}.` };
        } finally {
          setSectionImagesLoading(false);
        }
      }
      case "social": {
        setSocialLoading(true);
        setShareNote("");
        try {
          const res = await generateSocial({
            topic: topic.trim() || current.title,
            title: current.title,
            markdown: current.markdown,
          });
          setSocial(res);
          setSocialTab("thread");
          setSocialOpen(true);
          return { result: current, note: "Social pack ready — opened in a panel." };
        } finally {
          setSocialLoading(false);
        }
      }
      case "faq": {
        setFaqLoading(true);
        try {
          const res = await generateFaq({
            topic: topic.trim() || current.title,
            title: current.title,
            meta_description: current.meta_description,
            markdown: current.markdown,
            count: 5,
          });
          if (!res.items?.length) throw new Error("No FAQ could be generated.");
          setFaq(res);
          setFaqOpen(true);
          return {
            result: current,
            note: `Generated ${res.items.length} FAQ item${res.items.length === 1 ? "" : "s"}.`,
          };
        } finally {
          setFaqLoading(false);
        }
      }
      case "competitors": {
        setCompetitorLoading(true);
        try {
          const res = await analyzeCompetitors({
            topic: topic.trim() || current.title,
            keywords: current.keywords?.length ? current.keywords : keywordList,
          });
          setCompetitor(res);
          setCompetitorOpen(true);
          const gapCount = res.gaps?.length || 0;
          const pageCount = res.top_pages?.length || 0;
          return {
            result: current,
            note: `Scan complete — ${pageCount} top pages, ${gapCount} content gap${gapCount === 1 ? "" : "s"}.`,
          };
        } finally {
          setCompetitorLoading(false);
        }
      }
      case "export": {
        const fmt = String(action.args?.format || "pdf").toLowerCase();
        const kind = fmt === "html" ? "html" : "pdf";
        exportDocument(kind);
        return {
          result: current,
          note:
            kind === "pdf"
              ? "Opened the browser print dialog — pick 'Save as PDF' or a printer."
              : "Downloaded the article as a standalone .html file.",
        };
      }
      case "cover_image": {
        if (!current.id) {
          throw new Error("Save the article before generating a cover image.");
        }
        setCoverLoading(true);
        try {
          const saved = await generateCover(current.id);
          setResult(saved);
          setHistory((prev) => prev.map((h) => (h.id === saved.id ? saved : h)));
          return { result: saved, note: "Cover image generated and attached." };
        } finally {
          setCoverLoading(false);
        }
      }
      case "seo_report": {
        const report = analyzeSeo({
          markdown: current.markdown,
          title: current.title,
          meta: current.meta_description,
          keywords: current.keywords?.length ? current.keywords : keywordList,
          length: current.length || length,
        });
        return {
          result: current,
          note: `SEO score ${report.score}/100 · ${report.wordCount} words · Flesch ${report.fleschScore} (${report.fleschLabel}). See the SEO panel for the full breakdown.`,
        };
      }
      case "proofread": {
        const res = await editChat({
          title: current.title,
          meta_description: current.meta_description,
          markdown: current.markdown,
          messages: [
            {
              role: "user",
              content:
                "Proofread the article: fix ONLY grammar, spelling, and " +
                "punctuation errors. Do not change the meaning, wording, tone, or " +
                "structure beyond those corrections. Return the corrected article.",
            },
          ],
        });
        if (res.updated && res.markdown) {
          const saved = await applyArticleUpdate(current, {
            title: res.title,
            meta_description: res.meta_description,
            markdown: res.markdown,
            word_count: res.word_count,
          });
          return { result: saved, note: "Proofread — grammar & spelling fixed." };
        }
        return { result: current, note: res.reply || "No corrections were needed." };
      }
      case "summarize": {
        const res = await editChat({
          title: current.title,
          meta_description: current.meta_description,
          markdown: current.markdown,
          messages: [
            {
              role: "user",
              content:
                "Add a concise '## Key takeaways' section with 3–5 bullet points " +
                "summarizing the article. Place it right after the introduction " +
                "(near the top). Keep the rest of the article unchanged.",
            },
          ],
        });
        if (res.updated && res.markdown) {
          const saved = await applyArticleUpdate(current, {
            title: res.title,
            meta_description: res.meta_description,
            markdown: res.markdown,
            word_count: res.word_count,
          });
          return { result: saved, note: "Added a Key takeaways summary." };
        }
        return { result: current, note: res.reply || "Couldn't add a summary." };
      }
      default:
        throw new Error(`Unknown tool: ${action.tool}`);
    }
  }

  async function sendEditorMessage(e) {
    e?.preventDefault?.();
    const text = editorInput.trim();
    if (!text || !result || editorLoading) return;
    const nextMessages = [
      ...editorMessages.filter((m) => m.role === "user" || m.role === "assistant"),
      { role: "user", content: text },
    ];
    setEditorMessages((prev) => [...prev, { role: "user", content: text }]);
    setEditorInput("");
    setEditorLoading(true);
    setError("");
    try {
      const libraryRecent = (history || []).slice(0, 15).map((h) => ({
        id: h.id,
        title: h.title || "",
        topic: h.topic || "",
        word_count: h.word_count || 0,
        created_at: h.created_at || "",
      }));
      const plan = await planAgentActions({
        title: result.title,
        meta_description: result.meta_description,
        markdown: result.markdown,
        topic: topic.trim() || result.title,
        keywords: result.keywords?.length ? result.keywords : keywordList,
        tone: result.tone || tone,
        audience: result.audience || audience.trim() || "a general audience",
        messages: nextMessages,
        library_count: history?.length || 0,
        library_recent: libraryRecent,
      });
      const actions = Array.isArray(plan.actions) ? plan.actions : [];
      setEditorMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: plan.reply || (actions.length ? "Working on it." : "OK."),
          plannedActions: actions.length,
        },
      ]);
      let currentResult = result;
      for (const action of actions) {
        pushAgentStep({
          tool: action.tool,
          label: AGENT_TOOL_LABELS[action.tool] || action.tool,
          args: action.args || {},
          status: "running",
        });
        try {
          const stepRes = await runAgentAction(action, () => currentResult);
          currentResult = stepRes.result;
          updateLastAgentStep({ status: "done", note: stepRes.note });
        } catch (err) {
          updateLastAgentStep({ status: "error", note: err.message });
          break;
        }
      }
    } catch (err) {
      setEditorMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${err.message}`, error: true },
      ]);
    } finally {
      setEditorLoading(false);
    }
  }

  function resetEditor() {
    setEditorMessages([]);
    setEditorInput("");
  }

  function openAudio() {
    if (!result) return;
    setAudioOpen(true);
  }

  function playAudio() {
    if (!result) return;
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (!synth) return;
    synth.cancel();
    const text = markdownToPlain(result.markdown);
    if (!text) return;
    const utter = new SpeechSynthesisUtterance(text);
    if (audioVoiceIdx >= 0 && audioVoices[audioVoiceIdx]) {
      utter.voice = audioVoices[audioVoiceIdx];
      utter.lang = audioVoices[audioVoiceIdx].lang;
    }
    utter.rate = audioRate;
    utter.onend = () => setAudioStatus("idle");
    utter.onerror = () => setAudioStatus("idle");
    synth.speak(utter);
    setAudioStatus("playing");
  }

  function pauseAudio() {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (!synth) return;
    if (audioStatus === "playing") {
      synth.pause();
      setAudioStatus("paused");
    } else if (audioStatus === "paused") {
      synth.resume();
      setAudioStatus("playing");
    }
  }

  function stopAudio() {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (!synth) return;
    synth.cancel();
    setAudioStatus("idle");
  }

  async function handleSectionImages() {
    if (!result?.id || sectionImagesLoading) {
      if (!result?.id) setError("Save the article first to add section images.");
      return;
    }
    setSectionImagesLoading(true);
    setError("");
    try {
      const res = await generateSectionImages(result.id);
      const updated = { ...result, markdown: res.markdown, word_count: res.word_count };
      setResult(updated);
      setHistory((prev) => prev.map((h) => (h.id === result.id ? { ...h, ...updated } : h)));
      setFaq(null);
      setSocial(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSectionImagesLoading(false);
    }
  }

  async function runTranslation() {
    if (!result || translateLoading) return;
    setTranslateLoading(true);
    setError("");
    try {
      const res = await translateArticle({
        title: result.title,
        meta_description: result.meta_description,
        markdown: result.markdown,
        target_language: translateLang,
      });
      setTranslation(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setTranslateLoading(false);
    }
  }

  async function replaceWithTranslation() {
    if (!translation || !result) return;
    const updated = {
      ...result,
      title: translation.title,
      meta_description: translation.meta_description,
      markdown: translation.markdown,
      word_count: translation.word_count,
    };
    setResult(updated);
    setTranslateOpen(false);
    setTranslation(null);
    setFaq(null);
    setSocial(null);
    if (result.id) {
      try {
        const saved = await updateArticle(result.id, {
          title: updated.title,
          meta_description: updated.meta_description,
          markdown: updated.markdown,
          word_count: updated.word_count,
        });
        setResult(saved);
        setHistory((prev) => prev.map((h) => (h.id === saved.id ? saved : h)));
      } catch {
        /* keep local update if persist fails */
      }
    }
  }

  async function handleImproveSeo() {
    if (!result || improvingSeo || !seo) return;
    setImprovingSeo(true);
    setError("");
    setFaq(null);
    setSocial(null);
    try {
      const issues = seo.checks
        .filter((c) => c.status !== "good")
        .map((c) => `${c.label}: ${c.detail}`);
      const res = await improveSeo({
        topic: topic.trim() || result.title,
        title: result.title,
        meta_description: result.meta_description,
        markdown: result.markdown,
        keywords: result.keywords?.length ? result.keywords : keywordList,
        tone: result.tone || tone,
        audience: result.audience || audience.trim() || "a general audience",
        issues,
      });
      const updated = {
        ...result,
        title: res.title,
        meta_description: res.meta_description,
        markdown: res.markdown,
        word_count: res.word_count,
      };
      setResult(updated);
      if (result.id) {
        try {
          const saved = await updateArticle(result.id, {
            title: updated.title,
            meta_description: updated.meta_description,
            markdown: updated.markdown,
            word_count: updated.word_count,
          });
          setResult(saved);
          setHistory((prev) => prev.map((h) => (h.id === saved.id ? saved : h)));
        } catch {
          /* keep local update if persist fails */
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setImprovingSeo(false);
    }
  }

  async function handleFaq() {
    if (!result) return;
    setFaqOpen(true);
    if (faq || faqLoading) return;
    await runFaq();
  }

  async function runFaq() {
    if (!result) return;
    setFaqLoading(true);
    setError("");
    try {
      const res = await generateFaq({
        topic: topic.trim() || result.title,
        title: result.title,
        meta_description: result.meta_description,
        markdown: result.markdown,
        count: 5,
      });
      if (!res.items?.length) {
        setError("No FAQ could be generated. Please try again.");
        return;
      }
      setFaq(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setFaqLoading(false);
    }
  }

  async function handleSocial() {
    if (!result) return;
    setShareNote("");
    setSocialOpen(true);
    if (social || socialLoading) return;
    await runSocial();
  }

  async function runSocial() {
    if (!result) return;
    setSocialLoading(true);
    setError("");
    try {
      const res = await generateSocial({
        topic: topic.trim() || result.title,
        title: result.title,
        markdown: result.markdown,
      });
      setSocial(res);
      setSocialTab("thread");
    } catch (err) {
      setError(err.message);
    } finally {
      setSocialLoading(false);
    }
  }

  function copyText(text, key) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    });
  }

  async function downloadImage(url, baseName) {
    if (!url) return;
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const ext = blob.type.includes("png") ? "png" : "jpg";
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = `${slugify(baseName || "article")}-linkedin.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
    } catch {
      // Fallback: open the image so the user can save it manually.
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  function shareTo(platform, text, subject = "") {
    if (!text) return;
    try {
      navigator.clipboard.writeText(text);
    } catch {
      /* clipboard may be blocked; paste fallback still works */
    }
    if (platform === "email") {
      window.location.href = `mailto:?subject=${encodeURIComponent(
        subject
      )}&body=${encodeURIComponent(text)}`;
      return;
    }
    if (platform === "linkedin") {
      // LinkedIn truncates URL-prefilled text, so open an empty composer and paste instead.
      setShareNote(
        result?.cover_url
          ? "Post copied — press Ctrl/Cmd+V to paste, then attach your downloaded image."
          : "Full LinkedIn post copied — press Ctrl/Cmd+V to paste it in the composer."
      );
      setTimeout(() => setShareNote(""), 6000);
      window.open(
        "https://www.linkedin.com/feed/?shareActive=true",
        "_blank",
        "noopener,noreferrer"
      );
      return;
    }
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`,
      "_blank",
      "noopener,noreferrer"
    );
  }

  async function handleRewrite() {
    if (sectionIdx === "" || !result || rewriting) return;
    const idx = Number(sectionIdx);
    const secs = splitSections(result.markdown);
    const target = secs[idx];
    if (!target) return;
    setRewriting(true);
    setError("");
    try {
      const { markdown: newSection } = await rewriteSection({
        section: target.text,
        topic: topic.trim(),
        tone,
        audience: audience.trim() || "a general audience",
        instruction: rewriteHint.trim(),
      });
      secs[idx] = { ...target, text: newSection.trim() };
      const newMarkdown = secs
        .map((s) => s.text)
        .join("\n\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const updated = { ...result, markdown: newMarkdown, word_count: countWords(newMarkdown) };
      setResult(updated);
      setRewriteHint("");
      setSectionIdx("");
      if (result.id) {
        try {
          const saved = await updateArticle(result.id, {
            markdown: newMarkdown,
            word_count: updated.word_count,
          });
          setResult(saved);
          setHistory((prev) => prev.map((h) => (h.id === saved.id ? saved : h)));
        } catch {
          /* keep local update if persist fails */
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setRewriting(false);
    }
  }

  async function handleCover() {
    if (!result?.id || coverLoading) return;
    setCoverLoading(true);
    setError("");
    try {
      const updated = await generateCover(result.id);
      setResult(updated);
      setHistory((prev) => prev.map((h) => (h.id === updated.id ? updated : h)));
    } catch (err) {
      setError(err.message);
    } finally {
      setCoverLoading(false);
    }
  }

  async function makeOutline() {
    if (topic.trim().length < 3 || loading || outlineLoading) return;
    setError("");
    setResult(null);
    setStream(null);
    setOutline(null);
    setSuggestOpen(false);
    setSuggestions([]);
    setOutlineLoading(true);
    try {
      const { sections } = await generateOutline(currentPayload());
      setOutline(sections.length ? sections : [{ heading: "", points: "" }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setOutlineLoading(false);
    }
  }

  async function expandOutline() {
    if (!outline || loading) return;
    const cleaned = outline.filter((s) => s.heading.trim());
    if (!cleaned.length) {
      setError("Add at least one section to the outline.");
      return;
    }
    await runGeneration({ ...currentPayload(), outline: cleaned }, expandOutlineStream);
  }

  function updateSection(i, field, value) {
    setOutline((prev) => prev.map((s, idx) => (idx === i ? { ...s, [field]: value } : s)));
  }

  function addSection() {
    setOutline((prev) => [...(prev || []), { heading: "", points: "" }]);
  }

  function removeSection(i) {
    setOutline((prev) => {
      const next = (prev || []).filter((_, idx) => idx !== i);
      return next.length ? next : null;
    });
  }

  function moveSection(i, dir) {
    setOutline((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function openSuggest() {
    if (suggestLoading) return;
    setSuggestOpen(true);
    setSuggestLoading(true);
    setError("");
    try {
      const existing = (outline || []).map((s) => s.heading).filter(Boolean);
      const { sections } = await suggestSections({ ...currentPayload(), existing });
      setSuggestions(sections || []);
    } catch (err) {
      setError(err.message);
      setSuggestions([]);
    } finally {
      setSuggestLoading(false);
    }
  }

  function addSuggestion(i) {
    const s = suggestions[i];
    if (!s) return;
    setOutline((prev) => [...(prev || []), { heading: s.heading, points: s.points || "" }]);
    setSuggestions((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function copyMarkdown() {
    if (!result) return;
    await navigator.clipboard.writeText(result.markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function downloadMarkdown() {
    if (!result) return;
    const slug =
      (result.title || "article")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "article";
    const blob = new Blob([result.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportDocument(kind) {
    if (!result) return;
    const html = buildExportHtml({
      title: result.title,
      metaDescription: result.meta_description,
      articleHtml,
      coverUrl: result.cover_url,
    });
    if (kind === "pdf") {
      if (!openPrintWindow(html)) setError("Please allow pop-ups to export as PDF.");
      return;
    }
    downloadHtmlFile(`${slugify(result.title)}.html`, html);
  }

  return (
    <>
      <header className="header">
        <h1>Generate SEO-ready articles in seconds</h1>
        <p>
          Describe your topic and a few keywords — get a formatted, publish-ready draft with a
          title and meta description.
        </p>
      </header>

      <div className="layout">
        <form className="card form" onSubmit={handleSubmit}>
          <div className="field">
            <div className="field-head">
              <label htmlFor="topic">
                Topic <span className="req">*</span>
              </label>
              <span className="counter">{topic.length}/200</span>
            </div>
            <input
              id="topic"
              type="text"
              value={topic}
              maxLength={200}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. Benefits of remote work"
              required
              minLength={3}
            />
          </div>

          <div className="field">
            <div className="field-head">
              <label htmlFor="keywords">SEO keywords</label>
              <button
                type="button"
                className="kw-suggest-btn"
                onClick={handleSuggestKeywords}
                disabled={kwLoading || topic.trim().length < 3}
                title={
                  topic.trim().length < 3
                    ? "Enter a topic first"
                    : "Let AI suggest SEO keywords for this topic"
                }
              >
                {kwLoading ? "Suggesting…" : "✨ Suggest"}
              </button>
            </div>
            <input
              id="keywords"
              type="text"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="remote work, productivity, work-life balance"
            />
            {keywordList.length > 0 && (
              <div className="chips">
                {keywordList.map((k, i) => (
                  <span className="chip" key={`${k}-${i}`}>
                    {k}
                  </span>
                ))}
              </div>
            )}
            {kwError && <span className="hint kw-error">{kwError}</span>}
            {kwSuggestions.length > 0 && (
              <div className="kw-suggest">
                <span className="hint kw-suggest-label">Tap to add:</span>
                <div className="chips">
                  {kwSuggestions.map((k, i) => (
                    <button
                      type="button"
                      className="chip chip-add"
                      key={`${k}-${i}`}
                      onClick={() => addSuggestedKeyword(k)}
                    >
                      + {k}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <span className="hint">Separate keywords with commas.</span>
          </div>

          <div className="field">
            <label htmlFor="audience">Target audience</label>
            <input
              id="audience"
              type="text"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder="a general audience"
            />
          </div>

          <div className="field">
            <label htmlFor="tone">Tone</label>
            <select id="tone" value={tone} onChange={(e) => setTone(e.target.value)}>
              {TONES.map((t) => (
                <option key={t} value={t}>
                  {t[0].toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Length</label>
            <div className="segment" role="group" aria-label="Article length">
              {LENGTHS.map((l) => (
                <button
                  type="button"
                  key={l.value}
                  className={`segment-item ${length === l.value ? "active" : ""}`}
                  aria-pressed={length === l.value}
                  onClick={() => setLength(l.value)}
                >
                  <span>{l.label}</span>
                  <small>{l.hint}</small>
                </button>
              ))}
            </div>
          </div>

          <button className="generate" type="submit" disabled={!canSubmit}>
            {loading ? (
              <>
                <span className="spinner" /> Researching…
              </>
            ) : clarifyLoading ? (
              <>
                <span className="spinner" /> Checking topic…
              </>
            ) : (
              "🌐 Generate article"
            )}
          </button>

          <button
            type="button"
            className="ghost outline-toggle"
            onClick={makeOutline}
            disabled={topic.trim().length < 3 || loading || outlineLoading}
          >
            {outlineLoading ? "Building outline…" : "Outline first"}
          </button>

          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
        </form>

        <section className="card output">
          {!result && !loading && !outline && !outlineLoading && (
            <div className="placeholder">
              <div className="placeholder-icon">📝</div>
              <h3>Your article will appear here</h3>
              <p>
                Fill in a topic and hit <strong>Generate</strong> — or start with an{" "}
                <strong>outline</strong>.
              </p>
            </div>
          )}

          {outlineLoading && (
            <div className="placeholder">
              <span className="spinner spinner-lg" />
              <h3>Building your outline…</h3>
              <p>Then you can edit it before writing.</p>
            </div>
          )}

          {outline && !loading && (
            <div className="outline">
              <div className="outline-head">
                <h3>Outline</h3>
                <p>Edit the sections, then write the full article.</p>
              </div>
              {outline.map((sec, i) => (
                <div className="outline-item" key={i}>
                  <div className="outline-item-top">
                    <input
                      type="text"
                      value={sec.heading}
                      onChange={(e) => updateSection(i, "heading", e.target.value)}
                      placeholder="Section heading"
                    />
                    <div className="outline-item-actions">
                      <button type="button" onClick={() => moveSection(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                      <button type="button" onClick={() => moveSection(i, 1)} disabled={i === outline.length - 1} aria-label="Move down">↓</button>
                      <button type="button" onClick={() => removeSection(i)} aria-label="Remove section">×</button>
                    </div>
                  </div>
                  <textarea
                    value={sec.points}
                    onChange={(e) => updateSection(i, "points", e.target.value)}
                    placeholder="Key points (one per line)"
                    rows={3}
                  />
                </div>
              ))}
              <div className="outline-add">
                <button
                  type="button"
                  className="ghost"
                  onClick={openSuggest}
                  disabled={suggestLoading}
                >
                  {suggestLoading ? (
                    <>
                      <span className="spinner" /> Finding ideas…
                    </>
                  ) : (
                    "+ Add section"
                  )}
                </button>
                {suggestOpen && (
                  <div className="suggest-panel">
                    {suggestions.length > 0
                      ? suggestions.map((s, i) => (
                          <button
                            type="button"
                            key={`${s.heading}-${i}`}
                            className="suggest-item"
                            onClick={() => addSuggestion(i)}
                          >
                            <span className="suggest-plus">＋</span>
                            <span className="suggest-text">
                              <strong>{s.heading}</strong>
                              {s.points && <small>{s.points.split("\n")[0]}</small>}
                            </span>
                          </button>
                        ))
                      : !suggestLoading && (
                          <p className="suggest-empty">No new ideas right now.</p>
                        )}
                    <button
                      type="button"
                      className="suggest-blank"
                      onClick={() => {
                        addSection();
                        setSuggestOpen(false);
                      }}
                    >
                      Add a blank section instead
                    </button>
                  </div>
                )}
              </div>

              <div className="outline-footer">
                <button type="button" className="generate" onClick={expandOutline} disabled={loading}>
                  Write article →
                </button>
              </div>
            </div>
          )}

          {loading && !stream?.hasArticle && (
            <div className="placeholder">
              <span className="spinner spinner-lg" />
              <h3>{researching ? "Researching your topic…" : "Writing your article…"}</h3>
              <p>
                {researching
                  ? "Gathering live sources for accuracy…"
                  : "Streaming in from Gemini…"}
              </p>
              <div className="skeleton">
                <span />
                <span />
                <span />
                <span />
              </div>
            </div>
          )}

          {loading && stream?.hasArticle && (
            <>
              <div className="output-meta">
                <span className="meta-stat">
                  <span className="spinner" /> writing…
                </span>
              </div>
              {cleanMeta(stream.meta) && (
                <div className="meta-desc">
                  <span className="meta-desc-label">Meta description</span>
                  {cleanMeta(stream.meta)}
                </div>
              )}
              <article
                className="article streaming"
                dangerouslySetInnerHTML={{ __html: streamHtml }}
              />
            </>
          )}

          {result && !loading && (
            <>
              <div className="output-meta">
                <span className="meta-stat">📄 {result.word_count} words</span>
                <span className="meta-stat">⏱ {readingTime} min read</span>
                <div className="output-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={regenerate}
                    disabled={loading}
                  >
                    ↻ Regenerate
                  </button>
                  <button type="button" className="ghost" onClick={openEditor}>
                    🤖 AI agent
                  </button>

                  <div className="action-menu">
                    <button
                      type="button"
                      className="ghost"
                      aria-haspopup="menu"
                      aria-expanded={openMenu === "export"}
                      onClick={() => setOpenMenu(openMenu === "export" ? null : "export")}
                    >
                      Export ▾
                    </button>
                    {openMenu === "export" && (
                      <div className="action-menu-items" role="menu">
                        <button
                          type="button"
                          onClick={() => {
                            copyMarkdown();
                            setOpenMenu(null);
                          }}
                        >
                          {copied ? "Copied!" : "Copy Markdown"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            downloadMarkdown();
                            setOpenMenu(null);
                          }}
                        >
                          Download .md
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            exportDocument("html");
                            setOpenMenu(null);
                          }}
                        >
                          Download HTML
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            exportDocument("pdf");
                            setOpenMenu(null);
                          }}
                        >
                          Print / PDF
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="action-menu">
                    <button
                      type="button"
                      className="ghost"
                      aria-haspopup="menu"
                      aria-expanded={openMenu === "media"}
                      onClick={() => setOpenMenu(openMenu === "media" ? null : "media")}
                    >
                      Media ▾
                    </button>
                    {openMenu === "media" && (
                      <div className="action-menu-items" role="menu">
                        {result.id && (
                          <button
                            type="button"
                            onClick={() => {
                              handleCover();
                              setOpenMenu(null);
                            }}
                            disabled={coverLoading}
                          >
                            {coverLoading
                              ? "Creating cover…"
                              : result.cover_url
                              ? "🖼 New cover"
                              : "🖼 Cover image"}
                          </button>
                        )}
                        {result.id && (
                          <button
                            type="button"
                            onClick={() => {
                              handleSectionImages();
                              setOpenMenu(null);
                            }}
                            disabled={sectionImagesLoading}
                          >
                            {sectionImagesLoading ? "Adding images…" : "🖼 Section images"}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            openAudio();
                            setOpenMenu(null);
                          }}
                        >
                          🎧 Listen (audio)
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="action-menu">
                    <button
                      type="button"
                      className="ghost"
                      aria-haspopup="menu"
                      aria-expanded={openMenu === "repurpose"}
                      onClick={() => setOpenMenu(openMenu === "repurpose" ? null : "repurpose")}
                    >
                      Repurpose ▾
                    </button>
                    {openMenu === "repurpose" && (
                      <div className="action-menu-items" role="menu">
                        <button
                          type="button"
                          onClick={() => {
                            openTranslate();
                            setOpenMenu(null);
                          }}
                        >
                          🌐 Translate
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            handleFaq();
                            setOpenMenu(null);
                          }}
                        >
                          ❓ FAQ
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            handleSocial();
                            setOpenMenu(null);
                          }}
                        >
                          🔁 Social posts
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {result.cover_url && (
                <img
                  className="cover-img"
                  src={result.cover_url}
                  alt={`Cover for ${result.title}`}
                />
              )}

              <div className="meta-desc">
                <span className="meta-desc-label">Meta description</span>
                {result.meta_description}
              </div>

              {seo && (
                <details className="seo-panel">
                  <summary>
                    <span className={`seo-score ${seoTier(seo.score)}`}>{seo.score}</span>
                    <span className="seo-title">SEO analysis</span>
                    <span className="seo-hint">
                      {seo.checks.filter((c) => c.status === "good").length}/{seo.checks.length}{" "}
                      checks passed
                    </span>
                    {seo.score < 100 && (
                      <button
                        type="button"
                        className="seo-fix-btn"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleImproveSeo();
                        }}
                        disabled={improvingSeo}
                      >
                        {improvingSeo ? (
                          <>
                            <span className="spinner" /> Improving…
                          </>
                        ) : (
                          "✨ Improve SEO"
                        )}
                      </button>
                    )}
                  </summary>
                  <div className="seo-body">
                    <div className="seo-stats">
                      <div>
                        <b>{seo.wordCount}</b>
                        <span>words</span>
                      </div>
                      <div>
                        <b>{seo.readingTime}m</b>
                        <span>read</span>
                      </div>
                      <div>
                        <b>{seo.fleschScore}</b>
                        <span>readability</span>
                      </div>
                      <div>
                        <b>{seo.headings.h2}</b>
                        <span>sections</span>
                      </div>
                    </div>
                    <ul className="seo-checks">
                      {seo.checks.map((c, i) => (
                        <li key={i} className={`seo-check ${c.status}`}>
                          <span className="seo-dot" />
                          <span className="seo-check-label">{c.label}</span>
                          <span className="seo-check-detail">{c.detail}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </details>
              )}

              <article
                className="article"
                dangerouslySetInnerHTML={{ __html: articleHtml }}
              />

              {sections.length > 1 && (
                <div className="rewrite-bar">
                  <select
                    value={sectionIdx}
                    onChange={(e) => setSectionIdx(e.target.value)}
                    aria-label="Section to rewrite"
                  >
                    <option value="">Rewrite a section…</option>
                    {sections.map((s) => (
                      <option key={s.index} value={s.index}>
                        {s.heading}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={rewriteHint}
                    onChange={(e) => setRewriteHint(e.target.value)}
                    placeholder="Optional: how? (e.g. more concise, add stats)"
                  />
                  <button
                    type="button"
                    className="ghost"
                    onClick={handleRewrite}
                    disabled={sectionIdx === "" || rewriting}
                  >
                    {rewriting ? "Rewriting…" : "Rewrite"}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {clarify && (
        <div className="modal-backdrop" onClick={dismissClarify}>
          <div
            className="clarify-modal card"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Which “{topic.trim()}” did you mean?</h3>
            <p className="clarify-sub">
              This could refer to a few things. Pick one so the article stays on target
              — or keep your original wording.
            </p>
            <div className="clarify-options">
              {clarify.options.map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  className="clarify-option"
                  onClick={() => chooseTopic(opt.label)}
                >
                  <strong>{opt.label}</strong>
                  {opt.description && <small>{opt.description}</small>}
                </button>
              ))}
            </div>
            <div className="clarify-foot">
              <button type="button" className="ghost" onClick={keepOriginalTopic}>
                Use “{topic.trim()}” as-is
              </button>
              <button type="button" className="ghost" onClick={dismissClarify}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {faqOpen && (
        <div className="modal-backdrop" onClick={() => setFaqOpen(false)}>
          <div
            className="tool-modal card"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tool-modal-head">
              <h3>❓ Frequently asked questions</h3>
              <div className="tool-modal-actions">
                {faq && !faqLoading && (
                  <button type="button" className="ghost" onClick={runFaq}>
                    ↻ Regenerate
                  </button>
                )}
                <button
                  type="button"
                  className="modal-close"
                  aria-label="Close"
                  onClick={() => setFaqOpen(false)}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="tool-modal-body">
              {faqLoading ? (
                <div className="tool-loading">
                  <span className="spinner spinner-lg" />
                  <p>Writing frequently asked questions…</p>
                </div>
              ) : faq && faq.items.length ? (
                <ul className="faq-list">
                  {faq.items.map((it, i) => (
                    <li key={i}>
                      <p className="faq-q">{it.question}</p>
                      <p className="faq-a">{it.answer}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="tool-empty">
                  <p>Couldn't generate the FAQ.</p>
                  <button type="button" className="ghost" onClick={runFaq}>
                    Retry
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {audioOpen && (
        <div className="modal-backdrop" onClick={() => setAudioOpen(false)}>
          <div
            className="tool-modal card audio-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tool-modal-head">
              <h3>🎧 Listen to article</h3>
              <button
                type="button"
                className="modal-close"
                aria-label="Close"
                onClick={() => setAudioOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="tool-modal-body">
              {audioVoices.length === 0 ? (
                <div className="tool-empty">
                  <p>Your browser doesn't expose any speech voices.</p>
                </div>
              ) : (
                <>
                  <div className="audio-row">
                    <label htmlFor="audio-voice">Voice</label>
                    <select
                      id="audio-voice"
                      value={audioVoiceIdx}
                      onChange={(e) => setAudioVoiceIdx(Number(e.target.value))}
                    >
                      {audioVoices.map((v, i) => (
                        <option key={`${v.name}-${i}`} value={i}>
                          {v.name} · {v.lang}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="audio-row">
                    <label htmlFor="audio-rate">Speed</label>
                    <input
                      id="audio-rate"
                      type="range"
                      min="0.5"
                      max="2"
                      step="0.1"
                      value={audioRate}
                      onChange={(e) => setAudioRate(Number(e.target.value))}
                    />
                    <span className="audio-rate-val">{audioRate.toFixed(1)}x</span>
                  </div>
                  <div className="audio-controls">
                    {audioStatus === "idle" ? (
                      <button type="button" className="social-post-btn" onClick={playAudio}>
                        ▶ Play
                      </button>
                    ) : (
                      <>
                        <button type="button" className="social-post-btn" onClick={pauseAudio}>
                          {audioStatus === "paused" ? "▶ Resume" : "⏸ Pause"}
                        </button>
                        <button type="button" className="ghost" onClick={stopAudio}>
                          ⏹ Stop
                        </button>
                        <button type="button" className="ghost" onClick={playAudio}>
                          ↻ Restart
                        </button>
                      </>
                    )}
                  </div>
                  <p className="audio-note">
                    Uses your browser's built-in voices (free, offline). Quality depends on your OS.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {editorOpen && (
        <div className="modal-backdrop" onClick={() => setEditorOpen(false)}>
          <div
            className="tool-modal card editor-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tool-modal-head">
              <h3>🤖 AI agent</h3>
              <div className="tool-modal-actions">
                {editorMessages.length > 0 && (
                  <button type="button" className="ghost" onClick={resetEditor}>
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  className="modal-close"
                  aria-label="Close"
                  onClick={() => setEditorOpen(false)}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="editor-body">
              {editorMessages.length === 0 && !editorLoading && (
                <div className="editor-empty">
                  <p>
                    Ask in plain English — the agent picks the right tools and runs them for you.
                    Try:
                  </p>
                  <ul>
                    <li>Translate this to Spanish and add section images.</li>
                    <li>Boost the SEO score and shorten the intro.</li>
                    <li>Generate a social pack and an FAQ.</li>
                    <li>Print this article / download as HTML.</li>
                    <li>Scan competitors for this topic.</li>
                    <li>How many articles do I have?</li>
                  </ul>
                </div>
              )}
              {editorMessages.map((m, i) => {
                if (m.role === "agent") {
                  const statusIcon =
                    m.status === "done" ? "✓" : m.status === "error" ? "✗" : "•";
                  const detail =
                    m.tool === "translate" && m.args?.language
                      ? ` → ${m.args.language}`
                      : m.tool === "edit" && m.args?.instruction
                      ? ` → ${m.args.instruction.slice(0, 80)}${m.args.instruction.length > 80 ? "…" : ""}`
                      : "";
                  return (
                    <div key={i} className={`agent-step agent-step-${m.status}`}>
                      <span className="agent-step-icon">
                        {m.status === "running" ? <span className="spinner" /> : statusIcon}
                      </span>
                      <div className="agent-step-body">
                        <span className="agent-step-label">
                          {m.label}
                          {detail}
                        </span>
                        {m.note && <span className="agent-step-note">{m.note}</span>}
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={i} className={`editor-msg ${m.role} ${m.error ? "error" : ""}`}>
                    <span className="editor-msg-role">{m.role === "user" ? "You" : "AI"}</span>
                    <div className="editor-msg-body">
                      <p>{m.content}</p>
                      {m.plannedActions > 0 && (
                        <span className="editor-msg-tag">
                          Running {m.plannedActions} action{m.plannedActions === 1 ? "" : "s"}…
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              {editorLoading && (
                <div className="editor-msg assistant">
                  <span className="editor-msg-role">AI</span>
                  <div className="editor-msg-body">
                    <span className="spinner" /> Thinking…
                  </div>
                </div>
              )}
            </div>
            <form className="editor-input" onSubmit={sendEditorMessage}>
              <input
                type="text"
                value={editorInput}
                onChange={(e) => setEditorInput(e.target.value)}
                placeholder="Ask the agent to do anything — translate, improve SEO, add images…"
                aria-label="Message for the AI agent"
                disabled={editorLoading}
                autoFocus
              />
              <button
                type="submit"
                className="social-post-btn"
                disabled={editorLoading || !editorInput.trim()}
              >
                Run
              </button>
            </form>
          </div>
        </div>
      )}

      {competitorOpen && (
        <div className="modal-backdrop" onClick={() => setCompetitorOpen(false)}>
          <div
            className="tool-modal card"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tool-modal-head">
              <h3>🔎 Competitor scan</h3>
              <div className="tool-modal-actions">
                {competitor && !competitorLoading && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setCompetitor(null);
                      handleCompetitorScan();
                    }}
                  >
                    ↻ Rescan
                  </button>
                )}
                <button
                  type="button"
                  className="modal-close"
                  aria-label="Close"
                  onClick={() => setCompetitorOpen(false)}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="tool-modal-body">
              {competitorLoading ? (
                <div className="tool-loading">
                  <span className="spinner spinner-lg" />
                  <p>Analysing top-ranking pages…</p>
                </div>
              ) : competitor ? (
                <>
                  {competitor.word_count_target > 0 && (
                    <div className="comp-target">
                      Aim for <b>~{competitor.word_count_target}</b> words to compete.
                    </div>
                  )}
                  {competitor.top_pages.length > 0 && (
                    <>
                      <h4 className="comp-heading">Top-ranking pages</h4>
                      <ul className="comp-pages">
                        {competitor.top_pages.map((p, i) => (
                          <li key={i} className="comp-page">
                            <a
                              href={p.url}
                              target="_blank"
                              rel="noreferrer"
                              className="comp-page-title"
                            >
                              {p.title || p.url}
                            </a>
                            {p.summary && <p className="comp-page-sum">{p.summary}</p>}
                            {p.angles.length > 0 && (
                              <div className="sf-tags">
                                {p.angles.map((a, j) => (
                                  <span key={j}>{a}</span>
                                ))}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {competitor.gaps.length > 0 && (
                    <>
                      <h4 className="comp-heading">Gaps to fill</h4>
                      <ul className="comp-list">
                        {competitor.gaps.map((g, i) => (
                          <li key={i}>{g}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {competitor.suggested_sections.length > 0 && (
                    <>
                      <div className="comp-sections-head">
                        <h4 className="comp-heading">Suggested sections</h4>
                        <button
                          type="button"
                          className="social-post-btn"
                          onClick={useCompetitorSections}
                        >
                          Use as outline →
                        </button>
                      </div>
                      <ul className="comp-list">
                        {competitor.suggested_sections.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {!competitor.top_pages.length &&
                    !competitor.gaps.length &&
                    !competitor.suggested_sections.length && (
                      <div className="tool-empty">
                        <p>No results returned. Try a more specific topic or refine keywords.</p>
                      </div>
                    )}
                </>
              ) : (
                <div className="tool-empty">
                  <p>No data yet.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {translateOpen && (
        <div className="modal-backdrop" onClick={() => setTranslateOpen(false)}>
          <div
            className="tool-modal card translate-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tool-modal-head">
              <h3>🌐 Translate article</h3>
              <button
                type="button"
                className="modal-close"
                aria-label="Close"
                onClick={() => setTranslateOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="tool-modal-body">
              <div className="translate-controls">
                <label htmlFor="translate-lang">Target language</label>
                <select
                  id="translate-lang"
                  value={translateLang}
                  onChange={(e) => setTranslateLang(e.target.value)}
                >
                  {TRANSLATION_LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="social-post-btn"
                  onClick={runTranslation}
                  disabled={translateLoading}
                >
                  {translateLoading ? (
                    <>
                      <span className="spinner" /> Translating…
                    </>
                  ) : translation ? (
                    "Retranslate"
                  ) : (
                    "Translate"
                  )}
                </button>
              </div>
              {translation && !translateLoading && (
                <>
                  <div className="translate-actions">
                    <span className="social-tweet-count">
                      {translation.word_count} words · {translation.target_language}
                    </span>
                    <div className="social-head-actions">
                      <button
                        type="button"
                        className="social-tweet-copy"
                        onClick={() => copyText(translation.markdown, "tr")}
                      >
                        {copiedKey === "tr" ? "Copied!" : "Copy Markdown"}
                      </button>
                      <button
                        type="button"
                        className="social-post-btn"
                        onClick={replaceWithTranslation}
                      >
                        Replace article
                      </button>
                    </div>
                  </div>
                  <div className="translate-grid">
                    <div className="translate-col">
                      <div className="translate-col-head">Original</div>
                      <h4 className="translate-title">{result.title}</h4>
                      <p className="translate-meta">{result.meta_description}</p>
                      <div
                        className="article translate-body"
                        dangerouslySetInnerHTML={{ __html: articleHtml }}
                      />
                    </div>
                    <div className="translate-col">
                      <div className="translate-col-head">{translation.target_language}</div>
                      <h4 className="translate-title">{translation.title}</h4>
                      <p className="translate-meta">{translation.meta_description}</p>
                      <div
                        className="article translate-body"
                        dangerouslySetInnerHTML={{
                          __html: DOMPurify.sanitize(marked.parse(translation.markdown)),
                        }}
                      />
                    </div>
                  </div>
                </>
              )}
              {!translation && !translateLoading && (
                <div className="tool-empty">
                  <p>Pick a language and click Translate to get a side-by-side view.</p>
                </div>
              )}
              {translateLoading && (
                <div className="tool-loading">
                  <span className="spinner spinner-lg" />
                  <p>Translating into {translateLang}…</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {socialOpen && (
        <div className="modal-backdrop" onClick={() => setSocialOpen(false)}>
          <div
            className="tool-modal card"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tool-modal-head">
              <h3>🔁 Repurpose to social</h3>
              <div className="tool-modal-actions">
                {social && !socialLoading && (
                  <button type="button" className="ghost" onClick={runSocial}>
                    ↻ Regenerate
                  </button>
                )}
                <button
                  type="button"
                  className="modal-close"
                  aria-label="Close"
                  onClick={() => setSocialOpen(false)}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="tool-modal-body">
              {socialLoading ? (
                <div className="tool-loading">
                  <span className="spinner spinner-lg" />
                  <p>Repurposing into social posts…</p>
                </div>
              ) : social ? (
                <>
                  <div className="social-tabs">
                    <button
                      type="button"
                      className={socialTab === "thread" ? "active" : ""}
                      onClick={() => setSocialTab("thread")}
                    >
                      X thread
                    </button>
                    <button
                      type="button"
                      className={socialTab === "linkedin" ? "active" : ""}
                      onClick={() => setSocialTab("linkedin")}
                    >
                      LinkedIn
                    </button>
                    <button
                      type="button"
                      className={socialTab === "newsletter" ? "active" : ""}
                      onClick={() => setSocialTab("newsletter")}
                    >
                      Newsletter
                    </button>
                  </div>
                  <div className="social-body">
                    {shareNote && <div className="social-note">✓ {shareNote}</div>}
                    {socialTab === "thread" &&
                      (social.thread.length ? (
                        <>
                          <div className="social-single-head">
                            <span className="social-field-label">
                              {social.thread.length} posts
                            </span>
                            <div className="social-head-actions">
                              <button
                                type="button"
                                className="social-post-btn"
                                onClick={() => shareTo("x", social.thread[0])}
                              >
                                Post to X
                              </button>
                              <button
                                type="button"
                                className="social-tweet-copy"
                                onClick={() => copyText(social.thread.join("\n\n"), "all")}
                              >
                                {copiedKey === "all" ? "Copied!" : "Copy all"}
                              </button>
                            </div>
                          </div>
                          {social.thread.map((t, i) => (
                            <div key={i} className="social-tweet">
                              <div className="social-tweet-top">
                                <span className="social-tweet-n">
                                  {i + 1}/{social.thread.length}
                                </span>
                                <span
                                  className={`social-tweet-count ${
                                    t.length > 280 ? "over" : ""
                                  }`}
                                >
                                  {t.length}/280
                                </span>
                                <button
                                  type="button"
                                  className="social-tweet-copy"
                                  onClick={() => copyText(t, `t${i}`)}
                                >
                                  {copiedKey === `t${i}` ? "Copied!" : "Copy"}
                                </button>
                              </div>
                              <p>{t}</p>
                            </div>
                          ))}
                        </>
                      ) : (
                        <p className="social-text">No thread was generated.</p>
                      ))}
                    {socialTab === "linkedin" && (
                      <div className="social-field">
                        <div className="social-single-head">
                          <span className="social-tweet-count">
                            {social.linkedin.length} chars
                          </span>
                          <div className="social-head-actions">
                            <button
                              type="button"
                              className="social-post-btn"
                              onClick={() => shareTo("linkedin", social.linkedin)}
                            >
                              Post to LinkedIn
                            </button>
                            <button
                              type="button"
                              className="social-tweet-copy"
                              onClick={() => copyText(social.linkedin, "li")}
                            >
                              {copiedKey === "li" ? "Copied!" : "Copy"}
                            </button>
                          </div>
                        </div>
                        <div className="social-formatted">
                          {parseFormatted(social.linkedin).map((b, i) =>
                            b.type === "ul" ? (
                              <ul key={i} className="sf-list">
                                {b.items.map((it, j) => (
                                  <li key={j}>{it}</li>
                                ))}
                              </ul>
                            ) : b.type === "tags" ? (
                              <div key={i} className="sf-tags">
                                {b.items.map((t, j) => (
                                  <span key={j}>{t}</span>
                                ))}
                              </div>
                            ) : (
                              <p key={i} className="sf-p">
                                {b.text}
                              </p>
                            )
                          )}
                        </div>
                        <div className="social-image">
                          {result?.cover_url ? (
                            <>
                              <img
                                className="social-image-preview"
                                src={result.cover_url}
                                alt={`Image for ${result.title}`}
                              />
                              <div className="social-image-bar">
                                <span className="social-image-hint">
                                  LinkedIn can't attach images from pasted text — download
                                  this and add it to your post.
                                </span>
                                <div className="social-head-actions">
                                  {result.id && (
                                    <button
                                      type="button"
                                      className="social-tweet-copy"
                                      onClick={handleCover}
                                      disabled={coverLoading}
                                    >
                                      {coverLoading ? "Generating…" : "↻ New image"}
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="social-post-btn"
                                    onClick={() => downloadImage(result.cover_url, result.title)}
                                  >
                                    ⬇ Download image
                                  </button>
                                </div>
                              </div>
                            </>
                          ) : (
                            <div className="social-image-empty">
                              <span className="social-image-hint">
                                🖼 A LinkedIn post with an image gets far more engagement.
                                {result?.id
                                  ? " Generate a relevant image to attach."
                                  : " Save the article first to add one."}
                              </span>
                              {result?.id && (
                                <button
                                  type="button"
                                  className="social-post-btn"
                                  onClick={handleCover}
                                  disabled={coverLoading}
                                >
                                  {coverLoading ? "Generating image…" : "🖼 Generate image"}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {socialTab === "newsletter" && (
                      <div className="social-newsletter">
                        <div className="social-single-head">
                          <span className="social-field-label">Newsletter</span>
                          <div className="social-head-actions">
                            <button
                              type="button"
                              className="social-post-btn"
                              onClick={() =>
                                shareTo("email", newsletter.emailBody, newsletter.subject)
                              }
                            >
                              Open in email
                            </button>
                            <button
                              type="button"
                              className="social-tweet-copy"
                              onClick={() => copyText(newsletter.text, "nl")}
                            >
                              {copiedKey === "nl" ? "Copied!" : "Copy all"}
                            </button>
                          </div>
                        </div>
                        {newsletter.subject && (
                          <div className="nl-subject">
                            <span className="social-field-label">Subject</span>
                            <p className="social-text">{newsletter.subject}</p>
                            {newsletter.preview && (
                              <p className="nl-preview">{newsletter.preview}</p>
                            )}
                          </div>
                        )}
                        {newsletter.intro && (
                          <p className="social-text nl-intro">{newsletter.intro}</p>
                        )}
                        {newsletter.highlights.length > 0 && (
                          <div className="nl-grid">
                            {newsletter.highlights.map((h, i) => (
                              <div key={i} className="nl-card">
                                {h.head && <h4>{h.head}</h4>}
                                <p>{h.text}</p>
                              </div>
                            ))}
                          </div>
                        )}
                        {newsletter.whyItMatters && (
                          <div className="nl-why">
                            <span className="social-field-label">Why it matters</span>
                            <p className="social-text">{newsletter.whyItMatters}</p>
                          </div>
                        )}
                        {newsletter.cta && (
                          <p className="social-text nl-cta">{newsletter.cta}</p>
                        )}
                        {!newsletter.structured && (
                          <p className="social-text">{social.newsletter}</p>
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="tool-empty">
                  <p>Couldn't generate social posts.</p>
                  <button type="button" className="ghost" onClick={runSocial}>
                    Retry
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      </>
    );
}
