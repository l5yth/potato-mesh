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
