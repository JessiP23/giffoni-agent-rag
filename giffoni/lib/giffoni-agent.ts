import {
  formatGiffoniStructuredReview,
  type GiffoniScoringSheet,
  type GiffoniStructuredReview,
  GIFFONI_REVIEWER_SYSTEM_PROMPT,
  normalizeGiffoniStructuredReview,
} from "./giffoni-reviewer"
import { buildAgentToolRagContext, formatDatasetRagContextForPrompt } from "./giffoni-rag-standalone"

export type RunGiffoniAgentInput = {
  prompt: string
  model?: string
  maxHits?: number
  dryRun?: boolean
}

export type RunGiffoniAgentOutput = {
  assistantMessage: string
  rawResponse: string
  model: string
  ragHits: number
  ragContextPreview: string
  structuredReview: GiffoniStructuredReview | null
  scoringSheet: GiffoniScoringSheet | null
}

export type GiffoniStreamEvent =
  | {
      type: "start"
      model: string
      ragHits: number
      ragContextPreview: string
    }
  | {
      type: "delta"
      delta: string
    }
  | {
      type: "final"
      assistantMessage: string
      rawResponse: string
      model: string
      ragHits: number
      ragContextPreview: string
      structuredReview: GiffoniStructuredReview | null
      scoringSheet: GiffoniScoringSheet | null
    }

function parseJsonFromText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
  }
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>
    } catch {
    }
  }
  return null
}

function normalizeAssistantMessage(parsed: Record<string, unknown> | null, fallback: string): string {
  if (!parsed) return fallback
  const content = typeof parsed.assistantMessage === "string" ? parsed.assistantMessage.trim() : ""
  return content || fallback
}

function resolveModel(input: RunGiffoniAgentInput): string {
  return input.model || process.env.CREATIVE_IMAGE_AGENT_MODEL || "google/gemini-3.1-flash-lite-preview"
}

function buildRequestMessages(prompt: string, ragText: string): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: GIFFONI_REVIEWER_SYSTEM_PROMPT },
    { role: "system", content: ragText },
    { role: "user", content: prompt },
    { role: "user", content: "Return ONLY JSON." },
  ]
}

function getApiKey(): string {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey || apiKey === "sk-or-placeholder-build-key") {
    throw new Error("OPENROUTER_API_KEY is required to run non-dry Giffoni agent")
  }
  return apiKey
}

async function buildRagMetadata(input: RunGiffoniAgentInput): Promise<{
  model: string
  ragText: string
  ragHits: number
  ragContextPreview: string
}> {
  const model = resolveModel(input)
  const maxHits = Math.max(1, Math.min(12, input.maxHits ?? 6))
  const ragContext = await buildAgentToolRagContext({
    toolId: "giffoni_reviewer",
    query: input.prompt,
    k: maxHits,
  })
  const ragText = ragContext ? formatDatasetRagContextForPrompt(ragContext) : "Dataset retrieval unavailable."
  return {
    model,
    ragText,
    ragHits: ragContext?.hits.length || 0,
    ragContextPreview: ragText.slice(0, 2000),
  }
}

function finalizeOutput(params: {
  raw: string
  model: string
  ragHits: number
  ragContextPreview: string
}): RunGiffoniAgentOutput {
  const parsed = parseJsonFromText(params.raw)
  const structured = normalizeGiffoniStructuredReview(parsed)
  const assistantMessage = normalizeAssistantMessage(
    parsed,
    structured ? formatGiffoniStructuredReview(structured) : params.raw.trim() || "No response generated",
  )
  return {
    assistantMessage,
    rawResponse: params.raw,
    model: params.model,
    ragHits: params.ragHits,
    ragContextPreview: params.ragContextPreview,
    structuredReview: structured,
    scoringSheet: structured?.scoring_sheet || null,
  }
}

export async function runGiffoniAgent(input: RunGiffoniAgentInput): Promise<RunGiffoniAgentOutput> {
  const metadata = await buildRagMetadata(input)
  if (input.dryRun) {
    return {
      assistantMessage: "Dry-run completed",
      rawResponse: "",
      model: metadata.model,
      ragHits: metadata.ragHits,
      ragContextPreview: metadata.ragContextPreview,
      structuredReview: null,
      scoringSheet: null,
    }
  }

  const apiKey = getApiKey()

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: metadata.model,
      temperature: 0.15,
      max_tokens: 1800,
      messages: buildRequestMessages(input.prompt, metadata.ragText),
    }),
  })
  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`OpenRouter error ${response.status}: ${errText}`)
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const raw = payload.choices?.[0]?.message?.content || ""
  return finalizeOutput({
    raw,
    model: metadata.model,
    ragHits: metadata.ragHits,
    ragContextPreview: metadata.ragContextPreview,
  })
}

export async function* runGiffoniAgentStream(input: RunGiffoniAgentInput): AsyncGenerator<GiffoniStreamEvent> {
  const metadata = await buildRagMetadata(input)
  yield {
    type: "start",
    model: metadata.model,
    ragHits: metadata.ragHits,
    ragContextPreview: metadata.ragContextPreview,
  }

  if (input.dryRun) {
    yield {
      type: "final",
      assistantMessage: "Dry-run completed",
      rawResponse: "",
      model: metadata.model,
      ragHits: metadata.ragHits,
      ragContextPreview: metadata.ragContextPreview,
      structuredReview: null,
      scoringSheet: null,
    }
    return
  }

  const apiKey = getApiKey()
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: metadata.model,
      temperature: 0.15,
      max_tokens: 1800,
      stream: true,
      messages: buildRequestMessages(input.prompt, metadata.ragText),
    }),
  })
  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`OpenRouter error ${response.status}: ${errText}`)
  }
  if (!response.body) {
    throw new Error("OpenRouter stream body is unavailable")
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let raw = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split("\n\n")
    buffer = blocks.pop() || ""
    for (const block of blocks) {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.replace(/^data:\s?/, ""))
        .join("")
        .trim()
      if (!data || data === "[DONE]") continue
      let payload: { choices?: Array<{ delta?: { content?: string } }> } | null = null
      try {
        payload = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
      } catch {
        payload = null
      }
      if (!payload) continue
      const delta = payload.choices?.[0]?.delta?.content || ""
      if (!delta) continue
      raw += delta
      yield {
        type: "delta",
        delta,
      }
    }
  }

  const output = finalizeOutput({
    raw,
    model: metadata.model,
    ragHits: metadata.ragHits,
    ragContextPreview: metadata.ragContextPreview,
  })
  yield {
    type: "final",
    assistantMessage: output.assistantMessage,
    rawResponse: output.rawResponse,
    model: output.model,
    ragHits: output.ragHits,
    ragContextPreview: output.ragContextPreview,
    structuredReview: output.structuredReview,
    scoringSheet: output.scoringSheet,
  }
}
