/** API helpers for talking to the FastAPI backend. */

/** Attach a Clerk bearer token when the user is signed in (no-op otherwise). */
async function authHeaders() {
  try {
    const clerk = window.Clerk;
    if (clerk?.session) {
      const token = await clerk.session.getToken();
      if (token) return { Authorization: `Bearer ${token}` };
    }
  } catch {
    /* not signed in / Clerk not ready */
  }
  return {};
}

export async function generateArticle(payload) {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.detail) detail = data.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Generate a web-grounded article (non-streaming; returns a Sources section). */
export async function generateGrounded(payload) {
  const res = await fetch("/api/generate/grounded", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.detail) detail = data.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Check whether a topic is ambiguous; returns { ambiguous, options:[{label,description}] }. */
export async function clarifyTopic(topic) {
  const res = await fetch("/api/clarify", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ topic }),
  });
  if (!res.ok) throw new Error(`Clarify failed (${res.status})`);
  return res.json();
}

/** Shared streaming reader for endpoints that emit "meta + ===ARTICLE=== + markdown". */
async function streamMarkdown(url, payload, onUpdate) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.body) {
    let detail = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.detail) detail = data.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const DELIM = "===ARTICLE===";
  let full = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    full += decoder.decode(value, { stream: true });
    const idx = full.indexOf(DELIM);
    if (idx === -1) {
      onUpdate?.({ meta: full.trim(), markdown: "", hasArticle: false });
    } else {
      onUpdate?.({
        meta: full.slice(0, idx).trim(),
        markdown: full.slice(idx + DELIM.length).replace(/^\s+/, ""),
        hasArticle: true,
      });
    }
  }

  const errIdx = full.indexOf("[[STREAM_ERROR]]");
  if (errIdx !== -1) {
    throw new Error(full.slice(errIdx + 16).trim() || "Streaming failed");
  }

  const idx = full.indexOf(DELIM);
  return {
    meta: (idx === -1 ? "" : full.slice(0, idx)).trim(),
    markdown: (idx === -1 ? full : full.slice(idx + DELIM.length)).trim(),
  };
}

/** Stream a generated article. */
export function generateArticleStream(payload, onUpdate) {
  return streamMarkdown("/api/generate/stream", payload, onUpdate);
}

/** Stream an article expanded from an edited outline. */
export function expandOutlineStream(payload, onUpdate) {
  return streamMarkdown("/api/expand/stream", payload, onUpdate);
}

/** Stream a web-grounded article (researches live sources first, then streams + Sources). */
export function generateGroundedStream(payload, onUpdate) {
  return streamMarkdown("/api/generate/grounded/stream", payload, onUpdate);
}

/** Generate an editable outline. Returns { sections: [{ heading, points }] }. */
export async function generateOutline(payload) {
  const res = await fetch("/api/outline", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `Outline failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.detail) detail = data.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Suggest additional outline sections (aware of existing headings). */
export async function suggestSections(payload) {
  const res = await fetch("/api/outline/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `Suggestions failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.detail) detail = data.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Suggest SEO keywords for a topic. Returns { keywords: [] }. */
export async function suggestKeywords(payload) {
  const res = await fetch("/api/keywords/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `Keyword suggestions failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.detail) detail = data.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Ping the backend health endpoint. Returns { status, provider }. */
export async function checkHealth() {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`Health check failed (${res.status})`);
  return res.json();
}

/** List saved articles (newest first). */
export async function listArticles() {
  const res = await fetch("/api/articles", { headers: { ...(await authHeaders()) } });
  if (!res.ok) throw new Error(`Failed to load articles (${res.status})`);
  return res.json();
}

/** Fetch a single saved article by ID. */
export async function getArticle(articleId) {
  const res = await fetch(`/api/articles/${articleId}`, { headers: { ...(await authHeaders()) } });
  if (!res.ok) throw new Error(`Article not found (${res.status})`);
  return res.json();
}

/** Aggregated dashboard analytics for the current user. */
export async function getStats() {
  const res = await fetch("/api/stats", { headers: { ...(await authHeaders()) } });
  if (!res.ok) throw new Error(`Failed to load stats (${res.status})`);
  return res.json();
}

/** Ask a question answered from the user's saved article library (RAG). */
export async function askLibrary(question, { topK = 4 } = {}) {
  const res = await fetch("/api/library/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ question, top_k: topK }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `Failed to ask library (${res.status})`);
  }
  return res.json();
}

/** Suggest internal links from one saved article to the user's other articles. */
export async function suggestInternalLinks(articleId, { maxSuggestions = 5 } = {}) {
  const res = await fetch("/api/library/internal-links", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ article_id: articleId, max_suggestions: maxSuggestions }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `Failed to suggest links (${res.status})`);
  }
  return res.json();
}

/** List chat sessions for a mode (+ article for agent mode), newest first. */
export async function listChatSessions(mode, articleId = 0) {
  const params = new URLSearchParams({ mode, article_id: String(articleId || 0) });
  const res = await fetch(`/api/chat/sessions?${params}`, {
    headers: { ...(await authHeaders()) },
  });
  if (!res.ok) throw new Error(`Failed to load chats (${res.status})`);
  return res.json();
}

/** Load one chat session with its full message list. */
export async function getChatSession(id) {
  const res = await fetch(`/api/chat/sessions/${id}`, {
    headers: { ...(await authHeaders()) },
  });
  if (!res.ok) throw new Error(`Failed to load chat (${res.status})`);
  return res.json();
}

/** Create a new chat session. Returns the created session (with id + title). */
export async function createChatSession(mode, articleId, messages) {
  const res = await fetch("/api/chat/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ mode, article_id: articleId || 0, messages }),
  });
  if (!res.ok) throw new Error(`Failed to create chat (${res.status})`);
  return res.json();
}

/** Update an existing session's messages (auto-titles until renamed). */
export async function updateChatSession(id, messages) {
  const res = await fetch(`/api/chat/sessions/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) throw new Error(`Failed to save chat (${res.status})`);
  return res.json();
}

/** Rename a session. */
export async function renameChatSession(id, title) {
  const res = await fetch(`/api/chat/sessions/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Failed to rename chat (${res.status})`);
  return res.json();
}

/** Delete a session. */
export async function deleteChatSession(id) {
  const res = await fetch(`/api/chat/sessions/${id}`, {
    method: "DELETE",
    headers: { ...(await authHeaders()) },
  });
  if (!res.ok) throw new Error(`Failed to delete chat (${res.status})`);
  return res.json().catch(() => ({}));
}

/** Whether server-side email sending is configured. */
export async function getNotifyStatus() {
  const res = await fetch("/api/notify/status", { headers: { ...(await authHeaders()) } });
  if (!res.ok) throw new Error(`Failed to check email status (${res.status})`);
  return res.json();
}

/** Email the weekly digest to `email` (or return a preview when unconfigured). */
export async function sendDigestEmail(email, { preview = false, name = "" } = {}) {
  const res = await fetch("/api/notify/digest", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ email, preview, name }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `Failed to send digest (${res.status})`);
  }
  return res.json();
}

/** Send a test email to verify the SMTP setup. */
export async function sendTestEmail(email, { preview = false, name = "" } = {}) {
  const res = await fetch("/api/notify/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ email, preview, name }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `Failed to send test email (${res.status})`);
  }
  return res.json();
}

/** Get the current user's weekly-digest subscription state. */
export async function getSubscription() {
  const res = await fetch("/api/notify/subscription", {
    headers: { ...(await authHeaders()) },
  });
  if (!res.ok) throw new Error(`Failed to load subscription (${res.status})`);
  return res.json();
}

/** Create/update the weekly-digest subscription (subscribe or opt out). */
export async function setSubscription({
  email,
  name = "",
  enabled = true,
  sendDay = 0,
  sendHour = 9,
  timezone = "UTC",
}) {
  const res = await fetch("/api/notify/subscription", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({
      email,
      name,
      enabled,
      send_day: sendDay,
      send_hour: sendHour,
      timezone,
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `Failed to update subscription (${res.status})`);
  }
  return res.json();
}

/** Persist a generated article to the library. Returns the saved record. */
export async function createArticle(payload) {
  const res = await fetch("/api/articles", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to save article (${res.status})`);
  return res.json();
}

/** Delete a saved article by id. */
export async function deleteArticle(id) {
  const res = await fetch(`/api/articles/${id}`, {
    method: "DELETE",
    headers: { ...(await authHeaders()) },
  });
  if (!res.ok && res.status !== 204) throw new Error(`Failed to delete (${res.status})`);
}

/** Delete all saved articles. */
export async function clearArticles() {
  const res = await fetch("/api/articles", {
    method: "DELETE",
    headers: { ...(await authHeaders()) },
  });
  if (!res.ok && res.status !== 204) throw new Error(`Failed to clear (${res.status})`);
}

/** Rewrite a single Markdown section. Returns { markdown }. */
export async function rewriteSection(payload) {
  const res = await fetch("/api/rewrite", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `Rewrite failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.detail) detail = data.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Update a saved article (partial). Returns the updated record. */
export async function updateArticle(id, patch) {
  const res = await fetch(`/api/articles/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed to update (${res.status})`);
  return res.json();
}

/** Generate an AI cover image for a saved article. Returns the updated record. */
export async function generateCover(id) {
  const res = await fetch(`/api/articles/${id}/cover`, {
    method: "POST",
    headers: { ...(await authHeaders()) },
  });
  if (!res.ok) {
    let detail = `Cover failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.detail) detail = data.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Generate FAQ Q&A + JSON-LD schema for an article. */
export async function generateFaq(payload) {
  const res = await fetch("/api/faq", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `FAQ failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.detail) detail = data.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Repurpose an article into an X thread, LinkedIn post, and newsletter blurb. */
export async function generateSocial(payload) {
  const res = await fetch("/api/social", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `Social failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.detail) detail = data.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Rewrite an article to fix the given SEO issues. */
export async function improveSeo(payload) {
  const res = await fetch("/api/seo/improve", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `Improve SEO failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.detail) detail = data.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Translate an article into the target language. */
export async function translateArticle(payload) {
  const res = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `Translate failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.detail) detail = data.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Analyze top-ranking pages for a topic and suggest angles + outline. */
export async function analyzeCompetitors(payload) {
  const res = await fetch("/api/competitors", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `Competitor scan failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.detail) detail = data.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Generate per-section AI images for an article and return the updated markdown + urls. */
export async function generateSectionImages(id) {
  const res = await fetch(`/api/articles/${id}/section-images`, {
    method: "POST",
    headers: { ...(await authHeaders()) },
  });
  if (!res.ok) {
    let detail = `Section images failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.detail) detail = data.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Send a chat message to the AI editor; may return an updated article. */
export async function editChat(payload) {
  const res = await fetch("/api/edit/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `Editor chat failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.detail) detail = data.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }
  return res.json();
}

/**
 * Ask the AI agent what to do. Returns { reply, actions[], provider } where
 * each action is { tool, args }. The frontend executes them in order.
 */
export async function planAgentActions(payload) {
  const res = await fetch("/api/agent/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `Agent planning failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.detail) {
        detail = typeof data.detail === "object" ? JSON.stringify(data.detail) : String(data.detail);
      }
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }
  return res.json();
}
