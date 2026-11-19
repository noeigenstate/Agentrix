import { modelName } from './model-name.ts';
import type { SeatsInfo } from './types';

export const OPEN_SEATS = 'agentrix:open-seats';
export type SeatsTarget = { projectId?: string; terminalId?: string };
export type SeatsRequest = SeatsTarget & { info?: SeatsInfo };

export const isRoutingCommand = (words: string) => /^\/(?:model|effort|fast)(?:\s|$)/.test(words.trim());

export function openSeats(target: SeatsRequest) {
  window.dispatchEvent(new CustomEvent(OPEN_SEATS, { detail: target }));
}

export async function readRoutingCommand({ projectId, terminalId }: SeatsTarget) {
  try {
    const info = await window.agentrix?.skillSeats?.(projectId, terminalId);
    if (info) return { info, notice: '模型由模型路由决定' };
    if (info === null) return { notice: '模型路由已关闭，使用 CLI 自身的默认设置' };
  } catch { /* The routing status could not be read. */ }
  return { notice: '无法读取模型路由状态' };
}

export function routingRoleName(name: string, t: (key: string) => string) {
  const key = '席位 · ' + name;
  const label = t(key);
  return label === key ? t(name) : label;
}

export const routingModelName = (model: string) =>
  /^(opus|sonnet|haiku)$/.test(model) ? model[0].toUpperCase() + model.slice(1) : modelName(model);
