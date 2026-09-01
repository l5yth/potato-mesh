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

  describe ".ip_address_candidates and .discover_local_ip_address with no interfaces" do
    it "returns an empty list when Socket.ip_address_list returns nothing" do
      allow(Socket).to receive(:ip_address_list).and_return([])

      candidates = described_class.ip_address_candidates

      expect(candidates).to eq([])
    end

    it "falls back to 127.0.0.1 when there are no candidate addresses at all" do
      allow(Socket).to receive(:ip_address_list).and_return([])

      result = described_class.discover_local_ip_address

      expect(result).to eq("127.0.0.1")
    end
  end

  describe ".discover_local_ip_address with IPv6-only addresses" do
    it "returns the non-loopback IPv6 address when only IPv6 is available" do
      # Simulate a host that has only a loopback (::1) and a link-local fe80::
      # address – both are non-IPv4, but the link-local candidate is picked
      # as the non-loopback fallback.
      loopback_addr = instance_double(
        Addrinfo,
        ip?: true,
        ipv4?: false,
        ipv4_loopback?: false,
        ipv6_loopback?: true,
        ip_address: "::1",
      )
      link_local_addr = instance_double(
        Addrinfo,
        ip?: true,
        ipv4?: false,
        ipv4_loopback?: false,
        ipv6_loopback?: false,
        ip_address: "fe80::1",
      )

      allow(Socket).to receive(:ip_address_list).and_return([loopback_addr, link_local_addr])

      result = described_class.discover_local_ip_address

      # The first non-loopback address (fe80::1) should be returned.
      expect(result).to eq("fe80::1")
    end

    it "returns the loopback address when every candidate is loopback" do
      loopback_addr = instance_double(
        Addrinfo,
        ip?: true,
        ipv4?: false,
        ipv4_loopback?: false,
        ipv6_loopback?: true,
        ip_address: "::1",
      )

      allow(Socket).to receive(:ip_address_list).and_return([loopback_addr])

      result = described_class.discover_local_ip_address

      expect(result).to eq("::1")
    end
  end

  # ---------------------------------------------------------------------------
  # restricted_ip_address? / embedded_ipv4_addresses — SSRF guard (SPEC SS1/SS2)
  #
  # The guard is table-driven here rather than one example per address: the
  # contract *is* the table, and a per-address +it+ block would be thirty copies
  # of the same assertion. Each row is (address, why). The tables are block
  # locals rather than constants so that generic names like +allowed+ do not
  # land on Object and collide with another spec file.
  # ---------------------------------------------------------------------------
  describe ".restricted_ip_address?" do
    # Addresses that name an internal destination directly. These were already
    # blocked before SS1 and must stay blocked.
    direct_restricted = {
      "127.0.0.1" => "IPv4 loopback",
      "127.1.2.3" => "IPv4 loopback, non-canonical host",
      "10.0.0.1" => "RFC1918 private",
      "172.16.0.1" => "RFC1918 private",
      "192.168.1.1" => "RFC1918 private",
      "169.254.169.254" => "link-local / cloud metadata",
      "0.0.0.0" => "IPv4 unspecified",
      "::" => "IPv6 unspecified",
      "::1" => "IPv6 loopback",
      "fc00::1" => "IPv6 unique local address",
      "fe80::1" => "IPv6 link-local",
      "::ffff:127.0.0.1" => "IPv4-mapped loopback",
      "::ffff:169.254.169.254" => "IPv4-mapped metadata",
      "::ffff:203.0.113.5" => "IPv4-mapped public payload, still reserved ::/16",
      "::127.0.0.1" => "deprecated IPv4-compatible form (RFC4291 §2.5.5.1)",
      "::a9fe:a9fe" => "deprecated IPv4-compatible form, metadata payload",
      "::cb00:7105" => "deprecated IPv4-compatible form, public payload",
    }

    # Ranges Ruby's IPAddr predicates do not classify as internal at all.
    predicate_gap_restricted = {
      "100.64.0.1" => "RFC6598 CGNAT",
      "100.127.255.254" => "RFC6598 CGNAT, upper bound",
      "0.1.2.3" => "RFC1122 \"this network\"",
      "fec0::1" => "RFC3879 deprecated site-local",
    }

    # The reported bypass: an IPv6 address that *embeds* a blocked IPv4 target
    # and reaches it through a transition gateway.
    transition_restricted = {
      "64:ff9b::7f00:1" => "NAT64 well-known prefix -> 127.0.0.1",
      "64:ff9b::a9fe:a9fe" => "NAT64 well-known prefix -> 169.254.169.254",
      "64:ff9b::a00:1" => "NAT64 well-known prefix -> 10.0.0.1",
      "64:ff9b:1::a9fe:a9fe" => "RFC8215 NAT64 local-use prefix, local by definition",
      "2002:7f00:1::" => "6to4 -> 127.0.0.1",
      "2002:a9fe:a9fe::" => "6to4 -> 169.254.169.254",
      "2002:a00:1:1::1" => "6to4 -> 10.0.0.1, non-zero subnet/interface id",
      "2002:a00:1:ffff:ffff:ffff:ffff:ffff" => "6to4 -> 10.0.0.1, maximal suffix",
      "2001:0:4136:e378:8000:63bf:f5ff:fffe" => "Teredo, obfuscated client IPv4 -> 10.0.0.1",
      "2001:0:7f00:1::" => "Teredo, server IPv4 -> 127.0.0.1",
      "2001:db8:1::5efe:a9fe:a9fe" => "RFC5214 ISATAP under a global prefix -> 169.254.169.254",
      "2001:db8:1::200:5efe:7f00:1" => "RFC5214 ISATAP, globally-unique marker -> 127.0.0.1",
      "64:ff9b:0:0:0:5efe:a9fe:a9fe" => "ISATAP riding a prefix the NAT64 rule does not match",
    }

    # Real federation peers. A guard that blocks these has traded an SSRF for an
    # outage, so they are asserted as explicitly as the blocked set.
    allowed = {
      "203.0.113.5" => "public IPv4",
      "8.8.8.8" => "public IPv4",
      "100.63.255.255" => "just below CGNAT",
      "100.128.0.0" => "just above CGNAT",
      "2606:4700:4700::1111" => "public IPv6",
      "2001:db8::1" => "documentation IPv6, outside Teredo /32",
      "64:ff9b::cb00:7105" => "NAT64 -> 203.0.113.5, an IPv4-only peer behind DNS64",
      "2002:cb00:7105::" => "6to4 -> 203.0.113.5",
      "2001:0:4136:e378:8000:63bf:34ff:8efa" => "Teredo, public server and client IPv4",
      # SS1: the predicates reported these internal because IPAddr tests only
      # bits 80..95 == ffff without requiring bits 0..79 to be zero. Both are
      # ordinary global addresses that reach nothing internal, so permitting
      # them retires a stdlib false positive rather than opening a hole. Note
      # which predicate misfires differs with the payload.
      "2606:4700:4700::ffff:a9fe:a9fe" => "global address IPAddr#link_local? misreports",
      "2001:db8:1:2:3:ffff:a00:1" => "global address IPAddr#private? misreports",
    }

    direct_restricted.merge(predicate_gap_restricted).merge(transition_restricted).each do |address, why|
      it "restricts #{address} (#{why})" do
        expect(described_class.restricted_ip_address?(IPAddr.new(address))).to be(true)
      end
    end

    allowed.each do |address, why|
      it "permits #{address} (#{why})" do
        expect(described_class.restricted_ip_address?(IPAddr.new(address))).to be(false)
      end
    end

    it "reports the stdlib predicates it replaces as disagreeing on those addresses" do
      # Pins the SS1 claim itself: the permitted rows above are exactly the
      # cases where the old predicate chain said "restricted" for a reason that
      # does not survive inspection. If a future Ruby fixes IPAddr, this fails
      # and the SS1 prose can be simplified.
      link_local_misread = IPAddr.new("2606:4700:4700::ffff:a9fe:a9fe")
      private_misread = IPAddr.new("2001:db8:1:2:3:ffff:a00:1")

      expect(link_local_misread.link_local?).to be(true)
      expect(private_misread.private?).to be(true)
      expect(described_class.restricted_ip_address?(link_local_misread)).to be(false)
      expect(described_class.restricted_ip_address?(private_misread)).to be(false)
    end
  end

  # ---------------------------------------------------------------------------
  # The decoding helpers are public members of the module, so they carry their
  # own coverage rather than being reached only through restricted_ip_address?.
  # ---------------------------------------------------------------------------
  describe ".embedded_ipv4_addresses" do
    it "returns nothing for an IPv4 address" do
      expect(described_class.embedded_ipv4_addresses(IPAddr.new("10.0.0.1"))).to eq([])
    end

    it "returns nothing for an IPv6 address that encodes no IPv4 destination" do
      expect(described_class.embedded_ipv4_addresses(IPAddr.new("2606:4700:4700::1111"))).to eq([])
    end

    it "decodes the low 32 bits of a NAT64 address" do
      result = described_class.embedded_ipv4_addresses(IPAddr.new("64:ff9b::a9fe:a9fe"))

      expect(result.map(&:to_s)).to eq(["169.254.169.254"])
    end

    it "decodes bits 16..47 of a 6to4 address" do
      result = described_class.embedded_ipv4_addresses(IPAddr.new("2002:cb00:7105:1::1"))

      expect(result.map(&:to_s)).to eq(["203.0.113.5"])
    end

    it "decodes both the server and the obfuscated client of a Teredo address" do
      result = described_class.embedded_ipv4_addresses(
        IPAddr.new("2001:0:4136:e378:8000:63bf:f5ff:fffe"),
      )

      expect(result.map(&:to_s)).to eq(["65.54.227.120", "10.0.0.1"])
    end

    it "decodes an ISATAP identifier riding an unrelated prefix" do
      result = described_class.embedded_ipv4_addresses(IPAddr.new("2001:db8:1::5efe:a9fe:a9fe"))

      expect(result.map(&:to_s)).to eq(["169.254.169.254"])
    end

    it "decodes the globally-unique ISATAP marker as well as the local one" do
      result = described_class.embedded_ipv4_addresses(IPAddr.new("2001:db8:1::200:5efe:7f00:1"))

      expect(result.map(&:to_s)).to eq(["127.0.0.1"])
    end

    it "reports both decodings when a prefix rule and ISATAP both apply" do
      result = described_class.embedded_ipv4_addresses(IPAddr.new("2001:0:1:2:0:5efe:a9fe:a9fe"))

      # Teredo server, Teredo obfuscated client, then the ISATAP payload.
      expect(result.map(&:to_s)).to eq(["0.1.0.2", "86.1.86.1", "169.254.169.254"])
    end
  end

  describe ".ipv4_from_integer" do
    it "builds an IPv4 address from its 32-bit value" do
      result = described_class.ipv4_from_integer(0x7f000001)

      expect(result.to_s).to eq("127.0.0.1")
      expect(result).to be_ipv4
    end
  end
end
