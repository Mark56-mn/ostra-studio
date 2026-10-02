// scripts/kaggle-agent-notebook.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  AGENT_NOTEBOOK_KINDS,
  agentKernelSlug,
  buildAgentNotebook,
  probeAccount,
  renderAgentBootstrap,
  tunnelCell,
} from "./kaggle-agent-notebook.js";

const template = readFileSync(new URL("./kaggle-agent-bootstrap.py", import.meta.url), "utf8");

function cellText(cell: { source: string[] | string }): string {
  return Array.isArray(cell.source) ? cell.source.join("") : String(cell.source);
}

describe("renderAgentBootstrap", () => {
  it("substitutes exactly the identity line and nothing else", () => {
    const out = renderAgentBootstrap(template, "voice");
    assert.match(out, /^OSTRA_AGENT = "voice"$/m);
    assert.doesNotMatch(out, /^OSTRA_AGENT = "image"$/m);
    // The rest of the canonical bootstrap is untouched, so behaviour cannot drift per agent.
    assert.equal(out.length, template.length - "\"image\"".length + "\"voice\"".length);
  });

  it("refuses a template whose identity line is missing rather than shipping the wrong role", () => {
    assert.throws(() => renderAgentBootstrap("no identity here", "image"));
  });
});

describe("agentKernelSlug", () => {
  it("names each agent kernel distinctly", () => {
    const slugs = AGENT_NOTEBOOK_KINDS.map(agentKernelSlug);
    assert.deepEqual(new Set(slugs).size, slugs.length);
    assert.equal(agentKernelSlug("image"), "ostra-image-agent");
    // The deployed showrunner notebook is ostra-showrunner-agent; a different slug would 409.
    assert.equal(agentKernelSlug("overseer"), "ostra-showrunner-agent");
  });
});

describe("buildAgentNotebook", () => {
  it("ends with a bootstrap cell carrying this agent's identity", () => {
    for (const agent of AGENT_NOTEBOOK_KINDS) {
      const nb = buildAgentNotebook(agent, template);
      const last = cellText(nb.cells[nb.cells.length - 1]);
      assert.match(last, new RegExp(`^OSTRA_AGENT = "${agent}"$`, "m"));
      assert.match(last, /Ostra Studio agent worker bootstrap/);
    }
  });

  it("serves the OpenAI-compatible chat contract the backend calls", () => {
    const nb = buildAgentNotebook("image", template);
    const server = nb.cells.map(cellText).find((s) => s.includes("uvicorn.run"));
    assert.ok(server, "a server cell must exist");
    assert.match(server!, /\/v1\/chat\/completions/);
    assert.match(server!, /\/health/);
    assert.match(server!, /apply_chat_template/);
    assert.match(server!, /"agent": "image"/);
  });

  it("publishes a tunnel and waits for the local server without aborting", () => {
    const text = buildAgentNotebook("voice", template).cells.map(cellText).join("\n");
    assert.match(text, /ngrok\.connect\(8000\)/);
    assert.match(text, /127\.0\.0\.1:8000\/health/);
    assert.match(text, /never raises/);
  });

  it("carries a kernelspec and cell ids, without which Papermill aborts the run", () => {
    const nb = buildAgentNotebook("image", template);
    assert.equal(nb.metadata.kernelspec.name, "python3");
    assert.equal(nb.metadata.kernelspec.language, "python");
    assert.equal(nb.nbformat, 4);
    assert.ok(nb.cells.every((c) => typeof c.id === "string" && c.id.length > 0));
  });

  it("lets each agent use its own ngrok token, falling back to the shared one", () => {
    const voice = buildAgentNotebook("voice", template).cells.map(cellText).join("\n");
    assert.match(voice, /NGROK_AUTHTOKEN_VOICE/);
    assert.match(voice, /NGROK_AUTHTOKEN"/);
    const image = buildAgentNotebook("image", template).cells.map(cellText).join("\n");
    assert.match(image, /NGROK_AUTHTOKEN_IMAGE/);
  });

  it("reports WHICH secret lookup failed, since 'wrong label' and 'not attached' need different fixes", () => {
    const cell = tunnelCell("voice");
    assert.match(cell, /ngrok token read from Kaggle secret/);
    assert.match(cell, /__ostra_secret_probe__/);
    // Kaggle's log API truncates long lines, so the diagnosis must be split across short prints.
    assert.match(cell, /\[ostra\] {3}tried /);
    assert.doesNotMatch(cell, /per-label/);
    assert.match(cell, /secrets must be ATTACHED, not just created/);
  });

  it("picks the strongest model the GPU can serve, with an OSTRA_MODEL secret override", () => {
    const text = buildAgentNotebook("script", template).cells.map(cellText).join("\n");
    assert.match(text, /OSTRA_MODEL/);
    assert.match(text, /OSTRA_MODEL_DEFAULT/);
    assert.match(text, /Qwen\/Qwen3-4B/);
    assert.match(text, /Qwen\/Qwen3-1\.7B/);
    // 14.0, not 15.0: Kaggle's T4 reports 14.6 GiB, so a 15.0 gate would never pick 4B there.
    assert.match(text, /_VRAM_GIB >= 14\.0/);
  });

  it("registers the model actually booted, never a hardcoded one", () => {
    for (const agent of AGENT_NOTEBOOK_KINDS) {
      const nb = buildAgentNotebook(agent, template);
      const last = cellText(nb.cells[nb.cells.length - 1]);
      assert.match(last, /"model": \(globals\(\)\.get\("MODEL_ID"\)/);
      // The old intent-based chain claimed its default even when the runtime booted something else.
      assert.doesNotMatch(last, /"model": \(_secret\("OSTRA_MODEL"\)/);
    }
  });
});

describe("probeAccount", () => {
  type Route = { match: RegExp; status: number; body: unknown };
  function withFetch(routes: Route[], fn: () => Promise<void>): Promise<void> {
    const original = globalThis.fetch;
    globalThis.fetch = ((url: string | URL | Request) => {
      const target = String(url);
      const matched = routes.find((r) => r.match.test(target));
      const body = matched ? matched.body : { message: "unexpected url" };
      const status = matched ? matched.status : 500;
      return Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
    }) as typeof fetch;
    return fn().finally(() => {
      globalThis.fetch = original;
    });
  }

  it("reads the owner from a profile kernel ref", async () => {
    await withFetch([{ match: /kernels\/list/u, status: 200, body: [{ ref: "bettertrade/ostra-voice-agent" }] }], async () => {
      const r = await probeAccount("Basic dXNlcjprZXk=");
      assert.equal(r.authenticated, true);
      assert.equal(r.owner, "bettertrade");
      assert.equal(r.error, null);
    });
  });

  it("treats a valid but completely empty account as authenticated with no owner", async () => {
    await withFetch(
      [
        { match: /kernels\/list/u, status: 200, body: [] },
        { match: /datasets\/list/u, status: 200, body: [] },
        { match: /models\/list/u, status: 200, body: [] },
      ],
      async () => {
        const r = await probeAccount("Basic dXNlcjprZXk=");
        assert.equal(r.authenticated, true, "200s mean the token is valid");
        assert.equal(r.owner, null);
        assert.equal(r.error, null);
      }
    );
  });

  it("reports a rejected token as unauthenticated instead of guessing", async () => {
    await withFetch([{ match: /kernels\/list/u, status: 401, body: { code: 401, message: "Unauthenticated" } }], async () => {
      const r = await probeAccount("Basic bm9ib2R5Om5vdGFrZXk=");
      assert.equal(r.authenticated, false);
      assert.match(String(r.error), /401/);
    });
  });

  it("falls through to datasets when the account owns no kernels", async () => {
    await withFetch(
      [
        { match: /kernels\/list/u, status: 200, body: [] },
        { match: /datasets\/list/u, status: 200, body: [{ ref: "secondaccount/some-dataset" }] },
      ],
      async () => {
        const r = await probeAccount("Basic dXNlcjprZXk=");
        assert.equal(r.owner, "secondaccount");
      }
    );
  });
});
