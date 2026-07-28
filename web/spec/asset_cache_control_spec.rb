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

# Unit coverage for the versioned-asset Cache-Control middleware (frontend perf:
# returning-visitor caching, SPEC AV2/AV4).
RSpec.describe PotatoMesh::App::AssetCacheControl do
  # A downstream Rack app returning a configurable response triple.
  def downstream(status: 200, headers: {})
    ->(_env) { [status, headers.dup, ["body"]] }
  end

  # Build a minimal Rack env for the middleware.
  def env_for(method: "GET", path: "/assets/js/app/main.js", query: "v=v1.2.3")
    { "REQUEST_METHOD" => method, "PATH_INFO" => path, "QUERY_STRING" => query }
  end

  def call(app, env)
    described_class.new(app).call(env)
  end

  it "stamps an immutable one-year Cache-Control on a version-busted asset GET" do
    status, headers, = call(downstream, env_for)
    expect(status).to eq(200)
    expect(headers["cache-control"]).to eq("public, max-age=31536000, immutable")
    expect(headers["cache-control"]).to eq(described_class::IMMUTABLE_CACHE_CONTROL)
  end

  it "applies to HEAD requests as well" do
    _, headers, = call(downstream, env_for(method: "HEAD"))
    expect(headers["cache-control"]).to eq(described_class::IMMUTABLE_CACHE_CONTROL)
  end

  it "leaves unversioned assets untouched so they keep revalidation (AV4)" do
    _, headers, = call(downstream, env_for(path: "/assets/img/meshcore.svg", query: ""))
    expect(headers).not_to have_key("cache-control")
  end

  it "ignores an empty ?v= value" do
    _, headers, = call(downstream, env_for(query: "v="))
    expect(headers).not_to have_key("cache-control")
  end

  it "ignores non-GET/HEAD methods" do
    _, headers, = call(downstream, env_for(method: "POST"))
    expect(headers).not_to have_key("cache-control")
  end

  it "ignores paths outside /assets/" do
    _, headers, = call(downstream, env_for(path: "/version"))
    expect(headers).not_to have_key("cache-control")
  end

  it "only caches successful (200) responses" do
    _, headers, = call(downstream(status: 404), env_for)
    expect(headers).not_to have_key("cache-control")
  end

  it "never overwrites an existing Cache-Control, regardless of casing" do
    _, headers, = call(downstream(headers: { "Cache-Control" => "no-store" }), env_for)
    expect(headers["Cache-Control"]).to eq("no-store")
    expect(headers).not_to have_key("cache-control")
  end

  it "passes the downstream status and body through unchanged" do
    status, _, body = call(downstream, env_for)
    expect(status).to eq(200)
    expect(body).to eq(["body"])
  end
end
