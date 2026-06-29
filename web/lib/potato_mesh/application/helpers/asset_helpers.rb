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

module PotatoMesh
  module App
    # Builds the JSON import map that version-stamps every served JS module.
    #
    # A +?v=+ query on an entry-point URL (e.g. +index.js+) does **not**
    # propagate to that module's relative +import './main.js'+ statements — the
    # browser resolves them to the bare +/assets/js/app/main.js+ and may serve a
    # stale copy. An import map rewrites those bare module URLs to their
    # version-stamped equivalents, so a release busts the **entire** transitive
    # module graph rather than just the entry points a template references
    # directly (SPEC AV3).
    #
    # A module absent from the map degrades to today's unversioned-but-working
    # load — a missing entry can never break a working import.
    module AssetImportMap
      module_function

      # Enumerate every served JS module under +js_root+ and map each to its
      # cache-busted URL.
      #
      # @param js_root [String] absolute path to the served +/assets/js+ dir.
      # @param version [String] cache-busting token (the application version).
      # @return [Hash{String=>Hash{String=>String}}] the import-map document
      #   (``{"imports" => {"/assets/js/app/main.js" => "...?v=<version>"}}``).
      def document(js_root, version)
        imports = module_paths(js_root).each_with_object({}) do |path, acc|
          acc[path] = "#{path}?v=#{version}"
        end
        { "imports" => imports }
      end

      # Serialize {document} to a compact JSON string, memoized per
      # +[js_root, version]+. Both inputs are constant for the life of the
      # process, so the filesystem is walked at most once per pair.
      #
      # @param js_root [String] absolute path to the served +/assets/js+ dir.
      # @param version [String] cache-busting token (the application version).
      # @return [String] JSON document suitable for a +<script type="importmap">+.
      def json(js_root, version)
        cache = (@json_cache ||= {})
        cache[[js_root, version]] ||= JSON.generate(document(js_root, version))
      end

      # List the served **ES-module** paths to preload — every
      # +/assets/js/app/**+ module, excluding the classic top-level scripts
      # (+theme.js+, +background.js+) which are loaded as ordinary
      # +<script>+ tags, not modules. Preloading a classic script as a module
      # would fetch it a second time, so the preload set is the app graph only.
      #
      # @param js_root [String] absolute path to the served +/assets/js+ dir.
      # @return [Array<String>] sorted ``/assets/js/app/...`` module paths.
      def preload_paths(js_root)
        module_paths(js_root).select { |path| path.start_with?("/assets/js/app/") }
      end

      # Render one +<link rel="modulepreload">+ per app module so the browser
      # fetches the **entire** transitive ES-module graph in parallel rather
      # than discovering it one import-tier at a time (the waterfall that
      # delayed the dashboard's first data paint). Each href is the
      # version-stamped URL — i.e. the import-map **target** — so the preload
      # and the eventual +import+ resolve to the same cache entry. Memoized per
      # +[js_root, version]+ (both constant for the process), mirroring {json}.
      #
      # A module absent here still loads normally on demand, so a missing entry
      # can never break a working import (the same degradation property as the
      # import map, SPEC AV3).
      #
      # @param js_root [String] absolute path to the served +/assets/js+ dir.
      # @param version [String] cache-busting token (the application version).
      # @return [String] newline-joined +<link rel="modulepreload">+ tags.
      def preload_html(js_root, version)
        cache = (@preload_cache ||= {})
        cache[[js_root, version]] ||= preload_paths(js_root)
          .map { |path| %(<link rel="modulepreload" href="#{path}?v=#{version}">) }
          .join("\n")
      end

      # List the absolute asset paths (``/assets/js/...``) of every served
      # module, excluding test files, in a stable sorted order.
      #
      # @param js_root [String] absolute path to the served +/assets/js+ dir.
      # @return [Array<String>] sorted ``/assets/js/...`` module paths; empty
      #   when the directory does not exist.
      def module_paths(js_root)
        return [] unless Dir.exist?(js_root)

        Dir.glob(File.join(js_root, "**", "*.js"))
          .reject { |abs| abs.include?("/__tests__/") }
          .map { |abs| "/assets/js/#{abs.delete_prefix("#{js_root}/")}" }
          .sort
      end
    end

    module Helpers
      # Append the running application version to a static-asset path as a
      # cache-busting query parameter so a new release invalidates the browser
      # cache.
      #
      # Without a buster, browsers keep serving the previously cached JS/CSS
      # after a deploy until the user manually hard-refreshes. The query string
      # is ignored by Sinatra's static-file handler, so the bytes served are
      # unchanged — only the cache key differs per release (see
      # {PotatoMesh::Application::APP_VERSION}).
      #
      # @param path [String] absolute asset path rooted at the public folder,
      #   e.g. ``"/assets/js/app/index.js"`` or ``"/assets/styles/base.css"``.
      # @return [String] the path with a ``?v=<APP_VERSION>`` query appended.
      def asset_url(path)
        "#{path}?v=#{app_constant(:APP_VERSION)}"
      end

      # Render the JSON import map that version-stamps the entire served JS
      # module graph (SPEC AV3). Emitted inside a +<script type="importmap">+
      # in the layout head, before any module loads.
      #
      # @return [String] the import-map JSON document.
      def asset_import_map_json
        PotatoMesh::App::AssetImportMap.json(asset_js_root, app_constant(:APP_VERSION))
      end

      # Render the +<link rel="modulepreload">+ tags that preload the whole
      # served ES-module graph in parallel (so the browser does not walk the
      # import waterfall before the app can fetch its first data). Emitted in the
      # layout head **after** the import map (which must precede any module
      # resolution) and before the module entry point.
      #
      # @return [String] newline-joined modulepreload link tags.
      def asset_modulepreload_tags
        PotatoMesh::App::AssetImportMap.preload_html(asset_js_root, app_constant(:APP_VERSION))
      end

      # Absolute path to the served JavaScript asset directory.
      #
      # @return [String] the ``<public_folder>/assets/js`` directory.
      def asset_js_root
        File.join(settings.public_folder, "assets", "js")
      end
    end
  end
end
