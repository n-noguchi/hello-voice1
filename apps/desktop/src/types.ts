export type Phase =
  | "standby"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

export type Role = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  pending?: boolean;
  error?: boolean;
}

export interface AssistantSettings {
  ollama_base_url: string;
  llm_model: string | null;
  system_prompt: string;
  temperature: number;
  max_context_messages: number;
  stt_provider: "faster_whisper" | "none";
  stt_model: string;
  stt_language: string;
  stt_device: "auto" | "cpu" | "cuda";
  stt_compute_type: string;
  tts_provider: "voicevox" | "piper" | "none";
  voicevox_base_url: string;
  voicevox_speaker: number;
  piper_executable: string;
  piper_model_path: string | null;
}

export interface HealthResponse {
  ok: boolean;
  ollama: boolean;
  voicevox: boolean;
  data_dir: string;
  settings: AssistantSettings;
}

export interface ModelInfo {
  name: string;
  size?: number | null;
  modified_at?: string | null;
}

export interface StoredMessage {
  id: number;
  session_id: string;
  role: Role;
  content: string;
  created_at: string;
}

export interface TranscriptResponse {
  text: string;
  language?: string | null;
  duration?: number | null;
  segments: Array<{ start: number; end: number; text: string }>;
}

export interface StreamEvent {
  type: string;
  token?: string;
  text?: string;
  message?: string;
}
