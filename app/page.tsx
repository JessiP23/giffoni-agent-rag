"use client"

import { FormEvent, KeyboardEvent, useMemo, useState } from "react"

type ChatRole = "user" | "assistant"

type ChatMessage = {
  id: string
  role: ChatRole
  content: string
  timestamp: string
  ragHits?: number
  score?: number
}

type StreamEvent =
  | {
      type: "start"
      ragHits: number
    }
  | {
      type: "delta"
      delta: string
    }
  | {
      type: "final"
      assistantMessage: string
      ragHits: number
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

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [prompt, setPrompt] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [maxHits, setMaxHits] = useState(6)
  const [error, setError] = useState("")

  const stats = useMemo(() => {
    const assistantMessages = messages.filter((message) => message.role === "assistant")
    const totalHits = assistantMessages.reduce((acc, message) => acc + (message.ragHits || 0), 0)
    const latestScore =
      assistantMessages.find((message) => typeof message.score === "number")?.score ?? null
    return { totalHits, latestScore, reviews: assistantMessages.length }
  }, [messages])

  function updateAssistantMessage(id: string, update: (message: ChatMessage) => ChatMessage): void {
    setMessages((prev) => prev.map((message) => (message.id === id ? update(message) : message)))
  }

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
              score: event.scoringSheet?.weighted_score_100,
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
    <div className="min-h-screen bg-zinc-100 text-zinc-900">
      <main className="mx-auto flex w-full max-w-7xl gap-6 px-4 py-6 md:px-6">
        <section className="hidden w-80 shrink-0 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm lg:block">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Giffoni RAG</p>
            <h1 className="text-2xl font-semibold tracking-tight">Reviewer Console</h1>
            <p className="text-sm text-zinc-600">Structured film critique with retrieval-grounded scoring.</p>
          </div>
          <div className="mt-6 space-y-3">
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
              <p className="text-xs text-zinc-500">Reviews</p>
              <p className="text-xl font-semibold">{stats.reviews}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
              <p className="text-xs text-zinc-500">Total RAG Hits</p>
              <p className="text-xl font-semibold">{stats.totalHits}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
              <p className="text-xs text-zinc-500">Latest Weighted Score</p>
              <p className="text-xl font-semibold">
                {typeof stats.latestScore === "number" ? `${stats.latestScore}/100` : "—"}
              </p>
            </div>
          </div>
        </section>

        <section className="flex min-h-[calc(100vh-3rem)] flex-1 flex-col rounded-2xl border border-zinc-200 bg-white shadow-sm">
          <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Film Review Chat</h2>
              <p className="text-sm text-zinc-500">Grounded responses from your existing Giffoni dataset logic.</p>
            </div>
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
          </header>

          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {messages.length === 0 && (
              <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-5">
                <p className="text-sm text-zinc-700">Paste film context and request your review.</p>
                <button
                  type="button"
                  onClick={() => setPrompt(STARTER_PROMPT)}
                  className="mt-3 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 transition hover:bg-zinc-100"
                >
                  Use starter prompt
                </button>
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
                  <div className="mt-3 flex gap-2 text-xs">
                    <span className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-zinc-700">
                      Hits: {message.ragHits || 0}
                    </span>
                    <span className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-zinc-700">
                      Score: {typeof message.score === "number" ? `${message.score}/100` : "N/A"}
                    </span>
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

          <form onSubmit={onSubmit} className="border-t border-zinc-200 p-4">
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
      </main>
    </div>
  )
}
