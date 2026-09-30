import type { Channel } from "@prisma/client";
import { MetaAdapter } from "./meta";
import { WhatsAppAdapter } from "./whatsapp";
import type { ChannelAdapter, SendResult } from "./types";

export * from "./types";

/** The internal test channel never leaves the server. */
class TestAdapter implements ChannelAdapter {
  readonly channel = "TEST" as const;
  readonly maxLength = 4000;
  async send(): Promise<SendResult> {
    return { ok: true, externalIds: [] };
  }
}

let testFactory: ((channel: Channel) => ChannelAdapter) | null = null;

/** Test hook: route all outbound sends through a fake adapter. Ignored in production. */
export function setAdapterFactoryForTests(factory: ((channel: Channel) => ChannelAdapter) | null) {
  if (process.env.NODE_ENV === "production") return;
  testFactory = factory;
}

export function getAdapter(channel: Channel): ChannelAdapter {
  if (testFactory) return testFactory(channel);
  switch (channel) {
    case "MESSENGER":
      return new MetaAdapter("MESSENGER");
    case "INSTAGRAM":
      return new MetaAdapter("INSTAGRAM");
    case "WHATSAPP":
      return new WhatsAppAdapter();
    case "TEST":
      return new TestAdapter();
  }
}
