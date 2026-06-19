import { nanoid } from 'nanoid'

export type ThreadId = `th_${string}`
export type RunId = `ru_${string}`
export type ActionId = `ac_${string}`
export type BackupId = `bk_${string}`

export const newThreadId = (): ThreadId => `th_${nanoid()}`
export const newRunId = (): RunId => `ru_${nanoid()}`
export const newActionId = (): ActionId => `ac_${nanoid()}`
export const newBackupId = (): BackupId => `bk_${nanoid()}`
