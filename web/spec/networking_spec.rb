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
