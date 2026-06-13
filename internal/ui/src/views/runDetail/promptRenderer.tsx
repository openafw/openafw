// Structured renderer for system prompts (and the Claude-Code-style first
// user message wrapped in <system-reminder>). The raw content is usually
// 10k–30k chars with clear internal structure — markdown ## sections, an
// <available_skills> block, cache-boundary comments, conversation-resume
// summary. Show that structure instead of one big <pre>.

import { type ReactNode, useState } from 'react'

// ─────────────────────────────────────────────────────────────
// Detection — only kick in when there's enough structure to win
// ─────────────────────────────────────────────────────────────

export function looksStructured(content: string): boolean {
  if (!content || content.length < 200) return false
  if (content.includes('<available_skills>')) return true
  if (content.includes('<system-reminder>')) return true
  // Codex developer message tags + any line-start XML wrapper.
  if (/^<[A-Za-z][A-Za-z0-9_ -]*>\s*$/m.test(content)) return true
  // OpenClaw / Hermes markers
  if (/^You are a personal assistant running inside OpenClaw/m.test(content)) return true
  if (/^# Hermes Agent Persona/m.test(content)) return true
  // Generic: ≥3 markdown ## headers suggests intentional structure
  const headers = content.match(/^##\s+\S/gm)
  if (headers && headers.length >= 3) return true
  return false
}

// ─────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────

type Section = {
  title: string | null // null = lede / persona block
  level: 1 | 2
  body: string
  /** When the body contains a recognizable embedded structure, we lift it
   *  out so the renderer can format it specially instead of as text. */
  embedded?: EmbeddedBlock
}

type EmbeddedBlock =
  | { kind: 'skills'; skills: SkillEntry[] }
  | { kind: 'reminder'; body: string }
  | { kind: 'tagged'; tag: string; body: string }

type SkillEntry = {
  category?: string
  name: string
  description?: string
  location?: string
}

export function parseStructuredPrompt(content: string): Section[] {
  if (!content) return []

  // Phase 1: extract line-start <TAG>...</TAG> blocks. Three flavours:
  //
  //   <available_skills>...</available_skills>  → skill-chip grid (special)
  //   <system-reminder>...</system-reminder>    → recursively parsed reminder card
  //   any other <NAME>...</NAME>                → generic tagged section
  //
  // The opening tag must be at the start of a line and on its own line
  // (modulo trailing whitespace), and the closing tag likewise. That
  // restriction stops us from grabbing inline <X> tokens that happen
  // inside code blocks or markdown body text. Tag names may include
  // letters, digits, spaces, underscores, hyphens (e.g. "permissions
  // instructions" or "system-reminder").
  const embeds: EmbeddedBlock[] = []
  let working = content
  const blockRe = /^[ \t]*<([A-Za-z][A-Za-z0-9_ -]*)>[ \t]*\n([\s\S]*?)\n^[ \t]*<\/\1>[ \t]*$/gm
  working = working.replace(blockRe, (_m, tag: string, inner: string) => {
    const name = tag.trim()
    if (name === 'available_skills') {
      embeds.push({ kind: 'skills', skills: parseSkills(inner) })
    } else if (name === 'system-reminder') {
      embeds.push({ kind: 'reminder', body: inner.trim() })
    } else {
      embeds.push({ kind: 'tagged', tag: name, body: inner.trim() })
    }
    return `\n__EMBED_${embeds.length - 1}__\n`
  })

  // Drop HTML/markdown comment noise so it doesn't get rendered.
  working = working.replace(/<!--[\s\S]*?-->/g, '')

  // Phase 2: walk lines, breaking on # / ## headers. Each placeholder
  // line ends the current section (so the embed becomes its own
  // standalone section instead of mixing with surrounding text).
  const lines = working.split('\n')
  const sections: Section[] = []
  let cur: { title: string | null; level: 1 | 2; body: string[]; embedded?: EmbeddedBlock } = {
    title: null,
    level: 2,
    body: [],
  }
  const flush = () => {
    const body = cur.body.join('\n').trim()
    if (cur.title || body || cur.embedded) {
      const s: Section = { title: cur.title, level: cur.level, body }
      if (cur.embedded) s.embedded = cur.embedded
      sections.push(s)
    }
  }

  for (const line of lines) {
    const hdr = /^(#{1,2})\s+(.+)$/.exec(line)
    if (hdr) {
      flush()
      cur = { title: hdr[2]!.trim(), level: hdr[1]!.length === 1 ? 1 : 2, body: [] }
      continue
    }
    const embed = /^__EMBED_(\d+)__$/.exec(line.trim())
    if (embed) {
      // Each embed is its own section. Flush the current text-only
      // section first (preserving any preceding intro), then push the
      // embed as a standalone, then start a fresh section.
      flush()
      sections.push({ title: null, level: 2, body: '', embedded: embeds[Number(embed[1])] })
      cur = { title: null, level: 2, body: [] }
      continue
    }
    cur.body.push(line)
  }
  flush()

  return sections.length > 0 ? sections : [{ title: null, level: 2, body: content }]
}

function parseSkills(block: string): SkillEntry[] {
  const out: SkillEntry[] = []

  // OpenClaw XML-ish: <skill><name>X</name><description>...</description><location>...</location></skill>
  const xmlRe =
    /<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>(?:\s*<location>([\s\S]*?)<\/location>)?\s*<\/skill>/g
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: classic regex iter
  while ((m = xmlRe.exec(block)) != null) {
    out.push({
      name: m[1]!.trim(),
      description: m[2]!.replace(/\s+/g, ' ').trim(),
      ...(m[3] ? { location: m[3].trim() } : {}),
    })
  }
  if (out.length > 0) return out

  // Hermes indented: "  category[: description]\n    - name: description"
  const lines = block.split('\n')
  let currentCategory: string | undefined
  for (const line of lines) {
    const catM = /^\s{0,4}([\w-]+)(?::\s*(.*))?$/.exec(line.replace(/\s+$/, ''))
    const itemM = /^\s+-\s+([\w-]+):\s*(.*)$/.exec(line)
    if (itemM) {
      out.push({
        name: itemM[1]!.trim(),
        description: itemM[2]!.trim(),
        ...(currentCategory ? { category: currentCategory } : {}),
      })
    } else if (catM && !line.trim().startsWith('-') && line.trim().endsWith(':')) {
      currentCategory = catM[1]!.trim()
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────

export function StructuredPrompt({ content }: { content: string }) {
  const sections = parseStructuredPrompt(content)
  return (
    <div className="prompt-structured">
      {sections.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional identity is the rendering
        <PromptSection key={i} section={s} />
      ))}
    </div>
  )
}

function PromptSection({ section }: { section: Section }) {
  const isLede = section.title == null

  // Special case: this section is just an embedded block (skills or
  // system-reminder). Render the block as the whole section.
  if (section.embedded && !section.body) {
    return <EmbeddedRender title={section.title} embedded={section.embedded} />
  }

  return (
    <div className={`prompt-section${isLede ? ' prompt-lede' : ''}`}>
      {section.title ? (
        <div className="prompt-section-title">
          <span className="prompt-section-marker">{section.level === 1 ? '§' : '#'}</span>
          {section.title}
        </div>
      ) : null}
      {section.body ? <PromptBody body={section.body} /> : null}
    </div>
  )
}

function PromptBody({ body }: { body: string }) {
  // The placeholder substitution may leave inline [[skills:N]] / [[reminder:N]]
  // markers. We can't recover the original block here without state — just
  // strip them. (Top-level sections that ONLY contain a block were already
  // handled.)
  const cleaned = body.replace(/\n\[\[(?:skills|reminder):\d+\]\]\n/g, '').trim()
  if (!cleaned) return null
  return <div className="prompt-section-body">{cleaned}</div>
}

function EmbeddedRender({
  title,
  embedded,
}: {
  title: string | null
  embedded: EmbeddedBlock
}) {
  if (embedded.kind === 'skills') {
    return <SkillsBlock title={title} skills={embedded.skills} />
  }
  if (embedded.kind === 'reminder') {
    return <SystemReminderBlock title={title} body={embedded.body} />
  }
  // generic <NAME>...</NAME> tagged block (e.g. Codex developer-msg
  // sections: permissions instructions / collaboration_mode /
  // apps_instructions / skills_instructions).
  return <TaggedBlock tag={embedded.tag} body={embedded.body} />
}

function TaggedBlock({ tag, body }: { tag: string; body: string }) {
  const sub = parseStructuredPrompt(body)
  return (
    <div className="prompt-section prompt-tagged">
      <div className="prompt-section-title">
        <span className="prompt-section-marker">‹›</span>
        {tag}
      </div>
      <div className="prompt-section-body prompt-tagged-body">
        {sub.length > 1 || sub[0]?.embedded != null ? (
          <div className="prompt-structured">
            {sub.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional
              <PromptSection key={i} section={s} />
            ))}
          </div>
        ) : (
          body.trim()
        )}
      </div>
    </div>
  )
}

function SkillsBlock({ title, skills }: { title: string | null; skills: SkillEntry[] }) {
  const [showAll, setShowAll] = useState(false)
  if (skills.length === 0) return null

  // Group by category if any entry has one; otherwise flat.
  const hasCategories = skills.some((s) => s.category)
  const byCategory = new Map<string, SkillEntry[]>()
  for (const s of skills) {
    const key = s.category ?? '(uncategorised)'
    const arr = byCategory.get(key) ?? []
    arr.push(s)
    byCategory.set(key, arr)
  }

  const PREVIEW = 12
  const shown = showAll ? skills : skills.slice(0, PREVIEW)
  const overflow = skills.length - shown.length

  return (
    <div className="prompt-section prompt-skills">
      <div className="prompt-section-title">
        <span className="prompt-section-marker">⚒</span>
        {title || 'Available skills'}
        <span className="prompt-section-count">{skills.length}</span>
        {skills.length > PREVIEW ? (
          <button
            type="button"
            className="msg-expand-btn prompt-section-expand"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? '▾ show fewer' : `▸ show all ${skills.length}`}
          </button>
        ) : null}
      </div>
      {hasCategories ? (
        <div className="prompt-skills-groups">
          {[...byCategory.entries()].map(([cat, items]) => {
            const visible = showAll ? items : items.slice(0, 4)
            const more = items.length - visible.length
            return (
              <div className="prompt-skills-group" key={cat}>
                <div className="prompt-skills-group-name">{cat}</div>
                <div className="prompt-skills-list">
                  {visible.map((s) => (
                    <SkillChip key={`${cat}-${s.name}`} skill={s} />
                  ))}
                  {more > 0 ? <span className="prompt-skills-more">+ {more} more</span> : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="prompt-skills-list">
          {shown.map((s) => (
            <SkillChip key={s.name} skill={s} />
          ))}
          {overflow > 0 ? <span className="prompt-skills-more">+ {overflow} more</span> : null}
        </div>
      )}
    </div>
  )
}

function SkillChip({ skill }: { skill: SkillEntry }) {
  return (
    <div className="skill-chip" title={skill.description}>
      <span className="skill-chip-name">{skill.name}</span>
      {skill.description ? <span className="skill-chip-desc">{skill.description}</span> : null}
    </div>
  )
}

function SystemReminderBlock({
  title,
  body,
}: {
  title: string | null
  body: string
}) {
  // The reminder is itself often structured — recurse the same parser.
  const sub = parseStructuredPrompt(body)
  const hasStructure = sub.length > 1 || sub[0]?.embedded != null || sub[0]?.title != null
  return (
    <div className="prompt-section prompt-reminder">
      <div className="prompt-section-title">
        <span className="prompt-section-marker">⚠</span>
        {title || 'system-reminder'}
      </div>
      <div className="prompt-section-body prompt-reminder-body">
        {hasStructure ? (
          <div className="prompt-structured">
            {sub.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional
              <PromptSection key={i} section={s} />
            ))}
          </div>
        ) : (
          body.trim()
        )}
      </div>
    </div>
  )
}

export function getStructuredContent(role: string, raw: string): string | null {
  if (!raw) return null
  // system: every agent's bundled system prompt path.
  // developer: Codex's equivalent — the role that carries
  //   <permissions instructions> / <collaboration_mode> / etc.
  if ((role === 'system' || role === 'developer') && looksStructured(raw)) {
    return raw
  }
  // user: Claude Code wraps its CLAUDE.md context in a <system-reminder>
  //   tag on the first user turn.
  if (role === 'user' && raw.includes('<system-reminder>') && looksStructured(raw)) {
    return raw
  }
  return null
}
