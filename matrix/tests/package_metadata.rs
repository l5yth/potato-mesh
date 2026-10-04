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

//! Regression guard for the crates.io package metadata (issue #879).
//!
//! crates.io refuses a crate without `description` and `license`, and renders
//! the packaged `README.md` outside the repository, where a `../` link points
//! at a file `cargo package` never ships. Cargo exports the `[package]` fields
//! to every target as `CARGO_PKG_*` compile-time variables, set to an empty
//! string when a field is absent, so these tests fail on a manifest that drops
//! one of them instead of failing at publish time.

/// The crate README exactly as `cargo package` ships it.
const README: &str = include_str!("../README.md");

/// Asserts that a `[package]` field, read through its `CARGO_PKG_*`
/// variable, holds more than whitespace; `name` is the manifest key the
/// failure message reports.
///
/// Takes the value as a parameter rather than inspecting the `env!` literal
/// in place, so the emptiness check stays a runtime assertion with a message
/// naming the missing field. `#[track_caller]` reports the failing test's
/// line instead of this helper's.
#[track_caller]
fn assert_field_set(name: &str, value: &str) {
    assert!(
        !value.trim().is_empty(),
        "Cargo.toml [package] is missing `{name}`"
    );
}

/// `description` is set; crates.io rejects a publish without it.
#[test]
fn manifest_declares_description() {
    assert_field_set("description", env!("CARGO_PKG_DESCRIPTION"));
}

/// `license` is the SPDX identifier of the repository's Apache-2.0 license;
/// crates.io rejects a publish without a license.
#[test]
fn manifest_declares_apache_license() {
    assert_eq!(env!("CARGO_PKG_LICENSE"), "Apache-2.0");
}

/// `repository` is set, so the crates.io page links back to the source.
#[test]
fn manifest_declares_repository() {
    assert_field_set("repository", env!("CARGO_PKG_REPOSITORY"));
}

/// `homepage` is set, so the crates.io page links to the project site.
#[test]
fn manifest_declares_homepage() {
    assert_field_set("homepage", env!("CARGO_PKG_HOMEPAGE"));
}

/// The README carries no `../` link or image; the packaged crate holds only
/// `matrix/`, so such a target is missing on crates.io.
#[test]
fn readme_has_no_parent_relative_links() {
    assert!(
        !README.contains("](../"),
        "matrix/README.md links outside the crate with `](../`"
    );
}
