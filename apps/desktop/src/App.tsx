import {
  Bot,
  CheckCircle2,
  CircleAlert,
  Loader2,
  Mic,
  RefreshCw,
  Send,
  Settings,
  SlidersHorizontal,
  Square,
  Trash2,
  User,
  Volume2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_API_BASE,
  clearHistory,
  getHealth,
  getHistory,
  getModels,
  getSettings,
  saveSettings,
  synthesizeSpeech,
  transcribeAudio,
} from "./api";
import type {
  AssistantSettings,
  ChatMessage,
  HealthResponse,
  ModelInfo,
  Phase,
  StreamEvent,
} from "./types";

const defaultSettings: AssistantSettings = {
  ollama_base_url: "http://127.0.0.1:11434",
  llm_model: null,
  system_prompt:
    "あなたはローカルで動作する音声アシスタントです。簡潔で自然な日本語で答えてください。",
  temperature: 0.7,
  max_context_messages: 16,
  stt_provider: "faster_whisper",
  stt_model: "small",
  stt_language: "ja",
  stt_device: "auto",
  stt_compute_type: "int8",
  tts_provider: "voicevox",
  voicevox_base_url: "http://127.0.0.1:50021",
  voicevox_speaker: 1,
  piper_executable: "piper",
  piper_model_path: null,
};

const phaseLabel: Record<Phase, string> = {
  standby: "待機中",
  listening: "聞き取り中",
  transcribing: "認識中",
  thinking: "生成中",
  speaking: "発話中",
  error: "エラー",
};

interface AudioInputDevice {
  deviceId: string;
  label: string;
}

function createId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();

  if (cryptoObject?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoObject.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
      16,
      20,
    )}-${hex.slice(20)}`;
  }

  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getSessionId(): string {
  const existing = localStorage.getItem("helloVoice.sessionId");
  if (existing) return existing;
  const created = createId();
  localStorage.setItem("helloVoice.sessionId", created);
  return created;
}

function messageId(): string {
  return createId();
}

function mergeAssistantToken(messages: ChatMessage[], id: string, token: string): ChatMessage[] {
  return messages.map((message) =>
    message.id === id
      ? { ...message, content: `${message.content}${token}`, pending: true }
      : message,
  );
}

export function App() {
  const [apiBase, setApiBase] = useState(
    () => localStorage.getItem("helloVoice.apiBase") || DEFAULT_API_BASE,
  );
  const [sessionId] = useState(getSessionId);
  const [settings, setSettings] = useState<AssistantSettings>(defaultSettings);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [phase, setPhase] = useState<Phase>("standby");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [audioInputs, setAudioInputs] = useState<AudioInputDevice[]>([]);
  const [audioDeviceId, setAudioDeviceId] = useState(
    () => localStorage.getItem("helloVoice.audioDeviceId") || "",
  );
  const [recordingLevel, setRecordingLevel] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserFrameRef = useRef<number | null>(null);
  const maxRecordingLevelRef = useRef(0);

  const selectedModel = settings.llm_model || models[0]?.name || "";
  const busy = phase === "thinking" || phase === "speaking" || phase === "transcribing";
  const recording = phase === "listening";
  const voicevoxUnavailable =
    settings.tts_provider === "voicevox" && health?.voicevox === false;

  const appendError = useCallback((message: string) => {
    setError(message);
    setPhase("error");
    setMessages((current) => [
      ...current,
      { id: messageId(), role: "assistant", content: message, error: true },
    ]);
  }, []);

  const refreshAudioInputs = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `マイク ${index + 1}`,
      }));
    setAudioInputs(inputs);
    if (audioDeviceId && !inputs.some((device) => device.deviceId === audioDeviceId)) {
      setAudioDeviceId("");
      localStorage.removeItem("helloVoice.audioDeviceId");
    }
  }, [audioDeviceId]);

  const stopLevelMonitor = useCallback(() => {
    if (analyserFrameRef.current !== null) {
      cancelAnimationFrame(analyserFrameRef.current);
      analyserFrameRef.current = null;
    }
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    setRecordingLevel(0);
  }, []);

  const startLevelMonitor = useCallback(
    (stream: MediaStream) => {
      stopLevelMonitor();
      const audioContextConstructor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!audioContextConstructor) return;

      const audioContext = new audioContextConstructor();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      audioContextRef.current = audioContext;
      const buffer = new Uint8Array(analyser.fftSize);

      const tick = () => {
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (const value of buffer) {
          const centered = (value - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / buffer.length);
        const level = Math.min(1, rms * 6);
        maxRecordingLevelRef.current = Math.max(maxRecordingLevelRef.current, level);
        setRecordingLevel(level);
        analyserFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
    },
    [stopLevelMonitor],
  );

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [nextHealth, nextSettings, nextModels, history] = await Promise.all([
        getHealth(apiBase),
        getSettings(apiBase),
        getModels(apiBase).catch(() => [] as ModelInfo[]),
        getHistory(apiBase, sessionId).catch(() => []),
      ]);
      setHealth(nextHealth);
      setSettings(nextSettings);
      setModels(nextModels);
      setMessages(
        history
          .filter((item) => item.role !== "system")
          .map((item) => ({
            id: `${item.id}`,
            role: item.role,
            content: item.content,
          })),
      );
      setPhase("standby");
    } catch (err) {
      appendError(err instanceof Error ? err.message : String(err));
    }
  }, [apiBase, appendError, sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    void refreshAudioInputs();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshAudioInputs);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshAudioInputs);
    };
  }, [refreshAudioInputs]);

  useEffect(() => {
    timelineRef.current?.scrollTo({
      top: timelineRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const playSpeech = useCallback(
    async (text: string) => {
      if (!text.trim() || settings.tts_provider === "none") return;
      if (settings.tts_provider === "voicevox" && health?.voicevox === false) {
        setError(
          "VOICEVOX Engineに接続できません。VOICEVOX Engineを起動するか、設定のTTSをnone/Piperに変更してください。",
        );
        setPhase("standby");
        return;
      }
      setPhase("speaking");
      try {
        const blob = await synthesizeSpeech(apiBase, text, settings);
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;
        await new Promise<void>((resolve, reject) => {
          audio.onended = () => resolve();
          audio.onerror = () => reject(new Error("音声再生に失敗しました。"));
          audio.play().catch(reject);
        });
        URL.revokeObjectURL(url);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        audioRef.current = null;
      }
    },
    [apiBase, health?.voicevox, settings],
  );

  const sendText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setInput("");
      setError(null);
      setPhase("thinking");

      const userMessage: ChatMessage = { id: messageId(), role: "user", content: trimmed };
      const assistantId = messageId();
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        pending: true,
      };
      setMessages((current) => [...current, userMessage, assistantMessage]);

      const controller = new AbortController();
      abortRef.current = controller;
      let finalText = "";

      try {
        const response = await fetch(`${apiBase}/api/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            text: trimmed,
            session_id: sessionId,
            model: selectedModel || null,
            speak: settings.tts_provider !== "none",
          }),
        });
        if (!response.ok || !response.body) {
          throw new Error(response.statusText || "応答生成に失敗しました。");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as StreamEvent;
            if (event.type === "llm.token" && event.token) {
              finalText += event.token;
              setMessages((current) => mergeAssistantToken(current, assistantId, event.token || ""));
            }
            if (event.type === "llm.done") {
              finalText = event.text || finalText;
              setMessages((current) =>
                current.map((message) =>
                  message.id === assistantId
                    ? { ...message, content: finalText, pending: false }
                    : message,
                ),
              );
            }
            if (event.type === "error") {
              throw new Error(event.message || "応答生成に失敗しました。");
            }
          }
        }

        await playSpeech(finalText);
        setPhase("standby");
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId ? { ...message, pending: false } : message,
            ),
          );
          setPhase("standby");
          return;
        }
        appendError(err instanceof Error ? err.message : String(err));
      } finally {
        abortRef.current = null;
      }
    },
    [apiBase, appendError, busy, playSpeech, selectedModel, sessionId, settings.tts_provider],
  );

  const stopActive = useCallback(() => {
    abortRef.current?.abort();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    stopLevelMonitor();
    setPhase("standby");
  }, [stopLevelMonitor]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (busy || recording) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      appendError(
        window.isSecureContext
          ? "このブラウザでは音声入力APIを利用できません。ChromeまたはEdgeで開いてください。"
          : "音声入力はHTTPSまたはlocalhostで開いた場合だけ利用できます。HTTPのスマートフォンアクセスではテキスト入力を使ってください。",
      );
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      appendError("このブラウザは録音APIに対応していません。ChromeまたはEdgeで開いてください。");
      return;
    }
    try {
      setError(null);
      maxRecordingLevelRef.current = 0;
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (audioDeviceId) {
        audioConstraints.deviceId = { exact: audioDeviceId };
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      void refreshAudioInputs();
      streamRef.current = stream;
      chunksRef.current = [];
      startLevelMonitor(stream);
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        const peakLevel = maxRecordingLevelRef.current;
        stopLevelMonitor();
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        chunksRef.current = [];
        if (!blob.size) {
          setPhase("standby");
          return;
        }
        setPhase("transcribing");
        try {
          const transcript = await transcribeAudio(apiBase, blob);
          const recognizedText = transcript.text.trim();
          if (recognizedText) {
            await sendText(recognizedText);
          } else {
            appendError(
              `音声を認識できませんでした。録音レベルは最大${Math.round(
                peakLevel * 100,
              )}%でした。設定のMicまたはWindows/Chromeの入力マイクを確認してください。`,
            );
          }
        } catch (err) {
          appendError(err instanceof Error ? err.message : String(err));
        }
      };
      recorder.start();
      setPhase("listening");
    } catch (err) {
      appendError(err instanceof Error ? err.message : String(err));
    }
  }, [
    apiBase,
    appendError,
    audioDeviceId,
    busy,
    recording,
    refreshAudioInputs,
    sendText,
    startLevelMonitor,
    stopLevelMonitor,
  ]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void sendText(input);
  };

  const updateSettings = <K extends keyof AssistantSettings>(
    key: K,
    value: AssistantSettings[K],
  ) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const persistSettings = async () => {
    try {
      const saved = await saveSettings(apiBase, settings);
      setSettings(saved);
      localStorage.setItem("helloVoice.apiBase", apiBase);
      await refresh();
    } catch (err) {
      appendError(err instanceof Error ? err.message : String(err));
    }
  };

  const clearConversation = async () => {
    try {
      await clearHistory(apiBase, sessionId);
      setMessages([]);
    } catch (err) {
      appendError(err instanceof Error ? err.message : String(err));
    }
  };

  const statusIcon = useMemo(() => {
    if (phase === "error") return <CircleAlert size={18} />;
    if (phase === "thinking" || phase === "transcribing") {
      return <Loader2 size={18} className="spin" />;
    }
    if (phase === "speaking") return <Volume2 size={18} />;
    if (phase === "listening") return <Mic size={18} />;
    return <CheckCircle2 size={18} />;
  }, [phase]);

  return (
    <main className={`app-shell ${settingsOpen ? "with-settings" : ""}`}>
      <section className="workspace">
        <header className="topbar">
          <div className="brand">
            <Bot size={22} />
            <div>
              <h1>hello-voice1</h1>
              <span className={`status ${phase}`}>{statusIcon}{phaseLabel[phase]}</span>
            </div>
          </div>
          <div className="top-actions">
            <div className="connection" title="Ollama">
              {health?.ollama ? <Wifi size={18} /> : <WifiOff size={18} />}
              <span>Ollama</span>
            </div>
            {settings.tts_provider === "voicevox" && (
              <div className={`connection ${voicevoxUnavailable ? "offline" : ""}`} title="VOICEVOX">
                {health?.voicevox ? <Wifi size={18} /> : <WifiOff size={18} />}
                <span>VOICEVOX</span>
              </div>
            )}
            <select
              className="model-select"
              value={selectedModel}
              onChange={(event) =>
                updateSettings("llm_model", event.target.value || null)
              }
              title="LLMモデル"
            >
              {models.length === 0 && <option value="">モデル未検出</option>}
              {models.map((model) => (
                <option key={model.name} value={model.name}>
                  {model.name}
                </option>
              ))}
            </select>
            <button className="icon-button" type="button" title="更新" onClick={() => void refresh()}>
              <RefreshCw size={18} />
            </button>
            <button
              className="icon-button"
              type="button"
              title="設定"
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <SlidersHorizontal size={18} />
            </button>
          </div>
        </header>

        {error && <div className="error-line">{error}</div>}

        <div className="timeline" ref={timelineRef}>
          {messages.length === 0 && (
            <div className="empty-state">
              <Bot size={30} />
              <span>待機中</span>
            </div>
          )}
          {messages.map((message) => (
            <article
              className={`message ${message.role} ${message.error ? "message-error" : ""}`}
              key={message.id}
            >
              <div className="avatar" aria-hidden="true">
                {message.role === "user" ? <User size={18} /> : <Bot size={18} />}
              </div>
              <p>{message.content || (message.pending ? "..." : "")}</p>
              {message.pending && <Loader2 size={16} className="spin pending-icon" />}
            </article>
          ))}
        </div>

        <form className="composer" onSubmit={submit}>
          <div className="voice-control">
            <button
              className={`round-button ${recording ? "recording" : ""}`}
              type="button"
              title={recording ? "停止" : "録音"}
              onClick={() => (recording ? stopRecording() : void startRecording())}
              disabled={busy && !recording}
            >
              {recording ? <Square size={20} /> : <Mic size={20} />}
            </button>
            <div className="level-meter" title={`入力レベル ${Math.round(recordingLevel * 100)}%`}>
              <span style={{ transform: `scaleX(${recordingLevel})` }} />
            </div>
          </div>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="メッセージ"
            rows={1}
            disabled={busy || recording}
          />
          {busy || recording ? (
            <button className="command-button stop" type="button" onClick={stopActive}>
              <Square size={18} />
              <span>停止</span>
            </button>
          ) : (
            <button className="command-button" type="submit" disabled={!input.trim()}>
              <Send size={18} />
              <span>送信</span>
            </button>
          )}
        </form>
      </section>

      {settingsOpen && (
        <aside className="settings-panel">
          <div className="settings-heading">
            <Settings size={20} />
            <h2>設定</h2>
          </div>

          <label>
            API
            <input
              value={apiBase}
              placeholder="same origin (/api)"
              onChange={(event) => setApiBase(event.target.value)}
            />
          </label>

          <label>
            Ollama
            <input
              value={settings.ollama_base_url}
              onChange={(event) => updateSettings("ollama_base_url", event.target.value)}
            />
          </label>

          <label>
            System
            <textarea
              value={settings.system_prompt}
              rows={4}
              onChange={(event) => updateSettings("system_prompt", event.target.value)}
            />
          </label>

          <div className="field-row">
            <label>
              Temperature
              <input
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={settings.temperature}
                onChange={(event) =>
                  updateSettings("temperature", Number(event.target.value))
                }
              />
            </label>
            <label>
              Context
              <input
                type="number"
                min="2"
                max="80"
                value={settings.max_context_messages}
                onChange={(event) =>
                  updateSettings("max_context_messages", Number(event.target.value))
                }
              />
            </label>
          </div>

          <div className="field-row">
            <label>
              STT
              <select
                value={settings.stt_provider}
                onChange={(event) =>
                  updateSettings(
                    "stt_provider",
                    event.target.value as AssistantSettings["stt_provider"],
                  )
                }
              >
                <option value="faster_whisper">faster-whisper</option>
                <option value="none">none</option>
              </select>
            </label>
            <label>
              Lang
              <input
                value={settings.stt_language}
                onChange={(event) => updateSettings("stt_language", event.target.value)}
              />
            </label>
          </div>

          <div className="mic-picker">
            <label>
              Mic
              <select
                value={audioDeviceId}
                onChange={(event) => {
                  setAudioDeviceId(event.target.value);
                  if (event.target.value) {
                    localStorage.setItem("helloVoice.audioDeviceId", event.target.value);
                  } else {
                    localStorage.removeItem("helloVoice.audioDeviceId");
                  }
                }}
              >
                <option value="">既定のマイク</option>
                {audioInputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="icon-button"
              type="button"
              title="マイク一覧更新"
              onClick={() => void refreshAudioInputs()}
            >
              <RefreshCw size={18} />
            </button>
          </div>

          <div className="field-row">
            <label>
              STT Model
              <input
                value={settings.stt_model}
                onChange={(event) => updateSettings("stt_model", event.target.value)}
              />
            </label>
            <label>
              Device
              <select
                value={settings.stt_device}
                onChange={(event) =>
                  updateSettings(
                    "stt_device",
                    event.target.value as AssistantSettings["stt_device"],
                  )
                }
              >
                <option value="auto">auto</option>
                <option value="cpu">cpu</option>
                <option value="cuda">cuda</option>
              </select>
            </label>
          </div>

          <div className="field-row">
            <label>
              TTS
              <select
                value={settings.tts_provider}
                onChange={(event) =>
                  updateSettings(
                    "tts_provider",
                    event.target.value as AssistantSettings["tts_provider"],
                  )
                }
              >
                <option value="voicevox">VOICEVOX</option>
                <option value="piper">Piper</option>
                <option value="none">none</option>
              </select>
            </label>
            <label>
              Speaker
              <input
                type="number"
                min="0"
                value={settings.voicevox_speaker}
                onChange={(event) =>
                  updateSettings("voicevox_speaker", Number(event.target.value))
                }
              />
            </label>
          </div>

          <label>
            VOICEVOX
            <input
              value={settings.voicevox_base_url}
              onChange={(event) => updateSettings("voicevox_base_url", event.target.value)}
            />
          </label>

          <label>
            Piper model
            <input
              value={settings.piper_model_path || ""}
              onChange={(event) =>
                updateSettings("piper_model_path", event.target.value || null)
              }
            />
          </label>

          <div className="settings-actions">
            <button className="command-button" type="button" onClick={persistSettings}>
              <CheckCircle2 size={18} />
              <span>保存</span>
            </button>
            <button
              className="icon-button danger"
              type="button"
              title="履歴削除"
              onClick={() => void clearConversation()}
            >
              <Trash2 size={18} />
            </button>
          </div>
        </aside>
      )}
    </main>
  );
}
