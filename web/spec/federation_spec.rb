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

        def debug_log(message, **_metadata)
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
    federation_helpers.instance_variable_set(:@remote_instance_verify_callback, nil)
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

  describe ".remote_instance_verify_callback" do
    let(:callback) { federation_helpers.remote_instance_verify_callback }

    it "memoizes the generated callback" do
      first = federation_helpers.remote_instance_verify_callback
      second = federation_helpers.remote_instance_verify_callback
      expect(second).to equal(first)
    end

    it "allows the handshake to continue when CRLs are unavailable" do
      store_context = instance_double(OpenSSL::X509::StoreContext, error: OpenSSL::X509::V_ERR_UNABLE_TO_GET_CRL)

      expect(callback.call(false, store_context)).to be(true)
      expect(federation_helpers.debug_messages.last).to include("Ignoring TLS CRL retrieval failure")
    end

    it "rejects other verification failures" do
      store_context = instance_double(OpenSSL::X509::StoreContext, error: OpenSSL::X509::V_ERR_CERT_HAS_EXPIRED)

      expect(callback.call(false, store_context)).to be(false)
    end

    it "falls back to the default behavior when the handshake is already valid" do
      expect(callback.call(true, nil)).to be(true)
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
      callback = proc { true }
      allow(federation_helpers).to receive(:remote_instance_verify_callback).and_return(callback)

      http = federation_helpers.build_remote_http_client(uri)

      expect(http.use_ssl?).to be(true)
      expect(http.open_timeout).to eq(timeout)
      expect(http.read_timeout).to eq(timeout)
      expect(http.cert_store).to eq(store)
      expect(http.verify_mode).to eq(OpenSSL::SSL::VERIFY_PEER)
      expect(http.verify_callback).to eq(callback)
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
      allow(federation_helpers).to receive(:remote_instance_verify_callback).and_return(nil)

      http = federation_helpers.build_remote_http_client(uri)

      expect(http.cert_store).to be_nil
      expect(http.verify_callback).to be_nil
    end
  end

  describe ".perform_instance_http_request" do
    let(:uri) { URI.parse("https://remote.example.com/api") }
    let(:http_client) { instance_double(Net::HTTP) }

    before do
      allow(federation_helpers).to receive(:build_remote_http_client).with(uri).and_return(http_client)
    end

    it "wraps errors that omit a message with the error class name" do
      stub_const(
        "RemoteTcpFailure",
        Class.new(StandardError) do
          def message
            ""
          end
        end,
      )

      allow(http_client).to receive(:start).and_raise(RemoteTcpFailure.new)

      expect do
        federation_helpers.send(:perform_instance_http_request, uri)
      end.to raise_error(PotatoMesh::App::InstanceFetchError, "RemoteTcpFailure")
    end

    it "includes the error class name when the message omits it" do
      allow(http_client).to receive(:start).and_raise(OpenSSL::SSL::SSLError.new("handshake failed"))

      expect do
        federation_helpers.send(:perform_instance_http_request, uri)
      end.to raise_error(
        PotatoMesh::App::InstanceFetchError,
        "OpenSSL::SSL::SSLError: handshake failed",
      )
    end

    it "preserves messages that already include the error class" do
      allow(http_client).to receive(:start).and_raise(Net::ReadTimeout.new)

      expect do
        federation_helpers.send(:perform_instance_http_request, uri)
      end.to raise_error(PotatoMesh::App::InstanceFetchError, "Net::ReadTimeout")
    end
  end
end
