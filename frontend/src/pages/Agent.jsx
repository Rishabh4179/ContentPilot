/**
 * General Agent — Claude-style chat interface.
 *
 * Single centered column. The active article is shown as a chip in the header
 * with a "Change" button that opens a searchable picker modal. All 8 planner
 * tools are wired identically to the generator's in-page agent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  analyzeCompetitors,
  askLibrary,
  createChatSession,
  deleteChatSession,
  editChat,
  generateCover,
  generateFaq,
  generateSectionImages,
  generateSocial,
  getChatSession,
  improveSeo,
  listArticles,
  listChatSessions,
  planAgentActions,
  renameChatSession,
  translateArticle,
  updateArticle,
  updateChatSession,
} from "../api";
import { useAuthState, useDisplayName } from "../AuthGate";
import { useAgentSession } from "../AgentContext";
import ArticlePreview from "../ArticlePreview";
import { analyzeSeo, seoTier } from "../seo";
import { buildExportHtml, downloadHtmlFile, openPrintWindow, slugify } from "../exportDoc";

marked.setOptions({ breaks: true });

const AGENT_NAME = "Pilot";

// Stable empty thread slice so renders don't churn when a thread is untouched.
const EMPTY_THREAD = { activeId: null, messages: [], list: undefined };

function relTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
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

// One-line human explanation of what each tool actually does — shown when the
// step dropdown is expanded so the user knows what's happening under the hood.
const AGENT_TOOL_DESCRIPTIONS = {
  edit: "Sends the whole article + your instruction to the editor LLM and applies the returned diff in place.",
  improve_seo:
    "Runs a full SEO rewrite: title 50–60 chars, meta 120–160, keyword density check, ≥3 H2s, readability pass.",
  translate:
    "Replaces the article body with a full translation into the target language. Structure, headings, and links are preserved.",
  section_images:
    "Generates an AI image for every H2 section and inserts it under each heading.",
  social:
    "Produces an X/Twitter thread, a LinkedIn post, and an email-newsletter draft from the article.",
  faq: "Generates 5 FAQ items grounded in the article body.",
  competitors:
    "Runs a live SERP scan for the topic — top ranking pages, content gaps, suggested extra sections.",
  export:
    "Renders the article as a print-ready HTML doc, then opens the print dialog (PDF) or downloads the .html file.",
  cover_image:
    "Generates a single AI cover / hero image for the article and attaches it.",
  seo_report:
    "Analyzes the article and reports its SEO + readability score, headings, length and keyword usage — no changes made.",
  proofread:
    "Light-touch pass that fixes only grammar, spelling and punctuation — meaning and structure are untouched.",
  summarize:
    "Adds a short ‘Key takeaways’ bullet summary near the top of the article.",
};

// API path the tool ends up calling — informational, shown in the dropdown.
const AGENT_TOOL_ENDPOINTS = {
  edit: "POST /api/edit/chat",
  improve_seo: "POST /api/seo/improve",
  translate: "POST /api/translate",
  section_images: "POST /api/articles/{id}/section-images",
  social: "POST /api/social",
  faq: "POST /api/faq",
  competitors: "POST /api/competitors",
  export: "(client-side render + print)",
  cover_image: "POST /api/articles/{id}/cover",
  seo_report: "(client-side analysis)",
  proofread: "POST /api/edit/chat",
  summarize: "POST /api/edit/chat",
};

// Pool of quick-start prompts. The welcome screen shows a rotating window of
// SUGGESTION_VISIBLE_COUNT of these, cycling every 5s so new cards appear.
const SUGGESTED_PROMPTS = [
  { icon: "🌍", label: "Translate this to Spanish" },
  { icon: "📈", label: "Improve the SEO score" },
  { icon: "📣", label: "Generate a social pack" },
  { icon: "❓", label: "Add an FAQ section" },
  { icon: "🖨", label: "Export this as a PDF" },
  { icon: "📚", label: "How many articles do I have?" },
  { icon: "🇫🇷", label: "Translate this to French" },
  { icon: "✏️", label: "Rewrite the intro to be punchier" },
  { icon: "🖼", label: "Add images to each section" },
  { icon: "🔎", label: "Scan competitors for this topic" },
  { icon: "✂️", label: "Shorten this article" },
  { icon: "📖", label: "Expand with more detail" },
  { icon: "🐦", label: "Write a Twitter thread" },
  { icon: "💼", label: "Draft a LinkedIn post" },
  { icon: "🎯", label: "Make the title more clickable" },
  { icon: "📝", label: "Add a conclusion section" },
  { icon: "💾", label: "Download as HTML" },
  { icon: "🌐", label: "Translate this to Hindi" },
];

const SUGGESTION_VISIBLE_COUNT = 6;
const SUGGESTION_ROTATE_MS = 5000;

// Rotating one-liners under the welcome greeting. Change every ~2.6s.
const NO_ARTICLE_TAGLINES = [
  "Pick any article and I'll take it from there.",
  "I can translate, edit, SEO-boost, or export anything in your library.",
  "Ask me anything — I know every article you've saved.",
];

const WITH_ARTICLE_TAGLINES = [
  "Try: “Translate this to Spanish” 🌍",
  "Try: “Improve the SEO score” 📈",
  "Try: “Add an FAQ at the end” ❓",
  "Try: “Print this as a PDF” 🖨",
];

const COMPOSER_PLACEHOLDERS = [
  "Ask me to translate, edit, or improve…",
  "Try: add a section about pricing",
  "Try: rewrite the intro to be punchier",
  "Try: print this as a PDF",
];

// Suggestions shown in Library (RAG) mode — cross-article questions.
const LIBRARY_SUGGESTIONS = [
  { icon: "🧭", label: "Summarize everything in my library" },
  { icon: "🔁", label: "Do I have duplicate or overlapping articles?" },
  { icon: "🧩", label: "What topics have I not covered yet?" },
  { icon: "🔗", label: "Which articles could link to each other?" },
  { icon: "🔎", label: "What did I write about SEO?" },
  { icon: "📝", label: "Suggest my next article idea" },
];

function useRotating(items, ms = 2600) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!items || items.length < 2) return undefined;
    const t = setInterval(() => setI((n) => (n + 1) % items.length), ms);
    return () => clearInterval(t);
  }, [items, ms]);
  return items && items.length ? items[i % items.length] : "";
}

// Returns a sliding window of `count` items, advancing by `count` every `ms`
// so the whole visible set swaps out. Wraps around the pool. Also returns the
// current page index so callers can key the container to replay animations.
function useRotatingWindow(items, count, ms = 5000) {
  const [start, setStart] = useState(0);
  useEffect(() => {
    if (!items || items.length <= count) return undefined;
    const t = setInterval(() => {
      setStart((s) => (s + count) % items.length);
    }, ms);
    return () => clearInterval(t);
  }, [items, count, ms]);
  if (!items || !items.length) return { window: [], page: 0 };
  const window = [];
  const take = Math.min(count, items.length);
  for (let k = 0; k < take; k++) {
    window.push(items[(start + k) % items.length]);
  }
  return { window, page: Math.floor(start / count) };
}

function countWords(text) {
  return ((text || "").match(/\b\w+\b/g) || []).length;
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function renderMarkdown(md) {
  return DOMPurify.sanitize(marked.parse(md || ""));
}

export default function Agent() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { ready: authReady, signedIn, userId } = useAuthState();
  const displayName = useDisplayName();
  const greetingName = (displayName || "there").trim();

  const [articles, setArticles] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");

  // Chat state lives in a route-independent context so switching tabs preserves
  // everything. Each mode+article ("thread") has many DB-persisted sessions.
  const {
    sessionState,
    setSessionState,
    selectedId,
    setSelectedId,
    input,
    setInput,
    chatMode,
    setChatMode,
  } = useAgentSession();
  const libraryMode = chatMode === "library";
  const threadKey = libraryMode
    ? "library:0"
    : selectedId
    ? `agent:${selectedId}`
    : "none";
  const current = sessionState[threadKey] || EMPTY_THREAD;
  const messages = current.messages;
  const activeSessionId = current.activeId;
  const sessionList = current.list;

  // Patch just the current thread's slice of session state.
  const patchThread = useCallback(
    (patch) => {
      setSessionState((prev) => {
        const cur = prev[threadKey] || { activeId: null, messages: [], list: undefined };
        const next = typeof patch === "function" ? patch(cur) : { ...cur, ...patch };
        return { ...prev, [threadKey]: next };
      });
    },
    [threadKey, setSessionState]
  );

  const setMessages = useCallback(
    (updater) => {
      patchThread((cur) => {
        const nextMsgs =
          typeof updater === "function" ? updater(cur.messages || []) : updater;
        return { ...cur, messages: nextMsgs };
      });
    },
    [patchThread]
  );

  const [chatLoading, setChatLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const bodyRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!authReady) return;
    if (!signedIn) {
      setArticles([]);
      setLoadingList(false);
      return;
    }
    let active = true;
    setLoadingList(true);
    listArticles()
      .then((rows) => {
        if (!active) return;
        setArticles(rows || []);
        setListError("");
      })
      .catch((err) => active && setListError(err.message))
      .finally(() => active && setLoadingList(false));
    return () => {
      active = false;
    };
  }, [authReady, signedIn, userId]);

  useEffect(() => {
    const raw = searchParams.get("article");
    if (!raw || !articles.length) return;
    const id = Number(raw);
    if (
      Number.isFinite(id) &&
      id !== selectedId &&
      articles.some((a) => a.id === id)
    ) {
      // Switch article; its own thread loads from the DB (see thread effect).
      setSelectedId(id);
    }
  }, [searchParams, articles, selectedId, setSelectedId]);

  // Sanitize a loaded message list: interrupted "running" steps are stale.
  function hydrateMessages(msgs) {
    return (msgs || []).map((m) =>
      m.role === "agent" && m.status === "running"
        ? { ...m, status: "error", note: "Interrupted" }
        : m
    );
  }

  // Load the session LIST for a thread the first time we see it, and open the
  // most recent session (or start a fresh empty one).
  const loadedThreadsRef = useRef(new Set());
  useEffect(() => {
    if (!authReady || !signedIn) return;
    if (threadKey === "none") return;
    if (loadedThreadsRef.current.has(threadKey)) return;
    if (sessionState[threadKey]?.list !== undefined) {
      loadedThreadsRef.current.add(threadKey);
      return;
    }
    loadedThreadsRef.current.add(threadKey);
    const mode = libraryMode ? "library" : "agent";
    const aid = libraryMode ? 0 : selectedId || 0;
    let active = true;
    listChatSessions(mode, aid)
      .then(async (list) => {
        if (!active) return;
        const safeList = Array.isArray(list) ? list : [];
        if (safeList.length > 0) {
          // Auto-open the most recent conversation.
          try {
            const detail = await getChatSession(safeList[0].id);
            if (!active) return;
            patchThread((cur) => ({
              ...cur,
              activeId: detail.id,
              messages: hydrateMessages(detail.messages),
              list: safeList,
            }));
            return;
          } catch {
            /* fall through to empty */
          }
        }
        patchThread((cur) => ({
          ...cur,
          activeId: cur.activeId ?? null,
          messages: cur.messages || [],
          list: safeList,
        }));
      })
      .catch(() => {
        patchThread((cur) => ({ ...cur, list: [] }));
      });
    return () => {
      active = false;
    };
  }, [threadKey, authReady, signedIn, libraryMode, selectedId, sessionState, patchThread]);

  // Debounced save of the active session whenever its messages change. Creates
  // the session on the first message, then updates it in place.
  const saveTimerRef = useRef(null);
  const creatingRef = useRef({});
  useEffect(() => {
    if (!authReady || !signedIn) return;
    if (threadKey === "none") return;
    if (chatLoading) return; // wait until the turn settles
    const msgs = messages;
    if (!msgs || msgs.length === 0) return;
    const mode = libraryMode ? "library" : "agent";
    const aid = libraryMode ? 0 : selectedId || 0;
    const capturedKey = threadKey;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        if (activeSessionId) {
          const updated = await updateChatSession(activeSessionId, msgs);
          // Refresh this session's title/time in the list.
          setSessionState((prev) => {
            const cur = prev[capturedKey];
            if (!cur) return prev;
            const list = (cur.list || []).map((s) =>
              s.id === updated.id
                ? { ...s, title: updated.title, updated_at: updated.updated_at }
                : s
            );
            return { ...prev, [capturedKey]: { ...cur, list } };
          });
        } else if (!creatingRef.current[capturedKey]) {
          creatingRef.current[capturedKey] = true;
          const created = await createChatSession(mode, aid, msgs);
          setSessionState((prev) => {
            const cur = prev[capturedKey] || EMPTY_THREAD;
            const meta = {
              id: created.id,
              title: created.title,
              message_count: msgs.length,
              updated_at: created.updated_at,
            };
            return {
              ...prev,
              [capturedKey]: {
                ...cur,
                activeId: created.id,
                list: [meta, ...(cur.list || [])],
              },
            };
          });
          creatingRef.current[capturedKey] = false;
        }
      } catch {
        creatingRef.current[capturedKey] = false;
      }
    }, 600);
    return () => clearTimeout(saveTimerRef.current);
  }, [
    messages,
    activeSessionId,
    threadKey,
    authReady,
    signedIn,
    libraryMode,
    selectedId,
    chatLoading,
    setSessionState,
  ]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, chatLoading]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const onKey = (e) => e.key === "Escape" && setPickerOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickerOpen]);

  const selected = useMemo(
    () => articles.find((a) => a.id === selectedId) || null,
    [articles, selectedId]
  );

  const filteredArticles = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase();
    if (!q) return articles;
    return articles.filter((a) => {
      const hay = [a.title, a.topic, (a.keywords || []).join(" ")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [articles, pickerSearch]);

  function pickArticle(id) {
    setSelectedId(id);
    setPickerOpen(false);
    setPickerSearch("");
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("article", String(id));
      return next;
    });
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  // ---- Session management (multi-conversation history) ----

  function startNewChat() {
    // Reset the active thread to an empty, unsaved session. A row is created
    // in the DB on the first message (see save effect).
    patchThread((cur) => ({ ...cur, activeId: null, messages: [] }));
    setHistoryOpen(false);
    setInput("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function openSession(id) {
    if (id === activeSessionId) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(false);
    try {
      const detail = await getChatSession(id);
      patchThread((cur) => ({
        ...cur,
        activeId: detail.id,
        messages: hydrateMessages(detail.messages),
      }));
    } catch {
      /* ignore */
    }
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function removeSession(id) {
    try {
      await deleteChatSession(id);
    } catch {
      /* ignore */
    }
    patchThread((cur) => {
      const list = (cur.list || []).filter((s) => s.id !== id);
      // If we deleted the open one, drop to a fresh empty chat.
      if (cur.activeId === id) {
        return { ...cur, activeId: null, messages: [], list };
      }
      return { ...cur, list };
    });
  }

  async function renameSession(id, title) {
    const clean = (title || "").trim();
    if (!clean) return;
    try {
      const meta = await renameChatSession(id, clean);
      patchThread((cur) => ({
        ...cur,
        list: (cur.list || []).map((s) =>
          s.id === id ? { ...s, title: meta.title } : s
        ),
      }));
    } catch {
      /* ignore */
    }
  }

  function pushAgentStep(step) {
    setMessages((prev) => [
      ...prev,
      { role: "agent", startedAt: Date.now(), ...step },
    ]);
  }

  function updateLastAgentStep(patch) {
    setMessages((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === "agent" && prev[i].status === "running") {
          const next = [...prev];
          const finished =
            patch.status === "done" || patch.status === "error"
              ? { durationMs: Date.now() - (next[i].startedAt || Date.now()) }
              : {};
          next[i] = { ...next[i], ...patch, ...finished };
          return next;
        }
      }
      return prev;
    });
  }

  async function applyArticleUpdate(baseArticle, patch) {
    const updated = {
      ...baseArticle,
      title: patch.title || baseArticle.title,
      meta_description:
        patch.meta_description !== undefined
          ? patch.meta_description
          : baseArticle.meta_description,
      markdown: patch.markdown ?? baseArticle.markdown,
      word_count:
        patch.word_count ??
        countWords(patch.markdown ?? baseArticle.markdown),
    };
    try {
      const saved = await updateArticle(baseArticle.id, {
        title: updated.title,
        meta_description: updated.meta_description,
        markdown: updated.markdown,
        word_count: updated.word_count,
      });
      setArticles((prev) => prev.map((a) => (a.id === saved.id ? saved : a)));
      return saved;
    } catch {
      setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      return updated;
    }
  }

  async function runAgentAction(action, getCurrent) {
    const current = getCurrent();
    if (!current) throw new Error("No article selected.");
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
        const res = await improveSeo({
          topic: current.topic || current.title,
          title: current.title,
          meta_description: current.meta_description,
          markdown: current.markdown,
          keywords: current.keywords || [],
          tone: current.tone || "informative",
          audience: current.audience || "a general audience",
          issues: [],
        });
        const saved = await applyArticleUpdate(current, {
          title: res.title,
          meta_description: res.meta_description,
          markdown: res.markdown,
          word_count: res.word_count,
        });
        return { result: saved, note: "SEO rewrite applied." };
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
        const res = await generateSectionImages(current.id);
        const saved = {
          ...current,
          markdown: res.markdown,
          word_count: res.word_count,
        };
        setArticles((prev) => prev.map((a) => (a.id === saved.id ? saved : a)));
        const count = res.image_urls?.length || 0;
        return {
          result: saved,
          note: `Added ${count} section image${count === 1 ? "" : "s"}.`,
        };
      }
      case "social": {
        const res = await generateSocial({
          topic: current.topic || current.title,
          title: current.title,
          markdown: current.markdown,
        });
        setMessages((prev) => [
          ...prev,
          { role: "result", kind: "social", data: res },
        ]);
        return { result: current, note: "Social pack rendered below." };
      }
      case "faq": {
        const res = await generateFaq({
          topic: current.topic || current.title,
          title: current.title,
          meta_description: current.meta_description,
          markdown: current.markdown,
          count: 5,
        });
        if (!res.items?.length) throw new Error("No FAQ could be generated.");
        setMessages((prev) => [
          ...prev,
          { role: "result", kind: "faq", data: res },
        ]);
        return {
          result: current,
          note: `Generated ${res.items.length} FAQ item${res.items.length === 1 ? "" : "s"}.`,
        };
      }
      case "competitors": {
        const res = await analyzeCompetitors({
          topic: current.topic || current.title,
          keywords: current.keywords || [],
        });
        setMessages((prev) => [
          ...prev,
          { role: "result", kind: "competitors", data: res },
        ]);
        return {
          result: current,
          note: `Scanned ${res.top_pages?.length || 0} pages, ${res.gaps?.length || 0} gaps.`,
        };
      }
      case "export": {
        const fmt = String(action.args?.format || "pdf").toLowerCase();
        const kind = fmt === "html" ? "html" : "pdf";
        const html = buildExportHtml({
          title: current.title,
          metaDescription: current.meta_description,
          articleHtml: renderMarkdown(current.markdown),
          coverUrl: current.cover_url,
        });
        if (kind === "pdf") {
          if (!openPrintWindow(html)) {
            throw new Error("Please allow pop-ups to export as PDF.");
          }
          return { result: current, note: "Opened the browser print dialog." };
        }
        downloadHtmlFile(`${slugify(current.title || "article")}.html`, html);
        return { result: current, note: "Downloaded as standalone .html." };
      }
      case "cover_image": {
        if (!current.id) throw new Error("The article must be saved first.");
        const saved = await generateCover(current.id);
        setArticles((prev) => prev.map((a) => (a.id === saved.id ? saved : a)));
        return { result: saved, note: "Cover image generated and attached." };
      }
      case "seo_report": {
        const report = analyzeSeo({
          markdown: current.markdown,
          title: current.title,
          meta: current.meta_description,
          keywords: current.keywords || [],
          length: current.length || "medium",
        });
        setMessages((prev) => [
          ...prev,
          { role: "result", kind: "seo", data: report },
        ]);
        return {
          result: current,
          note: `SEO score ${report.score}/100 · ${report.wordCount} words · Flesch ${report.fleschScore}.`,
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

  async function runLibraryAsk(text) {
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setChatLoading(true);
    try {
      const res = await askLibrary(text);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: res.answer || "I couldn't find anything relevant in your library.",
          sources: Array.isArray(res.sources) ? res.sources : [],
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${err.message}`, error: true },
      ]);
    } finally {
      setChatLoading(false);
    }
  }

  function openSource(source) {
    // Jump into article mode with the cited article selected.
    if (!source?.id) return;
    setChatMode("article");
    pickArticle(source.id);
  }

  async function sendMessage(eOrText) {
    // Support (event) from form submit and (text) from clarification chips.
    let text;
    if (typeof eOrText === "string") {
      text = eOrText.trim();
    } else {
      eOrText?.preventDefault?.();
      text = input.trim();
    }
    if (!text || chatLoading) return;
    if (chatMode === "library") {
      await runLibraryAsk(text);
      return;
    }
    if (!selected) return;
    const nextMessages = [
      ...messages.filter((m) => m.role === "user" || m.role === "assistant"),
      { role: "user", content: text },
    ];
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setChatLoading(true);
    try {
      const libraryRecent = articles.slice(0, 15).map((a) => ({
        id: a.id,
        title: a.title || "",
        topic: a.topic || "",
        word_count: a.word_count || 0,
        created_at: a.created_at || "",
      }));
      const plan = await planAgentActions({
        title: selected.title,
        meta_description: selected.meta_description,
        markdown: selected.markdown,
        topic: selected.topic || selected.title,
        keywords: selected.keywords || [],
        tone: selected.tone || "informative",
        audience: selected.audience || "a general audience",
        messages: nextMessages,
        library_count: articles.length,
        library_recent: libraryRecent,
      });
      const actions = Array.isArray(plan.actions) ? plan.actions : [];
      const clarification =
        plan.clarification &&
        typeof plan.clarification.question === "string" &&
        plan.clarification.question.trim()
          ? {
              question: plan.clarification.question.trim(),
              options: Array.isArray(plan.clarification.options)
                ? plan.clarification.options
                    .map((o) => String(o).trim())
                    .filter(Boolean)
                : [],
            }
          : null;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            plan.reply ||
            (clarification
              ? clarification.question
              : actions.length
              ? "Working on it."
              : "OK."),
          plannedActions: actions.length,
          clarification,
        },
      ]);
      let currentArticle = selected;
      for (const action of actions) {
        pushAgentStep({
          tool: action.tool,
          label: AGENT_TOOL_LABELS[action.tool] || action.tool,
          args: action.args || {},
          status: "running",
        });
        try {
          const stepRes = await runAgentAction(action, () => currentArticle);
          currentArticle = stepRes.result;
          updateLastAgentStep({ status: "done", note: stepRes.note });
        } catch (err) {
          updateLastAgentStep({ status: "error", note: err.message });
          break;
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${err.message}`, error: true },
      ]);
    } finally {
      setChatLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(e);
    }
  }

  function renderStep(m) {
    const statusIcon = m.status === "done" ? "✓" : m.status === "error" ? "✗" : "•";
    const statusLabel =
      m.status === "done"
        ? "Done"
        : m.status === "error"
        ? "Failed"
        : "Processing…";
    const detail =
      m.tool === "translate" && m.args?.language
        ? ` → ${m.args.language}`
        : m.tool === "edit" && m.args?.instruction
        ? ` → ${m.args.instruction.slice(0, 80)}${m.args.instruction.length > 80 ? "…" : ""}`
        : m.tool === "export" && m.args?.format
        ? ` → ${m.args.format}`
        : "";
    const durationText =
      m.status !== "running" && Number.isFinite(m.durationMs)
        ? m.durationMs >= 1000
          ? `${(m.durationMs / 1000).toFixed(1)}s`
          : `${m.durationMs}ms`
        : "";
    const description = AGENT_TOOL_DESCRIPTIONS[m.tool];
    const endpoint = AGENT_TOOL_ENDPOINTS[m.tool];
    const argsEntries = Object.entries(m.args || {}).filter(
      ([, v]) => v !== undefined && v !== null && v !== ""
    );

    return (
      <details className={`agent-step agent-step-${m.status}`}>
        <summary className="agent-step-summary">
          <span className="agent-step-icon" aria-hidden="true">
            {m.status === "running" ? <span className="spinner" /> : statusIcon}
          </span>
          <span className="agent-step-label">
            {m.label}
            {detail}
          </span>
          <span className="agent-step-status-pill">{statusLabel}</span>
          {durationText && (
            <span className="agent-step-duration">{durationText}</span>
          )}
          <span className="agent-step-caret" aria-hidden="true">
            ▾
          </span>
        </summary>
        <div className="agent-step-details">
          {description && (
            <div className="agent-step-detail-row">
              <span className="agent-step-detail-key">What it does</span>
              <span className="agent-step-detail-val">{description}</span>
            </div>
          )}
          {endpoint && (
            <div className="agent-step-detail-row">
              <span className="agent-step-detail-key">Endpoint</span>
              <code className="agent-step-detail-code">{endpoint}</code>
            </div>
          )}
          {argsEntries.length > 0 && (
            <div className="agent-step-detail-row">
              <span className="agent-step-detail-key">Arguments</span>
              <div className="agent-step-args">
                {argsEntries.map(([k, v]) => (
                  <div key={k} className="agent-step-arg">
                    <code className="agent-step-arg-key">{k}</code>
                    <code className="agent-step-arg-val">
                      {typeof v === "string" ? v : JSON.stringify(v)}
                    </code>
                  </div>
                ))}
              </div>
            </div>
          )}
          {m.note && (
            <div className="agent-step-detail-row">
              <span className="agent-step-detail-key">
                {m.status === "error" ? "Error" : "Result"}
              </span>
              <span
                className={`agent-step-detail-val${
                  m.status === "error" ? " agent-step-detail-error" : ""
                }`}
              >
                {m.note}
              </span>
            </div>
          )}
          {m.status === "running" && (
            <div className="agent-step-detail-row">
              <span className="agent-step-detail-key">Status</span>
              <span className="agent-step-detail-val agent-step-detail-processing">
                Working on this now — the article state will update when it finishes.
              </span>
            </div>
          )}
        </div>
      </details>
    );
  }

  function renderResultBubble(m, i) {
    if (m.kind === "seo") {
      const r = m.data || {};
      const tier = seoTier(r.score || 0);
      return (
        <div key={i} className="chat-msg assistant">
          <div className="chat-avatar">🤖</div>
          <div className="chat-bubble">
            <div className="agent-result-head">
              📊 SEO report ·{" "}
              <span className={`chat-seo-score chat-seo-${tier}`}>
                {r.score}/100
              </span>
            </div>
            <div className="chat-seo-meta">
              {r.wordCount} words · ~{r.readingTime} min read · Flesch{" "}
              {r.fleschScore} ({r.fleschLabel})
            </div>
            <ul className="agent-result-list">
              {(r.checks || []).map((c, idx) => (
                <li key={idx}>
                  <span className={`chat-seo-dot chat-seo-${c.status}`} />
                  <strong>{c.label}</strong> — {c.detail}
                </li>
              ))}
            </ul>
          </div>
        </div>
      );
    }
    if (m.kind === "social") {
      const s = m.data || {};
      return (
        <div key={i} className="chat-msg assistant">
          <div className="chat-avatar">🤖</div>
          <div className="chat-bubble">
            <div className="agent-result-head">📣 Social pack</div>
            {s.thread?.length > 0 && (
              <>
                <h4>X / Twitter thread</h4>
                <ol className="agent-result-list">
                  {s.thread.map((t, idx) => (
                    <li key={idx}>{t}</li>
                  ))}
                </ol>
              </>
            )}
            {s.linkedin && (
              <>
                <h4>LinkedIn</h4>
                <pre className="agent-result-block">{s.linkedin}</pre>
              </>
            )}
            {s.newsletter && (
              <>
                <h4>Newsletter</h4>
                <pre className="agent-result-block">{s.newsletter}</pre>
              </>
            )}
          </div>
        </div>
      );
    }
    if (m.kind === "faq") {
      const items = m.data?.items || [];
      return (
        <div key={i} className="chat-msg assistant">
          <div className="chat-avatar">🤖</div>
          <div className="chat-bubble">
            <div className="agent-result-head">❓ FAQ</div>
            <ul className="agent-result-list">
              {items.map((it, idx) => (
                <li key={idx}>
                  <strong>{it.question}</strong>
                  <div>{it.answer}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      );
    }
    if (m.kind === "competitors") {
      const c = m.data || {};
      return (
        <div key={i} className="chat-msg assistant">
          <div className="chat-avatar">🤖</div>
          <div className="chat-bubble">
            <div className="agent-result-head">🔎 Competitor scan</div>
            {c.top_pages?.length > 0 && (
              <>
                <h4>Top pages</h4>
                <ul className="agent-result-list">
                  {c.top_pages.map((p, idx) => (
                    <li key={idx}>
                      <a href={p.url} target="_blank" rel="noopener noreferrer">
                        {p.title || p.url}
                      </a>
                      {p.summary && <div>{p.summary}</div>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {c.gaps?.length > 0 && (
              <>
                <h4>Content gaps</h4>
                <ul className="agent-result-list">
                  {c.gaps.map((g, idx) => (
                    <li key={idx}>{g}</li>
                  ))}
                </ul>
              </>
            )}
            {c.suggested_sections?.length > 0 && (
              <>
                <h4>Suggested sections</h4>
                <ul className="agent-result-list">
                  {c.suggested_sections.map((s, idx) => (
                    <li key={idx}>{s}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      );
    }
    return null;
  }

  const hasArticles = articles.length > 0;
  const hasMessages = messages.length > 0;
  const canSend =
    Boolean(input.trim()) &&
    !chatLoading &&
    (libraryMode ? hasArticles : Boolean(selected));
  const rotatingTagline = useRotating(
    selected ? WITH_ARTICLE_TAGLINES : NO_ARTICLE_TAGLINES
  );
  const rotatingPlaceholder = useRotating(COMPOSER_PLACEHOLDERS, 3200);
  const { window: visibleSuggestions, page: suggestionPage } = useRotatingWindow(
    SUGGESTED_PROMPTS,
    SUGGESTION_VISIBLE_COUNT,
    SUGGESTION_ROTATE_MS
  );

  return (
    <main className="chat-page">
      <header className="chat-topbar">
        <div className="chat-topbar-title">
          <span className="chat-topbar-icon">🤖</span>
          <div>
            <div className="chat-topbar-heading">{AGENT_NAME}</div>
            <div className="chat-topbar-sub">
              {libraryMode
                ? "Ask anything across your whole library"
                : selected
                ? `Working on: ${selected.title || selected.topic || "(untitled)"}`
                : hasArticles
                ? "Select an article to get started"
                : "No articles yet"}
            </div>
          </div>
        </div>
        <div className="chat-topbar-actions">
          <div className="chat-mode-switch" role="tablist" aria-label="Chat mode">
            <button
              type="button"
              role="tab"
              aria-selected={!libraryMode}
              className={`chat-mode-btn${!libraryMode ? " active" : ""}`}
              onClick={() => setChatMode("article")}
              title="Chat about one article"
            >
              💬 Article
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={libraryMode}
              className={`chat-mode-btn${libraryMode ? " active" : ""}`}
              onClick={() => setChatMode("library")}
              title="Ask across your whole library"
            >
              📚 Library
            </button>
          </div>
          {!libraryMode && selected && (
            <button
              type="button"
              className="ghost chat-icon-btn"
              onClick={() => setPreviewOpen(true)}
              title="Read article"
              aria-label="Read article"
            >
              📖
            </button>
          )}
          {threadKey !== "none" && (
            <button
              type="button"
              className="ghost chat-icon-btn"
              onClick={() => setHistoryOpen(true)}
              title="Chat history"
              aria-label="Chat history"
            >
              🕘
              {sessionList?.length > 0 && (
                <span className="chat-hist-count">{sessionList.length}</span>
              )}
            </button>
          )}
          {threadKey !== "none" && hasMessages && (
            <button
              type="button"
              className="ghost chat-icon-btn"
              onClick={startNewChat}
              title="New chat"
              aria-label="New chat"
            >
              ✏️
            </button>
          )}
          {!libraryMode && (
            <button
              type="button"
              className={selected ? "ghost" : "generate"}
              onClick={() => setPickerOpen(true)}
              disabled={!hasArticles}
            >
              {selected ? "Change article" : hasArticles ? "Choose article" : "No articles"}
            </button>
          )}
        </div>
      </header>

      <section className="chat-scroll" ref={bodyRef}>
        <div className="chat-inner">
          {libraryMode && !hasMessages && !chatLoading && (
            <div className="chat-welcome">
              <div className="chat-welcome-mark">📚</div>
              <h1>Ask your library anything</h1>
              <p className="chat-welcome-sub">
                I'll search across all {articles.length} of your saved article
                {articles.length === 1 ? "" : "s"} and answer with citations.
              </p>
              {hasArticles ? (
                <div className="chat-suggestions">
                  {LIBRARY_SUGGESTIONS.map((s, idx) => (
                    <button
                      key={s.label}
                      type="button"
                      className="chat-suggestion"
                      style={{ animationDelay: `${idx * 50}ms` }}
                      onClick={() => {
                        setInput(s.label);
                        setTimeout(() => inputRef.current?.focus(), 0);
                      }}
                    >
                      <span aria-hidden="true">{s.icon}</span>
                      <span>{s.label}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  <p>Your library is empty — generate an article first.</p>
                  <button
                    type="button"
                    className="generate chat-welcome-cta"
                    onClick={() => navigate("/")}
                  >
                    ✨ Generate an article
                  </button>
                </>
              )}
            </div>
          )}

          {!libraryMode && !selected && !loadingList && (
            <div className="chat-welcome">
              <div className="chat-welcome-mark">🤖</div>
              <h1>
                Hey {greetingName}, what would you like to do today?
              </h1>
              <p
                className="chat-welcome-rotator"
                key={rotatingTagline}
                aria-live="polite"
              >
                {rotatingTagline}
              </p>
              {hasArticles ? (
                <button
                  type="button"
                  className="generate chat-welcome-cta"
                  onClick={() => setPickerOpen(true)}
                >
                  📚 Choose an article
                </button>
              ) : (
                <>
                  <p>You don't have any articles yet — generate your first one.</p>
                  <button
                    type="button"
                    className="generate chat-welcome-cta"
                    onClick={() => navigate("/")}
                  >
                    ✨ Generate an article
                  </button>
                </>
              )}
              {listError && <p className="chat-welcome-error">{listError}</p>}
            </div>
          )}

          {!libraryMode && selected && !hasMessages && !chatLoading && (
            <div className="chat-welcome">
              <div className="chat-welcome-mark">🤖</div>
              <h1>
                Hey {greetingName}, what would you like to do today?
              </h1>
              <p
                className="chat-welcome-rotator"
                key={rotatingTagline}
                aria-live="polite"
              >
                {rotatingTagline}
              </p>
              <p className="chat-welcome-sub">
                {selected.word_count || 0} words · {formatDate(selected.created_at)}
              </p>
              <div className="chat-suggestions" key={suggestionPage}>
                {visibleSuggestions.map((s, idx) => (
                  <button
                    key={s.label}
                    type="button"
                    className="chat-suggestion"
                    style={{ animationDelay: `${idx * 50}ms` }}
                    onClick={() => {
                      setInput(s.label);
                      setTimeout(() => inputRef.current?.focus(), 0);
                    }}
                  >
                    <span aria-hidden="true">{s.icon}</span>
                    <span>{s.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => {
            if (m.role === "agent") {
              return (
                <div key={i} className="chat-msg agent">
                  <div className="chat-avatar">⚙️</div>
                  <div className="chat-bubble chat-bubble-step">{renderStep(m)}</div>
                </div>
              );
            }
            if (m.role === "result") return renderResultBubble(m, i);
            if (m.role === "user") {
              return (
                <div key={i} className="chat-msg user">
                  <div className="chat-bubble">{m.content}</div>
                  <div className="chat-avatar">🧑</div>
                </div>
              );
            }
            // Chips stay active only on the LATEST clarification (no later user msg).
            const hasLaterUserMsg = messages
              .slice(i + 1)
              .some((later) => later.role === "user");
            const chipsActive = Boolean(m.clarification) && !hasLaterUserMsg && !chatLoading;
            return (
              <div key={i} className={`chat-msg assistant${m.error ? " error" : ""}`}>
                <div className="chat-avatar">🤖</div>
                <div className="chat-bubble">
                  {m.content}
                  {m.plannedActions > 0 && (
                    <div className="chat-bubble-tag">
                      Running {m.plannedActions} action
                      {m.plannedActions === 1 ? "" : "s"}…
                    </div>
                  )}
                  {m.clarification?.options?.length > 0 && (
                    <div
                      className={`chat-clarify${
                        chipsActive ? "" : " chat-clarify-inert"
                      }`}
                    >
                      {m.clarification.options.map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          className="chat-clarify-chip"
                          onClick={() => chipsActive && sendMessage(opt)}
                          disabled={!chipsActive}
                          title={
                            chipsActive
                              ? `Answer: ${opt}`
                              : "Already answered"
                          }
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                  {m.sources?.length > 0 && (
                    <div className="chat-sources">
                      <div className="chat-sources-label">Sources</div>
                      <div className="chat-sources-list">
                        {m.sources.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            className="chat-source-chip"
                            onClick={() => openSource(s)}
                            title={`Open “${s.title}” in article chat`}
                          >
                            📄 {s.title}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {chatLoading && (
            <div className="chat-msg assistant">
              <div className="chat-avatar">🤖</div>
              <div className="chat-bubble">
                <span className="typing">
                  <span></span>
                  <span></span>
                  <span></span>
                </span>
              </div>
            </div>
          )}
        </div>
      </section>

      <form className="chat-composer" onSubmit={sendMessage}>
        <div className="chat-composer-inner">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              libraryMode
                ? hasArticles
                  ? "Ask anything about your library…"
                  : "Generate an article first"
                : selected
                ? rotatingPlaceholder
                : hasArticles
                ? "Choose an article to start chatting"
                : "Generate an article first"
            }
            disabled={(libraryMode ? !hasArticles : !selected) || chatLoading}
            aria-label={`Message ${AGENT_NAME}`}
          />
          <button
            type="submit"
            className="chat-send"
            disabled={!canSend}
            aria-label="Send message"
            title="Send (Enter)"
          >
            {chatLoading ? <span className="spinner" /> : <span aria-hidden="true">↑</span>}
          </button>
        </div>
        <div className="chat-composer-hint">
          {libraryMode
            ? "Answers cite the articles they came from · Enter to send"
            : selected
            ? "Press Enter to send · Shift+Enter for newline"
            : "Pick an article to enable chat"}
        </div>
      </form>

      {previewOpen && selected && (
        <ArticlePreview article={selected} onClose={() => setPreviewOpen(false)} />
      )}

      {historyOpen && (
        <div
          className="chat-hist-backdrop"
          onClick={() => setHistoryOpen(false)}
          role="presentation"
        >
          <aside
            className="chat-hist-drawer"
            role="dialog"
            aria-label="Chat history"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="chat-hist-head">
              <h2>
                {libraryMode ? "📚 Library chats" : "💬 Article chats"}
              </h2>
              <button
                type="button"
                className="drawer-close"
                onClick={() => setHistoryOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <button
              type="button"
              className="generate chat-hist-new"
              onClick={startNewChat}
            >
              ✏️ New chat
            </button>
            {sessionList === undefined && (
              <p className="chat-hist-empty">Loading…</p>
            )}
            {sessionList?.length === 0 && (
              <p className="chat-hist-empty">
                No saved chats yet. Start typing to create one.
              </p>
            )}
            <ul className="chat-hist-list">
              {(sessionList || []).map((s) => (
                <li
                  key={s.id}
                  className={`chat-hist-item${s.id === activeSessionId ? " active" : ""}`}
                >
                  <button
                    type="button"
                    className="chat-hist-open"
                    onClick={() => openSession(s.id)}
                    title={s.title}
                  >
                    <span className="chat-hist-title">{s.title || "New chat"}</span>
                    <span className="chat-hist-meta">
                      {s.message_count} msg{s.message_count === 1 ? "" : "s"} ·{" "}
                      {relTime(s.updated_at)}
                    </span>
                  </button>
                  <span className="chat-hist-actions">
                    <button
                      type="button"
                      className="chat-hist-icon"
                      title="Rename"
                      aria-label="Rename chat"
                      onClick={() => {
                        const t = window.prompt("Rename chat", s.title || "");
                        if (t !== null) renameSession(s.id, t);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="chat-hist-icon danger"
                      title="Delete"
                      aria-label="Delete chat"
                      onClick={() => {
                        if (window.confirm("Delete this chat?")) removeSession(s.id);
                      }}
                    >
                      🗑
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      )}

      {pickerOpen && (
        <div
          className="chat-picker-backdrop"
          onClick={() => setPickerOpen(false)}
          role="presentation"
        >
          <div
            className="chat-picker card"
            role="dialog"
            aria-label="Choose an article"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="chat-picker-head">
              <h2>Choose an article</h2>
              <button
                type="button"
                className="drawer-close"
                onClick={() => setPickerOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <input
              type="search"
              autoFocus
              value={pickerSearch}
              onChange={(e) => setPickerSearch(e.target.value)}
              placeholder="Search by title, topic, or keyword…"
              className="chat-picker-search"
              aria-label="Search articles"
            />
            {loadingList && <p className="chat-picker-empty">Loading…</p>}
            {!loadingList && filteredArticles.length === 0 && (
              <p className="chat-picker-empty">
                {articles.length === 0
                  ? "No articles yet."
                  : `No matches for “${pickerSearch}”.`}
              </p>
            )}
            <ul className="chat-picker-list">
              {filteredArticles.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className={`chat-picker-item${a.id === selectedId ? " active" : ""}`}
                    onClick={() => pickArticle(a.id)}
                  >
                    <span className="chat-picker-item-title">
                      {a.title || a.topic || "(untitled)"}
                    </span>
                    <span className="chat-picker-item-meta">
                      {a.word_count || 0} words · {formatDate(a.created_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </main>
  );
}
