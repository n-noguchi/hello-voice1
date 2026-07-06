from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from assistant_core.config import AssistantSettings


class PiperProvider:
    def __init__(self, settings: AssistantSettings) -> None:
        self.settings = settings

    async def synthesize(self, text: str) -> bytes:
        if not self.settings.piper_model_path:
            raise RuntimeError("Piper model path is not configured.")
        model_path = Path(self.settings.piper_model_path).expanduser()
        if not model_path.exists():
            raise RuntimeError(f"Piper model does not exist: {model_path}")
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as out_file:
            out_path = Path(out_file.name)
        try:
            process = await asyncio.create_subprocess_exec(
                self.settings.piper_executable,
                "--model",
                str(model_path),
                "--output_file",
                str(out_path),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await process.communicate(text.encode("utf-8"))
            if process.returncode != 0:
                raise RuntimeError(stderr.decode("utf-8", errors="replace"))
            return out_path.read_bytes()
        finally:
            out_path.unlink(missing_ok=True)
