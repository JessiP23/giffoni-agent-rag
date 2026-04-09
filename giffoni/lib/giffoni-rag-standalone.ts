import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import JSZip from "jszip"

type DatasetRowRecord = {
  id: string
  title: string
  synopsis: string
  judgment: string
  section: string
  kind: string
  format: string
  themes: string[]
  values: Record<string, string>
  searchText: string
  titleTokens: Set<string>
  synopsisTokens: Set<string>
  judgmentTokens: Set<string>
  themeTokens: Set<string>
  metaTokens: Set<string>
}

export type DatasetRagHit = {
  id: string
  score: number
  title: string
  section: string
  kind: string
  format: string
  judgment: string
  synopsis: string
  themes: string[]
}

export type DatasetRagContext = {
  rubric: string
  hits: DatasetRagHit[]
}

export type AgentToolRagConfig = {
  datasetPath?: string
  hfDatasetRepo?: string
  hfDatasetConfig?: string
  hfDatasetSplit?: string
  hfMaxRows?: number
  vectorStoreName: string
  vectorStoreDescription: string
  datasetFileName: string
  sourceType: string
  embeddingModel: string
  rubric: string
}

const DEFAULT_EMBEDDING_MODEL = process.env.RAG_EMBEDDING_MODEL || "qwen/qwen3-embedding-8b"
const DEFAULT_GIFFONI_HF_REPO = "JessiP23/giffoni-reviewer-dataset"
const DEFAULT_RUBRIC = [
  "narrative_clarity: structure, causality, pacing, coherence",
  "character_arc: transformation, motivations, emotional credibility",
  "emotional_impact: intensity, resonance, memorability",
  "visual_language: composition, cinematography, visual consistency",
  "sound_design_music: sonic storytelling, score utility, mix quality",
  "audience_fit: age-range suitability, accessibility, educational sensitivity",
  "festival_suitability: originality, cultural relevance, selection potential",
  "actionability: concrete editorial improvements and production next steps",
].join("\n")

const recordsCache = new Map<string, { versionToken: string; records: DatasetRowRecord[] }>()

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "how",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "them",
  "then",
  "this",
  "to",
  "was",
  "were",
  "with",
  "film",
  "title",
  "synopsis",
  "review",
  "task",
  "focus",
  "audit",
  "structure",
  "act",
  "breaks",
  "midpoint",
  "climax",
  "pacing",
  "rhythm",
  "narrative",
  "causality",
  "flag",
  "dead",
  "zones",
  "propose",
  "editorial",
  "tightening",
  "il",
  "la",
  "le",
  "gli",
  "dei",
  "delle",
  "del",
  "della",
  "con",
  "per",
  "una",
  "uno",
  "un",
  "che",
  "non",
  "piu",
  "più",
  "anche",
  "come",
  "nel",
  "nella",
  "nelle",
  "nello",
  "all",
  "alla",
  "alle",
  "agli",
  "sul",
  "sulla",
  "sulle",
  "sullo",
])

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function normalizeHeader(value: string): string {
  return normalizeSpaces(value).toLowerCase().replace(/[^a-z0-9à-ÿ]+/gi, "_")
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9à-ÿ]+/gi, " ")
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.length > 2 && !STOPWORDS.has(part))
}

function xmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&#13;/g, "\r")
}

function stripXmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, "")
}

function colIndexFromRef(cellRef: string): number {
  const letters = (cellRef.match(/[A-Z]+/i)?.[0] || "A").toUpperCase()
  let total = 0
  for (let i = 0; i < letters.length; i += 1) {
    total = total * 26 + (letters.charCodeAt(i) - 64)
  }
  return Math.max(0, total - 1)
}

function parseXmlCells(rowXml: string): Array<{ index: number; raw: string; cellType: string | null }> {
  const cells: Array<{ index: number; raw: string; cellType: string | null }> = []
  const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g
  let match: RegExpExecArray | null = cellRegex.exec(rowXml)
  while (match) {
    const attrs = match[1] || match[3] || ""
    const body = match[2] || ""
    const ref = attrs.match(/\br="([^"]+)"/)?.[1] || "A1"
    const type = attrs.match(/\bt="([^"]+)"/)?.[1] || null
    cells.push({ index: colIndexFromRef(ref), raw: body, cellType: type })
    match = cellRegex.exec(rowXml)
  }
  return cells
}

function parseSharedStrings(xml: string): string[] {
  const entries: string[] = []
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let match: RegExpExecArray | null = siRegex.exec(xml)
  while (match) {
    const block = match[1] || ""
    const textNodes = block.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []
    const value = normalizeSpaces(xmlDecode(textNodes.map((node) => stripXmlTags(node)).join("")))
    entries.push(value)
    match = siRegex.exec(xml)
  }
  return entries
}

function parseSheetRows(sheetXml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = []
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let rowMatch: RegExpExecArray | null = rowRegex.exec(sheetXml)
  while (rowMatch) {
    const rowContent = rowMatch[1] || ""
    const cells = parseXmlCells(rowContent)
    const maxIndex = cells.reduce((max, cell) => Math.max(max, cell.index), 0)
    const row = new Array(maxIndex + 1).fill("")
    for (const cell of cells) {
      const vText = cell.raw.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1]
      const inlineText = cell.raw.match(/<is\b[^>]*>[\s\S]*?<\/is>/)?.[0]
      let value = ""
      if (cell.cellType === "s") {
        const idx = Number(vText || "")
        value = Number.isFinite(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : ""
      } else if (inlineText) {
        const tNodes = inlineText.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []
        value = tNodes.map((node) => stripXmlTags(node)).join("")
      } else if (typeof vText === "string") {
        value = vText
      }
      row[cell.index] = normalizeSpaces(xmlDecode(value))
    }
    rows.push(row)
    rowMatch = rowRegex.exec(sheetXml)
  }
  return rows
}

function buildWorkbookRows(rows: string[][]): Array<Record<string, string>> {
  if (rows.length === 0) return []
  const headers = (rows[0] || []).map((header, index) => normalizeHeader(header) || `column_${index + 1}`)
  const out: Array<Record<string, string>> = []
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i] || []
    const record: Record<string, string> = {}
    for (let j = 0; j < headers.length; j += 1) {
      const key = headers[j]
      const value = normalizeSpaces(row[j] || "")
      if (value) record[key] = value
    }
    if (Object.keys(record).length > 0) out.push(record)
  }
  return out
}

function matchKeywordInKey(key: string, keywords: string[]): boolean {
  const normalizedKey = normalizeHeader(key)
  return keywords.some((keyword) => normalizedKey.includes(keyword))
}

function pickByKeywords(values: Record<string, string>, keywords: string[]): string {
  const key = Object.keys(values).find((candidate) => matchKeywordInKey(candidate, keywords))
  return key ? normalizeString(values[key]) : ""
}

function parseThemes(values: Record<string, string>): string[] {
  const themeValues = Object.entries(values)
    .filter(([key]) => matchKeywordInKey(key, ["theme", "tema", "tag", "genre"]))
    .map(([, value]) => normalizeString(value))
    .filter(Boolean)
  const exploded = themeValues
    .flatMap((value) => value.split(/[,;|]/g))
    .map((value) => normalizeSpaces(value))
    .filter(Boolean)
  return Array.from(new Set(exploded))
}

function buildDatasetRowRecords(workbookRows: Array<Record<string, string>>, sourceType: string): DatasetRowRecord[] {
  return workbookRows
    .map((values, index) => {
      const title =
        pickByKeywords(values, ["title_english", "titolo_inglese"]) ||
        pickByKeywords(values, ["title", "titolo", "film"]) ||
        ""
      const synopsis = pickByKeywords(values, ["synopsis", "trama", "plot", "description"])
      const judgment = pickByKeywords(values, ["judgment", "giudizio", "review", "critique"])
      const section = pickByKeywords(values, ["section", "sezione"])
      const kind = pickByKeywords(values, ["kind", "type", "animation", "anim"])
      const format = pickByKeywords(values, ["format", "formato"])
      const themes = parseThemes(values)
      const searchableBody = Object.entries(values)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n")
      const effectiveTitle = title || `row_${index + 1}`
      const titleTokens = new Set(tokenize(title))
      const synopsisTokens = new Set(tokenize(synopsis))
      const judgmentTokens = new Set(tokenize(judgment))
      const themeTokens = new Set(tokenize(themes.join(" ")))
      const metaTokens = new Set(tokenize(`${section} ${kind} ${format}`))
      return {
        id: `${sourceType}_${index + 1}`,
        title: effectiveTitle,
        synopsis,
        judgment,
        section,
        kind,
        format,
        themes,
        values,
        searchText: searchableBody.toLowerCase(),
        titleTokens,
        synopsisTokens,
        judgmentTokens,
        themeTokens,
        metaTokens,
      }
    })
    .filter((record) => record.searchText.trim().length > 0)
}

async function resolveDatasetPath(inputPath?: string): Promise<string | null> {
  const candidate = normalizeString(inputPath)
  if (candidate) return candidate
  const envPath = normalizeString(process.env.RAG_DATASET_XLSX_PATH)
  if (envPath) return envPath
  const datasetDirectory = path.join(process.cwd(), "dataset")
  try {
    const entries = await readdir(datasetDirectory, { withFileTypes: true })
    const xlsx = entries
      .filter((entry) => entry.isFile() && /\.xlsx$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
    if (xlsx.length === 0) return null
    return path.join(datasetDirectory, xlsx[0])
  } catch {
    return null
  }
}

function buildDefaultSourceType(toolId: string, vectorStoreName: string): string {
  const seed = normalizeHeader(toolId || vectorStoreName || "dataset")
  return seed.length > 0 ? seed : "dataset"
}

function parseToolRagConfig(toolId: string): Partial<AgentToolRagConfig> {
  const raw = normalizeString(process.env.AGENT_TOOL_RAG_CONFIG_JSON)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const rawConfig = parsed?.[toolId]
    if (!rawConfig || typeof rawConfig !== "object") return {}
    const config = rawConfig as Record<string, unknown>
    const maxRowsRaw = Number(config.hfMaxRows)
    return {
      datasetPath: normalizeString(config.datasetPath),
      hfDatasetRepo: normalizeString(config.hfDatasetRepo),
      hfDatasetConfig: normalizeString(config.hfDatasetConfig),
      hfDatasetSplit: normalizeString(config.hfDatasetSplit),
      hfMaxRows: Number.isFinite(maxRowsRaw) && maxRowsRaw > 0 ? Math.floor(maxRowsRaw) : undefined,
      vectorStoreName: normalizeString(config.vectorStoreName),
      vectorStoreDescription: normalizeString(config.vectorStoreDescription),
      datasetFileName: normalizeString(config.datasetFileName),
      sourceType: normalizeString(config.sourceType),
      embeddingModel: normalizeString(config.embeddingModel),
      rubric: normalizeString(config.rubric),
    }
  } catch {
    return {}
  }
}

export async function resolveAgentToolRagConfig(toolId: string): Promise<AgentToolRagConfig | null> {
  const envConfig = parseToolRagConfig(toolId)
  const datasetPath = await resolveDatasetPath(envConfig.datasetPath)
  const hfDatasetRepo =
    envConfig.hfDatasetRepo ||
    normalizeString(process.env.RAG_HF_DATASET_REPO) ||
    (toolId === "giffoni_reviewer" ? DEFAULT_GIFFONI_HF_REPO : "")
  const hfDatasetConfig = envConfig.hfDatasetConfig || normalizeString(process.env.RAG_HF_DATASET_CONFIG) || "default"
  const hfDatasetSplit = envConfig.hfDatasetSplit || normalizeString(process.env.RAG_HF_DATASET_SPLIT) || "train"
  const envHfMaxRowsRaw = Number(process.env.RAG_HF_MAX_ROWS)
  const hfMaxRows =
    envConfig.hfMaxRows ||
    (Number.isFinite(envHfMaxRowsRaw) && envHfMaxRowsRaw > 0 ? Math.floor(envHfMaxRowsRaw) : 3000)
  if (!hfDatasetRepo && !datasetPath) return null
  const vectorStoreName = envConfig.vectorStoreName || normalizeString(process.env.RAG_VECTOR_STORE_NAME) || `${toolId} Dataset`
  const sourceType = envConfig.sourceType || buildDefaultSourceType(toolId, vectorStoreName)
  const datasetFileName =
    envConfig.datasetFileName ||
    (hfDatasetRepo ? `${hfDatasetRepo}:${hfDatasetSplit}` : datasetPath || `${toolId}:dataset`)
  return {
    datasetPath: datasetPath || undefined,
    hfDatasetRepo: hfDatasetRepo || undefined,
    hfDatasetConfig,
    hfDatasetSplit,
    hfMaxRows,
    vectorStoreName,
    vectorStoreDescription: envConfig.vectorStoreDescription || `${toolId} dataset grounding`,
    datasetFileName,
    sourceType,
    embeddingModel: envConfig.embeddingModel || DEFAULT_EMBEDDING_MODEL,
    rubric: envConfig.rubric || DEFAULT_RUBRIC,
  }
}

function buildHfHeaders(): HeadersInit {
  const token = normalizeString(process.env.HF_TOKEN) || normalizeString(process.env.HUGGINGFACE_TOKEN)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function fetchJson<T>(url: string, headers?: HeadersInit): Promise<T | null> {
  const response = await fetch(url, { headers, cache: "no-store" })
  if (!response.ok) return null
  try {
    return (await response.json()) as T
  } catch {
    return null
  }
}

type HfInfoResponse = {
  sha?: string
  lastModified?: string
}

type HfRowsResponse = {
  rows?: Array<{ row?: Record<string, unknown> }>
}

function normalizeHfRecord(values: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue
    if (typeof value === "string") {
      const normalized = normalizeSpaces(value)
      if (normalized) out[key] = normalized
      continue
    }
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value)
      continue
    }
    if (Array.isArray(value)) {
      const joined = value
        .map((entry) => (typeof entry === "string" ? normalizeSpaces(entry) : ""))
        .filter(Boolean)
        .join(", ")
      if (joined) out[key] = joined
      continue
    }
    if (typeof value === "object") {
      const serialized = JSON.stringify(value)
      if (serialized) out[key] = serialized
    }
  }
  return out
}

async function loadHfDatasetRecords(config: AgentToolRagConfig): Promise<{ records: DatasetRowRecord[]; versionToken: string }> {
  const repo = normalizeString(config.hfDatasetRepo)
  const split = normalizeString(config.hfDatasetSplit || "train")
  const hfConfig = normalizeString(config.hfDatasetConfig || "default")
  const maxRows = Math.max(100, Math.min(10000, config.hfMaxRows || 3000))
  const headers = buildHfHeaders()
  const probeUrl = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(repo)}&config=${encodeURIComponent(hfConfig)}&split=${encodeURIComponent(split)}&offset=0&length=1`
  const probe = await fetch(probeUrl, { headers, cache: "no-store" })
  if (!probe.ok) {
    throw new Error(
      `HF dataset access failed for ${repo} (${hfConfig}/${split}) with status ${probe.status}. Set HF_TOKEN/HUGGINGFACE_TOKEN for private datasets.`,
    )
  }
  const info = await fetchJson<HfInfoResponse>(`https://huggingface.co/api/datasets/${encodeURIComponent(repo)}`, headers)
  const revisionSeed = normalizeString(info?.sha) || normalizeString(info?.lastModified) || "unknown"
  const cacheKey = `hf:${repo}:${hfConfig}:${split}:${maxRows}:${config.sourceType}`
  const cached = recordsCache.get(cacheKey)
  if (cached && cached.versionToken === revisionSeed) {
    return { records: cached.records, versionToken: cached.versionToken }
  }

  const rows: Array<Record<string, string>> = []
  const pageSize = 100
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const length = Math.min(pageSize, maxRows - offset)
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(repo)}&config=${encodeURIComponent(hfConfig)}&split=${encodeURIComponent(split)}&offset=${offset}&length=${length}`
    const payload = await fetchJson<HfRowsResponse>(url, headers)
    const currentRows = (payload?.rows || [])
      .map((entry) => (entry?.row && typeof entry.row === "object" ? normalizeHfRecord(entry.row) : null))
      .filter((entry): entry is Record<string, string> => !!entry && Object.keys(entry).length > 0)
    if (currentRows.length === 0) break
    rows.push(...currentRows)
    if (currentRows.length < length) break
  }

  const records = buildDatasetRowRecords(rows, config.sourceType)
  recordsCache.set(cacheKey, { records, versionToken: revisionSeed })
  return { records, versionToken: revisionSeed }
}

async function loadLocalDatasetRecords(config: AgentToolRagConfig): Promise<{ records: DatasetRowRecord[]; versionToken: string }> {
  if (!config.datasetPath) return { records: [], versionToken: "missing" }
  const fileStats = await stat(config.datasetPath)
  const versionToken = `${Math.floor(fileStats.mtimeMs)}`
  const cacheKey = `${config.datasetPath}::${config.sourceType}`
  const cached = recordsCache.get(cacheKey)
  if (cached && cached.versionToken === versionToken) {
    return { records: cached.records, versionToken: cached.versionToken }
  }

  const buffer = await readFile(config.datasetPath)
  const zip = await JSZip.loadAsync(buffer)
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string")
  const workbookRelsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string")
  if (!workbookXml || !workbookRelsXml) {
    recordsCache.set(cacheKey, { records: [], versionToken })
    return { records: [], versionToken }
  }

  const sheetRid = workbookXml.match(/<sheet\b[^>]*r:id="([^"]+)"[^>]*\/?>/i)?.[1]
  if (!sheetRid) {
    recordsCache.set(cacheKey, { records: [], versionToken })
    return { records: [], versionToken }
  }
  const relationshipRegex = new RegExp(`<Relationship\\b[^>]*Id="${sheetRid}"[^>]*Target="([^"]+)"[^>]*\\/?>`, "i")
  const target = workbookRelsXml.match(relationshipRegex)?.[1]
  if (!target) {
    recordsCache.set(cacheKey, { records: [], versionToken })
    return { records: [], versionToken }
  }
  const sheetPath = target.startsWith("xl/") ? target : `xl/${target}`
  const sharedStringsXml = await zip.file("xl/sharedStrings.xml")?.async("string")
  const sharedStrings = sharedStringsXml ? parseSharedStrings(sharedStringsXml) : []
  const sheetXml = await zip.file(sheetPath)?.async("string")
  if (!sheetXml) {
    recordsCache.set(cacheKey, { records: [], versionToken })
    return { records: [], versionToken }
  }

  const rows = parseSheetRows(sheetXml, sharedStrings)
  const workbookRows = buildWorkbookRows(rows)
  const records = buildDatasetRowRecords(workbookRows, config.sourceType)
  recordsCache.set(cacheKey, { records, versionToken })
  return { records, versionToken }
}

async function loadDatasetRecords(config: AgentToolRagConfig): Promise<{ records: DatasetRowRecord[]; versionToken: string }> {
  const sourceRecords: DatasetRowRecord[] = []
  const versionTokens: string[] = []

  if (config.datasetPath) {
    try {
      const local = await loadLocalDatasetRecords(config)
      sourceRecords.push(
        ...local.records.map((record) => ({
          ...record,
          id: `local:${record.id}`,
        })),
      )
      versionTokens.push(`local:${local.versionToken}`)
    } catch {
    }
  }

  if (config.hfDatasetRepo) {
    try {
      const hf = await loadHfDatasetRecords(config)
      sourceRecords.push(
        ...hf.records.map((record) => ({
          ...record,
          id: `hf:${record.id}`,
        })),
      )
      versionTokens.push(`hf:${hf.versionToken}`)
    } catch (error) {
      if (sourceRecords.length === 0) throw error
    }
  }

  if (sourceRecords.length === 0) {
    return { records: [], versionToken: "empty" }
  }

  const deduped = Array.from(
    new Map(
      sourceRecords.map((record) => [
        `${normalizeHeader(record.title)}::${normalizeHeader(record.synopsis)}::${normalizeHeader(record.judgment)}`,
        record,
      ]),
    ).values(),
  )
  return { records: deduped, versionToken: versionTokens.join("|") || "mixed" }
}

function scoreRecord(record: DatasetRowRecord, queryTokens: string[]): { score: number; matchedTokens: number } {
  if (queryTokens.length === 0) return { score: 0, matchedTokens: 0 }
  let score = 0
  let matchedTokens = 0
  for (const token of queryTokens) {
    let tokenScore = 0
    if (record.titleTokens.has(token)) tokenScore = Math.max(tokenScore, 4.2)
    if (record.themeTokens.has(token)) tokenScore = Math.max(tokenScore, 3.4)
    if (record.synopsisTokens.has(token)) tokenScore = Math.max(tokenScore, 2.2)
    if (record.judgmentTokens.has(token)) tokenScore = Math.max(tokenScore, 1.3)
    if (record.metaTokens.has(token)) tokenScore = Math.max(tokenScore, 1.1)
    if (tokenScore > 0) {
      score += tokenScore
      matchedTokens += 1
    }
  }
  if (matchedTokens >= 3) score += 1.5
  if (matchedTokens >= 5) score += 1.5
  if (record.judgment) score += 0.2
  if (record.themes.length > 0) score += 0.3
  return { score, matchedTokens }
}

function extractRetrievalQuery(query: string): string {
  const lines = query
    .split(/\r?\n/g)
    .map((line) => normalizeSpaces(line))
    .filter(Boolean)
  const filmTitleLine = lines.find((line) => /^film\s*title\s*:/i.test(line))
  const synopsisLine = lines.find((line) => /^synopsis\s*:/i.test(line))
  const loglineLine = lines.find((line) => /^logline\s*:/i.test(line))
  const themesLine = lines.find((line) => /^themes?\s*:/i.test(line))
  const targetAudienceLine = lines.find((line) => /^target\s*audience\s*:/i.test(line))
  const focused = [filmTitleLine, synopsisLine, loglineLine, themesLine, targetAudienceLine]
    .filter((line): line is string => Boolean(line))
    .join(" ")
  return focused || query
}

function lexicalSearch(records: DatasetRowRecord[], query: string, k: number): DatasetRagHit[] {
  const retrievalQuery = extractRetrievalQuery(query)
  const queryTokens = tokenize(retrievalQuery)
  const ranked = records
    .map((record) => ({ record, ...scoreRecord(record, queryTokens) }))
    .filter((entry) => entry.score > 0 && entry.matchedTokens >= 2)
    .sort((a, b) => b.score - a.score)
  const usable = ranked.length > 0 ? ranked : records
    .map((record) => ({ record, ...scoreRecord(record, queryTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
  return usable
    .slice(0, Math.max(1, Math.min(12, k)))
    .map(({ record, score }) => ({
      id: record.id,
      score: Number(score.toFixed(3)),
      title: record.title || "Untitled",
      section: record.section,
      kind: record.kind,
      format: record.format,
      judgment: record.judgment,
      synopsis: record.synopsis,
      themes: record.themes,
    }))
}

function diversifyHits(hits: DatasetRagHit[], k: number): DatasetRagHit[] {
  const limit = Math.max(1, Math.min(12, k))
  const seen = new Set<string>()
  const diversified: DatasetRagHit[] = []
  for (const hit of hits) {
    const key = `${normalizeHeader(hit.title)}::${normalizeHeader(hit.section)}`
    if (!key || seen.has(key)) continue
    seen.add(key)
    diversified.push(hit)
    if (diversified.length >= limit) break
  }
  if (diversified.length >= limit) return diversified
  for (const hit of hits) {
    if (diversified.find((entry) => entry.id === hit.id)) continue
    diversified.push(hit)
    if (diversified.length >= limit) break
  }
  return diversified
}

export async function buildAgentToolRagContext(params: {
  toolId: string
  query: string
  k?: number
}): Promise<DatasetRagContext | null> {
  const config = await resolveAgentToolRagConfig(params.toolId)
  if (!config) return null
  const trimmedQuery = normalizeString(params.query)
  const k = params.k ?? 6
  const { records } = await loadDatasetRecords(config)
  if (records.length === 0) {
    return { rubric: config.rubric, hits: [] }
  }
  const lexicalHits = lexicalSearch(records, trimmedQuery, k)
  return { rubric: config.rubric, hits: diversifyHits(lexicalHits, k) }
}

export function formatDatasetRagContextForPrompt(context: DatasetRagContext): string {
  const header = ["Dataset rubric schema to apply:", context.rubric]
  if (context.hits.length === 0) {
    return [...header, "Dataset retrieval hits: none found. Ask for specific details when context is insufficient."].join("\n")
  }
  const rows = context.hits.map((hit, index) =>
    [
      `Example ${index + 1}: ${hit.title}`,
      `score: ${hit.score}`,
      `section: ${hit.section || "n/a"} | kind: ${hit.kind || "n/a"} | format: ${hit.format || "n/a"}`,
      `themes: ${hit.themes.length > 0 ? hit.themes.join(", ") : "n/a"}`,
      `judgment_reference: ${hit.judgment || "n/a"}`,
      `synopsis_reference: ${hit.synopsis || "n/a"}`,
    ].join("\n"),
  )
  return [...header, "Dataset retrieval hits:", ...rows].join("\n\n")
}
