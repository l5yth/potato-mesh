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
require "ipaddr"
require "potato_mesh/sanitizer"

RSpec.describe PotatoMesh::Sanitizer do
  describe ".string_or_nil" do
    it "returns trimmed strings or nil" do
      expect(described_class.string_or_nil("  value \n")).to eq("value")
      expect(described_class.string_or_nil(" \t ")).to be_nil
      expect(described_class.string_or_nil(nil)).to be_nil
      expect(described_class.string_or_nil(123)).to eq("123")
    end
  end

  describe ".sanitize_instance_domain" do
    it "rejects invalid domains" do
      expect(described_class.sanitize_instance_domain(nil)).to be_nil
      expect(described_class.sanitize_instance_domain(" ")).to be_nil
      expect(described_class.sanitize_instance_domain("example")).to be_nil
      expect(described_class.sanitize_instance_domain("example.org/")).to be_nil
      expect(described_class.sanitize_instance_domain("example .org")).to be_nil
      expect(described_class.sanitize_instance_domain("mesh_instance.example")).to be_nil
      expect(described_class.sanitize_instance_domain("example.org:70000")).to be_nil
      expect(described_class.sanitize_instance_domain("[::1")).to be_nil
    end

    it "normalises valid domains" do
      expect(described_class.sanitize_instance_domain(" Example.Org. ")).to eq("example.org")
      expect(described_class.sanitize_instance_domain("Example.Org:443")).to eq("example.org:443")
      expect(described_class.sanitize_instance_domain("[2001:DB8::1]")).to eq("[2001:db8::1]")
      expect(described_class.sanitize_instance_domain("127.0.0.1:8080")).to eq("127.0.0.1:8080")
    end

    it "preserves case when requested" do
      expect(described_class.sanitize_instance_domain("Mesh.Example", downcase: false)).to eq("Mesh.Example")
      expect(described_class.sanitize_instance_domain("[2001:DB8::1]", downcase: false)).to eq("[2001:DB8::1]")
    end
  end

  describe ".instance_domain_host" do
    it "extracts hosts from literal and host:port values" do
      expect(described_class.instance_domain_host("example.com:443")).to eq("example.com")
      expect(described_class.instance_domain_host("[::1]:9000")).to eq("::1")
      expect(described_class.instance_domain_host("::1")).to eq("::1")
      expect(described_class.instance_domain_host("bad:port:name")).to eq("bad:port:name")
      expect(described_class.instance_domain_host("[::1:invalid")).to be_nil
    end
  end

  describe ".ip_from_domain" do
    it "parses valid IP literals and rejects hostnames" do
      expect(described_class.ip_from_domain("127.0.0.1")).to eq(IPAddr.new("127.0.0.1"))
      expect(described_class.ip_from_domain("[2001:db8::1]:443")).to eq(IPAddr.new("2001:db8::1"))
      expect(described_class.ip_from_domain("example.org")).to be_nil
    end
  end

  describe "sanitised configuration accessors" do
    before do
      allow(PotatoMesh::Config).to receive_messages(
        site_name: "  Spec Mesh  ",
        announcement: "  Next Meetup  ",
        channel: "  #Spec  ",
        frequency: " 915MHz  ",
        contact_link: "  #room:example.org  ",
        max_distance_km: 42,
      )
    end

    it "provides trimmed strings" do
      expect(described_class.sanitized_site_name).to eq("Spec Mesh")
      expect(described_class.sanitized_announcement).to eq("Next Meetup")
      expect(described_class.sanitized_channel).to eq("#Spec")
      expect(described_class.sanitized_frequency).to eq("915MHz")
      expect(described_class.sanitized_contact_link).to eq("#room:example.org")
      expect(described_class.sanitized_contact_link_url).to eq("https://matrix.to/#/#room:example.org")
      expect(described_class.sanitized_max_distance_km).to eq(42)
    end

    it "returns nil when the contact link is blank" do
      allow(PotatoMesh::Config).to receive(:contact_link).and_return(" \t ")

      expect(described_class.sanitized_contact_link).to be_nil
      expect(described_class.sanitized_contact_link_url).to be_nil
    end

    it "returns nil when the announcement is blank" do
      allow(PotatoMesh::Config).to receive(:announcement).and_return("  ")

      expect(described_class.sanitized_announcement).to be_nil
    end

    it "returns nil when the distance is not positive" do
      allow(PotatoMesh::Config).to receive(:max_distance_km).and_return(0)

      expect(described_class.sanitized_max_distance_km).to be_nil
    end

    it "returns nil when the distance is not numeric" do
      allow(PotatoMesh::Config).to receive(:max_distance_km).and_return("far")

      expect(described_class.sanitized_max_distance_km).to be_nil
    end
  end

  describe ".sanitized_string" do
    it "always returns a string representation" do
      expect(described_class.sanitized_string(:symbol)).to eq("symbol")
    end
  end
end
