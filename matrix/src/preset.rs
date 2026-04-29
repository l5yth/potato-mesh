// Copyright © 2025-26 l5yth & contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Modem preset abbreviation logic, mirroring
//! `web/public/assets/js/app/node-modem-metadata.js` and
//! `web/public/assets/js/app/chat-format.js`.
//!
//! The PotatoMesh ingestor encodes MeshCore radio config as
//! `SF{sf}/BW{bw}/CR{cr}` and Meshtastic radio config as a CamelCase preset
//! name like `MediumFast`. The web dashboard collapses both to a 2-character
//! bracket label (e.g. `[NA]` for EU/UK Narrow, `[MF]` for MediumFast); this
//! module reproduces that mapping in Rust so Matrix-bridged messages render
//! the same label as the dashboard.

/// Named MeshCore SF/BW/CR preset entry.
///
/// Frequency-gated entries (currently only the SF7/BW62/CR5 row) are skipped
/// when `freq_mhz` is `None`, matching the JS `resolveMeshcorePresetDisplay`
/// behavior.
struct NamedPreset {
    sf: u8,
    bw: u16,
    cr: u8,
    long_name: &'static str,
    /// Inclusive lower bound for `freq_mhz`. `None` means no lower gate.
    min_freq_mhz: Option<u16>,
    /// Exclusive upper bound for `freq_mhz`. `None` means no upper gate.
    max_freq_mhz: Option<u16>,
}

/// Canonical MeshCore preset table, ported from
/// `MESHCORE_NAMED_PRESETS` in `node-modem-metadata.js:84-92`.
const MESHCORE_NAMED_PRESETS: &[NamedPreset] = &[
    NamedPreset {
        sf: 10,
        bw: 250,
        cr: 5,
        long_name: "AU/NZ Wide",
        min_freq_mhz: None,
        max_freq_mhz: None,
    },
    NamedPreset {
        sf: 10,
        bw: 62,
        cr: 5,
        long_name: "AU/NZ Narrow",
        min_freq_mhz: None,
        max_freq_mhz: None,
    },
    NamedPreset {
        sf: 11,
        bw: 250,
        cr: 5,
        long_name: "EU/UK Wide",
        min_freq_mhz: None,
        max_freq_mhz: None,
    },
    NamedPreset {
        sf: 8,
        bw: 62,
        cr: 8,
        long_name: "EU/UK Narrow",
        min_freq_mhz: None,
        max_freq_mhz: None,
    },
    // SF7/BW62/CR5 is region-disambiguated by the 900 MHz threshold.
    NamedPreset {
        sf: 7,
        bw: 62,
        cr: 5,
        long_name: "CZ/SK Narrow",
        min_freq_mhz: None,
        max_freq_mhz: Some(900),
    },
    NamedPreset {
        sf: 7,
        bw: 62,
        cr: 5,
        long_name: "US/CA Narrow",
        min_freq_mhz: Some(900),
        max_freq_mhz: None,
    },
];

/// Canonical Meshtastic preset abbreviation table, ported from
/// `PRESET_ABBREVIATIONS` in `chat-format.js:160-170`.
///
/// Keys are already lowercased and stripped of non-alphabetic characters so
/// the lookup is insensitive to delimiters and casing.
const MESHTASTIC_PRESET_ABBREVIATIONS: &[(&str, &str)] = &[
    ("verylongslow", "VL"),
    ("longslow", "LS"),
    ("longmoderate", "LM"),
    ("longfast", "LF"),
    ("mediumslow", "MS"),
    ("mediumfast", "MF"),
    ("shortslow", "SS"),
    ("shortfast", "SF"),
    ("shortturbo", "ST"),
];

/// Identity of one parsed token in an SF/BW/CR preset string.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PresetKey {
    Sf,
    Bw,
    Cr,
}

/// Parsed numeric values extracted from an SF/BW/CR preset string.
///
/// JS uses double-precision floats throughout; mirroring with `f64` avoids
/// surprises for any future fractional MHz value even though the values
/// in play today (62, 62.5, 125, 250, ~868–915) are exact in `f32`.
#[derive(Clone, Copy, PartialEq, Debug)]
struct MeshcoreTokens {
    sf: f64,
    bw: f64,
    cr: f64,
}

/// Validate that `s` matches the JS regex `\d+(?:\.\d+)?`.
///
/// Accepts integer or decimal positive numbers — no sign, no exponent, no
/// leading or trailing dot.
fn is_valid_number_token(s: &str) -> bool {
    let mut has_digits_before_dot = false;
    let mut found_dot = false;
    let mut has_digits_after_dot = false;
    for c in s.chars() {
        if c == '.' {
            if found_dot || !has_digits_before_dot {
                return false;
            }
            found_dot = true;
        } else if c.is_ascii_digit() {
            if found_dot {
                has_digits_after_dot = true;
            } else {
                has_digits_before_dot = true;
            }
        } else {
            return false;
        }
    }
    has_digits_before_dot && (!found_dot || has_digits_after_dot)
}

/// Parse a single `SF{n}`, `BW{n}`, or `CR{n}` token (case-insensitive).
fn parse_token(part: &str) -> Option<(PresetKey, f64)> {
    // Both length and char-boundary checks are needed: `len() >= 3` rules
    // out short tokens, but a multi-byte first codepoint (e.g. `é12`) has
    // `len() == 3` while byte index 2 lands mid-codepoint — so
    // `is_char_boundary(2)` is what actually keeps `split_at(2)` from
    // panicking on non-ASCII input.
    if part.len() < 3 || !part.is_char_boundary(2) {
        return None;
    }
    let (prefix, rest) = part.split_at(2);
    let key = if prefix.eq_ignore_ascii_case("SF") {
        PresetKey::Sf
    } else if prefix.eq_ignore_ascii_case("BW") {
        PresetKey::Bw
    } else if prefix.eq_ignore_ascii_case("CR") {
        PresetKey::Cr
    } else {
        return None;
    };
    if !is_valid_number_token(rest) {
        return None;
    }
    let value: f64 = rest.parse().ok()?;
    Some((key, value))
}

/// Parse an SF/BW/CR preset string into its three components.
///
/// Tokens may appear in any order; the prefix matching is case-insensitive.
/// Returns `None` for any string that is not a 3-segment SF/BW/CR pattern,
/// matching JS `parseMeshcorePresetTokens`.
fn parse_meshcore_preset_tokens(preset: &str) -> Option<MeshcoreTokens> {
    let trimmed = preset.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parts: Vec<&str> = trimmed.split('/').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut sf: Option<f64> = None;
    let mut bw: Option<f64> = None;
    let mut cr: Option<f64> = None;
    for part in parts {
        let (key, value) = parse_token(part)?;
        match key {
            PresetKey::Sf => {
                if sf.is_some() {
                    return None;
                }
                sf = Some(value);
            }
            PresetKey::Bw => {
                if bw.is_some() {
                    return None;
                }
                bw = Some(value);
            }
            PresetKey::Cr => {
                if cr.is_some() {
                    return None;
                }
                cr = Some(value);
            }
        }
    }
    Some(MeshcoreTokens {
        sf: sf?,
        bw: bw?,
        cr: cr?,
    })
}

/// Map a LoRa bandwidth to the canonical 2-character short code.
///
/// Mirrors `bwToShortCode` in `node-modem-metadata.js:132-138` — `62` and
/// `62.5` collapse to `Na`, `125` to `St`, `250` to `Wi`. Any other value
/// returns `None`.
///
/// The `f64 ==` comparisons rely on each literal having an exact double
/// representation; `62`, `62.5`, `125`, and `250` all do, and tokens
/// reach this function via `f64::from_str` of plain decimal strings, so
/// no rounding is introduced upstream.
fn bw_to_short_code(bw: f64) -> Option<&'static str> {
    if bw == 62.0 || bw == 62.5 {
        Some("Na")
    } else if bw == 125.0 {
        Some("St")
    } else if bw == 250.0 {
        Some("Wi")
    } else {
        None
    }
}

/// Format a numeric token for display string construction.
///
/// Mirrors JS coercion: `62` renders as `"62"`, `62.5` as `"62.5"`.
fn format_number(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

/// Display metadata returned by [`resolve_meshcore_preset_display`].
///
/// `long_name` and `display_string` are not consumed by the Matrix bridge
/// today — only `short_code` feeds the bracket render. They are retained
/// (with `#[allow(dead_code)]`) so the port stays line-for-line auditable
/// against the JS source and so a future caller (e.g. a tooltip surface)
/// can read them without touching the parsing path again.
#[derive(Clone, PartialEq, Debug)]
struct MeshcoreDisplay {
    /// Long human-readable name (e.g. "EU/UK Wide") when the SF/BW/CR
    /// triple matches a named preset, else `None`.
    #[allow(dead_code)]
    long_name: Option<&'static str>,
    /// 2-character short code derived from BW alone (e.g. "Na", "St",
    /// "Wi"), or `None` when the BW is unrecognized.
    short_code: Option<&'static str>,
    /// Human-readable display string — the long name when matched, else
    /// `BW{bw}/SF{sf}/CR{cr}`.
    #[allow(dead_code)]
    display_string: String,
}

/// Resolve a MeshCore SF/BW/CR preset into display metadata, or `None`
/// when the input is not an SF/BW/CR string.
///
/// Mirrors `resolveMeshcorePresetDisplay` in `node-modem-metadata.js:161-190`.
fn resolve_meshcore_preset_display(preset: &str, freq_mhz: Option<f64>) -> Option<MeshcoreDisplay> {
    let tokens = parse_meshcore_preset_tokens(preset)?;
    let short_code = bw_to_short_code(tokens.bw);

    let matched = MESHCORE_NAMED_PRESETS.iter().find(|entry| {
        if (entry.sf as f64) != tokens.sf {
            return false;
        }
        if (entry.bw as f64) != tokens.bw {
            return false;
        }
        if (entry.cr as f64) != tokens.cr {
            return false;
        }
        if let Some(max) = entry.max_freq_mhz {
            match freq_mhz {
                Some(f) if f < max as f64 => {}
                _ => return false,
            }
        }
        if let Some(min) = entry.min_freq_mhz {
            match freq_mhz {
                Some(f) if f >= min as f64 => {}
                _ => return false,
            }
        }
        true
    });

    if let Some(entry) = matched {
        return Some(MeshcoreDisplay {
            long_name: Some(entry.long_name),
            short_code,
            display_string: entry.long_name.to_string(),
        });
    }

    Some(MeshcoreDisplay {
        long_name: None,
        short_code,
        display_string: format!(
            "BW{}/SF{}/CR{}",
            format_number(tokens.bw),
            format_number(tokens.sf),
            format_number(tokens.cr),
        ),
    })
}

/// Lowercase a Meshtastic preset string for table lookup.
///
/// Mirrors `preset.replace(/[^A-Za-z]/g, '').toLowerCase()` in
/// `chat-format.js:296`.
fn normalize_meshtastic_token(preset: &str) -> String {
    preset
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Generate the fallback initials for a preset that did not hit either
/// lookup table.
///
/// Mirrors `derivePresetInitials` in `chat-format.js:309-336`.
fn derive_preset_initials(preset: &str) -> Option<String> {
    if preset.is_empty() {
        return None;
    }

    // Insert a space between (lowercase | digit) and uppercase to split
    // CamelCase boundaries — mirrors `/([a-z0-9])([A-Z])/g`.
    let mut spaced = String::with_capacity(preset.len() + 4);
    let mut prev: Option<char> = None;
    for c in preset.chars() {
        if let Some(p) = prev {
            if (p.is_ascii_lowercase() || p.is_ascii_digit()) && c.is_ascii_uppercase() {
                spaced.push(' ');
            }
        }
        spaced.push(c);
        prev = Some(c);
    }

    let tokens: Vec<String> = spaced
        .split(|c: char| c.is_whitespace() || c == '_' || c == '-')
        .map(|part| {
            part.chars()
                .filter(|c| c.is_ascii_alphabetic())
                .collect::<String>()
        })
        .filter(|s| !s.is_empty())
        .collect();

    if tokens.is_empty() {
        return None;
    }

    if tokens.len() == 1 {
        // Tokens are non-empty after the alphabetic-only filter, so
        // `upper` always has ≥ 1 character. The branch reduces to "≥ 2
        // → first two chars" vs. "exactly 1 → `X?`" — no zero-length arm.
        let upper = tokens[0].to_ascii_uppercase();
        if upper.chars().count() >= 2 {
            return Some(upper.chars().take(2).collect());
        }
        return Some(format!("{}?", upper));
    }

    let first = tokens[0].chars().next()?.to_ascii_uppercase();
    let second = tokens[1].chars().next()?.to_ascii_uppercase();
    Some(format!("{}{}", first, second))
}

/// Produce a 2-character abbreviation for any modem preset string.
///
/// MeshCore SF/BW/CR presets resolve via [`resolve_meshcore_preset_display`]
/// (taking precedence over the Meshtastic table). Meshtastic named presets
/// hit [`MESHTASTIC_PRESET_ABBREVIATIONS`] after delimiter / casing
/// normalization. Anything else falls through to [`derive_preset_initials`].
///
/// Returns `None` only when the preset is empty or cannot be reduced to a
/// 1+ character abbreviation.
///
/// Mirrors `abbreviatePreset` in `chat-format.js:287-301`.
pub fn abbreviate_preset(preset: &str, freq_mhz: Option<f64>) -> Option<String> {
    let trimmed = preset.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(display) = resolve_meshcore_preset_display(trimmed, freq_mhz) {
        return display.short_code.map(str::to_string);
    }

    let token = normalize_meshtastic_token(trimmed);
    if !token.is_empty() {
        for (key, value) in MESHTASTIC_PRESET_ABBREVIATIONS {
            if token == *key {
                return Some((*value).to_string());
            }
        }
    }

    derive_preset_initials(trimmed)
}

/// Format an abbreviation into the 2-character bracket slot used by both
/// the dashboard and the Matrix bridge.
///
/// Trims the value, uppercases it, and truncates to 2 characters. Returns
/// `"??"` when the value is missing or empty so the column width remains
/// consistent.
///
/// Mirrors `normalizePresetSlot` in `chat-format.js:344-350`. Where the JS
/// version emits `&nbsp;&nbsp;` for the empty case (HTML context), this Rust
/// port emits the literal placeholder `"??"` because Matrix message bodies
/// are plain text plus a `<code>…</code>` HTML wrapper, not raw HTML. `"??"`
/// also matches the existing `protocol_tag` placeholder convention.
pub fn normalize_preset_slot(value: Option<&str>) -> String {
    let raw = value.unwrap_or("").trim();
    if raw.is_empty() {
        return "??".to_string();
    }
    let upper: String = raw.chars().flat_map(|c| c.to_uppercase()).collect();
    if upper.is_empty() {
        return "??".to_string();
    }
    upper.chars().take(2).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ----- is_valid_number_token --------------------------------------------

    #[test]
    fn number_token_accepts_integers_and_decimals() {
        assert!(is_valid_number_token("0"));
        assert!(is_valid_number_token("125"));
        assert!(is_valid_number_token("62.5"));
    }

    #[test]
    fn number_token_rejects_signs_exponents_and_dotted_edges() {
        assert!(!is_valid_number_token(""));
        assert!(!is_valid_number_token("."));
        assert!(!is_valid_number_token(".5"));
        assert!(!is_valid_number_token("5."));
        assert!(!is_valid_number_token("+5"));
        assert!(!is_valid_number_token("-5"));
        assert!(!is_valid_number_token("1e3"));
        assert!(!is_valid_number_token("1.2.3"));
    }

    // ----- parse_token -------------------------------------------------------

    #[test]
    fn parse_token_handles_each_prefix_case_insensitively() {
        assert_eq!(parse_token("SF12"), Some((PresetKey::Sf, 12.0)));
        assert_eq!(parse_token("sf12"), Some((PresetKey::Sf, 12.0)));
        assert_eq!(parse_token("BW125"), Some((PresetKey::Bw, 125.0)));
        assert_eq!(parse_token("bw62.5"), Some((PresetKey::Bw, 62.5)));
        assert_eq!(parse_token("CR5"), Some((PresetKey::Cr, 5.0)));
    }

    #[test]
    fn parse_token_rejects_invalid_inputs() {
        assert_eq!(parse_token(""), None);
        assert_eq!(parse_token("XX12"), None);
        assert_eq!(parse_token("SF"), None);
        assert_eq!(parse_token("SFabc"), None);
        // Non-ASCII first byte must not panic (multi-byte char crosses the
        // first-2-bytes boundary).
        assert_eq!(parse_token("é12"), None);
    }

    // ----- parse_meshcore_preset_tokens --------------------------------------

    #[test]
    fn parse_preset_tokens_accepts_any_order_and_case() {
        let parsed = parse_meshcore_preset_tokens("SF12/BW125/CR5").unwrap();
        assert_eq!(parsed.sf, 12.0);
        assert_eq!(parsed.bw, 125.0);
        assert_eq!(parsed.cr, 5.0);

        let reordered = parse_meshcore_preset_tokens("cr5/sf7/bw62.5").unwrap();
        assert_eq!(reordered.sf, 7.0);
        assert_eq!(reordered.bw, 62.5);
        assert_eq!(reordered.cr, 5.0);
    }

    #[test]
    fn parse_preset_tokens_rejects_non_sf_bw_cr_inputs() {
        assert!(parse_meshcore_preset_tokens("MediumFast").is_none());
        assert!(parse_meshcore_preset_tokens("").is_none());
        assert!(parse_meshcore_preset_tokens("SF12/BW125").is_none());
        assert!(parse_meshcore_preset_tokens("SF12/BW125/CR5/extra").is_none());
        // Duplicate token rejected to avoid silently dropping ambiguous input.
        assert!(parse_meshcore_preset_tokens("SF12/SF12/CR5").is_none());
    }

    // ----- bw_to_short_code --------------------------------------------------

    #[test]
    fn bw_short_code_matches_canonical_table() {
        assert_eq!(bw_to_short_code(62.0), Some("Na"));
        assert_eq!(bw_to_short_code(62.5), Some("Na"));
        assert_eq!(bw_to_short_code(125.0), Some("St"));
        assert_eq!(bw_to_short_code(250.0), Some("Wi"));
        assert_eq!(bw_to_short_code(500.0), None);
        assert_eq!(bw_to_short_code(31.0), None);
    }

    // ----- format_number -----------------------------------------------------

    #[test]
    fn format_number_drops_decimal_for_integers() {
        assert_eq!(format_number(0.0), "0");
        assert_eq!(format_number(62.0), "62");
        assert_eq!(format_number(125.0), "125");
    }

    #[test]
    fn format_number_keeps_decimal_for_fractions() {
        assert_eq!(format_number(0.5), "0.5");
        assert_eq!(format_number(62.5), "62.5");
    }

    // ----- resolve_meshcore_preset_display -----------------------------------

    #[test]
    fn resolve_returns_none_for_non_sf_bw_cr_input() {
        assert!(resolve_meshcore_preset_display("MediumFast", None).is_none());
        assert!(resolve_meshcore_preset_display("", None).is_none());
    }

    #[test]
    fn resolve_au_nz_wide_at_915mhz() {
        let got = resolve_meshcore_preset_display("SF10/BW250/CR5", Some(915.0)).unwrap();
        assert_eq!(got.long_name, Some("AU/NZ Wide"));
        assert_eq!(got.short_code, Some("Wi"));
        assert_eq!(got.display_string, "AU/NZ Wide");
    }

    #[test]
    fn resolve_au_nz_narrow_at_915mhz() {
        let got = resolve_meshcore_preset_display("SF10/BW62/CR5", Some(915.0)).unwrap();
        assert_eq!(got.long_name, Some("AU/NZ Narrow"));
        assert_eq!(got.short_code, Some("Na"));
        assert_eq!(got.display_string, "AU/NZ Narrow");
    }

    #[test]
    fn resolve_eu_uk_wide_at_868mhz() {
        let got = resolve_meshcore_preset_display("SF11/BW250/CR5", Some(868.0)).unwrap();
        assert_eq!(got.long_name, Some("EU/UK Wide"));
        assert_eq!(got.short_code, Some("Wi"));
        assert_eq!(got.display_string, "EU/UK Wide");
    }

    #[test]
    fn resolve_eu_uk_narrow_at_868mhz() {
        let got = resolve_meshcore_preset_display("SF8/BW62/CR8", Some(868.0)).unwrap();
        assert_eq!(got.long_name, Some("EU/UK Narrow"));
        assert_eq!(got.short_code, Some("Na"));
        assert_eq!(got.display_string, "EU/UK Narrow");
    }

    #[test]
    fn resolve_cz_sk_narrow_below_900mhz() {
        let got = resolve_meshcore_preset_display("SF7/BW62/CR5", Some(868.0)).unwrap();
        assert_eq!(got.long_name, Some("CZ/SK Narrow"));
        assert_eq!(got.short_code, Some("Na"));
        assert_eq!(got.display_string, "CZ/SK Narrow");
    }

    #[test]
    fn resolve_us_ca_narrow_at_or_above_900mhz() {
        let got915 = resolve_meshcore_preset_display("SF7/BW62/CR5", Some(915.0)).unwrap();
        assert_eq!(got915.long_name, Some("US/CA Narrow"));
        let got_boundary = resolve_meshcore_preset_display("SF7/BW62/CR5", Some(900.0)).unwrap();
        assert_eq!(got_boundary.long_name, Some("US/CA Narrow"));
    }

    #[test]
    fn resolve_unknown_freq_skips_gated_named_match() {
        let got = resolve_meshcore_preset_display("SF7/BW62/CR5", None).unwrap();
        assert_eq!(got.long_name, None);
        assert_eq!(got.short_code, Some("Na"));
        assert_eq!(got.display_string, "BW62/SF7/CR5");
    }

    #[test]
    fn resolve_unknown_bw_has_no_short_code() {
        let got = resolve_meshcore_preset_display("SF12/BW500/CR7", None).unwrap();
        assert_eq!(got.long_name, None);
        assert_eq!(got.short_code, None);
        assert_eq!(got.display_string, "BW500/SF12/CR7");
    }

    #[test]
    fn resolve_125khz_falls_back_to_st() {
        let got = resolve_meshcore_preset_display("SF9/BW125/CR6", None).unwrap();
        assert_eq!(got.long_name, None);
        assert_eq!(got.short_code, Some("St"));
        assert_eq!(got.display_string, "BW125/SF9/CR6");
    }

    // ----- abbreviate_preset (MeshCore path) ---------------------------------

    #[test]
    fn abbreviate_returns_meshcore_short_code_for_named_presets() {
        assert_eq!(
            abbreviate_preset("SF11/BW250/CR5", Some(868.0)).as_deref(),
            Some("Wi")
        );
        assert_eq!(
            abbreviate_preset("SF8/BW62/CR8", Some(868.0)).as_deref(),
            Some("Na")
        );
        assert_eq!(
            abbreviate_preset("SF10/BW250/CR5", Some(915.0)).as_deref(),
            Some("Wi")
        );
    }

    #[test]
    fn abbreviate_returns_meshcore_short_code_via_bw_fallback() {
        assert_eq!(
            abbreviate_preset("SF9/BW125/CR6", None).as_deref(),
            Some("St")
        );
        assert_eq!(
            abbreviate_preset("SF7/BW62/CR5", None).as_deref(),
            Some("Na")
        );
    }

    #[test]
    fn abbreviate_returns_none_when_meshcore_bw_unknown() {
        assert_eq!(abbreviate_preset("SF12/BW500/CR7", None), None);
    }

    // ----- abbreviate_preset (Meshtastic path) -------------------------------

    #[test]
    fn abbreviate_resolves_every_named_meshtastic_preset() {
        let cases = [
            ("VeryLongSlow", "VL"),
            ("LongSlow", "LS"),
            ("LongModerate", "LM"),
            ("LongFast", "LF"),
            ("MediumSlow", "MS"),
            ("MediumFast", "MF"),
            ("ShortSlow", "SS"),
            ("ShortFast", "SF"),
            ("ShortTurbo", "ST"),
        ];
        for (input, expected) in cases {
            assert_eq!(
                abbreviate_preset(input, None).as_deref(),
                Some(expected),
                "input={input}"
            );
        }
    }

    #[test]
    fn abbreviate_is_insensitive_to_delimiters_and_case() {
        assert_eq!(abbreviate_preset("LONG_FAST", None).as_deref(), Some("LF"));
        assert_eq!(abbreviate_preset("long-fast", None).as_deref(), Some("LF"));
        assert_eq!(
            abbreviate_preset("Medium_Fast", None).as_deref(),
            Some("MF")
        );
        // Whitespace is stripped along with other non-alphabetic chars,
        // so a human-typed `"Medium Fast"` resolves the same as the
        // CamelCase form.
        assert_eq!(
            abbreviate_preset("Medium Fast", None).as_deref(),
            Some("MF")
        );
    }

    // ----- abbreviate_preset (initials fallback) -----------------------------

    #[test]
    fn abbreviate_falls_back_to_initials_for_unmapped_camelcase() {
        assert_eq!(
            abbreviate_preset("CustomPreset", None).as_deref(),
            Some("CP")
        );
    }

    #[test]
    fn abbreviate_handles_single_word_and_letter_inputs() {
        assert_eq!(abbreviate_preset("Foo", None).as_deref(), Some("FO"));
        assert_eq!(abbreviate_preset("X", None).as_deref(), Some("X?"));
    }

    #[test]
    fn abbreviate_returns_none_for_blank_or_punctuation_only() {
        assert_eq!(abbreviate_preset("", None), None);
        assert_eq!(abbreviate_preset("   ", None), None);
        assert_eq!(abbreviate_preset("___", None), None);
    }

    // ----- normalize_preset_slot --------------------------------------------

    #[test]
    fn normalize_slot_uppercases_and_truncates() {
        assert_eq!(normalize_preset_slot(Some("Na")), "NA");
        assert_eq!(normalize_preset_slot(Some("MF")), "MF");
        assert_eq!(normalize_preset_slot(Some("verylong")), "VE");
        assert_eq!(normalize_preset_slot(Some("  st  ")), "ST");
    }

    #[test]
    fn normalize_slot_emits_placeholder_for_missing_or_empty() {
        assert_eq!(normalize_preset_slot(None), "??");
        assert_eq!(normalize_preset_slot(Some("")), "??");
        assert_eq!(normalize_preset_slot(Some("   ")), "??");
    }

    // ----- derive_preset_initials -------------------------------------------

    #[test]
    fn derive_initials_handles_token_count_branches() {
        assert_eq!(derive_preset_initials(""), None);
        assert_eq!(derive_preset_initials("___"), None);
        assert_eq!(derive_preset_initials("Foo"), Some("FO".to_string()));
        assert_eq!(derive_preset_initials("X"), Some("X?".to_string()));
        assert_eq!(
            derive_preset_initials("CustomPreset"),
            Some("CP".to_string())
        );
        assert_eq!(
            derive_preset_initials("Three Word Name"),
            Some("TW".to_string())
        );
    }
}
