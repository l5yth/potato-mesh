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

require "base64"
require "ipaddr"
require "json"
require "openssl"
require "socket"
require "uri"
require_relative "federation_fake_peers"

# Federation peers on real sockets for specs: listeners on 127.0.0.1 that
# the app's unchanged transport reaches, Net::HTTP, TLS verification and
# timeouts included. Every peer domain resolves to 127.0.0.1, and each
# request's port is replaced by the port of the listener the spec maps its
# host and scheme to, so +https://peer.invalid+ reaches a TLS listener and
# +http://peer.invalid+ a plain one. A plain or TLS listener answers through
# a {FederationFakePeers::Fed}, as the in-process fake federation does.
# Nothing listens beyond the loopback, and no request leaves it.
module LocalFederationPeers
  # The address every listener binds and every request is pinned to.
  LOOPBACK = "127.0.0.1"

  # Seconds a listener waits for a request before it gives up on it.
  READ_SECONDS = 5

  # A self-signed certificate naming +hosts+, as an operator without a CA
  # would serve.
  #
  # @param hosts [Array<String>] DNS names the certificate covers.
  # @return [Array(OpenSSL::PKey::RSA, OpenSSL::X509::Certificate)] key and
  #   certificate.
  def self.self_signed_certificate(*hosts)
    key = OpenSSL::PKey::RSA.new(2048)
    cert = OpenSSL::X509::Certificate.new
    cert.version = 2
    cert.serial = rand(1 << 62)
    cert.subject = cert.issuer = OpenSSL::X509::Name.parse("/CN=#{hosts.first}")
    cert.public_key = key.public_key
    cert.not_before = Time.now - 60
    cert.not_after = Time.now + 3600
    extensions = OpenSSL::X509::ExtensionFactory.new(cert, cert)
    cert.add_extension(extensions.create_extension("subjectAltName", hosts.map { |host| "DNS:#{host}" }.join(",")))
    cert.sign(key, OpenSSL::Digest::SHA256.new)
    [key, cert]
  end

  # A listening socket on a free loopback port. Built from +Socket+ itself:
  # the fake federation stubs the +TCPSocket+ constructors, which
  # +TCPServer+ inherits.
  #
  # @return [Socket] the bound, listening socket.
  def self.server_socket
    socket = Socket.new(:INET, :STREAM)
    socket.bind(Socket.sockaddr_in(0, LOOPBACK))
    socket.listen(16)
    socket
  end

  # A loopback port nothing listens on, so a connection to it is refused.
  #
  # @return [Integer] port number.
  def self.refused_port
    server = server_socket
    server.local_address.ip_port
  ensure
    server&.close
  end

  # +uri+ aimed at the listener +ports+ maps its host and scheme to, or its
  # scheme alone.
  #
  # @param uri [URI::Generic] the request URI the app built.
  # @param ports [Hash{Array(String, String), String => Integer}] listener
  #   ports by +[host, scheme]+ or by scheme.
  # @return [URI::Generic] a copy carrying the listener's port.
  def self.retarget(uri, ports)
    port = ports.fetch([uri.host, uri.scheme]) { ports.fetch(uri.scheme) }
    uri.dup.tap { |copy| copy.port = port }
  end

  # Read one HTTP/1.1 request.
  #
  # @param socket [IO] a plain or TLS socket.
  # @param buffer [String] bytes already read from it.
  # @return [Array(String, String, Hash{String => String}, String)] method,
  #   request target, lower-cased headers and body.
  def self.read_request(socket, buffer = +"")
    buffer << socket.readpartial(16_384) until buffer.include?("\r\n\r\n")
    head, body = buffer.split("\r\n\r\n", 2)
    request_line, *header_lines = head.split("\r\n")
    method, target, = request_line.split(" ", 3)
    headers = header_lines.to_h do |line|
      name, value = line.split(":", 2)
      [name.strip.downcase, value.to_s.strip]
    end
    body << socket.readpartial(16_384) while body.bytesize < headers["content-length"].to_i
    [method, target, headers, body]
  end

  # Write one HTTP/1.1 response and end the exchange.
  #
  # @param socket [IO] a plain or TLS socket.
  # @param status [Integer] status code.
  # @param headers [Hash{String => String}] extra response headers.
  # @param body [String, Object] body, JSON-encoded unless a String.
  # @return [void]
  def self.write_response(socket, status, headers, body)
    payload = body.is_a?(String) ? body : JSON.generate(body)
    lines = ["HTTP/1.1 #{status} spec", "Content-Type: application/json", "Content-Length: #{payload.bytesize}", "Connection: close"]
    headers.each { |name, value| lines << "#{name}: #{value}" }
    socket.write("#{lines.join("\r\n")}\r\n\r\n#{payload}")
  end

  # The request headers a {FederationFakePeers::Fed} reads, as Net::HTTP
  # exposes them.
  RequestHeaders = Struct.new(:headers) do
    # @return [Enumerator, Hash] the headers, lower-cased.
    def each_header(&block)
      headers.each(&block)
    end
  end

  # One listener on the loopback, answering each connection on its own
  # thread until {#close}.
  class Listener
    # @return [Integer] the port it listens on.
    attr_reader :port
    # @return [Array<IO>] every connection it accepted, the server side.
    attr_reader :connections
    # @return [Array<String>] TLS handshakes that failed, by their messages.
    attr_reader :tls_errors

    # @param tls [Array(OpenSSL::PKey::RSA, OpenSSL::X509::Certificate), nil]
    #   key and certificate to speak TLS with, nil for plain TCP.
    # @yieldparam socket [IO] each accepted connection, after its TLS
    #   handshake.
    def initialize(tls: nil, &serve)
      @server = LocalFederationPeers.server_socket
      @port = @server.local_address.ip_port
      @tls = tls && OpenSSL::SSL::SSLContext.new.tap { |context| context.key, context.cert = tls }
      @serve = serve
      @connections = []
      @tls_errors = []
      @threads = []
      @mutex = Mutex.new
      @acceptor = Thread.new { accept_loop }
    end

    # Stop listening and close every connection still open.
    #
    # @return [void]
    def close
      @server.close unless @server.closed?
      @acceptor.join(1)
      @mutex.synchronize { @threads.dup }.each { |thread| thread.kill.join(1) }
      @mutex.synchronize { @connections.dup }.each { |socket| socket.close unless socket.closed? }
    end

    # Whether the client closed +socket+ within +seconds+: its end read
    # end of file then. Bytes the client still sends, a TLS alert for one,
    # are read past.
    #
    # @param socket [IO] an accepted connection, the server side.
    # @param within [Numeric] seconds to wait.
    # @return [Boolean] true when the client closed it in time.
    def self.closed_by_client?(socket, within:)
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + within
      loop do
        remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
        return false unless remaining.positive? && IO.select([socket], nil, nil, remaining)

        begin
          socket.read_nonblock(16_384)
        rescue IO::WaitReadable
          next
        rescue EOFError, Errno::ECONNRESET
          return true
        end
      end
    end

    private

    def accept_loop
      loop do
        raw, = @server.accept
        @mutex.synchronize { @threads << Thread.new { handle(raw) } }
      end
    rescue IOError, Errno::EBADF
      # Closed by #close.
    end

    def handle(raw)
      @mutex.synchronize { @connections << raw }
      socket = raw
      if @tls
        socket = OpenSSL::SSL::SSLSocket.new(raw, @tls)
        socket.sync_close = true
        socket.accept
      end
      @serve.call(socket)
    rescue OpenSSL::SSL::SSLError => e
      @mutex.synchronize { @tls_errors << e.message }
    rescue IOError, SystemCallError
      # The client went away.
    end
  end

  # Answer each connection with one request served by +fed+ as +scheme+,
  # then close it. A TLS handshake sent to a plain listener gets an HTTP
  # 400, as a plain web server answers it.
  #
  # @param fed [FederationFakePeers::Fed] the fake peers answering requests.
  # @param scheme [String] +"http"+ or +"https"+, as the listener speaks.
  # @return [Proc] the listener's connection handler.
  def self.fed_handler(fed, scheme)
    lambda do |socket|
      first = socket.readpartial(16_384)
      if first.start_with?("\x16".b)
        write_response(socket, 400, {}, "")
        next
      end

      method, target, headers, body = read_request(socket, first)
      uri = URI.parse("#{scheme}://#{headers.fetch("host")}#{target}")
      status, response_headers, response_body = fed.call(uri, RequestHeaders.new(headers.merge("x-spec-method" => method, "x-spec-body" => body)))
      write_response(socket, status, response_headers, response_body)
    ensure
      socket.close unless socket.closed?
    end
  end

  # Read whatever a connection sends and never answer: a stalled TLS
  # handshake on a TLS port, a request left unanswered on a plain one.
  #
  # @return [Proc] the listener's connection handler.
  def self.stall_handler
    lambda do |socket|
      socket.readpartial(16_384)
      sleep
    end
  end

  # A legacy v1 record of +domain+ as a pre-0.7.0 peer lists it: camelCase
  # wire keys, signed over the v1 canonical, which leaves out every node
  # count (SPEC FS4).
  #
  # @param domain [String] instance domain.
  # @param key [OpenSSL::PKey::RSA] the instance's key.
  # @param counts [Hash{Symbol => Integer}] node counts the record carries.
  # @return [Hash] decoded wire record.
  def self.v1_record(domain, key = FederationFakePeers::KEYS[domain], **counts)
    attributes = FederationFakePeers.attrs(domain, key, version: "v0.5.11")
    canonical = FederationFakePeers::APP.canonical_instance_payload_v1(attributes)
    {
      "id" => attributes[:id], "domain" => domain, "pubkey" => attributes[:pubkey], "name" => attributes[:name],
      "version" => attributes[:version], "channel" => attributes[:channel], "frequency" => attributes[:frequency],
      "latitude" => attributes[:latitude], "longitude" => attributes[:longitude],
      "lastUpdateTime" => attributes[:last_update_time], "isPrivate" => false,
      "nodesCount" => counts[:nodes_count], "meshcoreNodesCount" => counts[:meshcore_nodes_count],
      "meshtasticNodesCount" => counts[:meshtastic_nodes_count],
      "signature" => Base64.strict_encode64(key.sign(OpenSSL::Digest::SHA256.new, canonical)),
    }.compact
  end
end

# Wire the app's federation transport to {LocalFederationPeers} listeners
# for every example of the including group. It builds on the fake
# federation context (logs, database, worker pool, +fed+), then lets
# sockets through again: peer domains resolve to 127.0.0.1, and
# +build_remote_http_client+ runs unchanged on a URI aimed at the listener
# +ports+ maps it to. Listeners opened through +listen+ close after each
# example.
RSpec.shared_context "local federation peers" do
  include_context "fake federation peers"

  let(:ports) { {} }
  let(:listeners) { [] }

  # Open a listener that is closed after the example.
  #
  # @param tls [Array(OpenSSL::PKey::RSA, OpenSSL::X509::Certificate), nil]
  #   key and certificate, nil for plain TCP.
  # @param handler [Proc] connection handler.
  # @return [LocalFederationPeers::Listener] the listener.
  def listen(handler, tls: nil)
    LocalFederationPeers::Listener.new(tls: tls, &handler).tap { |listener| listeners << listener }
  end

  # Requests the fake peers answered over +scheme+.
  #
  # @param scheme [String] +"http"+ or +"https"+.
  # @return [Array<Array(String, Symbol)>] host and kind of each request.
  def served_over(scheme)
    fed.log.select { |entry| entry[:scheme] == scheme }.map { |entry| [entry[:host], entry[:kind]] }
  end

  before do
    allow(TCPSocket).to receive(:open).and_call_original
    allow(Socket).to receive(:tcp).and_call_original

    application = FederationFakePeers::APP
    loopback = [IPAddr.new(LocalFederationPeers::LOOPBACK)]
    allow(application).to receive(:resolve_remote_ip_addresses).and_return(loopback)
    allow_any_instance_of(application).to receive(:resolve_remote_ip_addresses).and_return(loopback)
    map = ports
    allow(application).to receive(:build_remote_http_client).and_wrap_original do |original, uri, ip_address: nil|
      original.call(LocalFederationPeers.retarget(uri, map), ip_address: ip_address)
    end
    allow_any_instance_of(application).to receive(:build_remote_http_client).and_wrap_original do |original, uri, ip_address: nil|
      original.call(LocalFederationPeers.retarget(uri, map), ip_address: ip_address)
    end
  end

  after do
    listeners.each(&:close)
  end
end
