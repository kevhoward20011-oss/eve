import type { TraceLink } from "#tracing/core/types.js";

export function linkAttributes(link: TraceLink) {
  return { context: link.context, attributes: { "agent.link.type": link.relationship } };
}
