# Copyright © 2025-26 l5yth & contributors
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

"""LoRa region/frequency/preset derivation from a Meshtastic config protobuf."""

from __future__ import annotations

import math
import re
from typing import Any

from .. import config


def _has_field(message: Any, field_name: str) -> bool:
    """Return ``True`` when ``message`` advertises ``field_name`` via ``HasField``."""

    if message is None:
        return False
    has_field = getattr(message, "HasField", None)
    if callable(has_field):
        try:
            return bool(has_field(field_name))
        except Exception:  # pragma: no cover - defensive guard
            return False
    return hasattr(message, field_name)


def _enum_name_from_field(message: Any, field_name: str, value: Any) -> str | None:
    """Return the enum name for ``value`` using ``message`` descriptors."""

    descriptor = getattr(message, "DESCRIPTOR", None)
    if descriptor is None:
        return None
    fields_by_name = getattr(descriptor, "fields_by_name", {})
    field_desc = fields_by_name.get(field_name)
    if field_desc is None:
        return None
    enum_type = getattr(field_desc, "enum_type", None)
    if enum_type is None:
        return None
    enum_values = getattr(enum_type, "values_by_number", {})
    enum_value = enum_values.get(value)
    if enum_value is None:
        return None
    return getattr(enum_value, "name", None)


def _resolve_lora_message(local_config: Any) -> Any | None:
    """Return the LoRa configuration sub-message from ``local_config``."""

    if local_config is None:
        return None
    if _has_field(local_config, "lora"):
        candidate = getattr(local_config, "lora", None)
        if candidate is not None:
            return candidate
    radio_section = getattr(local_config, "radio", None)
    if radio_section is not None:
        if _has_field(radio_section, "lora"):
            return getattr(radio_section, "lora", None)
        if hasattr(radio_section, "lora"):
            return getattr(radio_section, "lora")
    if hasattr(local_config, "lora"):
        return getattr(local_config, "lora")
    return None


# Maps Meshtastic region enum name to (base_freq_MHz, channel_spacing_MHz).
# Values are derived from the Meshtastic firmware RegionInfo tables.
# Used by _computed_channel_frequency to derive the actual radio frequency
# from the region and channel index.
_REGION_CHANNEL_PARAMS: dict[str, tuple[float, float]] = {
    "US": (902.0, 0.25),  # 902–928 MHz; e.g. ch 52 ≈ 915 MHz at 250 kHz spacing
    "EU_433": (433.175, 0.2),
    "EU_868": (869.525, 0.5),  # actual primary ≈ 869.525 MHz, not 868
    "CN": (470.0, 0.2),
    "JP": (920.875, 0.5),
    "ANZ": (916.0, 0.5),
    "KR": (921.9, 0.5),
    "TW": (923.0, 0.5),
    "RU": (868.9, 0.5),
    "IN": (865.0, 0.5),
    "NZ_865": (864.0, 0.5),
    "TH": (920.0, 0.5),
    "LORA_24": (2400.0, 0.5),
    "UA_433": (433.175, 0.2),
    "UA_868": (868.0, 0.5),
    "MY_433": (433.0, 0.2),
    "MY_919": (919.0, 0.5),
    "SG_923": (923.0, 0.5),
    "PH_433": (433.0, 0.2),
    "PH_868": (868.0, 0.5),
    "PH_915": (915.0, 0.5),
    "ANZ_433": (433.0, 0.2),
    "KZ_433": (433.0, 0.2),
    "KZ_863": (863.125, 0.5),
    "NP_865": (865.0, 0.5),
    "BR_902": (902.0, 0.25),
    # IL (Israel) is absent from meshtastic Python lib 2.7.8 protobufs; the
    # enum value is unresolvable at runtime.  Operators on IL firmware should
    # set the FREQUENCY environment variable to override.
}


def _computed_channel_frequency(
    enum_name: str | None,
    channel_num: int | None,
) -> int | None:
    """Compute the floor MHz frequency for a known region and channel index.

    Looks up *enum_name* in :data:`_REGION_CHANNEL_PARAMS` and returns
    ``floor(base_freq + channel_num * spacing)``.  Returns ``None`` when the
    region is not in the table.  A missing or negative *channel_num* is
    treated as 0 so the base frequency is always usable.

    Args:
        enum_name: Region enum name as returned by
            :func:`_enum_name_from_field`, e.g. ``"EU_868"`` or ``"US"``.
        channel_num: Zero-based channel index from the device LoRa config.

    Returns:
        Floored MHz as :class:`int`, or ``None`` if the region is unknown.
    """
    if enum_name is None:
        return None
    params = _REGION_CHANNEL_PARAMS.get(enum_name)
    if params is None:
        return None
    base, spacing = params
    idx = channel_num if (isinstance(channel_num, int) and channel_num >= 0) else 0
    return math.floor(base + idx * spacing)


def _region_frequency(lora_message: Any) -> int | float | str | None:
    """Derive the LoRa region frequency in MHz or the region label from ``lora_message``.

    Frequency sources are tried in priority order:

    1. ``override_frequency > 0`` — explicit radio override, floored to MHz.
    2. :data:`_REGION_CHANNEL_PARAMS` lookup + ``channel_num`` — actual
       band-plan frequency derived from the device's region and channel index,
       floored to MHz.
    3. Largest digit token ≥ 100 parsed from the region enum name string.
    4. Largest digit token < 100 from the enum name (reversed scan).
    5. Full enum name string, raw integer ≥ 100, or raw string as a label.

    Args:
        lora_message: A LoRa config protobuf message or compatible object.

    Returns:
        An integer MHz frequency, a fallback string label, or ``None``.
    """

    if lora_message is None:
        return None

    # Step 1 — explicit radio override
    override_frequency = getattr(lora_message, "override_frequency", None)
    if override_frequency is not None:
        if isinstance(override_frequency, (int, float)):
            if override_frequency > 0:
                return math.floor(override_frequency)
        elif override_frequency:
            return override_frequency

    region_value = getattr(lora_message, "region", None)
    if region_value is None:
        return None
    enum_name = _enum_name_from_field(lora_message, "region", region_value)

    # Step 2 — lookup table + channel offset (actual band-plan frequency)
    if enum_name:
        channel_num = getattr(lora_message, "channel_num", None)
        computed = _computed_channel_frequency(enum_name, channel_num)
        if computed is not None:
            return computed

    # Steps 3–5 — parse digits from enum name (fallback for unknown regions)
    if enum_name:
        digits = re.findall(r"\d+", enum_name)
        for token in digits:
            try:
                freq = int(token)
            except ValueError:  # pragma: no cover - regex guarantees digits
                continue
            if freq >= 100:
                return freq
        for token in reversed(digits):
            try:
                return int(token)
            except ValueError:  # pragma: no cover - defensive only
                continue
        return enum_name
    if isinstance(region_value, int) and region_value >= 100:
        return region_value
    if isinstance(region_value, str) and region_value:
        return region_value
    return None


def _camelcase_enum_name(name: str | None) -> str | None:
    """Convert ``name`` from ``SCREAMING_SNAKE`` to ``CamelCase``."""

    if not name:
        return None
    parts = re.split(r"[^0-9A-Za-z]+", name.strip())
    camel_parts = [part.capitalize() for part in parts if part]
    if not camel_parts:
        return None
    return "".join(camel_parts)


def _modem_preset(lora_message: Any) -> str | None:
    """Return the CamelCase modem preset configured on ``lora_message``."""

    if lora_message is None:
        return None
    descriptor = getattr(lora_message, "DESCRIPTOR", None)
    fields_by_name = getattr(descriptor, "fields_by_name", {}) if descriptor else {}
    if "modem_preset" in fields_by_name:
        preset_field = "modem_preset"
    elif "preset" in fields_by_name:
        preset_field = "preset"
    elif hasattr(lora_message, "modem_preset"):
        preset_field = "modem_preset"
    elif hasattr(lora_message, "preset"):
        preset_field = "preset"
    else:
        return None

    preset_value = getattr(lora_message, preset_field, None)
    if preset_value is None:
        return None
    enum_name = _enum_name_from_field(lora_message, preset_field, preset_value)
    if isinstance(enum_name, str) and enum_name:
        return _camelcase_enum_name(enum_name)
    if isinstance(preset_value, str) and preset_value:
        return _camelcase_enum_name(preset_value)
    return None


def _ensure_radio_metadata(iface: Any) -> None:
    """Populate cached LoRa metadata by inspecting ``iface`` when available."""

    if iface is None:
        return

    try:
        wait_for_config = getattr(iface, "waitForConfig", None)
        if callable(wait_for_config):
            wait_for_config()
    except Exception:  # pragma: no cover - hardware dependent guard
        pass

    local_node = getattr(iface, "localNode", None)
    local_config = getattr(local_node, "localConfig", None) if local_node else None
    lora_message = _resolve_lora_message(local_config)
    if lora_message is None:
        return

    frequency = _region_frequency(lora_message)
    preset = _modem_preset(lora_message)

    updated = False
    if frequency is not None and getattr(config, "LORA_FREQ", None) is None:
        config.LORA_FREQ = frequency
        updated = True
    if preset is not None and getattr(config, "MODEM_PRESET", None) is None:
        config.MODEM_PRESET = preset
        updated = True

    if updated:
        config._debug_log(
            "Captured LoRa radio metadata",
            context="interfaces.ensure_radio_metadata",
            severity="info",
            always=True,
            lora_freq=frequency,
            modem_preset=preset,
        )
