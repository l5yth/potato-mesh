# Copyright (C) 2025 l5yth
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

# Main Sinatra application exposing the Meshtastic node and message archive.
# The daemon in +data/mesh.py+ pushes updates into the SQLite database that
# this web process reads from, providing JSON APIs and a rendered HTML index
# page for human visitors.
require "sinatra"
require "json"
require "sqlite3"
require "fileutils"
require "logger"
require "rack/utils"
require "open3"
require "resolv"
require "socket"
require "time"
require "openssl"
require "base64"
require "prometheus/client"
require "prometheus/client/formats/text"
require "prometheus/middleware/collector"
require "prometheus/middleware/exporter"
require "net/http"
require "uri"
require "ipaddr"
require "set"
require "digest"

# Path to the SQLite database used by the web application.
DB_PATH = ENV.fetch("MESH_DB", File.join(__dir__, "../data/mesh.db"))
# Default timeout applied to SQLite ``busy`` responses in milliseconds.
DB_BUSY_TIMEOUT_MS = ENV.fetch("DB_BUSY_TIMEOUT_MS", "5000").to_i
# Maximum number of SQLite ``busy`` retries before failing the request.
DB_BUSY_MAX_RETRIES = ENV.fetch("DB_BUSY_MAX_RETRIES", "5").to_i
# Base delay in seconds between SQLite ``busy`` retries.
DB_BUSY_RETRY_DELAY = ENV.fetch("DB_BUSY_RETRY_DELAY", "0.05").to_f
# Open the SQLite database with a configured busy timeout.
#
# @param readonly [Boolean] whether to open the database in read-only mode.
# @return [SQLite3::Database]
def open_database(readonly: false)
  SQLite3::Database.new(DB_PATH, readonly: readonly).tap do |db|
    db.busy_timeout = DB_BUSY_TIMEOUT_MS
    db.execute("PRAGMA foreign_keys = ON")
  end
end

# Convenience constant used when filtering stale records.
WEEK_SECONDS = 7 * 24 * 60 * 60
# Default request body size allowed for JSON uploads.
DEFAULT_MAX_JSON_BODY_BYTES = 1_048_576
# Maximum request body size for JSON uploads, configurable via ``MAX_JSON_BODY_BYTES``.
MAX_JSON_BODY_BYTES = begin
    raw = ENV.fetch("MAX_JSON_BODY_BYTES", DEFAULT_MAX_JSON_BODY_BYTES.to_s)
    value = Integer(raw, 10)
    value.positive? ? value : DEFAULT_MAX_JSON_BODY_BYTES
  rescue ArgumentError
    DEFAULT_MAX_JSON_BODY_BYTES
  end
# Fallback version string used when Git metadata is unavailable.
VERSION_FALLBACK = "v0.5.0"
DEFAULT_REFRESH_INTERVAL_SECONDS = 60
REFRESH_INTERVAL_SECONDS = begin
    raw = ENV.fetch("REFRESH_INTERVAL_SECONDS", DEFAULT_REFRESH_INTERVAL_SECONDS.to_s)
    value = Integer(raw, 10)
    value.positive? ? value : DEFAULT_REFRESH_INTERVAL_SECONDS
  rescue ArgumentError
    DEFAULT_REFRESH_INTERVAL_SECONDS
  end
MAP_TILE_FILTER_LIGHT = ENV.fetch(
  "MAP_TILE_FILTER_LIGHT",
  "grayscale(1) saturate(0) brightness(0.92) contrast(1.05)"
)
MAP_TILE_FILTER_DARK = ENV.fetch(
  "MAP_TILE_FILTER_DARK",
  "grayscale(1) invert(1) brightness(0.9) contrast(1.08)"
)
PROM_REPORT_IDS = ENV.fetch("PROM_REPORT_IDS", "")

# Map the comma-separated list of node IDs into a sanitized array.
$prom_report_ids = PROM_REPORT_IDS.split(",").map(&:strip).reject(&:empty?)

# Fetch a configuration string from environment variables.
#
# @param key [String] name of the environment variable to read.
# @param default [String] fallback value returned when the variable is unset or blank.
# @return [String] sanitized configuration value.
def fetch_config_string(key, default)
  value = ENV[key]
  return default if value.nil?

  trimmed = value.strip
  trimmed.empty? ? default : trimmed
end

# Convert a value into a trimmed string or return ``nil`` when blank.
#
# @param value [Object]
# @return [String, nil]
def string_or_nil(value)
  return nil if value.nil?

  str = value.is_a?(String) ? value : value.to_s
  trimmed = str.strip
  trimmed.empty? ? nil : trimmed
end

# Normalise domain strings supplied by remote instances or configuration inputs.
#
# @param value [Object] untrusted domain string.
# @return [String, nil] canonical domain without schemes or paths.
def sanitize_instance_domain(value)
  host = string_or_nil(value)
  return nil unless host

  trimmed = host.strip
  trimmed = trimmed.delete_suffix(".") while trimmed.end_with?(".")
  return nil if trimmed.empty?
  return nil if trimmed.match?(%r{[\s/\\@]})

  trimmed
end

# Extract the hostname component from an instance domain string, handling IPv6
# literals and optional port suffixes.
#
# @param domain [String]
# @return [String, nil]
def instance_domain_host(domain)
  return nil if domain.nil?

  candidate = domain.strip
  return nil if candidate.empty?

  if candidate.start_with?("[")
    match = candidate.match(/\A\[(?<host>[^\]]+)\](?::(?<port>\d+))?\z/)
    return match[:host] if match
    return nil
  end

  host, port = candidate.split(":", 2)
  if port && !host.include?(":") && port.match?(/\A\d+\z/)
    return host
  end

  candidate
end

# Parse an IP address when the provided domain represents an address literal.
#
# @param domain [String]
# @return [IPAddr, nil]
def ip_from_domain(domain)
  host = instance_domain_host(domain)
  return nil unless host

  IPAddr.new(host)
rescue IPAddr::InvalidAddressError
  nil
end

# Attempt to resolve the instance's vanity domain from configuration or reverse
# DNS lookup.
#
# @return [Array<(String, Symbol)>] pair containing the resolved domain (or
#   ``nil``) and the source used (:environment, :reverse_dns, :unknown).
def canonicalize_configured_instance_domain(raw)
  return nil if raw.nil?

  trimmed = raw.to_s.strip
  return nil if trimmed.empty?

  candidate = trimmed

  if candidate.include?("://")
    begin
      uri = URI.parse(candidate)
    rescue URI::InvalidURIError => e
      raise "INSTANCE_DOMAIN must be a valid hostname or URL, but parsing #{candidate.inspect} failed: #{e.message}"
    end

    unless uri.host
      raise "INSTANCE_DOMAIN URL must include a hostname: #{candidate.inspect}"
    end

    if uri.userinfo
      raise "INSTANCE_DOMAIN URL must not include credentials: #{candidate.inspect}"
    end

    if uri.path && !uri.path.empty? && uri.path != "/"
      raise "INSTANCE_DOMAIN URL must not include a path component: #{candidate.inspect}"
    end

    if uri.query || uri.fragment
      raise "INSTANCE_DOMAIN URL must not include query or fragment data: #{candidate.inspect}"
    end

    hostname = uri.hostname
    unless hostname
      raise "INSTANCE_DOMAIN URL must include a hostname: #{candidate.inspect}"
    end

    candidate = hostname
    port = uri.port
    if port && (!uri.respond_to?(:default_port) || uri.default_port.nil? || port != uri.default_port)
      candidate = "#{candidate}:#{port}"
    elsif port && uri.to_s.match?(/:\d+/)
      candidate = "#{candidate}:#{port}"
    end
  end

  sanitized = sanitize_instance_domain(candidate)
  unless sanitized
    raise "INSTANCE_DOMAIN must be a bare hostname (optionally with a port) without schemes or paths: #{raw.inspect}"
  end

  sanitized.downcase
end

def determine_instance_domain
  raw = ENV["INSTANCE_DOMAIN"]
  if raw
    canonical = canonicalize_configured_instance_domain(raw)
    return [canonical, :environment] if canonical
  end

  reverse = sanitize_instance_domain(reverse_dns_domain)
  return [reverse, :reverse_dns] if reverse

  public_ip = discover_public_ip_address
  return [public_ip, :public_ip] if public_ip

  protected_ip = discover_protected_ip_address
  return [protected_ip, :protected_ip] if protected_ip

  [discover_local_ip_address, :local_ip]
end

# Attempt to resolve a hostname via reverse DNS for the current machine.
#
# @return [String, nil] hostname when a reverse DNS entry exists.
def reverse_dns_domain
  Socket.ip_address_list.each do |address|
    next unless address.respond_to?(:ip?) && address.ip?

    loopback =
      (address.respond_to?(:ipv4_loopback?) && address.ipv4_loopback?) ||
      (address.respond_to?(:ipv6_loopback?) && address.ipv6_loopback?)
    next if loopback

    link_local =
      address.respond_to?(:ipv6_linklocal?) && address.ipv6_linklocal?
    next if link_local

    ip = address.ip_address
    next if ip.nil? || ip.empty?

    begin
      hostname = Resolv.getname(ip)
      trimmed = hostname&.strip
      return trimmed unless trimmed.nil? || trimmed.empty?
    rescue Resolv::ResolvError, Resolv::ResolvTimeout, SocketError
      next
    end
  end

  nil
end

# Locate a globally routable IP address exposed on the current host.
#
# @return [String, nil]
def discover_public_ip_address
  address = ip_address_candidates.find { |candidate| public_ip_address?(candidate) }
  address&.ip_address
end

# Locate a private IP address (e.g. RFC1918 or unique local) exposed on the current host.
#
# @return [String, nil]
def discover_protected_ip_address
  address = ip_address_candidates.find { |candidate| protected_ip_address?(candidate) }
  address&.ip_address
end

# Enumerate IP address candidates exposed on the local machine.
#
# @return [Array<Addrinfo>]
def ip_address_candidates
  Socket.ip_address_list.select { |addr| addr.respond_to?(:ip?) && addr.ip? }
end

# Determine whether the supplied address is globally routable.
#
# @param addr [Addrinfo]
# @return [Boolean]
def public_ip_address?(addr)
  ip = ipaddr_from(addr)
  return false unless ip
  return false if loopback_address?(addr, ip)
  return false if link_local_address?(addr, ip)
  return false if private_address?(addr, ip)
  return false if unspecified_address?(ip)

  true
end

# Determine whether the supplied address is suitable for protected network exposure.
#
# @param addr [Addrinfo]
# @return [Boolean]
def protected_ip_address?(addr)
  ip = ipaddr_from(addr)
  return false unless ip
  return false if loopback_address?(addr, ip)
  return false if link_local_address?(addr, ip)

  private_address?(addr, ip)
end

# Convert an Addrinfo into an IPAddr instance for further inspection.
#
# @param addr [Addrinfo]
# @return [IPAddr, nil]
def ipaddr_from(addr)
  ip = addr.ip_address
  return nil if ip.nil? || ip.empty?

  IPAddr.new(ip)
rescue IPAddr::InvalidAddressError
  nil
end

# Determine whether the address is a loopback interface.
#
# @param addr [Addrinfo]
# @param ip [IPAddr]
# @return [Boolean]
def loopback_address?(addr, ip)
  (addr.respond_to?(:ipv4_loopback?) && addr.ipv4_loopback?) ||
    (addr.respond_to?(:ipv6_loopback?) && addr.ipv6_loopback?) ||
    ip.loopback?
end

# Determine whether the address resides within a link-local range.
#
# @param addr [Addrinfo]
# @param ip [IPAddr]
# @return [Boolean]
def link_local_address?(addr, ip)
  (addr.respond_to?(:ipv6_linklocal?) && addr.ipv6_linklocal?) ||
    (ip.respond_to?(:link_local?) && ip.link_local?)
end

# Determine whether the address is private (RFC1918 or unique local).
#
# @param addr [Addrinfo]
# @param ip [IPAddr]
# @return [Boolean]
def private_address?(addr, ip)
  if addr.respond_to?(:ipv4?) && addr.ipv4? && addr.respond_to?(:ipv4_private?)
    addr.ipv4_private?
  else
    ip.private?
  end
end

# Determine whether the address is the unspecified (all zeros) address.
#
# @param ip [IPAddr]
# @return [Boolean]
def unspecified_address?(ip)
  (ip.ipv4? || ip.ipv6?) && ip.to_i.zero?
end

# Determine the current application version using ``git describe`` when
# available.
#
# @return [String] semantic version string for display in the footer.
def determine_app_version
  repo_root = File.expand_path("..", __dir__)
  git_dir = File.join(repo_root, ".git")
  return VERSION_FALLBACK unless File.directory?(git_dir)

  stdout, status = Open3.capture2("git", "-C", repo_root, "describe", "--tags", "--long", "--abbrev=7")
  return VERSION_FALLBACK unless status.success?

  raw = stdout.strip
  return VERSION_FALLBACK if raw.empty?

  match = /\A(?<tag>.+)-(?<count>\d+)-g(?<hash>[0-9a-f]+)\z/.match(raw)
  return raw unless match

  tag = match[:tag]
  count = match[:count].to_i
  hash = match[:hash]
  return tag if count.zero?

  "#{tag}+#{count}-#{hash}"
rescue StandardError
  VERSION_FALLBACK
end

APP_VERSION = determine_app_version

KEYFILE_PATH = File.join(__dir__, ".config", "keyfile")
WELL_KNOWN_RELATIVE_PATH = File.join(".well-known", "potato-mesh")
WELL_KNOWN_STORAGE_ROOT = File.join(__dir__, ".config", "well-known")
LEGACY_PUBLIC_WELL_KNOWN_PATH = File.join(__dir__, "public", WELL_KNOWN_RELATIVE_PATH)
WELL_KNOWN_REFRESH_INTERVAL = 24 * 60 * 60
INSTANCE_SIGNATURE_ALGORITHM = "rsa-sha256"
REMOTE_INSTANCE_HTTP_TIMEOUT = 5
REMOTE_INSTANCE_MAX_NODE_AGE = 86_400
REMOTE_INSTANCE_MIN_NODE_COUNT = 10
FEDERATION_SEED_DOMAINS = ["potatomesh.net"].freeze
FEDERATION_ANNOUNCEMENT_INTERVAL = 24 * 60 * 60

class InstanceFetchError < StandardError; end

def load_or_generate_instance_private_key
  FileUtils.mkdir_p(File.dirname(KEYFILE_PATH))
  if File.exist?(KEYFILE_PATH)
    contents = File.binread(KEYFILE_PATH)
    return [OpenSSL::PKey.read(contents), false]
  end

  key = OpenSSL::PKey::RSA.new(2048)
  File.open(KEYFILE_PATH, File::WRONLY | File::CREAT | File::TRUNC, 0o600) do |file|
    file.write(key.export)
  end
  [key, true]
rescue OpenSSL::PKey::PKeyError, ArgumentError => e
  warn "[warn] failed to load instance private key, generating a new key: #{e.message}"
  key = OpenSSL::PKey::RSA.new(2048)
  File.open(KEYFILE_PATH, File::WRONLY | File::CREAT | File::TRUNC, 0o600) do |file|
    file.write(key.export)
  end
  [key, true]
end

INSTANCE_PRIVATE_KEY, INSTANCE_KEY_GENERATED = load_or_generate_instance_private_key
INSTANCE_PUBLIC_KEY_PEM = INSTANCE_PRIVATE_KEY.public_key.export
SELF_INSTANCE_ID = Digest::SHA256.hexdigest(INSTANCE_PUBLIC_KEY_PEM)

def well_known_directory
  WELL_KNOWN_STORAGE_ROOT
end

def well_known_file_path
  File.join(well_known_directory, File.basename(WELL_KNOWN_RELATIVE_PATH))
end

begin
  FileUtils.rm_f(LEGACY_PUBLIC_WELL_KNOWN_PATH)
  legacy_dir = File.dirname(LEGACY_PUBLIC_WELL_KNOWN_PATH)
  FileUtils.rmdir(legacy_dir) if Dir.exist?(legacy_dir) && Dir.empty?(legacy_dir)
rescue SystemCallError
  # Ignore errors removing legacy static files; failure only means the directory
  # or file did not exist or is in use.
end

def build_well_known_document
  last_update = latest_node_update_timestamp
  payload = {
    publicKey: INSTANCE_PUBLIC_KEY_PEM,
    name: sanitized_site_name,
    version: APP_VERSION,
    domain: INSTANCE_DOMAIN,
    lastUpdate: last_update,
  }

  signed_payload = JSON.generate(payload, sort_keys: true)
  signature = Base64.strict_encode64(
    INSTANCE_PRIVATE_KEY.sign(OpenSSL::Digest::SHA256.new, signed_payload),
  )

  document = payload.merge(
    signature: signature,
    signatureAlgorithm: INSTANCE_SIGNATURE_ALGORITHM,
    signedPayload: Base64.strict_encode64(signed_payload),
  )

  json_output = JSON.pretty_generate(document)
  [json_output, signature]
end

def refresh_well_known_document_if_stale
  FileUtils.mkdir_p(well_known_directory)
  path = well_known_file_path
  now = Time.now
  if File.exist?(path)
    mtime = File.mtime(path)
    return if (now - mtime) < WELL_KNOWN_REFRESH_INTERVAL
  end

  json_output, signature = build_well_known_document
  File.open(path, File::WRONLY | File::CREAT | File::TRUNC, 0o644) do |file|
    file.write(json_output)
    file.write("\n") unless json_output.end_with?("\n")
  end

  debug_log("Updated #{WELL_KNOWN_RELATIVE_PATH} content: #{json_output}")
  debug_log(
    "Updated #{WELL_KNOWN_RELATIVE_PATH} signature (#{INSTANCE_SIGNATURE_ALGORITHM}): #{signature}",
  )
end

set :public_folder, File.join(__dir__, "public")
set :views, File.join(__dir__, "views")
set :federation_thread, nil

def latest_node_update_timestamp
  return nil unless File.exist?(DB_PATH)

  db = open_database(readonly: true)
  value = db.get_first_value(
    "SELECT MAX(COALESCE(last_heard, first_heard, position_time)) FROM nodes",
  )
  value&.to_i
rescue SQLite3::Exception
  nil
ensure
  db&.close
end

get "/favicon.ico" do
  cache_control :public, max_age: WEEK_SECONDS
  ico_path = File.join(settings.public_folder, "favicon.ico")
  if File.file?(ico_path)
    send_file ico_path, type: "image/x-icon"
  else
    send_file File.join(settings.public_folder, "potatomesh-logo.svg"), type: "image/svg+xml"
  end
end

get "/version" do
  content_type :json
  last_update = latest_node_update_timestamp
  payload = {
    name: sanitized_site_name,
    version: APP_VERSION,
    lastNodeUpdate: last_update,
    config: {
      siteName: sanitized_site_name,
      defaultChannel: sanitized_default_channel,
      defaultFrequency: sanitized_default_frequency,
      refreshIntervalSeconds: REFRESH_INTERVAL_SECONDS,
      mapCenter: {
        lat: MAP_CENTER_LAT,
        lon: MAP_CENTER_LON,
      },
      maxNodeDistanceKm: MAX_NODE_DISTANCE_KM,
      matrixRoom: sanitized_matrix_room,
      instanceDomain: INSTANCE_DOMAIN,
      privateMode: private_mode?,
    },
  }
  payload.to_json
end

get "/.well-known/potato-mesh" do
  refresh_well_known_document_if_stale
  cache_control :public, max_age: WELL_KNOWN_REFRESH_INTERVAL
  content_type :json
  send_file well_known_file_path
end

SITE_NAME = fetch_config_string("SITE_NAME", "PotatoMesh Demo")
DEFAULT_CHANNEL = fetch_config_string("DEFAULT_CHANNEL", "#LongFast")
DEFAULT_FREQUENCY = fetch_config_string("DEFAULT_FREQUENCY", "915MHz")
MAP_CENTER_LAT = ENV.fetch("MAP_CENTER_LAT", "38.761944").to_f
MAP_CENTER_LON = ENV.fetch("MAP_CENTER_LON", "-27.090833").to_f
MAX_NODE_DISTANCE_KM = ENV.fetch("MAX_NODE_DISTANCE_KM", "42").to_f
MATRIX_ROOM = ENV.fetch("MATRIX_ROOM", "#potatomesh:dod.ngo")
INSTANCE_DOMAIN, INSTANCE_DOMAIN_SOURCE = determine_instance_domain
DEBUG = ENV["DEBUG"] == "1"

#
# Prometheus metrics
#
$prom_messages_total = Prometheus::Client::Counter.new(
  :meshtastic_messages_total,
  docstring: "Total number of messages received",
)
Prometheus::Client.registry.register($prom_messages_total)

$prom_nodes = Prometheus::Client::Gauge.new(
  :meshtastic_nodes,
  docstring: "Number of nodes seen",
)
Prometheus::Client.registry.register($prom_nodes)

$prom_node = Prometheus::Client::Gauge.new(
  :meshtastic_node,
  docstring: "Node details",
  labels: [:node, :short_name, :long_name, :hw_model, :role],
)
Prometheus::Client.registry.register($prom_node)

$prom_node_battery_level = Prometheus::Client::Gauge.new(
  :meshtastic_node_battery_level,
  docstring: "Battery level of a node",
  labels: [:node],
)
Prometheus::Client.registry.register($prom_node_battery_level)

$prom_node_voltage = Prometheus::Client::Gauge.new(
  :meshtastic_node_voltage,
  docstring: "Voltage level of a node",
  labels: [:node],
)
Prometheus::Client.registry.register($prom_node_voltage)

$prom_node_uptime = Prometheus::Client::Gauge.new(
  :meshtastic_node_uptime,
  docstring: "Uptime of a node",
  labels: [:node],
)
Prometheus::Client.registry.register($prom_node_uptime)

$prom_node_channel_utilization = Prometheus::Client::Gauge.new(
  :meshtastic_node_channel_utilization,
  docstring: "Channel utilization level of a node",
  labels: [:node],
)
Prometheus::Client.registry.register($prom_node_channel_utilization)

$prom_node_transmit_air_utilization = Prometheus::Client::Gauge.new(
  :meshtastic_node_transmit_air_utilization,
  docstring: "Air transmit utilization level of a node",
  labels: [:node],
)
Prometheus::Client.registry.register($prom_node_transmit_air_utilization)

$prom_node_latitude = Prometheus::Client::Gauge.new(
  :meshtastic_node_latitude,
  docstring: "Latitude of a node",
  labels: [:node],
)
Prometheus::Client.registry.register($prom_node_latitude)

$prom_node_longitude = Prometheus::Client::Gauge.new(
  :meshtastic_node_longitude,
  docstring: "Longitude of a node",
  labels: [:node],
)
Prometheus::Client.registry.register($prom_node_longitude)

$prom_node_altitude = Prometheus::Client::Gauge.new(
  :meshtastic_node_altitude,
  docstring: "Altitude of a node",
  labels: [:node],
)
Prometheus::Client.registry.register($prom_node_altitude)

# Log a debug message when the ``DEBUG`` environment variable is enabled.
#
# @param message [String] text written to the configured logger.
# @return [void]
def debug_log(message)
  return unless DEBUG

  logger = settings.logger if respond_to?(:settings)
  logger&.debug(message)
end

# Log the instance public key to the debug output so operators can record it for
# federation purposes.
#
# @return [void]
def log_instance_public_key
  debug_log("Instance public key (PEM):\n#{INSTANCE_PUBLIC_KEY_PEM}")
  if INSTANCE_KEY_GENERATED
    debug_log("Generated new instance private key at #{KEYFILE_PATH}")
  end
end

# Emit a debug log entry describing how the instance domain was resolved.
#
# @return [void]
def log_instance_domain_resolution
  message = case INSTANCE_DOMAIN_SOURCE
    when :environment
      "Instance domain configured from INSTANCE_DOMAIN environment variable: #{INSTANCE_DOMAIN.inspect}"
    when :reverse_dns
      "Instance domain resolved via reverse DNS lookup: #{INSTANCE_DOMAIN.inspect}"
    when :public_ip
      "Instance domain resolved using public IP address: #{INSTANCE_DOMAIN.inspect}"
    when :protected_ip
      "Instance domain resolved using protected network IP address: #{INSTANCE_DOMAIN.inspect}"
    when :local_ip
      "Instance domain defaulted to local IP address: #{INSTANCE_DOMAIN.inspect}"
    else
      "Instance domain could not be determined from the environment or local network."
    end

  debug_log(message)
end

# Indicates whether the instance should hide sensitive details from visitors.
#
# @return [Boolean] true when the ``PRIVATE`` flag is set.
def private_mode?
  ENV["PRIVATE"] == "1"
end

# Determine whether the application is running in the test environment.
#
# @return [Boolean]
def test_environment?
  ENV["RACK_ENV"] == "test"
end

# Determine whether outbound federation announcements are enabled via
# configuration and not suppressed by private mode.
#
# @return [Boolean]
def federation_enabled?
  ENV.fetch("FEDERATION", "1") != "0" && !private_mode?
end

# Determine whether automatic federation announcements should run in the
# current environment.
#
# @return [Boolean]
def federation_announcements_active?
  federation_enabled? && !test_environment?
end

# Discover the most appropriate IP address for the local instance when a
# hostname is unavailable.
#
# @return [String]
def discover_local_ip_address
  candidates = ip_address_candidates

  ipv4 = candidates.find do |addr|
    addr.respond_to?(:ipv4?) && addr.ipv4? && !(addr.respond_to?(:ipv4_loopback?) && addr.ipv4_loopback?)
  end
  return ipv4.ip_address if ipv4

  non_loopback = candidates.find do |addr|
    !(addr.respond_to?(:ipv4_loopback?) && addr.ipv4_loopback?) &&
      !(addr.respond_to?(:ipv6_loopback?) && addr.ipv6_loopback?)
  end
  return non_loopback.ip_address if non_loopback

  loopback = candidates.find do |addr|
    (addr.respond_to?(:ipv4_loopback?) && addr.ipv4_loopback?) ||
      (addr.respond_to?(:ipv6_loopback?) && addr.ipv6_loopback?)
  end
  return loopback.ip_address if loopback

  "127.0.0.1"
end

# Resolve the domain used when registering this instance in the federation
# directory.
#
# @return [String, nil]
def self_instance_domain
  sanitized = sanitize_instance_domain(INSTANCE_DOMAIN)
  return sanitized if sanitized

  raise "INSTANCE_DOMAIN could not be determined"
end

# Assemble the canonical attributes advertised for this instance when
# communicating with other deployments.
#
# @return [Hash]
def self_instance_attributes
  domain = self_instance_domain
  last_update = latest_node_update_timestamp || Time.now.to_i
  {
    id: SELF_INSTANCE_ID,
    domain: domain,
    pubkey: INSTANCE_PUBLIC_KEY_PEM,
    name: sanitized_site_name,
    version: APP_VERSION,
    channel: sanitized_default_channel,
    frequency: sanitized_default_frequency,
    latitude: MAP_CENTER_LAT,
    longitude: MAP_CENTER_LON,
    last_update_time: last_update,
    is_private: private_mode?,
  }
end

# Generate the canonical signature for the supplied instance attributes.
#
# @param attributes [Hash]
# @return [String]
def sign_instance_attributes(attributes)
  payload = canonical_instance_payload(attributes)
  Base64.strict_encode64(
    INSTANCE_PRIVATE_KEY.sign(OpenSSL::Digest::SHA256.new, payload),
  )
end

# Construct the JSON payload delivered to remote federation peers.
#
# @param attributes [Hash]
# @param signature [String]
# @return [Hash]
def instance_announcement_payload(attributes, signature)
  payload = {
    "id" => attributes[:id],
    "domain" => attributes[:domain],
    "pubkey" => attributes[:pubkey],
    "name" => attributes[:name],
    "version" => attributes[:version],
    "channel" => attributes[:channel],
    "frequency" => attributes[:frequency],
    "latitude" => attributes[:latitude],
    "longitude" => attributes[:longitude],
    "lastUpdateTime" => attributes[:last_update_time],
    "isPrivate" => attributes[:is_private],
    "signature" => signature,
  }
  payload.reject { |_, value| value.nil? }
end

# Ensure the local instance registration exists in the database.
#
# @return [Array(Hash, String)] tuple containing attributes and signature.
def ensure_self_instance_record!
  attributes = self_instance_attributes
  signature = sign_instance_attributes(attributes)
  db = open_database
  upsert_instance_record(db, attributes, signature)
  debug_log(
    "Registered self instance record #{attributes[:domain]} (id: #{attributes[:id]})",
  )
  [attributes, signature]
ensure
  db&.close
end

# Retrieve all known federation domains, combining the seed list and locally
# stored registrations.
#
# @param self_domain [String, nil]
# @return [Array<String>]
def federation_target_domains(self_domain)
  domains = Set.new
  FEDERATION_SEED_DOMAINS.each do |seed|
    sanitized = sanitize_instance_domain(seed)
    domains << sanitized.downcase if sanitized
  end

  db = open_database(readonly: true)
  db.results_as_hash = false
  rows = with_busy_retry { db.execute("SELECT domain FROM instances WHERE domain IS NOT NULL AND TRIM(domain) != ''") }
  rows.flatten.compact.each do |raw_domain|
    sanitized = sanitize_instance_domain(raw_domain)
    domains << sanitized.downcase if sanitized
  end
  if self_domain
    domains.delete(self_domain.downcase)
  end
  domains.to_a
rescue SQLite3::Exception
  domains = FEDERATION_SEED_DOMAINS.map { |seed| sanitize_instance_domain(seed)&.downcase }.compact
  self_domain ? domains.reject { |domain| domain == self_domain.downcase } : domains
ensure
  db&.close
end

# Perform an HTTP POST request delivering the instance announcement payload to
# the specified domain.
#
# @param domain [String]
# @param payload_json [String]
# @return [Boolean]
def announce_instance_to_domain(domain, payload_json)
  return false unless domain && !domain.empty?

  instance_uri_candidates(domain, "/api/instances").each do |uri|
    begin
      http = Net::HTTP.new(uri.host, uri.port)
      http.open_timeout = REMOTE_INSTANCE_HTTP_TIMEOUT
      http.read_timeout = REMOTE_INSTANCE_HTTP_TIMEOUT
      http.use_ssl = uri.scheme == "https"
      response = http.start do |connection|
        request = Net::HTTP::Post.new(uri)
        request["Content-Type"] = "application/json"
        request.body = payload_json
        connection.request(request)
      end
      if response.is_a?(Net::HTTPSuccess)
        debug_log("Announced instance to #{uri}")
        return true
      end
      debug_log(
        "Federation announcement to #{uri} failed with status #{response.code}",
      )
    rescue StandardError => e
      debug_log("Federation announcement to #{uri} failed: #{e.message}")
    end
  end

  false
end

# Broadcast the local instance registration to all known federation targets.
#
# @return [void]
def announce_instance_to_all_domains
  return unless federation_enabled?

  attributes, signature = ensure_self_instance_record!
  payload_json = JSON.generate(instance_announcement_payload(attributes, signature))
  domains = federation_target_domains(attributes[:domain])
  domains.each do |domain|
    announce_instance_to_domain(domain, payload_json)
  end
  debug_log(
    "Federation announcement cycle complete (targets: #{domains.join(", ")})",
  ) unless domains.empty?
end

# Launch a background thread responsible for issuing daily federation
# announcements.
#
# @return [Thread, nil]
def start_federation_announcer!
  existing = Sinatra::Application.settings.federation_thread
  return existing if existing&.alive?

  thread = Thread.new do
    loop do
      sleep FEDERATION_ANNOUNCEMENT_INTERVAL
      begin
        announce_instance_to_all_domains
      rescue StandardError => e
        debug_log("Federation announcement loop error: #{e.message}")
      end
    end
  end
  thread.name = "potato-mesh-federation" if thread.respond_to?(:name=)
  Sinatra::Application.set(:federation_thread, thread)
  thread
end

# Launch the initial federation announcement asynchronously to avoid delaying
# application boot while network requests are attempted.
#
# @return [Thread, nil]
def start_initial_federation_announcement!
  settings = Sinatra::Application.settings
  existing = settings.respond_to?(:initial_federation_thread) ? settings.initial_federation_thread : nil
  return existing if existing&.alive?

  thread = Thread.new do
    begin
      announce_instance_to_all_domains
    rescue StandardError => e
      debug_log("Initial federation announcement failed: #{e.message}")
    ensure
      Sinatra::Application.set(:initial_federation_thread, nil)
    end
  end
  thread.name = "potato-mesh-federation-initial" if thread.respond_to?(:name=)
  thread.report_on_exception = false if thread.respond_to?(:report_on_exception=)
  Sinatra::Application.set(:initial_federation_thread, thread)
  thread
end

# Convert arbitrary values into trimmed strings.
#
# @param value [Object] input value converted using ``to_s``.
# @return [String] trimmed representation of ``value``.
def sanitized_string(value)
  value.to_s.strip
end

# Return the configured site name stripped of leading and trailing whitespace.
#
# @return [String] sanitized site name used throughout the UI.
def sanitized_site_name
  sanitized_string(SITE_NAME)
end

# Return the configured default channel label.
#
# @return [String] sanitized channel label for the UI.
def sanitized_default_channel
  sanitized_string(DEFAULT_CHANNEL)
end

# Return the configured default frequency label.
#
# @return [String] sanitized frequency string.
def sanitized_default_frequency
  sanitized_string(DEFAULT_FREQUENCY)
end

# Assemble configuration exposed to the frontend JavaScript bundle.
#
# @return [Hash] settings describing refresh cadence and map defaults.
def frontend_app_config
  {
    refreshIntervalSeconds: REFRESH_INTERVAL_SECONDS,
    refreshMs: REFRESH_INTERVAL_SECONDS * 1000,
    chatEnabled: !private_mode?,
    defaultChannel: sanitized_default_channel,
    defaultFrequency: sanitized_default_frequency,
    mapCenter: { lat: MAP_CENTER_LAT, lon: MAP_CENTER_LON },
    maxNodeDistanceKm: MAX_NODE_DISTANCE_KM,
    tileFilters: {
      light: MAP_TILE_FILTER_LIGHT,
      dark: MAP_TILE_FILTER_DARK,
    },
    instanceDomain: INSTANCE_DOMAIN,
  }
end

# Return the configured Matrix room when present.
#
# @return [String, nil] Matrix room identifier or nil when blank.
def sanitized_matrix_room
  value = sanitized_string(MATRIX_ROOM)
  value.empty? ? nil : value
end

# Coerce arbitrary values into strings or nil when blank.
#
# @param value [Object] raw value to normalize.
# @return [String, nil] string when present or nil for empty inputs.
# Convert values into integers while tolerating hexadecimal and float inputs.
#
# @param value [Object] input converted to an integer when possible.
# @return [Integer, nil] integer representation or nil when conversion fails.
def coerce_integer(value)
  case value
  when Integer
    value
  when Float
    value.finite? ? value.to_i : nil
  when Numeric
    value.to_i
  when String
    trimmed = value.strip
    return nil if trimmed.empty?
    return trimmed.to_i(16) if trimmed.match?(/\A0[xX][0-9A-Fa-f]+\z/)
    return trimmed.to_i(10) if trimmed.match?(/\A-?\d+\z/)
    begin
      float_val = Float(trimmed)
      float_val.finite? ? float_val.to_i : nil
    rescue ArgumentError
      nil
    end
  else
    nil
  end
end

# Convert values into floats while rejecting non-finite numbers.
#
# @param value [Object] input converted to a float when possible.
# @return [Float, nil] floating-point representation or nil when conversion fails.
def coerce_float(value)
  case value
  when Float
    value.finite? ? value : nil
  when Integer
    value.to_f
  when Numeric
    value.to_f
  when String
    trimmed = value.strip
    return nil if trimmed.empty?
    begin
      float_val = Float(trimmed)
      float_val.finite? ? float_val : nil
    rescue ArgumentError
      nil
    end
  else
    nil
  end
end

# Convert arbitrary values into boolean flags.
#
# @param value [Object] raw value coerced into a boolean when recognised.
# @return [Boolean, nil] boolean representation or nil when ambiguous.
def coerce_boolean(value)
  case value
  when true, false
    value
  when String
    trimmed = value.strip.downcase
    return true if %w[true 1 yes y].include?(trimmed)
    return false if %w[false 0 no n].include?(trimmed)
    nil
  when Numeric
    !value.to_i.zero?
  else
    nil
  end
end

# Normalise PEM-encoded public keys while preserving their structure.
#
# @param value [Object]
# @return [String, nil]
def sanitize_public_key_pem(value)
  return nil if value.nil?

  pem = value.is_a?(String) ? value : value.to_s
  pem = pem.gsub(/\r\n?/, "\n")
  return nil if pem.strip.empty?

  pem
end

# Extract the host component from an instance domain string.
#
# @param domain [String]
# @return [String, nil] host portion suitable for IP parsing.
# Determine whether an IP address belongs to a restricted network range.
#
# @param ip [IPAddr]
# @return [Boolean]
def restricted_ip_address?(ip)
  return true if ip.loopback?
  return true if ip.private?
  return true if ip.link_local?
  return true if ip.to_i.zero?

  false
end

# Build canonical payload string used for signature verification.
#
# @param attributes [Hash]
# @return [String]
def canonical_instance_payload(attributes)
  data = {}
  data["id"] = attributes[:id] if attributes[:id]
  data["domain"] = attributes[:domain] if attributes[:domain]
  data["pubkey"] = attributes[:pubkey] if attributes[:pubkey]
  data["name"] = attributes[:name] if attributes[:name]
  data["version"] = attributes[:version] if attributes[:version]
  data["channel"] = attributes[:channel] if attributes[:channel]
  data["frequency"] = attributes[:frequency] if attributes[:frequency]
  data["latitude"] = attributes[:latitude] unless attributes[:latitude].nil?
  data["longitude"] = attributes[:longitude] unless attributes[:longitude].nil?
  data["lastUpdateTime"] = attributes[:last_update_time] unless attributes[:last_update_time].nil?
  data["isPrivate"] = attributes[:is_private] unless attributes[:is_private].nil?

  JSON.generate(data, sort_keys: true)
end

# Validate the authenticity of a federated instance registration payload.
#
# @param attributes [Hash] canonicalised payload attributes.
# @param signature [String] base64 encoded signature.
# @param public_key_pem [String] PEM encoded public key.
# @return [Boolean]
def verify_instance_signature(attributes, signature, public_key_pem)
  return false unless signature && public_key_pem

  canonical = canonical_instance_payload(attributes)
  signature_bytes = Base64.strict_decode64(signature)
  key = OpenSSL::PKey::RSA.new(public_key_pem)
  key.verify(OpenSSL::Digest::SHA256.new, signature_bytes, canonical)
rescue ArgumentError, OpenSSL::PKey::PKeyError
  false
end

# Construct potential URIs for remote instance resources.
#
# @param domain [String]
# @param path [String]
# @return [Array<URI::Generic>]
def instance_uri_candidates(domain, path)
  base = domain
  [
    URI.parse("https://#{base}#{path}"),
    URI.parse("http://#{base}#{path}"),
  ]
rescue URI::InvalidURIError
  []
end

# Perform an HTTP GET request to a remote instance.
#
# @param uri [URI::Generic]
# @return [String]
def perform_instance_http_request(uri)
  http = Net::HTTP.new(uri.host, uri.port)
  http.open_timeout = REMOTE_INSTANCE_HTTP_TIMEOUT
  http.read_timeout = REMOTE_INSTANCE_HTTP_TIMEOUT
  http.use_ssl = uri.scheme == "https"
  http.start do |connection|
    response = connection.request(Net::HTTP::Get.new(uri))
    case response
    when Net::HTTPSuccess
      response.body
    else
      raise InstanceFetchError, "unexpected response #{response.code}"
    end
  end
rescue StandardError => e
  raise InstanceFetchError, e.message
end

# Retrieve and parse JSON from a remote instance endpoint.
#
# @param domain [String]
# @param path [String]
# @return [Array]
def fetch_instance_json(domain, path)
  errors = []
  instance_uri_candidates(domain, path).each do |uri|
    begin
      body = perform_instance_http_request(uri)
      return [JSON.parse(body), uri] if body
    rescue JSON::ParserError => e
      errors << "#{uri}: invalid JSON (#{e.message})"
    rescue InstanceFetchError => e
      errors << "#{uri}: #{e.message}"
    end
  end
  [nil, errors]
end

# Validate the contents of a remote well-known document.
#
# @param document [Hash]
# @param domain [String]
# @param pubkey [String]
# @return [Array(Boolean, String)]
def validate_well_known_document(document, domain, pubkey)
  unless document.is_a?(Hash)
    return [false, "document is not an object"]
  end

  remote_pubkey = sanitize_public_key_pem(document["publicKey"])
  return [false, "public key missing"] unless remote_pubkey
  return [false, "public key mismatch"] unless remote_pubkey == pubkey

  remote_domain = string_or_nil(document["domain"])
  return [false, "domain missing"] unless remote_domain
  return [false, "domain mismatch"] unless remote_domain.casecmp?(domain)

  algorithm = string_or_nil(document["signatureAlgorithm"])
  return [false, "unsupported signature algorithm"] unless algorithm&.casecmp?(INSTANCE_SIGNATURE_ALGORITHM)

  signed_payload_b64 = string_or_nil(document["signedPayload"])
  signature_b64 = string_or_nil(document["signature"])
  return [false, "missing signed payload"] unless signed_payload_b64
  return [false, "missing signature"] unless signature_b64

  signed_payload = Base64.strict_decode64(signed_payload_b64)
  signature = Base64.strict_decode64(signature_b64)
  key = OpenSSL::PKey::RSA.new(remote_pubkey)
  unless key.verify(OpenSSL::Digest::SHA256.new, signature, signed_payload)
    return [false, "invalid well-known signature"]
  end

  payload = JSON.parse(signed_payload)
  unless payload.is_a?(Hash)
    return [false, "signed payload is not an object"]
  end

  payload_domain = string_or_nil(payload["domain"])
  payload_pubkey = sanitize_public_key_pem(payload["publicKey"])
  return [false, "signed payload domain mismatch"] unless payload_domain&.casecmp?(domain)
  return [false, "signed payload public key mismatch"] unless payload_pubkey == pubkey

  [true, nil]
rescue ArgumentError, OpenSSL::PKey::PKeyError => e
  [false, e.message]
rescue JSON::ParserError => e
  [false, "signed payload JSON error: #{e.message}"]
end

# Determine whether the remote node dataset satisfies freshness requirements.
#
# @param nodes [Array<Hash>]
# @return [Array(Boolean, String)]
def validate_remote_nodes(nodes)
  unless nodes.is_a?(Array)
    return [false, "node response is not an array"]
  end

  return [false, "insufficient nodes"] if nodes.length < REMOTE_INSTANCE_MIN_NODE_COUNT

  latest = nodes.filter_map do |node|
    next unless node.is_a?(Hash)

    timestamps = []
    timestamps << coerce_integer(node["last_heard"])
    timestamps << coerce_integer(node["position_time"])
    timestamps << coerce_integer(node["first_heard"])
    timestamps.compact.max
  end.compact.max

  return [false, "missing recent node updates"] unless latest

  cutoff = Time.now.to_i - REMOTE_INSTANCE_MAX_NODE_AGE
  return [false, "node data is stale"] if latest < cutoff

  [true, nil]
end

# Insert or update a federated instance registration record.
#
# @param db [SQLite3::Database]
# @param attributes [Hash]
# @param signature [String]
# @return [void]
def upsert_instance_record(db, attributes, signature)
  sql = <<~SQL
    INSERT INTO instances (
      id, domain, pubkey, name, version, channel, frequency,
      latitude, longitude, last_update_time, is_private, signature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      domain=excluded.domain,
      pubkey=excluded.pubkey,
      name=excluded.name,
      version=excluded.version,
      channel=excluded.channel,
      frequency=excluded.frequency,
      latitude=excluded.latitude,
      longitude=excluded.longitude,
      last_update_time=excluded.last_update_time,
      is_private=excluded.is_private,
      signature=excluded.signature
  SQL

  params = [
    attributes[:id],
    attributes[:domain],
    attributes[:pubkey],
    attributes[:name],
    attributes[:version],
    attributes[:channel],
    attributes[:frequency],
    attributes[:latitude],
    attributes[:longitude],
    attributes[:last_update_time],
    attributes[:is_private] ? 1 : 0,
    signature,
  ]

  with_busy_retry do
    db.execute(sql, params)
  end
end

# Recursively normalize JSON values to ensure keys are strings.
#
# @param value [Object] array, hash, or scalar value parsed from JSON.
# @return [Object] normalized representation with string keys for hashes.
def normalize_json_value(value)
  case value
  when Hash
    value.each_with_object({}) do |(key, val), memo|
      memo[key.to_s] = normalize_json_value(val)
    end
  when Array
    value.map { |element| normalize_json_value(element) }
  else
    value
  end
end

# Parse user-supplied JSON payloads into normalized hashes.
#
# @param value [Object] JSON string or hash-like object.
# @return [Hash, nil] normalized hash or nil when parsing fails.
def normalize_json_object(value)
  case value
  when Hash
    normalize_json_value(value)
  when String
    trimmed = value.strip
    return nil if trimmed.empty?
    begin
      parsed = JSON.parse(trimmed)
    rescue JSON::ParserError
      return nil
    end
    parsed.is_a?(Hash) ? normalize_json_value(parsed) : nil
  else
    nil
  end
end

# Return the configured maximum node distance when valid.
#
# @return [Float, nil] positive distance in kilometres or nil when invalid.
def sanitized_max_distance_km
  return nil unless defined?(MAX_NODE_DISTANCE_KM)

  distance = MAX_NODE_DISTANCE_KM
  return nil unless distance.is_a?(Numeric)
  return nil unless distance.positive?

  distance
end

# Format a distance in kilometres for display.
#
# @param distance [Numeric] value expressed in kilometres.
# @return [String] distance formatted with a single decimal place.
def formatted_distance_km(distance)
  format("%.1f", distance).sub(/\.0\z/, "")
end

# Compose the meta description used by the landing page.
#
# @return [String] readable sentence summarising the instance.
def meta_description
  site = sanitized_site_name
  channel = sanitized_default_channel
  frequency = sanitized_default_frequency
  matrix = sanitized_matrix_room

  summary = "Live Meshtastic mesh map for #{site}"
  if channel.empty? && frequency.empty?
    summary += "."
  elsif channel.empty?
    summary += " tuned to #{frequency}."
  elsif frequency.empty?
    summary += " on #{channel}."
  else
    summary += " on #{channel} (#{frequency})."
  end

  activity_sentence = if private_mode?
      "Track nodes and coverage in real time."
    else
      "Track nodes, messages, and coverage in real time."
    end

  sentences = [summary, activity_sentence]
  if (distance = sanitized_max_distance_km)
    sentences << "Shows nodes within roughly #{formatted_distance_km(distance)} km of the map center."
  end
  sentences << "Join the community in #{matrix} on Matrix." if matrix

  sentences.join(" ")
end

# Return the metadata used to populate the HTML head section.
#
# @return [Hash] hash containing ``:title``, ``:name``, and ``:description`` keys.
def meta_configuration
  site = sanitized_site_name
  {
    title: site,
    name: site,
    description: meta_description,
  }
end

class << Sinatra::Application
  # Configure the logger level based on the ``DEBUG`` flag.
  #
  # @return [void]
  def apply_logger_level!
    logger = settings.logger
    return unless logger

    logger.level = DEBUG ? Logger::DEBUG : Logger::WARN
  end
end

# Execute the provided block, retrying when SQLite reports the database is
# temporarily locked.
#
# @param max_retries [Integer] maximum number of retries after the initial
#   attempt.
# @param base_delay [Float] base delay in seconds for linear backoff between
#   retries.
# @yieldreturn [Object] result of the block once it succeeds.
def with_busy_retry(max_retries: DB_BUSY_MAX_RETRIES, base_delay: DB_BUSY_RETRY_DELAY)
  attempts = 0
  begin
    yield
  rescue SQLite3::BusyException
    attempts += 1
    raise if attempts > max_retries
    sleep(base_delay * attempts)
    retry
  end
end

# Checks whether the SQLite database already contains the required tables.
#
# @return [Boolean] true when both +nodes+ and +messages+ tables exist.
def db_schema_present?
  return false unless File.exist?(DB_PATH)
  db = open_database(readonly: true)
  required = %w[nodes messages positions telemetry neighbors instances]
  tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nodes','messages','positions','telemetry','neighbors','instances')").flatten
  (required - tables).empty?
rescue SQLite3::Exception
  false
ensure
  db&.close
end

# Create the SQLite database and seed it with the node and message schemas.
#
# @return [void]
def init_db
  FileUtils.mkdir_p(File.dirname(DB_PATH))
  db = open_database
  %w[nodes messages positions telemetry neighbors instances].each do |schema|
    sql_file = File.expand_path("../data/#{schema}.sql", __dir__)
    db.execute_batch(File.read(sql_file))
  end
ensure
  db&.close
end

init_db unless db_schema_present?

# Apply opportunistic schema upgrades without forcing a separate migration
# process for existing deployments.
#
# @return [void]
def ensure_schema_upgrades
  db = open_database
  node_columns = db.execute("PRAGMA table_info(nodes)").map { |row| row[1] }
  unless node_columns.include?("precision_bits")
    db.execute("ALTER TABLE nodes ADD COLUMN precision_bits INTEGER")
  end

  tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='instances'").flatten
  if tables.empty?
    sql_file = File.expand_path("../data/instances.sql", __dir__)
    db.execute_batch(File.read(sql_file))
  end
rescue SQLite3::SQLException, Errno::ENOENT => e
  warn "[warn] failed to apply schema upgrade: #{e.message}"
ensure
  db&.close
end

ensure_schema_upgrades

Sinatra::Application.configure do
  app_logger = Logger.new($stdout)
  set :logger, app_logger
  use Rack::CommonLogger, app_logger
  use Rack::Deflater
  use Prometheus::Middleware::Collector
  use Prometheus::Middleware::Exporter
  Sinatra::Application.apply_logger_level!
  log_instance_domain_resolution
  log_instance_public_key
  refresh_well_known_document_if_stale
  ensure_self_instance_record!
  if federation_announcements_active?
    start_initial_federation_announcement!
    start_federation_announcer!
  elsif federation_enabled?
    debug_log("Federation announcements disabled in test environment")
  else
    debug_log("Federation announcements disabled by configuration or private mode")
  end
end

# Derive canonical string and numeric representations for a node reference.
#
# @param node_ref [Object] raw identifier provided by the caller.
# @return [Hash] hash containing ``:string_values`` and ``:numeric_values`` arrays.
def node_reference_tokens(node_ref)
  parts = canonical_node_parts(node_ref)
  canonical_id, numeric_id = parts ? parts[0, 2] : [nil, nil]

  string_values = []
  numeric_values = []

  case node_ref
  when Integer
    numeric_values << node_ref
    string_values << node_ref.to_s
  when Numeric
    coerced = node_ref.to_i
    numeric_values << coerced
    string_values << coerced.to_s
  when String
    trimmed = node_ref.strip
    unless trimmed.empty?
      string_values << trimmed
      numeric_values << trimmed.to_i if trimmed.match?(/\A-?\d+\z/)
    end
  when nil
    # no-op
  else
    coerced = node_ref.to_s.strip
    string_values << coerced unless coerced.empty?
  end

  if canonical_id
    string_values << canonical_id
    string_values << canonical_id.upcase
  end

  if numeric_id
    numeric_values << numeric_id
    string_values << numeric_id.to_s
  end

  cleaned_strings = string_values.compact.map(&:to_s).map(&:strip).reject(&:empty?).uniq
  cleaned_numbers = numeric_values.compact.map do |value|
    begin
      Integer(value, 10)
    rescue ArgumentError, TypeError
      nil
    end
  end.compact.uniq

  {
    string_values: cleaned_strings,
    numeric_values: cleaned_numbers,
  }
end

# Build a SQL predicate limiting results to the provided node reference.
#
# @param node_ref [Object] identifier used to match the node.
# @param string_columns [Array<String>] columns compared against string forms.
# @param numeric_columns [Array<String>] columns compared against numeric forms.
# @return [Array(String, Array), nil] tuple containing the SQL fragment and
#   bound parameters, or nil when no valid tokens can be derived.
def node_lookup_clause(node_ref, string_columns:, numeric_columns: [])
  tokens = node_reference_tokens(node_ref)
  string_values = tokens[:string_values]
  numeric_values = tokens[:numeric_values]

  clauses = []
  params = []

  unless string_columns.empty? || string_values.empty?
    string_columns.each do |column|
      placeholders = Array.new(string_values.length, "?").join(", ")
      clauses << "#{column} IN (#{placeholders})"
      params.concat(string_values)
    end
  end

  unless numeric_columns.empty? || numeric_values.empty?
    numeric_columns.each do |column|
      placeholders = Array.new(numeric_values.length, "?").join(", ")
      clauses << "#{column} IN (#{placeholders})"
      params.concat(numeric_values)
    end
  end

  return nil if clauses.empty?

  ["(#{clauses.join(" OR ")})", params]
end

# Retrieve recently heard nodes ordered by their last contact time.
#
# @param limit [Integer] maximum number of rows returned.
# @param node_ref [Object, nil] optional identifier restricting the query.
# @return [Array<Hash>] collection of node records formatted for the API.
def query_nodes(limit, node_ref: nil)
  db = open_database(readonly: true)
  db.results_as_hash = true
  now = Time.now.to_i
  min_last_heard = now - WEEK_SECONDS
  params = []
  where_clauses = []

  if node_ref
    clause = node_lookup_clause(node_ref, string_columns: ["node_id"], numeric_columns: ["num"])
    return [] unless clause
    where_clauses << clause.first
    params.concat(clause.last)
  else
    where_clauses << "last_heard >= ?"
    params << min_last_heard
  end

  if private_mode?
    where_clauses << "(role IS NULL OR role <> 'CLIENT_HIDDEN')"
  end

  sql = <<~SQL
    SELECT node_id, short_name, long_name, hw_model, role, snr,
           battery_level, voltage, last_heard, first_heard,
           uptime_seconds, channel_utilization, air_util_tx,
           position_time, location_source, precision_bits,
           latitude, longitude, altitude
    FROM nodes
  SQL
  sql += "    WHERE #{where_clauses.join(" AND ")}\n" if where_clauses.any?
  sql += <<~SQL
    ORDER BY last_heard DESC
    LIMIT ?
  SQL
  params << limit

  rows = db.execute(sql, params)
  rows.each do |r|
    r["role"] ||= "CLIENT"
    lh = r["last_heard"]&.to_i
    pt = r["position_time"]&.to_i
    lh = now if lh && lh > now
    pt = nil if pt && pt > now
    r["last_heard"] = lh
    r["position_time"] = pt
    r["last_seen_iso"] = Time.at(lh).utc.iso8601 if lh
    r["pos_time_iso"] = Time.at(pt).utc.iso8601 if pt
    pb = r["precision_bits"]
    r["precision_bits"] = pb.to_i if pb
  end
  rows
ensure
  db&.close
end

# GET /api/nodes
#
# Returns a JSON array of the most recently heard nodes.
get "/api/nodes" do
  content_type :json
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_nodes(limit).to_json
end

get "/api/nodes/:id" do
  content_type :json
  node_ref = string_or_nil(params["id"])
  halt 400, { error: "missing node id" }.to_json unless node_ref
  limit = [params["limit"]&.to_i || 200, 1000].min
  rows = query_nodes(limit, node_ref: node_ref)
  halt 404, { error: "not found" }.to_json if rows.empty?
  rows.first.to_json
end

# Retrieve recent text messages joined with related node information.
#
# @param limit [Integer] maximum number of rows returned.
# @param node_ref [Object, nil] optional identifier restricting the query.
# @return [Array<Hash>] collection of message rows suitable for serialisation.
def query_messages(limit, node_ref: nil)
  db = open_database(readonly: true)
  db.results_as_hash = true
  params = []
  where_clauses = ["COALESCE(TRIM(m.encrypted), '') = ''"]

  if node_ref
    clause = node_lookup_clause(node_ref, string_columns: ["m.from_id", "m.to_id"])
    return [] unless clause
    where_clauses << clause.first
    params.concat(clause.last)
  end

  sql = <<~SQL
    SELECT m.*, n.*, m.snr AS msg_snr
    FROM messages m
    LEFT JOIN nodes n ON (
      m.from_id IS NOT NULL AND TRIM(m.from_id) <> '' AND (
        m.from_id = n.node_id OR (
          m.from_id GLOB '[0-9]*' AND CAST(m.from_id AS INTEGER) = n.num
        )
      )
    )
  SQL
  sql += "    WHERE #{where_clauses.join(" AND ")}\n"
  sql += <<~SQL
    ORDER BY m.rx_time DESC
    LIMIT ?
  SQL
  params << limit
  rows = db.execute(sql, params)
  msg_fields = %w[id rx_time rx_iso from_id to_id channel portnum text encrypted msg_snr rssi hop_limit]
  rows.each do |r|
    if DEBUG && (r["from_id"].nil? || r["from_id"].to_s.empty?)
      raw = db.execute("SELECT * FROM messages WHERE id = ?", [r["id"]]).first
      Kernel.warn "[debug] messages row before join: #{raw.inspect}"
      Kernel.warn "[debug] row after join: #{r.inspect}"
    end
    node = {}
    r.keys.each do |k|
      next if msg_fields.include?(k)
      node[k] = r.delete(k)
    end
    r["snr"] = r.delete("msg_snr")
    references = [r["from_id"]].compact
    if references.any? && (node["node_id"].nil? || node["node_id"].to_s.empty?)
      lookup_keys = []
      canonical = normalize_node_id(db, r["from_id"])
      lookup_keys << canonical if canonical
      raw_ref = r["from_id"].to_s.strip
      lookup_keys << raw_ref unless raw_ref.empty?
      lookup_keys << raw_ref.to_i if raw_ref.match?(/\A[0-9]+\z/)
      fallback = nil
      lookup_keys.uniq.each do |ref|
        sql = ref.is_a?(Integer) ? "SELECT * FROM nodes WHERE num = ?" : "SELECT * FROM nodes WHERE node_id = ?"
        fallback = db.get_first_row(sql, [ref])
        break if fallback
      end
      if fallback
        fallback.each do |key, value|
          next unless key.is_a?(String)
          next if msg_fields.include?(key)
          node[key] = value if node[key].nil?
        end
      end
    end
    node["role"] = "CLIENT" if node.key?("role") && (node["role"].nil? || node["role"].to_s.empty?)
    r["node"] = node

    canonical_from_id = string_or_nil(node["node_id"]) || string_or_nil(normalize_node_id(db, r["from_id"]))
    if canonical_from_id
      raw_from_id = string_or_nil(r["from_id"])
      if raw_from_id.nil? || raw_from_id.match?(/\A[0-9]+\z/)
        r["from_id"] = canonical_from_id
      elsif raw_from_id.start_with?("!") && raw_from_id.casecmp(canonical_from_id) != 0
        r["from_id"] = canonical_from_id
      end
    end
    if DEBUG && (r["from_id"].nil? || r["from_id"].to_s.empty?)
      Kernel.warn "[debug] row after processing: #{r.inspect}"
    end
  end
  rows
ensure
  db&.close
end

# Retrieve recorded position packets ordered by receive time.
#
# @param limit [Integer] maximum number of rows returned.
# @param node_ref [Object, nil] optional identifier restricting the query.
# @return [Array<Hash>] collection of position rows formatted for the API.
def query_positions(limit, node_ref: nil)
  db = open_database(readonly: true)
  db.results_as_hash = true
  params = []
  where_clauses = []

  if node_ref
    clause = node_lookup_clause(
      node_ref,
      string_columns: ["node_id", "to_id"],
      numeric_columns: ["node_num"],
    )
    return [] unless clause
    where_clauses << clause.first
    params.concat(clause.last)
  end

  sql = <<~SQL
    SELECT id, node_id, node_num, rx_time, rx_iso, position_time,
           to_id, latitude, longitude, altitude, location_source,
           precision_bits, sats_in_view, pdop, ground_speed,
           ground_track, snr, rssi, hop_limit, bitfield,
           payload_b64
    FROM positions
  SQL
  sql += "    WHERE #{where_clauses.join(" AND ")}\n" if where_clauses.any?
  sql += <<~SQL
    ORDER BY rx_time DESC
    LIMIT ?
  SQL
  params << limit
  rows = db.execute(sql, params)
  rows.each do |r|
    pt = r["position_time"]
    if pt
      begin
        r["position_time"] = Integer(pt, 10)
      rescue ArgumentError, TypeError
        r["position_time"] = coerce_integer(pt)
      end
    end
    pt_val = r["position_time"]
    r["position_time_iso"] = Time.at(pt_val).utc.iso8601 if pt_val
    pb = r["precision_bits"]
    r["precision_bits"] = pb.to_i if pb
  end
  rows
ensure
  db&.close
end

# Retrieve recent neighbour signal reports ordered by the recorded time.
#
# @param limit [Integer] maximum number of rows returned.
# @param node_ref [Object, nil] optional identifier restricting the query.
# @return [Array<Hash>] neighbour tuples formatted for the API response.
def query_neighbors(limit, node_ref: nil)
  db = open_database(readonly: true)
  db.results_as_hash = true
  params = []
  where_clauses = []

  if node_ref
    clause = node_lookup_clause(node_ref, string_columns: ["node_id", "neighbor_id"])
    return [] unless clause
    where_clauses << clause.first
    params.concat(clause.last)
  end

  sql = <<~SQL
    SELECT node_id, neighbor_id, snr, rx_time
    FROM neighbors
  SQL
  sql += "    WHERE #{where_clauses.join(" AND ")}\n" if where_clauses.any?
  sql += <<~SQL
    ORDER BY rx_time DESC
    LIMIT ?
  SQL
  params << limit
  rows = db.execute(sql, params)
  rows.each do |r|
    rx_time = coerce_integer(r["rx_time"])
    r["rx_time"] = rx_time if rx_time
    r["rx_iso"] = Time.at(rx_time).utc.iso8601 if rx_time
    r["snr"] = coerce_float(r["snr"])
  end
  rows
ensure
  db&.close
end

# Retrieve telemetry packets enriched with parsed numeric values.
#
# @param limit [Integer] maximum number of rows returned.
# @param node_ref [Object, nil] optional identifier restricting the query.
# @return [Array<Hash>] telemetry rows suitable for serialisation.
def query_telemetry(limit, node_ref: nil)
  db = open_database(readonly: true)
  db.results_as_hash = true
  params = []
  where_clauses = []

  if node_ref
    clause = node_lookup_clause(
      node_ref,
      string_columns: ["node_id", "from_id", "to_id"],
      numeric_columns: ["node_num"],
    )
    return [] unless clause
    where_clauses << clause.first
    params.concat(clause.last)
  end

  sql = <<~SQL
    SELECT id, node_id, node_num, from_id, to_id, rx_time, rx_iso,
           telemetry_time, channel, portnum, hop_limit, snr, rssi,
           bitfield, payload_b64, battery_level, voltage,
           channel_utilization, air_util_tx, uptime_seconds,
           temperature, relative_humidity, barometric_pressure
    FROM telemetry
  SQL
  sql += "    WHERE #{where_clauses.join(" AND ")}\n" if where_clauses.any?
  sql += <<~SQL
    ORDER BY rx_time DESC
    LIMIT ?
  SQL
  params << limit
  rows = db.execute(sql, params)
  now = Time.now.to_i
  rows.each do |r|
    rx_time = coerce_integer(r["rx_time"])
    r["rx_time"] = rx_time if rx_time
    r["rx_iso"] = Time.at(rx_time).utc.iso8601 if rx_time && string_or_nil(r["rx_iso"]).nil?

    node_num = coerce_integer(r["node_num"])
    r["node_num"] = node_num if node_num

    telemetry_time = coerce_integer(r["telemetry_time"])
    telemetry_time = nil if telemetry_time && telemetry_time > now
    r["telemetry_time"] = telemetry_time
    r["telemetry_time_iso"] = Time.at(telemetry_time).utc.iso8601 if telemetry_time

    r["channel"] = coerce_integer(r["channel"])
    r["hop_limit"] = coerce_integer(r["hop_limit"])
    r["rssi"] = coerce_integer(r["rssi"])
    r["bitfield"] = coerce_integer(r["bitfield"])
    r["snr"] = coerce_float(r["snr"])
    r["battery_level"] = coerce_float(r["battery_level"])
    r["voltage"] = coerce_float(r["voltage"])
    r["channel_utilization"] = coerce_float(r["channel_utilization"])
    r["air_util_tx"] = coerce_float(r["air_util_tx"])
    r["uptime_seconds"] = coerce_integer(r["uptime_seconds"])
    r["temperature"] = coerce_float(r["temperature"])
    r["relative_humidity"] = coerce_float(r["relative_humidity"])
    r["barometric_pressure"] = coerce_float(r["barometric_pressure"])
  end
  rows
ensure
  db&.close
end

# GET /api/messages
#
# Returns a JSON array of stored text messages including node metadata.
get "/api/messages" do
  halt 404 if private_mode?
  content_type :json
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_messages(limit).to_json
end

get "/api/messages/:id" do
  halt 404 if private_mode?
  content_type :json
  node_ref = string_or_nil(params["id"])
  halt 400, { error: "missing node id" }.to_json unless node_ref
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_messages(limit, node_ref: node_ref).to_json
end

# GET /api/positions
#
# Returns a JSON array of recorded position packets.
get "/api/positions" do
  content_type :json
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_positions(limit).to_json
end

get "/api/positions/:id" do
  content_type :json
  node_ref = string_or_nil(params["id"])
  halt 400, { error: "missing node id" }.to_json unless node_ref
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_positions(limit, node_ref: node_ref).to_json
end

# GET /api/neighbors
#
# Returns the most recent neighbor tuples describing mesh health.
get "/api/neighbors" do
  content_type :json
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_neighbors(limit).to_json
end

get "/api/neighbors/:id" do
  content_type :json
  node_ref = string_or_nil(params["id"])
  halt 400, { error: "missing node id" }.to_json unless node_ref
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_neighbors(limit, node_ref: node_ref).to_json
end

# GET /api/telemetry
#
# Returns a JSON array of recorded telemetry packets.
get "/api/telemetry" do
  content_type :json
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_telemetry(limit).to_json
end

get "/api/telemetry/:id" do
  content_type :json
  node_ref = string_or_nil(params["id"])
  halt 400, { error: "missing node id" }.to_json unless node_ref
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_telemetry(limit, node_ref: node_ref).to_json
end

# Determine the numeric node reference for a canonical node identifier.
#
# The Meshtastic protobuf encodes the node ID as a hexadecimal string prefixed
# with an exclamation mark (for example ``!4ed36bd0``).  Many payloads also
# include a decimal ``num`` alias, but some integrations omit it.  When the
# alias is missing we can reconstruct it from the canonical identifier so that
# later joins using ``nodes.num`` continue to work.
#
# @param node_id [String, nil] canonical node identifier (e.g. ``!4ed36bd0``).
# @param payload [Hash] raw node payload provided by the data daemon.
# @return [Integer, nil] numeric node reference if it can be determined.
def resolve_node_num(node_id, payload)
  raw = payload["num"]

  case raw
  when Integer
    return raw
  when Numeric
    return raw.to_i
  when String
    trimmed = raw.strip
    return nil if trimmed.empty?
    return Integer(trimmed, 10) if trimmed.match?(/\A[0-9]+\z/)
    return Integer(trimmed.delete_prefix("0x").delete_prefix("0X"), 16) if trimmed.match?(/\A0[xX][0-9A-Fa-f]+\z/)
    if trimmed.match?(/\A[0-9A-Fa-f]+\z/)
      canonical = node_id.is_a?(String) ? node_id.strip : ""
      return Integer(trimmed, 16) if canonical.match?(/\A!?[0-9A-Fa-f]+\z/)
    end
  end

  return nil unless node_id.is_a?(String)

  hex = node_id.strip
  return nil if hex.empty?
  hex = hex.delete_prefix("!")
  return nil unless hex.match?(/\A[0-9A-Fa-f]+\z/)

  Integer(hex, 16)
rescue ArgumentError
  nil
end

# Determine canonical node identifiers and derived metadata for a reference.
#
# @param node_ref [Object] raw node identifier or numeric reference.
# @param fallback_num [Object] optional numeric reference used when the
#   identifier does not encode the value directly.
# @return [Array(String, Integer, String), nil] tuple containing the canonical
#   node ID, numeric node reference, and uppercase short identifier suffix when
#   the reference can be parsed. Returns nil when the reference cannot be
#   converted into a canonical ID.
def canonical_node_parts(node_ref, fallback_num = nil)
  fallback = coerce_integer(fallback_num)

  hex = nil
  num = nil

  case node_ref
  when Integer
    num = node_ref
  when Numeric
    num = node_ref.to_i
  when String
    trimmed = node_ref.strip
    return nil if trimmed.empty?

    if trimmed.start_with?("!")
      hex = trimmed.delete_prefix("!")
    elsif trimmed.match?(/\A0[xX][0-9A-Fa-f]+\z/)
      hex = trimmed[2..].to_s
    elsif trimmed.match?(/\A-?\d+\z/)
      num = trimmed.to_i
    elsif trimmed.match?(/\A[0-9A-Fa-f]+\z/)
      hex = trimmed
    else
      return nil
    end
  when nil
    num = fallback if fallback
  else
    return nil
  end

  num ||= fallback if fallback

  if hex
    begin
      num ||= Integer(hex, 16)
    rescue ArgumentError
      return nil
    end
  elsif num
    return nil if num.negative?
    hex = format("%08x", num & 0xFFFFFFFF)
  else
    return nil
  end

  return nil if hex.nil? || hex.empty?

  begin
    parsed = Integer(hex, 16)
  rescue ArgumentError
    return nil
  end

  parsed &= 0xFFFFFFFF
  canonical_hex = format("%08x", parsed)
  short_id = canonical_hex[-4, 4].upcase

  ["!#{canonical_hex}", parsed, short_id]
end

# Ensure a placeholder node entry exists for the provided identifier.
#
# Messages and telemetry can reference nodes before the daemon has received a
# full node snapshot. When this happens we create a minimal hidden entry so the
# sender can be resolved in the UI until richer metadata becomes available.
#
# @param db [SQLite3::Database] open database handle.
# @param node_ref [Object] raw identifier extracted from the payload.
# @param fallback_num [Object] optional numeric reference used when the
#   identifier is missing.
def ensure_unknown_node(db, node_ref, fallback_num = nil, heard_time: nil)
  parts = canonical_node_parts(node_ref, fallback_num)
  return unless parts

  node_id, node_num, short_id = parts

  existing = db.get_first_value(
    "SELECT 1 FROM nodes WHERE node_id = ? LIMIT 1",
    [node_id],
  )
  return if existing

  long_name = "Meshtastic #{short_id}"
  heard_time = coerce_integer(heard_time)
  inserted = false

  with_busy_retry do
    db.execute(
      <<~SQL,
      INSERT OR IGNORE INTO nodes(node_id,num,short_name,long_name,role,last_heard,first_heard)
      VALUES (?,?,?,?,?,?,?)
    SQL
      [node_id, node_num, short_id, long_name, "CLIENT_HIDDEN", heard_time, heard_time],
    )
    inserted = db.changes.positive?
  end

  if inserted
    debug_log(
      "ensure_unknown_node created hidden node_id=#{node_id} from=#{node_ref.inspect} " \
      "fallback=#{fallback_num.inspect} heard_time=#{heard_time.inspect}"
    )
  end

  inserted
end

# Ensure the node's last_seen timestamp reflects the provided receive time.
#
# @param db [SQLite3::Database] open database handle.
# @param node_ref [Object] raw identifier used to resolve the node.
# @param fallback_num [Object] optional numeric identifier.
# @param rx_time [Object] receive timestamp that should update the node.
def touch_node_last_seen(db, node_ref, fallback_num = nil, rx_time: nil, source: nil)
  timestamp = coerce_integer(rx_time)
  return unless timestamp

  node_id = nil

  parts = canonical_node_parts(node_ref, fallback_num)
  node_id, = parts if parts

  unless node_id
    trimmed = string_or_nil(node_ref)
    if trimmed
      node_id = normalize_node_id(db, trimmed) || trimmed
    elsif fallback_num
      fallback_parts = canonical_node_parts(fallback_num, nil)
      node_id, = fallback_parts if fallback_parts
    end
  end

  return unless node_id

  updated = false
  with_busy_retry do
    db.execute <<~SQL, [timestamp, timestamp, timestamp, node_id]
                 UPDATE nodes
                    SET last_heard = CASE
                      WHEN COALESCE(last_heard, 0) >= ? THEN last_heard
                      ELSE ?
                    END,
                        first_heard = COALESCE(first_heard, ?)
                  WHERE node_id = ?
               SQL
    updated ||= db.changes.positive?
  end

  if updated
    debug_log(
      "touch_node_last_seen updated last_heard node_id=#{node_id} timestamp=#{timestamp} " \
      "source=#{(source || :unknown).inspect}"
    )
  end

  updated
end

# Insert or update a node row with the most recent metrics.
#
# @param db [SQLite3::Database] open database handle.
# @param node_id [String] primary identifier for the node.
# @param n [Hash] node payload provided by the data daemon.
def upsert_node(db, node_id, n)
  user = n["user"] || {}
  met = n["deviceMetrics"] || {}
  pos = n["position"] || {}
  role = user["role"] || "CLIENT"
  lh = coerce_integer(n["lastHeard"])
  pt = coerce_integer(pos["time"])
  now = Time.now.to_i
  pt = nil if pt && pt > now
  lh = now if lh && lh > now
  lh = pt if pt && (!lh || lh < pt)
  lh ||= now
  bool = ->(v) {
    case v
    when true then 1
    when false then 0
    else v
    end
  }
  node_num = resolve_node_num(node_id, n)

  # insert or update Prometheus metrics
  update_prometheus_metrics(node_id, user, role, met, pos)

  row = [
    node_id,
    node_num,
    user["shortName"],
    user["longName"],
    user["macaddr"],
    user["hwModel"] || n["hwModel"],
    role,
    user["publicKey"],
    bool.call(user["isUnmessagable"]),
    bool.call(n["isFavorite"]),
    n["hopsAway"],
    n["snr"],
    lh,
    lh,
    met["batteryLevel"],
    met["voltage"],
    met["channelUtilization"],
    met["airUtilTx"],
    met["uptimeSeconds"],
    pt,
    pos["locationSource"],
    coerce_integer(
      pos["precisionBits"] ||
      pos["precision_bits"] ||
      pos.dig("raw", "precision_bits"),
    ),
    pos["latitude"],
    pos["longitude"],
    pos["altitude"],
  ]
  with_busy_retry do
    db.execute <<~SQL, row
                 INSERT INTO nodes(node_id,num,short_name,long_name,macaddr,hw_model,role,public_key,is_unmessagable,is_favorite,
                                   hops_away,snr,last_heard,first_heard,battery_level,voltage,channel_utilization,air_util_tx,uptime_seconds,
                                   position_time,location_source,precision_bits,latitude,longitude,altitude)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(node_id) DO UPDATE SET
                   num=excluded.num, short_name=excluded.short_name, long_name=excluded.long_name, macaddr=excluded.macaddr,
                   hw_model=excluded.hw_model, role=excluded.role, public_key=excluded.public_key, is_unmessagable=excluded.is_unmessagable,
                   is_favorite=excluded.is_favorite, hops_away=excluded.hops_away, snr=excluded.snr, last_heard=excluded.last_heard,
                   first_heard=COALESCE(nodes.first_heard, excluded.first_heard, excluded.last_heard),
                   battery_level=excluded.battery_level, voltage=excluded.voltage, channel_utilization=excluded.channel_utilization,
                   air_util_tx=excluded.air_util_tx, uptime_seconds=excluded.uptime_seconds, position_time=excluded.position_time,
                   location_source=excluded.location_source, precision_bits=excluded.precision_bits, latitude=excluded.latitude, longitude=excluded.longitude,
                   altitude=excluded.altitude
                 WHERE COALESCE(excluded.last_heard,0) >= COALESCE(nodes.last_heard,0)
               SQL
  end
end

# Ensure the request includes the expected bearer token.
#
# @return [void]
# @raise [Sinatra::Halt] when authentication fails.
def require_token!
  token = ENV["API_TOKEN"]
  provided = request.env["HTTP_AUTHORIZATION"].to_s.sub(/^Bearer\s+/i, "")
  halt 403, { error: "Forbidden" }.to_json unless token && !token.empty? && secure_token_match?(token, provided)
end

# Perform a constant-time comparison between two strings, returning false on
# length mismatches or invalid input.
#
# @param expected [String]
# @param provided [String]
# @return [Boolean]
def secure_token_match?(expected, provided)
  return false unless expected.is_a?(String) && provided.is_a?(String)

  expected_bytes = expected.b
  provided_bytes = provided.b
  return false unless expected_bytes.bytesize == provided_bytes.bytesize
  Rack::Utils.secure_compare(expected_bytes, provided_bytes)
rescue Rack::Utils::SecurityError
  false
end

# Read the request body enforcing a maximum allowed size.
#
# @param limit [Integer, nil] optional override for the number of bytes.
# @return [String]
def read_json_body(limit: nil)
  max_bytes = limit || MAX_JSON_BODY_BYTES
  max_bytes = max_bytes.to_i
  max_bytes = MAX_JSON_BODY_BYTES if max_bytes <= 0

  body = request.body.read(max_bytes + 1)
  body = "" if body.nil?
  halt 413, { error: "payload too large" }.to_json if body.bytesize > max_bytes

  body
ensure
  request.body.rewind if request.body.respond_to?(:rewind)
end

# Determine whether the canonical node identifier should replace the provided
# sender reference for a message payload.
#
# @param message [Object] raw request payload element.
# @return [Boolean]
def prefer_canonical_sender?(message)
  message.is_a?(Hash) && message.key?("packet_id") && !message.key?("id")
end

# Update or create a node entry using information from a position payload.
#
# @param db [SQLite3::Database] open database handle.
# @param node_id [String, nil] canonical node identifier when available.
# @param node_num [Integer, nil] numeric node reference if known.
# @param rx_time [Integer] time the packet was received by the gateway.
# @param position_time [Integer, nil] timestamp reported by the device.
# @param location_source [String, nil] location source flag from the packet.
# @param latitude [Float, nil] reported latitude.
# @param longitude [Float, nil] reported longitude.
# @param altitude [Float, nil] reported altitude.
# @param precision_bits [Integer, nil] precision estimate provided by the device.
# @param snr [Float, nil] link SNR for the packet.
def update_node_from_position(db, node_id, node_num, rx_time, position_time, location_source, precision_bits, latitude, longitude, altitude, snr)
  num = coerce_integer(node_num)
  id = string_or_nil(node_id)
  if id&.start_with?("!")
    id = "!#{id.delete_prefix("!").downcase}"
  end
  id ||= format("!%08x", num & 0xFFFFFFFF) if num
  return unless id

  now = Time.now.to_i
  rx = coerce_integer(rx_time) || now
  rx = now if rx && rx > now
  pos_time = coerce_integer(position_time)
  pos_time = nil if pos_time && pos_time > now
  last_heard = [rx, pos_time].compact.max || rx
  last_heard = now if last_heard && last_heard > now

  loc = string_or_nil(location_source)
  lat = coerce_float(latitude)
  lon = coerce_float(longitude)
  alt = coerce_float(altitude)
  precision = coerce_integer(precision_bits)
  snr_val = coerce_float(snr)

  # updates position metrics
  update_prometheus_metrics(node_id, nil, nil, nil, {
    "latitude" => lat,
    "longitude" => lon,
    "altitude" => alt,
  })

  row = [
    id,
    num,
    last_heard,
    last_heard,
    pos_time,
    loc,
    precision,
    lat,
    lon,
    alt,
    snr_val,
  ]
  with_busy_retry do
    db.execute <<~SQL, row
                 INSERT INTO nodes(node_id,num,last_heard,first_heard,position_time,location_source,precision_bits,latitude,longitude,altitude,snr)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(node_id) DO UPDATE SET
                   num=COALESCE(excluded.num,nodes.num),
                   snr=COALESCE(excluded.snr,nodes.snr),
                   last_heard=MAX(COALESCE(nodes.last_heard,0),COALESCE(excluded.last_heard,0)),
                   first_heard=COALESCE(nodes.first_heard, excluded.first_heard, excluded.last_heard),
                   position_time=CASE
                     WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                       THEN excluded.position_time
                     ELSE nodes.position_time
                   END,
                   location_source=CASE
                     WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                          AND excluded.location_source IS NOT NULL
                       THEN excluded.location_source
                     ELSE nodes.location_source
                   END,
                   precision_bits=CASE
                     WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                          AND excluded.precision_bits IS NOT NULL
                       THEN excluded.precision_bits
                     ELSE nodes.precision_bits
                   END,
                   latitude=CASE
                     WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                          AND excluded.latitude IS NOT NULL
                       THEN excluded.latitude
                     ELSE nodes.latitude
                   END,
                   longitude=CASE
                     WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                          AND excluded.longitude IS NOT NULL
                       THEN excluded.longitude
                     ELSE nodes.longitude
                   END,
                   altitude=CASE
                     WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                          AND excluded.altitude IS NOT NULL
                       THEN excluded.altitude
                     ELSE nodes.altitude
                   END
               SQL
  end
end

# Insert a position packet into the history table and refresh node metadata.
#
# @param db [SQLite3::Database] open database handle.
# @param payload [Hash] position payload provided by the data daemon.
def insert_position(db, payload)
  pos_id = coerce_integer(payload["id"] || payload["packet_id"])
  return unless pos_id

  now = Time.now.to_i
  rx_time = coerce_integer(payload["rx_time"])
  rx_time = now if rx_time.nil? || rx_time > now
  rx_iso = string_or_nil(payload["rx_iso"])
  rx_iso ||= Time.at(rx_time).utc.iso8601

  raw_node_id = payload["node_id"] || payload["from_id"] || payload["from"]
  node_id = string_or_nil(raw_node_id)
  node_id = "!#{node_id.delete_prefix("!").downcase}" if node_id&.start_with?("!")
  raw_node_num = coerce_integer(payload["node_num"]) || coerce_integer(payload["num"])
  node_id ||= format("!%08x", raw_node_num & 0xFFFFFFFF) if node_id.nil? && raw_node_num

  payload_for_num = payload.is_a?(Hash) ? payload.dup : {}
  payload_for_num["num"] ||= raw_node_num if raw_node_num
  node_num = resolve_node_num(node_id, payload_for_num)
  node_num ||= raw_node_num
  canonical = normalize_node_id(db, node_id || node_num)
  node_id = canonical if canonical

  ensure_unknown_node(db, node_id || node_num, node_num, heard_time: rx_time)
  touch_node_last_seen(db, node_id || node_num, node_num, rx_time: rx_time, source: :position)

  to_id = string_or_nil(payload["to_id"] || payload["to"])

  position_section = payload["position"].is_a?(Hash) ? payload["position"] : {}

  lat = coerce_float(payload["latitude"]) || coerce_float(position_section["latitude"])
  lon = coerce_float(payload["longitude"]) || coerce_float(position_section["longitude"])
  alt = coerce_float(payload["altitude"]) || coerce_float(position_section["altitude"])

  lat ||= begin
      lat_i = coerce_integer(position_section["latitudeI"] || position_section["latitude_i"] || position_section.dig("raw", "latitude_i"))
      lat_i ? lat_i / 1e7 : nil
    end
  lon ||= begin
      lon_i = coerce_integer(position_section["longitudeI"] || position_section["longitude_i"] || position_section.dig("raw", "longitude_i"))
      lon_i ? lon_i / 1e7 : nil
    end
  alt ||= coerce_float(position_section.dig("raw", "altitude"))

  position_time = coerce_integer(
    payload["position_time"] ||
    position_section["time"] ||
    position_section.dig("raw", "time"),
  )

  location_source = string_or_nil(
    payload["location_source"] ||
    payload["locationSource"] ||
    position_section["location_source"] ||
    position_section["locationSource"] ||
    position_section.dig("raw", "location_source"),
  )

  precision_bits = coerce_integer(
    payload["precision_bits"] ||
    payload["precisionBits"] ||
    position_section["precision_bits"] ||
    position_section["precisionBits"] ||
    position_section.dig("raw", "precision_bits"),
  )

  sats_in_view = coerce_integer(
    payload["sats_in_view"] ||
    payload["satsInView"] ||
    position_section["sats_in_view"] ||
    position_section["satsInView"] ||
    position_section.dig("raw", "sats_in_view"),
  )

  pdop = coerce_float(
    payload["pdop"] ||
    payload["PDOP"] ||
    position_section["pdop"] ||
    position_section["PDOP"] ||
    position_section.dig("raw", "PDOP") ||
    position_section.dig("raw", "pdop"),
  )

  ground_speed = coerce_float(
    payload["ground_speed"] ||
    payload["groundSpeed"] ||
    position_section["ground_speed"] ||
    position_section["groundSpeed"] ||
    position_section.dig("raw", "ground_speed"),
  )

  ground_track = coerce_float(
    payload["ground_track"] ||
    payload["groundTrack"] ||
    position_section["ground_track"] ||
    position_section["groundTrack"] ||
    position_section.dig("raw", "ground_track"),
  )

  snr = coerce_float(payload["snr"] || payload["rx_snr"] || payload["rxSnr"])
  rssi = coerce_integer(payload["rssi"] || payload["rx_rssi"] || payload["rxRssi"])
  hop_limit = coerce_integer(payload["hop_limit"] || payload["hopLimit"])
  bitfield = coerce_integer(payload["bitfield"])

  payload_b64 = string_or_nil(payload["payload_b64"] || payload["payload"])
  payload_b64 ||= string_or_nil(position_section.dig("payload", "__bytes_b64__"))

  row = [
    pos_id,
    node_id,
    node_num,
    rx_time,
    rx_iso,
    position_time,
    to_id,
    lat,
    lon,
    alt,
    location_source,
    precision_bits,
    sats_in_view,
    pdop,
    ground_speed,
    ground_track,
    snr,
    rssi,
    hop_limit,
    bitfield,
    payload_b64,
  ]

  with_busy_retry do
    db.execute <<~SQL, row
                 INSERT INTO positions(id,node_id,node_num,rx_time,rx_iso,position_time,to_id,latitude,longitude,altitude,location_source,
                                       precision_bits,sats_in_view,pdop,ground_speed,ground_track,snr,rssi,hop_limit,bitfield,payload_b64)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(id) DO UPDATE SET
                   node_id=COALESCE(excluded.node_id,positions.node_id),
                   node_num=COALESCE(excluded.node_num,positions.node_num),
                   rx_time=excluded.rx_time,
                   rx_iso=excluded.rx_iso,
                   position_time=COALESCE(excluded.position_time,positions.position_time),
                   to_id=COALESCE(excluded.to_id,positions.to_id),
                   latitude=COALESCE(excluded.latitude,positions.latitude),
                   longitude=COALESCE(excluded.longitude,positions.longitude),
                   altitude=COALESCE(excluded.altitude,positions.altitude),
                   location_source=COALESCE(excluded.location_source,positions.location_source),
                   precision_bits=COALESCE(excluded.precision_bits,positions.precision_bits),
                   sats_in_view=COALESCE(excluded.sats_in_view,positions.sats_in_view),
                   pdop=COALESCE(excluded.pdop,positions.pdop),
                   ground_speed=COALESCE(excluded.ground_speed,positions.ground_speed),
                   ground_track=COALESCE(excluded.ground_track,positions.ground_track),
                   snr=COALESCE(excluded.snr,positions.snr),
                   rssi=COALESCE(excluded.rssi,positions.rssi),
                   hop_limit=COALESCE(excluded.hop_limit,positions.hop_limit),
                   bitfield=COALESCE(excluded.bitfield,positions.bitfield),
                   payload_b64=COALESCE(excluded.payload_b64,positions.payload_b64)
               SQL
  end

  update_node_from_position(
    db,
    node_id,
    node_num,
    rx_time,
    position_time,
    location_source,
    precision_bits,
    lat,
    lon,
    alt,
    snr,
  )
end

# Ingest neighbour relationship data for a node and refresh cached records.
#
# @param db [SQLite3::Database] open database handle.
# @param payload [Hash] neighbour payload provided by the data daemon.
# @return [void]
def insert_neighbors(db, payload)
  return unless payload.is_a?(Hash)

  now = Time.now.to_i
  rx_time = coerce_integer(payload["rx_time"])
  rx_time = now if rx_time.nil? || rx_time > now

  raw_node_id = payload["node_id"] || payload["node"] || payload["from_id"]
  raw_node_num = coerce_integer(payload["node_num"]) || coerce_integer(payload["num"])

  canonical_parts = canonical_node_parts(raw_node_id, raw_node_num)
  if canonical_parts
    node_id, node_num, = canonical_parts
  else
    node_id = string_or_nil(raw_node_id)
    canonical = normalize_node_id(db, node_id || raw_node_num)
    node_id = canonical if canonical
    if node_id&.start_with?("!") && raw_node_num.nil?
      begin
        node_num = Integer(node_id.delete_prefix("!"), 16)
      rescue ArgumentError
        node_num = nil
      end
    else
      node_num = raw_node_num
    end
  end

  return unless node_id

  node_id = "!#{node_id.delete_prefix("!").downcase}" if node_id.start_with?("!")

  ensure_unknown_node(db, node_id || node_num, node_num, heard_time: rx_time)
  touch_node_last_seen(db, node_id || node_num, node_num, rx_time: rx_time, source: :neighborinfo)

  neighbor_entries = []
  neighbors_payload = payload["neighbors"]
  neighbors_list = neighbors_payload.is_a?(Array) ? neighbors_payload : []

  neighbors_list.each do |neighbor|
    next unless neighbor.is_a?(Hash)

    neighbor_ref = neighbor["neighbor_id"] || neighbor["node_id"] || neighbor["nodeId"] || neighbor["id"]
    neighbor_num = coerce_integer(
      neighbor["neighbor_num"] || neighbor["node_num"] || neighbor["nodeId"] || neighbor["id"],
    )

    canonical_neighbor = canonical_node_parts(neighbor_ref, neighbor_num)
    if canonical_neighbor
      neighbor_id, neighbor_num, = canonical_neighbor
    else
      neighbor_id = string_or_nil(neighbor_ref)
      canonical_neighbor_id = normalize_node_id(db, neighbor_id || neighbor_num)
      neighbor_id = canonical_neighbor_id if canonical_neighbor_id
      if neighbor_id&.start_with?("!") && neighbor_num.nil?
        begin
          neighbor_num = Integer(neighbor_id.delete_prefix("!"), 16)
        rescue ArgumentError
          neighbor_num = nil
        end
      end
    end

    next unless neighbor_id

    neighbor_id = "!#{neighbor_id.delete_prefix("!").downcase}" if neighbor_id.start_with?("!")

    entry_rx_time = coerce_integer(neighbor["rx_time"]) || rx_time
    entry_rx_time = now if entry_rx_time && entry_rx_time > now
    snr = coerce_float(neighbor["snr"])

    ensure_unknown_node(db, neighbor_id || neighbor_num, neighbor_num, heard_time: entry_rx_time)
    touch_node_last_seen(db, neighbor_id || neighbor_num, neighbor_num, rx_time: entry_rx_time, source: :neighborinfo)

    neighbor_entries << [neighbor_id, snr, entry_rx_time]
  end

  with_busy_retry do
    db.transaction do
      db.execute("DELETE FROM neighbors WHERE node_id = ?", [node_id])
      neighbor_entries.each do |neighbor_id, snr, heard_time|
        db.execute(
          <<~SQL,
          INSERT OR REPLACE INTO neighbors(node_id, neighbor_id, snr, rx_time)
          VALUES (?, ?, ?, ?)
        SQL
          [node_id, neighbor_id, snr, heard_time],
        )
      end
    end
  end
end

# Update cached node metrics using the provided telemetry readings.
#
# @param db [SQLite3::Database] open database handle.
# @param node_id [String, nil] canonical node identifier when available.
# @param node_num [Integer, nil] numeric node reference.
# @param rx_time [Integer, nil] last receive timestamp associated with the telemetry.
# @param metrics [Hash] telemetry metrics extracted from the payload.
# @return [void]
def update_node_from_telemetry(db, node_id, node_num, rx_time, metrics = {})
  num = coerce_integer(node_num)
  id = string_or_nil(node_id)
  if id&.start_with?("!")
    id = "!#{id.delete_prefix("!").downcase}"
  end
  id ||= format("!%08x", num & 0xFFFFFFFF) if num
  return unless id

  ensure_unknown_node(db, id, num, heard_time: rx_time)
  touch_node_last_seen(db, id, num, rx_time: rx_time, source: :telemetry)

  battery = coerce_float(metrics[:battery_level] || metrics["battery_level"])
  voltage = coerce_float(metrics[:voltage] || metrics["voltage"])
  channel_util = coerce_float(metrics[:channel_utilization] || metrics["channel_utilization"])
  air_util_tx = coerce_float(metrics[:air_util_tx] || metrics["air_util_tx"])
  uptime = coerce_integer(metrics[:uptime_seconds] || metrics["uptime_seconds"])

  # updates telemetry metrics
  update_prometheus_metrics(node_id, nil, nil, {
    "batteryLevel" => battery,
    "voltage" => voltage,
    "uptimeSeconds" => uptime,
    "channelUtilization" => channel_util,
    "airUtilTx" => air_util_tx,
  }, nil)

  assignments = []
  params = []

  if num
    assignments << "num = ?"
    params << num
  end

  metric_updates = {
    "battery_level" => battery,
    "voltage" => voltage,
    "channel_utilization" => channel_util,
    "air_util_tx" => air_util_tx,
    "uptime_seconds" => uptime,
  }

  metric_updates.each do |column, value|
    next if value.nil?

    assignments << "#{column} = ?"
    params << value
  end

  return if assignments.empty?

  assignments_sql = assignments.join(", ")
  params << id

  with_busy_retry do
    db.execute("UPDATE nodes SET #{assignments_sql} WHERE node_id = ?", params)
  end
end

# Update Prometheus metrics for a node when reporting is enabled.
#
# @param node_id [String] meshtastic node identifier.
# @param user [Hash] user information from the node payload.
# @param role [String] node role designation.
# @param met [Hash] device metrics from the node payload.
# @param pos [Hash] position information from the node payload.
# @return [void]
def update_prometheus_metrics(node_id, user = nil, role = "", met = nil, pos = nil)
  return if $prom_report_ids.empty? || !node_id

  return unless $prom_report_ids[0] == "*" || $prom_report_ids.include?(node_id)

  if user && user.is_a?(Hash) && role && role != ""
    $prom_node.set(
      1,
      labels: {
        node: node_id,
        short_name: user["shortName"],
        long_name: user["longName"],
        hw_model: user["hwModel"],
        role: role,
      },
    )
  end

  if met && met.is_a?(Hash)
    if met["batteryLevel"]
      $prom_node_battery_level.set(met["batteryLevel"], labels: { node: node_id })
    end

    if met["voltage"]
      $prom_node_voltage.set(met["voltage"], labels: { node: node_id })
    end

    if met["uptimeSeconds"]
      $prom_node_uptime.set(met["uptimeSeconds"], labels: { node: node_id })
    end

    if met["channelUtilization"]
      $prom_node_channel_utilization.set(met["channelUtilization"], labels: { node: node_id })
    end

    if met["airUtilTx"]
      $prom_node_transmit_air_utilization.set(met["airUtilTx"], labels: { node: node_id })
    end
  end

  if pos && pos.is_a?(Hash)
    if pos["latitude"]
      $prom_node_latitude.set(pos["latitude"], labels: { node: node_id })
    end

    if pos["longitude"]
      $prom_node_longitude.set(pos["longitude"], labels: { node: node_id })
    end

    if pos["altitude"]
      $prom_node_altitude.set(pos["altitude"], labels: { node: node_id })
    end
  end
end

# Update Prometheus metrics for all known nodes when reporting is enabled.
#
# This is intended to be called once on startup to populate the metrics from
# existing database records.
#
# @return [void]
def update_all_prometheus_metrics_from_nodes
  # find all nodes
  nodes = query_nodes(1000)

  # set the node size
  $prom_nodes.set(nodes.size)

  # update prometheus metrics on startup if enabled
  if !$prom_report_ids.empty?
    # fill in details for each node
    nodes.each do |n|
      node_id = n["node_id"]

      if $prom_report_ids[0] != "*" && !$prom_report_ids.include?(node_id)
        next
      end

      update_prometheus_metrics(
        node_id,
        {
          "shortName" => n["short_name"] || "",
          "longName" => n["long_name"] || "",
          "hwModel" => n["hw_model"] || "",
        },
        n["role"] || "",
        {
          "batteryLevel" => n["battery_level"],
          "voltage" => n["voltage"],
          "uptimeSeconds" => n["uptime_seconds"],
          "channelUtilization" => n["channel_utilization"],
          "airUtilTx" => n["air_util_tx"],
        },
        {
          "latitude" => n["latitude"],
          "longitude" => n["longitude"],
          "altitude" => n["altitude"],
        }
      )
    end
  end
end

update_all_prometheus_metrics_from_nodes

# Insert or update a telemetry packet and propagate relevant metrics to the node.
#
# @param db [SQLite3::Database] open database handle.
# @param payload [Hash] telemetry payload provided by the data daemon.
# @return [void]
def insert_telemetry(db, payload)
  return unless payload.is_a?(Hash)

  telemetry_id = coerce_integer(payload["id"] || payload["packet_id"])
  return unless telemetry_id

  now = Time.now.to_i
  rx_time = coerce_integer(payload["rx_time"])
  rx_time = now if rx_time.nil? || rx_time > now
  rx_iso = string_or_nil(payload["rx_iso"])
  rx_iso ||= Time.at(rx_time).utc.iso8601

  raw_node_id = payload["node_id"] || payload["from_id"] || payload["from"]
  node_id = string_or_nil(raw_node_id)
  node_id = "!#{node_id.delete_prefix("!").downcase}" if node_id&.start_with?("!")
  raw_node_num = coerce_integer(payload["node_num"]) || coerce_integer(payload["num"])

  payload_for_num = payload.dup
  payload_for_num["num"] ||= raw_node_num if raw_node_num
  node_num = resolve_node_num(node_id, payload_for_num)
  node_num ||= raw_node_num

  canonical = normalize_node_id(db, node_id || node_num)
  node_id = canonical if canonical

  from_id = string_or_nil(payload["from_id"]) || node_id
  to_id = string_or_nil(payload["to_id"] || payload["to"])

  telemetry_time = coerce_integer(payload["telemetry_time"] || payload["time"] || payload.dig("telemetry", "time"))
  telemetry_time = nil if telemetry_time && telemetry_time > now

  channel = coerce_integer(payload["channel"])
  portnum = string_or_nil(payload["portnum"])
  hop_limit = coerce_integer(payload["hop_limit"] || payload["hopLimit"])
  snr = coerce_float(payload["snr"])
  rssi = coerce_integer(payload["rssi"])
  bitfield = coerce_integer(payload["bitfield"])
  payload_b64 = string_or_nil(payload["payload_b64"] || payload["payload"])

  telemetry_section = normalize_json_object(payload["telemetry"])
  device_metrics = normalize_json_object(payload["device_metrics"] || payload["deviceMetrics"])
  device_metrics ||= normalize_json_object(telemetry_section["deviceMetrics"]) if telemetry_section&.key?("deviceMetrics")
  environment_metrics = normalize_json_object(payload["environment_metrics"] || payload["environmentMetrics"])
  environment_metrics ||= normalize_json_object(telemetry_section["environmentMetrics"]) if telemetry_section&.key?("environmentMetrics")

  fetch_metric = lambda do |map, *names|
    next nil unless map.is_a?(Hash)
    names.each do |name|
      next unless name
      key = name.to_s
      return map[key] if map.key?(key)
    end
    nil
  end

  battery_level = payload.key?("battery_level") ? payload["battery_level"] : nil
  battery_level = coerce_float(battery_level)
  battery_level ||= coerce_float(fetch_metric.call(device_metrics, :battery_level, :batteryLevel))

  voltage = payload.key?("voltage") ? payload["voltage"] : nil
  voltage = coerce_float(voltage)
  voltage ||= coerce_float(fetch_metric.call(device_metrics, :voltage))

  channel_utilization = payload.key?("channel_utilization") ? payload["channel_utilization"] : nil
  channel_utilization ||= payload["channelUtilization"] if payload.key?("channelUtilization")
  channel_utilization = coerce_float(channel_utilization)
  channel_utilization ||= coerce_float(fetch_metric.call(device_metrics, :channel_utilization, :channelUtilization))

  air_util_tx = payload.key?("air_util_tx") ? payload["air_util_tx"] : nil
  air_util_tx ||= payload["airUtilTx"] if payload.key?("airUtilTx")
  air_util_tx = coerce_float(air_util_tx)
  air_util_tx ||= coerce_float(fetch_metric.call(device_metrics, :air_util_tx, :airUtilTx))

  uptime_seconds = payload.key?("uptime_seconds") ? payload["uptime_seconds"] : nil
  uptime_seconds ||= payload["uptimeSeconds"] if payload.key?("uptimeSeconds")
  uptime_seconds = coerce_integer(uptime_seconds)
  uptime_seconds ||= coerce_integer(fetch_metric.call(device_metrics, :uptime_seconds, :uptimeSeconds))

  temperature = payload.key?("temperature") ? payload["temperature"] : nil
  temperature = coerce_float(temperature)
  temperature ||= coerce_float(fetch_metric.call(environment_metrics, :temperature, :temperatureC, :temperature_c, :tempC))

  relative_humidity = payload.key?("relative_humidity") ? payload["relative_humidity"] : nil
  relative_humidity ||= payload["relativeHumidity"] if payload.key?("relativeHumidity")
  relative_humidity ||= payload["humidity"] if payload.key?("humidity")
  relative_humidity = coerce_float(relative_humidity)
  relative_humidity ||= coerce_float(fetch_metric.call(environment_metrics, :relative_humidity, :relativeHumidity, :humidity))

  barometric_pressure = payload.key?("barometric_pressure") ? payload["barometric_pressure"] : nil
  barometric_pressure ||= payload["barometricPressure"] if payload.key?("barometricPressure")
  barometric_pressure ||= payload["pressure"] if payload.key?("pressure")
  barometric_pressure = coerce_float(barometric_pressure)
  barometric_pressure ||= coerce_float(fetch_metric.call(environment_metrics, :barometric_pressure, :barometricPressure, :pressure))

  row = [
    telemetry_id,
    node_id,
    node_num,
    from_id,
    to_id,
    rx_time,
    rx_iso,
    telemetry_time,
    channel,
    portnum,
    hop_limit,
    snr,
    rssi,
    bitfield,
    payload_b64,
    battery_level,
    voltage,
    channel_utilization,
    air_util_tx,
    uptime_seconds,
    temperature,
    relative_humidity,
    barometric_pressure,
  ]

  with_busy_retry do
    db.execute <<~SQL, row
                 INSERT INTO telemetry(id,node_id,node_num,from_id,to_id,rx_time,rx_iso,telemetry_time,channel,portnum,hop_limit,snr,rssi,bitfield,payload_b64,
                                       battery_level,voltage,channel_utilization,air_util_tx,uptime_seconds,temperature,relative_humidity,barometric_pressure)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(id) DO UPDATE SET
                   node_id=COALESCE(excluded.node_id,telemetry.node_id),
                   node_num=COALESCE(excluded.node_num,telemetry.node_num),
                   from_id=COALESCE(excluded.from_id,telemetry.from_id),
                   to_id=COALESCE(excluded.to_id,telemetry.to_id),
                   rx_time=excluded.rx_time,
                   rx_iso=excluded.rx_iso,
                   telemetry_time=COALESCE(excluded.telemetry_time,telemetry.telemetry_time),
                   channel=COALESCE(excluded.channel,telemetry.channel),
                   portnum=COALESCE(excluded.portnum,telemetry.portnum),
                   hop_limit=COALESCE(excluded.hop_limit,telemetry.hop_limit),
                   snr=COALESCE(excluded.snr,telemetry.snr),
                   rssi=COALESCE(excluded.rssi,telemetry.rssi),
                   bitfield=COALESCE(excluded.bitfield,telemetry.bitfield),
                   payload_b64=COALESCE(excluded.payload_b64,telemetry.payload_b64),
                   battery_level=COALESCE(excluded.battery_level,telemetry.battery_level),
                   voltage=COALESCE(excluded.voltage,telemetry.voltage),
                   channel_utilization=COALESCE(excluded.channel_utilization,telemetry.channel_utilization),
                   air_util_tx=COALESCE(excluded.air_util_tx,telemetry.air_util_tx),
                   uptime_seconds=COALESCE(excluded.uptime_seconds,telemetry.uptime_seconds),
                   temperature=COALESCE(excluded.temperature,telemetry.temperature),
                   relative_humidity=COALESCE(excluded.relative_humidity,telemetry.relative_humidity),
                   barometric_pressure=COALESCE(excluded.barometric_pressure,telemetry.barometric_pressure)
               SQL
  end

  update_node_from_telemetry(
    db,
    node_id || from_id,
    node_num,
    rx_time,
    battery_level: battery_level,
    voltage: voltage,
    channel_utilization: channel_utilization,
    air_util_tx: air_util_tx,
    uptime_seconds: uptime_seconds,
  )
end

# Insert a text message if it does not already exist.
#
# @param db [SQLite3::Database] open database handle.
# @param m [Hash] message payload provided by the data daemon.
def insert_message(db, m)
  msg_id = m["id"] || m["packet_id"]
  return unless msg_id

  rx_time = m["rx_time"]&.to_i || Time.now.to_i
  rx_iso = m["rx_iso"] || Time.at(rx_time).utc.iso8601

  raw_from_id = m["from_id"]
  if raw_from_id.nil? || raw_from_id.to_s.strip.empty?
    alt_from = m["from"]
    raw_from_id = alt_from unless alt_from.nil? || alt_from.to_s.strip.empty?
  end

  trimmed_from_id = string_or_nil(raw_from_id)
  canonical_from_id = string_or_nil(normalize_node_id(db, raw_from_id))
  from_id = trimmed_from_id
  if canonical_from_id
    if from_id.nil?
      from_id = canonical_from_id
    elsif prefer_canonical_sender?(m)
      from_id = canonical_from_id
    elsif from_id.start_with?("!") && from_id.casecmp(canonical_from_id) != 0
      from_id = canonical_from_id
    end
  end

  raw_to_id = m["to_id"]
  raw_to_id = m["to"] if raw_to_id.nil? || raw_to_id.to_s.strip.empty?
  trimmed_to_id = string_or_nil(raw_to_id)
  canonical_to_id = string_or_nil(normalize_node_id(db, raw_to_id))
  to_id = trimmed_to_id
  if canonical_to_id
    if to_id.nil?
      to_id = canonical_to_id
    elsif to_id.start_with?("!") && to_id.casecmp(canonical_to_id) != 0
      to_id = canonical_to_id
    end
  end

  encrypted = string_or_nil(m["encrypted"])

  ensure_unknown_node(db, from_id || raw_from_id, m["from_num"], heard_time: rx_time)
  touch_node_last_seen(
    db,
    from_id || raw_from_id || m["from_num"],
    m["from_num"],
    rx_time: rx_time,
    source: :message,
  )

  row = [
    msg_id,
    rx_time,
    rx_iso,
    from_id,
    to_id,
    m["channel"],
    m["portnum"],
    m["text"],
    encrypted,
    m["snr"],
    m["rssi"],
    m["hop_limit"],
  ]

  with_busy_retry do
    existing = db.get_first_row(
      "SELECT from_id, to_id, encrypted FROM messages WHERE id = ?",
      [msg_id],
    )
    if existing
      updates = {}

      if from_id
        existing_from = existing.is_a?(Hash) ? existing["from_id"] : existing[0]
        existing_from_str = existing_from&.to_s
        should_update = existing_from_str.nil? || existing_from_str.strip.empty?
        should_update ||= existing_from != from_id
        updates["from_id"] = from_id if should_update
      end

      if to_id
        existing_to = existing.is_a?(Hash) ? existing["to_id"] : existing[1]
        existing_to_str = existing_to&.to_s
        should_update = existing_to_str.nil? || existing_to_str.strip.empty?
        should_update ||= existing_to != to_id
        updates["to_id"] = to_id if should_update
      end

      if encrypted
        existing_encrypted = existing.is_a?(Hash) ? existing["encrypted"] : existing[2]
        existing_encrypted_str = existing_encrypted&.to_s
        should_update = existing_encrypted_str.nil? || existing_encrypted_str.strip.empty?
        should_update ||= existing_encrypted != encrypted
        updates["encrypted"] = encrypted if should_update
      end

      unless updates.empty?
        assignments = updates.keys.map { |column| "#{column} = ?" }.join(", ")
        db.execute("UPDATE messages SET #{assignments} WHERE id = ?", updates.values + [msg_id])
      end
    else
      $prom_messages_total.increment

      begin
        db.execute <<~SQL, row
                     INSERT INTO messages(id,rx_time,rx_iso,from_id,to_id,channel,portnum,text,encrypted,snr,rssi,hop_limit)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                   SQL
      rescue SQLite3::ConstraintException
        fallback_updates = {}
        fallback_updates["from_id"] = from_id if from_id
        fallback_updates["to_id"] = to_id if to_id
        fallback_updates["encrypted"] = encrypted if encrypted
        unless fallback_updates.empty?
          assignments = fallback_updates.keys.map { |column| "#{column} = ?" }.join(", ")
          db.execute("UPDATE messages SET #{assignments} WHERE id = ?", fallback_updates.values + [msg_id])
        end
      end
    end
  end
end

# Resolve a node reference to the canonical node ID when possible.
#
# @param db [SQLite3::Database] open database handle.
# @param node_ref [Object] raw node identifier or numeric reference.
# @return [String, nil] canonical node ID or nil if it cannot be resolved.
def normalize_node_id(db, node_ref)
  return nil if node_ref.nil?
  ref_str = node_ref.to_s.strip
  return nil if ref_str.empty?

  node_id = db.get_first_value("SELECT node_id FROM nodes WHERE node_id = ?", [ref_str])
  return node_id if node_id

  begin
    ref_num = Integer(ref_str, 10)
  rescue ArgumentError
    return nil
  end

  db.get_first_value("SELECT node_id FROM nodes WHERE num = ?", [ref_num])
end

get "/api/instances" do
  content_type :json
  ensure_self_instance_record!
  db = open_database(readonly: true)
  db.results_as_hash = true
  rows = with_busy_retry do
    db.execute(
      <<~SQL,
      SELECT id, domain, pubkey, name, version, channel, frequency,
             latitude, longitude, last_update_time, is_private, signature
      FROM instances
      WHERE domain IS NOT NULL AND TRIM(domain) != ''
        AND pubkey IS NOT NULL AND TRIM(pubkey) != ''
      ORDER BY LOWER(domain)
    SQL
    )
  end
  payload = rows.map do |row|
    {
      "id" => row["id"],
      "domain" => row["domain"],
      "pubkey" => row["pubkey"],
      "name" => row["name"],
      "version" => row["version"],
      "channel" => row["channel"],
      "frequency" => row["frequency"],
      "latitude" => row["latitude"],
      "longitude" => row["longitude"],
      "lastUpdateTime" => row["last_update_time"]&.to_i,
      "isPrivate" => row["is_private"].to_i == 1,
      "signature" => row["signature"],
    }.reject { |_, value| value.nil? }
  end
  JSON.generate(payload)
ensure
  db&.close
end

# POST /api/instances
#
# Accepts signed registrations from remote Potato Mesh deployments.
post "/api/instances" do
  content_type :json
  begin
    payload = JSON.parse(read_json_body)
  rescue JSON::ParserError
    warn "[warn] instance registration rejected: invalid JSON"
    halt 400, { error: "invalid JSON" }.to_json
  end

  unless payload.is_a?(Hash)
    warn "[warn] instance registration rejected: payload is not an object"
    halt 400, { error: "invalid payload" }.to_json
  end

  id = string_or_nil(payload["id"]) || string_or_nil(payload["instanceId"])
  domain = sanitize_instance_domain(payload["domain"])
  pubkey = sanitize_public_key_pem(payload["pubkey"])
  name = string_or_nil(payload["name"])
  version = string_or_nil(payload["version"])
  channel = string_or_nil(payload["channel"])
  frequency = string_or_nil(payload["frequency"])
  latitude = coerce_float(payload["latitude"])
  longitude = coerce_float(payload["longitude"])
  last_update_time = coerce_integer(payload["last_update_time"] || payload["lastUpdateTime"])
  raw_private = payload.key?("isPrivate") ? payload["isPrivate"] : payload["is_private"]
  is_private = coerce_boolean(raw_private)
  signature = string_or_nil(payload["signature"])

  attributes = {
    id: id,
    domain: domain,
    pubkey: pubkey,
    name: name,
    version: version,
    channel: channel,
    frequency: frequency,
    latitude: latitude,
    longitude: longitude,
    last_update_time: last_update_time,
    is_private: is_private,
  }

  if [attributes[:id], attributes[:domain], attributes[:pubkey], signature, attributes[:last_update_time]].any?(&:nil?)
    warn "[warn] instance registration rejected: missing required fields"
    halt 400, { error: "missing required fields" }.to_json
  end

  unless verify_instance_signature(attributes, signature, attributes[:pubkey])
    warn "[warn] instance registration rejected for #{attributes[:domain]}: invalid signature"
    halt 400, { error: "invalid signature" }.to_json
  end

  if attributes[:is_private]
    warn "[warn] instance registration rejected for #{attributes[:domain]}: instance marked private"
    halt 403, { error: "instance marked private" }.to_json
  end

  ip = ip_from_domain(attributes[:domain])
  if ip && restricted_ip_address?(ip)
    warn "[warn] instance registration rejected for #{attributes[:domain]}: restricted IP address"
    halt 400, { error: "restricted domain" }.to_json
  end

  well_known, well_known_meta = fetch_instance_json(attributes[:domain], "/.well-known/potato-mesh")
  unless well_known
    details_list = Array(well_known_meta).map(&:to_s)
    details = details_list.empty? ? "no response" : details_list.join("; ")
    warn "[warn] instance registration rejected for #{attributes[:domain]}: failed to fetch well-known document (#{details})"
    halt 400, { error: "failed to verify well-known document" }.to_json
  end

  valid_well_known, well_known_reason = validate_well_known_document(well_known, attributes[:domain], attributes[:pubkey])
  unless valid_well_known
    warn "[warn] instance registration rejected for #{attributes[:domain]}: #{well_known_reason}"
    halt 400, { error: "failed to verify well-known document" }.to_json
  end

  remote_nodes, nodes_meta = fetch_instance_json(attributes[:domain], "/api/nodes")
  unless remote_nodes
    details_list = Array(nodes_meta).map(&:to_s)
    details = details_list.empty? ? "no response" : details_list.join("; ")
    warn "[warn] instance registration rejected for #{attributes[:domain]}: failed to fetch remote nodes (#{details})"
    halt 400, { error: "failed to validate node dataset" }.to_json
  end

  valid_nodes, nodes_reason = validate_remote_nodes(remote_nodes)
  unless valid_nodes
    warn "[warn] instance registration rejected for #{attributes[:domain]}: #{nodes_reason}"
    halt 400, { error: "failed to validate node dataset" }.to_json
  end

  db = open_database
  attributes[:domain] = attributes[:domain].downcase
  upsert_instance_record(db, attributes, signature)
  debug_log("Registered federated instance #{attributes[:domain]} (id: #{attributes[:id]})")
  status 201
  { status: "registered" }.to_json
ensure
  db&.close
end

post "/api/nodes" do
  require_token!
  content_type :json
  begin
    data = JSON.parse(read_json_body)
  rescue JSON::ParserError
    halt 400, { error: "invalid JSON" }.to_json
  end
  halt 400, { error: "too many nodes" }.to_json if data.is_a?(Hash) && data.size > 1000
  db = open_database
  data.each do |node_id, node|
    upsert_node(db, node_id, node)
  end

  $prom_nodes.set(query_nodes(1000).length)

  { status: "ok" }.to_json
ensure
  db&.close
end

# POST /api/messages
#
# Accepts an array or object describing text messages and stores each entry.
post "/api/messages" do
  halt 404 if private_mode?
  require_token!
  content_type :json
  begin
    data = JSON.parse(read_json_body)
  rescue JSON::ParserError
    halt 400, { error: "invalid JSON" }.to_json
  end
  messages = data.is_a?(Array) ? data : [data]
  halt 400, { error: "too many messages" }.to_json if messages.size > 1000
  db = open_database
  messages.each do |msg|
    insert_message(db, msg)
  end
  { status: "ok" }.to_json
ensure
  db&.close
end

# POST /api/positions
#
# Accepts an array or object describing position packets and stores each entry.
post "/api/positions" do
  require_token!
  content_type :json
  begin
    data = JSON.parse(read_json_body)
  rescue JSON::ParserError
    halt 400, { error: "invalid JSON" }.to_json
  end
  positions = data.is_a?(Array) ? data : [data]
  halt 400, { error: "too many positions" }.to_json if positions.size > 1000
  db = open_database
  positions.each do |pos|
    insert_position(db, pos)
  end
  { status: "ok" }.to_json
ensure
  db&.close
end

# POST /api/neighbors
#
# Accepts an array or object describing neighbor tuples and stores each entry.
post "/api/neighbors" do
  require_token!
  content_type :json
  begin
    data = JSON.parse(read_json_body)
  rescue JSON::ParserError
    halt 400, { error: "invalid JSON" }.to_json
  end
  neighbor_payloads = data.is_a?(Array) ? data : [data]
  halt 400, { error: "too many neighbor packets" }.to_json if neighbor_payloads.size > 1000
  db = open_database
  neighbor_payloads.each do |packet|
    insert_neighbors(db, packet)
  end
  { status: "ok" }.to_json
ensure
  db&.close
end

# POST /api/telemetry
#
# Accepts an array or object describing telemetry packets and stores each entry.
post "/api/telemetry" do
  require_token!
  content_type :json
  begin
    data = JSON.parse(read_json_body)
  rescue JSON::ParserError
    halt 400, { error: "invalid JSON" }.to_json
  end
  telemetry_packets = data.is_a?(Array) ? data : [data]
  halt 400, { error: "too many telemetry packets" }.to_json if telemetry_packets.size > 1000
  db = open_database
  telemetry_packets.each do |packet|
    insert_telemetry(db, packet)
  end
  { status: "ok" }.to_json
ensure
  db&.close
end

get "/potatomesh-logo.svg" do
  # Sinatra знает корень через settings.root (обычно это каталог app.rb)
  path = File.expand_path("potatomesh-logo.svg", settings.public_folder)

  # отладка в лог (видно в docker logs)
  settings.logger&.info("logo_path=#{path} exist=#{File.exist?(path)}
file=#{File.file?(path)}")

  halt 404, "Not Found" unless File.exist?(path) && File.readable?(path)

  content_type "image/svg+xml"
  last_modified File.mtime(path)
  cache_control :public, max_age: 3600
  send_file path
end

# GET /
#
# Renders the main site with configuration-driven defaults for the template.
get "/" do
  meta = meta_configuration
  config = frontend_app_config

  raw_theme = request.cookies["theme"]
  theme = %w[dark light].include?(raw_theme) ? raw_theme : "dark"
  if raw_theme != theme
    response.set_cookie("theme", value: theme, path: "/", max_age: 60 * 60 * 24 * 7, same_site: :lax)
  end

  erb :index, locals: {
                site_name: meta[:name],
                meta_title: meta[:title],
                meta_name: meta[:name],
                meta_description: meta[:description],
                default_channel: sanitized_default_channel,
                default_frequency: sanitized_default_frequency,
                map_center_lat: MAP_CENTER_LAT,
                map_center_lon: MAP_CENTER_LON,
                max_node_distance_km: MAX_NODE_DISTANCE_KM,
                matrix_room: sanitized_matrix_room,
                version: APP_VERSION,
                private_mode: private_mode?,
                refresh_interval_seconds: REFRESH_INTERVAL_SECONDS,
                app_config_json: JSON.generate(config),
                initial_theme: theme,
              }
end

# GET /metrics
#
# Prometheus metrics endpoint.
get "/metrics" do
  content_type Prometheus::Client::Formats::Text::CONTENT_TYPE
  Prometheus::Client::Formats::Text.marshal(Prometheus::Client.registry)
end
