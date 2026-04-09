"use client"

import { FormEvent, KeyboardEvent, UIEvent, useEffect, useMemo, useRef, useState } from "react"

type ChatRole = "user" | "assistant"

type ChatMessage = {
  id: string
  role: ChatRole
  content: string
  timestamp: string
  ragHits?: number
  score?: number
  confidence?: number
  festivalFit?: number
  audienceFit?: string[]
  improvementActions?: string[]
  model?: string
  ragExamples?: RagExample[]
}

type RagExample = {
  id: string
  score: number
  title: string
  section: string
  kind: string
  format: string
  themes: string[]
  synopsis: string
  relevanceReason: string
}

type StructuredReview = {
  review_summary: string
  festival_fit_score: number
  audience_segment_fit: string[]
  improvement_actions: string[]
  confidence: number
  scoring_sheet: {
    weighted_score_100: number
  }
}

type StreamEvent =
  | {
      type: "start"
      model: string
      ragHits: number
      ragExamples: RagExample[]
    }
  | {
      type: "delta"
      delta: string
    }
  | {
      type: "final"
      assistantMessage: string
      ragHits: number
      model: string
      structuredReview: StructuredReview | null
      ragExamples: RagExample[]
      scoringSheet: {
        weighted_score_100: number
      } | null
    }
  | {
      type: "error"
      error: string
    }

const STARTER_PROMPT = `Film title: Into the Wind
Target audience: 12-16
Synopsis: A shy 13-year-old violinist joins a chaotic street band competition and must lead the final performance after their mentor disappears.`

const QUICK_ACTIONS = [
  "Give an investor-ready verdict with risks, upside, and distribution readiness.",
  "Run structural audit + 6 rewrite moves with expected audience impact.",
  "Score festival fit by audience segment and explain commercial potential.",
]

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [prompt, setPrompt] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [maxHits, setMaxHits] = useState(6)
  const [error, setError] = useState("")
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const shouldAutoScrollRef = useRef(true)

  const stats = useMemo(() => {
    const assistantMessages = messages.filter((message) => message.role === "assistant")
    const scoredMessages = assistantMessages.filter((message) => typeof message.score === "number")
    const hitMessages = assistantMessages.filter((message) => typeof message.ragHits === "number")
    const totalHits = assistantMessages.reduce((acc, message) => acc + (message.ragHits || 0), 0)
    const latestScore =
      assistantMessages.find((message) => typeof message.score === "number")?.score ?? null
    const latestConfidence =
      assistantMessages.find((message) => typeof message.confidence === "number")?.confidence ?? null
    const latestFestival =
      assistantMessages.find((message) => typeof message.festivalFit === "number")?.festivalFit ?? null
    const avgScore =
      scoredMessages.length > 0
        ? scoredMessages.reduce((acc, message) => acc + (message.score || 0), 0) / scoredMessages.length
        : null
    const avgHits =
      hitMessages.length > 0
        ? hitMessages.reduce((acc, message) => acc + (message.ragHits || 0), 0) / hitMessages.length
        : null
    return { totalHits, latestScore, latestConfidence, latestFestival, avgScore, avgHits, reviews: assistantMessages.length }
  }, [messages])
  const latestAssistantMessage = useMemo(
    () => messages.filter((message) => message.role === "assistant").find((message) => message.content.trim().length > 0) || null,
    [messages],
  )

  function updateAssistantMessage(id: string, update: (message: ChatMessage) => ChatMessage): void {
    setMessages((prev) => prev.map((message) => (message.id === id ? update(message) : message)))
  }

  function onChatScroll(event: UIEvent<HTMLDivElement>): void {
    const target = event.currentTarget
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight
    shouldAutoScrollRef.current = distanceFromBottom < 140
  }

  function copyMessage(messageId: string, content: string): void {
    if (!content.trim()) return
    void navigator.clipboard.writeText(content).then(() => {
      setCopiedMessageId(messageId)
      window.setTimeout(() => setCopiedMessageId((prev) => (prev === messageId ? null : prev)), 1200)
    })
  }

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return
    const container = chatScrollRef.current
    if (!container) return
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" })
  }, [messages, isLoading])

  async function submitReview(input: string): Promise<void> {
    const trimmed = input.trim()
    if (!trimmed || isLoading) return

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: trimmed,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    }
    const assistantId = `assistant-${Date.now()}`
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      ragHits: 0,
    }

    setMessages((prev) => [...prev, userMessage, assistantMessage])
    setPrompt("")
    setError("")
    setIsLoading(true)

    try {
      const response = await fetch("/api/giffoni-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: trimmed, maxHits }),
      })
      if (!response.ok) {
        throw new Error("Failed to start streamed review.")
      }
      if (!response.body) {
        throw new Error("Streaming response is unavailable.")
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split("\n\n")
        buffer = chunks.pop() || ""

        for (const chunk of chunks) {
          const data = chunk
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.replace(/^data:\s?/, ""))
            .join("")
            .trim()
          if (!data) continue
          let event: StreamEvent | null = null
          try {
            event = JSON.parse(data) as StreamEvent
          } catch {
            event = null
          }
          if (!event) continue

          if (event.type === "start") {
            updateAssistantMessage(assistantId, (message) => ({
              ...message,
              ragHits: event.ragHits,
              model: event.model,
              ragExamples: event.ragExamples,
            }))
            continue
          }
          if (event.type === "delta") {
            updateAssistantMessage(assistantId, (message) => ({
              ...message,
              content: `${message.content}${event.delta}`,
            }))
            continue
          }
          if (event.type === "final") {
            updateAssistantMessage(assistantId, (message) => ({
              ...message,
              content: event.assistantMessage,
              ragHits: event.ragHits,
              model: event.model,
              score: event.scoringSheet?.weighted_score_100,
              confidence: event.structuredReview?.confidence,
              festivalFit: event.structuredReview?.festival_fit_score,
              audienceFit: event.structuredReview?.audience_segment_fit || [],
              improvementActions: event.structuredReview?.improvement_actions || [],
              ragExamples: event.ragExamples,
            }))
            continue
          }
          if (event.type === "error") {
            throw new Error(event.error || "Streaming failed.")
          }
        }
      }

    } catch (caughtError) {
      const fallback = caughtError instanceof Error ? caughtError.message : "Unexpected error"
      setError(fallback)
      setMessages((prev) =>
        prev.filter((message) => !(message.id === assistantId && message.role === "assistant" && !message.content.trim())),
      )
    } finally {
      setIsLoading(false)
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void submitReview(prompt)
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault()
      void submitReview(prompt)
    }
  }

  return (
    <div className="h-screen overflow-hidden bg-zinc-100 text-zinc-900">
      <main className="mx-auto grid h-full w-full max-w-[1680px] gap-6 px-4 py-6 lg:grid-cols-[360px_minmax(0,1fr)_420px] md:px-6">
        <section className="hidden h-[calc(100vh-3rem)] shrink-0 overflow-hidden rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm lg:block">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Giffoni RAG</p>
            <h1 className="text-2xl font-semibold tracking-tight">Reviewer Console</h1>
            <p className="text-sm text-zinc-600">Clean decision signals powered by retrieval-grounded criticism.</p>
          </div>
          <div className="mt-6 space-y-3">
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
              <p className="text-xs text-zinc-500">Reviews</p>
              <p className="text-xl font-semibold">{stats.reviews}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
              <p className="text-xs text-zinc-500">Avg Quality Score</p>
              <p className="text-xl font-semibold">
                {typeof stats.avgScore === "number" ? `${Math.round(stats.avgScore)}/100` : "—"}
              </p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
              <p className="text-xs text-zinc-500">Avg Retrieval Depth</p>
              <p className="text-xl font-semibold">
                {typeof stats.avgHits === "number" ? Math.round(stats.avgHits) : "—"}
              </p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
              <p className="text-xs text-zinc-500">Latest Score</p>
              <p className="text-xl font-semibold">
                {typeof stats.latestScore === "number" ? `${Math.round(stats.latestScore)}/100` : "—"}
              </p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
              <p className="text-xs text-zinc-500">Total RAG Hits</p>
              <p className="text-xl font-semibold">
                {stats.totalHits}
              </p>
            </div>
          </div>
        </section>

        <section className="flex h-[calc(100vh-3rem)] min-h-0 min-w-0 flex-1 flex-col rounded-2xl border border-zinc-200 bg-white shadow-sm">
          <header className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-200 bg-white/95 px-5 py-4 backdrop-blur">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Film Review Chat</h2>
              <p className="text-sm text-zinc-500">Grounded responses from your existing Giffoni dataset logic.</p>
            </div>
            <div className="flex items-center gap-3">
              <span className={`rounded-md border px-2 py-1 text-xs ${isLoading ? "border-zinc-400 bg-zinc-100 text-zinc-700" : "border-zinc-200 bg-white text-zinc-500"}`}>
                {isLoading ? "Streaming" : "Idle"}
              </span>
              <label className="flex items-center gap-2 text-sm text-zinc-600">
                Max hits
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={maxHits}
                  onChange={(event) => setMaxHits(Math.max(1, Math.min(12, Number(event.target.value) || 1)))}
                  className="w-16 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-right text-sm outline-none ring-0 focus:border-zinc-500"
                />
              </label>
            </div>
          </header>

          <div ref={chatScrollRef} onScroll={onChatScroll} className="clean-scroll flex-1 space-y-4 overflow-y-auto px-5 py-4 scroll-smooth">
            {messages.length === 0 && (
              <div className="space-y-3 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-5">
                <p className="text-sm text-zinc-700">Paste film context and choose an objective-focused ask.</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setPrompt(STARTER_PROMPT)}
                    className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 transition hover:bg-zinc-100"
                  >
                    Use starter prompt
                  </button>
                  {QUICK_ACTIONS.map((action) => (
                    <button
                      key={action}
                      type="button"
                      onClick={() => setPrompt((prev) => `${prev.trim()}\n\nRequest: ${action}`.trim())}
                      className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100"
                    >
                      {action}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => (
              <article
                key={message.id}
                className={`rounded-xl border p-4 ${
                  message.role === "user" ? "ml-auto max-w-3xl border-zinc-300 bg-zinc-900 text-zinc-100" : "mr-auto max-w-4xl border-zinc-200 bg-zinc-50 text-zinc-900"
                }`}
              >
                <div className="mb-2 flex items-center justify-between gap-4 text-xs uppercase tracking-wider opacity-70">
                  <span>{message.role === "user" ? "You" : "Giffoni Agent"}</span>
                  <span>{message.timestamp}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>
                {message.role === "assistant" && (
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    <span className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-zinc-700">
                      Hits: {message.ragHits || 0}
                    </span>
                    <span className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-zinc-700">
                      Score: {typeof message.score === "number" ? `${message.score}/100` : "N/A"}
                    </span>
                    <span className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-zinc-700">
                      Confidence: {typeof message.confidence === "number" ? `${Math.round(message.confidence * 100)}%` : "N/A"}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyMessage(message.id, message.content)}
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-zinc-700 transition hover:bg-zinc-100"
                    >
                      {copiedMessageId === message.id ? "Copied" : "Copy"}
                    </button>
                  </div>
                )}
                {message.role === "assistant" && message.ragExamples && message.ragExamples.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">Retrieved examples</p>
                    <div className="clean-scroll flex snap-x gap-2 overflow-x-auto pb-1">
                      {message.ragExamples.map((example) => (
                        <div key={example.id} className="w-64 shrink-0 snap-start rounded-lg border border-zinc-200 bg-white p-3">
                          <p className="line-clamp-1 text-sm font-semibold text-zinc-900">{example.title || "Untitled reference"}</p>
                          <p className="mt-1 text-xs text-zinc-500">
                            Match {Math.round(example.score * 100)} · {example.section || "General"}
                          </p>
                          <p className="mt-1 line-clamp-2 text-xs text-zinc-600">{example.relevanceReason}</p>
                          <p className="mt-1 line-clamp-3 text-xs leading-5 text-zinc-700">{example.synopsis || "No synopsis available."}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </article>
            ))}

            {isLoading && (
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600">
                Streaming retrieval-grounded review…
              </div>
            )}
          </div>

          <form onSubmit={onSubmit} className="sticky bottom-0 border-t border-zinc-200 bg-white/95 p-4 backdrop-blur">
            <label htmlFor="prompt" className="mb-2 block text-sm font-medium text-zinc-700">
              Film context + request
            </label>
            <textarea
              id="prompt"
              rows={6}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder="Add title, audience, synopsis, and what kind of review you need..."
              className="w-full resize-none rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm leading-6 text-zinc-900 outline-none focus:border-zinc-500"
            />
            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            <div className="mt-3 flex items-center justify-between">
              <p className="text-xs text-zinc-500">Submit with Cmd/Ctrl + Enter</p>
              <button
                type="submit"
                disabled={isLoading || !prompt.trim()}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-400"
              >
                {isLoading ? "Reviewing..." : "Run Giffoni Review"}
              </button>
            </div>
          </form>
        </section>

        <section className="clean-scroll hidden h-[calc(100vh-3rem)] overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm lg:block">
          <h3 className="text-sm font-semibold uppercase tracking-[0.15em] text-zinc-500">Outcome Intelligence</h3>
          <div className="mt-4 space-y-3">
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
              <p className="text-xs text-zinc-500">Investment Signal</p>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-zinc-500">Festival Fit</p>
                  <p className="text-2xl font-semibold text-zinc-900">
                    {typeof latestAssistantMessage?.festivalFit === "number" ? Math.round(latestAssistantMessage.festivalFit) : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500">Confidence</p>
                  <p className="text-2xl font-semibold text-zinc-900">
                    {typeof latestAssistantMessage?.confidence === "number" ? `${Math.round(latestAssistantMessage.confidence * 100)}%` : "—"}
                  </p>
                </div>
              </div>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
              <p className="text-xs text-zinc-500">Primary Audience</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {(latestAssistantMessage?.audienceFit || []).slice(0, 3).map((segment) => (
                  <span key={segment} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700">
                    {segment}
                  </span>
                ))}
                {(!latestAssistantMessage?.audienceFit || latestAssistantMessage.audienceFit.length === 0) && (
                  <span className="text-sm text-zinc-500">No audience segmentation yet.</span>
                )}
              </div>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
              <p className="text-xs text-zinc-500">Next 3 Actions</p>
              <ul className="mt-2 space-y-2 text-sm text-zinc-800">
                {(latestAssistantMessage?.improvementActions || []).slice(0, 3).map((action) => (
                  <li key={action} className="rounded-md bg-white px-2 py-1">{action}</li>
                ))}
                {(!latestAssistantMessage?.improvementActions || latestAssistantMessage.improvementActions.length === 0) && (
                  <li className="text-zinc-500">Run a review to see action plan.</li>
                )}
              </ul>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
