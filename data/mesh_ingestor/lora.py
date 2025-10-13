# Copyright (C) 2025 l5yth
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Helpers for formatting and tracking LoRa device metadata."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

_RADIO_PREFERENCE_KEYS = ("modem_preset", "modemPreset")


def _raw_radio_fields(radio_config: Any) -> tuple[Any, Any, bool]:
    """Return raw modem preset and region from ``radio_config``."""

    if radio_config is None:
        return None, None, False
    preferences = _lookup(radio_config, "preferences")
    if preferences is None:
        return None, None, False
    preset = None
    for key in _RADIO_PREFERENCE_KEYS:
        preset = _lookup(preferences, key)
        if preset is not None:
            break
    region = _lookup(preferences, "region")
    return preset, region, True


def _raw_device_fields(device_config: Any) -> tuple[Any, Any, bool]:
    """Return raw modem preset and region from ``device_config``."""

    if device_config is None:
        return None, None, False
    lora_section = _lookup(device_config, "lora")
    if lora_section is None:
        return None, None, False
    preset = _lookup(lora_section, "modemPreset")
    if preset is None:
        preset = _lookup(lora_section, "modem_preset")
    region = _lookup(lora_section, "region")
    return preset, region, True


_LORA_PRESET: str | None = None
_LORA_FREQUENCY: int | None = None


def _lookup(obj: Any, key: str) -> Any:
    """Return ``obj[key]`` or ``getattr(obj, key)`` when available."""

    if isinstance(obj, Mapping):
        return obj.get(key)
    return getattr(obj, key, None)


def format_modem_preset(value: Any) -> str | None:
    """Format ``value`` into a Meshtastic modem preset label."""

    if value in {None, ""}:
        return None
    text = str(value).strip()
    if not text:
        return None
    words = re.split(r"[^0-9A-Za-z]+", text)
    camel = "".join(word.lower().capitalize() for word in words if word)
    if not camel:
        return None
    return f"#{camel}"


def format_region_frequency(value: Any) -> int | None:
    """Extract an integer LoRa frequency from a region label.

    The helper scans ``value`` for numeric fragments and returns an averaged
    centre frequency when a range is supplied (e.g. ``"902-928"`` becomes
    ``915``).
    """

    if value in {None, ""}:
        return None
    text = str(value).strip()
    if not text:
        return None
    matches = re.findall(r"\d+(?:\.\d+)?", text)
    if not matches:
        return None
    numeric = []
    for match in matches:
        try:
            numeric.append(float(match))
        except ValueError:
            continue
    if not numeric:
        return None
    if len(numeric) == 1:
        frequency = numeric[0]
    else:
        frequency = (min(numeric) + max(numeric)) / 2.0
    return int(round(frequency))


def extract_from_device_config(device_config: Any) -> tuple[str | None, int | None]:
    """Return the formatted LoRa metadata from ``device_config``."""

    preset, region, has_section = _raw_device_fields(device_config)
    if not has_section:
        return None, None
    return format_modem_preset(preset), format_region_frequency(region)


def extract_from_radio_config(radio_config: Any) -> tuple[str | None, int | None]:
    """Return LoRa metadata extracted from a Meshtastic ``RadioConfig`` proto.

    The mesh daemon exposes the last-known radio configuration on
    ``iface.radioConfig``. This helper drills into the ``preferences`` section to
    obtain the modem preset and region fields, converting them into the
    application-friendly formats handled elsewhere in the ingestion pipeline.
    """

    preset, region, has_preferences = _raw_radio_fields(radio_config)
    if not has_preferences:
        return None, None
    return format_modem_preset(preset), format_region_frequency(region)


def inspect_device_config(device_config: Any) -> dict[str, Any]:
    """Return raw LoRa details extracted from ``device_config`` for logging."""

    preset, region, has_section = _raw_device_fields(device_config)
    return {
        "device_config_present": device_config is not None,
        "device_lora_present": has_section,
        "device_raw_preset": preset,
        "device_raw_region": region,
    }


def inspect_radio_config(radio_config: Any) -> dict[str, Any]:
    """Return raw LoRa details from ``radio_config`` for debug logging."""

    preset, region, has_preferences = _raw_radio_fields(radio_config)
    return {
        "radio_config_present": radio_config is not None,
        "radio_preferences_present": has_preferences,
        "radio_raw_preset": preset,
        "radio_raw_region": region,
    }


def set_metadata(*, preset: str | None, frequency: int | None) -> None:
    """Set the cached LoRa metadata values."""

    global _LORA_PRESET, _LORA_FREQUENCY
    _LORA_PRESET = preset
    _LORA_FREQUENCY = frequency


def update_from_device_config(device_config: Any) -> tuple[str | None, int | None]:
    """Extract and store LoRa metadata from ``device_config``."""

    preset, frequency = extract_from_device_config(device_config)
    set_metadata(preset=preset, frequency=frequency)
    return preset, frequency


def current_preset() -> str | None:
    """Return the cached LoRa modem preset."""

    return _LORA_PRESET


def current_frequency() -> int | None:
    """Return the cached LoRa region frequency."""

    return _LORA_FREQUENCY


def apply_metadata(record: dict[str, Any]) -> dict[str, Any]:
    """Attach the cached metadata to ``record`` in-place."""

    record["lora_preset"] = _LORA_PRESET
    record["lora_frequency"] = _LORA_FREQUENCY
    return record


__all__ = [
    "apply_metadata",
    "current_frequency",
    "current_preset",
    "extract_from_device_config",
    "format_modem_preset",
    "format_region_frequency",
    "inspect_device_config",
    "inspect_radio_config",
    "extract_from_radio_config",
    "set_metadata",
    "update_from_device_config",
]
