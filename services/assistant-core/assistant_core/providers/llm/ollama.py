from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx

from assistant_core.config import AssistantSettings
from assistant_core.schemas import Message, ModelInfo


class OllamaProvider:
    def __init__(self, settings: AssistantSettings) -> None:
        self.settings = settings
        self.base_url = settings.ollama_base_url.rstrip("/")

    async def is_available(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(f"{self.base_url}/api/tags")
                return response.status_code < 500
        except httpx.HTTPError:
            return False

    async def list_models(self) -> list[ModelInfo]:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(f"{self.base_url}/api/tags")
            response.raise_for_status()
            payload = response.json()
        models: list[ModelInfo] = []
        for item in payload.get("models", []):
            models.append(
                ModelInfo(
                    name=item.get("name", ""),
                    size=item.get("size"),
                    modified_at=item.get("modified_at"),
                )
            )
        return [model for model in models if model.name]

    async def default_model(self) -> str:
        if self.settings.llm_model:
            return self.settings.llm_model
        models = await self.list_models()
        if not models:
            raise RuntimeError("Ollamaに利用可能なモデルがありません。先に `ollama pull` でモデルを取得してください。")
        return models[0].name

    async def stream_chat(
        self,
        messages: list[Message],
        model: str | None = None,
    ) -> AsyncIterator[str]:
        selected_model = model or await self.default_model()
        payload = {
            "model": selected_model,
            "messages": [message.model_dump() for message in messages],
            "stream": True,
            "options": {"temperature": self.settings.temperature},
        }
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", f"{self.base_url}/api/chat", json=payload) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    data = json.loads(line)
                    if data.get("done"):
                        break
                    content = data.get("message", {}).get("content")
                    if content:
                        yield content
