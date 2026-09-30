// scripts/kaggle-agent-notebook.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  AGENT_NOTEBOOK_KINDS,
  agentKernelSlug,
  buildAgentNotebook,
  renderAgentBootstrap,
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
    assert.match(voice, /NGROK_AUTHTOKEN_VOICE/);
    const image = buildAgentNotebook("image", template).cells.map(cellText).join("\n");
    assert.match(image, /NGROK_AUTHTOKEN_IMAGE/);
  });
});
