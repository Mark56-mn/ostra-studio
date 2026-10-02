// scripts/kaggle-model-benchmark.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_BENCHMARK_MODELS, buildBenchmarkNotebook, rosterModels } from "./kaggle-model-benchmark.js";

function cellText(cell: { source: string[] | string }): string {
  return Array.isArray(cell.source) ? cell.source.join("") : String(cell.source);
}

describe("buildBenchmarkNotebook", () => {
  it("measures every candidate on the real device and writes the real numbers", () => {
    const nb = buildBenchmarkNotebook(DEFAULT_BENCHMARK_MODELS);
    const text = nb.cells.map(cellText).join("\n");
    for (const model of DEFAULT_BENCHMARK_MODELS) {
      assert.ok(text.includes(model), `candidate ${model} must appear`);
    }
    assert.match(text, /torch\.cuda\.max_memory_allocated/);
    assert.match(text, /tokens_per_second/);
    assert.match(text, /load_seconds/);
    assert.match(text, /ostra-model-benchmark\.json/);
    assert.match(text, /no CUDA device/);
  });

  it("never fabricates a time-to-first-token it cannot measure", () => {
    const text = buildBenchmarkNotebook(DEFAULT_BENCHMARK_MODELS).cells.map(cellText).join("\n");
    assert.doesNotMatch(text, /time_to_first_token/);
  });

  it("carries a kernelspec and cell ids, without which Papermill aborts the run", () => {
    const nb = buildBenchmarkNotebook(DEFAULT_BENCHMARK_MODELS);
    assert.equal(nb.metadata.kernelspec.name, "python3");
    assert.equal(nb.nbformat, 4);
    assert.ok(nb.cells.every((c) => typeof c.id === "string" && c.id.length > 0));
  });

  it("keeps the candidate list injectable via --model", () => {
    const nb = buildBenchmarkNotebook(["Qwen/Qwen3-4B"]);
    const text = nb.cells.map(cellText).join("\n");
    assert.match(text, /MODELS = \["Qwen\/Qwen3-4B"\]/);
    assert.ok(!text.includes("Qwen/Qwen3-1.7B"));
  });
});

describe("rosterModels", () => {
  it("dedupes the roster's models into the benchmark shortlist", () => {
    assert.deepEqual(rosterModels(), ["Qwen/Qwen3-4B"]);
  });
});
