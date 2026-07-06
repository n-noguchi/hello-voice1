from __future__ import annotations


def list_audio_devices() -> list[dict]:
    try:
        import sounddevice as sd
    except ImportError:
        return []

    devices = sd.query_devices()
    result = []
    for index, device in enumerate(devices):
        result.append(
            {
                "id": index,
                "name": device.get("name"),
                "max_input_channels": device.get("max_input_channels"),
                "max_output_channels": device.get("max_output_channels"),
                "default_samplerate": device.get("default_samplerate"),
            }
        )
    return result
