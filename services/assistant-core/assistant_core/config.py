from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field


def project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def default_data_dir() -> Path:
    configured = os.getenv("HELLO_VOICE_DATA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return project_root() / ".hello-voice-data"


class AssistantSettings(BaseModel):
    ollama_base_url: str = "http://127.0.0.1:11434"
    llm_model: str | None = None
    system_prompt: str = (
        "あなたはローカルで動作する音声アシスタントです。"
        "簡潔で自然な日本語で答えてください。"
    )
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_context_messages: int = Field(default=16, ge=2, le=80)

    stt_provider: Literal["faster_whisper", "none"] = "faster_whisper"
    stt_model: str = "small"
    stt_language: str = "ja"
    stt_device: Literal["auto", "cpu", "cuda"] = "auto"
    stt_compute_type: str = "int8"

    tts_provider: Literal["voicevox", "piper", "none"] = "voicevox"
    voicevox_base_url: str = "http://127.0.0.1:50021"
    voicevox_speaker: int = 1
    piper_executable: str = "piper"
    piper_model_path: str | None = None


class SettingsStore:
    def __init__(self, data_dir: Path | None = None) -> None:
        self.data_dir = data_dir or default_data_dir()
        self.path = self.data_dir / "settings.json"
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def load(self) -> AssistantSettings:
        if not self.path.exists():
            return apply_env_overrides(AssistantSettings())
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            return apply_env_overrides(AssistantSettings.model_validate(raw))
        except Exception:
            broken = self.path.with_suffix(".json.broken")
            self.path.replace(broken)
            return apply_env_overrides(AssistantSettings())

    def save(self, settings: AssistantSettings) -> AssistantSettings:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            settings.model_dump_json(indent=2),
            encoding="utf-8",
        )
        return settings


settings_store = SettingsStore()


def apply_env_overrides(settings: AssistantSettings) -> AssistantSettings:
    data = settings.model_dump()
    overrides: dict[str, tuple[str, object]] = {
        "HELLO_VOICE_OLLAMA_BASE_URL": ("ollama_base_url", str),
        "HELLO_VOICE_LLM_MODEL": ("llm_model", str),
        "HELLO_VOICE_SYSTEM_PROMPT": ("system_prompt", str),
        "HELLO_VOICE_TEMPERATURE": ("temperature", float),
        "HELLO_VOICE_MAX_CONTEXT_MESSAGES": ("max_context_messages", int),
        "HELLO_VOICE_STT_PROVIDER": ("stt_provider", str),
        "HELLO_VOICE_STT_MODEL": ("stt_model", str),
        "HELLO_VOICE_STT_LANGUAGE": ("stt_language", str),
        "HELLO_VOICE_STT_DEVICE": ("stt_device", str),
        "HELLO_VOICE_STT_COMPUTE_TYPE": ("stt_compute_type", str),
        "HELLO_VOICE_TTS_PROVIDER": ("tts_provider", str),
        "HELLO_VOICE_VOICEVOX_BASE_URL": ("voicevox_base_url", str),
        "HELLO_VOICE_VOICEVOX_SPEAKER": ("voicevox_speaker", int),
        "HELLO_VOICE_PIPER_EXECUTABLE": ("piper_executable", str),
        "HELLO_VOICE_PIPER_MODEL_PATH": ("piper_model_path", str),
    }
    for env_name, (field_name, parser) in overrides.items():
        value = os.getenv(env_name)
        if value is None or value == "":
            continue
        data[field_name] = parser(value)  # type: ignore[operator]
    return AssistantSettings.model_validate(data)
