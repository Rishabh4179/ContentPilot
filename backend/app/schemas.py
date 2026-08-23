"""Pydantic request/response models for the ContentPilot API."""
from typing import Literal

from pydantic import BaseModel, Field

Tone = Literal["professional", "casual", "friendly", "persuasive", "informative", "witty"]
Length = Literal["short", "medium", "long"]


class GenerateRequest(BaseModel):
    topic: str = Field(..., min_length=3, max_length=200, description="The main topic of the article")
    keywords: list[str] = Field(default_factory=list, description="SEO keywords to include")
    tone: Tone = "informative"
    length: Length = "medium"
    audience: str = Field("a general audience", max_length=120)


class GenerateResponse(BaseModel):
    title: str
    meta_description: str
    markdown: str
    word_count: int
    provider: str


class RewriteRequest(BaseModel):
    section: str = Field(..., min_length=1, description="The Markdown section to rewrite")
    topic: str = ""
    tone: str = "informative"
    audience: str = "a general audience"
    instruction: str = ""


class RewriteResponse(BaseModel):
    markdown: str


class OutlineSection(BaseModel):
    heading: str = ""
    points: str = ""


class OutlineResponse(BaseModel):
    sections: list[OutlineSection] = Field(default_factory=list)


class OutlineExpandRequest(GenerateRequest):
    outline: list[OutlineSection] = Field(default_factory=list)


class SuggestRequest(GenerateRequest):
    existing: list[str] = Field(default_factory=list)


class KeywordSuggestRequest(BaseModel):
    topic: str = Field(..., min_length=2, max_length=200)
    audience: str = Field("a general audience", max_length=120)
    existing: list[str] = Field(default_factory=list)


class KeywordSuggestResponse(BaseModel):
    keywords: list[str] = Field(default_factory=list)


class ClarifyRequest(BaseModel):
    topic: str = Field(..., min_length=2, max_length=200)


class TopicOption(BaseModel):
    label: str
    description: str = ""


class ClarifyResponse(BaseModel):
    ambiguous: bool = False
    options: list[TopicOption] = Field(default_factory=list)


class FaqRequest(BaseModel):
    topic: str = ""
    title: str = ""
    meta_description: str = ""
    markdown: str = Field(..., min_length=1)
    count: int = Field(5, ge=3, le=8)


class FaqItem(BaseModel):
    question: str
    answer: str


class FaqResponse(BaseModel):
    items: list[FaqItem] = Field(default_factory=list)
    jsonld: str = ""


class SocialRequest(BaseModel):
    topic: str = ""
    title: str = ""
    markdown: str = Field(..., min_length=1)


class SocialResponse(BaseModel):
    thread: list[str] = Field(default_factory=list)
    linkedin: str = ""
    newsletter: str = ""


class SeoImproveRequest(BaseModel):
    topic: str = ""
    title: str = ""
    meta_description: str = ""
    markdown: str = Field(..., min_length=1)
    keywords: list[str] = Field(default_factory=list)
    tone: str = "informative"
    audience: str = "a general audience"
    issues: list[str] = Field(default_factory=list)


class SeoImproveResponse(BaseModel):
    title: str
    meta_description: str
    markdown: str
    word_count: int
    provider: str


class TranslateRequest(BaseModel):
    title: str = ""
    meta_description: str = ""
    markdown: str = Field(..., min_length=1)
    target_language: str = Field(..., min_length=2, max_length=40)


class TranslateResponse(BaseModel):
    title: str
    meta_description: str
    markdown: str
    target_language: str
    word_count: int
    provider: str


class CompetitorRequest(BaseModel):
    topic: str = Field(..., min_length=3, max_length=200)
    keywords: list[str] = Field(default_factory=list)


class CompetitorPage(BaseModel):
    title: str
    url: str
    summary: str = ""
    angles: list[str] = Field(default_factory=list)


class CompetitorResponse(BaseModel):
    top_pages: list[CompetitorPage] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)
    suggested_sections: list[str] = Field(default_factory=list)
    word_count_target: int = 0
    provider: str = ""


class EditChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class EditChatRequest(BaseModel):
    title: str = ""
    meta_description: str = ""
    markdown: str = Field(..., min_length=1)
    messages: list[EditChatMessage] = Field(default_factory=list, max_length=40)


class EditChatResponse(BaseModel):
    reply: str
    updated: bool = False
    title: str | None = None
    meta_description: str | None = None
    markdown: str | None = None
    word_count: int | None = None
    provider: str = ""


class SectionImagesResponse(BaseModel):
    markdown: str
    word_count: int
    image_urls: list[str] = Field(default_factory=list)


AgentTool = Literal[
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
]


class AgentAction(BaseModel):
    """One tool call the planner wants the frontend to execute."""

    tool: AgentTool
    args: dict = Field(default_factory=dict)


class AgentLibraryItem(BaseModel):
    """Compact summary of one saved article, used to answer meta questions
    ("how many articles do I have?", "what did I write last week?")."""

    id: int
    title: str = ""
    topic: str = ""
    word_count: int = 0
    created_at: str = ""


class AgentPlanRequest(BaseModel):
    """Chat with the agent about the current article. Planner returns a reply
    plus zero or more actions the frontend should run in order."""

    title: str = ""
    meta_description: str = ""
    markdown: str = Field(..., min_length=1)
    topic: str = ""
    keywords: list[str] = Field(default_factory=list)
    tone: str = "informative"
    audience: str = "a general audience"
    messages: list[EditChatMessage] = Field(default_factory=list, max_length=40)
    library_count: int = 0
    library_recent: list[AgentLibraryItem] = Field(default_factory=list, max_length=15)


class AgentPlanResponse(BaseModel):
    reply: str
    actions: list[AgentAction] = Field(default_factory=list)
    clarification: "AgentClarification | None" = None
    provider: str = ""


class AgentClarification(BaseModel):
    """Follow-up question the planner asks when the user's request is ambiguous.

    Rendered in the chat as a bubble with clickable option chips; picking an
    option sends it back as the next user message, re-triggering the planner
    with the ambiguity resolved."""

    question: str
    options: list[str] = Field(default_factory=list, max_length=6)


AgentPlanResponse.model_rebuild()


class StatPoint(BaseModel):
    """One time bucket for the activity chart."""

    label: str  # e.g. "2026-07-06" or "Jul 6"
    count: int = 0
    words: int = 0


class NameCount(BaseModel):
    """Generic name → count pair (providers, tones, lengths, keywords)."""

    name: str
    count: int


class StatsResponse(BaseModel):
    """Aggregated library analytics for the dashboard, scoped to one user."""

    total_articles: int = 0
    total_words: int = 0
    avg_words: int = 0
    longest_words: int = 0
    articles_this_week: int = 0
    words_this_week: int = 0
    articles_prev_week: int = 0
    active_days: int = 0
    over_time: list[StatPoint] = Field(default_factory=list)
    top_keywords: list[NameCount] = Field(default_factory=list)
    audiences: list[NameCount] = Field(default_factory=list)
    tones: list[NameCount] = Field(default_factory=list)
    lengths: list[NameCount] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: str
    provider: str


class LibraryAskRequest(BaseModel):
    """Ask a question answered from the user's saved article library (RAG)."""

    question: str = Field(..., min_length=2, max_length=500)
    top_k: int = Field(4, ge=1, le=8)


class LibrarySource(BaseModel):
    id: int
    title: str = ""
    topic: str = ""
    score: float = 0.0


class LibraryAskResponse(BaseModel):
    answer: str
    sources: list[LibrarySource] = Field(default_factory=list)
    provider: str = ""
    indexed: int = 0


class InternalLinkRequest(BaseModel):
    """Suggest internal links from one article to the user's other articles."""

    article_id: int
    max_suggestions: int = Field(5, ge=1, le=10)


class InternalLinkSuggestion(BaseModel):
    target_id: int
    target_title: str = ""
    target_topic: str = ""
    anchor_text: str = ""
    reason: str = ""
    score: float = 0.0


class InternalLinkResponse(BaseModel):
    suggestions: list[InternalLinkSuggestion] = Field(default_factory=list)
    provider: str = ""
    indexed: int = 0


class ChatSessionMeta(BaseModel):
    """Lightweight session info for the history list (no messages)."""

    id: int
    mode: str = "agent"
    article_id: int = 0
    title: str = "New chat"
    message_count: int = 0
    updated_at: str = ""


class ChatSessionDetail(BaseModel):
    """A full chat session including its messages."""

    id: int
    mode: str = "agent"
    article_id: int = 0
    title: str = "New chat"
    messages: list = Field(default_factory=list)
    updated_at: str = ""


class ChatSessionCreate(BaseModel):
    mode: str = "agent"
    article_id: int = 0
    messages: list = Field(default_factory=list)


class ChatSessionUpdate(BaseModel):
    messages: list = Field(default_factory=list)


class ChatSessionRename(BaseModel):
    title: str = Field(..., min_length=1, max_length=120)


class NotifyStatusResponse(BaseModel):
    """Whether server-side email sending is configured."""

    configured: bool
    from_address: str = ""


class NotifyRequest(BaseModel):
    """Send a notification email to `email`. `preview` renders without sending."""

    email: str = Field(..., min_length=3, max_length=254)
    name: str = ""
    preview: bool = False


class NotifyResult(BaseModel):
    sent: bool = False
    preview: bool = False
    message: str = ""
    subject: str = ""
    html: str = ""


class SubscriptionResponse(BaseModel):
    """Current user's digest-subscription state."""

    enabled: bool = False
    email: str = ""
    frequency: str = "weekly"
    send_day: int = 0
    send_hour: int = 9
    timezone: str = "UTC"
    last_sent_at: str | None = None
    email_configured: bool = False


class SubscriptionRequest(BaseModel):
    """Create/update the current user's subscription."""

    email: str = Field(..., min_length=3, max_length=254)
    name: str = ""
    enabled: bool = True
    frequency: str = "weekly"
    send_day: int = Field(0, ge=0, le=6)
    send_hour: int = Field(9, ge=0, le=23)
    timezone: str = "UTC"
