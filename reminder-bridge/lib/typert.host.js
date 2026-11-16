/**
 * dsh-reminder 的 Host 面 Typert 清单（由 typert-loader 自动扫描注册）。
 * 结构必须与 @deepseek-ai/dsh-typert-loader 的 validateTypertManifest /
 * typert-registry 的 validateInvocation 校验规则一致：
 *  - TYPERT.model 必须是对象，含 services / events / objects 三个数组；
 *  - invocation 的 parameters 每项需 { name, wire, source, codec }；
 *  - codec / result 必须是严格 codec：{ mode:'strict', typeSymbol, create }；
 *    其中 create() 必须返回 zod v4 实例（含 _zod 与 parse）；旧版写的 schema: z.xxx
 *    会被 typert-loader 以 "has no create() factory" 拒绝，并连带撤回本进程所有
 *    strict 定义（settings/describe 等官方 RPC 全部 500/definition-unavailable）。
 */

import { z } from 'zod'

const configCodec = z.object({
  position: z.string(),
  mode: z.string(),
  manualModes: z.array(z.string()),
  flashOpacity: z.number(),
  flashRounds: z.number(),
  flashPulseMs: z.number(),
  flashGapMs: z.number(),
  enabled: z.boolean(),
})

const patchCodec = z.object({
  position: z.string().optional(),
  mode: z.string().optional(),
  manualModes: z.array(z.string()).optional(),
  flashOpacity: z.number().optional(),
  flashRounds: z.number().optional(),
  flashPulseMs: z.number().optional(),
  flashGapMs: z.number().optional(),
  enabled: z.boolean().optional(),
})

export const TYPERT = {
  package: 'dsh-reminder',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-reminder#reminderConfig/getConfig',
      service: 'reminderConfig',
      namespace: 'reminderConfig',
      method: 'getConfig',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-reminder#ReminderConfig',
        create: () => configCodec,
      },
    },
    {
      id: 'dsh-reminder#reminderConfig/setConfig',
      service: 'reminderConfig',
      namespace: 'reminderConfig',
      method: 'setConfig',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'patch',
          wire: 'patch',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'dsh-reminder#ReminderConfigPatch',
            create: () => patchCodec,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-reminder#ReminderConfig',
        create: () => configCodec,
      },
    },
  ],
  model: {
    services: [
      {
        key: 'reminderConfig',
        exportName: 'ReminderConfigService',
        description: '提醒配置的远程读写服务：client 端面板经 Typert RPC 读写 Host 侧实时状态。',
        summary: '提醒配置远程服务。',
        tags: [],
        members: [
          {
            kind: 'method',
            name: 'getConfig',
            signature: 'getConfig(): Promise<ReminderConfig>',
          },
          {
            kind: 'method',
            name: 'setConfig',
            signature: 'setConfig(patch: ReminderConfigPatch): Promise<ReminderConfig>',
          },
        ],
        types: [
          {
            name: 'ReminderConfig',
            declaration:
              'export interface ReminderConfig { position: string; mode: string; manualModes: string[]; flashOpacity: number; flashRounds: number; flashPulseMs: number; flashGapMs: number; enabled: boolean; }',
          },
          {
            name: 'ReminderConfigPatch',
            declaration:
              'export interface ReminderConfigPatch { position?: string; mode?: string; manualModes?: string[]; flashOpacity?: number; flashRounds?: number; flashPulseMs?: number; flashGapMs?: number; enabled?: boolean; }',
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT
