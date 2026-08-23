"""Article generation service using Google Gemini."""
from __future__ import annotations

import base64
import json
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from ..config import Settings
from ..schemas import (
    AgentAction,
    AgentClarification,
    AgentPlanRequest,
    AgentPlanResponse,
    ClarifyResponse,
    CompetitorPage,
    CompetitorRequest,
    CompetitorResponse,
    EditChatMessage,
    EditChatRequest,
    EditChatResponse,
    FaqItem,
    FaqRequest,
    FaqResponse,
    GenerateRequest,
    GenerateResponse,
    KeywordSuggestRequest,
    KeywordSuggestResponse,
    OutlineExpandRequest,
    OutlineResponse,
    OutlineSection,
    RewriteRequest,
    RewriteResponse,
    SeoImproveRequest,
    SeoImproveResponse,
    SocialRequest,
    SocialResponse,
    SuggestRequest,
    TopicOption,
    TranslateRequest,
    TranslateResponse,
)

_LENGTH_GUIDE = {
    "short": "around 400-500 words",
    "medium": "around 800-1000 words",
    "long": "around 1500-1800 words",
}


_ARTICLE_DELIM = "===ARTICLE==="


def _build_prompt(req: GenerateRequest) -> str:
    keywords = ", ".join(req.keywords) if req.keywords else "none provided"
    return (
        "Write a well-structured, original SEO blog article in Markdown.\n\n"
        f"Topic: {req.topic}\n"
        f"Target audience: {req.audience}\n"
        f"Tone: {req.tone}\n"
        f"Length: {_LENGTH_GUIDE[req.length]}\n"
        f"SEO keywords to naturally include: {keywords}\n\n"
        "Requirements:\n"
        "- Start the article with an engaging H1 title (a single '# ' heading).\n"
        "- Include an introduction, multiple H2/H3 sections, and a conclusion.\n"
        "- Use bullet points and bold text where helpful.\n"
        "- Naturally weave in the SEO keywords (no keyword stuffing).\n\n"
        "Respond in EXACTLY this format, with nothing before or after:\n"
        "- First line: a single-sentence meta description (max 160 characters, plain text).\n"
        f"- Second line: a line containing only {_ARTICLE_DELIM}\n"
        "- Then the full Markdown article, beginning with the H1 title.\n"
    )


def _build_rewrite_prompt(req: RewriteRequest) -> str:
    instruction = (
        req.instruction.strip()
        or "Improve clarity, flow, and engagement while keeping the meaning."
    )
    return (
        "Rewrite the following Markdown section of a blog article.\n\n"
        f"Article topic: {req.topic}\n"
        f"Tone: {req.tone}\n"
        f"Audience: {req.audience}\n"
        f"How to rewrite: {instruction}\n\n"
        "Keep the same Markdown heading and level if the section has one, and keep it "
        "well-structured. Return ONLY the rewritten Markdown for this section — no "
        "preamble, no explanations, no code fences.\n\n"
        "Section:\n"
        f"{req.section}"
    )


def _build_outline_prompt(req: GenerateRequest) -> str:
    keywords = ", ".join(req.keywords) if req.keywords else "none provided"
    return (
        "Create a concise outline for an SEO blog article.\n\n"
        f"Topic: {req.topic}\n"
        f"Target audience: {req.audience}\n"
        f"Tone: {req.tone}\n"
        f"Length: {_LENGTH_GUIDE[req.length]}\n"
        f"SEO keywords: {keywords}\n\n"
        "Output ONLY the outline, in exactly this format:\n"
        "- Each section starts with '## ' followed by the section heading.\n"
        "- Under each heading, 2-4 bullet points starting with '- ' for what to cover.\n"
        "Do NOT write the article itself."
    )


def _parse_outline(text: str) -> list[OutlineSection]:
    sections: list[dict] = []
    current: dict | None = None
    for line in (text or "").splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            if current:
                sections.append(current)
            current = {"heading": stripped[3:].strip(), "points": []}
        elif current is not None and stripped:
            point = stripped.lstrip("-*").strip() if stripped[0] in "-*" else stripped
            if point and not point.startswith("#"):
                current["points"].append(point)
    if current:
        sections.append(current)
    return [
        OutlineSection(heading=s["heading"], points="\n".join(s["points"]))
        for s in sections
        if s["heading"]
    ]


def _build_expand_prompt(req: OutlineExpandRequest) -> str:
    keywords = ", ".join(req.keywords) if req.keywords else "none provided"
    outline_text = "\n".join(
        f"## {s.heading}\n"
        + "\n".join(f"- {p}" for p in s.points.splitlines() if p.strip())
        for s in req.outline
        if s.heading.strip()
    )
    return (
        "Write a complete SEO blog article in Markdown that follows the outline below "
        "EXACTLY (same sections, same order, using the given headings as H2s).\n\n"
        f"Topic: {req.topic}\n"
        f"Target audience: {req.audience}\n"
        f"Tone: {req.tone}\n"
        f"Length: {_LENGTH_GUIDE[req.length]}\n"
        f"SEO keywords to naturally include: {keywords}\n\n"
        "Outline:\n"
        f"{outline_text}\n\n"
        "Requirements:\n"
        "- Start with an engaging H1 title.\n"
        "- Use each outline section as an H2 and expand it into full paragraphs.\n"
        "- Add an introduction and a conclusion; weave in keywords naturally.\n\n"
        "Respond in EXACTLY this format, with nothing before or after:\n"
        "- First line: a single-sentence meta description (max 160 characters, plain text).\n"
        f"- Second line: a line containing only {_ARTICLE_DELIM}\n"
        "- Then the full Markdown article, beginning with the H1 title.\n"
    )


def _build_suggest_prompt(req: SuggestRequest) -> str:
    keywords = ", ".join(req.keywords) if req.keywords else "none provided"
    existing = "\n".join(f"- {h}" for h in req.existing if h.strip()) or "(none yet)"
    return (
        "Suggest 4-5 additional, distinct section ideas for an SEO blog article.\n\n"
        f"Topic: {req.topic}\n"
        f"Target audience: {req.audience}\n"
        f"Tone: {req.tone}\n"
        f"SEO keywords: {keywords}\n\n"
        "Sections already in the outline (do NOT repeat these or close variants):\n"
        f"{existing}\n\n"
        "Output ONLY the new sections, in exactly this format:\n"
        "- Each section starts with '## ' followed by the heading.\n"
        "- Under each heading, 1-3 bullet points starting with '- '.\n"
    )


def _word_count(text: str) -> int:
    return len(re.findall(r"\b\w+\b", text))


def _extract_title(markdown: str, fallback: str) -> str:
    match = re.search(r"^\s{0,3}#\s+(.+?)\s*#*\s*$", markdown, re.MULTILINE)
    return match.group(1).strip() if match else fallback


def _clean_meta(meta: str) -> str:
    meta = meta.strip().strip("`").strip()
    meta = re.sub(r"^(meta description|meta|description)\s*[:\-]\s*", "", meta, flags=re.IGNORECASE)
    return meta.strip().strip('"').strip("'").strip()


def _parse_response(content: str, req: GenerateRequest) -> tuple[str, str, str]:
    """Split model output into (title, meta_description, markdown).

    The model returns a meta line, a delimiter, then Markdown. Falls back
    gracefully if the delimiter is missing so a result is always produced.
    """
    text = (content or "").strip()
    if _ARTICLE_DELIM in text:
        meta_part, _, article_part = text.partition(_ARTICLE_DELIM)
        meta = _clean_meta(meta_part)
        markdown = article_part.strip()
    else:
        markdown = text
        meta = ""
        for line in text.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                meta = _clean_meta(stripped)
                break
    markdown = markdown or text
    title = _extract_title(markdown, req.topic)
    meta = (meta or title)[:160]
    return title, meta, markdown


def _sources_markdown(chunks: list) -> str:
    """Build a deduplicated '## Sources' Markdown section from grounding chunks."""
    seen: set[str] = set()
    lines: list[str] = []
    for chunk in chunks or []:
        web = chunk.get("web") or {}
        uri = (web.get("uri") or "").strip()
        if not uri or uri in seen:
            continue
        seen.add(uri)
        title = (web.get("title") or uri).strip()
        lines.append(f"- [{title}]({uri})")
    if not lines:
        return ""
    return "\n\n## Sources\n\n" + "\n".join(lines) + "\n"


def _sources_markdown_groq(executed_tools: list) -> str:
    """Build a deduplicated '## Sources' section from Groq compound search results."""
    seen: set[str] = set()
    lines: list[str] = []
    for tool in executed_tools or []:
        search_results = tool.get("search_results") if isinstance(tool, dict) else None
        results = search_results.get("results") if isinstance(search_results, dict) else None
        for result in results or []:
            if not isinstance(result, dict):
                continue
            uri = (result.get("url") or "").strip()
            if not uri or uri in seen:
                continue
            seen.add(uri)
            title = (result.get("title") or uri).strip()
            lines.append(f"- [{title}]({uri})")
    if not lines:
        return ""
    return "\n\n## Sources\n\n" + "\n".join(lines) + "\n"


def _build_grounded_prompt(req: GenerateRequest, facts: str) -> str:
    """Prepend verified web research to the standard article prompt."""
    base = _build_prompt(req)
    if not facts.strip():
        return base
    return (
        "Use the following verified, up-to-date research from live web sources as the "
        "factual basis for the article. Do not contradict it, and do not invent facts, "
        "names, dates, or statistics beyond what it supports.\n\n"
        f"<research>\n{facts}\n</research>\n\n"
        f"{base}"
    )


def _article_digest(markdown: str, limit: int = 1200) -> str:
    """Condense an article to headings + concrete detail lines for prompt grounding."""
    if not markdown:
        return ""
    headings: list[str] = []
    details: list[str] = []
    intro = ""
    for line in markdown.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            heading = stripped.lstrip("#").strip()
            if heading and heading.lower() != "sources":
                headings.append(heading)
        elif stripped[0] in "-*":
            if len(details) < 6:
                detail = stripped.lstrip("-*").strip()
                if detail:
                    details.append(detail)
        elif not intro and stripped[0] not in "!|>[":
            intro = stripped
    parts: list[str] = []
    if headings:
        parts.append("Key points: " + "; ".join(headings[:8]) + ".")
    if intro:
        parts.append("Intro: " + intro)
    if details:
        parts.append("Specifics: " + " ".join(details[:6]))
    return " ".join(parts)[:limit]


def _strip_sources(markdown: str) -> str:
    idx = (markdown or "").find("\n## Sources")
    return markdown[:idx].rstrip() if idx != -1 else (markdown or "")


def _parse_agent_json(raw: str) -> dict:
    """Best-effort extraction of a JSON object from a planner reply.

    Handles the happy path (raw is valid JSON) plus the common fallback where
    the model wraps JSON in ```json ... ``` fences or adds a preamble."""
    text = (raw or "").strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        pass
    # Strip markdown fences and try again.
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)
        try:
            return json.loads(text)
        except (json.JSONDecodeError, ValueError):
            pass
    # Last-ditch: find the widest {...} span in the text.
    start = text.find("{")
    end = text.rfind("}")
    if 0 <= start < end:
        try:
            return json.loads(text[start : end + 1])
        except (json.JSONDecodeError, ValueError):
            return {}
    return {}


def _render_library_context(req) -> str:
    """Render a compact library index to keep token consumption minimal."""
    count = getattr(req, "library_count", 0) or 0
    recent = getattr(req, "library_recent", None) or []
    lines = [f"User library (total {count}):"]
    for r in recent[:5]:
        rid = getattr(r, "id", None)
        title = (getattr(r, "title", "") or getattr(r, "topic", "") or "(untitled)").strip()
        lines.append(f"- ID {rid}: {title}")
    return "\n".join(lines)


def _clean_faq(s: str) -> str:
    return s.strip().strip("*_`").strip().strip('"').strip()


def _parse_faq(text: str) -> list[FaqItem]:
    items: list[FaqItem] = []
    question: str | None = None
    answer: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        head = line[:2].upper()
        if head == "Q:":
            if question and answer:
                items.append(
                    FaqItem(question=_clean_faq(question), answer=_clean_faq(" ".join(answer)))
                )
            question = line[2:].strip()
            answer = []
        elif head == "A:":
            answer.append(line[2:].strip())
        elif answer:
            answer.append(line)
    if question and answer:
        items.append(FaqItem(question=_clean_faq(question), answer=_clean_faq(" ".join(answer))))
    return items


def _faq_jsonld(req: FaqRequest, items: list[FaqItem]) -> str:
    faq_page = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": it.question,
                "acceptedAnswer": {"@type": "Answer", "text": it.answer},
            }
            for it in items
        ],
    }
    graph: list[dict] = []
    if req.title or req.meta_description:
        graph.append(
            {
                "@context": "https://schema.org",
                "@type": "Article",
                "headline": req.title or req.topic,
                "description": req.meta_description,
            }
        )
    graph.append(faq_page)
    payload = graph[0] if len(graph) == 1 else graph
    return json.dumps(payload, indent=2, ensure_ascii=False)


def _social_section(text: str, start: str, end: str | None) -> str:
    if start not in text:
        return ""
    part = text.split(start, 1)[1]
    if end and end in part:
        part = part.split(end, 1)[0]
    return part.strip()


def _parse_social(text: str) -> SocialResponse:
    text = text or ""
    thread_raw = _social_section(text, "===THREAD===", "===LINKEDIN===")
    linkedin = _social_section(text, "===LINKEDIN===", "===NEWSLETTER===")
    newsletter = _social_section(text, "===NEWSLETTER===", None)
    thread: list[str] = []
    for line in thread_raw.splitlines():
        tweet = re.sub(r"^\s*\d+\s*[.)/]\s*", "", line.strip()).strip("*`").strip()
        if tweet:
            thread.append(tweet)
    if not thread and not linkedin and not newsletter:
        newsletter = text.strip()
    return SocialResponse(thread=thread[:8], linkedin=linkedin, newsletter=newsletter)


def _parse_competitor_sources(sources_md: str) -> list[CompetitorPage]:
    """Extract [Title](url) items from a '## Sources' markdown block."""
    pages: list[CompetitorPage] = []
    for line in (sources_md or "").splitlines():
        match = re.match(r"^\s*-\s*\[(?P<title>[^\]]+)\]\((?P<url>[^)]+)\)\s*$", line)
        if match:
            pages.append(CompetitorPage(title=match.group("title").strip(), url=match.group("url").strip()))
    return pages


def _parse_competitor_output(text: str, sourced_pages: list[CompetitorPage]) -> CompetitorResponse:
    """Parse the model's TOP_PAGES / GAPS / SECTIONS / WORD_COUNT output."""
    section = None
    top_lines: list[str] = []
    gaps: list[str] = []
    sections: list[str] = []
    word_count = 0
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        upper = line.upper()
        if upper.startswith("TOP_PAGES"):
            section = "top"
            continue
        if upper.startswith("GAPS"):
            section = "gaps"
            continue
        if upper.startswith("SECTIONS"):
            section = "sections"
            continue
        if upper.startswith("WORD_COUNT"):
            match = re.search(r"\d+", line)
            if match:
                word_count = int(match.group())
            section = None
            continue
        stripped = line.lstrip("-*• ").strip()
        if section == "top":
            if stripped.lower() == "none":
                continue
            top_lines.append(stripped)
        elif section == "gaps" and stripped:
            gaps.append(stripped)
        elif section == "sections" and stripped:
            sections.append(stripped)

    pages_by_url = {p.url: p for p in sourced_pages}
    top_pages: list[CompetitorPage] = []
    for idx, entry in enumerate(top_lines[:5]):
        parts = [p.strip() for p in entry.split("|")]
        title = parts[0] if parts and parts[0] else (sourced_pages[idx].title if idx < len(sourced_pages) else "")
        summary = parts[1] if len(parts) > 1 else ""
        angles_raw = parts[2] if len(parts) > 2 else ""
        angles = [a.strip() for a in re.split(r";|•|\|", angles_raw) if a.strip()]
        url = sourced_pages[idx].url if idx < len(sourced_pages) else ""
        if url in pages_by_url:
            page = pages_by_url[url]
            page.title = title or page.title
            page.summary = summary
            page.angles = angles
            top_pages.append(page)
        elif title:
            top_pages.append(CompetitorPage(title=title, url=url, summary=summary, angles=angles))
    if not top_pages:
        top_pages = sourced_pages[:5]
    return CompetitorResponse(
        top_pages=top_pages,
        gaps=gaps[:8],
        suggested_sections=sections[:8],
        word_count_target=word_count,
    )


_CLARIFY_SYSTEM = (
    "You disambiguate blog article topics. Using current, real-world usage, decide whether "
    "the given topic is AMBIGUOUS - that is, a reasonable writer could interpret it as two or "
    "more clearly different subjects (for example an acronym or short phrase with several "
    "meanings). Actively consider modern technology, software, developer, and AI meanings, "
    "INCLUDING recent ones from the last couple of years - not only older or generic meanings. "
    "For example, the acronym 'MCP' now commonly refers to the 'Model Context Protocol'. "
    "A specific, self-explanatory topic is CLEAR.\n\n"
    "If it is CLEAR, reply with exactly one line:\n"
    "CLEAR\n\n"
    "If it is AMBIGUOUS, reply with:\n"
    "AMBIGUOUS\n"
    "then 2 to 5 lines, one per interpretation, ordered with the most likely modern/technical "
    "meaning first, each formatted exactly as:\n"
    "- <specific unambiguous topic> | <one short clarifying sentence>\n\n"
    "Reply with nothing else - no citations, preamble, or trailing notes."
)


def _parse_clarify(text: str) -> ClarifyResponse:
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    if not lines:
        return ClarifyResponse(ambiguous=False)
    # Grounding can prepend a preamble or append citations, so don't require the
    # verdict on line 1; detect it anywhere and collect any "label | description" lines.
    if not any(ln.upper().startswith("AMBIG") for ln in lines):
        return ClarifyResponse(ambiguous=False)
    options: list[TopicOption] = []
    for line in lines:
        if line.upper().startswith("AMBIG") or "|" not in line:
            continue
        cleaned = line.lstrip("-*0123456789. ").strip()
        label, _, desc = cleaned.partition("|")
        label = label.strip()
        if label:
            options.append(TopicOption(label=label, description=desc.strip()))
    if len(options) < 2:
        return ClarifyResponse(ambiguous=False)
    return ClarifyResponse(ambiguous=True, options=options[:5])


def _parse_keywords(text: str, existing: set[str]) -> list[str]:
    """Parse a model reply into a clean, de-duplicated keyword list.

    Accepts newline- or comma-separated output and strips bullets, numbering, and
    surrounding quotes/backticks. Drops blanks, over-long lines, and anything already
    chosen (case-insensitive).
    """
    out: list[str] = []
    seen = set(existing)
    for raw in (text or "").replace(",", "\n").splitlines():
        kw = re.sub(r"^\s*\d+[.)]\s*", "", raw.strip())
        kw = kw.lstrip("-*\u2022").strip().strip('"').strip("'").strip("`").strip()
        if not kw or len(kw) > 60:
            continue
        low = kw.lower()
        if low in seen:
            continue
        seen.add(low)
        out.append(kw)
    return out


_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
_GROQ_BASE_URL = "https://api.groq.com/openai/v1"


def _create_with_retry(client, *, retries: int = 1, **kwargs):
    """Call chat.completions.create, retrying once briefly on transient 429 rate limits."""
    from openai import APIStatusError, RateLimitError

    for attempt in range(retries + 1):
        try:
            return client.chat.completions.create(**kwargs)
        except (RateLimitError, APIStatusError) as exc:
            status = getattr(exc, "status_code", getattr(exc, "code", None))
            if status != 429 and not isinstance(exc, RateLimitError):
                raise
            if attempt >= retries:
                raise
            time.sleep(0.5)


class ArticleGenerator:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _text_providers(self) -> list[tuple[str, str, str, str]]:
        """Ordered (name, api_key, base_url, model) for text generation.

        Failover chain using verified active models across Groq and Gemini.
        """
        chain: list[tuple[str, str, str, str]] = []
        if self.settings.groq_api_key:
            chain.append(
                ("groq-120b", self.settings.groq_api_key, _GROQ_BASE_URL, "openai/gpt-oss-120b")
            )
            chain.append(
                ("groq-20b", self.settings.groq_api_key, _GROQ_BASE_URL, "openai/gpt-oss-20b")
            )
            chain.append(
                ("groq-qwen", self.settings.groq_api_key, _GROQ_BASE_URL, "qwen/qwen3.6-27b")
            )
        if self.settings.gemini_api_key:
            chain.append(
                (
                    "gemini-flash-latest",
                    self.settings.gemini_api_key,
                    _GEMINI_BASE_URL,
                    "gemini-flash-latest",
                )
            )
            chain.append(
                (
                    "gemini-36-flash",
                    self.settings.gemini_api_key,
                    _GEMINI_BASE_URL,
                    "gemini-3.6-flash",
                )
            )
            chain.append(
                (
                    "gemini-37-flash",
                    self.settings.gemini_api_key,
                    _GEMINI_BASE_URL,
                    "gemini-3.7-flash",
                )
            )
        return chain

    def _complete(
        self, messages: list, *, temperature: float, max_tokens: int
    ) -> tuple[str, str]:
        """Non-streaming chat completion with provider fallback (Groq -> Gemini).

        Returns (content, provider_name); raises the last error if all providers fail.
        """
        from openai import OpenAI

        chain = self._text_providers()
        if not chain:
            raise ValueError("No LLM provider configured. Set GROQ_API_KEY or GEMINI_API_KEY.")
        last_exc: Exception = RuntimeError("No LLM provider produced a response")
        for name, key, base_url, model in chain:
            # Gemini 2.5 models "think" by default, spending max_tokens before any visible
            # output (truncating long results); disable it for these formatting tasks.
            extra = {"reasoning_effort": "none"} if name == "gemini" else {}
            try:
                client = OpenAI(api_key=key, base_url=base_url)
                completion = _create_with_retry(
                    client,
                    model=model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    **extra,
                )
                return (completion.choices[0].message.content or "", name)
            except Exception as exc:  # noqa: BLE001 - fall through to the next provider
                last_exc = exc
        raise last_exc

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch of texts with Gemini's embeddings model.

        Returns one vector per input, in order. Requires GEMINI_API_KEY (Groq has
        no embeddings API). Inputs are trimmed and sent in small batches.
        """
        from openai import OpenAI

        key = self.settings.gemini_api_key
        if not key:
            raise ValueError("Embeddings require GEMINI_API_KEY.")
        if not texts:
            return []
        client = OpenAI(api_key=key, base_url=_GEMINI_BASE_URL)
        model = self.settings.gemini_embedding_model
        out: list[list[float]] = []
        batch = 32
        for i in range(0, len(texts), batch):
            chunk = [((t or "").strip()[:8000] or " ") for t in texts[i : i + batch]]
            resp = client.embeddings.create(model=model, input=chunk)
            out.extend(list(d.embedding) for d in resp.data)
        return out

    def embed_text(self, text: str) -> list[float]:
        vecs = self.embed_texts([text])
        return vecs[0] if vecs else []

    def answer_library_question(
        self, question: str, contexts: list[dict]
    ) -> tuple[str, str]:
        """Answer a question using retrieved article excerpts (RAG).

        `contexts` is an ordered list of {"title", "snippet"}. Returns
        (answer, provider). The model is told to cite by bracket number.
        """
        if contexts:
            blocks = "\n\n".join(
                f"[{i + 1}] {c.get('title') or 'Untitled'}\n{c.get('snippet') or ''}"
                for i, c in enumerate(contexts)
            )
        else:
            blocks = "(the user's library is empty)"
        system = (
            "You are ContentPilot's library assistant. Answer the user's question "
            "using ONLY the excerpts below, taken from their personal article "
            "library. Cite the articles you draw on by their bracket number, e.g. "
            "[1] or [2]. If the answer isn't present in the excerpts, say you "
            "couldn't find it in their library and suggest what they might write. "
            "Be concise, friendly, and specific.\n\n"
            f"Article excerpts:\n{blocks}"
        )
        return self._complete(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": question.strip()[:2000]},
            ],
            temperature=0.3,
            max_tokens=800,
        )

    def suggest_internal_links(
        self, *, markdown: str, candidates: list[dict]
    ) -> tuple[list[dict], str]:
        """Propose internal links from the current article to related articles.

        `candidates` is an ordered list of {"id", "title", "topic"} (already ranked
        by semantic similarity). Returns (suggestions, provider) where each suggestion
        is {"target_id", "anchor_text", "reason"}. The anchor text is chosen to be a
        short phrase that actually appears in the article, so the frontend can splice
        a Markdown link over the first match. Never raises — returns [] on failure.
        """
        if not candidates:
            return [], ""
        listed = "\n".join(
            f'{c["id"]}: {c.get("title") or c.get("topic") or "Untitled"}'
            + (f' — about {c.get("topic")}' if c.get("topic") else "")
            for c in candidates
        )
        body = _strip_sources(markdown or "")[:6000]
        system = (
            "You are an SEO editor adding INTERNAL LINKS between a writer's own "
            "articles. Given the current article and a list of their OTHER articles "
            "(with ids), pick the best, most natural internal-linking opportunities. "
            "For each, choose an ANCHOR PHRASE that appears VERBATIM in the current "
            "article and that is topically relevant to the target article. Only "
            "suggest a link when it genuinely helps the reader — never force it.\n\n"
            'Reply with STRICT JSON: {"links": [{"target_id": <int>, "anchor_text": '
            '"<exact phrase from the article>", "reason": "<short why>"}]}. Use each '
            "target article at most once, each anchor phrase at most once, and keep "
            "anchor phrases under 8 words. If nothing fits, return an empty list."
        )
        user = f"Current article:\n{body}\n\nTheir other articles:\n{listed}"
        try:
            raw, provider = self._complete_json(
                [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                temperature=0.3,
                max_tokens=1024,
            )
        except Exception:  # noqa: BLE001 - suggestions must never hard-fail
            return [], ""
        data = _parse_agent_json(raw)
        valid_ids = {int(c["id"]) for c in candidates}
        out: list[dict] = []
        seen_ids: set[int] = set()
        seen_anchors: set[str] = set()
        for item in data.get("links", []) if isinstance(data, dict) else []:
            try:
                tid = int(item.get("target_id"))
            except (TypeError, ValueError):
                continue
            anchor = str(item.get("anchor_text") or "").strip()
            if tid not in valid_ids or tid in seen_ids or not anchor:
                continue
            # The anchor must actually be in the article to be splice-able.
            if anchor.lower() not in (markdown or "").lower():
                continue
            low = anchor.lower()
            if low in seen_anchors:
                continue
            seen_ids.add(tid)
            seen_anchors.add(low)
            out.append(
                {
                    "target_id": tid,
                    "anchor_text": anchor,
                    "reason": str(item.get("reason") or "").strip()[:200],
                }
            )
        return out, provider

    def _stream_chat(self, messages: list, *, temperature: float, max_tokens: int):
        """Streaming chat with provider fallback (Groq -> Gemini).

        Re-routes to the next provider only if stream creation fails (auth/429); once
        tokens start flowing a mid-stream error can't be re-routed.
        """
        from openai import OpenAI

        chain = self._text_providers()
        if not chain:
            raise ValueError("No LLM provider configured. Set GROQ_API_KEY or GEMINI_API_KEY.")
        last_exc: Exception = RuntimeError("No LLM provider produced a response")
        for name, key, base_url, model in chain:
            extra = {"reasoning_effort": "none"} if name == "gemini" else {}
            try:
                client = OpenAI(api_key=key, base_url=base_url)
                stream = _create_with_retry(
                    client,
                    model=model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    stream=True,
                    **extra,
                )
            except Exception as exc:  # noqa: BLE001 - try the next provider
                last_exc = exc
                continue
            for chunk in stream:
                if chunk.choices:
                    delta = chunk.choices[0].delta.content
                    if delta:
                        yield delta
            return
        raise last_exc

    def generate(self, req: GenerateRequest) -> GenerateResponse:
        content, provider = self._complete(
            [
                {"role": "system", "content": "You are an expert SEO content writer."},
                {"role": "user", "content": _build_prompt(req)},
            ],
            temperature=0.8,
            max_tokens=8192,
        )
        title, meta, markdown = _parse_response(content, req)
        return GenerateResponse(
            title=title,
            meta_description=meta,
            markdown=markdown,
            word_count=_word_count(markdown),
            provider=provider,
        )

    def clarify_topic(self, topic: str) -> ClarifyResponse:
        """Detect whether a topic is ambiguous; if so, return distinct interpretations.

        Prefers a google_search-grounded call so recent/technical meanings (e.g. an
        acronym coined in the last year) are surfaced, and falls back to a fast plain
        call if grounding fails. Never raises - on any error or rate limit it reports
        'not ambiguous' so the clarify step can never block article generation.
        """
        if not self.settings.gemini_api_key:
            return ClarifyResponse(ambiguous=False)

        text = self._grounded_clarify(topic)
        if not text:
            text = self._plain_clarify(topic)
        return _parse_clarify(text)

    def _grounded_clarify(self, topic: str) -> str:
        """Enumerate a topic's current meanings via Gemini's google_search grounding."""
        model = self.settings.gemini_model
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        body = json.dumps(
            {
                "contents": [
                    {"role": "user", "parts": [{"text": f"{_CLARIFY_SYSTEM}\n\nTopic: {topic}"}]}
                ],
                "tools": [{"google_search": {}}],
                "generationConfig": {"temperature": 0.2, "maxOutputTokens": 1024},
            }
        ).encode()
        request = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": self.settings.gemini_api_key,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=45) as resp:
                data = json.load(resp)
        except Exception:  # noqa: BLE001 - fall back to the plain clarify call
            return ""
        candidates = data.get("candidates") or []
        if not candidates:
            return ""
        return "".join(
            part.get("text", "")
            for part in candidates[0].get("content", {}).get("parts", [])
        ).strip()

    def _plain_clarify(self, topic: str) -> str:
        """Fast, ungrounded clarify call (Groq -> Gemini) used as a fallback."""
        try:
            text, _ = self._complete(
                [
                    {"role": "system", "content": _CLARIFY_SYSTEM},
                    {"role": "user", "content": f"Topic: {topic}"},
                ],
                temperature=0.3,
                max_tokens=1024,
            )
        except Exception:  # noqa: BLE001 - degrade gracefully to 'not ambiguous'
            return ""
        return text

    def generate_grounded(self, req: GenerateRequest) -> GenerateResponse:
        """Generate an article grounded in live web search results (with sources).

        Two steps: (1) research gathers current, cited facts - Groq web search
        preferred, with a full fallback to Gemini's google_search grounding; (2) the
        article is written from those facts (Groq preferred, Gemini fallback), with a
        '## Sources' section appended. If all research fails, it degrades to ungrounded.
        """
        try:
            facts, sources_md = self._gather_research(req)
        except Exception:  # noqa: BLE001 - all grounding failed; degrade to ungrounded
            facts, sources_md = "", ""

        content, provider = self._complete(
            [
                {
                    "role": "system",
                    "content": "You are an expert SEO content writer. Ground the article "
                    "in the provided research and never invent facts.",
                },
                {"role": "user", "content": _build_grounded_prompt(req, facts)},
            ],
            temperature=0.7,
            max_tokens=8192,
        )
        title, meta, markdown = _parse_response(content, req)
        if sources_md:
            markdown = markdown.rstrip() + sources_md
        return GenerateResponse(
            title=title,
            meta_description=meta,
            markdown=markdown,
            word_count=_word_count(markdown),
            provider=f"{provider} · web-grounded" if sources_md else provider,
        )

    def _research(self, req: GenerateRequest) -> tuple[str, str]:
        """Gather grounded facts + a Sources section via Gemini's google_search tool."""
        model = self.settings.gemini_model
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        keywords = ", ".join(req.keywords) if req.keywords else ""
        query = f"Research this topic and list detailed, accurate, up-to-date facts: {req.topic}."
        if keywords:
            query += f" Pay attention to: {keywords}."
        query += (
            " Include key concepts, recent developments, specific names, dates, and figures. "
            "Present the findings as concise bullet points."
        )
        body = json.dumps(
            {
                "contents": [{"role": "user", "parts": [{"text": query}]}],
                "tools": [{"google_search": {}}],
                "generationConfig": {"temperature": 0.3, "maxOutputTokens": 4096},
            }
        ).encode()
        request = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": self.settings.gemini_api_key,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as resp:
                data = json.load(resp)
        except urllib.error.HTTPError as exc:
            err = RuntimeError(f"Web research failed ({exc.code})")
            err.status_code = exc.code
            raise err from exc

        candidates = data.get("candidates") or []
        if not candidates:
            return "", ""
        candidate = candidates[0]
        facts = "".join(
            part.get("text", "")
            for part in candidate.get("content", {}).get("parts", [])
        ).strip()
        sources_md = _sources_markdown(
            candidate.get("groundingMetadata", {}).get("groundingChunks", [])
        )
        return facts, sources_md

    def _research_groq(self, req: GenerateRequest) -> tuple[str, str]:
        """Gather grounded facts + a Sources section via Groq's compound web search.

        Uses the `groq/compound-mini` agentic system (Tavily-backed) through the
        OpenAI-compatible client. Returns (facts, sources_md); the compound system
        decides when to search, exposing results under message.executed_tools.
        """
        from openai import OpenAI

        keywords = ", ".join(req.keywords) if req.keywords else ""
        query = (
            f"Research this topic and list detailed, accurate, up-to-date facts: {req.topic}."
        )
        if keywords:
            query += f" Pay attention to: {keywords}."
        query += (
            " Include key concepts, recent developments, specific names, dates, and figures. "
            "Present the findings as concise bullet points."
        )
        client = OpenAI(api_key=self.settings.groq_api_key, base_url=_GROQ_BASE_URL)
        completion = _create_with_retry(
            client,
            model=self.settings.groq_compound_model,
            messages=[{"role": "user", "content": query}],
            temperature=0.3,
            max_tokens=1024,
        )
        message = completion.model_dump().get("choices", [{}])[0].get("message", {})
        facts = (message.get("content") or "").strip()
        sources_md = _sources_markdown_groq(message.get("executed_tools") or [])
        return facts, sources_md

    def _gather_research(self, req: GenerateRequest) -> tuple[str, str]:
        """Web grounding with provider fallback: Groq compound search -> Gemini.

        Tries Groq's web search first (when a Groq key is set); if it fails or returns
        nothing, falls back entirely to Gemini's google_search grounding.
        """
        if self.settings.groq_api_key:
            try:
                facts, sources_md = self._research_groq(req)
                if facts.strip():
                    return facts, sources_md
            except Exception:  # noqa: BLE001 - fall back to Gemini grounding
                pass
        return self._research(req)

    def _stream(self, prompt: str, system: str = "You are an expert SEO content writer."):
        yield from self._stream_chat(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            temperature=0.8,
            max_tokens=8192,
        )

    def stream_generate(self, req: GenerateRequest):
        """Stream a full article for the request."""
        yield from self._stream(_build_prompt(req))

    def stream_generate_from_outline(self, req: OutlineExpandRequest):
        """Stream a full article that follows the provided outline."""
        yield from self._stream(_build_expand_prompt(req))

    def stream_generate_grounded(self, req: GenerateRequest):
        """Stream a web-grounded article.

        Researches live sources first (blocking): Groq web search preferred, with a
        full fallback to Gemini's google_search grounding. Then streams the article
        written from those facts (Groq preferred, Gemini fallback), and finally yields
        a '## Sources' section. If all research fails, it degrades to an ungrounded
        article instead of erroring.
        """
        try:
            facts, sources_md = self._gather_research(req)
        except Exception:  # noqa: BLE001 - all grounding failed; degrade to ungrounded
            facts, sources_md = "", ""
        yield from self._stream(
            _build_grounded_prompt(req, facts),
            system=(
                "You are an expert SEO content writer. Ground the article in the "
                "provided research and never invent facts."
            ),
        )
        if sources_md:
            yield sources_md

    def generate_outline(self, req: GenerateRequest) -> OutlineResponse:
        text, _ = self._complete(
            [
                {"role": "system", "content": "You are an expert SEO content strategist."},
                {"role": "user", "content": _build_outline_prompt(req)},
            ],
            temperature=0.7,
            max_tokens=1024,
        )
        return OutlineResponse(sections=_parse_outline(text))

    def suggest_sections(self, req: SuggestRequest) -> OutlineResponse:
        text, _ = self._complete(
            [
                {"role": "system", "content": "You are an expert SEO content strategist."},
                {"role": "user", "content": _build_suggest_prompt(req)},
            ],
            temperature=0.9,
            max_tokens=512,
        )
        existing = {h.strip().lower() for h in req.existing if h.strip()}
        sections = [
            s for s in _parse_outline(text) if s.heading.strip().lower() not in existing
        ]
        return OutlineResponse(sections=sections[:5])

    def suggest_keywords(self, req: KeywordSuggestRequest) -> KeywordSuggestResponse:
        """Suggest SEO keywords for a topic. Never raises - returns [] on failure.

        Blends short head terms with longer-tail phrases a writer should realistically
        target, skipping any the user has already chosen.
        """
        existing = {k.strip().lower() for k in req.existing if k.strip()}
        system = (
            "You are an expert SEO strategist. Given a topic, return the most valuable, "
            "realistic search keywords and phrases a writer should target to rank - a mix "
            "of short head terms and longer-tail phrases people actually search for. Every "
            "keyword must be directly relevant to the topic."
        )
        user = f"Topic: {req.topic}\nAudience: {req.audience or 'a general audience'}"
        if existing:
            user += "\nAlready chosen (do NOT repeat these): " + ", ".join(sorted(existing))
        user += (
            "\n\nReturn 8-12 keywords, ordered by SEO value. Reply with ONLY the keywords, "
            "one per line, with no numbering, bullets, quotes, or commentary."
        )
        try:
            text, _ = self._complete(
                [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                temperature=0.7,
                max_tokens=512,
            )
        except Exception:  # noqa: BLE001 - suggestions must never block the form
            return KeywordSuggestResponse(keywords=[])
        return KeywordSuggestResponse(keywords=_parse_keywords(text, existing)[:12])

    def generate_faq(self, req: FaqRequest) -> FaqResponse:
        """Generate FAQ Q&A from the article plus copy-paste JSON-LD (FAQPage/Article)."""
        prompt = (
            f"Based on the article below, write {req.count} frequently asked questions with "
            "concise, accurate answers a reader would realistically search for. Base the answers "
            "ONLY on the article's content, and keep each answer to 1-3 sentences.\n\n"
            "Format your reply EXACTLY as repeated blocks with one blank line between blocks, "
            "and nothing else:\n"
            "Q: <question>\n"
            "A: <answer>\n\n"
            f"Article title: {req.title or req.topic}\n\n"
            f"{_strip_sources(req.markdown)}"
        )
        text, _ = self._complete(
            [
                {"role": "system", "content": "You are an expert SEO content strategist."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.6,
            max_tokens=1536,
        )
        items = _parse_faq(text)
        return FaqResponse(items=items, jsonld=_faq_jsonld(req, items))

    def generate_social(self, req: SocialRequest) -> SocialResponse:
        """Repurpose the article into an X thread, a LinkedIn post, and a newsletter blurb."""
        prompt = (
            "Repurpose the article below into social content. Pull SPECIFIC facts, numbers, "
            "names, and examples straight from the article - never vague generalities. Write "
            "like a sharp, human creator, not a press release, and use NO Markdown symbols "
            "(no **, #, or backticks). Every piece is SELF-CONTAINED: never tell readers to "
            "'read the full article', 'read more', or click a link.\n\n"
            "Output EXACTLY these three sections, each led by its exact header line, and nothing "
            "else:\n\n"
            "===THREAD===\n"
            "An X/Twitter thread of 5-7 posts, each on ONE line with no internal line breaks:\n"
            "- Post 1 is a scroll-stopping hook: a bold claim, a surprising stat, or a sharp "
            "question. No hashtags in the hook.\n"
            "- Each middle post delivers ONE concrete, standalone insight or fact from the article.\n"
            "- The last post lands the key takeaway and drives engagement (a question, a bold "
            "prediction, or 'follow for more'), plus 1-2 relevant hashtags - no external links.\n"
            "- Keep every post under 270 characters, use at most one emoji per post, and do NOT "
            "number them.\n\n"
            "===LINKEDIN===\n"
            "One personable, professional LinkedIn post:\n"
            "- Open with a one-line hook that stops the scroll, then a blank line.\n"
            "- Use short 1-2 sentence paragraphs separated by blank lines for whitespace.\n"
            "- Include 3-4 concrete takeaways as a bulleted list, each line starting with the "
            "bullet character '\u2022'.\n"
            "- Add a blank line, then a question that invites comments.\n"
            "- Finally, put 3-5 relevant hashtags on their OWN last line.\n\n"
            "===NEWSLETTER===\n"
            "A full-length newsletter edition (aim for 220-320 words total). Use everyday, "
            "conversational language and specific facts, numbers, names, and examples from the "
            "article. Format it EXACTLY like this, each label on its own line:\n"
            "Subject: <curiosity-driven subject line under 60 characters>\n"
            "Preview: <one sentence, 40-90 characters, that shows up under the subject in an inbox>\n"
            "Intro: <3-4 sentence opening that hooks the reader, frames why this topic matters "
            "right now, and hints at the specific insights below>\n"
            "Highlights:\n"
            "- <punchy 3-6 word headline> | <2-3 sentences with a specific fact, number, or "
            "example from the article and why it matters>\n"
            "- <punchy 3-6 word headline> | <2-3 sentences with a specific fact, number, or "
            "example from the article and why it matters>\n"
            "- <punchy 3-6 word headline> | <2-3 sentences with a specific fact, number, or "
            "example from the article and why it matters>\n"
            "- <punchy 3-6 word headline> | <2-3 sentences with a specific fact, number, or "
            "example from the article and why it matters>\n"
            "- <punchy 3-6 word headline> | <2-3 sentences with a specific fact, number, or "
            "example from the article and why it matters>\n"
            "Why it matters: <a 2-3 sentence paragraph that connects these highlights to a "
            "bigger trend or a practical implication for the reader>\n"
            "CTA: <one punchy closing line that lands the single biggest takeaway or poses a "
            "thought-provoking question - do NOT mention reading a full article or a link>\n\n"
            f"Article title: {req.title or req.topic}\n\n"
            f"{_strip_sources(req.markdown)}"
        )
        text, _ = self._complete(
            [
                {
                    "role": "system",
                    "content": "You are an elite social media ghostwriter who turns articles into "
                    "scroll-stopping, platform-native posts that sound genuinely human - punchy, "
                    "specific, and free of corporate fluff.",
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.85,
            max_tokens=2400,
        )
        return _parse_social(text)

    def improve_seo(self, req: SeoImproveRequest) -> SeoImproveResponse:
        """Rewrite the article to fix the given SEO issues, preserving its meaning."""
        keywords = ", ".join(k for k in req.keywords if k.strip()) or "none provided"
        issues_text = (
            "\n".join(f"- {i}" for i in req.issues if i.strip())
            or "- General SEO polish: readability, keyword usage, structure."
        )
        prompt = (
            "Rewrite the article below so it PASSES the specific SEO issues listed. "
            "Preserve meaning, facts, tone, and audience; do not shorten or bloat unnecessarily.\n\n"
            f"Topic: {req.topic}\n"
            f"Target audience: {req.audience}\n"
            f"Tone: {req.tone}\n"
            f"SEO keywords: {keywords}\n\n"
            "SEO issues to fix (each 'detail' shows the CURRENT value and the TARGET range - "
            "you MUST land inside the target range for every one):\n"
            f"{issues_text}\n\n"
            "Hard requirements you MUST hit:\n"
            "- Title: 50-60 characters. Count characters before you finalise it.\n"
            "- Meta description: 120-160 characters, single sentence, natural prose.\n"
            "- Exactly ONE H1 (the title). Use H2 for at least 3 main sections; use H3 for "
            "sub-points if needed.\n"
            "- If a target keyword is provided, it MUST appear in the H1 title and 3-6 times "
            "across the body (roughly 0.5-1.5% density) - naturally, never keyword-stuffed.\n"
            "- Readability: aim for Flesch Reading Ease around 65+. Use short sentences "
            "(mostly under 20 words), everyday words, active voice, and split long paragraphs.\n"
            "- Length: hit the word count target in the issues above within +/- 10%.\n\n"
            "Respond in EXACTLY this format, with nothing before or after:\n"
            "- First line: the meta description (a single sentence, 120-160 characters, plain text).\n"
            f"- Second line: a line containing only {_ARTICLE_DELIM}\n"
            "- Then the full Markdown article, beginning with the H1 title.\n\n"
            "Article to improve:\n"
            f"{_strip_sources(req.markdown)}"
        )
        content, provider = self._complete(
            [
                {
                    "role": "system",
                    "content": "You are a meticulous SEO editor. You count characters and words, "
                    "and you write short, plain-English sentences that score high on readability.",
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.4,
            max_tokens=8192,
        )
        stub = GenerateRequest(topic=req.topic or req.title or "article", tone="informative")
        title, meta, markdown = _parse_response(content, stub)
        return SeoImproveResponse(
            title=title or req.title,
            meta_description=meta or req.meta_description,
            markdown=markdown,
            word_count=_word_count(markdown),
            provider=provider,
        )

    def translate(self, req: TranslateRequest) -> TranslateResponse:
        """Translate the article to the target language while preserving Markdown."""
        lang = req.target_language.strip()
        prompt = (
            f"Translate the following blog article into {lang}. Rules you MUST follow:\n"
            "- Preserve the ENTIRE Markdown structure: keep every '#', '##', '###' heading at "
            "the same level, keep bullet lists ('-', '*'), numbered lists, blockquotes (>), "
            "code fences (```), inline code (`), tables, and links exactly as they are.\n"
            "- Translate the visible text only. Do NOT translate URLs, code, code fences, or "
            "technical identifiers.\n"
            "- Keep proper nouns and brand names in their original form.\n"
            "- Match the original tone and reading level; write natural, idiomatic "
            f"{lang} - not a literal word-for-word translation.\n\n"
            "Respond in EXACTLY this format, with nothing before or after:\n"
            f"- First line: the meta description translated into {lang} (single sentence, 120-160 characters).\n"
            f"- Second line: a line containing only {_ARTICLE_DELIM}\n"
            f"- Then the fully translated Markdown article, beginning with the H1 title in {lang}.\n\n"
            f"Original title: {req.title}\n"
            f"Original meta: {req.meta_description}\n\n"
            "Article:\n"
            f"{_strip_sources(req.markdown)}"
        )
        content, provider = self._complete(
            [
                {
                    "role": "system",
                    "content": f"You are a professional translator producing natural, idiomatic {lang} "
                    "while preserving Markdown structure precisely.",
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.4,
            max_tokens=8192,
        )
        stub = GenerateRequest(topic=req.title or "article", tone="informative")
        title, meta, markdown = _parse_response(content, stub)
        return TranslateResponse(
            title=title or req.title,
            meta_description=meta or req.meta_description,
            markdown=markdown,
            target_language=lang,
            word_count=_word_count(markdown),
            provider=provider,
        )

    def analyze_competitors(self, req: CompetitorRequest) -> CompetitorResponse:
        """Analyze top-ranking pages for a topic and suggest angles, gaps, and sections.

        Uses live web search (Groq compound preferred, Gemini google_search fallback) to
        gather real pages, then asks the model to summarise them and propose an outline
        that outranks them. Falls back to an ungrounded strategic outline if search fails.
        """
        stub = GenerateRequest(
            topic=req.topic,
            keywords=req.keywords,
            tone="informative",
            length="long",
            audience="a general audience",
        )
        try:
            facts, sources_md = self._gather_research(stub)
        except Exception:  # noqa: BLE001 - degrade to ungrounded strategy
            facts, sources_md = "", ""

        pages = _parse_competitor_sources(sources_md)
        kw = ", ".join(k for k in req.keywords if k.strip()) or "none provided"
        prompt = (
            "You are an SEO strategist. Based ONLY on the research and sources below, "
            "analyse how to write an article on the topic that outranks the current top "
            "results. Be specific and concrete.\n\n"
            f"Topic: {req.topic}\n"
            f"Target keywords: {kw}\n\n"
            "Research:\n"
            f"{facts or '(no live research available)'}\n\n"
            f"{sources_md if sources_md else ''}\n\n"
            "Output EXACTLY these labelled sections, one per line, with no preamble and "
            "no Markdown symbols:\n"
            "TOP_PAGES:\n"
            "For up to 5 of the sources above, one per line: \n"
            "<page title> | <one-sentence summary of what it covers> | <angle 1>; <angle 2>\n"
            "(if there are no sources, write 'none')\n"
            "GAPS:\n"
            "- <gap 1: what the top results miss>\n"
            "- <gap 2>\n"
            "- <gap 3>\n"
            "SECTIONS:\n"
            "- <suggested H2 section 1>\n"
            "- <suggested H2 section 2>\n"
            "- <suggested H2 section 3>\n"
            "- <suggested H2 section 4>\n"
            "- <suggested H2 section 5>\n"
            "WORD_COUNT: <one integer, the recommended article length in words>\n"
        )
        text, provider = self._complete(
            [
                {
                    "role": "system",
                    "content": "You give sharp, specific SEO competitive analysis grounded in "
                    "the provided research and sources.",
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.4,
            max_tokens=2048,
        )
        parsed = _parse_competitor_output(text, pages)
        parsed.provider = provider
        return parsed

    def generate_section_images(
        self,
        *,
        title: str,
        topic: str,
        keywords: list[str] | None,
        markdown: str,
        upload,
        max_sections: int = 8,
    ) -> tuple[str, list[str]]:
        """Generate an image for each H2 section and insert it right after the heading.

        `upload(data: bytes, mime: str) -> str` persists the image and returns its
        public URL (e.g. a Cloudflare R2 upload). Returns (new_markdown, image_urls).
        Existing markdown images are preserved and no duplicate image is added to a
        section that already has one.
        """
        lines = (markdown or "").splitlines()
        section_indices: list[int] = []
        current: list[int] | None = None
        h2_blocks: list[dict] = []
        for idx, line in enumerate(lines):
            if line.startswith("## ") and not line.lower().startswith("## sources"):
                if current is not None:
                    h2_blocks[-1]["end"] = idx
                h2_blocks.append({"heading": line[3:].strip(), "start": idx, "end": len(lines)})
                current = h2_blocks[-1]
                section_indices.append(idx)
        if current is not None:
            h2_blocks[-1]["end"] = len(lines)

        image_urls: list[str] = []
        insertions: list[tuple[int, str]] = []  # (line_index_to_insert_after, markdown_snippet)
        for block in h2_blocks[:max_sections]:
            section_text = "\n".join(lines[block["start"] : block["end"]])
            if "![" in section_text:
                continue  # already has an image
            prompt = self.build_cover_prompt(
                title=block["heading"] or title,
                topic=f"{topic}: {block['heading']}" if topic else block["heading"],
                keywords=keywords,
                content=section_text,
            )
            try:
                data, mime = self.generate_cover_image(prompt)
                hint = f"{title or topic}-{block['heading'] or 'section'}"
                try:
                    url = upload(data, mime, name_hint=hint)
                except TypeError:
                    url = upload(data, mime)
            except Exception:  # noqa: BLE001 - skip failing sections rather than aborting
                continue
            image_urls.append(url)
            insertions.append((block["start"], f"\n![{block['heading']}]({url})\n"))

        if not insertions:
            return markdown, []
        # Apply insertions from the bottom so earlier indices remain valid.
        new_lines = list(lines)
        for line_index, snippet in sorted(insertions, key=lambda t: -t[0]):
            new_lines.insert(line_index + 1, snippet)
        return "\n".join(new_lines), image_urls

    def edit_chat(self, req: EditChatRequest) -> EditChatResponse:
        """Chat with the article. Returns a reply and, if the user asked for a change,
        the updated Markdown split by _ARTICLE_DELIM."""
        history = [
            {"role": m.role, "content": m.content}
            for m in (req.messages or [])
            if m.content.strip()
        ]
        if not history:
            raise ValueError("No user message provided.")
        system = (
            "You are an expert AI editor helping the user refine a blog article. Answer their "
            "questions clearly and concisely.\n\n"
            "IMPORTANT rules for updates:\n"
            "- If (and only if) the user asks you to CHANGE the article (rewrite, tighten, add "
            "a section, remove something, fix a fact, add a stat, restructure, etc.), apply the "
            "change to the ENTIRE article and output it after the delimiter below.\n"
            "- Do NOT output the delimiter or article if the user is only asking a question or "
            "making small talk.\n"
            "- When you do update, preserve the article's tone and voice. Keep exactly one H1. "
            "Do not add commentary inside the article.\n\n"
            "Response format when updating the article:\n"
            "<your short natural reply explaining what you changed, 1-3 sentences>\n"
            f"{_ARTICLE_DELIM}\n"
            "<the FULL updated Markdown article, beginning with the H1 title>\n\n"
            "Response format when NOT updating (question / discussion):\n"
            "<your natural conversational reply>\n\n"
            "Here is the current article you are helping to edit:\n"
            f"Title: {req.title}\n"
            f"Meta description: {req.meta_description}\n\n"
            "Markdown:\n"
            f"{_strip_sources(req.markdown)}"
        )
        content, provider = self._complete(
            [{"role": "system", "content": system}, *history],
            temperature=0.5,
            max_tokens=8192,
        )
        text = (content or "").strip()
        if _ARTICLE_DELIM in text:
            reply_part, _, article_part = text.partition(_ARTICLE_DELIM)
            reply = reply_part.strip() or "Updated the article."
            markdown = article_part.strip()
            title = _extract_title(markdown, req.title)
            return EditChatResponse(
                reply=reply,
                updated=True,
                title=title,
                meta_description=req.meta_description,
                markdown=markdown,
                word_count=_word_count(markdown),
                provider=provider,
            )
        return EditChatResponse(reply=text, updated=False, provider=provider)

    def plan_agent_actions(self, req: AgentPlanRequest) -> AgentPlanResponse:
        """Route a chat message to zero or more tool calls the frontend will run.

        The planner returns strict JSON:
            {"reply": "...", "actions": [{"tool": "...", "args": {...}}, ...]}

        If the message is a plain question or discussion, actions=[]. The frontend
        executes each returned action in order, using the same endpoints the
        toolbar buttons hit."""
        history = [
            {"role": m.role, "content": m.content}
            for m in (req.messages or [])
            if m.content.strip()
        ]
        if not history:
            raise ValueError("No user message provided.")

        # Cap the article digest to 300 chars and chat history to last 3 turns
        raw_markdown = _strip_sources(req.markdown) if req.markdown else ""
        digest = _article_digest(raw_markdown, limit=300) if raw_markdown else ""
        if not digest:
            digest = raw_markdown[:300]
        history = history[-3:]
        kw = ", ".join(k for k in (req.keywords or []) if k.strip())
        system = (
            "You are ContentPilot Agent. Answer questions about the article or route to tools.\n"
            "Tools: edit(instruction), improve_seo(), translate(language), section_images(), cover_image(), social(), faq(), competitors(), seo_report(), proofread(), summarize(), export(format: 'pdf'|'html').\n"
            "Rules:\n"
            "- Plain questions: reply naturally, actions=[].\n"
            "- Ambiguous requests: reply with clarification object {question, options: []}, actions=[].\n"
            "- Cross-article: if question matches a library article below, answer directly and return switch_to_article_id: <int id>.\n"
            "- Unrelated/off-topic: reply 'That topic is not mentioned in any article in your library. Please ask a question related to your articles, or generate a new article in the Generator.'\n"
            "Output JSON ONLY: {\"reply\": \"...\", \"actions\": [{\"tool\": \"...\", \"args\": {}}], \"clarification\": null, \"switch_to_article_id\": null}\n\n"
            f"Article: {req.title} | Topic: {req.topic} | Keywords: {kw or 'none'}\n"
            f"Digest: {digest}\n"
            f"{_render_library_context(req)}"
        )

        # Try JSON-mode first; if a provider rejects response_format, fall back to
        # a plain completion and parse whatever JSON block we can find.
        raw = ""
        provider = ""
        try:
            raw, provider = self._complete_json(
                [{"role": "system", "content": system}, *history],
                temperature=0.2,
                max_tokens=300,
            )
        except Exception:  # noqa: BLE001 - fall through to plain _complete
            raw, provider = self._complete(
                [{"role": "system", "content": system}, *history],
                temperature=0.2,
                max_tokens=300,
            )

        data = _parse_agent_json(raw)
        reply = str(data.get("reply") or "").strip() or "OK."

        switch_id_raw = data.get("switch_to_article_id")
        switch_to_article_id = None
        if switch_id_raw is not None:
            try:
                switch_to_article_id = int(switch_id_raw)
            except (ValueError, TypeError):
                switch_to_article_id = None

        clarification: AgentClarification | None = None
        c_raw = data.get("clarification")
        if isinstance(c_raw, dict):
            q = str(c_raw.get("question") or "").strip()
            opts_raw = c_raw.get("options") or []
            opts = [
                str(o).strip()
                for o in opts_raw
                if isinstance(o, (str, int, float)) and str(o).strip()
            ][:6]
            if q:
                try:
                    clarification = AgentClarification(question=q, options=opts)
                except Exception:  # noqa: BLE001 - skip malformed clarification
                    clarification = None

        actions_raw = data.get("actions") or []
        actions: list[AgentAction] = []
        # When the planner is asking a clarification, ignore any accidental actions
        # so we never run something the user didn't confirm.
        if clarification is None:
            for a in actions_raw:
                if not isinstance(a, dict):
                    continue
                tool = str(a.get("tool") or "").strip()
                if tool not in {
                    "edit",
                    "improve_seo",
                    "translate",
                    "section_images",
                    "cover_image",
                    "social",
                    "faq",
                    "competitors",
                    "export",
                    "seo_report",
                    "proofread",
                    "summarize",
                }:
                    continue
                args = a.get("args") if isinstance(a.get("args"), dict) else {}
                try:
                    actions.append(AgentAction(tool=tool, args=args))
                except Exception:  # noqa: BLE001 - skip malformed action
                    continue
        return AgentPlanResponse(
            reply=reply,
            actions=actions,
            clarification=clarification,
            switch_to_article_id=switch_to_article_id,
            provider=provider,
        )

    def _complete_json(
        self, messages: list, *, temperature: float, max_tokens: int
    ) -> tuple[str, str]:
        """Same as _complete but asks the provider for strict JSON output."""
        from openai import OpenAI

        chain = self._text_providers()
        if not chain:
            raise ValueError("No LLM provider configured. Set GROQ_API_KEY or GEMINI_API_KEY.")
        last_exc: Exception = RuntimeError("No LLM provider produced a response")
        for name, key, base_url, model in chain:
            extra: dict = {"response_format": {"type": "json_object"}}
            if name == "gemini":
                extra["reasoning_effort"] = "none"
            try:
                client = OpenAI(api_key=key, base_url=base_url)
                completion = _create_with_retry(
                    client,
                    model=model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    **extra,
                )
                return (completion.choices[0].message.content or "", name)
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
        raise last_exc

    def build_cover_prompt(
        self,
        *,
        title: str,
        topic: str,
        keywords: list[str] | None = None,
        content: str | None = None,
    ) -> str:
        """Craft a vivid image prompt grounded in the article via the text model.

        Uses the article's own headings/intro (when provided) so the cover reflects
        what the article actually covers. Falls back to a strong topic-based template
        if the model is unavailable or rate-limited, so a cover can always be generated.
        """
        kw = ", ".join(k for k in (keywords or []) if k.strip())
        subject = topic.strip() or title.strip()
        fallback = (
            f"Editorial blog cover illustration about {subject}"
            + (f" ({kw})" if kw else "")
            + ". The main subject is clearly depicted and centered. Modern flat "
            "vector illustration, depth and detail, tasteful vibrant color palette, "
            "soft lighting, no text, no words, no letters, no logos."
        )
        if not self._text_providers():
            return fallback

        digest = _article_digest(content or "")
        system = (
            "You write a single prompt for an AI image generator that creates a blog COVER image. "
            "Using the article's title, topic, and content summary, identify the two or three MOST DISTINCTIVE, "
            "concrete things that make THIS subject specific - its signature products, objects, equipment, people, "
            "or setting - and describe one focused scene built around them.\n"
            "- If the subject is an organization, product, brand, or acronym, depict what it actually makes or does "
            "using its characteristic items, not a vague thematic backdrop.\n"
            "- Be concrete and specific. Avoid generic stock cliches.\n"
            "- Keep one clear focal subject, richly detailed, modern editorial illustration.\n"
            "- If the scene naturally contains text (such as on a banner, sign, book cover, screen, product packaging, "
            "or label), you MUST specify the exact text in double quotes (e.g., a banner reading \"Cockroach Janata Party\" "
            "or a book cover with the title \"AI Revolution\"). The text must be spelled correctly and represent the actual topic.\n"
            "- If the scene does not require text, do not describe elements like blank signs, screens, or placards, "
            "as this causes the generator to output gibberish text. Instead, focus entirely on visual elements.\n"
            "Reply with ONLY the image prompt, one or two sentences, no preamble."
        )
        user = f"Title: {title}\nTopic: {topic}" + (f"\nKeywords: {kw}" if kw else "")
        if digest:
            user += f"\n\nArticle summary:\n{digest}"
        try:
            text, _ = self._complete(
                [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                temperature=0.9,
                max_tokens=1024,
            )
            text = text.strip().strip('"').strip()
            if not text:
                return fallback
            return f"{text} Modern editorial illustration."
        except Exception:  # noqa: BLE001 - any failure falls back to the template
            return fallback

    def generate_cover_image(self, prompt: str) -> tuple[bytes, str]:
        """Generate a cover image. Returns (bytes, mime).

        Provider is chosen by settings.image_provider:
        - "pollinations" (default): free & keyless; sharpened with the built-in prompt
          enhancer. A POLLINATIONS_TOKEN unlocks higher-adherence models like "gptimage".
        - "cloudflare": free FLUX.1-schnell via Cloudflare Workers AI (needs a free
          account id + API token). Best free quality.
        - "gemini": Gemini 2.5 Flash Image ("Nano Banana") - strong adherence, low quota.

        For resilience, if the chosen provider fails, it falls back to Pollinations so a
        cover can still be produced.
        """
        provider = (self.settings.image_provider or "pollinations").lower()
        if provider == "gemini":
            return self._cover_gemini(prompt)
        if provider == "cloudflare":
            if self.settings.cloudflare_account_id and self.settings.cloudflare_api_token:
                try:
                    return self._cover_cloudflare(prompt)
                except Exception:  # noqa: BLE001 - degrade to the free keyless provider
                    return self._cover_pollinations(prompt)
            # Misconfigured -> use the free keyless provider instead of failing.
            return self._cover_pollinations(prompt)
        return self._cover_pollinations(prompt)

    def _cover_pollinations(self, prompt: str) -> tuple[bytes, str]:
        """Cover generation via pollinations.ai.

        Free and keyless with the default `flux` model. `enhance=true` runs Pollinations'
        LLM prompt enhancer for noticeably sharper, more on-topic images at no cost. Set
        POLLINATIONS_TOKEN (free registration at auth.pollinations.ai) to unlock
        higher-adherence models like `gptimage` (GPT-Image-1) and remove the watermark -
        keyless requests ignore the model choice and return a more generic image.
        """
        seed = random.randint(1, 1_000_000)
        model = self.settings.pollinations_model or "flux"
        encoded = urllib.parse.quote(prompt, safe="")
        params = [
            "width=1280",
            "height=720",
            "nologo=true",
            f"model={model}",
            f"seed={seed}",
        ]
        if self.settings.pollinations_enhance:
            params.append("enhance=true")
        url = f"https://image.pollinations.ai/prompt/{encoded}?" + "&".join(params)
        headers = {"User-Agent": "ContentPilot/1.0"}
        if self.settings.pollinations_token:
            headers["Authorization"] = f"Bearer {self.settings.pollinations_token}"
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=120) as resp:
                data = resp.read()
                ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
        except urllib.error.HTTPError as exc:
            err = RuntimeError(f"Image generation failed ({exc.code})")
            err.status_code = exc.code
            raise err from exc

        if not data:
            raise RuntimeError("No image was returned by the image service")
        if not ctype.startswith("image/"):
            if data[:3] == b"\xff\xd8\xff":
                ctype = "image/jpeg"
            elif data[:8] == b"\x89PNG\r\n\x1a\n":
                ctype = "image/png"
            else:
                raise RuntimeError("Image service returned a non-image response")
        return data, ctype

    def _cover_cloudflare(self, prompt: str) -> tuple[bytes, str]:
        """Generate an image via Cloudflare Workers AI (FLUX.1-schnell by default).

        Free tier, high quality. Returns (bytes, mime). FLUX models return JSON with a
        base64-encoded JPEG in `result.image`; other models (e.g. SDXL) may return raw
        image bytes, which are handled too.
        """
        account = self.settings.cloudflare_account_id
        token = self.settings.cloudflare_api_token
        if not account or not token:
            raise ValueError("Cloudflare account id / API token is not set")

        model = self.settings.cloudflare_image_model or "@cf/black-forest-labs/flux-1-schnell"
        url = f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}"
        body = {"prompt": prompt}
        steps = int(self.settings.cloudflare_image_steps or 0)
        if steps > 0:
            # FLUX.1-schnell supports up to 8 diffusion steps; higher = more detail.
            body["steps"] = min(steps, 8)
        payload = json.dumps(body).encode()
        request = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as resp:
                raw = resp.read()
                ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
        except urllib.error.HTTPError as exc:
            err = RuntimeError(f"Image generation failed ({exc.code})")
            err.status_code = exc.code
            raise err from exc

        # Raw image bytes (e.g. SDXL) -> use directly.
        if ctype.startswith("image/"):
            return raw, ctype
        if raw[:3] == b"\xff\xd8\xff":
            return raw, "image/jpeg"
        if raw[:8] == b"\x89PNG\r\n\x1a\n":
            return raw, "image/png"

        # JSON envelope (FLUX): {"result": {"image": "<base64 jpeg>"}, "success": true}
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise RuntimeError("Cloudflare returned an unexpected image response") from exc
        if not parsed.get("success", True):
            errors = parsed.get("errors") or "unknown error"
            raise RuntimeError(f"Cloudflare image error: {errors}")
        b64 = (parsed.get("result") or {}).get("image")
        if not b64:
            raise RuntimeError("No image was returned by Cloudflare")
        return base64.b64decode(b64), "image/jpeg"

    def _cover_gemini(self, prompt: str) -> tuple[bytes, str]:
        """Generate a cover image via the Gemini image model. Returns (bytes, mime)."""
        if not self.settings.gemini_api_key:
            raise ValueError("GEMINI_API_KEY is not set")

        model = self.settings.gemini_image_model
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        payload = json.dumps(
            {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
            }
        ).encode()
        request = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": self.settings.gemini_api_key,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=90) as resp:
                data = json.load(resp)
        except urllib.error.HTTPError as exc:
            err = RuntimeError(f"Image generation failed ({exc.code})")
            err.status_code = exc.code
            raise err from exc

        for candidate in data.get("candidates", []):
            for part in candidate.get("content", {}).get("parts", []):
                inline = part.get("inlineData") or part.get("inline_data")
                if inline and inline.get("data"):
                    mime = inline.get("mimeType") or inline.get("mime_type") or "image/png"
                    return base64.b64decode(inline["data"]), mime
        raise RuntimeError("No image was returned by the model")

    def rewrite_section(self, req: RewriteRequest) -> RewriteResponse:
        content, _ = self._complete(
            [
                {"role": "system", "content": "You are an expert SEO content editor."},
                {"role": "user", "content": _build_rewrite_prompt(req)},
            ],
            temperature=0.8,
            max_tokens=2048,
        )
        text = content.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:markdown)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text)
        return RewriteResponse(markdown=text.strip())
