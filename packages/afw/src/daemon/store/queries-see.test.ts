import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from './schema.ts'

// Mock getDb to point the query layer at an in-memory database we seed below.
let testDb: ReturnType<typeof drizzle>
vi.mock('./db.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as object
  return { ...actual, getDb: async () => testDb }
})

const { applySchema } = await import('./db.ts')
const { listAgentInstances, getInstanceDetail, listMcpServers, listSkills } = await import(
  './queries.ts'
)

const tu = (o: Partial<typeof schema.toolUses.$inferInsert> & { name: string }) => ({
  actionId: o.actionId ?? `a-${Math.random()}`,
  agent: o.agent ?? 'claude-code',
  ts: o.ts ?? 1000,
  costMicroShare: o.costMicroShare ?? 0,
  isError: o.isError ?? 0,
  ...o,
})

beforeAll(() => {
  const raw = new Database(':memory:')
  applySchema(raw)
  testDb = drizzle(raw, { schema })

  // Two instances of claude-code: 'worker-a' and the null (unknown) bucket.
  const mkAction = (instanceId: string | null, threadId: string, ts: number) => ({
    id: `act-${threadId}-${ts}`,
    runId: `run-${threadId}`,
    threadId,
    kind: 'model_call',
    sourceAgent: 'claude-code',
    ts,
    durMs: 1,
    costUsd: 1_000_000, // $1
    instanceId,
  })
  testDb
    .insert(schema.actions)
    .values([
      mkAction('worker-a', 't1', 1000),
      mkAction('worker-a', 't2', 2000),
      mkAction(null, 't3', 1500),
    ])
    .run()

  testDb
    .insert(schema.toolUses)
    .values([
      // worker-a: 2 builtins, 1 mcp server (github), 1 skill
      tu({ name: 'Edit', category: 'builtin', instanceId: 'worker-a', threadId: 't1' }),
      tu({ name: 'Bash', category: 'builtin', instanceId: 'worker-a', threadId: 't1' }),
      tu({
        name: 'mcp__github__create_issue',
        category: 'mcp',
        detail: 'github',
        instanceId: 'worker-a',
        threadId: 't1',
      }),
      tu({
        name: 'tools/call',
        category: 'mcp',
        detail: 'github',
        instanceId: 'worker-a',
        threadId: 't2',
      }),
      tu({
        name: 'Skill',
        category: 'skill',
        detail: 'deep-research',
        instanceId: 'worker-a',
        threadId: 't2',
      }),
      // unknown bucket: 1 skill (deep-research again, different instance)
      tu({
        name: 'Skill',
        category: 'skill',
        detail: 'deep-research',
        instanceId: null,
        threadId: 't3',
      }),
    ])
    .run()
})

describe('listAgentInstances', () => {
  it('groups by (agent, instance) with the null bucket separate', async () => {
    const rows = await listAgentInstances()
    expect(rows).toHaveLength(2)
    const worker = rows.find((r) => r.instanceId === 'worker-a')
    const unknown = rows.find((r) => r.instanceId === null)
    expect(worker).toMatchObject({ taskCount: 2, mcpCount: 1, skillCount: 1, toolCount: 5 })
    expect(worker?.costUsd).toBe(2)
    expect(unknown).toMatchObject({ taskCount: 1, skillCount: 1 })
  })
})

describe('getInstanceDetail', () => {
  it('lists the instance’s mcp servers / skills / tools', async () => {
    const d = await getInstanceDetail('claude-code', 'worker-a')
    expect(d?.mcpServers).toEqual([{ name: 'github', count: 2 }])
    expect(d?.skills).toEqual([{ name: 'deep-research', count: 1 }])
    expect(d?.tools.map((t) => t.name).sort()).toEqual([
      'Bash',
      'Edit',
      'Skill',
      'mcp__github__create_issue',
      'tools/call',
    ])
  })
  it('404s (null) for an unknown instance', async () => {
    expect(await getInstanceDetail('claude-code', 'nope')).toBeNull()
  })
})

describe('listMcpServers / listSkills', () => {
  it('aggregates mcp servers across instances', async () => {
    const servers = await listMcpServers()
    expect(servers).toEqual([
      expect.objectContaining({
        server: 'github',
        callCount: 2,
        methodCount: 2,
        instanceCount: 1,
        taskCount: 2,
      }),
    ])
  })
  it('aggregates skills across instances (deep-research used by 2 instances)', async () => {
    const skills = await listSkills()
    expect(skills).toEqual([
      expect.objectContaining({
        skill: 'deep-research',
        useCount: 2,
        instanceCount: 2,
        taskCount: 2,
      }),
    ])
  })
})
