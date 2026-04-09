import { runGiffoniAgent } from "./lib/giffoni-agent"

type CliArgs = {
  prompt: string
  dryRun: boolean
  maxHits?: number
  model?: string
}

function parseArgs(argv: string[]): CliArgs {
  let prompt = ""
  let dryRun = false
  let maxHits: number | undefined
  let model: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--dry-run") {
      dryRun = true
      continue
    }
    if (arg === "--max-hits") {
      const raw = argv[i + 1]
      const value = Number(raw)
      if (Number.isFinite(value) && value > 0) {
        maxHits = Math.floor(value)
        i += 1
      }
      continue
    }
    if (arg === "--model") {
      const value = argv[i + 1]
      if (value) {
        model = value
        i += 1
      }
      continue
    }
    if (arg.startsWith("--")) continue
    prompt = prompt ? `${prompt} ${arg}` : arg
  }
  if (!prompt) {
    throw new Error("Prompt is required. Example: tsx agent/giffoni/run-giffoni.ts \"Film title: ...\"")
  }
  return { prompt, dryRun, maxHits, model }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const output = await runGiffoniAgent({
    prompt: args.prompt,
    dryRun: args.dryRun,
    maxHits: args.maxHits,
    model: args.model,
  })
  process.stdout.write(
    JSON.stringify(
      {
        model: output.model,
        ragHits: output.ragHits,
        assistantMessage: output.assistantMessage,
        ragContextPreview: output.ragContextPreview,
        scoringSheet: output.scoringSheet,
      },
      null,
      2,
    ) + "\n",
  )
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
