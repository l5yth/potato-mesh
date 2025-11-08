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

RSpec.describe PotatoMesh::Application do
  describe ".canonicalize_configured_instance_domain" do
    subject(:canonicalize) { described_class.canonicalize_configured_instance_domain(input) }

    context "with an IPv6 URL" do
      let(:input) { "http://[::1]" }

      it "retains brackets around the literal" do
        expect(canonicalize).to eq("[::1]")
      end
    end

    context "with an IPv6 URL including a non-default port" do
      let(:input) { "http://[::1]:8080" }

      it "keeps the literal bracketed and appends the port" do
        expect(canonicalize).to eq("[::1]:8080")
      end
    end

    context "with a bare IPv6 literal" do
      let(:input) { "::1" }

      it "wraps the literal in brackets" do
        expect(canonicalize).to eq("[::1]")
      end
    end

    context "with a bare IPv6 literal and port" do
      let(:input) { "::1:9000" }

      it "wraps the literal in brackets and preserves the port" do
        expect(canonicalize).to eq("[::1]:9000")
      end
    end

    context "with an IPv4 literal" do
      let(:input) { "http://127.0.0.1" }

      it "returns the literal without brackets" do
        expect(canonicalize).to eq("127.0.0.1")
      end
    end
  end
end
