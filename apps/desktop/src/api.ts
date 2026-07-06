import type {
  AssistantSettings,
  HealthResponse,
  ModelInfo,
  StoredMessage,
  TranscriptResponse,
} from "./types";

export const DEFAULT_API_BASE = "";

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return body.detail || body.message || response.statusText;
  } catch {
    return response.statusText;
  }
}

export async function requestJson<T>(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.json() as Promise<T>;
}

export function getHealth(apiBase: string): Promise<HealthResponse> {
  return requestJson<HealthResponse>(apiBase, "/health");
}

export function getSettings(apiBase: string): Promise<AssistantSettings> {
  return requestJson<AssistantSettings>(apiBase, "/api/settings");
}

export function saveSettings(
  apiBase: string,
  settings: AssistantSettings,
): Promise<AssistantSettings> {
  return requestJson<AssistantSettings>(apiBase, "/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function getModels(apiBase: string): Promise<ModelInfo[]> {
  return requestJson<ModelInfo[]>(apiBase, "/api/llm/models");
}

export function getHistory(apiBase: string, sessionId: string): Promise<StoredMessage[]> {
  return requestJson<StoredMessage[]>(apiBase, `/api/history/${encodeURIComponent(sessionId)}`);
}

export function clearHistory(apiBase: string, sessionId: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(apiBase, `/api/history/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export async function transcribeAudio(
  apiBase: string,
  blob: Blob,
): Promise<TranscriptResponse> {
  const formData = new FormData();
  const extension = blob.type.includes("wav") ? "wav" : "webm";
  formData.append("file", blob, `input.${extension}`);
  const response = await fetch(`${apiBase}/api/stt/transcribe`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.json() as Promise<TranscriptResponse>;
}

export async function synthesizeSpeech(
  apiBase: string,
  text: string,
  settings: AssistantSettings,
): Promise<Blob> {
  const response = await fetch(`${apiBase}/api/tts/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      provider: settings.tts_provider,
      voicevox_speaker: settings.voicevox_speaker,
    }),
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.blob();
}
