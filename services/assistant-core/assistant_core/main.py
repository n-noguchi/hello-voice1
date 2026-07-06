from __future__ import annotations

import json
import logging
import subprocess
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

from .audio.devices import list_audio_devices
from .config import AssistantSettings, default_data_dir, settings_store
from .orchestrator import ConversationOrchestrator
from .providers.llm.ollama import OllamaProvider
from .providers.stt.faster_whisper import FasterWhisperProvider
from .providers.tts.piper import PiperProvider
from .providers.tts.voicevox import VoicevoxProvider
from .schemas import ChatRequest, HealthResponse, Message, TTSRequest
from .storage.conversation_store import conversation_store

app = FastAPI(title="hello-voice1 assistant core", version="0.1.0")
logger = logging.getLogger("uvicorn.error")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:1420",
        "http://localhost:1420",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def current_settings() -> AssistantSettings:
    return settings_store.load()


def ndjson(payload: dict) -> bytes:
    return (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")


def audio_volume_stats(path: Path) -> dict[str, str]:
    try:
        completed = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"error": str(exc)}

    stats: dict[str, str] = {}
    for line in completed.stderr.splitlines():
        if "Duration:" in line:
            stats["ffmpeg_duration"] = line.strip()
        if "mean_volume:" in line:
            stats["mean_volume"] = line.rsplit("mean_volume:", 1)[1].strip()
        if "max_volume:" in line:
            stats["max_volume"] = line.rsplit("max_volume:", 1)[1].strip()
    if completed.returncode != 0:
        stats["error"] = completed.stderr.splitlines()[-1] if completed.stderr else f"ffmpeg exit {completed.returncode}"
    return stats


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    settings = current_settings()
    ollama = await OllamaProvider(settings).is_available()
    voicevox = await VoicevoxProvider(settings).is_available()
    return HealthResponse(
        ok=True,
        ollama=ollama,
        voicevox=voicevox,
        data_dir=str(default_data_dir()),
        settings=settings,
    )


@app.get("/api/settings", response_model=AssistantSettings)
async def get_settings() -> AssistantSettings:
    return current_settings()


@app.put("/api/settings", response_model=AssistantSettings)
async def put_settings(settings: AssistantSettings) -> AssistantSettings:
    return settings_store.save(settings)


@app.get("/api/llm/models")
async def list_llm_models() -> list[dict]:
    settings = current_settings()
    try:
        models = await OllamaProvider(settings).list_models()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"Ollamaに接続できません: {exc}") from exc
    return [model.model_dump() for model in models]


@app.get("/api/audio/devices")
async def audio_devices() -> list[dict]:
    return list_audio_devices()


@app.get("/api/history/{session_id}")
async def history(session_id: str) -> list[dict]:
    return [message.model_dump(mode="json") for message in conversation_store.list_messages(session_id, limit=80)]


@app.delete("/api/history/{session_id}")
async def clear_history(session_id: str) -> dict:
    conversation_store.clear(session_id)
    return {"ok": True}


@app.post("/api/chat/stream")
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    async def events() -> AsyncIterator[bytes]:
        settings = current_settings()
        orchestrator = ConversationOrchestrator(settings)
        yield ndjson({"type": "user.accepted", "session_id": request.session_id, "text": request.text})
        reply_parts: list[str] = []
        try:
            async for token in orchestrator.stream_reply(
                request.session_id,
                request.text,
                model=request.model,
            ):
                reply_parts.append(token)
                yield ndjson({"type": "llm.token", "token": token})
            yield ndjson({"type": "llm.done", "text": "".join(reply_parts)})
        except Exception as exc:
            yield ndjson({"type": "error", "message": str(exc)})

    return StreamingResponse(events(), media_type="application/x-ndjson")


@app.post("/api/stt/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    settings = current_settings()
    if settings.stt_provider == "none":
        raise HTTPException(status_code=400, detail="STT provider is disabled.")
    suffix = Path(file.filename or "audio.webm").suffix or ".webm"
    uploaded_bytes = 0
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = Path(tmp.name)
        while chunk := await file.read(1024 * 1024):
            uploaded_bytes += len(chunk)
            tmp.write(chunk)
    logger.info(
        "STT upload received: filename=%s content_type=%s bytes=%s provider=%s model=%s language=%s",
        file.filename,
        file.content_type,
        uploaded_bytes,
        settings.stt_provider,
        settings.stt_model,
        settings.stt_language,
    )
    logger.info("STT audio stats: %s", audio_volume_stats(tmp_path))
    try:
        result = FasterWhisperProvider(settings).transcribe_file(tmp_path)
        logger.info(
            "STT result: text_length=%s segments=%s language=%s duration=%s",
            len(result.text),
            len(result.segments),
            result.language,
            result.duration,
        )
        return result
    except RuntimeError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    finally:
        tmp_path.unlink(missing_ok=True)


@app.get("/api/tts/voicevox/speakers")
async def voicevox_speakers() -> list[dict]:
    settings = current_settings()
    try:
        return await VoicevoxProvider(settings).list_speakers()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"VOICEVOXに接続できません: {exc}") from exc


@app.post("/api/tts/synthesize")
async def synthesize_tts(request: TTSRequest) -> Response:
    settings = current_settings()
    provider = request.provider or settings.tts_provider
    if provider == "none":
        raise HTTPException(status_code=400, detail="TTS provider is disabled.")
    try:
        if provider == "voicevox":
            voicevox = VoicevoxProvider(settings)
            if not await voicevox.is_available():
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "VOICEVOX Engineに接続できません。"
                        f" Engineを起動し、{settings.voicevox_base_url} にアクセスできることを確認してください。"
                        " 確認コマンド: curl --fail http://127.0.0.1:50021/version"
                    ),
                )
            audio = await voicevox.synthesize(
                request.text,
                speaker=request.voicevox_speaker,
            )
        elif provider == "piper":
            audio = await PiperProvider(settings).synthesize(request.text)
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported TTS provider: {provider}")
    except RuntimeError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"TTSに接続できません: {exc}") from exc
    return Response(content=audio, media_type="audio/wav")


@app.websocket("/ws/conversation")
async def conversation_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            payload = await websocket.receive_json()
            event_type = payload.get("type")
            if event_type != "chat.text":
                await websocket.send_json({"type": "error", "message": "Unsupported event type"})
                continue
            request = ChatRequest(
                text=payload.get("text", ""),
                session_id=payload.get("session_id", "default"),
                model=payload.get("model"),
            )
            settings = current_settings()
            orchestrator = ConversationOrchestrator(settings)
            await websocket.send_json(
                {"type": "user.accepted", "session_id": request.session_id, "text": request.text}
            )
            reply_parts: list[str] = []
            try:
                async for token in orchestrator.stream_reply(
                    request.session_id,
                    request.text,
                    model=request.model,
                ):
                    reply_parts.append(token)
                    await websocket.send_json({"type": "llm.token", "token": token})
                await websocket.send_json({"type": "llm.done", "text": "".join(reply_parts)})
            except Exception as exc:
                await websocket.send_json({"type": "error", "message": str(exc)})
    except WebSocketDisconnect:
        return
