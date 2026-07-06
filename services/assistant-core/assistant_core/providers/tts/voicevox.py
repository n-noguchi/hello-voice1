from __future__ import annotations

import httpx

from assistant_core.config import AssistantSettings


class VoicevoxProvider:
    def __init__(self, settings: AssistantSettings) -> None:
        self.settings = settings
        self.base_url = settings.voicevox_base_url.rstrip("/")

    async def is_available(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(f"{self.base_url}/version")
                return response.status_code < 500
        except httpx.HTTPError:
            return False

    async def list_speakers(self) -> list[dict]:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(f"{self.base_url}/speakers")
            response.raise_for_status()
            return response.json()

    async def synthesize(self, text: str, speaker: int | None = None) -> bytes:
        selected_speaker = speaker if speaker is not None else self.settings.voicevox_speaker
        async with httpx.AsyncClient(timeout=60.0) as client:
            query_response = await client.post(
                f"{self.base_url}/audio_query",
                params={"text": text, "speaker": selected_speaker},
            )
            query_response.raise_for_status()
            audio_query = query_response.json()
            synthesis_response = await client.post(
                f"{self.base_url}/synthesis",
                params={"speaker": selected_speaker},
                json=audio_query,
            )
            synthesis_response.raise_for_status()
            return synthesis_response.content
