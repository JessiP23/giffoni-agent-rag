import { runGiffoniAgentStream } from "@/giffoni/lib/giffoni-agent"
import { NextResponse } from "next/server"

export const runtime = "nodejs"

type ReviewRequest = {
  prompt?: string
  maxHits?: number
  model?: string
  dryRun?: boolean
}

function normalizePrompt(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeMaxHits(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) return 6
  return Math.max(1, Math.min(12, Math.floor(parsed)))
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ReviewRequest
    const prompt = normalizePrompt(body.prompt)
    if (!prompt) {
      return NextResponse.json({ error: "Prompt is required." }, { status: 400 })
    }

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const eventStream = runGiffoniAgentStream({
            prompt,
            maxHits: normalizeMaxHits(body.maxHits),
            model: typeof body.model === "string" ? body.model : undefined,
            dryRun: Boolean(body.dryRun),
          })
          for await (const event of eventStream) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error"
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "error",
                error: message,
              })}\n\n`,
            ),
          )
        } finally {
          controller.close()
        }
      },
    })
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
