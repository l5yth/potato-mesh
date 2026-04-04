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

  describe ".valid_hostname?" do
    it "rejects IPv6 literals because they contain colons" do
      # IPv6 addresses split on ":" produce labels that contain invalid chars or
      # empty strings, so valid_hostname? must return false for them.
      expect(described_class.valid_hostname?("::1")).to be(false)
      expect(described_class.valid_hostname?("2001:db8::1")).to be(false)
      expect(described_class.valid_hostname?("fe80::1%eth0")).to be(false)
    end

    it "tolerates trailing dots because String#split drops the empty trailing element" do
      # Ruby's String#split(".") discards the trailing empty field produced by
      # a terminal dot, so "example.com." is treated identically to
      # "example.com".  sanitize_instance_domain strips trailing dots upstream
      # before delegating to valid_hostname?, so this edge case is handled at
      # the sanitizer level rather than inside valid_hostname? itself.
      expect(described_class.valid_hostname?("example.com.")).to be(true)
    end

    it "sanitize_instance_domain strips trailing dots from hostnames" do
      # End-to-end: the public API normalises trailing dots before validation.
      expect(described_class.sanitize_instance_domain("example.com.")).to eq("example.com")
      expect(described_class.sanitize_instance_domain("Example.Com.")).to eq("example.com")
    end

    it "accepts well-formed hostnames" do
      expect(described_class.valid_hostname?("example.com")).to be(true)
      expect(described_class.valid_hostname?("mesh.example.org")).to be(true)
    end
  end

  describe ".sanitize_instance_domain with unicode input" do
    it "rejects pure unicode domain names without ASCII labels" do
      # The hostname validator only accepts ASCII alphanumeric labels (RFC 1035),
      # so a raw IDN like münchen.de (non-punycode) must be rejected.
      result = described_class.sanitize_instance_domain("münchen.de")
      expect(result).to be_nil
    end
  end

  describe ".ip_from_domain with invalid bracket notation" do
    it "returns nil when the port in bracket notation is not numeric" do
      # "[::1]:notaport" matches the bracket prefix but the port guard in
      # sanitize_instance_domain would reject it; ip_from_domain still tries
      # to extract the host and parse it via instance_domain_host.
      result = described_class.ip_from_domain("[::1]:notaport")
      # instance_domain_host returns nil for an invalid bracket expression
      # because the port portion is non-numeric, so ip_from_domain is nil too.
      expect(result).to be_nil
    end

    it "returns nil for an unterminated bracket expression" do
      expect(described_class.ip_from_domain("[::1")).to be_nil
    end
  end
end
