// Quick NVIDIA NIM chat endpoint tester
const KEY = "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";

const candidates = [
  { base: "https://integrate.api.nvidia.com/v1", model: "nvidia/llama-3.1-nemotron-ultra-253b-v1" },
  { base: "https://integrate.api.nvidia.com/v1", model: "nvidia/llama-3.3-nemotron-super-49b-v1" },
  { base: "https://integrate.api.nvidia.com/v1", model: "nvdev/c...) " },
];

async function test(base, model) {
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: "say hi in 3 words" }],
    max_tokens: 50,
  });
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      },
      body,
    });
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, model, base, data: parsed };
  } catch (e) {
    return { ok: false, error: String(e), model, base };
  }
}

// Try a bunch of likely model ids on the integrate endpoint
const modelIds = [
  "nvidia/llama-3.1-nemotron-ultra-253b-v1",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
  "nvidia/llama-3.1-nemotron-nano-8b-v1",
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/mistral-nemo-12b-instruct",
  "nvidia/qwen2.5-7b-instruct",
];

const base = "https://integrate.api.nvidia.com/v1";
for (const m of modelIds) {
  const r = await test(base, m);
  console.log("==", m);
  console.log(JSON.stringify(r, null, 2).slice(0, 800));
  console.log("");
}
