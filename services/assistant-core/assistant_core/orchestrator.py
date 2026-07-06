from __future__ import annotations

from collections.abc import AsyncIterator

from .config import AssistantSettings
from .providers.llm.ollama import OllamaProvider
from .schemas import Message
from .storage.conversation_store import conversation_store


class ConversationOrchestrator:
    def __init__(self, settings: AssistantSettings) -> None:
        self.settings = settings
        self.llm = OllamaProvider(settings)

    def build_context(self, session_id: str, user_text: str) -> list[Message]:
        history = conversation_store.list_messages(
            session_id,
            limit=self.settings.max_context_messages,
        )
        messages = [Message(role="system", content=self.settings.system_prompt)]
        messages.extend(Message(role=item.role, content=item.content) for item in history)
        messages.append(Message(role="user", content=user_text))
        return messages

    async def stream_reply(
        self,
        session_id: str,
        user_text: str,
        model: str | None = None,
    ) -> AsyncIterator[str]:
        messages = self.build_context(session_id, user_text)
        conversation_store.add_message(session_id, Message(role="user", content=user_text))
        reply_parts: list[str] = []
        async for token in self.llm.stream_chat(messages, model=model):
            reply_parts.append(token)
            yield token
        reply = "".join(reply_parts).strip()
        if reply:
            conversation_store.add_message(session_id, Message(role="assistant", content=reply))
