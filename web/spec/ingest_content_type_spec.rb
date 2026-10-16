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
require "json"
require "tmpdir"

# An ingest POST body must be declared as JSON, and no path takes a form
# body (SPEC IH1-IH4): the guard ahead of Sinatra answers 415, per route,
# path, method and content type, before any token check and before Rack
# parses the body.
RSpec.describe "Ingest content type" do
  let(:app) { Sinatra::Application }
  let(:api_token) { "ih-spec-token" }
  let(:refusal) { { "error" => "Content-Type must be application/json" } }
  let(:boundary) { "ihspec" }

  # Each ingest route with a JSON body and the route's own answer to it: what
  # a JSON request gets past the guard. +/api/ingestors+ refuses +{}+ as an
  # invalid payload and +/api/instances+ as an invalid domain, before any
  # write or fetch.
  let(:route_answers) do
    {
      "/api/nodes" => ["{}", 201],
      "/api/messages" => ["[]", 201],
      "/api/positions" => ["[]", 201],
      "/api/neighbors" => ["[]", 201],
      "/api/telemetry" => ["[]", 201],
      "/api/waypoints" => ["[]", 201],
      "/api/traces" => ["[]", 201],
      "/api/ingestors" => ["{}", 400],
      "/api/instances" => ["{}", 400],
    }
  end

  around do |example|
    original_token = ENV["API_TOKEN"]
    ENV["API_TOKEN"] = api_token
    example.run
  ensure
    original_token.nil? ? ENV.delete("API_TOKEN") : ENV["API_TOKEN"] = original_token
  end

  before do
    # +/api/instances+ answers 404 while federation is off; with it on, a
    # +{}+ body stops at the route's domain check.
    allow(PotatoMesh::Config).to receive(:federation_enabled?).and_return(true)
  end

  # A multipart body with one file part, which Rack's parser would write to
  # a temporary file.
  #
  # @return [String] the request body.
  def multipart_body
    "--#{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"part.bin\"\r\n" \
    "Content-Type: application/octet-stream\r\n\r\n#{"A" * 4096}\r\n--#{boundary}--\r\n"
  end

  # Send +body+ to +path+ by +method+, declared as +content_type+.
  #
  # @param method [String] request method.
  # @param path [String] request path.
  # @param body [String] raw request body.
  # @param content_type [String, nil] the Content-Type; nil sends none.
  # @param token [Boolean] whether to send the bearer token.
  # @return [void]
  def request_typed(method, path, body, content_type, token: true)
    # An explicit :input keeps rack-test from declaring a form itself.
    env = { input: body }
    env["CONTENT_TYPE"] = content_type if content_type
    env["HTTP_AUTHORIZATION"] = "Bearer #{api_token}" if token
    # A URI would read a leading "//" as a host; the server passes it on as
    # the path.
    env["PATH_INFO"] = path if path.start_with?("//")
    custom_request(method, path, {}, env)
  end

  # POST +body+ to +path+ declared as +content_type+.
  #
  # @param path [String] request path.
  # @param body [String] raw request body.
  # @param content_type [String, nil] the Content-Type; nil sends none.
  # @param token [Boolean] whether to send the bearer token.
  # @return [void]
  def post_typed(path, body, content_type, token: true)
    request_typed("POST", path, body, content_type, token: token)
  end

  # Run the block with TMPDIR pointing at +dir+.
  #
  # @param dir [String] temporary directory to use.
  # @return [void]
  def with_tmpdir(dir)
    previous = ENV["TMPDIR"]
    ENV["TMPDIR"] = dir
    yield
  ensure
    previous.nil? ? ENV.delete("TMPDIR") : ENV["TMPDIR"] = previous
  end

  # Expect the guard's 415, and that Sinatra never parsed the request.  A
  # HEAD answer carries no body.
  #
  # @param label [String] what the failure message names.
  # @return [void]
  def expect_refused(label)
    expect(last_response.status).to eq(415), "#{label}: #{last_response.status} #{last_response.body[0, 80]}"
    expect(last_response.content_type).to eq("application/json"), label
    expect(JSON.parse(last_response.body)).to eq(refusal), label unless last_request.head?
    # Sinatra's dispatch stores the form pairs it parsed, an empty list for
    # a JSON body; the guard answers before it runs.
    expect(last_request.env).not_to have_key("rack.request.form_pairs"), label
  end

  {
    "a form" => "application/x-www-form-urlencoded",
    "no Content-Type" => nil,
    "text/plain" => "text/plain",
    "multipart with a file part" => "multipart/form-data; boundary=ihspec",
  }.each do |label, content_type|
    it "answers 415 to #{label} on every ingest route, with or without a token (IH1, IH2)" do
      aggregate_failures do
        route_answers.each do |path, (json_body, _status)|
          body = content_type.to_s.start_with?("multipart/") ? multipart_body : json_body
          [true, false].each do |token|
            post_typed(path, body, content_type, token: token)
            expect_refused("#{path}, #{label}, token=#{token}")
          end
        end
      end
    end
  end

  ["application/json", "application/json; charset=utf-8", "Application/JSON; Charset=UTF-8"].each do |content_type|
    it "lets #{content_type} through to each route's own answer (IH1)" do
      aggregate_failures do
        route_answers.each do |path, (body, status)|
          post_typed(path, body, content_type)
          expect(last_response.status).to eq(status), "#{path}: #{last_response.status} #{last_response.body}"
        end
        post_typed("/api/nodes", "{}", content_type, token: false)
        expect(last_response.status).to eq(403)
      end
    end
  end

  it "writes no multipart part to TMPDIR (IH2)" do
    Dir.mktmpdir("ih-spec-") do |tmp|
      with_tmpdir(tmp) do
        post_typed("/api/nodes", multipart_body, "multipart/form-data; boundary=#{boundary}", token: false)
        post_typed("/api/instances", multipart_body, "multipart/form-data; boundary=#{boundary}", token: false)
      end
      aggregate_failures do
        expect(Dir.children(tmp)).to be_empty
        expect_refused("multipart")
      end
    end
  end

  it "answers inside the logger, the security headers and the route collector (IH2)" do
    used = app.middleware.map(&:first)
    guard = used.index(PotatoMesh::App::IngestContentType)
    expect(guard).to be > used.index(Rack::CommonLogger)
    expect(guard).to be > used.index(PotatoMesh::App::SecurityHeaders)
    expect(guard).to be > used.index(PotatoMesh::App::Prometheus::RouteCollector)
    expect(guard).to be < used.index(::Prometheus::Middleware::Exporter)

    counter = ::Prometheus::Client.registry.get(:http_server_requests_total)
    labels = { code: "415", method: "post", path: PotatoMesh::App::Prometheus::UNMATCHED_ROUTE }
    before = counter.get(labels: labels)
    post_typed("/api/nodes", "{}", "text/plain")
    expect_refused("text/plain")
    expect(last_response.headers["Referrer-Policy"]).to eq("strict-origin-when-cross-origin")
    expect(counter.get(labels: labels)).to eq(before + 1)
  end

  it "guards every spelling of an ingest path, trailing and doubled slashes included (IH3)" do
    aggregate_failures do
      {
        "/api/%6Eodes" => 201, "/api%2Fnodes" => 201, "/api//nodes" => 201, "//api/nodes" => 201,
        "/api/x/../nodes" => 201, "/api/nodes/" => 404, "/api/nodes//" => 404,
      }.each do |path, json_status|
        post_typed(path, "{}", "application/json")
        expect(last_response.status).to eq(json_status), "#{path} as JSON: #{last_response.status}"
        post_typed(path, "{}", "text/plain")
        expect_refused("#{path} as text/plain")
      end
    end
  end

  it "covers every write route the app registers (IH3)" do
    expect(app.routes.keys).to contain_exactly("GET", "HEAD", "POST")
    expect(app.routes["POST"].map { |route| route.first.to_s }).to match_array(PotatoMesh::App::IngestContentType::ROUTES)
  end

  describe "a form body anywhere (IH4)" do
    # A form-parsed type, or every +multipart/*+, with a body to match.
    let(:form_types) do
      {
        "a form" => ["application/x-www-form-urlencoded", "a=1&b=2"],
        "multipart/form-data" => ["multipart/form-data; boundary=ihspec", multipart_body],
        "multipart/related" => ["multipart/related; boundary=ihspec", multipart_body],
        "multipart/mixed" => ["multipart/mixed; boundary=ihspec", multipart_body],
        "multipart/alternative" => ["multipart/alternative; boundary=ihspec", multipart_body],
      }
    end
    let(:paths) { ["/", "/api/nodes/", "/api/events", "/api/nodes", "/api/nodes/!0badc0de", "/metrics", "/no-such-page"] }

    it "answers 415 on every path and method, without a token, and writes nothing to TMPDIR" do
      Dir.mktmpdir("ih-spec-") do |tmp|
        aggregate_failures do
          with_tmpdir(tmp) do
            %w[GET HEAD POST PUT PATCH DELETE OPTIONS LINK UNLINK].each do |method|
              paths.each do |path|
                form_types.each do |label, (content_type, body)|
                  request_typed(method, path, body, content_type, token: false)
                  expect_refused("#{method} #{path}, #{label}")
                end
              end
            end
            paths.each do |path|
              post_typed(path, "a=1&b=2", nil, token: false)
              expect_refused("POST #{path}, no Content-Type")
            end
          end
          expect(Dir.children(tmp)).to be_empty
        end
      end
    end

    it "closes the pre-auth parse on the paths the review named" do
      Dir.mktmpdir("ih-spec-") do |tmp|
        aggregate_failures do
          with_tmpdir(tmp) do
            [%w[POST /], %w[POST /api/nodes/], %w[POST /api/events], %w[GET /api/nodes], %w[PUT /api/nodes]].each do |method, path|
              request_typed(method, path, multipart_body, "multipart/form-data; boundary=#{boundary}", token: false)
              expect_refused("#{method} #{path}, a file part")
            end
            ["battery at 100% now", "&" * 5000].each do |text|
              post_typed("/api/nodes/", "text=#{text}", "application/x-www-form-urlencoded", token: false)
              expect_refused("POST /api/nodes/, a form body of #{text.size} bytes")
            end
          end
          expect(Dir.children(tmp)).to be_empty
        end
      end
    end

    it "lets a request without a body, or with a body Rack does not parse, through" do
      aggregate_failures do
        request_typed("GET", "/api/nodes", "", "application/x-www-form-urlencoded")
        expect(last_response.status).to eq(200)
        request_typed("HEAD", "/api/nodes", "", "multipart/form-data; boundary=#{boundary}")
        expect(last_response.status).to eq(200)
        request_typed("GET", "/api/nodes", "{}", "application/json")
        expect(last_response.status).to eq(200)
        request_typed("POST", "/no-such-page", "", nil)
        expect(last_response.status).to eq(404)
        request_typed("PUT", "/api/nodes", "{}", "text/plain")
        expect(last_response.status).to eq(404)
      end
    end
  end

  describe "the middleware" do
    let(:seen) { [] }
    let(:inner) do
      lambda do |env|
        seen << env["PATH_INFO"]
        [204, {}, []]
      end
    end
    let(:guard) { PotatoMesh::App::IngestContentType.new(inner) }

    # A Rack environment for one request.
    #
    # @param method [String] request method.
    # @param path [String] request path.
    # @param content_type [String, nil] the Content-Type; nil sends none.
    # @param body [String] the request body.
    # @return [Hash] the environment.
    def rack_env(method, path, content_type, body: "{}")
      env = Rack::MockRequest.env_for(path, method: method, input: body)
      # A URI would read a leading "//" as a host; the server passes it on as
      # the path.
      env["PATH_INFO"] = path
      env.delete("CONTENT_TYPE")
      content_type ? env.merge("CONTENT_TYPE" => content_type) : env
    end

    it "passes a JSON body on, with any parameters and in any letter case (IH1)" do
      ["application/json", "application/json; charset=utf-8", "APPLICATION/JSON;CHARSET=UTF-8"].each do |type|
        expect(guard.call(rack_env("POST", "/api/nodes", type)).first).to eq(204)
      end
      expect(seen.size).to eq(3)
    end

    it "answers 415 with a JSON error to any other type, and never calls the app (IH1)" do
      [nil, "", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain",
       "application/octet-stream", "application/jsonp", "application/vnd.api+json"].each do |type|
        status, headers, body = guard.call(rack_env("POST", "/api/traces", type))
        expect(status).to eq(415), type.inspect
        expect(headers).to eq("content-type" => "application/json")
        expect(JSON.parse(body.join)).to eq(refusal)
      end
      expect(seen).to be_empty
    end

    it "applies the ingest rule to trailing and doubled slashes, and to no other path (IH3)" do
      ["/api/nodes/", "/api/nodes//", "//api//nodes", "/api/%6eodes"].each do |path|
        expect(guard.call(rack_env("POST", path, "text/plain")).first).to eq(415), path
      end
      [%w[GET /api/nodes], %w[POST /api/events], %w[POST /api/nodes/!0badc0de], %w[POST /API/nodes],
       %w[PUT /api/nodes], %w[POST /]].each do |method, path|
        expect(guard.call(rack_env(method, path, "text/plain")).first).to eq(204), "#{method} #{path}"
      end
      expect(guard.call(rack_env("POST", "/api/%6Eodes", "application/json")).first).to eq(204)
      expect(seen.size).to eq(7)
    end

    it "answers 415 to a form body by any method on any path, a chunked one included (IH4)" do
      [%w[GET /], %w[PUT /api/events], %w[DELETE /no-such-page], %w[OPTIONS /metrics]].each do |method, path|
        expect(guard.call(rack_env(method, path, "application/x-www-form-urlencoded")).first).to eq(415), method
        expect(guard.call(rack_env(method, path, "multipart/alternative; boundary=x")).first).to eq(415), method
      end
      expect(guard.call(rack_env("POST", "/api/events", nil)).first).to eq(415)
      chunked = rack_env("PUT", "/api/events", "multipart/related; boundary=x").merge("HTTP_TRANSFER_ENCODING" => "chunked")
      chunked.delete("CONTENT_LENGTH")
      expect(guard.call(chunked).first).to eq(415)
      expect(seen).to be_empty
    end

    it "passes a form type without a body, and a body Rack does not parse (IH4)" do
      expect(guard.call(rack_env("GET", "/api/nodes", "application/x-www-form-urlencoded", body: "")).first).to eq(204)
      expect(guard.call(rack_env("POST", "/api/events", "multipart/mixed; boundary=x", body: "")).first).to eq(204)
      expect(guard.call(rack_env("PUT", "/api/events", nil)).first).to eq(204)
      expect(guard.call(rack_env("GET", "/api/nodes", "application/json")).first).to eq(204)
      expect(seen.size).to eq(4)
    end
  end
end
