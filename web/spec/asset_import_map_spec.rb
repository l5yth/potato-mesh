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

  # ---------------------------------------------------------------------------
  # View-scoped module preload (frontend perf regression). A tree with import
  # edges so the closure walk has something to follow.
  # ---------------------------------------------------------------------------
  describe "view-scoped preload" do
    around do |example|
      Dir.mktmpdir("potato-mesh-closure-") do |dir|
        @root = dir
        FileUtils.mkdir_p(File.join(dir, "app", "sub"))
        FileUtils.mkdir_p(File.join(dir, "app", "__tests__"))
        File.write(File.join(dir, "background.js"), "// classic top-level script")
        # index → main (static). main statically imports ../background (a classic
        # top-level script, one dir up), re-exports ./config, imports a specifier
        # that escapes the served tree (dropped), and dynamic-imports ./sub/lazy
        # (excluded — lazy). other-page is unreachable from index.
        File.write(File.join(dir, "app", "index.js"), "import { boot } from './main.js';\n")
        File.write(
          File.join(dir, "app", "main.js"),
          "import '../background.js';\nexport { cfg } from './config.js';\n" \
          "import '../../../escapes-tree.js';\nimport('./sub/lazy.js');\n",
        )
        File.write(File.join(dir, "app", "config.js"), "// leaf module")
        File.write(File.join(dir, "app", "sub", "lazy.js"), "// lazily imported leaf")
        File.write(File.join(dir, "app", "other-page.js"), "import './config.js';\n")
        File.write(File.join(dir, "app", "__tests__", "index.test.js"), "import '../index.js';\n")
        example.run
      end
    end

    describe ".import_specifiers" do
      it "captures static, re-export, and bare side-effect relative specifiers" do
        source = <<~JS
          import a from './static.js';
          export { b } from './reexport.js';
          import './side-effect.js';
          import x from 'leaflet';
        JS
        expect(described_class.import_specifiers(source)).to contain_exactly(
          "./static.js", "./reexport.js", "./side-effect.js"
        )
        # A bare specifier (a global dependency, e.g. Leaflet) is not relative and
        # is therefore excluded.
        expect(described_class.import_specifiers(source)).not_to include("leaflet")
      end

      it "excludes dynamic import() specifiers (lazy, not part of the boot graph)" do
        source = <<~JS
          import a from './static.js';
          const c = import('./dynamic.js');
          if (x) { import("./conditional.js"); }
        JS
        expect(described_class.import_specifiers(source)).to eq(["./static.js"])
        expect(described_class.import_specifiers(source)).not_to include("./dynamic.js")
        expect(described_class.import_specifiers(source)).not_to include("./conditional.js")
      end

      it "de-duplicates repeated specifiers" do
        source = "import { a } from './x.js';\nimport { b } from './x.js';\n"
        expect(described_class.import_specifiers(source)).to eq(["./x.js"])
      end
    end

    describe ".resolve_relative_module" do
      it "resolves ./ and ../ against the importer's directory" do
        expect(described_class.resolve_relative_module("/assets/js/app/index.js", "./main.js")).to eq("/assets/js/app/main.js")
        expect(described_class.resolve_relative_module("/assets/js/app/main.js", "../background.js")).to eq("/assets/js/background.js")
      end

      it "returns nil when the specifier escapes the served tree" do
        expect(described_class.resolve_relative_module("/assets/js/app/index.js", "../../etc/passwd")).to be_nil
      end
    end

    describe ".import_closure" do
      it "returns the transitive static closure reachable from the entry, cycle-safe" do
        closure = described_class.import_closure(@root, ["/assets/js/app/index.js"])
        expect(closure).to contain_exactly(
          "/assets/js/app/index.js",
          "/assets/js/app/main.js",
          "/assets/js/app/config.js",
          "/assets/js/background.js",
        )
      end

      it "excludes a dynamically-imported module (lazy, loaded on demand — not preloaded)" do
        # main.js does `import('./sub/lazy.js')`, so the lazy module is not part of
        # the synchronous boot graph and must stay out of the preload closure.
        closure = described_class.import_closure(@root, ["/assets/js/app/index.js"])
        expect(closure).not_to include("/assets/js/app/sub/lazy.js")
      end

      it "excludes modules not reachable from the entry (other pages' graphs)" do
        closure = described_class.import_closure(@root, ["/assets/js/app/index.js"])
        expect(closure).not_to include("/assets/js/app/other-page.js")
      end

      it "skips a relative import that escapes the served tree" do
        # main.js imports '../../../escapes-tree.js', which resolves outside
        # /assets/js; resolve_relative_module returns nil so it is never queued.
        closure = described_class.import_closure(@root, ["/assets/js/app/index.js"])
        expect(closure).not_to include(a_string_including("escapes-tree"))
      end

      it "never follows an import into a __tests__ module" do
        closure = described_class.import_closure(@root, ["/assets/js/app/index.js"])
        expect(closure).not_to include(a_string_including("__tests__"))
      end

      it "skips entries outside the served tree and missing files" do
        closure = described_class.import_closure(
          @root, ["/elsewhere/x.js", "/assets/js/app/missing.js", "/assets/js/app/config.js"]
        )
        expect(closure).to eq(["/assets/js/app/config.js"])
      end

      it "returns an empty list when the js root is absent" do
        expect(described_class.import_closure(File.join(@root, "nope"), ["/assets/js/app/index.js"])).to eq([])
      end
    end

    describe ".preload_html_for" do
      it "emits version-stamped modulepreload links for the entry's app-module closure only" do
        html = described_class.preload_html_for(@root, "1.2.3", ["/assets/js/app/index.js"])
        expect(html).to include(%(<link rel="modulepreload" href="/assets/js/app/index.js?v=1.2.3">))
        expect(html).to include(%(<link rel="modulepreload" href="/assets/js/app/config.js?v=1.2.3">))
        # A dynamically-imported (lazy) module is not preloaded.
        expect(html).not_to include("sub/lazy.js")
        # An unreachable page module is not preloaded (the fix).
        expect(html).not_to include("other-page.js")
        # A classic top-level script pulled in transitively is still not emitted
        # as a module preload (it is loaded as an ordinary <script>).
        expect(html).not_to include("background.js")
      end

      it "is stable across repeated calls (memoized per root/version/entries)" do
        first = described_class.preload_html_for(@root, "7.0.0", ["/assets/js/app/index.js"])
        second = described_class.preload_html_for(@root, "7.0.0", ["/assets/js/app/index.js"])
        expect(second).to equal(first)
      end
    end
  end
end
