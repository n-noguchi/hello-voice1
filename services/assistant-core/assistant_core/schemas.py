from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from .config import AssistantSettings


class Message(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class StoredMessage(Message):
    id: int
    session_id: str
    created_at: datetime


class ChatRequest(BaseModel):
    text: str = Field(min_length=1)
    session_id: str = "default"
    model: str | None = None
    speak: bool = True


class ChatResponse(BaseModel):
    session_id: str
    message: Message


class TranscriptResponse(BaseModel):
    text: str
    language: str | None = None
    duration: float | None = None
    segments: list[dict[str, Any]] = Field(default_factory=list)


class HealthResponse(BaseModel):
    ok: bool
    ollama: bool
    voicevox: bool
    data_dir: str
    settings: AssistantSettings


class ModelInfo(BaseModel):
    name: str
    size: int | None = None
    modified_at: str | None = None


class TTSRequest(BaseModel):
    text: str = Field(min_length=1)
    provider: Literal["voicevox", "piper", "none"] | None = None
    voicevox_speaker: int | None = None


class ErrorPayload(BaseModel):
    type: str = "error"
    message: str
    detail: str | None = None
