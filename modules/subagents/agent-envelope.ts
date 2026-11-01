export type AgentMessageKind = "QUESTION" | "FINAL_ANSWER" | "STATUS" | "NEW_TASK";

export interface AgentEnvelopeInput {
  kind: AgentMessageKind;
  taskName: string;
  payload: string;
  sender?: string;
}

export const AGENT_TURN_DELIVERY = { triggerTurn: true, deliverAs: "followUp" } as const;

export const AGENT_QUEUE_DELIVERY = { triggerTurn: false } as const;

export function buildAgentEnvelope(input: AgentEnvelopeInput): string {
  const sender = input.sender ?? input.taskName;
  return `Message Type: ${input.kind}\nTask name: ${input.taskName}\nSender: ${sender}\nPayload:\n${input.payload}`;
}

export function buildResultEnvelope(input: { taskName: string; payload: string; hostNote: string }): string {
  const answer = buildAgentEnvelope({ kind: "FINAL_ANSWER", taskName: input.taskName, payload: input.payload });
  const note = buildAgentEnvelope({ kind: "STATUS", taskName: rootTaskName(), payload: input.hostNote });
  return `${answer}\n\n${note}`;
}

export function agentTaskName(running: {
  name: string;
  canonicalTaskName?: string | null;
  parentCanonicalTaskName?: string | null;
}): string {
  return running.canonicalTaskName ?? `${running.parentCanonicalTaskName ?? "/root"}/${running.name}`;
}

export function rootTaskName(): string {
  return process.env.PI_SUBAGENT_TASK_PATH?.trim() || "/root";
}

export function questionSummary(question: string): string {
  return `QUESTION: ${question.trim().slice(0, 200)}`;
}
