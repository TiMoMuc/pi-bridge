import { describe, expect, it } from "vitest";
import { prepareOutboundChunks } from "../src/outbound-delivery.js";
import type { Transport } from "../src/transport.js";

function makeTransport(name: "signal" | "nextcloud"): Transport {
  return {
    name,
    maxMessageLength: 4_000,
    send: async () => ({}),
    fetchAttachment: async () => Buffer.from(""),
    waitUntilReady: async () => {},
    listen: () => {},
    stop: () => {},
  };
}

describe("prepareOutboundChunks", () => {
  it("drops empty text-only sends after token stripping", () => {
    expect(prepareOutboundChunks(makeTransport("signal"), "", [])).toEqual([]);
    expect(prepareOutboundChunks(makeTransport("nextcloud"), "", [])).toEqual([]);
  });

  it("keeps attachment-only sends for the first chunk", () => {
    expect(prepareOutboundChunks(makeTransport("signal"), "", ["/tmp/file.pdf"])).toEqual([
      {
        text: "",
        options: {
          attachments: ["/tmp/file.pdf"],
          textStyles: [],
          target: undefined,
        },
      },
    ]);
  });

  it("keeps normal visible text sends", () => {
    expect(prepareOutboundChunks(makeTransport("signal"), "hello", [])).toEqual([
      {
        text: "hello",
        options: {
          attachments: undefined,
          textStyles: [],
          target: undefined,
        },
      },
    ]);
  });
});
