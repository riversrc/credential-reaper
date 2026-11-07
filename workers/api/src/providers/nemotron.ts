import type { NemotronInvestigationInput, NemotronInvestigationOutput, NemotronProvider } from '@credential-reaper/shared';

const NVIDIA_CHAT_COMPLETIONS_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

const SYSTEM_PROMPT = `You are a machine identity security investigator. Given metadata about a
machine identity (service account, API key, certificate, etc.), identify
ownership, dormancy, and over-permissioning risks. Respond with ONLY a JSON
object matching this shape, no prose, no markdown fences:
{
  "findings": [{ "category": string, "severity": "critical"|"high"|"medium"|"low"|"info", "description": string, "evidence": string }],
  "summary": string,
  "recommendedAction": "retire"|"rotate"|"migrate"|"monitor"|"no-action"
}`;

function buildUserPrompt(input: NemotronInvestigationInput): string {
  return JSON.stringify(input, null, 2);
}

/**
 * Real NVIDIA Nemotron provider via the OpenAI-compatible NVIDIA Build API
 * (https://integrate.api.nvidia.com/v1/chat/completions). Requires
 * NVIDIA_API_KEY to be set as a Worker secret; never exposed to the browser.
 */
export function createNemotronProvider(apiKey: string, model: string): NemotronProvider {
  return {
    name: 'nemotron',
    async investigate(input: NemotronInvestigationInput): Promise<NemotronInvestigationOutput> {
      const response = await fetch(NVIDIA_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(input) },
          ],
          temperature: 0.2,
        }),
      });

      if (!response.ok) {
        throw new Error(`Nemotron API request failed: ${response.status} ${await response.text()}`);
      }

      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('Nemotron API returned an empty response');
      }

      const parsed = JSON.parse(content) as Omit<NemotronInvestigationOutput, 'findings'> & {
        findings: Omit<NemotronInvestigationOutput['findings'][number], 'id'>[];
      };

      return {
        ...parsed,
        findings: parsed.findings.map((f) => ({ ...f, id: crypto.randomUUID() })),
      };
    },
  };
}
