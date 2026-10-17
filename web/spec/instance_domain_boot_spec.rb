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
require "open3"

# An instance without INSTANCE_DOMAIN takes its domain from the host, and the
# socket and resolver libraries return that text as BINARY
# (Addrinfo#ip_address, Resolv.getname). From v1.0.0-rc6 the canonical form
# (SPEC FB3) refused that encoding, so every production boot without
# INSTANCE_DOMAIN exited 1 with "INSTANCE_DOMAIN could not be determined".
RSpec.describe "An instance domain detected from the host" do
  let(:application) { PotatoMesh::Application }

  # Ruby run before the application loads: the host has one private address
  # and no reverse DNS, as a container on Docker's default bridge has.
  # Addrinfo builds the address, so its text carries the encoding a real
  # host's does.
  let(:private_host_prelude) do
    <<~RUBY
      require "socket"
      require "resolv"
      Socket.singleton_class.define_method(:ip_address_list) { [Addrinfo.ip("10.0.2.15")] }
      Resolv.singleton_class.define_method(:getname) { |_address| raise Resolv::ResolvError }
    RUBY
  end

  it "reads the BINARY text of the socket and resolver libraries in its canonical form (FB3)" do
    address = Addrinfo.ip("10.0.2.15").ip_address

    expect(address.encoding).to eq(Encoding::BINARY)
    expect(application.federation_canonical_domain(address)).to eq("10.0.2.15")
    expect(application.federation_canonical_domain("Mesh.Example.org.:8443".b)).to eq("mesh.example.org:8443")
    expect(application.federation_canonical_domain("мэш.рф".b)).to eq("xn--l1ayo.xn--p1ai")
    expect(application.federation_canonical_domain("mesh.\xC3.org".b)).to be_nil
  end

  it "boots in production with INSTANCE_DOMAIN unset" do
    Dir.mktmpdir do |dir|
      env = {
        "XDG_CONFIG_HOME" => File.join(dir, "config"), "XDG_DATA_HOME" => File.join(dir, "data"),
        "FEDERATION" => "0", "APP_ENV" => "production", "RACK_ENV" => "production", "INSTANCE_DOMAIN" => nil,
      }

      # The application loads in a child process, as app.rb loads it.
      _stdout, stderr, status = Open3.capture3(
        env, RbConfig.ruby, "-e", "#{private_host_prelude}require \"./lib/potato_mesh/application\"",
        chdir: File.expand_path("..", __dir__),
      )

      expect(stderr).not_to include("INSTANCE_DOMAIN could not be determined")
      expect(status.success?).to be(true), stderr
    end
  end
end
