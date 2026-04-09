export const GIFFONI_REVIEWER_SYSTEM_PROMPT = `The selected agent tool is "Giffoni Reviewer".

You are a senior festival juror-level film reviewer, operating with the rigor expected from awards-season evaluation panels (Oscars-grade analytical discipline), while applying Giffoni-style youth-focused criteria and the provided dataset standards.

Core behavior:
- Focus on film criticism and evaluation only.
- Never generate image plans for this tool.
- Return falPlan as null.
- Keep the reply practical and production-oriented for editorial usage.
- Critique the user-provided film directly; do not answer with generic examples.
- Use retrieved dataset content from local and Hugging Face sources as grounding patterns, not as copied summaries.
- Prioritize concrete craft analysis over taste statements: story architecture, scene function, character agency, cinematic language, and audience impact.

Review framework:
- Evaluate narrative clarity, emotional resonance, character development, visual language, sound/music impact, cultural relevance, and age-appropriate accessibility.
- Assign an overall verdict with confidence level.
- Include strengths, weaknesses, and concrete improvement actions.
- If the user asks for business outcomes, include audience fit, festival positioning, and distribution-readiness notes.
- Return structured review fields: review_summary, festival_fit_score (0-100), audience_segment_fit, improvement_actions, confidence (0-1).
- Return a scoring_sheet with 0-5 scores for: narrative_clarity, character_arc, emotional_impact, visual_language, sound_design_music, audience_fit, festival_suitability, actionability.
- Compute weighted_score_100 using these weights:
  narrative_clarity 15%
  character_arc 15%
  emotional_impact 15%
  visual_language 10%
  sound_design_music 10%
  audience_fit 15%
  festival_suitability 10%
  actionability 10%
- Ground your assessment in the retrieved dataset examples when available.
- When grounding from retrieval, reference patterns briefly (for example, grief-processing arc clarity, age-fit tension, pacing density) without quoting full retrieved synopses.
- Avoid generic praise; provide specific, testable editorial guidance.
- If confidence is below 0.6, explicitly signal uncertainty in review_summary.
- If the user asks for structural analysis, assistantMessage must include these sections in order:
  1) Executive Verdict
  2) Structural Audit (Act I setup, Midpoint shift, Act III/Climax payoff)
  3) Pacing Rhythm (where momentum rises/drops)
  4) Narrative Causality (cause→effect chain and broken links)
  5) Dead Zones (specific moments that stall progression)
  6) Scene-by-Scene Rewrite Notes (Scene intent, issue, rewrite move, expected effect)
  7) Risk Notes (psychological credibility, motivation consistency, age-fit)
- Each section must include concrete references to the provided synopsis details and must avoid filler.
- Provide at least 6 rewrite notes when the user requests scene-level notes.

Stage policy for this tool:
- Use "needs_info" when essential review inputs are missing (film title, synopsis, screenplay excerpt, scene description, or target audience).
- Use "proceed_ready" once enough information exists to deliver a full review.
- Do not use "summary_ready" unless the user explicitly asks for a multi-phase review workflow.

Output shape constraints:
- assistantMessage must contain the complete review text.
- missingInformation must be an array of missing inputs when stage is needs_info.
- situationSummary should briefly summarize the current review context.
- orchestrationThoughts should list 3 short user-safe bullets about review process.
- falPlan must be null.

Return ONLY valid JSON with:
{
  "stage": "needs_info" | "proceed_ready" | "summary_ready",
  "assistantMessage": "string",
  "missingInformation": ["string"],
  "situationSummary": "string",
  "orchestrationThoughts": ["string", "string", "string"],
  "falPlan": null,
  "review_summary": "string",
  "festival_fit_score": 0,
  "audience_segment_fit": ["string"],
  "improvement_actions": ["string"],
  "confidence": 0.0,
  "scoring_sheet": {
    "narrative_clarity": 0,
    "character_arc": 0,
    "emotional_impact": 0,
    "visual_language": 0,
    "sound_design_music": 0,
    "audience_fit": 0,
    "festival_suitability": 0,
    "actionability": 0,
    "weighted_score_100": 0
  }
}`

const SCORING_WEIGHTS = {
  narrative_clarity: 0.15,
  character_arc: 0.15,
  emotional_impact: 0.15,
  visual_language: 0.1,
  sound_design_music: 0.1,
  audience_fit: 0.15,
  festival_suitability: 0.1,
  actionability: 0.1,
} as const

export type GiffoniScoringSheet = {
  narrative_clarity: number
  character_arc: number
  emotional_impact: number
  visual_language: number
  sound_design_music: number
  audience_fit: number
  festival_suitability: number
  actionability: number
  weighted_score_100: number
}

export type GiffoniStructuredReview = {
  review_summary: string
  festival_fit_score: number
  audience_segment_fit: string[]
  improvement_actions: string[]
  confidence: number
  scoring_sheet: GiffoniScoringSheet
}

function computeWeightedScore100(scoringSheet: Omit<GiffoniScoringSheet, "weighted_score_100">): number {
  const total =
    scoringSheet.narrative_clarity * SCORING_WEIGHTS.narrative_clarity +
    scoringSheet.character_arc * SCORING_WEIGHTS.character_arc +
    scoringSheet.emotional_impact * SCORING_WEIGHTS.emotional_impact +
    scoringSheet.visual_language * SCORING_WEIGHTS.visual_language +
    scoringSheet.sound_design_music * SCORING_WEIGHTS.sound_design_music +
    scoringSheet.audience_fit * SCORING_WEIGHTS.audience_fit +
    scoringSheet.festival_suitability * SCORING_WEIGHTS.festival_suitability +
    scoringSheet.actionability * SCORING_WEIGHTS.actionability
  return Math.round(Math.max(0, Math.min(100, (total / 5) * 100)))
}

function formatScoringSheet(scoringSheet: GiffoniScoringSheet): string {
  return [
    "Scoring Sheet (0-5)",
    `- Narrative Clarity: ${scoringSheet.narrative_clarity.toFixed(1)}`,
    `- Character Arc: ${scoringSheet.character_arc.toFixed(1)}`,
    `- Emotional Impact: ${scoringSheet.emotional_impact.toFixed(1)}`,
    `- Visual Language: ${scoringSheet.visual_language.toFixed(1)}`,
    `- Sound Design & Music: ${scoringSheet.sound_design_music.toFixed(1)}`,
    `- Audience Fit: ${scoringSheet.audience_fit.toFixed(1)}`,
    `- Festival Suitability: ${scoringSheet.festival_suitability.toFixed(1)}`,
    `- Actionability: ${scoringSheet.actionability.toFixed(1)}`,
    `Weighted Score: ${scoringSheet.weighted_score_100}/100`,
  ].join("\n")
}

export function formatGiffoniStructuredReview(review: GiffoniStructuredReview): string {
  const audienceFit =
    review.audience_segment_fit.length > 0
      ? review.audience_segment_fit.map((entry) => `- ${entry}`).join("\n")
      : "- Not enough context to score segment fit yet."
  const improvementActions =
    review.improvement_actions.length > 0
      ? review.improvement_actions.map((entry) => `- ${entry}`).join("\n")
      : "- No concrete actions generated; request scene-level details."
  const confidencePercent = Math.round(review.confidence * 100)
  return [
    "Review Summary",
    review.review_summary || "Insufficient evidence for a full review.",
    "",
    `Festival Fit Score: ${Math.round(review.festival_fit_score)}/100`,
    `Confidence: ${confidencePercent}%`,
    "",
    "Audience Segment Fit",
    audienceFit,
    "",
    "Improvement Actions",
    improvementActions,
    "",
    formatScoringSheet(review.scoring_sheet),
  ].join("\n")
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function normalizeBoundedNumber(value: unknown, min: number, max: number): number | null {
  const num = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(num)) return null
  return Math.min(max, Math.max(min, num))
}

function normalizeScoringSheet(value: unknown): GiffoniScoringSheet {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const scoringSheet = {
    narrative_clarity: normalizeBoundedNumber(source.narrative_clarity, 0, 5) ?? 0,
    character_arc: normalizeBoundedNumber(source.character_arc, 0, 5) ?? 0,
    emotional_impact: normalizeBoundedNumber(source.emotional_impact, 0, 5) ?? 0,
    visual_language: normalizeBoundedNumber(source.visual_language, 0, 5) ?? 0,
    sound_design_music: normalizeBoundedNumber(source.sound_design_music, 0, 5) ?? 0,
    audience_fit: normalizeBoundedNumber(source.audience_fit, 0, 5) ?? 0,
    festival_suitability: normalizeBoundedNumber(source.festival_suitability, 0, 5) ?? 0,
    actionability: normalizeBoundedNumber(source.actionability, 0, 5) ?? 0,
  }
  const weightedFromModel = normalizeBoundedNumber(source.weighted_score_100, 0, 100)
  const computed = computeWeightedScore100(scoringSheet)
  return {
    ...scoringSheet,
    weighted_score_100: weightedFromModel === null ? computed : Math.round((weightedFromModel + computed) / 2),
  }
}

export function normalizeGiffoniStructuredReview(value: unknown): GiffoniStructuredReview | null {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : null
  if (!source) return null
  const reviewSummary =
    typeof source.review_summary === "string" && source.review_summary.trim().length > 0
      ? source.review_summary.trim()
      : ""
  const festivalFitScore = normalizeBoundedNumber(source.festival_fit_score, 0, 100)
  const confidence = normalizeBoundedNumber(source.confidence, 0, 1)
  const audienceSegmentFit = normalizeStringArray(source.audience_segment_fit)
  const improvementActions = normalizeStringArray(source.improvement_actions)
  const scoringSheet = normalizeScoringSheet(source.scoring_sheet)

  if (
    !reviewSummary &&
    festivalFitScore === null &&
    confidence === null &&
    audienceSegmentFit.length === 0 &&
    improvementActions.length === 0 &&
    scoringSheet.weighted_score_100 === 0
  ) {
    return null
  }

  return {
    review_summary: reviewSummary,
    festival_fit_score: festivalFitScore ?? 0,
    audience_segment_fit: audienceSegmentFit,
    improvement_actions: improvementActions,
    confidence: confidence ?? 0,
    scoring_sheet: scoringSheet,
  }
}
