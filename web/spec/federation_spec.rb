# frozen_string_literal: true

require "spec_helper"
require "net/http"
require "openssl"
require "uri"

RSpec.describe PotatoMesh::App::Federation do
  subject(:federation_helpers) do
    Class.new do
      extend PotatoMesh::App::Federation

      class << self
        def debug_messages
          @debug_messages ||= []
        end

        def debug_log(message)
          debug_messages << message
        end

        def reset_debug_messages
          @debug_messages = []
        end
      end
    end
  end

  before do
    federation_helpers.instance_variable_set(:@remote_instance_cert_store, nil)
    federation_helpers.reset_debug_messages
  end

  describe ".remote_instance_cert_store" do
    it "initializes the store with default paths and disables CRL checks" do
      store_double = Class.new do
        attr_reader :default_paths_called, :assigned_flags

        def set_default_paths
          @default_paths_called = true
        end

        def flags=(value)
          @assigned_flags = value
        end

        def respond_to_missing?(method_name, include_private = false)
          method_name == :flags= || super
        end
      end.new

      allow(OpenSSL::X509::Store).to receive(:new).and_return(store_double)

      result = federation_helpers.remote_instance_cert_store

      expect(result).to eq(store_double)
      expect(store_double.default_paths_called).to be(true)
      expect(store_double.assigned_flags).to eq(0)
    end

    it "memoizes the generated store" do
      first = federation_helpers.remote_instance_cert_store
      second = federation_helpers.remote_instance_cert_store
      expect(second).to equal(first)
    end

    it "logs and returns nil when initialization fails" do
      allow(OpenSSL::X509::Store).to receive(:new).and_raise(OpenSSL::X509::StoreError, "boom")

      expect(federation_helpers.remote_instance_cert_store).to be_nil
      expect(federation_helpers.debug_messages.last).to include("Failed to initialize certificate store")
    end
  end

  describe ".build_remote_http_client" do
    let(:timeout) { 15 }

    before do
      allow(PotatoMesh::Config).to receive(:remote_instance_http_timeout).and_return(timeout)
    end

    it "configures SSL settings for HTTPS endpoints" do
      uri = URI.parse("https://remote.example.com/api")
      store = OpenSSL::X509::Store.new
      allow(federation_helpers).to receive(:remote_instance_cert_store).and_return(store)

      http = federation_helpers.build_remote_http_client(uri)

      expect(http.use_ssl?).to be(true)
      expect(http.open_timeout).to eq(timeout)
      expect(http.read_timeout).to eq(timeout)
      expect(http.cert_store).to eq(store)
      expect(http.verify_mode).to eq(OpenSSL::SSL::VERIFY_PEER)
      if http.respond_to?(:min_version)
        expect(http.min_version).to eq(:TLS1_2)
      end
    end

    it "omits SSL configuration for HTTP endpoints" do
      uri = URI.parse("http://remote.example.com/api")

      http = federation_helpers.build_remote_http_client(uri)

      expect(http.use_ssl?).to be(false)
      expect(http.cert_store).to be_nil
      expect(http.open_timeout).to eq(timeout)
      expect(http.read_timeout).to eq(timeout)
    end

    it "leaves the certificate store unset when unavailable" do
      uri = URI.parse("https://remote.example.com/api")
      allow(federation_helpers).to receive(:remote_instance_cert_store).and_return(nil)

      http = federation_helpers.build_remote_http_client(uri)

      expect(http.cert_store).to be_nil
    end
  end
end
