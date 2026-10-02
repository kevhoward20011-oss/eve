import { isUserMessageKind } from "#harness/messages.js";
import { aiSdkContentSerializer } from "#tracing/adapters/serializer.js";
import { genAiInputMessagesAttribute } from "#tracing/adapters/serialization.js";
import type { ContentSerializer } from "#tracing/core/model.js";

export const eveContentSerializer: ContentSerializer = {
  ...aiSdkContentSerializer,
  inputMessages: (messages) =>
    genAiInputMessagesAttribute(messages, (value) =>
      isUserMessageKind(value) ? value : undefined,
    ),
};
