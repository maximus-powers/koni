import { describe, expect, it } from "vitest";
import {
  AUTHORITY_PROTOCOL,
  AuthorityProtocolError,
  encodeFrame,
  FrameDecoder,
  type RpcRequest,
} from "../src/authority/protocol.js";

describe("authority framing", () => {
  it("round trips fragmented and coalesced frames", () => {
    const first: RpcRequest = { type: "request", id: "one", method: "run.list" };
    const second: RpcRequest = {
      type: "request",
      id: "two",
      method: "run.pause",
      params: { run: "run-one" },
      expectedRevision: 4,
    };
    const bytes = Buffer.concat([encodeFrame(first), encodeFrame(second)]);
    const decoder = new FrameDecoder();
    expect(decoder.push(bytes.subarray(0, 3))).toEqual([]);
    expect(decoder.push(bytes.subarray(3, 11))).toEqual([]);
    expect(decoder.push(bytes.subarray(11))).toEqual([first, second]);
    decoder.finish();
  });

  it("rejects oversized lengths before buffering a payload", () => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(65, 0);
    const decoder = new FrameDecoder(64);
    expect(() => decoder.push(bytes)).toThrowError(AuthorityProtocolError);
  });

  it("rejects a truncated final frame", () => {
    const frame = encodeFrame({ type: "request", id: "one", method: "run.list" });
    const decoder = new FrameDecoder();
    decoder.push(frame.subarray(0, frame.byteLength - 1));
    expect(() => decoder.finish()).toThrow(/unconsumed bytes/);
  });

  it("negotiates only the supported protocol", () => {
    const decoder = new FrameDecoder();
    expect(
      decoder.push(
        encodeFrame({
          protocol: AUTHORITY_PROTOCOL,
          client: "tui",
          clientVersion: "0.1.0",
          clientBuildSha256: `sha256:${"a".repeat(64)}`,
          projectRoot: "/tmp/project",
          nonce: "nonce",
        }),
      ),
    ).toHaveLength(1);

    const payload = Buffer.from(JSON.stringify({ protocol: "koni.authority.v0" }), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.byteLength);
    expect(() => new FrameDecoder().push(Buffer.concat([header, payload]))).toThrow(
      /unsupported authority protocol/,
    );
  });
});
