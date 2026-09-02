import { callProvider, extractResponseText, type ProviderEndpoint } from "./provider-api.ts";

export type { ProviderEndpoint } from "./provider-api.ts";

export type CheckStatus = "PASS" | "FAIL" | "SKIP";

export type CheckResult = {
  name: string;
  status: CheckStatus;
  message: string;
  durationMs: number | undefined;
};

export type ProviderCheckResult = {
  status: "PASS" | "WARNING" | "FAIL";
  checks: readonly CheckResult[];
};

type ApiResponse = {
  status: number;
  body: Record<string, unknown>;
};

function isAuthError(res: ApiResponse): boolean {
  return res.status === 401 || res.status === 403;
}

function extractToolCall(res: ApiResponse, api: string | undefined): { name: string } | null {
  if (api === "openai-completions" || api === "openai-responses") {
    const choices = (res.body as {
      choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string } }> } }>;
    }).choices;
    const call = choices?.[0]?.message?.tool_calls?.[0];
    return call?.function?.name ? { name: call.function.name } : null;
  }
  const content = (res.body as { content?: Array<{ type: string; name?: string }> }).content;
  if (!Array.isArray(content)) return null;
  const toolBlock = content.find((b) => b.type === "toolCall" || b.type === "tool_use");
  return toolBlock ? { name: toolBlock.name ?? "unknown" } : null;
}

export async function checkProvider(endpoint: ProviderEndpoint): Promise<ProviderCheckResult> {
  const checks: CheckResult[] = [];
  let shouldContinue = true;

  const t0 = Date.now();

  // --- Step 1+2+3 combined: auth + model + completion in one minimal request ---
  let authOk = false;
  let modelOk = false;
  let completionOk = false;

  try {
    const res = await callProvider(endpoint, {
      model: endpoint.modelId,
      max_tokens: 30,
      messages: [{ role: "user", content: [{ type: "text", text: "Say exactly: ok" }] }],
    });

    if (isAuthError(res)) {
      checks.push({
        name: "api_auth", status: "FAIL",
        message: `authentication failed (HTTP ${res.status}): ${JSON.stringify(res.body).slice(0, 200)}`,
        durationMs: Date.now() - t0,
      });
      shouldContinue = false;
    } else {
      authOk = true;
      checks.push({
        name: "api_auth", status: "PASS",
        message: `authenticated successfully (HTTP ${res.status})`,
        durationMs: Date.now() - t0,
      });

      if (res.status === 404 || JSON.stringify(res.body).includes("model")) {
        const errStr = JSON.stringify(res.body).toLowerCase();
        if (errStr.includes("model") && (errStr.includes("not found") || errStr.includes("invalid"))) {
          checks.push({
            name: "model_available", status: "FAIL",
            message: `model '${endpoint.modelId}' not found on provider`,
            durationMs: undefined,
          });
          shouldContinue = false;
        } else {
          modelOk = true;
          checks.push({
            name: "model_available", status: "PASS",
            message: `model '${endpoint.modelId}' accepted`,
            durationMs: undefined,
          });
        }
      } else {
        modelOk = true;
        checks.push({
          name: "model_available", status: "PASS",
          message: `model '${endpoint.modelId}' accepted`,
          durationMs: undefined,
        });
      }

      if (shouldContinue && res.status < 400) {
        const text = extractResponseText(res, endpoint.api);
        if (text.length > 0) {
          completionOk = true;
          checks.push({
            name: "basic_completion", status: "PASS",
            message: `received response (${text.length} chars)`,
            durationMs: undefined,
          });
        } else {
          checks.push({
            name: "basic_completion", status: "FAIL",
            message: `response has no text content`,
            durationMs: undefined,
          });
          shouldContinue = false;
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      name: "api_auth", status: "FAIL",
      message: `connection failed: ${msg}`,
      durationMs: Date.now() - t0,
    });
    shouldContinue = false;
  }

  // --- Step 4: Tool calling ---
  if (!shouldContinue) {
    for (const name of ["tool_calling", "structured_plan"]) {
      checks.push({ name, status: "SKIP", message: "skipped due to earlier failure", durationMs: undefined });
    }
  } else {
    const t4 = Date.now();
    try {
      const tools = [{
        name: "write_file",
        description: "Write a file to disk",
        input_schema: {
          type: "object" as const,
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      }];

      const res = await callProvider(endpoint, {
        model: endpoint.modelId,
        max_tokens: 200,
        tools,
        messages: [{
          role: "user",
          content: [{ type: "text", text: "Use the write_file tool to create a file at /tmp/test.txt with content 'hello'." }],
        }],
      });

      if (res.status >= 400) {
        checks.push({
          name: "tool_calling", status: "FAIL",
          message: `API returned error during tool test (HTTP ${res.status}): ${JSON.stringify(res.body).slice(0, 150)}`,
          durationMs: Date.now() - t4,
        });
      } else {
        const tc = extractToolCall(res, endpoint.api);
        if (tc) {
          checks.push({
            name: "tool_calling", status: "PASS",
            message: `model invoked tool '${tc.name}'`,
            durationMs: Date.now() - t4,
          });
        } else {
          checks.push({
            name: "tool_calling", status: "FAIL",
            message: `model responded without tool call (may not support function calling)`,
            durationMs: Date.now() - t4,
          });
        }
      }
    } catch (err) {
      checks.push({
        name: "tool_calling", status: "FAIL",
        message: `error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - t4,
      });
    }

    // --- Step 5: Structured plan output ---
    const t5 = Date.now();
    try {
      const planPrompt =
        'Output a JSON object with key "suggestedSteps" whose value is an array. ' +
        'Each element has "intent" (string) and "successCriteria" (array). ' +
        "For example: {\"understanding\":\"test\",\"suggestedSteps\":[{\"intent\":\"create hello.txt\",\"successCriteria\":[{\"kind\":\"file_exists\",\"path\":\"hello.txt\"}]}]}. " +
        "Output ONLY the JSON object, no other text.";

      const res = await callProvider(endpoint, {
        model: endpoint.modelId,
        max_tokens: 300,
        messages: [{ role: "user", content: [{ type: "text", text: planPrompt }] }],
      });

      if (res.status >= 400) {
        checks.push({
          name: "structured_plan", status: "FAIL",
          message: `API error (HTTP ${res.status})`,
          durationMs: Date.now() - t5,
        });
      } else {
        const text = extractResponseText(res, endpoint.api);
        try {
          const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
          const candidate = jsonMatch[1] ?? text;
          const parsed = JSON.parse(candidate.trim());
          if (parsed.suggestedSteps && Array.isArray(parsed.suggestedSteps)) {
            checks.push({
              name: "structured_plan", status: "PASS",
              message: `model produced valid plan JSON with ${parsed.suggestedSteps.length} step(s)`,
              durationMs: Date.now() - t5,
            });
          } else {
            checks.push({
              name: "structured_plan", status: "WARNING" as CheckStatus,
              message: "JSON parsed but missing suggestedSteps array",
              durationMs: Date.now() - t5,
            });
          }
        } catch {
          checks.push({
            name: "structured_plan", status: "FAIL",
            message: `model output is not valid JSON`,
            durationMs: Date.now() - t5,
          });
        }
      }
    } catch (err) {
      checks.push({
        name: "structured_plan", status: "FAIL",
        message: `error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - t5,
      });
    }
  }

  void completionOk;

  const hasFail = checks.some((c) => c.status === "FAIL");
  const hasWarn = checks.some((c) => (c.status as string) === "WARNING");
  const overall = hasFail ? "FAIL" : hasWarn ? "WARNING" : "PASS";

  void authOk;
  void modelOk;

  return { status: overall, checks };
}
