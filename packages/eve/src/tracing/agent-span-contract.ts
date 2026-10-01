export {
  SPAN_NAMES as AGENT_SPAN_NAMES,
  USAGE_FIELDS as AGENT_USAGE_ATTRIBUTES,
  invocationName as agentInvocationSpanName,
  modelName as modelSpanName,
} from "#tracing/core/contract.js";
export const AGENT_TRACE_SCHEMA_VERSION = 4;

export interface AgentSamplingOperation {
  readonly name: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean | undefined>>;
}

export { isAgentActivationSpan, agentTurnIdentity } from "#tracing/core/inspection.js";
