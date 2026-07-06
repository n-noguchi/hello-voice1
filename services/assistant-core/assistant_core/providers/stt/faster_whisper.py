from __future__ import annotations

from pathlib import Path
from typing import Any

from assistant_core.config import AssistantSettings
from assistant_core.schemas import TranscriptResponse


class FasterWhisperProvider:
    _model_cache: dict[tuple[str, str, str], Any] = {}

    def __init__(self, settings: AssistantSettings) -> None:
        self.settings = settings

    def _load_model(self) -> Any:
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise RuntimeError(
                "faster-whisper がインストールされていません。"
                " `pip install -e .\\services\\assistant-core[voice]` を実行してください。"
            ) from exc

        device = self.settings.stt_device
        if device == "auto":
            device = "cpu"
        key = (self.settings.stt_model, device, self.settings.stt_compute_type)
        if key not in self._model_cache:
            self._model_cache[key] = WhisperModel(
                self.settings.stt_model,
                device=device,
                compute_type=self.settings.stt_compute_type,
            )
        return self._model_cache[key]

    def transcribe_file(self, path: Path) -> TranscriptResponse:
        model = self._load_model()
        language = None if self.settings.stt_language == "auto" else self.settings.stt_language
        segments, info = model.transcribe(str(path), language=language, vad_filter=True)
        result_segments = []
        text_parts = []
        for segment in segments:
            text_parts.append(segment.text)
            result_segments.append(
                {
                    "start": segment.start,
                    "end": segment.end,
                    "text": segment.text,
                }
            )
        return TranscriptResponse(
            text="".join(text_parts).strip(),
            language=getattr(info, "language", None),
            duration=getattr(info, "duration", None),
            segments=result_segments,
        )
