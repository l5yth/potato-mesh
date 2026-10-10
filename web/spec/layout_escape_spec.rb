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

# The header's site name and the footer's version print as text (SPEC HD6):
# SITE_NAME is operator text, and a git tag may hold <, >, " and &.
RSpec.describe "Layout escaping" do
  let(:app) { Sinatra::Application }
  let(:site_name) { %(Mesh <i id="sn">x</i> & "q") }

  before do
    allow(PotatoMesh::Config).to receive(:site_name).and_return(site_name)
    stub_const("PotatoMesh::Application::APP_VERSION", %(v1.0.0<b id="ver">z</b>&))
  end

  it "prints SITE_NAME in the header as text" do
    get "/"

    expect(last_response).to be_ok
    expect(last_response.body).to include(
      %(<span class="site-title-text">Mesh &lt;i id=&quot;sn&quot;&gt;x&lt;/i&gt; &amp; &quot;q&quot;</span>),
    )
    expect(last_response.body).not_to include('<i id="sn">')
  end

  it "prints the version in the footer as text" do
    get "/charts"

    expect(last_response).to be_ok
    expect(last_response.body).to include(%(<span class="mono">v1.0.0&lt;b id=&quot;ver&quot;&gt;z&lt;/b&gt;&amp;</span>))
    expect(last_response.body).not_to include(%(<span class="mono">v1.0.0<b id="ver">))
  end

  it "prints SITE_NAME nowhere raw: title, meta and og tags, JSON-LD and the header" do
    get "/"

    expect(last_response.body).not_to include(site_name)
    expect(last_response.body).to include("<title>Mesh &lt;i id=&quot;sn&quot;&gt;x&lt;/i&gt; &amp; &quot;q&quot;</title>")
    expect(last_response.body).to include(%(<meta property="og:site_name" content="Mesh &lt;i id=&quot;sn&quot;&gt;x&lt;/i&gt; &amp; &quot;q&quot;" />))
    expect(last_response.body).to include('"name":"Mesh \\u003ci id=\\"sn\\"\\u003ex\\u003c/i\\u003e \\u0026 \\"q\\""')
  end

  # A version a git tag may carry: a space, both quotes, markup and an
  # ampersand. Every URL that stamps it carries it URL-encoded, the import map
  # stays JSON a script element cannot leave, and the map served is the one the
  # boot hashes for the Content-Security-Policy (SPEC HD6, HD3).
  describe "with a version holding a space, quotes, markup and an ampersand" do
    let(:hostile) { %(v1.0.0 "<>&') }
    let(:encoded) { "v1.0.0%20%22%3C%3E%26%27" }

    before do
      stub_const("PotatoMesh::Application::APP_VERSION", hostile)
    end

    %w[/ /charts].each do |path|
      it "carries it URL-encoded in every ?v= query on #{path}, and nowhere raw" do
        get path

        body = last_response.body
        expect(body.scan("?v=").size).to be > 10
        expect(body.scan("?v=#{encoded}").size).to eq(body.scan("?v=").size)
        expect(body).not_to include(hostile)
        expect(body).to include(%(<span class="mono">v1.0.0 &quot;&lt;&gt;&amp;&#39;</span>))
      end
    end

    it "serves script-safe import-map JSON, byte for byte the map the boot hashes" do
      get "/"

      served = last_response.body[%r{<script type="importmap">(.*?)</script>}m, 1]
      js_root = File.join(Sinatra::Application.settings.public_folder, "assets", "js")
      expect(served).not_to match(/[<>&']/)
      expect(JSON.parse(served)["imports"].values).to all(end_with("?v=#{encoded}"))
      expect(served).to eq(PotatoMesh::App::AssetImportMap.json(js_root, hostile))
    end
  end
end
