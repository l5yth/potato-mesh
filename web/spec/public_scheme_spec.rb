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

# The scheme of the public URLs (SPEC HD4): the one INSTANCE_DOMAIN names,
# else http or https from the forwarded headers as Rack ranks them, else the
# request's own. robots.txt, sitemap.xml, the canonical link, og:image and the
# OG capture all print it.
RSpec.describe "Public URL scheme" do
  let(:app) { Sinatra::Application }
  # What the nginx example forwards, plus a client's own Forwarded header,
  # which nginx passes through unchanged.
  let(:proxied) { { "HTTP_X_FORWARDED_PROTO" => "https", "HTTP_FORWARDED" => "proto=ws" } }

  describe "generated URLs" do
    before do
      allow(PotatoMesh::Config).to receive(:private_mode_enabled?).and_return(false)
      PotatoMesh::OgImage.reset_for_tests!
    end

    after { PotatoMesh::OgImage.reset_for_tests! }

    it "skips a Forwarded proto other than http or https for X-Forwarded-Proto" do
      get "/robots.txt", {}, proxied

      expect(last_response.body).to include("Sitemap: https://spec.mesh.test/sitemap.xml")
    end

    it "prints that scheme in the sitemap, the canonical link and og:image" do
      get "/sitemap.xml", {}, proxied
      expect(last_response.body).to include("<loc>https://spec.mesh.test/</loc>")
      expect(last_response.body).not_to include("ws://")

      get "/", {}, proxied
      expect(last_response.body).to include('<link rel="canonical" href="https://spec.mesh.test/" />')
      expect(last_response.body).to include('<meta property="og:image" content="https://spec.mesh.test/og-image.png" />')
      expect(last_response.body).not_to include("ws://")
    end

    it "navigates the OG capture to the https URL" do
      urls = []
      PotatoMesh::OgImage.capture_strategy = lambda do |url|
        urls << url
        "PNG_BYTES"
      end

      get "/og-image.png", {}, proxied

      expect(last_response).to be_ok
      expect(urls).to eq(["https://spec.mesh.test"])
    end

    it "keeps the scheme INSTANCE_DOMAIN names whatever the headers say" do
      stub_const("PotatoMesh::Application::INSTANCE_DOMAIN_SCHEME", "https")

      get "/robots.txt", {}, { "HTTP_X_FORWARDED_PROTO" => "http", "HTTP_FORWARDED" => "proto=http" }

      expect(last_response.body).to include("Sitemap: https://spec.mesh.test/sitemap.xml")
    end
  end

  describe "PotatoMesh::App::PublicScheme.from_instance_domain" do
    it "returns the http or https scheme a URL names, in lower case" do
      scheme = ->(raw) { PotatoMesh::App::PublicScheme.from_instance_domain(raw) }

      expect(scheme.call("https://mesh.example.org")).to eq("https")
      expect(scheme.call("  HTTP://mesh.example.org:8080 ")).to eq("http")
    end

    it "returns nil for a bare host, another scheme or nothing" do
      scheme = ->(raw) { PotatoMesh::App::PublicScheme.from_instance_domain(raw) }

      expect(scheme.call("mesh.example.org")).to be_nil
      expect(scheme.call("mesh.example.org:8080")).to be_nil
      expect(scheme.call("ws://mesh.example.org")).to be_nil
      expect(scheme.call("")).to be_nil
      expect(scheme.call(nil)).to be_nil
    end
  end

  describe "PotatoMesh::App::PublicScheme.from_request" do
    # The scheme for a request to +url+ with the given extra Rack env.
    #
    # @param env [Hash] extra Rack env entries (headers as +HTTP_*+ keys).
    # @param url [String] the request URL, whose scheme is the fallback.
    # @return [String] the resolved scheme.
    def scheme_for(env = {}, url = "http://app.internal/")
      PotatoMesh::App::PublicScheme.from_request(Rack::MockRequest.env_for(url).merge(env))
    end

    it "falls back to the request's scheme" do
      expect(scheme_for).to eq("http")
      expect(scheme_for({}, "https://app.internal/")).to eq("https")
    end

    it "answers https for a TLS request or X-Forwarded-Ssl, as Rack does" do
      expect(scheme_for("HTTPS" => "on")).to eq("https")
      expect(scheme_for("HTTP_X_FORWARDED_SSL" => "on")).to eq("https")
    end

    it "ranks the last Forwarded proto above X-Forwarded-Proto" do
      expect(scheme_for("HTTP_FORWARDED" => "proto=http;for=1.2.3.4, proto=https", "HTTP_X_FORWARDED_PROTO" => "http")).to eq("https")
    end

    it "skips a WebSocket or unknown proto, in every header" do
      expect(scheme_for("HTTP_FORWARDED" => "proto=wss")).to eq("http")
      expect(scheme_for("HTTP_X_FORWARDED_PROTO" => "https, ws")).to eq("https")
      expect(scheme_for("HTTP_X_FORWARDED_PROTO" => "ftp", "HTTP_X_FORWARDED_SCHEME" => "https")).to eq("https")
      expect(scheme_for({ "HTTP_X_FORWARDED_SCHEME" => "wss" }, "https://app.internal/")).to eq("https")
    end

    it "ignores a Forwarded header Rack cannot parse" do
      expect(scheme_for("HTTP_FORWARDED" => "proto=https;secret=1", "HTTP_X_FORWARDED_PROTO" => "http")).to eq("http")
    end

    it "follows Rack's configured header priorities" do
      original = [Rack::Request.forwarded_priority, Rack::Request.x_forwarded_proto_priority]
      headers = { "HTTP_FORWARDED" => "proto=https", "HTTP_X_FORWARDED_PROTO" => "http", "HTTP_X_FORWARDED_SCHEME" => "https" }
      begin
        Rack::Request.forwarded_priority = [:unknown, :x_forwarded, :forwarded]
        expect(scheme_for(headers)).to eq("http")
        Rack::Request.x_forwarded_proto_priority = [:scheme, :proto, :unknown]
        expect(scheme_for(headers)).to eq("https")
        Rack::Request.x_forwarded_proto_priority = [:unknown]
        expect(scheme_for(headers)).to eq("https")
        Rack::Request.forwarded_priority = []
        expect(scheme_for(headers)).to eq("http")
      ensure
        Rack::Request.forwarded_priority, Rack::Request.x_forwarded_proto_priority = original
      end
    end

    it "answers https when the server names neither web scheme" do
      expect(scheme_for("rack.url_scheme" => "ws")).to eq("https")
      expect(scheme_for("rack.url_scheme" => nil)).to eq("https")
    end
  end
end
