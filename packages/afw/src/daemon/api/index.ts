import { Hono } from 'hono'
import { handleGetInstance, handleListInstances } from './instances.ts'
import { handleDeleteKey, handleGetKeys, handlePostKey } from './keys.ts'
import {
  handleDeleteMaskingCustom,
  handleGetMasking,
  handlePostMaskingCustom,
  handlePostMaskingFake,
  handlePostMaskingProvider,
  handlePostMaskingRule,
} from './masking.ts'
import { handleListMcp } from './mcp.ts'
import { handleListRisk } from './risk.ts'
import {
  handleDeleteAgent,
  handleDeleteCapability,
  handleDeleteCombo,
  handleDeleteModel,
  handleDeleteProvider,
  handleDeleteSecret,
  handleGetBaseline,
  handleGetPolicy,
  handleGetRegistry,
  handleGetSpend,
  handlePostAgent,
  handlePostCapability,
  handlePostCombo,
  handlePostListModels,
  handlePostModel,
  handlePostProvider,
  handlePostProviderEffort,
  handlePostSecret,
  handlePostSubagent,
} from './routing.ts'
import { handleGetRun, handleListRuns } from './runs.ts'
import { handleListSkills } from './skills.ts'
import { handleTapFrame } from './tap.ts'
import { handleGetThread, handleListThreads } from './threads.ts'
import { handleDeleteTier, handleGetTiers, handlePostTier } from './tiers.ts'
import {
  handleDeleteToolProvider,
  handleGetToolProviders,
  handlePostActiveToolProvider,
  handlePostToolProvider,
} from './tool-providers.ts'
import {
  handleGetUpdate,
  handlePostUpdate,
  handlePostUpdateCheck,
  handlePostUpdatePreference,
} from './update.ts'
import { handleWireDetect, handleWireStatus } from './wire.ts'

export const api = new Hono()

api.get('/runs', handleListRuns)
api.get('/runs/:id', handleGetRun)
api.get('/risk', handleListRisk)
api.get('/masking', handleGetMasking)
api.post('/masking/rule', handlePostMaskingRule)
api.post('/masking/provider', handlePostMaskingProvider)
api.post('/masking/fake', handlePostMaskingFake)
api.post('/masking/custom', handlePostMaskingCustom)
api.delete('/masking/custom', handleDeleteMaskingCustom)
api.get('/threads', handleListThreads)
api.get('/threads/:id', handleGetThread)
api.get('/instances', handleListInstances)
api.get('/instances/:key', handleGetInstance)
api.get('/mcp', handleListMcp)
api.get('/skills', handleListSkills)
api.get('/wire/status', handleWireStatus)
api.get('/wire/detect', handleWireDetect)
api.get('/routing/registry', handleGetRegistry)
api.post('/routing/provider', handlePostProvider)
api.post('/routing/provider/effort', handlePostProviderEffort)
api.delete('/routing/provider', handleDeleteProvider)
api.post('/routing/model', handlePostModel)
api.delete('/routing/model', handleDeleteModel)
api.post('/routing/combo', handlePostCombo)
api.delete('/routing/combo', handleDeleteCombo)
api.post('/routing/list-models', handlePostListModels)
api.get('/routing/policy', handleGetPolicy)
api.post('/routing/subagent', handlePostSubagent)
api.post('/routing/agent', handlePostAgent)
api.delete('/routing/agent', handleDeleteAgent)
api.post('/routing/capability', handlePostCapability)
api.delete('/routing/capability', handleDeleteCapability)
api.post('/routing/secret', handlePostSecret)
api.delete('/routing/secret', handleDeleteSecret)
api.get('/routing/spend', handleGetSpend)
api.get('/routing/baseline', handleGetBaseline)
api.get('/keys', handleGetKeys)
api.post('/keys', handlePostKey)
api.delete('/keys', handleDeleteKey)
api.get('/tiers', handleGetTiers)
api.post('/tiers', handlePostTier)
api.delete('/tiers', handleDeleteTier)
api.get('/tool-providers', handleGetToolProviders)
api.post('/tool-providers', handlePostToolProvider)
api.delete('/tool-providers', handleDeleteToolProvider)
api.post('/tool-providers/active', handlePostActiveToolProvider)
api.post('/tap/frame', handleTapFrame)
api.get('/update', handleGetUpdate)
api.post('/update', handlePostUpdate)
api.post('/update/check', handlePostUpdateCheck)
api.post('/update/preference', handlePostUpdatePreference)
