// packages/shared/src/providers/media.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  MEDIA_CAPABILITIES,
  MEDIA_PROVIDERS,
  buildCosmosRequest,
  buildTtsFields,
  looksLikeWav,
  mediaProviderFor,
  parseCosmosResponse,
  toImageDataUri,
} from "./media.js";

describe("MEDIA_PROVIDERS registry", () => {
  it("only contains endpoints that were really verified, with real URLs", () => {
    for (const p of MEDIA_PROVIDERS) {
      assert.match(p.endpoint, /^https:\/\//, `${p.key} must be a real https endpoint`);
      assert.ok(p.note.length > 20, `${p.key} must carry an honest note`);
    }
    assert.equal(mediaProviderFor("text2image")?.endpoint.includes("ai.api.nvidia.com"), true);
  });

  it("covers every capability the production pipeline needs", () => {
    for (const cap of MEDIA_CAPABILITIES) {
      assert.notEqual(mediaProviderFor(cap), null, `no provider registered for ${cap}`);
    }
  });

  it("records the trial tier honestly instead of promising free production use", () => {
    for (const p of MEDIA_PROVIDERS) assert.equal(p.tier, "trial");
    assert.match(mediaProviderFor("text2image")?.note ?? "", /no fixed quota|throttle/i);
  });

  it("returns null for an unknown capability rather than guessing", () => {
    assert.equal(mediaProviderFor("text2video" as never), null);
  });
});

describe("buildCosmosRequest", () => {
  it("builds the documented text2image payload", () => {
    const body = buildCosmosRequest("text2image", { prompt: "  a calligrapher's studio at dawn  " });
    assert.deepEqual(body, { model_mode: "text2image", prompt: "a calligrapher's studio at dawn", resolution: "720_1_1" });
  });

  it("builds the documented image2video payload, including the source image", () => {
    const body = buildCosmosRequest("image2video", { prompt: "ink spreads across the page", imageDataUri: "data:image/jpeg;base64,AAA" });
    assert.equal(body.model_mode, "image2video");
    assert.equal(body.input_reference, "data:image/jpeg;base64,AAA");
    assert.equal(body.resolution, "480_16_9");
    assert.equal(body.num_frames, 49);
    assert.equal(body.fps, 24);
  });
});

describe("buildTtsFields", () => {
  it("maps to the documented multipart fields and omits optional ones", () => {
    assert.deepEqual(buildTtsFields({ text: "Hello." }), { text: "Hello.", language: "en-US" });
    assert.deepEqual(buildTtsFields({ text: "Hello.", voice: "en-US-Female1", sampleRateHz: 22050 }), {
      text: "Hello.",
      language: "en-US",
      voice: "en-US-Female1",
      sample_rate_hz: "22050",
    });
  });
});

describe("parseCosmosResponse", () => {
  it("reads b64_image for text2image", () => {
    assert.deepEqual(parseCosmosResponse({ b64_image: "AAA" }, "text2image"), { ok: true, base64: "AAA" });
  });

  it("reads b64_video for image2video", () => {
    assert.deepEqual(parseCosmosResponse({ b64_video: "BBB" }, "image2video"), { ok: true, base64: "BBB" });
  });

  it("never turns a failed response into an empty success", () => {
    const r = parseCosmosResponse({ error: "rate limited" }, "text2image");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /no b64_image/);
    assert.match(r.error, /rate limited/);
  });

  it("surfaces what the endpoint actually returned when the shape is unexpected", () => {
    const r = parseCosmosResponse({ b64_image: "" }, "text2image");
    assert.equal(r.ok, false);
  });
});

describe("looksLikeWav", () => {
  it("accepts real RIFF/WAVE bytes", () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    assert.equal(looksLikeWav(wav), true);
  });

  it("rejects anything else, including an HTML error page", () => {
    assert.equal(looksLikeWav(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c])), false);
    assert.equal(looksLikeWav(new Uint8Array(4)), false);
  });
});

describe("toImageDataUri", () => {
  it("accepts raw base64 or an existing data URI without double-prefixing", () => {
    assert.equal(toImageDataUri("AAA"), "data:image/jpeg;base64,AAA");
    assert.equal(toImageDataUri("data:image/png;base64,BBB", "image/png"), "data:image/png;base64,BBB");
  });
});
