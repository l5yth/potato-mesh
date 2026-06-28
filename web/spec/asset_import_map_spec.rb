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

# frozen_string_literal: true

require "spec_helper"
require "tmpdir"
require "fileutils"
require "json"

# Unit coverage for the import-map builder (SPEC AV3). The builder is exercised
# against a temporary asset tree so the assertions are independent of the real
# bundle and of the live version string.
RSpec.describe PotatoMesh::App::AssetImportMap do
  around do |example|
    Dir.mktmpdir("potato-mesh-importmap-") do |dir|
      @js_root = dir
      FileUtils.mkdir_p(File.join(dir, "app", "__tests__"))
      File.write(File.join(dir, "theme.js"), "// theme")
      File.write(File.join(dir, "app", "main.js"), "// main")
      File.write(File.join(dir, "app", "config.js"), "// config")
      File.write(File.join(dir, "app", "__tests__", "main.test.js"), "// test")
      example.run
    end
  end

  describe ".module_paths" do
    it "lists served modules as /assets/js paths, sorted" do
      expect(described_class.module_paths(@js_root)).to eq(
        [
          "/assets/js/app/config.js",
          "/assets/js/app/main.js",
          "/assets/js/theme.js",
        ],
      )
    end

    it "excludes __tests__ files" do
      expect(described_class.module_paths(@js_root)).not_to include(
        a_string_including("__tests__"),
      )
    end

    it "returns an empty list when the directory is absent" do
      expect(described_class.module_paths(File.join(@js_root, "nope"))).to eq([])
    end
  end

  describe ".preload_paths" do
    it "lists only the app ES modules (excludes the classic top-level scripts)" do
      # theme.js is a classic <script>, not an ES module, so it must never be
      # emitted as <link rel="modulepreload"> (that would fetch it as a module
      # and double-load it). Only /assets/js/app/** modules are preloaded.
      expect(described_class.preload_paths(@js_root)).to eq(
        [
          "/assets/js/app/config.js",
          "/assets/js/app/main.js",
        ],
      )
    end

    it "excludes __tests__ files" do
      expect(described_class.preload_paths(@js_root)).not_to include(
        a_string_including("__tests__"),
      )
    end

    it "returns an empty list when the directory is absent" do
      expect(described_class.preload_paths(File.join(@js_root, "nope"))).to eq([])
    end
  end

  describe ".preload_html" do
    it "emits one version-stamped modulepreload link per app module" do
      html = described_class.preload_html(@js_root, "1.2.3")

      expect(html).to eq(
        %(<link rel="modulepreload" href="/assets/js/app/config.js?v=1.2.3">\n) +
          %(<link rel="modulepreload" href="/assets/js/app/main.js?v=1.2.3">),
      )
    end

    it "never preloads the classic top-level scripts" do
      expect(described_class.preload_html(@js_root, "1.2.3")).not_to include("theme.js")
    end

    it "is stable across repeated calls (memoized per root/version)" do
      first = described_class.preload_html(@js_root, "7.0.0")
      second = described_class.preload_html(@js_root, "7.0.0")

      expect(second).to equal(first)
    end
  end

  describe ".document" do
    it "maps each module path to its version-stamped URL" do
      doc = described_class.document(@js_root, "1.2.3")

      expect(doc).to eq(
        "imports" => {
          "/assets/js/app/config.js" => "/assets/js/app/config.js?v=1.2.3",
          "/assets/js/app/main.js" => "/assets/js/app/main.js?v=1.2.3",
          "/assets/js/theme.js" => "/assets/js/theme.js?v=1.2.3",
        },
      )
    end
  end

  describe ".json" do
    it "emits valid JSON equal to the document" do
      parsed = JSON.parse(described_class.json(@js_root, "9.9.9"))

      expect(parsed).to eq(described_class.document(@js_root, "9.9.9"))
    end

    it "is stable across repeated calls (memoized per root/version)" do
      first = described_class.json(@js_root, "7.0.0")
      second = described_class.json(@js_root, "7.0.0")

      expect(second).to equal(first)
    end
  end
end
